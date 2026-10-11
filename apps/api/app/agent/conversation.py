"""One conversation, over one socket.

Audio goes up to the model and comes back down, with captions both ways. Around that
sits everything the model is not trusted with: which tools exist, whether a spoken "yes"
counts, the commit itself, and what the model is told about a commit it did not see
finish.

Three things here came out of testing against the real model and are not optional.

**A commit the user talks over still completes, and the model is told it was cancelled.**
Left alone, the model then says "I have stopped the process" about something that was
saved. So a commit runs in its own task, its outcome goes to the browser directly, and
if the model was interrupted before it could report the outcome, the outcome is sent
into the conversation as a notice of its own.

**The model commits on a "yes" that interrupts the read-back**, whatever its
instructions say. The guard in ``agent_rules.refuse_voice_commit`` is what stops that,
on two facts the model does not control: where the microphone stream stood when the
read-back finished playing, and where the user's answer began.

**A model session is shorter-lived than a conversation.** It is replaced about every ten
minutes, a replacement can fail, and its memory of early turns is not dependable. When a
session ends for any reason other than the conversation ending, another is started,
seeded with what the server holds: what has been committed, what is open, and the recent
transcript.

Nothing here holds a database session open. See the package docstring.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import MutableMapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select, update

from app.agent import instruction, proposals
from app.agent.model import LiveModel, ModelEvent, ModelSession, Tool, blocking
from app.agent.proposals import ProposalRefused, SessionFactory
from app.config import get_settings
from app.logging import get_logger
from app.models.agent import AgentAction, AgentConversation, AgentMessage
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
from app.services import agent_service
from app.services.rules import agent_rules
from app.services.rules.agent_rules import VoiceCommitFacts

log = get_logger(__name__)

#: 16 kHz, 16-bit, mono.
MIC_BYTES_PER_SECOND = 32_000
#: How long a tool waits for the browser to say it has staged a proposal. A tool must
#: return quickly: the model's events are not delivered while one is running, the
#: user's interruption included.
DIRECTIVE_TIMEOUT_SECONDS = 5.0
#: How many times a dead model session is replaced before the conversation gives up.
MAX_MODEL_RESTARTS = 3

NOTICE = "[System notice, not from the user] "


class Socket(Protocol):
    """The part of a WebSocket a conversation uses. Starlette's fits; so does a fake."""

    async def receive(self) -> MutableMapping[str, Any]: ...
    async def send_text(self, data: str) -> None: ...
    async def send_bytes(self, data: bytes) -> None: ...


@dataclass(slots=True)
class _OpenProposal:
    """The one proposal waiting for an answer, and what is known about its read-back."""

    id: uuid.UUID
    kind: str
    title: str
    policy: AgentApprovalPolicy
    expires_at: datetime
    #: The agent finished a turn in which it spoke the summary.
    readback_spoken: bool = False
    #: Where the microphone stream stood when the browser reported that turn played.
    played_at: float | None = None
    typed_after: bool = False


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


class LiveConversation:
    def __init__(
        self,
        *,
        socket: Socket,
        model: LiveModel,
        factory: SessionFactory,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> None:
        self._socket = socket
        self._model = model
        self._factory = factory
        self.conversation_id = conversation_id
        self.user_id = user_id
        self._settings = get_settings()

        self._session: ModelSession | None = None
        self._send_lock = asyncio.Lock()
        self._acks: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._context: dict[str, Any] = {}
        self._timezone = "UTC"
        self._name = ""
        self._role = ""

        self._mic_bytes = 0
        self._open: _OpenProposal | None = None
        self._last_utterance_began: float | None = None
        self._last_heard = ""
        self._said = ""
        self._said_recorded = False
        self._turn_spoke = False
        #: The outcome of a commit the model has not yet told the user about.
        self._unreported: str | None = None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def run(self) -> AgentEndReason:
        """Carry the conversation until it ends, and say why it ended."""
        async with self._factory() as db:
            conversation = await db.get(AgentConversation, self.conversation_id)
            actor = await db.get(Profile, self.user_id)
            if conversation is None or actor is None:
                return AgentEndReason.ERROR
            self._timezone = conversation.client_timezone
            self._name = actor.display_name
            self._role = actor.role

        limit = self._settings.agent_max_session_seconds
        await self._send(
            "ready",
            conversation_id=str(self.conversation_id),
            limits={"max_session_seconds": limit},
        )

        self._session = await self._open_model()
        upstream = asyncio.create_task(self._upstream())
        downstream = asyncio.create_task(self._downstream())
        reason = AgentEndReason.ERROR
        try:
            done, _ = await asyncio.wait(
                {upstream, downstream}, timeout=limit, return_when=asyncio.FIRST_COMPLETED
            )
            if not done:
                reason = AgentEndReason.TIME_LIMIT
            else:
                finished = next(iter(done))
                if finished.exception() is None:
                    reason = finished.result()
                else:
                    log.error("agent_conversation_crashed", exc_info=finished.exception())
        finally:
            for task in (upstream, downstream):
                task.cancel()
            await asyncio.gather(upstream, downstream, return_exceptions=True)
            if self._session is not None:
                await self._close_quietly(self._session)
            await self._discard_open_proposal()
        await self._send("ended", reason=reason.value)
        return reason

    async def _discard_open_proposal(self) -> None:
        """A proposal still open when the conversation ends is dropped, never committed."""
        if self._open is None:
            return
        async with self._factory() as db:
            await proposals.resolve(db, self._open.id, AgentActionStatus.CANCELLED)
            await db.commit()
        self._open = None

    # ── The model session ─────────────────────────────────────────────────────

    async def _open_model(self) -> ModelSession:
        async with self._factory() as db:
            state = await self._state_card(db)
            roster = list(
                await db.scalars(select(Profile).where(Profile.status != UserStatus.BANNED.value))
            )
        try:
            now = datetime.now(ZoneInfo(self._timezone))
        except (ZoneInfoNotFoundError, ValueError):
            now = datetime.now(UTC)
        return await self._model.open(
            instruction=instruction.build(
                name=self._name, role=self._role, timezone=self._timezone, now=now, state=state
            ),
            tools=self._tools(),
            vocabulary=[person.display_name for person in roster if person.display_name],
        )

    async def _state_card(self, db: Any) -> instruction.StateCard:
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
                instruction.CommittedAction(kind=action.kind, summary=_as_done(action.summary))
                for action in done
            ],
            open_proposal=(
                (str(waiting.id), waiting.summary, waiting.approval_policy) if waiting else None
            ),
            transcript=[(line.role, line.text) for line in reversed(list(lines))],
        )

    async def _downstream(self) -> AgentEndReason:
        """Relay what the model does, replacing the model session when it dies."""
        restarts = 0
        while True:
            assert self._session is not None
            try:
                async for event in self._session.events():
                    await self._on_event(event)
                problem = "the model session closed"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                problem = f"{type(exc).__name__}: {exc}"[:300]

            restarts += 1
            log.warning(
                "agent_live_error",
                conversation_id=str(self.conversation_id),
                model=self._settings.agent_model,
                problem=problem,
                restart=restarts,
            )
            await self._close_quietly(self._session)
            if restarts > MAX_MODEL_RESTARTS:
                await self._send(
                    "error",
                    code="integration_unavailable",
                    message="The assistant lost its connection and could not get it back.",
                )
                return AgentEndReason.ERROR
            self._reset_turn()
            await self._send("interrupted")
            self._session = await self._open_model()
            await self._send("notice", kind="model_reconnected")

    async def _close_quietly(self, session: ModelSession) -> None:
        try:
            await session.close()
        except Exception:
            log.debug("agent_model_close_failed", exc_info=True)

    def _reset_turn(self) -> None:
        self._said = ""
        self._said_recorded = False
        self._turn_spoke = False

    async def _on_event(self, event: ModelEvent) -> None:
        if event.audio:
            self._turn_spoke = True
            await self._send_bytes(event.audio)

        if event.heard:
            if event.heard_final:
                self._last_heard = event.heard
                await self._record(AgentMessageRole.USER, AgentMessageSource.VOICE, event.heard)
            await self._send("transcript", role="user", text=event.heard, final=event.heard_final)

        if event.said:
            if event.said_final:
                self._said = event.said
                self._said_recorded = True
                await self._record(AgentMessageRole.ASSISTANT, AgentMessageSource.VOICE, event.said)
            else:
                self._said += event.said
            await self._send(
                "transcript", role="assistant", text=event.said, final=event.said_final
            )

        if event.speech_began_at is not None:
            self._last_utterance_began = event.speech_began_at

        if event.interrupted:
            # The read-back, if this was one, did not finish. Nothing marks it as spoken,
            # so the browser is never asked to report it played and no spoken yes counts.
            self._reset_turn()
            await self._send("interrupted")
            await self._report_missed_outcome()

        if event.turn_complete:
            await self._on_turn_complete()

    async def _on_turn_complete(self) -> None:
        spoke, said = self._turn_spoke, self._said
        if spoke and said and not self._said_recorded:
            await self._record(AgentMessageRole.ASSISTANT, AgentMessageSource.VOICE, said)

        readback_for: str | None = None
        waiting = self._open
        # A tool call ends a turn of its own with no audio in it. Only a turn that spoke,
        # and that spoke the summary, is the read-back.
        if (
            spoke
            and waiting
            and not waiting.readback_spoken
            and _squash(waiting.title) in _squash(said)
        ):
            waiting.readback_spoken = True
            readback_for = str(waiting.id)
        if spoke:
            # The model has spoken since the last commit, so it has reported it.
            self._unreported = None

        await self._send("turn_complete", spoke=spoke, readback_for=readback_for)
        self._reset_turn()

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

    async def _upstream(self) -> AgentEndReason:
        while True:
            message = await self._socket.receive()
            if message.get("type") == "websocket.disconnect":
                return AgentEndReason.DISCONNECTED

            audio = message.get("bytes")
            if audio:
                self._mic_bytes += len(audio)
                if self._session is not None:
                    self._session.send_audio(audio)
                continue

            try:
                frame = json.loads(message.get("text") or "{}")
            except ValueError:
                continue
            kind = frame.get("type")
            if kind == "end":
                return AgentEndReason.USER_CLOSED
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
        if self._open is not None and self._open.played_at is not None:
            self._open.typed_after = True
        self._session.send_text(text)

    async def _on_context(self, frame: dict[str, Any]) -> None:
        self._context = {
            key: frame.get(key)
            for key in ("route", "entity", "selection", "editor_save_state", "dialog_open")
        }

    async def _on_readback_played(self, frame: dict[str, Any]) -> None:
        """The browser reports that the read-back finished playing, or was shown in full.

        Arrives on the same socket as the microphone audio, so "how much audio had
        arrived by then" is an exact position in that stream and no clocks are compared.
        Ignored unless the agent really did finish speaking the summary.
        """
        waiting = self._open
        if waiting is None or str(waiting.id) != frame.get("proposal_id"):
            return
        if not waiting.readback_spoken or waiting.played_at is not None:
            return
        waiting.played_at = self._mic_seconds()
        async with self._factory() as db:
            await db.execute(
                update(AgentAction)
                .where(AgentAction.id == waiting.id)
                .values(readback_played_at=datetime.now(UTC))
            )
            await db.commit()

    async def _on_ui_ack(self, frame: dict[str, Any]) -> None:
        waiter = self._acks.pop(str(frame.get("directive_id")), None)
        if waiter is not None and not waiter.done():
            waiter.set_result(frame)

    async def _on_approval(self, frame: dict[str, Any]) -> None:
        """Approve or Reject was clicked. A browser message, not something the model did."""
        waiting = self._open
        if waiting is None or str(waiting.id) != frame.get("proposal_id"):
            return
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

    async def _on_stop(self, frame: dict[str, Any]) -> None:
        """Stop: the lock lifts at once, and a staged form becomes the user's to finish."""
        waiting = self._open
        if waiting is not None:
            async with self._factory() as db:
                closed = await proposals.resolve(db, waiting.id, AgentActionStatus.HANDED_OVER)
                await db.commit()
            if closed:
                self._open = None
                await self._send("proposal_result", id=str(waiting.id), status="handed_over")
                self._notify_model(
                    "The user pressed Stop and is finishing that form by hand. You did not "
                    "save it. Do not propose it again unless they ask."
                )
        await self._send("mode", mode="conversing")

    def _notify_model(self, text: str) -> None:
        if self._session is not None:
            self._session.send_text(NOTICE + text)

    # ── Tools ─────────────────────────────────────────────────────────────────

    def _tools(self) -> list[Tool]:
        """What the model may call. There is no tool here that deletes anything."""

        async def list_team_members() -> dict[str, Any]:
            """List the people on the team who can be invited to a meeting.

            Returns each person's name, email and id. Pass the id to
            propose_create_meeting. If a name the user said matches more than one person,
            or none, ask the user who they meant.
            """
            async with self._factory() as db:
                if (await self._actor(db)) is None:
                    return _refuse("Your account can no longer use the assistant.")
                people = await db.scalars(
                    select(Profile)
                    .where(Profile.status != UserStatus.BANNED.value)
                    .order_by(Profile.full_name)
                )
                return {
                    "members": [
                        {"id": str(p.id), "name": p.display_name, "email": p.email} for p in people
                    ]
                }

        async def get_current_view() -> dict[str, Any]:
            """Say which page of the app the user is looking at, and which record is open.

            Use it to resolve "this one" or "that meeting". If no record is open, ask.
            """
            return {"view": self._context or {"route": None}}

        @blocking
        async def propose_create_meeting(
            title: str,
            date: str,
            start_time: str,
            duration_minutes: int,
            attendee_ids: list[str],
            guest_emails: list[str],
            location: str,
            description: str,
        ) -> dict[str, Any]:
            """Stage a new meeting on the user's screen for their approval. Saves nothing.

            Args:
                title: The meeting's title.
                date: The date as YYYY-MM-DD, in the user's time zone.
                start_time: The start on a 24-hour clock as HH:MM, in the user's time zone.
                duration_minutes: How long it lasts. Ask if the user did not say.
                attendee_ids: Team members to invite, as ids from list_team_members.
                    An empty list if none.
                guest_emails: People outside the team to invite, by email address. An
                    empty list if none. Spell each address back to the user first.
                location: Where it is, or an empty string.
                description: Anything else to record, or an empty string.
            """
            return await self._propose_create_meeting(
                title=title,
                date=date,
                start_time=start_time,
                duration_minutes=duration_minutes,
                attendee_ids=attendee_ids,
                guest_emails=guest_emails,
                location=location,
                description=description,
            )

        @blocking
        async def commit_proposal(proposal_id: str) -> dict[str, Any]:
            """Save a staged proposal. Only after the user heard the whole summary and said yes.

            Args:
                proposal_id: The id the propose tool returned.
            """
            return await self._voice_commit(proposal_id)

        @blocking
        async def cancel_proposal(proposal_id: str) -> dict[str, Any]:
            """Drop a staged proposal because the user said no. Nothing is saved.

            Args:
                proposal_id: The id the propose tool returned.
            """
            waiting = self._open
            if waiting is None or str(waiting.id) != proposal_id:
                return _refuse(agent_rules.REFUSALS["not_open"])
            async with self._factory() as db:
                closed = await proposals.resolve(db, waiting.id, AgentActionStatus.CANCELLED)
                await db.commit()
            if closed:
                self._open = None
                await self._send("proposal_result", id=proposal_id, status="cancelled")
                await self._leave_work_mode()
            return {"ok": True, "status": "cancelled", "tell_the_user": "Nothing was saved."}

        return [
            list_team_members,
            get_current_view,
            propose_create_meeting,
            commit_proposal,
            cancel_proposal,
        ]

    async def _actor(self, db: Any) -> Profile | None:
        """The user as they are now. Re-read on every tool call, so a removal takes effect."""
        actor: Profile | None = await db.get(Profile, self.user_id, populate_existing=True)
        if actor is None or actor.is_banned:
            log.info("agent_tool_refused", rule="actor_removed", user=str(self.user_id))
            return None
        return actor

    async def _propose_create_meeting(self, **arguments: Any) -> dict[str, Any]:
        if self._context.get("dialog_open"):
            log.info("agent_tool_refused", tool="propose_create_meeting", rule="dialog_open")
            return _refuse(
                "The user has a dialog open in the app, and I cannot change the screen "
                "underneath it. Ask them to finish or close it first."
            )

        async with self._factory() as db:
            actor = await self._actor(db)
            conversation = await db.get(AgentConversation, self.conversation_id)
            if actor is None or conversation is None:
                return _refuse("Your account can no longer use the assistant.")
            try:
                action = await proposals.propose_meeting_create(
                    db, actor, conversation, **arguments
                )
            except ProposalRefused as refusal:
                await db.rollback()
                log.info("agent_tool_refused", tool="propose_create_meeting", rule="refused")
                return _refuse(str(refusal))
            proposal = {
                "id": str(action.id),
                "kind": action.kind,
                "summary": action.summary,
                "payload": action.payload,
                "labels": action.labels,
                "warnings": [],
                "approval": action.approval_policy,
                "expires_at": action.expires_at.isoformat(),
            }
            waiting = _OpenProposal(
                id=action.id,
                kind=action.kind,
                title=str(action.payload.get("title", "")),
                policy=proposals.policy_of(action),
                expires_at=action.expires_at,
            )
            await db.commit()

        replaced, self._open = self._open, waiting
        if replaced is not None:
            await self._send("proposal_result", id=str(replaced.id), status="superseded")

        await self._send("mode", mode="working")
        await self._send("step", id="stage", label="Fill in the meeting", status="active")
        staged = await self._directive("stage", proposal=proposal)
        if not staged.get("ok"):
            async with self._factory() as db:
                await proposals.resolve(db, waiting.id, AgentActionStatus.CANCELLED)
                await db.commit()
            self._open = None
            await self._send("proposal_result", id=proposal["id"], status="cancelled")
            await self._leave_work_mode()
            return _refuse(
                str(staged.get("reason") or "")
                or "The app could not show that on screen, so nothing was staged. Ask the "
                "user to try again."
            )

        await self._send("step", id="stage", label="Fill in the meeting", status="done")
        await self._send("step", id="approval", label="Waiting for your approval", status="active")
        await self._send("proposal", **proposal)

        if waiting.policy is AgentApprovalPolicy.CLICK:
            how = (
                "This sends email, so it needs a click. Speak the summary in full, then say "
                "'press Approve when you are ready'. Do not call commit_proposal."
            )
        else:
            how = (
                "Speak the summary in full, then ask the user to approve. Call "
                "commit_proposal only after a clear yes that follows the whole summary."
            )
        return {
            "ok": True,
            "proposal_id": proposal["id"],
            "summary": action.summary,
            "approval": action.approval_policy,
            "what_to_do": how,
        }

    async def _voice_commit(self, proposal_id: str) -> dict[str, Any]:
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
        )
        refusal = agent_rules.refuse_voice_commit(facts)
        if refusal is not None or waiting is None:
            reason = refusal or "unknown"
            log.info(
                "agent_voice_commit_rejected",
                conversation_id=str(self.conversation_id),
                condition=reason,
            )
            return _refuse(agent_rules.REFUSALS[reason])

        outcome = await self._commit(
            waiting, via=AgentApprovedVia.VOICE, utterance=self._last_heard or None
        )
        text = _outcome_for_model(outcome)
        self._unreported = text
        return {"ok": outcome.committed, "status": outcome.status, "tell_the_user": text}

    async def _commit(
        self, waiting: _OpenProposal, *, via: AgentApprovedVia, utterance: str | None
    ) -> proposals.CommitOutcome:
        """Commit, in a task of its own, and report to the browser whatever happens.

        Shielded: if the user speaks while this runs, the model's tool call is cancelled,
        and a commit that stopped half-way because of that would be the worst outcome
        there is. It finishes regardless and the browser is told directly.
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
                "ui", directive_id=uuid.uuid4().hex, action="refresh", keys=["meetings"]
            )
        else:
            await self._send(
                "proposal_result", id=str(waiting.id), status="failed", error=outcome.error
            )
        await self._leave_work_mode()
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
                log.debug("agent_send_failed", frame=frame)

    async def _send_bytes(self, data: bytes) -> None:
        async with self._send_lock:
            try:
                await self._socket.send_bytes(data)
            except Exception:
                log.debug("agent_send_failed", frame="audio")

    async def _record(self, role: AgentMessageRole, source: AgentMessageSource, text: str) -> None:
        """Write one finished utterance to the transcript. Never fatal to the conversation."""
        try:
            async with self._factory() as db:
                await agent_service.append_message(
                    db, self.conversation_id, role=role, source=source, text=text
                )
                await db.commit()
        except Exception:
            log.exception("agent_transcript_write_failed")


#: The frames a browser may send that are handled by a method named ``_on_<type>``.
_BROWSER_FRAMES = frozenset({"text", "context", "readback_played", "approval", "stop", "ui_ack"})


def _refuse(message: str) -> dict[str, Any]:
    return {"ok": False, "tell_the_user": message}


def _as_done(summary: str) -> str:
    """A proposal's summary, reworded as something that has happened."""
    return summary.replace("I am about to create", "Created", 1)


def _outcome_for_model(outcome: proposals.CommitOutcome) -> str:
    if outcome.committed:
        return "It was committed: it is saved."
    if outcome.status == "already_resolved":
        if outcome.resolved_as == AgentActionStatus.COMMITTED.value:
            return "It had already been approved and is saved. Nothing was saved twice."
        return f"It was no longer open ({outcome.resolved_as}), so nothing was saved."
    return f"It was not saved. {outcome.error or ''}".strip()
