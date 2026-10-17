"""BuildCo Assistant: adding rooms and lines to a supplement, worked out without I/O.

The assistant may **add** and nothing else. It cannot change or remove a line, because
photos are attached to a line by its position (``attachments.room_index`` /
``item_index``) and anything other than an append would move them onto the wrong line.
An append moves nobody's photos, so it is safe without stable ids.

Two decisions live here rather than with the model:

* **The price.** A line from the rate catalogue takes the catalogue's name, unit,
  category and price. A line the catalogue does not have needs a price the user stated.
  The model never supplies one of its own, and every line says where its price came
  from, so the read-back can name each one that did not come from the catalogue.
* **Where it goes.** New lines go at the end of a room, and new rooms at the end of the
  supplement. A room is named by the user; two rooms with that name are a question for
  the user, never a guess.

Pure functions. Data in, a plan or a refusal out.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from app.services.rules import estimate_totals

#: The most lines one proposal may add. More than this is too much to read back, and
#: too much to check on one screen.
MAX_LINES = 40

#: Where a line's price came from.
CATALOGUE = "catalogue"
STATED = "stated"
DIFFERS = "differs"


class AdditionRefused(ValueError):
    """The additions cannot be planned. The message says what to ask the user."""


@dataclass(frozen=True, slots=True)
class CatalogueEntry:
    id: str
    name: str
    category: str
    unit: str
    unit_cost: Decimal


@dataclass(frozen=True, slots=True)
class NewLine:
    quantity: str
    catalogue_id: str = ""
    name: str = ""
    unit: str = ""
    category: str = ""
    #: A price the user said, as written. Blank when they did not say one.
    stated_unit_cost: str = ""


@dataclass(frozen=True, slots=True)
class Addition:
    """Lines for one room: an existing one by name, or a new one."""

    room: str
    lines: Sequence[NewLine]
    new_room: bool = False
    #: 1-based, as ``get_supplement`` shows it. Only needed when two rooms share a name.
    room_position: int | None = None


@dataclass(frozen=True, slots=True)
class PlannedLine:
    room: str
    #: 0-based positions, as the attachments table stores them.
    room_index: int
    item_index: int
    new_room: bool
    name: str
    quantity: Decimal
    unit: str
    category: str
    unit_cost: Decimal
    source: str
    #: The catalogue's price, when the line is from the catalogue at a different price.
    catalogue_unit_cost: Decimal | None
    total: Decimal


@dataclass(frozen=True, slots=True)
class Plan:
    #: The whole new ``rooms`` document, in the stored camelCase shape.
    rooms: list[dict[str, Any]]
    lines: tuple[PlannedLine, ...]
    old_total: Decimal
    new_total: Decimal

    @property
    def positions(self) -> list[tuple[int, int]]:
        return [(line.room_index, line.item_index) for line in self.lines]

    @property
    def new_rooms(self) -> list[str]:
        seen: list[str] = []
        for line in self.lines:
            if line.new_room and line.room not in seen:
                seen.append(line.room)
        return seen

    @property
    def unpriced_by_catalogue(self) -> list[PlannedLine]:
        return [line for line in self.lines if line.source != CATALOGUE]


def _decimal(value: str, what: str, *, places: int) -> Decimal:
    text = str(value).strip().replace("$", "").replace(",", "")
    try:
        number = Decimal(text)
    except InvalidOperation as exc:
        raise AdditionRefused(f"I could not read {what} as a number. Ask for it again.") from exc
    if not number.is_finite() or number < 0:
        raise AdditionRefused(f"{what[:1].upper()}{what[1:]} has to be zero or more.")
    if number != number.quantize(Decimal(1).scaleb(-places)):
        raise AdditionRefused(f"{what[:1].upper()}{what[1:]} has too many decimal places.")
    return number


def _one_of(value: str, allowed: Sequence[str], what: str, plural: str, line: str) -> str:
    """The allowed spelling of ``value``, matched without regard to case."""
    wanted = value.strip().lower()
    if not wanted:
        raise AdditionRefused(
            f"The line {line} needs a {what}. Ask the user; the choices are {', '.join(allowed)}."
        )
    for option in allowed:
        if option.lower() == wanted:
            return option
    raise AdditionRefused(
        f"{value} is not one of the team's {plural} ({', '.join(allowed)}). Ask the user "
        "which one fits."
    )


def _room_index(rooms: Sequence[Any], addition: Addition) -> int:
    wanted = addition.room.strip().lower()
    matches = [
        index
        for index, room in enumerate(rooms)
        if isinstance(room, dict) and str(room.get("name", "")).strip().lower() == wanted
    ]
    if addition.room_position is not None:
        index = addition.room_position - 1
        if index not in matches:
            raise AdditionRefused(
                f"Room {addition.room_position} is not called {addition.room}. Read the "
                "supplement again and ask which room is meant."
            )
        return index
    if not matches:
        raise AdditionRefused(
            f"There is no room called {addition.room}. Ask whether to add it as a new room."
        )
    if len(matches) > 1:
        where = ", ".join(str(index + 1) for index in matches)
        raise AdditionRefused(
            f"There are {len(matches)} rooms called {addition.room}, at positions {where}. "
            "Ask the user which one, then pass its position."
        )
    return matches[0]


@dataclass(frozen=True, slots=True)
class _Priced:
    name: str
    unit: str
    category: str
    unit_cost: Decimal
    source: str
    catalogue_unit_cost: Decimal | None = None
    catalogue_id: str | None = None


def _price(
    line: NewLine,
    catalogue: Mapping[str, CatalogueEntry],
    *,
    units: Sequence[str],
    categories: Sequence[str],
) -> _Priced:
    """What a line is called, how it is measured, and what it costs, and why."""
    stated = (
        _decimal(line.stated_unit_cost, "the price", places=2)
        if line.stated_unit_cost.strip()
        else None
    )
    if line.catalogue_id.strip():
        entry = catalogue.get(line.catalogue_id.strip())
        if entry is None:
            raise AdditionRefused(
                f"{line.catalogue_id} is not an item in the catalogue. Search the catalogue "
                "and pass the id it gives."
            )
        if stated is None or stated == entry.unit_cost:
            return _Priced(
                entry.name, entry.unit, entry.category, entry.unit_cost, CATALOGUE, None, entry.id
            )
        return _Priced(
            entry.name, entry.unit, entry.category, stated, DIFFERS, entry.unit_cost, entry.id
        )

    name = line.name.strip()
    if not name:
        raise AdditionRefused("Every line needs a name, or a catalogue item. Ask what it is.")
    if stated is None:
        raise AdditionRefused(
            f"{name} is not from the catalogue and has no price. Ask the user for the price "
            "per unit. Never supply one yourself."
        )
    unit = _one_of(line.unit, units, "unit", "units", name)
    category = _one_of(line.category, categories, "category", "categories", name)
    return _Priced(name, unit, category, stated, STATED)


def plan_additions(
    rooms: Sequence[Any],
    additions: Sequence[Addition],
    catalogue: Mapping[str, CatalogueEntry],
    *,
    units: Sequence[str],
    categories: Sequence[str],
) -> Plan:
    """Work out the supplement's rooms with these lines appended.

    ``rooms`` is the stored document and is not modified. Raises ``AdditionRefused``
    with what to ask the user when anything is missing, unclear, or not allowed.
    """
    if not additions or not any(addition.lines for addition in additions):
        raise AdditionRefused("There is nothing to add. Ask what should be added.")
    count = sum(len(addition.lines) for addition in additions)
    if count > MAX_LINES:
        raise AdditionRefused(
            f"That is {count} lines, and at most {MAX_LINES} can be added at once. "
            "Split it into smaller batches."
        )

    document: list[dict[str, Any]] = [copy.deepcopy(room) for room in rooms]
    existing_names = {
        str(room.get("name", "")).strip().lower() for room in rooms if isinstance(room, dict)
    }
    created: dict[str, int] = {}
    planned: list[PlannedLine] = []

    for addition in additions:
        if not addition.lines:
            continue
        name = addition.room.strip()
        if addition.new_room:
            if not name:
                raise AdditionRefused("A new room needs a name. Ask for one.")
            key = name.lower()
            if key in existing_names:
                raise AdditionRefused(
                    f"There is already a room called {name}. Ask whether to add to it, or "
                    "to create a second room with a different name."
                )
            if key not in created:
                document.append({"name": name, "items": []})
                created[key] = len(document) - 1
            index = created[key]
        else:
            index = _room_index(rooms, addition)
            name = str(document[index].get("name", ""))

        items = document[index].setdefault("items", [])
        if not isinstance(items, list):
            items = document[index]["items"] = []
        for line in addition.lines:
            priced = _price(line, catalogue, units=units, categories=categories)
            quantity = _decimal(line.quantity, f"the quantity of {priced.name}", places=4)
            if quantity == 0:
                raise AdditionRefused(
                    f"The quantity of {priced.name} cannot be zero. Ask how many."
                )
            items.append(
                {
                    "name": priced.name,
                    "category": priced.category,
                    "unit": priced.unit,
                    "quantity": str(quantity),
                    "unitCost": str(priced.unit_cost),
                    "isCustom": priced.catalogue_id is None,
                    "catalogueId": priced.catalogue_id,
                    "notes": "",
                }
            )
            planned.append(
                PlannedLine(
                    room=name,
                    room_index=index,
                    item_index=len(items) - 1,
                    new_room=addition.new_room,
                    name=priced.name,
                    quantity=quantity,
                    unit=priced.unit,
                    category=priced.category,
                    unit_cost=priced.unit_cost,
                    source=priced.source,
                    catalogue_unit_cost=priced.catalogue_unit_cost,
                    total=estimate_totals.line_total(quantity, priced.unit_cost),
                )
            )

    return Plan(
        rooms=document,
        lines=tuple(planned),
        old_total=estimate_totals.compute(list(rooms)).total,
        new_total=estimate_totals.compute(document).total,
    )


def photos_in_the_way(
    positions: Sequence[tuple[int, int]], photos: Mapping[tuple[int, int], int]
) -> int:
    """How many photos already sit where the new lines would go.

    A line deleted by hand leaves its photo rows at its old position, and a line
    appended there would show them as its own. Any such photo refuses the proposal.
    """
    return sum(photos.get(position, 0) for position in positions)
