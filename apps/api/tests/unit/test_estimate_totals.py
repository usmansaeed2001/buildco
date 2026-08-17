"""Estimate money arithmetic.

The totals feed both the API response and the reviewer's email, so a rounding
discrepancy here is one the customer would see.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.rules.estimate_totals import compute, line_total


def room(name: str, *items: tuple[object, object]) -> dict[str, object]:
    return {
        "name": name,
        "items": [
            {"name": f"Item {i}", "quantity": q, "unitCost": c} for i, (q, c) in enumerate(items)
        ],
    }


def test_totals_sum_quantity_times_unit_cost():
    result = compute([room("Kitchen", (2, "10.00"), (3, "5.50"))])

    assert result.total == Decimal("36.50")
    assert result.room_count == 1
    assert result.item_count == 2


def test_room_totals_are_reported_individually():
    result = compute([room("Kitchen", (2, "10.00")), room("Bath", (1, "7.25"))])

    assert [r.total for r in result.rooms] == [Decimal("20.00"), Decimal("7.25")]
    assert [r.name for r in result.rooms] == ["Kitchen", "Bath"]
    assert result.total == Decimal("27.25")


def test_money_is_not_computed_in_binary_floating_point():
    """0.1 + 0.2 arithmetic must not leak into an invoice."""
    result = compute([room("R", (3, 0.1))])

    assert result.total == Decimal("0.30")


def test_values_round_half_up_to_cents():
    assert line_total(1, "0.125") == Decimal("0.13")
    assert line_total(1, "0.135") == Decimal("0.14")


def test_string_and_numeric_inputs_agree():
    assert compute([room("R", (2, "10.50"))]).total == compute([room("R", (2, 10.50))]).total


# ── Tolerance for imperfect stored documents ──────────────────────────────────
# These run on the public reviewer endpoint, where a document predating the current
# schema must still render rather than 500.


@pytest.mark.parametrize("rooms", [None, [], [{}], ["not a room"], [{"items": None}]])
def test_malformed_documents_total_zero_rather_than_raising(rooms):
    assert compute(rooms).total == Decimal("0")


def test_missing_prices_count_as_zero():
    result = compute([{"name": "R", "items": [{"name": "No price", "quantity": 5}]}])

    assert result.total == Decimal("0")
    assert result.item_count == 1


def test_snake_case_unit_cost_is_also_accepted():
    """Stored documents use camelCase; API payloads may use either."""
    result = compute([{"name": "R", "items": [{"quantity": 2, "unit_cost": "3.00"}]}])

    assert result.total == Decimal("6.00")


def test_a_room_without_items_still_counts_as_a_room():
    result = compute([{"name": "Empty"}])

    assert result.room_count == 1
    assert result.item_count == 0
    assert result.total == Decimal("0")


def test_unparseable_values_are_treated_as_zero_not_fatal():
    result = compute([{"name": "R", "items": [{"quantity": "many", "unitCost": "lots"}]}])

    assert result.total == Decimal("0")
