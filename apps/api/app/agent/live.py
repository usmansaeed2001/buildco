"""The voice WebSocket.

Mounted only on a process started with ``AGENT_SERVE_LIVE``. In production that is the
``buildco-agent`` service, which the browser reaches directly: Firebase Hosting's
``/api/**`` rewrite does not proxy WebSockets.

A socket is admitted on two things and nothing else: the ``Origin`` header, and a ticket
that the API service issued to a signed-in user a moment ago. There is no bearer token
here, because a browser cannot set one on a WebSocket.

**What a closed socket means** depends on how it closed, and getting this wrong in the
obvious way would refuse every reconnect:

* Announced (an ``end`` frame, a time limit, an error): the conversation ends now.
* Unannounced (the connection simply went away): the conversation is left ``active``
  with the moment it dropped recorded, and is ended a minute later unless a reconnect
  has picked it up under a new generation by then.
* Replaced (a reconnect took it over while this socket was still half alive): nothing.
  The conversation is another socket's now.
"""

from __future__ import annotations

import asyncio
import contextlib
import uuid

from fastapi import APIRouter, WebSocket

from app.agent.conversation import Ending, LiveConversation
from app.agent.model import LiveModel
from app.agent.proposals import SessionFactory
from app.config import get_settings
from app.db import get_session_factory
from app.errors import AppError
from app.logging import get_logger
from app.models.enums import AgentEndReason
from app.services import agent_service

log = get_logger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

#: Close codes in the application range. The browser shows a message for each.
CLOSE_BAD_ORIGIN = 4403
CLOSE_BAD_TICKET = 4401

_model: LiveModel | None = None
#: Timers ending conversations nobody came back to. Held so they are not collected.
_waiting_for_reconnect: set[asyncio.Task[None]] = set()


def get_live_model() -> LiveModel:
    """The process-wide model. Built on first use, so importing this module is cheap."""
    global _model
    if _model is None:
        from app.agent.adk_model import AdkLiveModel

        _model = AdkLiveModel(get_settings())
    return _model


def set_live_model(model: LiveModel | None) -> None:
    """Replace the model. For tests, which script one."""
    global _model
    _model = model


def origin_allowed(origin: str | None) -> bool:
    """Whether a socket from this origin is ours.

    A WebSocket is not subject to CORS, so any page on the internet can open one to this
    URL from a signed-in user's browser. The ticket is the real defence; this stops the
    easy version. A missing ``Origin`` is refused: every browser sends one.
    """
    return origin is not None and origin.rstrip("/") in get_settings().cors_origins


async def settle(
    factory: SessionFactory, conversation_id: uuid.UUID, generation: int, ending: Ending
) -> None:
    """Do to the conversation what the way its socket ended calls for."""
    if ending.how == "replaced":
        return
    async with factory() as db:
        if ending.how == "ended":
            await agent_service.end_conversation(
                db, conversation_id, ending.reason or AgentEndReason.ERROR
            )
            await db.commit()
            return
        held = await agent_service.mark_dropped(db, conversation_id, generation)
        await db.commit()
    if held:
        timer = asyncio.create_task(_end_if_nobody_returns(factory, conversation_id, generation))
        _waiting_for_reconnect.add(timer)
        timer.add_done_callback(_waiting_for_reconnect.discard)


async def _end_if_nobody_returns(
    factory: SessionFactory, conversation_id: uuid.UUID, generation: int
) -> None:
    """A minute after a drop, end the conversation unless a reconnect has taken it.

    If this instance dies first, the timer dies with it, and the stale-heartbeat reaper
    ends the conversation the next time its owner opens history or starts another.
    """
    await asyncio.sleep(agent_service.RECONNECT_WINDOW_SECONDS)
    try:
        async with factory() as db:
            await agent_service.end_if_not_back(db, conversation_id, generation)
            await db.commit()
    except Exception:
        log.exception("agent_drop_timer_failed", conversation_id=str(conversation_id))


@router.websocket("/live")
async def live(socket: WebSocket) -> None:
    if not origin_allowed(socket.headers.get("origin")):
        await socket.close(code=CLOSE_BAD_ORIGIN)
        return

    factory = get_session_factory()
    try:
        async with factory() as db:
            conversation, user = await agent_service.redeem_ticket(
                db, socket.query_params.get("ticket", "")
            )
            conversation_id, user_id = conversation.id, user.id
            generation = conversation.connection_generation
            await db.commit()
    except AppError:
        await socket.close(code=CLOSE_BAD_TICKET)
        return

    await socket.accept()
    log.info(
        "agent_session_started",
        conversation_id=str(conversation_id),
        user=str(user_id),
        generation=generation,
    )
    ending = Ending.ended(AgentEndReason.ERROR)
    try:
        ending = await LiveConversation(
            socket=socket,
            model=get_live_model(),
            factory=factory,
            conversation_id=conversation_id,
            user_id=user_id,
            generation=generation,
        ).run()
    except Exception:
        log.exception("agent_conversation_failed", conversation_id=str(conversation_id))
    finally:
        await settle(factory, conversation_id, generation, ending)
        # Already closed, if the other side went first.
        with contextlib.suppress(RuntimeError):
            await socket.close()
