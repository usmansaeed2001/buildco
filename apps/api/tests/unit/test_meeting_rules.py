"""The meeting visibility and management matrix.

Both rules are two-line functions, which is exactly why they are worth covering
exhaustively: the whole point of extracting them was that the calendar's access rules
should be checkable without a database, and a matrix with a hole in it is how "members
can see everyone's meetings" survives a refactor.
"""

from __future__ import annotations

import uuid

import pytest

from app.models.enums import Role
from app.services.rules.meeting_rules import (
    ActorSnapshot,
    MeetingSnapshot,
    can_manage,
    can_view,
    screen_attendees,
)

ALICE = uuid.uuid4()
BOB = uuid.uuid4()
CAROL = uuid.uuid4()


def actor(role: Role, who: uuid.UUID = ALICE) -> ActorSnapshot:
    return ActorSnapshot(id=who, role=role)


def meeting(created_by: uuid.UUID | None, *attendees: uuid.UUID) -> MeetingSnapshot:
    return MeetingSnapshot(created_by=created_by, attendee_ids=frozenset(attendees))


# ── can_view ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("role", [Role.OWNER, Role.ADMIN])
def test_elevated_users_see_every_meeting(role: Role) -> None:
    assert can_view(actor(role), meeting(BOB))


def test_a_member_sees_what_they_created() -> None:
    assert can_view(actor(Role.MEMBER), meeting(ALICE))


def test_a_member_sees_what_they_were_invited_to() -> None:
    assert can_view(actor(Role.MEMBER), meeting(BOB, ALICE))


def test_a_member_does_not_see_an_unrelated_meeting() -> None:
    assert not can_view(actor(Role.MEMBER), meeting(BOB, CAROL))


def test_an_orphaned_meeting_is_not_everyones() -> None:
    """``created_by`` is SET NULL on delete, so "no creator" is a real state.

    Treating ``None == None`` as a match would make every meeting whose creator left the
    company visible to the whole team — the exact leak this filter exists to prevent.
    """
    assert not can_view(actor(Role.MEMBER), meeting(None))


def test_an_orphaned_meeting_is_still_visible_to_its_attendees() -> None:
    assert can_view(actor(Role.MEMBER), meeting(None, ALICE))


def test_an_orphaned_meeting_is_still_visible_to_an_admin() -> None:
    assert can_view(actor(Role.ADMIN), meeting(None))


# ── can_manage ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("role", [Role.OWNER, Role.ADMIN])
def test_elevated_users_can_change_any_meeting(role: Role) -> None:
    assert can_manage(actor(role), meeting(BOB))


def test_a_member_can_change_their_own_meeting() -> None:
    assert can_manage(actor(Role.MEMBER), meeting(ALICE))


def test_being_invited_is_not_enough_to_change_a_meeting() -> None:
    """Narrower than can_view on purpose.

    An attendee who could move the time would re-invite everyone else from an account
    they would not expect it from.
    """
    assert can_view(actor(Role.MEMBER), meeting(BOB, ALICE))
    assert not can_manage(actor(Role.MEMBER), meeting(BOB, ALICE))


def test_a_member_cannot_change_an_orphaned_meeting() -> None:
    assert not can_manage(actor(Role.MEMBER), meeting(None))


# ── screen_attendees ──────────────────────────────────────────────────────────


def test_nobody_removed_keeps_everyone() -> None:
    screening = screen_attendees(
        frozenset({ALICE, BOB}), removed=frozenset(), already_on=frozenset()
    )

    assert screening.kept == {ALICE, BOB}
    assert not screening.dropped
    assert not screening.refused


def test_adding_a_removed_person_is_refused() -> None:
    screening = screen_attendees(
        frozenset({ALICE, BOB}), removed=frozenset({BOB}), already_on=frozenset({ALICE})
    )

    assert screening.refused == {BOB}
    assert screening.kept == {ALICE}
    assert not screening.dropped


def test_a_removed_person_already_on_the_meeting_is_dropped_not_refused() -> None:
    """The form sends them back without showing them, so refusing would block every edit."""
    screening = screen_attendees(
        frozenset({ALICE, BOB}), removed=frozenset({BOB}), already_on=frozenset({ALICE, BOB})
    )

    assert screening.dropped == {BOB}
    assert screening.kept == {ALICE}
    assert not screening.refused


def test_one_dropped_and_one_refused_in_the_same_request() -> None:
    screening = screen_attendees(
        frozenset({ALICE, BOB, CAROL}),
        removed=frozenset({BOB, CAROL}),
        already_on=frozenset({BOB}),
    )

    assert screening.kept == {ALICE}
    assert screening.dropped == {BOB}
    assert screening.refused == {CAROL}


def test_a_removed_person_who_was_not_requested_is_not_reported() -> None:
    """Leaving them off the list is an ordinary removal, not a drop to call out."""
    screening = screen_attendees(
        frozenset({ALICE}), removed=frozenset({BOB}), already_on=frozenset({ALICE, BOB})
    )

    assert screening.kept == {ALICE}
    assert not screening.dropped
    assert not screening.refused
