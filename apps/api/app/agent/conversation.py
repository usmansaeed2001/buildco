"""One conversation, over one socket.

Audio goes up to the model and comes back down, with captions both ways. Around that
sits everything the model is not trusted with: which tools exist, whether a spoken "yes"
counts, the commit itself, what the model is told about a commit it did not see finish,
and how long any of this may go on.

Several things here came out of testing against the real model and are not optional.

**A commit the user talks over still completes, and the model is told it was cancelled.**
Left alone, the model then says "I have stopped the process" about something that was
saved. So a commit runs in its own task, its outcome goes to the browser directly, and
if the model was interrupted before it could report the outcome, the outcome is sent
into the conversation as a notice of its own.

**The model commits on a "yes" that interrupts the read-back**, whatever its
instructions say. The guard in ``agent_rules.refuse_voice_commit`` is what stops that,
on facts the model does not control: where the microphone stream stood when the
read-back finished playing, where the user's answer began, and whether the read-back
actually said what it had to (``agent_readback``).

**A model session is shorter-lived than a conversation.** It is replaced about every ten
minutes, a replacement can fail, and its memory of early turns is not dependable. When a
session ends for any reason other than the conversation ending, another is started,
seeded with what the server holds: what has been committed, what is open, and the recent
transcript.

**A socket is shorter-lived than a conversation too.** A dropped connection leaves the
conversation open for a minute, and a reconnect carries on under a new *generation*. The
old socket is often only half dead and cannot tell; its next heartbeat matches no row,
and it stops without touching the meter or ending anything.

**Time is metered here, by the server.** ``live_seconds`` advances only while audio is
live on the socket that holds the current generation: not during an approval pause, not
while disconnected. The same heartbeat re-reads the team's allowance, which is what lets
an owner switch the assistant off for conversations already in progress.

Nothing here holds a database session open. See the package docstring.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Callable, MutableMapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import instruction, proposals, tools
from app.agent.model import LiveModel, ModelEvent, ModelSession, Tool
from app.agent.proposals import ProposalRefused, SessionFactory
from app.agent.tools import Build, refuse
from app.config import get_settings
from app.logging import get_logger
from app.models.agent import AgentAction, AgentConversation, AgentMemory, AgentMessage
from app.models.enums import (
    AgentActionStatus,
    AgentApprovalPolicy,
    AgentApprovedVia,
    AgentEndReason,
    AgentMessageRole,
    AgentMessageSource,
    UserStatus,
)
from app.models.profile import Profile
from app.models.settings import CatalogueItem
from app.services import agent_memory_service, agent_service
from app.services.rules import agent_readback, agent_rules
from app.services.rules.agent_rules import Term, VoiceCommitFacts

log = get_logger(__name__)

#: 16 kHz, 16-bit, mono, up; 24 kHz, 16-bit, mono, down.
MIC_BYTES_PER_SECOND = 32_000
VOICE_BYTES_PER_SECOND = 48_000
#: How long a tool waits for the browser to say it has done something on screen. A tool
#: must return quickly: the model's events are not delivered while one is running, the
#: user's interruption included.
DIRECTIVE_TIMEOUT_SECONDS = 5.0
#: How many times a dead model session is replaced before the conversation gives up.
MAX_MODEL_RESTARTS = 3
#: How often the conversation looks at its clocks.
TICK_SECONDS = 1.0
#: How often it stamps its row, advances the meter and re-reads the team's allowance.
HEARTBEAT_SECONDS = 5.0
#: The warning before the hard cap, and before the day's allowance runs out.
TIME_WARNING_SECONDS = 120.0
ALLOWANCE_WARNING_SECONDS = 60.0
#: After the model has been asked to say goodbye, how long it gets to say it.
GOODBYE_SECONDS = 8.0
#: How many words the transcriber is told to expect.
VOCABULARY_LIMIT = 300

NOTICE = "[System notice, not from the user] "


class Socket(Protocol):
    """The part of a WebSocket a conversation uses. Starlette's fits; so does a fake."""

    async def receive(self) -> MutableMapping[str, Any]: ...
    async def send_text(self, data: str) -> None: ...
    async def send_bytes(self, data: bytes) -> None: ...


@dataclass(frozen=True, slots=True)
class Ending:
    """How a socket's part in a conversation came to an end.

    Three different things, and what happens next differs for each:

    * ``ended``: the conversation is over, for ``reason``.
    * ``dropped``: the connection went away without saying goodbye. The conversation is
      held open for a reconnect.
    * ``replaced``: a reconnect has taken the conversation over. It carries on, on
      another socket, and this one must change nothing.
    """

    how: Literal["ended", "dropped", "replaced"]
    reason: AgentEndReason | None = None
    #: More about why, for the browser. ``allowance`` when the day's time ran out.
    detail: str | None = None

    @classmethod
    def ended(cls, reason: AgentEndReason, detail: str | None = None) -> Ending:
        return cls("ended", reason, detail)


@dataclass(slots=True)
class _OpenProposal:
    """The one proposal waiting for an answer, and what is known about its read-back."""

    id: uuid.UUID
    kind: str
    policy: AgentApprovalPolicy
    expires_at: datetime
    #: What must be heard in the read-back for a spoken yes to count.
    terms: list[Term] = field(default_factory=list)
    #: The agent finished a turn in which it read the summary back, well or badly.
    readback_spoken: bool = False
    #: Everything that had to be said in it was said.
    verified: bool = False
    #: Where the microphone stream stood when the browser reported that turn played.
    played_at: float | None = None
    typed_after: bool = False
    #: What a user on a phone says back to approve it, and what must be heard in it.
    confirm_line: str = ""
    confirm_terms: list[Term] = field(default_factory=list)
    #: The user's own words since the read-back finished: utterances that began after
    #: it, and anything typed. Never the agent's voice picked up by the microphone.
    said_after: list[str] = field(default_factory=list)

    @classmethod
    def of(cls, action: AgentAction) -> _OpenProposal:
        confirm = (action.labels or {}).get("confirm") or {}
        return cls(
            id=action.id,
            kind=action.kind,
            policy=proposals.policy_of(action),
            expires_at=_as_utc(action.expires_at),
            terms=list(action.required_terms or []),
            confirm_line=str(confirm.get("line") or ""),
            confirm_terms=list(confirm.get("terms") or []),
        )


class LiveConversation:
    def __init__(
        self,
        *,
        socket: Socket,
        model: LiveModel,
        factory: SessionFactory,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
        generation: int = 0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._socket = socket
        self._model = model
        self._factory = factory
        self.conversation_id = conversation_id
        self.user_id = user_id
        self.generation = generation
        self._clock = clock
        self._settings = get_settings()
        self._log = log.bind(conversation_id=str(conversation_id))

        self._session: ModelSession | None = None
        #: False once the model has been closed on purpose and must not be restarted.
        self._model_wanted = True
        self._finish: asyncio.Future[Ending] | None = None
        self._stop = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self._acks: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.context: dict[str, Any] = {}
        self.timezone = "UTC"
        self._name = ""
        self._role = ""
        self._roster: list[str] = []

        self._mic_bytes = 0
        self._voice_bytes = 0
        self._open: _OpenProposal | None = None
        self._last_utterance_began: float | None = None
        self._last_heard = ""
        self._said_whole: list[str] = []
        self._said_so_far = ""
        self._turn_spoke = False
        #: The outcome of a commit the model has not yet told the user about.
        self._unreported: str | None = None

        # Clocks. All in seconds on ``clock``, which never goes backwards.
        self._started = clock()
        self._elapsed_before = 0.0
        #: Live seconds not yet written to the conversation's row.
        self._unbilled = 0.0
        #: What is left of the day's allowance, as far as this socket knows.
        self._left = 0.0
        #: The allowance ran out with a proposal open: the model is closed and the
        #: socket stays, silent, so the proposal can still be approved by click.
        self._spent = False
        #: Waiting for an approval with the microphone off.
        self._paused = False
        #: When the answer window after a read-back closes and the audio pauses.
        self._window_closes: float | None = None
        self._agent_active = False
        self._quiet_for = 0.0
        self._idle_warned = False
        self._time_warned = False
        self._allowance_warned = False
        self._goodbye_due: float | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def run(self) -> Ending:
        """Carry the conversation on this socket until it stops, and say how it stopped."""
        self._finish = asyncio.get_running_loop().create_future()
        async with self._factory() as db:
            conversation = await db.get(AgentConversation, self.conversation_id)
            actor = await db.get(Profile, self.user_id)
            if conversation is None or actor is None:
                return Ending.ended(AgentEndReason.ERROR)
            self.timezone = conversation.client_timezone
            self._name = actor.display_name
            self._role = actor.role
            self._left = float(
                (await agent_service.allowance_for(db, self.user_id)).remaining_seconds
            )
            if conversation.started_at is not None:
                began = conversation.started_at
                began = began if began.tzinfo is not None else began.replace(tzinfo=UTC)
                self._elapsed_before = max(0.0, (datetime.now(UTC) - began).total_seconds())
            waiting = await proposals.open_proposal(db, self.conversation_id)
            restored = proposals.describe(waiting) if waiting is not None else None
            if waiting is not None:
                # A reconnect. The proposal is still staged in the browser; what was
                # known about its read-back went with the old socket, so a spoken yes
                # needs it read again. A click needs nothing.
                self._open = _OpenProposal.of(waiting)

        limit = float(self._settings.agent_max_session_seconds)
        await self._send(
            "ready",
            conversation_id=str(self.conversation_id),
            limits={
                "max_session_seconds": int(limit),
                "remaining_seconds": int(self._left),
            },
            resumed=self.generation > 0,
        )
        if restored is not None:
            await self._send("mode", mode="working")
            await self._send("proposal", **restored)

        ending = Ending.ended(AgentEndReason.ERROR)
        jobs: list[asyncio.Task[Any]] = []
        try:
            self._session = await self._open_model()
            jobs = [
                asyncio.create_task(self._upstream()),
                asyncio.create_task(self._downstream()),
                asyncio.create_task(self._ticker()),
            ]
            watched: set[asyncio.Future[Any]] = {*jobs, self._finish}
            done, _ = await asyncio.wait(
                watched,
                timeout=max(0.0, limit - self._elapsed_before),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                ending = Ending.ended(AgentEndReason.TIME_LIMIT)
            elif self._finish in done:
                ending = self._finish.result()
            else:
                finished = next(iter(done))
                if finished.exception() is None and isinstance(finished.result(), Ending):
                    ending = finished.result()
                else:
                    self._log.error("agent_conversation_crashed", exc_info=finished.exception())
        finally:
            # The two relays are cancelled where they wait. The ticker is asked to stop
            # and allowed to finish what it is doing: it may be half-way through writing
            # the meter, and a database call cancelled mid-flight costs its connection.
            self._stop.set()
            for job in jobs[:2]:
                job.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            if self._session is not None:
                await self._close_quietly(self._session)
            if ending.how != "replaced":
                await self._beat(final=True)
            if ending.how == "ended":
                await self._discard_open_proposal()
                await self._send("ended", reason=_value(ending.reason), detail=ending.detail)
            elif ending.how == "replaced":
                await self._send(
                    "ended", reason=AgentEndReason.SUPERSEDED.value, detail="reconnected"
                )
        return ending

    def _end(self, ending: Ending) -> None:
        if self._finish is not None and not self._finish.done():
            self._finish.set_result(ending)

    async def _discard_open_proposal(self) -> None:
        """A proposal still open when the conversation ends is dropped, never committed."""
        if self._open is None:
            return
        async with self._factory() as db:
            await proposals.resolve(db, self._open.id, AgentActionStatus.CANCELLED)
            await db.commit()
        self._open = None

    # ── Clocks ────────────────────────────────────────────────────────────────

    def _metering(self) -> bool:
        """Whether audio is live, which is what the allowance is spent on."""
        return self._session is not None and not self._paused and not self._spent

    async def _ticker(self) -> None:
        """Everything that happens because time passed, in one place."""
        last = self._clock()
        last_beat = last
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), TICK_SECONDS)
            except TimeoutError:
                pass
            else:
                return
            now = self._clock()
            passed, last = now - last, now
            try:
                if self._metering():
                    self._unbilled += passed
                    self._left -= passed
                if now - last_beat >= HEARTBEAT_SECONDS:
                    last_beat = now
                    await self._beat()
                await self._watch_the_allowance()
                await self._watch_the_cap(now)
                await self._watch_the_proposal(now)
                await self._watch_for_silence(passed)
                if self._goodbye_due is not None and now >= self._goodbye_due:
                    self._end(Ending.ended(AgentEndReason.USER_CLOSED))
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failed tick must not end a conversation: the next one tries again.
                self._log.exception("agent_tick_failed")

    async def _beat(self, *, final: bool = False) -> None:
        """Stamp the row, write the seconds used, and learn whether this is still ours."""
        seconds = int(self._unbilled)
        self._unbilled -= seconds
        try:
            async with self._factory() as db:
                beat = await agent_service.heartbeat(
                    db, self.conversation_id, self.generation, live_seconds=seconds
                )
                if final:
                    await agent_service.record_usage(
                        db,
                        self.conversation_id,
                        seconds_in=self._mic_bytes // MIC_BYTES_PER_SECOND,
                        seconds_out=self._voice_bytes // VOICE_BYTES_PER_SECOND,
                    )
                await db.commit()
        except Exception:
            self._unbilled += seconds
            self._log.exception("agent_heartbeat_failed")
            return
        if final:
            return
        if not beat.owns_it:
            if beat.ended_as is None:
                self._end(Ending("replaced"))
            else:
                self._end(Ending.ended(AgentEndReason(beat.ended_as)))
            return
        # The server's figure, which counts every conversation of the day and the
        # team's allowance as it stands right now. Zero ends this within one beat.
        self._left = float(beat.remaining_seconds) - self._unbilled

    async def _watch_the_allowance(self) -> None:
        if self._spent:
            return
        if self._left <= 0:
            await self._allowance_spent()
        elif self._left <= ALLOWANCE_WARNING_SECONDS and not self._allowance_warned:
            self._allowance_warned = True
            await self._send("notice", kind="allowance_low", seconds=int(self._left))
            self._notify_model(
                "About one minute of the user's time with you today is left. Tell them so, "
                "briefly, and carry on."
            )

    async def _allowance_spent(self) -> None:
        """The day's time has run out, or the team switched the assistant off.

        A proposal already waiting is not thrown away. The model is closed and the meter
        stops, but the socket stays, silent, until the proposal is approved, rejected or
        expires. Clicking Approve does not involve the model and costs nothing.
        """
        self._spent = True
        self._log.info("agent_allowance_exhausted", user=str(self.user_id), at="live")
        await self._send("notice", kind="allowance_exhausted")
        if self._open is None:
            self._end(Ending.ended(AgentEndReason.TIME_LIMIT, "allowance"))
            return
        self._model_wanted = False
        session, self._session = self._session, None
        if session is not None:
            await self._close_quietly(session)
        await self._send("interrupted")
        await self._send("audio", state="paused", reason="allowance")

    async def _watch_the_cap(self, now: float) -> None:
        if self._time_warned:
            return
        elapsed = self._elapsed_before + (now - self._started)
        if elapsed >= self._settings.agent_max_session_seconds - TIME_WARNING_SECONDS:
            self._time_warned = True
            await self._send("notice", kind="time_limit_warning")
            self._notify_model(
                "This conversation reaches its time limit in about two minutes and will "
                "end then. Tell the user so, briefly."
            )

    async def _watch_the_proposal(self, now: float) -> None:
        waiting = self._open
        if waiting is None:
            return
        if waiting.expires_at <= datetime.now(UTC):
            async with self._factory() as db:
                closed = await proposals.resolve(db, waiting.id, AgentActionStatus.EXPIRED)
                await db.commit()
            if closed and self._open is waiting:
                self._open = None
                await self._send("proposal_result", id=str(waiting.id), status="expired")
                await self._leave_work_mode()
                self._notify_model(
                    "The proposal waited too long for an answer and has expired. Nothing "
                    "was saved. Tell the user, and offer to stage it again."
                )
                await self._resolved()
            return
        if (
            self._window_closes is not None
            and now >= self._window_closes
            and not self._paused
            and not self._spent
        ):
            # Nobody answered. Stop streaming a job site to the cloud while someone
            # reads, and stop charging them for it.
            self._paused = True
            self._window_closes = None
            await self._send("audio", state="paused", reason="approval")

    async def _watch_for_silence(self, passed: float) -> None:
        """Idle timing. The clock does not run while the agent is speaking, while a
        proposal is waiting, or while paused, so it only ever measures real silence."""
        if self._open is not None or self._agent_active or self._paused or self._spent:
            return
        self._quiet_for += passed
        state = agent_rules.idle_state(
            quiet_for=self._quiet_for,
            warning_after=self._settings.agent_idle_warning_seconds,
            timeout_after=self._settings.agent_idle_timeout_seconds,
            paused=False,
        )
        if state == "end":
            self._end(Ending.ended(AgentEndReason.IDLE_TIMEOUT))
        elif state == "warn" and not self._idle_warned:
            self._idle_warned = True
            await self._send("notice", kind="idle_warning")
            self._notify_model(
                "The user has said nothing for a while. Ask, briefly, whether they are still there."
            )

    def _user_did_something(self) -> None:
        self._quiet_for = 0.0
        self._idle_warned = False
        if self._window_closes is not None:
            self._window_closes = self._clock() + self._settings.agent_approval_voice_window_seconds

    async def _resolved(self) -> None:
        """The open proposal has been answered, one way or another."""
        self._window_closes = None
        self._quiet_for = 0.0
        if self._spent:
            self._end(Ending.ended(AgentEndReason.TIME_LIMIT, "allowance"))
        elif self._paused:
            self._paused = False
            await self._send("audio", state="live")

    # ── The model session ─────────────────────────────────────────────────────

    async def _open_model(self) -> ModelSession:
        async with self._factory() as db:
            state = await self._state_card(db)
            people = list(
                await db.scalars(select(Profile).where(Profile.status != UserStatus.BANNED.value))
            )
            actor = await db.get(Profile, self.user_id)
            memories = (
                [m.content for m in await agent_memory_service.list_memories(db, actor)]
                if actor is not None
                else []
            )
            things = (await db.execute(select(CatalogueItem.name, CatalogueItem.unit))).all()
        self._roster = [person.display_name for person in people if person.display_name]
        try:
            now = datetime.now(ZoneInfo(self.timezone))
        except (ZoneInfoNotFoundError, ValueError):
            now = datetime.now(UTC)
        # Names first: they are what the transcriber gets wrong without help.
        words = list(self._roster)
        for name, unit in things:
            words.extend(word for word in (name, unit) if word)
        return await self._model.open(
            instruction=instruction.build(
                name=self._name,
                role=self._role,
                timezone=self.timezone,
                now=now,
                state=state,
                memories=memories,
            ),
            tools=self._tools(),
            vocabulary=list(dict.fromkeys(words))[:VOCABULARY_LIMIT],
        )

    async def _state_card(self, db: AsyncSession) -> instruction.StateCard:
        """What the server holds about this conversation, for a model session to be told."""
        done = await db.scalars(
            select(AgentAction)
            .where(
                AgentAction.conversation_id == self.conversation_id,
                AgentAction.status == AgentActionStatus.COMMITTED.value,
            )
            .order_by(AgentAction.resolved_at)
        )
        waiting = await proposals.open_proposal(db, self.conversation_id)
        lines = await db.scalars(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == self.conversation_id)
            .order_by(AgentMessage.seq.desc())
            .limit(instruction.RECENT_LINES)
        )
        return instruction.StateCard(
            committed=[
                instruction.CommittedAction(
                    kind=action.kind, summary=proposals.done_summary(action)
                )
                for action in done
            ],
            open_proposal=(
                (str(waiting.id), waiting.summary, waiting.approval_policy) if waiting else None
            ),
            transcript=[(line.role, line.text) for line in reversed(list(lines))],
        )

    async def _downstream(self) -> Ending:
        """Relay what the model does, replacing the model session when it dies."""
        restarts = 0
        while True:
            session = self._session
            if session is None or not self._model_wanted:
                # Closed on purpose. Nothing more comes from the model; the socket
                # stays for the clicks.
                await asyncio.Event().wait()
            assert session is not None
            try:
                async for event in session.events():
                    await self._on_event(event)
                problem = "the model session closed"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                problem = f"{type(exc).__name__}: {exc}"[:300]
            if not self._model_wanted:
                continue

            restarts += 1
            self._log.warning(
                "agent_live_error",
                model=self._settings.agent_model,
                problem=problem,
                restart=restarts,
            )
            await self._close_quietly(session)
            if restarts > MAX_MODEL_RESTARTS:
                await self._send(
                    "error",
                    code="integration_unavailable",
                    message="The assistant lost its connection and could not get it back.",
                )
                return Ending.ended(AgentEndReason.ERROR)
            self._reset_turn()
            await self._send("interrupted")
            self._session = await self._open_model()
            await self._send("notice", kind="model_reconnected")

    async def _close_quietly(self, session: ModelSession) -> None:
        try:
            await session.close()
        except Exception:
            self._log.debug("agent_model_close_failed", exc_info=True)

    def _reset_turn(self) -> None:
        self._said_whole = []
        self._said_so_far = ""
        self._turn_spoke = False
        self._agent_active = False

    def _said_this_turn(self) -> str:
        return " ".join(self._said_whole) if self._said_whole else self._said_so_far

    async def _on_event(self, event: ModelEvent) -> None:
        if event.audio:
            self._turn_spoke = True
            self._agent_active = True
            self._voice_bytes += len(event.audio)
            await self._send_bytes(event.audio)

        # Before the transcript: what the user said is judged by when it began.
        if event.speech_began_at is not None:
            self._last_utterance_began = event.speech_began_at

        if event.heard:
            self._user_did_something()
            if event.heard_final:
                self._last_heard = event.heard
                self._heard_after_readback(event.heard)
                await self._record(AgentMessageRole.USER, AgentMessageSource.VOICE, event.heard)
            await self._send("transcript", role="user", text=event.heard, final=event.heard_final)

        if event.said:
            self._agent_active = True
            if event.said_final:
                self._said_whole.append(event.said)
                self._said_so_far = ""
                await self._record(AgentMessageRole.ASSISTANT, AgentMessageSource.VOICE, event.said)
            else:
                self._said_so_far += event.said
            await self._send(
                "transcript", role="assistant", text=event.said, final=event.said_final
            )

        if event.interrupted:
            # The read-back, if this was one, did not finish. Nothing marks it as spoken,
            # so the browser is never asked to report it played and no spoken yes counts.
            self._reset_turn()
            await self._send("interrupted")
            await self._report_missed_outcome()

        if event.turn_complete:
            await self._on_turn_complete()

    async def _on_turn_complete(self) -> None:
        spoke, said = self._turn_spoke, self._said_this_turn()
        if spoke and said and not self._said_whole:
            await self._record(AgentMessageRole.ASSISTANT, AgentMessageSource.VOICE, said)

        readback_for: str | None = None
        waiting = self._open
        # A tool call ends a turn of its own with no audio in it. Only a turn that
        # spoke, and that was about the proposal, is its read-back.
        if (
            spoke
            and waiting is not None
            and not waiting.readback_spoken
            and agent_readback.is_an_attempt(waiting.terms, said)
        ):
            waiting.readback_spoken = True
            readback_for = str(waiting.id)
            await self._judge_the_readback(waiting, said)
        if spoke:
            # The model has spoken since the last commit, so it has reported it.
            self._unreported = None

        await self._send("turn_complete", spoke=spoke, readback_for=readback_for)
        self._reset_turn()
        if spoke and self._goodbye_due is not None:
            self._end(Ending.ended(AgentEndReason.USER_CLOSED))

    async def _judge_the_readback(self, waiting: _OpenProposal, said: str) -> None:
        """Decide, from what was actually said, whether a spoken yes may approve this.

        Everything that had to be heard was: verified. Anything missing: from now on
        only the button approves it, and the model is told to ask for a click. The card
        on screen is complete either way.
        """
        gaps = agent_readback.missing(waiting.terms, said)
        if not gaps:
            waiting.verified = True
            async with self._factory() as db:
                await proposals.mark_verified(db, waiting.id)
                await db.commit()
            return

        # What kind of thing was missing, never the thing itself.
        self._log.info("agent_readback_unverified", kind=waiting.kind, missing=gaps)
        if waiting.policy is not AgentApprovalPolicy.VOICE_OR_CLICK:
            return
        waiting.policy = AgentApprovalPolicy.CLICK
        async with self._factory() as db:
            await proposals.downgrade_to_click(db, waiting.id)
            await db.commit()
            action = await db.get(AgentAction, waiting.id)
            card = proposals.describe(action) if action is not None else None
        if card is not None:
            await self._send("proposal", **card)
        self._notify_model(
            "Part of that summary was not spoken, so this proposal can no longer be "
            "approved by voice. Tell the user to check the card on screen and press "
            "Approve when they are ready. Do not call commit_proposal."
        )

    async def _report_missed_outcome(self) -> None:
        """Tell the model what became of a commit it was interrupted before reporting."""
        if self._unreported is None or self._session is None:
            return
        outcome, self._unreported = self._unreported, None
        self._session.send_text(
            f"{NOTICE}While the user was speaking, the commit finished. {outcome} "
            "Tell the user this first, then deal with what they said."
        )

    # ── The browser ───────────────────────────────────────────────────────────

    async def _upstream(self) -> Ending:
        while True:
            message = await self._socket.receive()
            if message.get("type") == "websocket.disconnect":
                return Ending("dropped")

            audio = message.get("bytes")
            if audio:
                # Counted only when forwarded: the model reports where speech began as
                # an offset into the audio it was given, and nothing else.
                if self._session is not None and not self._paused:
                    self._mic_bytes += len(audio)
                    self._session.send_audio(audio)
                continue

            try:
                frame = json.loads(message.get("text") or "{}")
            except ValueError:
                continue
            kind = frame.get("type")
            if kind == "end":
                return Ending.ended(AgentEndReason.USER_CLOSED)
            handler = getattr(self, f"_on_{kind}", None) if isinstance(kind, str) else None
            if handler is not None and kind in _BROWSER_FRAMES:
                await handler(frame)

    def _mic_seconds(self) -> float:
        return self._mic_bytes / MIC_BYTES_PER_SECOND

    async def _on_text(self, frame: dict[str, Any]) -> None:
        text = str(frame.get("text") or "").strip()
        if not text or self._session is None:
            return
        await self._record(AgentMessageRole.USER, AgentMessageSource.TEXT, text)
        self._last_heard = text
        self._user_did_something()
        if self._open is not None and self._open.played_at is not None:
            self._open.typed_after = True
            self._open.said_after.append(text)
        await self._unpause()
        self._session.send_text(text)

    async def _on_context(self, frame: dict[str, Any]) -> None:
        self.context = {
            key: frame.get(key)
            for key in (
                "route",
                "entity",
                "selection",
                "editor_save_state",
                "dialog_open",
                "layout",
            )
        }

    @property
    def on_phone(self) -> bool:
        """Whether the browser last said it is laid out for a phone.

        Taken from the latest context, so turning a tablet or resizing a window between
        the proposal and the answer applies the rule for the screen the user is on.
        """
        return self.context.get("layout") == "phone"

    def _heard_after_readback(self, text: str) -> None:
        """Keep what the user said, if it began after the read-back finished playing.

        An utterance that began earlier may hold the read-back itself, heard back
        through the microphone, and must never stand in for the user's own words.
        """
        waiting = self._open
        began = self._last_utterance_began
        if (
            waiting is not None
            and waiting.played_at is not None
            and began is not None
            and began > waiting.played_at
        ):
            waiting.said_after.append(text)

    async def _on_readback_played(self, frame: dict[str, Any]) -> None:
        """The browser reports that the read-back finished playing, or was shown in full.

        Arrives on the same socket as the microphone audio, so "how much audio had
        arrived by then" is an exact position in that stream and no clocks are compared.
        Ignored unless the agent really did finish a turn that read the summary back: a
        tool call ends a turn of its own with no audio in it, and that one is not it.

        This is also when the answer window opens: the microphone stays live for a
        short while for a spoken yes or a correction, and then pauses.
        """
        waiting = self._open
        if waiting is None or str(waiting.id) != frame.get("proposal_id"):
            return
        if not waiting.readback_spoken or waiting.played_at is not None:
            return
        waiting.played_at = self._mic_seconds()
        self._window_closes = self._clock() + self._settings.agent_approval_voice_window_seconds
        async with self._factory() as db:
            await db.execute(
                update(AgentAction)
                .where(AgentAction.id == waiting.id)
                .values(readback_played_at=datetime.now(UTC))
            )
            await db.commit()

    async def _on_resume(self, frame: dict[str, Any]) -> None:
        """Tap to talk: the user wants the microphone back."""
        self._user_did_something()
        await self._unpause()

    async def _unpause(self) -> None:
        if not self._paused or self._spent:
            return
        self._paused = False
        if self._open is not None and self._open.played_at is not None:
            self._window_closes = self._clock() + self._settings.agent_approval_voice_window_seconds
        await self._send("audio", state="live")

    async def _on_ui_ack(self, frame: dict[str, Any]) -> None:
        waiter = self._acks.pop(str(frame.get("directive_id")), None)
        if waiter is not None and not waiter.done():
            waiter.set_result(frame)

    async def _on_approval(self, frame: dict[str, Any]) -> None:
        """Approve or Reject was clicked. A browser message, not something the model did."""
        waiting = self._open
        if waiting is None or str(waiting.id) != frame.get("proposal_id"):
            return
        self._user_did_something()
        if frame.get("decision") == "approve":
            outcome = await self._commit(waiting, via=AgentApprovedVia.CLICK, utterance=None)
            self._notify_model(
                f"The user pressed Approve. {_outcome_for_model(outcome)} Tell the user briefly."
            )
            return

        async with self._factory() as db:
            closed = await proposals.resolve(db, waiting.id, AgentActionStatus.CANCELLED)
            await db.commit()
        if not closed:
            return
        self._open = None
        await self._send("proposal_result", id=str(waiting.id), status="cancelled")
        await self._leave_work_mode()
        self._notify_model(
            "The user pressed Reject. Nothing was saved. Ask what they would like instead."
        )
        await self._resolved()

    async def _on_stop(self, frame: dict[str, Any]) -> None:
        """Stop: the lock lifts at once, and a staged form becomes the user's to finish."""
        waiting = self._open
        self._user_did_something()
        if waiting is not None:
            async with self._factory() as db:
                closed = await proposals.resolve(db, waiting.id, AgentActionStatus.HANDED_OVER)
                await db.commit()
            if closed:
                self._open = None
                await self._send("proposal_result", id=str(waiting.id), status="handed_over")
                self._notify_model(
                    "The user pressed Stop and has taken that over by hand. You did not "
                    "save it. Do not propose it again unless they ask."
                )
        await self._send("mode", mode="conversing")
        if waiting is not None:
            await self._resolved()

    def _notify_model(self, text: str) -> None:
        if self._session is not None:
            self._session.send_text(NOTICE + text)

    # ── What the tools ask of the conversation ────────────────────────────────

    def _tools(self) -> list[Tool]:
        """What the model may call. There is no tool here that deletes anything."""
        return tools.build(self)

    def database(self) -> AbstractAsyncContextManager[AsyncSession]:
        return self._factory()

    def roster_names(self) -> list[str]:
        return list(self._roster)

    async def actor(self, db: AsyncSession) -> Profile | None:
        """The user as they are now. Re-read on every tool call, so a removal takes effect."""
        actor: Profile | None = await db.get(Profile, self.user_id, populate_existing=True)
        if actor is None or actor.is_banned:
            self._log.info("agent_tool_refused", rule="actor_removed", user=str(self.user_id))
            return None
        return actor

    async def propose(
        self, tool: str, build: Build, *, step: str, supplement_id: str | None = None
    ) -> dict[str, Any]:
        """Stage one change on the user's screen and wait, briefly, for it to be shown.

        ``build`` does the work that differs between kinds of change: it validates, runs
        the permission and state rules as a dry run, and stores the proposal. Everything
        around it is the same for all of them.
        """
        if self.context.get("dialog_open"):
            self._log.info("agent_tool_refused", tool=tool, rule="dialog_open")
            return refuse(
                "The user has a dialog open in the app, and I cannot change the screen "
                "underneath it. Ask them to finish or close it first."
            )
        if supplement_id is not None:
            # The editor saves on its own. A proposal made against a supplement with a
            # save still on its way, or one that failed, would be checked against a
            # document that is about to change.
            ready = await self._directive("prepare", supplement_id=supplement_id)
            if not ready.get("ok"):
                self._log.info("agent_tool_refused", tool=tool, rule="editor_unsaved")
                return refuse(
                    str(ready.get("reason") or "")
                    or "That supplement has changes in the editor that have not been saved. "
                    "Ask the user to let it finish saving, or to fix the save, and try again."
                )

        async with self._factory() as db:
            actor = await self.actor(db)
            conversation = await db.get(AgentConversation, self.conversation_id)
            if actor is None or conversation is None:
                return refuse(tools.REMOVED)
            try:
                action = await build(db, actor, conversation)
            except ProposalRefused as refusal:
                await db.rollback()
                self._log.info("agent_tool_refused", tool=tool, rule="refused")
                return refuse(str(refusal))
            proposal = proposals.describe(action)
            waiting = _OpenProposal.of(action)
            await db.commit()

        replaced, self._open = self._open, waiting
        self._window_closes = None
        if replaced is not None:
            await self._send("proposal_result", id=str(replaced.id), status="superseded")
        await self._unpause()

        await self._send("mode", mode="working")
        await self._send("step", id="stage", label=step, status="active")
        staged = await self._directive("stage", proposal=proposal)
        if not staged.get("ok"):
            async with self._factory() as db:
                await proposals.resolve(db, waiting.id, AgentActionStatus.CANCELLED)
                await db.commit()
            if self._open is waiting:
                self._open = None
            await self._send("proposal_result", id=proposal["id"], status="cancelled")
            await self._leave_work_mode()
            return refuse(
                str(staged.get("reason") or "")
                or "The app could not show that on screen, so nothing was staged. Ask the "
                "user to try again."
            )

        await self._send("step", id="stage", label=step, status="done")
        await self._send("step", id="approval", label="Waiting for your approval", status="active")
        await self._send("proposal", **proposal)

        if waiting.policy is AgentApprovalPolicy.CLICK:
            how = (
                "This one needs a click. Speak the summary in full, then say 'press "
                "Approve when you are ready'. Do not call commit_proposal."
            )
        elif self.on_phone and waiting.confirm_line:
            how = (
                "The user is on a phone, where a yes does not approve. Speak the summary in "
                "full, then ask them to confirm by saying back this line: "
                f'"{waiting.confirm_line}". Call commit_proposal only after they have said '
                "it, after the whole summary. They can also press Approve."
            )
        else:
            how = (
                "Speak the summary in full, then ask the user to approve. Call "
                "commit_proposal only after a clear yes that follows the whole summary."
            )
        return {
            "ok": True,
            "proposal_id": proposal["id"],
            "summary": proposal["summary"],
            "approval": proposal["approval"],
            "what_to_do": how,
        }

    async def voice_commit(self, proposal_id: str) -> dict[str, Any]:
        waiting = self._open
        matches = waiting is not None and str(waiting.id) == proposal_id
        facts = VoiceCommitFacts(
            in_this_conversation=matches,
            status=AgentActionStatus.PROPOSED,
            expired=bool(waiting and waiting.expires_at <= datetime.now(UTC)),
            policy=waiting.policy if waiting else AgentApprovalPolicy.CLICK,
            readback_played_at=waiting.played_at if waiting else None,
            last_utterance_began_at=self._last_utterance_began,
            typed_after_readback=bool(waiting and waiting.typed_after),
            readback_verified=bool(waiting and (waiting.verified or not waiting.readback_spoken)),
            phone=self.on_phone,
            confirm_terms=waiting.confirm_terms if waiting else [],
            said_since_readback=" ".join(waiting.said_after) if waiting else "",
        )
        refusal = agent_rules.refuse_voice_commit(facts)
        if refusal is not None or waiting is None:
            reason = refusal or "unknown"
            self._log.info("agent_voice_commit_rejected", condition=reason)
            message = agent_rules.REFUSALS[reason]
            if reason == "confirmation_missing" and waiting is not None:
                message += f' The line is: "{waiting.confirm_line}".'
            return refuse(message)

        outcome = await self._commit(
            waiting, via=AgentApprovedVia.VOICE, utterance=self._last_heard or None
        )
        text = _outcome_for_model(outcome)
        self._unreported = text
        return {"ok": outcome.committed, "status": outcome.status, "tell_the_user": text}

    async def cancel_open(self, proposal_id: str) -> dict[str, Any]:
        waiting = self._open
        if waiting is None or str(waiting.id) != proposal_id:
            return refuse(agent_rules.REFUSALS["not_open"])
        async with self._factory() as db:
            closed = await proposals.resolve(db, waiting.id, AgentActionStatus.CANCELLED)
            await db.commit()
        if closed:
            self._open = None
            await self._send("proposal_result", id=proposal_id, status="cancelled")
            await self._leave_work_mode()
            await self._resolved()
        return {"ok": True, "status": "cancelled", "tell_the_user": "Nothing was saved."}

    async def show(self, route: str) -> dict[str, Any]:
        """Open a page for the user to look at. Showing is not working: nothing locks."""
        if self.context.get("dialog_open"):
            self._log.info("agent_tool_refused", tool="show_in_app", rule="dialog_open")
            return refuse(
                "The user has a dialog open in the app. Ask them to finish or close it "
                "before I open another page."
            )
        if self._open is not None:
            return refuse(
                "A change is staged on the screen and waiting for an answer. It has to "
                "be approved or dropped before I can open another page."
            )
        shown = await self._directive("navigate", to=route)
        if not shown.get("ok"):
            return refuse(str(shown.get("reason") or "") or "The app could not open that page.")
        return {"ok": True, "tell_the_user": "Say briefly that it is open."}

    async def announce_memory(self, memory: AgentMemory) -> None:
        await self._send(
            "memory",
            event="remembered",
            memory={"id": str(memory.id), "category": memory.category, "content": memory.content},
        )

    def end_after_reply(self) -> None:
        """End once the model has said goodbye, or shortly after if it says nothing."""
        self._goodbye_due = self._clock() + GOODBYE_SECONDS

    async def _commit(
        self, waiting: _OpenProposal, *, via: AgentApprovedVia, utterance: str | None
    ) -> proposals.CommitOutcome:
        """Commit, in a task of its own, and report to the browser whatever happens.

        Shielded: if the user speaks while this runs, the model's tool call is cancelled,
        and a commit that stopped half-way because of that would be the worst outcome
        there is. It finishes regardless and the browser is told directly. The same
        holds if the connection drops while it runs.
        """
        task = asyncio.create_task(self._commit_and_report(waiting, via, utterance))
        return await asyncio.shield(task)

    async def _commit_and_report(
        self, waiting: _OpenProposal, via: AgentApprovedVia, utterance: str | None
    ) -> proposals.CommitOutcome:
        outcome = await proposals.commit(
            self._factory, waiting.id, actor_id=self.user_id, via=via, utterance=utterance
        )
        if outcome.status == "already_resolved":
            return outcome
        if self._open is waiting:
            self._open = None

        if outcome.committed:
            await self._send(
                "proposal_result", id=str(waiting.id), status="committed", target=outcome.result
            )
            await self._send("step", id="approval", label="Saved", status="done")
            await self._send(
                "ui",
                directive_id=uuid.uuid4().hex,
                action="refresh",
                keys=proposals.REFRESH.get(outcome.kind, []),
                target=outcome.result,
            )
        else:
            await self._send(
                "proposal_result", id=str(waiting.id), status="failed", error=outcome.error
            )
        await self._leave_work_mode()
        await self._resolved()
        return outcome

    async def _leave_work_mode(self) -> None:
        await self._send("ui", directive_id=uuid.uuid4().hex, action="unstage")
        await self._send("mode", mode="conversing")

    # ── Sending ───────────────────────────────────────────────────────────────

    async def _directive(self, action: str, **fields: Any) -> dict[str, Any]:
        """Ask the browser to do something on screen, and wait briefly for its answer."""
        directive_id = uuid.uuid4().hex
        waiter: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._acks[directive_id] = waiter
        await self._send("ui", directive_id=directive_id, action=action, **fields)
        try:
            return await asyncio.wait_for(waiter, DIRECTIVE_TIMEOUT_SECONDS)
        except TimeoutError:
            self._acks.pop(directive_id, None)
            return {"ok": False, "reason": ""}

    async def _send(self, frame: str, /, **fields: Any) -> None:
        payload = json.dumps({"type": frame, **fields}, default=str)
        async with self._send_lock:
            try:
                await self._socket.send_text(payload)
            except Exception:
                # The socket has gone. The receive loop finds out and ends the
                # conversation; a commit in flight still has to finish regardless.
                self._log.debug("agent_send_failed", frame=frame)

    async def _send_bytes(self, data: bytes) -> None:
        async with self._send_lock:
            try:
                await self._socket.send_bytes(data)
            except Exception:
                self._log.debug("agent_send_failed", frame="audio")

    async def _record(self, role: AgentMessageRole, source: AgentMessageSource, text: str) -> None:
        """Write one finished utterance to the transcript. Never fatal to the conversation."""
        try:
            async with self._factory() as db:
                await agent_service.append_message(
                    db, self.conversation_id, role=role, source=source, text=text
                )
                await db.commit()
        except Exception:
            self._log.exception("agent_transcript_write_failed")


#: The frames a browser may send that are handled by a method named ``_on_<type>``.
_BROWSER_FRAMES = frozenset(
    {"text", "context", "readback_played", "resume", "approval", "stop", "ui_ack"}
)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _value(reason: AgentEndReason | None) -> str:
    return (reason or AgentEndReason.ERROR).value


def _outcome_for_model(outcome: proposals.CommitOutcome) -> str:
    if outcome.committed:
        return "It was committed: it is saved."
    if outcome.status == "already_resolved":
        if outcome.resolved_as == AgentActionStatus.COMMITTED.value:
            return "It had already been approved and is saved. Nothing was saved twice."
        return f"It was no longer open ({outcome.resolved_as}), so nothing was saved."
    return f"It was not saved. {outcome.error or ''}".strip()
