"""The voice WebSocket.

Mounted only on a process started with ``AGENT_SERVE_LIVE``. In production that is the
``buildco-agent`` service, which the browser reaches directly: Firebase Hosting's
``/api/**`` rewrite does not proxy WebSockets.

A socket is admitted on two things and nothing else: the ``Origin`` header, and a ticket
that the API service issued to a signed-in user a moment ago. There is no bearer token
here, because a browser cannot set one on a WebSocket.
"""

from __future__ import annotations

import contextlib

from fastapi import APIRouter, WebSocket

from app.agent.conversation import LiveConversation
from app.agent.model import LiveModel
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
            await db.commit()
    except AppError:
        await socket.close(code=CLOSE_BAD_TICKET)
        return

    await socket.accept()
    log.info("agent_session_started", conversation_id=str(conversation_id), user=str(user_id))
    reason = AgentEndReason.ERROR
    try:
        reason = await LiveConversation(
            socket=socket,
            model=get_live_model(),
            factory=factory,
            conversation_id=conversation_id,
            user_id=user_id,
        ).run()
    except Exception:
        log.exception("agent_conversation_failed", conversation_id=str(conversation_id))
    finally:
        async with factory() as db:
            await agent_service.end_conversation(db, conversation_id, reason)
            await db.commit()
        # Already closed, if the other side went first.
        with contextlib.suppress(RuntimeError):
            await socket.close()
