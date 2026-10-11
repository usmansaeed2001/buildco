"""Row locks on meetings and estimates. Postgres only.

Every write to a meeting or an estimate takes a lock on that row first, including the
writes that never touch the row itself: a change to a meeting's attendees, and a photo
recorded against an estimate. That is what lets a caller check a record and act on the
check in one transaction, knowing nobody changed it in between.

SQLite has no row locks and ignores ``FOR UPDATE``, so on SQLite these would pass
whether the lock was there or not. They are marked ``postgres`` and skipped unless the
suite is pointed at one (``make test-pg``), which the release build does.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attachment import Attachment
from app.models.estimate import Estimate
from app.models.meeting import Meeting
from app.models.profile import Profile
from app.schemas.estimate import EstimateCreate, EstimateUpdate
from app.schemas.meeting import MeetingCreate, MeetingUpdate
from app.services import actions, attachment_service, estimate_service, meeting_service

pytestmark = pytest.mark.postgres

START = datetime(2026, 9, 1, 15, 0, tzinfo=UTC)
END = START + timedelta(hours=1)

Write = Callable[[AsyncSession, Profile], Awaitable[object]]


@pytest.fixture
async def meeting(session_factory, owner) -> Meeting:
    async with session_factory() as session:
        created = await actions.create_meeting(
            session,
            await session.get(Profile, owner.id),
            MeetingCreate(title="Site walkthrough", start_time=START, end_time=END),
        )
        await session.commit()
        return created.meeting


@pytest.fixture
async def estimate(session_factory, owner) -> Estimate:
    async with session_factory() as session:
        created = await actions.create_estimate(
            session,
            await session.get(Profile, owner.id),
            EstimateCreate(project_name="Water damage supplement"),
        )
        await session.commit()
        return created.estimate


async def refused_while_locked(session_factory, owner: Profile, write: Write) -> bool:
    """Whether ``write`` had to wait for a lock, shown by it giving up after 400 ms."""
    async with session_factory() as session:
        await session.execute(text("SET LOCAL lock_timeout = '400ms'"))
        try:
            await write(session, await session.get(Profile, owner.id))
        except DBAPIError as exc:
            await session.rollback()
            assert "lock timeout" in str(exc).lower(), exc
            return True
        await session.rollback()
        return False


# ── Meetings ──────────────────────────────────────────────────────────────────


async def test_a_change_to_the_attendees_alone_waits_for_the_meetings_lock(
    session_factory, owner, member, meeting
):
    """The case a lock on "the row being written" would miss.

    Changing who is on a meeting writes ``meeting_attendees`` and nothing else, so
    without an explicit lock it would not wait for another writer at all.
    """

    async def change_attendees(session: AsyncSession, actor: Profile) -> object:
        return await actions.update_meeting(
            session, actor, meeting.id, MeetingUpdate(attendee_ids=[member.id])
        )

    async with session_factory() as holder:
        await meeting_service.get_meeting(
            holder, await holder.get(Profile, owner.id), meeting.id, for_update=True
        )

        assert await refused_while_locked(session_factory, owner, change_attendees)

        await holder.commit()

    assert not await refused_while_locked(session_factory, owner, change_attendees)


async def test_the_second_writer_to_a_meeting_works_from_what_the_first_left(
    session_factory, owner, member, meeting
):
    async with session_factory() as first, session_factory() as second:
        first_actor = await first.get(Profile, owner.id)
        second_actor = await second.get(Profile, owner.id)
        # The second session reads the meeting before the first changes it, so a stale
        # copy is sitting in its identity map when it comes to write.
        await meeting_service.get_meeting(second, second_actor, meeting.id)
        await second.rollback()

        await actions.update_meeting(first, first_actor, meeting.id, MeetingUpdate(title="Moved"))
        waiting = asyncio.create_task(
            actions.update_meeting(
                second, second_actor, meeting.id, MeetingUpdate(attendee_ids=[member.id])
            )
        )
        await asyncio.sleep(0.3)
        assert not waiting.done(), "the second writer did not wait for the first"

        await first.commit()
        result = await asyncio.wait_for(waiting, 5)
        await second.commit()

    assert result.meeting.title == "Moved"
    assert [a.user_id for a in result.meeting.attendees] == [member.id]


# ── Estimates ─────────────────────────────────────────────────────────────────


def estimate_writes(estimate_id) -> dict[str, Write]:
    async def update(session: AsyncSession, actor: Profile) -> object:
        return await actions.update_estimate(
            session, actor, estimate_id, EstimateUpdate(project_name="Renamed")
        )

    async def transition(session: AsyncSession, actor: Profile) -> object:
        return await actions.transition_estimate(session, actor, estimate_id, "archive")

    async def record_photo(session: AsyncSession, actor: Profile) -> object:
        return await attachment_service.record_attachment(
            session,
            actor,
            estimate_id,
            storage_path=f"{estimate_id}/0_0_photo.jpg",
            file_name="photo.jpg",
            content_type="image/jpeg",
            room_index=0,
            item_index=0,
        )

    return {"update": update, "transition": transition, "record_photo": record_photo}


@pytest.mark.parametrize("name", ["update", "transition", "record_photo"])
async def test_every_write_to_an_estimate_waits_for_its_lock(
    session_factory, owner, estimate, name
):
    """A photo is the one that matters most: it changes what the estimate holds without
    writing to the ``estimates`` row."""
    write = estimate_writes(estimate.id)[name]

    async with session_factory() as holder:
        await estimate_service.get_estimate(
            holder, await holder.get(Profile, owner.id), estimate.id, for_update=True
        )

        assert await refused_while_locked(session_factory, owner, write)

        await holder.commit()

    assert not await refused_while_locked(session_factory, owner, write)


async def test_a_photo_cannot_land_between_a_check_and_a_write(session_factory, owner, estimate):
    """What the lock is for: count the photos, then act on the count, undisturbed."""
    record_photo = estimate_writes(estimate.id)["record_photo"]

    async with session_factory() as checker, session_factory() as uploader:
        await estimate_service.get_estimate(
            checker, await checker.get(Profile, owner.id), estimate.id, for_update=True
        )
        photos = select(func.count()).select_from(Attachment)
        before = await checker.scalar(photos.where(Attachment.estimate_id == estimate.id))

        uploading = asyncio.create_task(
            record_photo(uploader, await uploader.get(Profile, owner.id))
        )
        await asyncio.sleep(0.3)
        still_waiting = not uploading.done()
        during = await checker.scalar(photos.where(Attachment.estimate_id == estimate.id))

        await checker.commit()
        await asyncio.wait_for(uploading, 5)
        await uploader.commit()

    assert still_waiting
    assert (before, during) == (0, 0)
