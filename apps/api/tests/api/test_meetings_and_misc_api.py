"""Meetings, health probes, AI parsing, and attachments."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.models.enums import Role, UserStatus
from app.models.profile import Profile
from app.services.integrations import calendar
from app.services.integrations.calendar import IcsAttendee

START = datetime(2026, 9, 1, 15, 0, tzinfo=UTC)
END = START + timedelta(hours=1)


async def make_meeting(client, **overrides):
    payload = {
        "title": "Site walkthrough",
        "description": "Review the scope with the adjuster.",
        "location": "12 Oak Street",
        "start_time": START.isoformat(),
        "end_time": END.isoformat(),
        **overrides,
    }
    response = await client.post("/api/v1/meetings", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# ── Meetings ──────────────────────────────────────────────────────────────────


async def test_a_member_can_now_schedule_a_meeting(member_client):
    """Deliberately reversed. This used to be a 403.

    Scheduling was elevated-only, which made "meetings I created" an empty category for
    most of the team and left a member unable to put their own work on the calendar.
    Editing and cancelling stayed narrow — see the row-level tests below — so opening
    creation does not let a member touch anyone else's meeting.
    """
    response = await member_client.post(
        "/api/v1/meetings",
        json={
            "title": "My own site visit",
            "start_time": START.isoformat(),
            "end_time": END.isoformat(),
        },
    )

    assert response.status_code == 201


# ── Visibility ────────────────────────────────────────────────────────────────


async def test_a_member_does_not_see_a_meeting_they_have_nothing_to_do_with(
    owner_client, member_client
):
    """Also deliberately reversed.

    The calendar was shared across the whole team by design, and both the router and the
    service said so in their docstrings. It is now scoped: created-by-me or
    invited-to-me, unless you are an owner or admin.
    """
    await make_meeting(owner_client, title="Leadership sync")

    listed = (await member_client.get("/api/v1/meetings")).json()

    assert listed == []


async def test_scope_all_no_longer_returns_the_whole_calendar_to_a_member(
    owner_client, member_client
):
    """Asking for everything is clamped, not refused.

    Refusing would turn a stale client bundle into an error page. Clamping mirrors
    ``project_service.list_projects``, which narrows a member to their own projects
    rather than 403ing them.
    """
    await make_meeting(owner_client, title="Leadership sync")

    response = await member_client.get("/api/v1/meetings", params={"scope": "all"})

    assert response.status_code == 200
    assert response.json() == []


async def test_an_attendee_sees_the_meeting_they_were_invited_to(
    owner_client, member_client, member
):
    """They were emailed an invite for it — the app must not be the one place it is hidden."""
    await make_meeting(owner_client, title="Adjuster call", attendee_ids=[str(member.id)])

    titles = [m["title"] for m in (await member_client.get("/api/v1/meetings")).json()]

    assert titles == ["Adjuster call"]


async def test_scope_invited_excludes_a_members_own_meeting(member_client):
    await make_meeting(member_client, title="My own site visit")

    listed = (await member_client.get("/api/v1/meetings", params={"scope": "invited"})).json()

    assert listed == []


async def test_scope_mine_returns_what_the_member_created(member_client):
    await make_meeting(member_client, title="My own site visit")

    titles = [
        m["title"]
        for m in (await member_client.get("/api/v1/meetings", params={"scope": "mine"})).json()
    ]

    assert titles == ["My own site visit"]


async def test_an_owner_still_sees_everything(owner_client, member_client):
    await make_meeting(member_client, title="A member's meeting")

    titles = [m["title"] for m in (await owner_client.get("/api/v1/meetings")).json()]

    assert titles == ["A member's meeting"]


async def test_a_meeting_a_member_cannot_see_is_a_404_not_a_403(owner_client, member_client):
    """Its existence is privileged. 403 would confirm that this id names a meeting."""
    meeting = await make_meeting(owner_client, title="Leadership sync")

    response = await member_client.get(f"/api/v1/meetings/{meeting['id']}")

    assert response.status_code == 404


# ── Who may change one ────────────────────────────────────────────────────────


async def test_a_member_can_edit_the_meeting_they_created(member_client):
    meeting = await make_meeting(member_client, title="My own site visit")

    response = await member_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"title": "Rescheduled site visit"}
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Rescheduled site visit"


async def test_an_attendee_cannot_move_someone_elses_meeting(owner_client, member_client, member):
    """403, not 404: they can see it, they were invited. They just may not move it.

    An attendee who could change the time would re-invite everyone else from an account
    nobody expected it from.
    """
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])

    response = await member_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"title": "Hijacked"}
    )

    assert response.status_code == 403


async def test_a_member_cannot_cancel_someone_elses_meeting(owner_client, member_client, member):
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])

    assert (await member_client.delete(f"/api/v1/meetings/{meeting['id']}")).status_code == 403


async def test_an_owner_can_cancel_a_members_meeting(owner_client, member_client):
    """Elevated users answer for the calendar, so they keep full control of it."""
    meeting = await make_meeting(member_client, title="My own site visit")

    assert (await owner_client.delete(f"/api/v1/meetings/{meeting['id']}")).status_code == 200


async def test_a_meeting_is_created_without_a_meet_link_when_no_token_is_given(
    owner_client,
):
    """A missing Google token degrades the invite; it must not fail the meeting."""
    meeting = await make_meeting(owner_client)

    assert meeting["meet_link"] is None
    assert meeting["title"] == "Site walkthrough"


async def test_attendees_are_recorded_and_invited(owner_client, member, notifications):
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])

    assert [a["email"] for a in meeting["attendees"]] == [member.email]
    assert any(member.email in (s.recipient or "") for s in notifications.sent)


async def test_an_end_time_before_the_start_is_rejected(owner_client):
    response = await owner_client.post(
        "/api/v1/meetings",
        json={
            "title": "Backwards",
            "start_time": END.isoformat(),
            "end_time": START.isoformat(),
        },
    )

    assert response.status_code == 422


async def test_an_invalid_colour_is_rejected(owner_client):
    response = await owner_client.post(
        "/api/v1/meetings",
        json={
            "title": "Colourful",
            "start_time": START.isoformat(),
            "end_time": END.isoformat(),
            "color": "cornflower",
        },
    )

    assert response.status_code == 422


async def test_meetings_can_be_windowed_for_a_calendar_view(owner_client):
    await make_meeting(owner_client, title="September")
    await make_meeting(
        owner_client,
        title="October",
        start_time=(START + timedelta(days=40)).isoformat(),
        end_time=(END + timedelta(days=40)).isoformat(),
    )

    # Passed as params, not interpolated: the "+00:00" offset would otherwise be
    # decoded as a space and rejected.
    window = (
        await owner_client.get(
            "/api/v1/meetings",
            params={
                "from": START.isoformat(),
                "to": (START + timedelta(days=7)).isoformat(),
            },
        )
    ).json()

    assert [m["title"] for m in window] == ["September"]


async def test_renaming_a_meeting_does_not_re_invite_everyone(owner_client, member, notifications):
    """The legacy code re-sent on any update touching attendees, which trained people
    to ignore the invites."""
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])
    notifications.sent.clear()

    await owner_client.patch(f"/api/v1/meetings/{meeting['id']}", json={"color": "#10B981"})

    assert notifications.sent == []


async def test_moving_a_meeting_does_re_invite(owner_client, member, notifications):
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])
    notifications.sent.clear()

    await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}",
        json={
            "start_time": (START + timedelta(hours=2)).isoformat(),
            "end_time": (END + timedelta(hours=2)).isoformat(),
        },
    )

    assert any(member.email in (s.recipient or "") for s in notifications.sent)


async def test_a_partial_update_cannot_invert_the_time_range(owner_client):
    """``MeetingUpdate`` is a partial, so the schema cannot check this on its own.

    A request carrying only ``end_time`` has nothing to compare against until the
    stored ``start_time`` is in hand. Without the service check it stores a meeting that
    finishes before it begins, which renders as a negative duration and produces an ICS
    Outlook rejects.
    """
    meeting = await make_meeting(owner_client)

    response = await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}",
        json={"end_time": (START - timedelta(hours=1)).isoformat()},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"


async def test_a_partial_update_may_move_one_end_within_the_range(owner_client):
    meeting = await make_meeting(owner_client)

    response = await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}",
        json={"end_time": (END + timedelta(hours=1)).isoformat()},
    )

    assert response.status_code == 200


async def test_cancelling_a_meeting_notifies_attendees(owner_client, member, notifications):
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])
    notifications.sent.clear()

    response = await owner_client.delete(f"/api/v1/meetings/{meeting['id']}")

    assert response.status_code == 200
    assert any("cancelled" in s.subject.lower() for s in notifications.sent)


# ── Guests invited by email ───────────────────────────────────────────────────

GUEST = "adjuster@insurer.example.com"


def recipients_of(notifications) -> set[str]:
    """Every address any recorded message went to."""
    return {r for s in notifications.sent for r in (s.recipient or "").split(",") if r}


@pytest.fixture
async def colleague(session_factory) -> Profile:
    """A team member with a deliverable-looking address.

    The shared fixtures live on ``@buildco.test``, a reserved domain the API rightly
    refuses as an email address — fine for an id, useless for typing into a guest field.
    """
    async with session_factory() as session:
        profile = Profile(
            id=uuid.uuid4(),
            firebase_uid=f"fb-{uuid.uuid4().hex[:12]}",
            email="mia@buildco.example.com",
            full_name="Mia Member",
            role=Role.MEMBER.value,
            status=UserStatus.ACTIVE.value,
        )
        session.add(profile)
        await session.commit()
        await session.refresh(profile)
        return profile


async def test_someone_outside_the_team_can_be_invited_by_email(owner_client, notifications):
    """A guest is an attendee row with no ``user_id`` — there is no account behind it."""
    meeting = await make_meeting(owner_client, attendee_emails=[GUEST])

    assert [(a["email"], a["user_id"], a["profile"]) for a in meeting["attendees"]] == [
        (GUEST, None, None)
    ]
    assert GUEST in recipients_of(notifications)


async def test_a_member_can_invite_a_guest_to_their_own_meeting(member_client, notifications):
    """Scheduling is open to everyone, and inviting an outsider is part of scheduling."""
    meeting = await make_meeting(member_client, attendee_emails=[GUEST])

    assert [a["email"] for a in meeting["attendees"]] == [GUEST]
    assert GUEST in recipients_of(notifications)


async def test_members_and_guests_are_invited_together(owner_client, member, notifications):
    meeting = await make_meeting(
        owner_client, attendee_ids=[str(member.id)], attendee_emails=[GUEST]
    )

    assert {a["email"] for a in meeting["attendees"]} == {member.email, GUEST}
    assert recipients_of(notifications) == {member.email, GUEST}


async def test_a_team_members_address_is_invited_as_that_member(owner_client, client_as, colleague):
    """Typing a colleague's email must not produce a second-class invite.

    Visibility is decided by ``user_id``, so a guest row for a team member would email
    them a meeting the app then hid from them.
    """
    meeting = await make_meeting(owner_client, attendee_emails=[colleague.email.upper()])

    assert [a["user_id"] for a in meeting["attendees"]] == [str(colleague.id)]
    async with client_as(colleague) as client:
        titles = [m["title"] for m in (await client.get("/api/v1/meetings")).json()]
    assert titles == ["Site walkthrough"]


async def test_the_same_person_is_not_invited_twice(owner_client, colleague):
    meeting = await make_meeting(
        owner_client,
        attendee_ids=[str(colleague.id)],
        attendee_emails=[colleague.email, GUEST, GUEST.upper()],
    )

    assert sorted(a["email"] for a in meeting["attendees"]) == sorted([colleague.email, GUEST])


async def test_a_malformed_guest_address_is_rejected(owner_client):
    response = await owner_client.post(
        "/api/v1/meetings",
        json={
            "title": "Site walkthrough",
            "start_time": START.isoformat(),
            "end_time": END.isoformat(),
            "attendee_emails": ["not-an-address"],
        },
    )

    assert response.status_code == 422


async def test_adding_a_guest_later_sends_the_invite(owner_client, member, notifications):
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])
    notifications.sent.clear()

    response = await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"attendee_emails": [GUEST]}
    )

    # The member half of the list was not sent, so it must be left exactly as it was.
    assert {a["email"] for a in response.json()["attendees"]} == {member.email, GUEST}
    assert recipients_of(notifications) == {member.email, GUEST}


async def test_changing_the_members_leaves_the_guests_alone(owner_client, member):
    meeting = await make_meeting(owner_client, attendee_emails=[GUEST])

    response = await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"attendee_ids": [str(member.id)]}
    )

    assert {a["email"] for a in response.json()["attendees"]} == {member.email, GUEST}


async def test_a_guest_can_be_removed(owner_client, member):
    meeting = await make_meeting(
        owner_client, attendee_ids=[str(member.id)], attendee_emails=[GUEST]
    )

    response = await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"attendee_emails": []}
    )

    assert [a["email"] for a in response.json()["attendees"]] == [member.email]


async def test_resending_the_same_guests_does_not_re_invite(owner_client, notifications):
    """Same people, different order and case — nothing an attendee would care about."""
    other = "pa@insurer.example.com"
    meeting = await make_meeting(owner_client, attendee_emails=[GUEST, other])
    notifications.sent.clear()

    await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"attendee_emails": [other.upper(), GUEST]}
    )

    assert notifications.sent == []


async def test_recolouring_a_meeting_keeps_its_guests_and_emails_nobody(
    owner_client, notifications
):
    meeting = await make_meeting(owner_client, attendee_emails=[GUEST])
    notifications.sent.clear()

    response = await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}", json={"color": "#10B981"}
    )

    assert [a["email"] for a in response.json()["attendees"]] == [GUEST]
    assert notifications.sent == []


async def test_moving_a_meeting_re_invites_its_guests(owner_client, notifications):
    """Guests have no profile, which is exactly how an update could forget them."""
    meeting = await make_meeting(owner_client, attendee_emails=[GUEST])
    notifications.sent.clear()

    await owner_client.patch(
        f"/api/v1/meetings/{meeting['id']}",
        json={
            "start_time": (START + timedelta(hours=2)).isoformat(),
            "end_time": (END + timedelta(hours=2)).isoformat(),
        },
    )

    assert GUEST in recipients_of(notifications)


async def test_cancelling_a_meeting_notifies_its_guests(owner_client, notifications):
    meeting = await make_meeting(owner_client, attendee_emails=[GUEST])
    notifications.sent.clear()

    await owner_client.delete(f"/api/v1/meetings/{meeting['id']}")

    assert GUEST in recipients_of(notifications)
    assert any("cancelled" in s.subject.lower() for s in notifications.sent)


async def test_the_number_of_guests_is_capped(owner_client):
    """Anyone signed in may schedule, so this bounds the mail one request can send."""
    response = await owner_client.post(
        "/api/v1/meetings",
        json={
            "title": "Everyone",
            "start_time": START.isoformat(),
            "end_time": END.isoformat(),
            "attendee_emails": [f"guest{n}@insurer.example.com" for n in range(51)],
        },
    )

    assert response.status_code == 422


# ── ICS generation ────────────────────────────────────────────────────────────


def build(**overrides):
    params = {
        "event_uid": "abc@buildco",
        "title": "Site walkthrough",
        "description": "Review scope",
        "location": "12 Oak Street",
        "start_time": START,
        "end_time": END,
        "organiser_email": "noreply@buildco.example.com",
        "attendees": [IcsAttendee(email="mia@buildco.example.com", name="Mia Member")],
        **overrides,
    }
    return calendar.build_ics(**params)


def test_the_ics_carries_the_expected_envelope():
    ics = build()

    assert ics.startswith("BEGIN:VCALENDAR")
    assert ics.endswith("END:VCALENDAR")
    assert "METHOD:REQUEST" in ics
    assert "STATUS:CONFIRMED" in ics
    assert "DTSTART:20260901T150000Z" in ics


def test_a_cancellation_is_marked_as_such():
    ics = build(cancelled=True)

    assert "METHOD:CANCEL" in ics
    assert "STATUS:CANCELLED" in ics


def test_special_characters_are_escaped_per_rfc_5545():
    ics = build(title="Walk; through, now", description="Line one\nLine two")

    assert "SUMMARY:Walk\\; through\\, now" in ics
    assert "\\n" in ics


def test_long_lines_are_folded():
    """Outlook rejects a calendar file containing lines over 75 octets."""
    ics = build(description="x" * 400)

    assert all(len(line.encode()) <= 75 for line in ics.split("\r\n"))


def test_the_sequence_number_is_emitted_for_updates():
    assert "SEQUENCE:7" in build(sequence=7)


# ── Health ────────────────────────────────────────────────────────────────────


async def test_liveness_does_not_touch_the_database(owner_client):
    body = (await owner_client.get("/healthz")).json()

    assert body["status"] == "ok"
    assert body["environment"] == "test"


async def test_readiness_reports_the_database(owner_client):
    body = (await owner_client.get("/readyz")).json()

    assert body == {"status": "ready", "database": "up"}


async def test_livez_is_an_alias_reachable_on_cloud_run(owner_client):
    """Cloud Run's front end reserves ``/healthz``, so the request never reaches the
    container and an uptime check aimed there reports a healthy service as down.
    ``/livez`` is the same probe under a path that is not intercepted."""
    healthz = (await owner_client.get("/healthz")).json()
    livez = (await owner_client.get("/livez")).json()

    assert livez == healthz
    assert livez["status"] == "ok"


# ── AI ────────────────────────────────────────────────────────────────────────


async def test_ai_parsing_reports_unavailable_without_a_key(owner_client):
    """Groq is unconfigured in tests, so this must be an honest 503 rather than a
    confusing success."""
    response = await owner_client.post(
        "/api/v1/ai/parse-estimate", json={"notes": "Two rooms, two coats of paint."}
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "integration_unavailable"


async def test_blank_notes_are_rejected_before_reaching_the_model(owner_client):
    response = await owner_client.post("/api/v1/ai/parse-estimate", json={"notes": "   "})

    assert response.status_code == 422


def test_a_hallucinated_category_falls_back_rather_than_failing_the_parse():
    """Losing one classification is a far better outcome for the user than losing the
    whole parse."""
    from app.schemas.ai import ParsedEstimate

    parsed = ParsedEstimate.model_validate(
        {
            "rooms": [
                {
                    "name": "Kitchen",
                    "items": [{"name": "Backsplash", "category": "tiling", "unit": "sf"}],
                }
            ]
        }
    )

    assert parsed.rooms[0].items[0].category == "other"
    assert parsed.rooms[0].items[0].unit == "SF"


def test_a_parse_with_no_rooms_is_rejected():
    import pytest
    from pydantic import ValidationError

    from app.schemas.ai import ParsedEstimate

    with pytest.raises(ValidationError):
        ParsedEstimate.model_validate({"rooms": []})


# ── Attachments ───────────────────────────────────────────────────────────────


async def test_an_upload_url_is_unavailable_without_a_bucket(owner_client):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    response = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/attachments/upload-url",
        json={"file_name": "photo.jpg", "content_type": "image/jpeg"},
    )

    assert response.status_code == 503


async def test_an_attachment_cannot_claim_a_path_from_another_estimate(owner_client):
    """Without this check, posting any object key would attach a file the caller may
    not even be allowed to read."""
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    response = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/attachments",
        json={
            "storage_path": f"{uuid.uuid4()}/0_0_123.jpg",
            "file_name": "photo.jpg",
            "content_type": "image/jpeg",
        },
    )

    assert response.status_code == 403


async def test_a_video_attachment_is_flagged_from_its_mime_type(owner_client):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    response = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/attachments",
        json={
            "storage_path": f"{estimate['id']}/0_0_123.mp4",
            "file_name": "walkthrough.mp4",
            "content_type": "video/mp4",
            "room_index": 0,
            "item_index": 0,
        },
    )

    assert response.status_code == 201
    assert response.json()["is_video"] is True
    # No bucket configured, so there is no URL to sign — the row still returns.
    assert response.json()["url"] is None


async def test_an_attachment_records_without_explicit_indexes(owner_client):
    """Both index columns are NOT NULL while the request schema leaves them optional.

    Passing the ``None`` straight through suppressed the column default and made the
    very first photo upload a 500 — the one existing creation test supplied both
    indexes, so the path was never exercised.
    """
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()

    response = await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/attachments",
        json={
            "storage_path": f"{estimate['id']}/0_0_123.jpg",
            "file_name": "photo.jpg",
            "content_type": "image/jpeg",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["room_index"] == 0
    assert body["item_index"] == 0


async def test_attachments_are_listed_for_an_estimate(owner_client):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()
    await owner_client.post(
        f"/api/v1/estimates/{estimate['id']}/attachments",
        json={
            "storage_path": f"{estimate['id']}/1_2_123.jpg",
            "file_name": "photo.jpg",
            "content_type": "image/jpeg",
            "room_index": 1,
            "item_index": 2,
        },
    )

    response = await owner_client.get(f"/api/v1/estimates/{estimate['id']}/attachments")

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["file_name"] == "photo.jpg"
    assert rows[0]["room_index"] == 1
    assert rows[0]["url"] is None


async def test_an_attachment_can_be_deleted(owner_client):
    estimate = (await owner_client.post("/api/v1/estimates", json={"project_name": "X"})).json()
    created = (
        await owner_client.post(
            f"/api/v1/estimates/{estimate['id']}/attachments",
            json={
                "storage_path": f"{estimate['id']}/0_0_123.jpg",
                "file_name": "photo.jpg",
                "content_type": "image/jpeg",
            },
        )
    ).json()

    response = await owner_client.delete(f"/api/v1/attachments/{created['id']}")
    assert response.status_code == 200

    remaining = (await owner_client.get(f"/api/v1/estimates/{estimate['id']}/attachments")).json()
    assert remaining == []


async def test_a_member_cannot_delete_an_attachment_on_another_persons_estimate(
    client_as, member, other_member
):
    async with client_as(other_member) as theirs:
        estimate = (await theirs.post("/api/v1/estimates", json={"project_name": "X"})).json()
        created = (
            await theirs.post(
                f"/api/v1/estimates/{estimate['id']}/attachments",
                json={
                    "storage_path": f"{estimate['id']}/0_0_123.jpg",
                    "file_name": "photo.jpg",
                    "content_type": "image/jpeg",
                },
            )
        ).json()

    async with client_as(member) as mine:
        response = await mine.delete(f"/api/v1/attachments/{created['id']}")

    assert response.status_code == 403
