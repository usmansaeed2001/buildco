"""Stand-ins for the two things a conversation talks to: the browser and the model.

Neither is a mock that records calls. Each behaves like the real thing in the one way
that matters to the code under test.

``FakeSocket`` is a browser on the other end of the WebSocket: it queues what the browser
would send and keeps what the server sent. Like a real page, it acknowledges a staging
directive on its own.

``ScriptedModel`` is a live model whose side of the conversation the test writes. A tool
call runs **inside the event stream**, because that is how ADK behaves: while a tool is
running, no further events from the model are delivered. A fake that ran tools on the
side would hide every bug that depends on that.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any

from app.agent.conversation import MIC_BYTES_PER_SECOND
from app.agent.model import ModelEvent, Tool

_CLOSED = object()


class FakeSocket:
    def __init__(self) -> None:
        self._inbox: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        #: Every JSON frame the server sent, in order.
        self.sent: list[dict[str, Any]] = []
        #: Every audio frame the server sent.
        self.audio: list[bytes] = []
        #: What this browser answers to a ``stage`` directive. A real page stages the
        #: form and says so; set ``ok`` False to be a page that could not.
        self.stage_answer: dict[str, Any] | None = {"ok": True}
        self._arrived = asyncio.Event()

    # ── What the conversation calls ───────────────────────────────────────────

    async def receive(self) -> dict[str, Any]:
        return await self._inbox.get()

    async def send_text(self, data: str) -> None:
        frame = json.loads(data)
        self.sent.append(frame)
        self._arrived.set()
        if frame["type"] == "ui" and frame.get("action") == "stage" and self.stage_answer:
            self.frame("ui_ack", directive_id=frame["directive_id"], **self.stage_answer)

    async def send_bytes(self, data: bytes) -> None:
        self.audio.append(data)

    # ── What the browser does ─────────────────────────────────────────────────

    def frame(self, kind: str, **fields: Any) -> None:
        self._inbox.put_nowait(
            {"type": "websocket.receive", "text": json.dumps({"type": kind, **fields})}
        )

    def microphone(self, seconds: float) -> None:
        """Stream this much microphone audio. It is silence; only its length matters."""
        self._inbox.put_nowait(
            {"type": "websocket.receive", "bytes": bytes(int(seconds * MIC_BYTES_PER_SECOND))}
        )

    def hang_up(self) -> None:
        """Go away without saying goodbye, as a dropped connection does."""
        self._inbox.put_nowait({"type": "websocket.disconnect"})

    # ── What the test asks ────────────────────────────────────────────────────

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [frame for frame in self.sent if frame["type"] == kind]

    def kinds(self) -> list[str]:
        return [frame["type"] for frame in self.sent]

    async def wait_for(self, kind: str, timeout: float = 3.0, **matching: Any) -> dict[str, Any]:
        """The first frame of this kind with these fields, waiting for it if need be."""

        def found() -> dict[str, Any] | None:
            for frame in self.sent:
                if frame["type"] == kind and all(frame.get(k) == v for k, v in matching.items()):
                    return frame
            return None

        async def poll() -> dict[str, Any]:
            while True:
                hit = found()
                if hit is not None:
                    return hit
                self._arrived.clear()
                await self._arrived.wait()

        try:
            return await asyncio.wait_for(poll(), timeout)
        except TimeoutError:
            raise AssertionError(
                f"no {kind!r} frame matching {matching}; the server sent {self.kinds()}"
            ) from None


class ScriptedSession:
    def __init__(self, instruction: str, tools: Sequence[Tool], vocabulary: Sequence[str]) -> None:
        self.instruction = instruction
        self.tools = {tool.__name__: tool for tool in tools}
        self.vocabulary = list(vocabulary)
        #: Everything sent to the model as text: typed messages and server notices.
        self.texts: list[str] = []
        self.audio_seconds = 0.0
        self.closed = False
        self._queue: asyncio.Queue[Any] = asyncio.Queue()

    # ── What the conversation calls ───────────────────────────────────────────

    def send_audio(self, pcm16k: bytes) -> None:
        self.audio_seconds += len(pcm16k) / MIC_BYTES_PER_SECOND

    def send_text(self, text: str) -> None:
        self.texts.append(text)

    async def events(self) -> AsyncIterator[ModelEvent]:
        while True:
            item = await self._queue.get()
            if item is _CLOSED:
                return
            if isinstance(item, Exception):
                raise item
            if isinstance(item, ModelEvent):
                yield item
            else:
                # A tool call. Awaited here, so nothing after it is delivered until it
                # returns, exactly as with the real SDK.
                await item()

    async def close(self) -> None:
        self.closed = True

    # ── What the model does, as the test scripts it ───────────────────────────

    def emit(self, **fields: Any) -> None:
        self._queue.put_nowait(ModelEvent(**fields))

    def hears(self, text: str, *, began_at: float) -> None:
        """The user said something, starting this far into the microphone stream."""
        self.emit(speech_began_at=began_at)
        self.emit(heard=text, heard_final=True)

    def says(self, text: str) -> None:
        """A whole spoken turn: audio, its transcript, and the end of the turn."""
        self.emit(audio=b"\x00\x00" * 2400)
        self.emit(said=text, said_final=True)
        self.emit(turn_complete=True)

    def starts_saying(self, text: str) -> None:
        """Begins a spoken turn and does not finish it."""
        self.emit(audio=b"\x00\x00" * 2400)
        self.emit(said=text, said_final=False)

    def is_interrupted(self) -> None:
        self.emit(interrupted=True)
        self.emit(turn_complete=True)

    async def calls(self, name: str, **arguments: Any) -> dict[str, Any]:
        """Call one of the tools the model was given, and wait for what it returns.

        The call ends its own turn afterwards, with no audio in it, which is what the
        real model does and what makes "the turn that spoke" a distinction worth testing.
        """
        result: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async def run() -> None:
            try:
                result.set_result(await self.tools[name](**arguments))
            except Exception as exc:
                result.set_exception(exc)

        self._queue.put_nowait(run)
        answer = await result
        self.emit(turn_complete=True)
        return answer

    def call_without_waiting(self, name: str, **arguments: Any) -> asyncio.Future[dict[str, Any]]:
        """Start a tool call and carry on, to script something happening during it."""
        result: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()

        async def run() -> None:
            result.set_result(await self.tools[name](**arguments))

        self._queue.put_nowait(run)
        return result

    def dies(self, problem: Exception | None = None) -> None:
        """The session ends under the conversation: with an error, or just closed."""
        self._queue.put_nowait(problem if problem is not None else _CLOSED)


class ScriptedModel:
    """A live model that hands out sessions the test drives."""

    def __init__(self) -> None:
        self.sessions: list[ScriptedSession] = []
        self._opened = asyncio.Event()
        #: Called for each new session, for a test that wants to script one up front.
        self.on_open: Callable[[ScriptedSession], Awaitable[None] | None] | None = None

    async def open(
        self, *, instruction: str, tools: Sequence[Tool], vocabulary: Sequence[str] = ()
    ) -> ScriptedSession:
        session = ScriptedSession(instruction, tools, vocabulary)
        self.sessions.append(session)
        self._opened.set()
        return session

    @property
    def session(self) -> ScriptedSession:
        """The session currently in use."""
        return self.sessions[-1]

    async def wait_for_session(self, number: int, timeout: float = 3.0) -> ScriptedSession:
        """The nth session to be opened, counting from one."""

        async def poll() -> ScriptedSession:
            while len(self.sessions) < number:
                self._opened.clear()
                await self._opened.wait()
            return self.sessions[number - 1]

        return await asyncio.wait_for(poll(), timeout)
