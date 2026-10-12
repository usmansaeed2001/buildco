"""Google Calendar / Meet, and ICS generation.

Two separate concerns live here:

* **Meet link creation** needs an OAuth access token carrying the ``calendar.events``
  scope. That token comes from the client, which asks Google for it when the meeting's
  creator opts in to a Meet link — not at sign-in. It is optional — a meeting without a
  Meet link is perfectly valid, which is why every failure path returns ``None`` rather
  than raising.
* **ICS generation** is pure string building with no network involved, which is why it
  is directly testable and lives alongside rather than inside the HTTP call.
"""

from __future__ import annotations

import uuid as uuid_module
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from app.config import get_settings
from app.logging import get_logger

log = get_logger(__name__)

CALENDAR_EVENTS_ENDPOINT = (
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1"
)


@dataclass(frozen=True, slots=True)
class CalendarEvent:
    meet_link: str | None
    google_event_id: str | None


@dataclass(frozen=True, slots=True)
class IcsAttendee:
    email: str
    name: str = ""


async def create_meet_event(
    *,
    access_token: str | None,
    title: str,
    description: str,
    location: str,
    start_time: datetime,
    end_time: datetime,
) -> CalendarEvent:
    """Create a Google Calendar event with a Meet conference attached.

    Returns empty fields rather than raising when no token is supplied or the call
    fails: the meeting itself must still be created and its invites still sent. A
    missing Meet link degrades the invite, it does not invalidate it.
    """
    if not access_token:
        return CalendarEvent(meet_link=None, google_event_id=None)

    settings = get_settings()
    body = {
        "summary": title,
        "description": description or "",
        "location": location or "",
        "start": {
            "dateTime": start_time.isoformat(),
            "timeZone": settings.calendar_timezone,
        },
        "end": {
            "dateTime": end_time.isoformat(),
            "timeZone": settings.calendar_timezone,
        },
        "conferenceData": {
            "createRequest": {
                "requestId": f"buildco-{uuid_module.uuid4().hex}",
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        },
    }

    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
            response = await client.post(
                CALENDAR_EVENTS_ENDPOINT,
                headers={"Authorization": f"Bearer {access_token}"},
                json=body,
            )
    except httpx.HTTPError as exc:
        log.error("calendar_request_error", error=str(exc))
        return CalendarEvent(meet_link=None, google_event_id=None)

    if response.status_code >= 400:
        log.error(
            "calendar_error_response",
            status=response.status_code,
            body=response.text[:400],
        )
        return CalendarEvent(meet_link=None, google_event_id=None)

    data = response.json()
    entry_points = (data.get("conferenceData") or {}).get("entryPoints") or []
    meet_link = next(
        (e.get("uri") for e in entry_points if e.get("entryPointType") == "video"),
        None,
    )
    return CalendarEvent(meet_link=meet_link, google_event_id=data.get("id"))


async def delete_event(access_token: str | None, google_event_id: str | None) -> bool:
    """Remove the event from the organiser's Google Calendar. Best effort."""
    if not access_token or not google_event_id:
        return False

    settings = get_settings()
    url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{google_event_id}"
    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
            response = await client.delete(url, headers={"Authorization": f"Bearer {access_token}"})
    except httpx.HTTPError as exc:
        log.error("calendar_delete_error", error=str(exc))
        return False
    return response.status_code < 400


# ── ICS ───────────────────────────────────────────────────────────────────────


def _ics_timestamp(value: datetime) -> str:
    """Format as a UTC basic-format timestamp, e.g. ``20260817T153000Z``."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _escape(text: str) -> str:
    """Escape per RFC 5545: backslash, semicolon, comma, and newline."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """Fold lines longer than 75 octets, as the spec requires.

    Outlook in particular rejects a calendar file with over-long lines. The legacy
    implementation did not fold at all, so a long description could produce an invite
    that some clients silently refused to import.
    """
    if len(line.encode("utf-8")) <= 75:
        return line
    chunks: list[str] = []
    current = ""
    for char in line:
        candidate = current + char
        limit = 75 if not chunks else 74  # continuation lines carry a leading space
        if len(candidate.encode("utf-8")) > limit:
            chunks.append(current)
            current = char
        else:
            current = candidate
    chunks.append(current)
    return "\r\n ".join(chunks)


def build_ics(
    *,
    event_uid: str,
    title: str,
    description: str,
    location: str,
    start_time: datetime,
    end_time: datetime,
    organiser_email: str,
    attendees: list[IcsAttendee],
    meet_link: str | None = None,
    cancelled: bool = False,
    sequence: int = 0,
) -> str:
    """Build an RFC 5545 VEVENT.

    ``sequence`` must increase on every update to the same ``event_uid``, otherwise
    calendar clients ignore the revision and keep showing the original time.
    """
    body = description or ""
    if meet_link:
        body = f"Join Google Meet: {meet_link}" + (f"\n\n{body}" if body else "")

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//BuildCo//Meeting//EN",
        "CALSCALE:GREGORIAN",
        f"METHOD:{'CANCEL' if cancelled else 'REQUEST'}",
        "BEGIN:VEVENT",
        f"UID:{event_uid}",
        f"DTSTAMP:{_ics_timestamp(datetime.now(UTC))}",
        f"DTSTART:{_ics_timestamp(start_time)}",
        f"DTEND:{_ics_timestamp(end_time)}",
        f"SUMMARY:{_escape(title)}",
    ]

    if body:
        lines.append(f"DESCRIPTION:{_escape(body)}")
    if location:
        lines.append(f"LOCATION:{_escape(location)}")
    if meet_link:
        lines.append(f"URL:{meet_link}")

    lines.append(f'ORGANIZER;CN="BuildCo":mailto:{organiser_email}')
    lines.extend(
        f'ATTENDEE;CN="{_escape(a.name or a.email)}";RSVP=TRUE:mailto:{a.email}' for a in attendees
    )
    lines.extend(
        [
            f"STATUS:{'CANCELLED' if cancelled else 'CONFIRMED'}",
            f"SEQUENCE:{sequence}",
            "END:VEVENT",
            "END:VCALENDAR",
        ]
    )

    return "\r\n".join(_fold(line) for line in lines)
