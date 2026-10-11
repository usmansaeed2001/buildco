"""The shared action functions, called directly rather than through a route.

These functions exist so that a second caller gets exactly what a route gets: the same
checks, and the same email owed afterwards. So every one is exercised here without HTTP
in the way, with a happy path and a denial, and the service functions that used to rely
on a router for their checks are called bare to prove they no longer do.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.models.enums import UserStatus
from app.models.profile import Profile
from app.schemas.estimate import EstimateCreate, EstimateUpdate
from app.schemas.meeting import MeetingCreate, MeetingUpdate
from app.services import actions, meeting_service, project_service

START = datetime(2026, 9, 1, 15, 0, tzinfo=UTC)
END = START + timedelta(hours=1)


async def here(db, profile: Profile) -> Profile:
    """The same person, loaded into the test's own session, as a caller would hold them."""
    loaded = await db.get(Profile, profile.id)
    assert loaded is not None
    return loaded


def meeting_request(**overrides) -> MeetingCreate:
    return MeetingCreate(
        **{"title": "Site walkthrough", "start_time": START, "end_time": END, **overrides}
    )


def estimate_request(**overrides) -> EstimateCreate:
    return EstimateCreate(
        **{
            "project_name": "Water damage supplement",
            "client_name": "Acme Insurance",
            "rooms": [
                {
                    "name": "Kitchen",
                    "items": [{"name": "Drywall patch", "quantity": "12", "unitCost": "4.50"}],
                }
            ],
            **overrides,
        }
    )


# ── Follow-up work is returned, not run ───────────────────────────────────────


async def test_creating_a_meeting_returns_its_invite_without_sending_it(
    db, owner, member, notifications
):
    """The caller commits first. An invite sent before that could describe a meeting
    that was then rolled back."""
    result = await actions.create_meeting(
        db, await here(db, owner), meeting_request(attendee_ids=[member.id])
    )

    assert len(result.follow_ups) == 1
    assert notifications.sent == []

    await db.commit()
    await result.follow_ups[0].run()

    assert [s.recipient for s in notifications.sent] == [member.email]
    assert "Meeting invite" in notifications.sent[0].subject


async def test_a_meeting_with_nobody_on_it_owes_no_email(db, owner, notifications):
    result = await actions.create_meeting(db, await here(db, owner), meeting_request())

    assert result.follow_ups == []


async def test_recolouring_a_meeting_owes_no_email(db, owner, member, notifications):
    actor = await here(db, owner)
    created = await actions.create_meeting(db, actor, meeting_request(attendee_ids=[member.id]))
    await db.commit()

    result = await actions.update_meeting(
        db, actor, created.meeting.id, MeetingUpdate(color="#10B981")
    )

    assert result.follow_ups == []
    assert result.meeting.color == "#10B981"


async def test_moving_a_meeting_owes_an_updated_invite(db, owner, member, notifications):
    actor = await here(db, owner)
    created = await actions.create_meeting(db, actor, meeting_request(attendee_ids=[member.id]))
    await db.commit()

    result = await actions.update_meeting(
        db,
        actor,
        created.meeting.id,
        MeetingUpdate(start_time=START + timedelta(days=1), end_time=END + timedelta(days=1)),
    )
    await db.commit()
    for follow_up in result.follow_ups:
        await follow_up.run()

    assert ["Meeting updated" in s.subject for s in notifications.sent] == [True]


# ── Meetings: who may change them ─────────────────────────────────────────────


async def test_a_member_cannot_update_a_meeting_they_were_only_invited_to(
    db, owner, member, notifications
):
    created = await actions.create_meeting(
        db, await here(db, owner), meeting_request(attendee_ids=[member.id])
    )
    await db.commit()

    with pytest.raises(Forbidden):
        await actions.update_meeting(
            db, await here(db, member), created.meeting.id, MeetingUpdate(title="Hijacked")
        )


async def test_a_member_cannot_update_a_meeting_they_cannot_see(db, owner, member, notifications):
    created = await actions.create_meeting(db, await here(db, owner), meeting_request())
    await db.commit()

    with pytest.raises(NotFound):
        await actions.update_meeting(
            db, await here(db, member), created.meeting.id, MeetingUpdate(title="Hijacked")
        )


async def test_the_meeting_service_refuses_an_update_by_itself(db, owner, member, notifications):
    """It used to trust its caller: the check was in the router and nowhere else."""
    created = await actions.create_meeting(
        db, await here(db, owner), meeting_request(attendee_ids=[member.id])
    )
    await db.commit()

    with pytest.raises(Forbidden):
        await meeting_service.update_meeting(
            db,
            await here(db, member),
            created.meeting,
            changes={"title": "Hijacked"},
            attendee_ids=None,
        )


async def test_an_update_names_the_removed_people_it_took_off_the_meeting(
    db, owner, member, other_member, notifications
):
    actor = await here(db, owner)
    created = await actions.create_meeting(
        db, actor, meeting_request(attendee_ids=[member.id, other_member.id])
    )
    (await here(db, member)).status = UserStatus.BANNED.value
    await db.commit()

    result = await actions.update_meeting(
        db, actor, created.meeting.id, MeetingUpdate(attendee_ids=[member.id, other_member.id])
    )

    assert [p.id for p in result.dropped] == [member.id]
    assert [a.user_id for a in result.meeting.attendees] == [other_member.id]


async def test_adding_a_removed_person_is_refused_before_anything_is_owed(
    db, owner, member, notifications
):
    (await here(db, member)).status = UserStatus.BANNED.value
    await db.commit()

    with pytest.raises(ValidationFailed, match="removed from the team"):
        await actions.create_meeting(
            db, await here(db, owner), meeting_request(attendee_ids=[member.id])
        )


# ── Estimates ─────────────────────────────────────────────────────────────────


async def test_a_member_can_create_and_update_their_own_estimate(db, member):
    actor = await here(db, member)

    created = await actions.create_estimate(db, actor, estimate_request())
    await db.commit()
    updated = await actions.update_estimate(
        db, actor, created.estimate.id, EstimateUpdate(project_name="Renamed")
    )

    assert created.follow_ups == [] and updated.follow_ups == []
    assert updated.estimate.project_name == "Renamed"
    assert str(updated.estimate.total_amount) == "54.00"


async def test_a_member_cannot_update_someone_elses_estimate(db, member, other_member):
    created = await actions.create_estimate(db, await here(db, member), estimate_request())
    await db.commit()

    with pytest.raises(NotFound):
        await actions.update_estimate(
            db, await here(db, other_member), created.estimate.id, EstimateUpdate(pm_name="Me")
        )


async def test_locking_returns_the_admin_notice_without_sending_it(db, owner, notifications):
    actor = await here(db, owner)
    created = await actions.create_estimate(db, actor, estimate_request())
    await db.commit()

    result = await actions.transition_estimate(db, actor, created.estimate.id, "lock")

    assert result.estimate.status == "locked"
    assert len(result.follow_ups) == 1
    assert notifications.sent == []

    await db.commit()
    await result.follow_ups[0].run()

    assert notifications.sent[0].kind == "admins"
    assert notifications.sent[0].pref == "estimate_locked"


async def test_a_member_cannot_lock_through_the_action(db, member, notifications):
    actor = await here(db, member)
    created = await actions.create_estimate(db, actor, estimate_request())
    await db.commit()

    with pytest.raises(Forbidden):
        await actions.transition_estimate(db, actor, created.estimate.id, "lock")


async def test_a_transition_from_the_wrong_status_is_a_conflict(db, owner, notifications):
    actor = await here(db, owner)
    created = await actions.create_estimate(db, actor, estimate_request())
    await db.commit()

    with pytest.raises(Conflict):
        await actions.transition_estimate(db, actor, created.estimate.id, "unlock")


async def test_submitting_returns_the_reviewers_email_and_the_slack_post(
    db, member, reviewer, notifications
):
    actor = await here(db, member)
    created = await actions.create_estimate(db, actor, estimate_request())
    await db.commit()

    result = await actions.submit_estimate_for_review(db, actor, created.estimate.id)

    assert result.submission.estimate.status == "submitted"
    assert len(result.follow_ups) == 2
    assert notifications.sent == []

    await db.commit()
    await result.follow_ups[0].run()

    sent = notifications.sent[0]
    assert sent.recipient == reviewer.email
    assert sent.context["approve_url"] == result.submission.approve_url
    assert sent.context["totals"] == result.totals


async def test_a_member_cannot_submit_someone_elses_estimate(
    db, member, other_member, reviewer, notifications
):
    created = await actions.create_estimate(db, await here(db, member), estimate_request())
    await db.commit()

    with pytest.raises(NotFound):
        await actions.submit_estimate_for_review(
            db, await here(db, other_member), created.estimate.id
        )


# ── Project reads take the actor ──────────────────────────────────────────────


@pytest.fixture
async def project_id(owner_client, member) -> uuid.UUID:
    """A project assigned to ``member``, with one milestone on it."""
    project = (
        await owner_client.post(
            "/api/v1/projects",
            json={
                "owner_name": "Jordan Homeowner",
                "address": "12 Oak Street",
                "work_type": "Water mitigation",
                "total_budget": "24000.00",
                "assigned_to": str(member.id),
            },
        )
    ).json()
    await owner_client.post(
        f"/api/v1/projects/{project['id']}/milestones",
        json={"label": "Deposit", "amount": "5000.00"},
    )
    return uuid.UUID(project["id"])


async def test_the_assigned_member_can_read_a_project_and_what_hangs_off_it(db, member, project_id):
    actor = await here(db, member)

    project = await project_service.get_project(db, actor, project_id)
    milestones = await project_service.list_milestones(db, actor, project_id)
    activity = await project_service.list_activity(db, actor, project_id)
    supplements = await project_service.list_supplements(db, actor, project_id)

    assert project.id == project_id
    assert [m.label for m in milestones] == ["Deposit"]
    assert activity
    assert supplements == []


@pytest.mark.parametrize(
    "read",
    [
        project_service.get_project,
        project_service.list_milestones,
        project_service.list_supplements,
        project_service.list_activity,
    ],
)
async def test_an_unassigned_member_cannot_read_a_project_through_the_service(
    db, other_member, project_id, read
):
    """These took no actor at all, so a caller that skipped the route saw any project."""
    with pytest.raises(NotFound):
        await read(db, await here(db, other_member), project_id)


async def test_an_owner_can_read_any_project_through_the_service(db, owner, project_id):
    milestones = await project_service.list_milestones(db, await here(db, owner), project_id)

    assert len(milestones) == 1
