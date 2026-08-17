"""Money arithmetic over an estimate's room/item document.

The legacy code recomputed these totals inline, in floating point, in both the browser
and the review email (``buildEstimateTable`` in ``submit.js``). They are computed here
once, in ``Decimal``, and every consumer — the API response, the reviewer payload, the
email template — reads the same numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

CENTS = Decimal("0.01")


def _money(value: object) -> Decimal:
    """Coerce whatever came out of JSON into a Decimal without float rounding.

    Values arrive as ints, floats, strings, or missing entirely. Routing through
    ``str()`` avoids inheriting binary-float error (``Decimal(0.1)`` is not 0.1).
    """
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return Decimal("0")


def _round(value: Decimal) -> Decimal:
    return value.quantize(CENTS, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class RoomTotal:
    name: str
    item_count: int
    total: Decimal


@dataclass(frozen=True, slots=True)
class EstimateTotals:
    total: Decimal
    room_count: int
    item_count: int
    rooms: tuple[RoomTotal, ...]


def compute(rooms: list[Any] | None) -> EstimateTotals:
    """Total an estimate's ``rooms`` document.

    Tolerant by design: a room with no items, an item with no price, or a malformed
    entry contributes zero rather than raising. This runs on the public reviewer
    endpoint, where a stored document predating the current schema must still render.
    """
    room_totals: list[RoomTotal] = []
    grand_total = Decimal("0")
    total_items = 0

    for room in rooms or []:
        if not isinstance(room, dict):
            continue
        items = room.get("items") or []
        if not isinstance(items, list):
            items = []

        room_sum = Decimal("0")
        counted = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            quantity = _money(item.get("quantity"))
            unit_cost = _money(item.get("unitCost", item.get("unit_cost")))
            room_sum += quantity * unit_cost
            counted += 1

        room_sum = _round(room_sum)
        grand_total += room_sum
        total_items += counted
        room_totals.append(
            RoomTotal(
                name=str(room.get("name") or "Untitled room"),
                item_count=counted,
                total=room_sum,
            )
        )

    return EstimateTotals(
        total=_round(grand_total),
        room_count=len(room_totals),
        item_count=total_items,
        rooms=tuple(room_totals),
    )


def line_total(quantity: object, unit_cost: object) -> Decimal:
    """A single line item's extended price."""
    return _round(_money(quantity) * _money(unit_cost))
