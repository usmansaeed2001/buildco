"""Adding lines by voice: where each goes and what it costs, decided without the model.

The two things that matter most get the most cases: a price never comes from anywhere
but the catalogue or the user's own words, and a room the user named is never guessed
at when the name fits more than one.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.rules import line_additions
from app.services.rules.line_additions import (
    Addition,
    AdditionRefused,
    CatalogueEntry,
    NewLine,
    plan_additions,
)

UNITS = ["LF", "SF", "Ea", "Qty", "Sq", "Roll"]
CATEGORIES = ["drywall", "flooring", "trim", "painting", "custom", "other"]
DRYWALL = CatalogueEntry(
    id="cat-1", name="Drywall, half inch", category="drywall", unit="SF", unit_cost=Decimal("3")
)
CATALOGUE = {DRYWALL.id: DRYWALL}
ROOMS = [
    {"name": "Kitchen", "items": [{"name": "Paint", "quantity": "1", "unitCost": "100"}]},
    {"name": "Bedroom", "items": []},
]


def plan(*additions: Addition, rooms=ROOMS):
    return plan_additions(rooms, additions, CATALOGUE, units=UNITS, categories=CATEGORIES)


def from_catalogue(quantity="10", **overrides) -> NewLine:
    return NewLine(quantity=quantity, catalogue_id="cat-1", **overrides)


def stated(name="Baseboard", price="4.50", unit="LF", category="trim", quantity="12") -> NewLine:
    return NewLine(
        quantity=quantity, name=name, unit=unit, category=category, stated_unit_cost=price
    )


# ── Prices ────────────────────────────────────────────────────────────────────


def test_a_catalogue_line_takes_the_catalogues_name_unit_category_and_price():
    result = plan(Addition(room="Kitchen", lines=[from_catalogue(name="ignored")]))

    (line,) = result.lines
    assert (line.name, line.unit, line.category, line.unit_cost) == (
        "Drywall, half inch",
        "SF",
        "drywall",
        Decimal("3"),
    )
    assert line.source == line_additions.CATALOGUE
    assert result.rooms[0]["items"][-1]["catalogueId"] == "cat-1"
    assert result.rooms[0]["items"][-1]["isCustom"] is False


def test_the_catalogue_price_said_again_is_still_the_catalogue():
    (line,) = plan(Addition(room="Kitchen", lines=[from_catalogue(stated_unit_cost="3.00")])).lines

    assert line.source == line_additions.CATALOGUE


def test_a_stated_price_that_differs_from_the_catalogue_wins_and_is_marked():
    (line,) = plan(Addition(room="Kitchen", lines=[from_catalogue(stated_unit_cost="$3.50")])).lines

    assert (line.unit_cost, line.source) == (Decimal("3.50"), line_additions.DIFFERS)
    assert line.catalogue_unit_cost == Decimal("3")


def test_a_line_not_in_the_catalogue_uses_the_price_the_user_stated():
    result = plan(Addition(room="Kitchen", lines=[stated()]))

    (line,) = result.lines
    assert (line.unit_cost, line.source) == (Decimal("4.50"), line_additions.STATED)
    assert result.rooms[0]["items"][-1]["isCustom"] is True
    assert result.rooms[0]["items"][-1]["catalogueId"] is None


def test_a_line_with_no_catalogue_item_and_no_price_is_a_question_never_a_guess():
    with pytest.raises(AdditionRefused, match="no price"):
        plan(Addition(room="Kitchen", lines=[stated(price="")]))


def test_an_id_that_is_not_in_the_catalogue_is_refused():
    with pytest.raises(AdditionRefused, match="not an item in the catalogue"):
        plan(Addition(room="Kitchen", lines=[NewLine(quantity="1", catalogue_id="made-up")]))


@pytest.mark.parametrize(
    ("price", "reason"),
    [("abc", "could not read"), ("-1", "zero or more"), ("1.234", "decimal places")],
)
def test_a_price_that_is_not_money_is_refused(price, reason):
    with pytest.raises(AdditionRefused, match=reason):
        plan(Addition(room="Kitchen", lines=[stated(price=price)]))


# ── Units, categories and quantities ──────────────────────────────────────────


def test_a_unit_and_category_are_matched_without_regard_to_case_and_kept_as_the_team_spells_them():
    (line,) = plan(Addition(room="Kitchen", lines=[stated(unit="roll", category="TRIM")])).lines

    assert (line.unit, line.category) == ("Roll", "trim")


@pytest.mark.parametrize(
    ("unit", "category", "reason"),
    [
        ("", "trim", "needs a unit"),
        ("Bucket", "trim", "not one of the team's units"),
        ("LF", "", "needs a category"),
        ("LF", "roofing", "not one of the team's categories"),
    ],
)
def test_a_unit_or_category_the_team_does_not_have_is_a_question(unit, category, reason):
    with pytest.raises(AdditionRefused, match=reason):
        plan(Addition(room="Kitchen", lines=[stated(unit=unit, category=category)]))


@pytest.mark.parametrize(("quantity", "reason"), [("0", "cannot be zero"), ("x", "could not read")])
def test_a_quantity_has_to_be_a_positive_number(quantity, reason):
    with pytest.raises(AdditionRefused, match=reason):
        plan(Addition(room="Kitchen", lines=[from_catalogue(quantity=quantity)]))


def test_a_line_needs_a_name_or_a_catalogue_item():
    with pytest.raises(AdditionRefused, match="needs a name"):
        plan(Addition(room="Kitchen", lines=[NewLine(quantity="1", stated_unit_cost="5")]))


# ── Rooms ─────────────────────────────────────────────────────────────────────


def test_lines_go_at_the_end_of_the_room_and_nothing_else_moves():
    result = plan(Addition(room="kitchen", lines=[from_catalogue(), stated()]))

    assert [item["name"] for item in result.rooms[0]["items"]] == [
        "Paint",
        "Drywall, half inch",
        "Baseboard",
    ]
    assert result.rooms[1] == ROOMS[1]
    assert result.positions == [(0, 1), (0, 2)]


def test_the_stored_document_is_not_touched():
    before = repr(ROOMS)

    plan(Addition(room="Kitchen", lines=[from_catalogue()]))

    assert repr(ROOMS) == before


def test_a_new_room_goes_at_the_end_and_is_named():
    result = plan(Addition(room="Bathroom", new_room=True, lines=[stated()]))

    assert result.rooms[-1]["name"] == "Bathroom"
    assert result.positions == [(2, 0)]
    assert result.new_rooms == ["Bathroom"]
    assert result.lines[0].new_room


def test_a_new_room_with_the_name_of_an_existing_one_is_a_question():
    with pytest.raises(AdditionRefused, match="already a room called kitchen"):
        plan(Addition(room="kitchen", new_room=True, lines=[stated()]))


def test_two_additions_to_the_same_new_room_share_it():
    result = plan(
        Addition(room="Bathroom", new_room=True, lines=[stated()]),
        Addition(room="Bathroom", new_room=True, lines=[from_catalogue()]),
    )

    assert len(result.rooms) == 3
    assert result.positions == [(2, 0), (2, 1)]


def test_a_room_that_does_not_exist_is_a_question():
    with pytest.raises(AdditionRefused, match="no room called Garage"):
        plan(Addition(room="Garage", lines=[stated()]))


def test_two_rooms_with_the_name_are_a_question_until_a_position_is_given():
    rooms = [*ROOMS, {"name": "Bedroom", "items": []}]

    with pytest.raises(AdditionRefused, match="2 rooms called Bedroom, at positions 2, 3"):
        plan(Addition(room="Bedroom", lines=[stated()]), rooms=rooms)

    result = plan(Addition(room="Bedroom", room_position=3, lines=[stated()]), rooms=rooms)
    assert result.positions == [(2, 0)]


def test_a_position_that_is_not_that_room_is_refused():
    with pytest.raises(AdditionRefused, match="Room 1 is not called Bedroom"):
        plan(Addition(room="Bedroom", room_position=1, lines=[stated()]))


# ── Totals and limits ─────────────────────────────────────────────────────────


def test_the_totals_before_and_after_are_worked_out_in_decimal():
    result = plan(Addition(room="Kitchen", lines=[from_catalogue(quantity="10"), stated()]))

    assert result.old_total == Decimal("100.00")
    assert result.new_total == Decimal("100.00") + Decimal("30.00") + Decimal("54.00")
    assert [line.total for line in result.lines] == [Decimal("30.00"), Decimal("54.00")]


def test_nothing_to_add_is_refused():
    with pytest.raises(AdditionRefused, match="nothing to add"):
        plan(Addition(room="Kitchen", lines=[]))


def test_too_many_lines_at_once_is_refused():
    lines = [from_catalogue() for _ in range(line_additions.MAX_LINES + 1)]

    with pytest.raises(AdditionRefused, match="smaller batches"):
        plan(Addition(room="Kitchen", lines=lines))


# ── Photos left behind ────────────────────────────────────────────────────────


def test_photos_left_where_a_new_line_would_go_are_counted():
    positions = [(0, 1), (2, 0)]

    assert line_additions.photos_in_the_way(positions, {(0, 0): 4}) == 0
    assert line_additions.photos_in_the_way(positions, {(0, 1): 2, (2, 0): 1}) == 3
