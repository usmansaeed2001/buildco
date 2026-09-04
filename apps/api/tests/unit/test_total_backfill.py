"""The migration's copy of the totals arithmetic, pinned to the real one.

Revision ``b7c4e1f2a930`` carries its own ``_total`` rather than importing
``estimate_totals.compute``, because a migration has to keep producing the same numbers
forever and importing application code means a later edit silently rewrites what an
already-applied revision does on replay.

That is the right call and it has an obvious cost: two copies drift. This is what stops
the drift being silent. If ``compute`` changes and these disagree, this test fails and
somebody decides on purpose — rather than finding out months later from a list that is
sorted wrong.

Note what this does **not** cover: the migration itself. `tests/conftest.py` builds the
schema from `Base.metadata`, so no revision in this repository is ever executed by the
suite. The backfill's SQL, its batching, and its `downgrade()` are only ever verified by
running `alembic upgrade head` against real Postgres by hand.
"""

from __future__ import annotations

import importlib.util
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from app.services.rules import estimate_totals

REVISION = (
    Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "b7c4e1f2a930_add_estimate_total_and_sort_indexes.py"
)


def _load_revision() -> Any:
    """Import the revision by path — `alembic/versions` is not an importable package."""
    spec = importlib.util.spec_from_file_location("_revision_b7c4e1f2a930", REVISION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


migration = _load_revision()


#: Documents chosen for the ways they can go wrong, not for the ways they work.
DOCUMENTS: list[tuple[str, Any]] = [
    ("empty", []),
    ("none", None),
    ("a room with no items", [{"name": "Roof", "items": []}]),
    (
        "a plain room",
        [{"name": "Roof", "items": [{"quantity": "20", "unitCost": "12.50"}]}],
    ),
    (
        "several rooms",
        [
            {"name": "Roof", "items": [{"quantity": "20", "unitCost": "12.50"}]},
            {"name": "Kitchen", "items": [{"quantity": "3", "unitCost": "4.00"}]},
        ],
    ),
    ("a missing price", [{"name": "Roof", "items": [{"quantity": "2"}]}]),
    ("a missing quantity", [{"name": "Roof", "items": [{"unitCost": "9.99"}]}]),
    (
        "the snake_case spelling",
        [{"name": "Roof", "items": [{"quantity": 2, "unit_cost": "3.50"}]}],
    ),
    (
        "numbers rather than strings",
        [{"name": "Roof", "items": [{"quantity": 2, "unitCost": 3.5}]}],
    ),
    ("an item that is not a dict", [{"name": "Roof", "items": ["junk", 7]}]),
    ("a room that is not a dict", ["notaroom", 3]),
    ("items that are not a list", [{"name": "Roof", "items": "nope"}]),
    (
        "a price that will not parse",
        [{"name": "Roof", "items": [{"quantity": "x", "unitCost": "y"}]}],
    ),
    (
        "a rounding boundary — half a cent per room",
        [
            {"name": "A", "items": [{"quantity": "1", "unitCost": "0.005"}]},
            {"name": "B", "items": [{"quantity": "1", "unitCost": "0.005"}]},
        ],
    ),
    (
        "a long tail of fractional cents",
        [{"name": "A", "items": [{"quantity": "3", "unitCost": "0.333"}]}],
    ),
]


@pytest.mark.parametrize("label,rooms", DOCUMENTS, ids=[d[0] for d in DOCUMENTS])
def test_the_backfill_arithmetic_matches_the_live_totals_function(label: str, rooms: Any) -> None:
    assert migration._total(rooms) == estimate_totals.compute(rooms).total


def test_the_backfill_rounds_per_room_rather_than_once_at_the_end() -> None:
    """Two half-cents round up separately, not away as a single whole cent.

    Spelled out because it is the one case where "sum then round" and "round then sum"
    disagree, and getting it wrong would put the list a penny out from the report.
    """
    rooms = [
        {"name": "A", "items": [{"quantity": "1", "unitCost": "0.005"}]},
        {"name": "B", "items": [{"quantity": "1", "unitCost": "0.005"}]},
    ]

    assert migration._total(rooms) == Decimal("0.02")
