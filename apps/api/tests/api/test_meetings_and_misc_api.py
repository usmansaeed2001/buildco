"""Meetings, health probes, AI parsing, and attachments."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

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


async def test_a_member_cannot_schedule_a_meeting(member_client):
    response = await member_client.post(
        "/api/v1/meetings",
        json={
            "title": "Nope",
            "start_time": START.isoformat(),
            "end_time": END.isoformat(),
        },
    )

    assert response.status_code == 403


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


async def test_cancelling_a_meeting_notifies_attendees(owner_client, member, notifications):
    meeting = await make_meeting(owner_client, attendee_ids=[str(member.id)])
    notifications.sent.clear()

    response = await owner_client.delete(f"/api/v1/meetings/{meeting['id']}")

    assert response.status_code == 200
    assert any("cancelled" in s.subject.lower() for s in notifications.sent)


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
