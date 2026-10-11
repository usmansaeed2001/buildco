"""What a conversation needs from a live model, and nothing about which model it is.

Two reasons this is an interface. A conversation can be tested against a script, with
no network, no audio and no cost. And the model is the part most likely to be replaced:
model ids and SDKs change, and when they do the change belongs in one module.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

#: A function the model may call. Its name, signature and docstring are what the model
#: is shown, so they are written for the model to read. It returns plain data.
Tool = Callable[..., Awaitable[dict[str, Any]]]


def blocking(tool: Tool) -> Tool:
    """Mark a tool the model must wait for before it speaks again.

    Every tool that stages or writes something is blocking: the model must not start
    describing a result it does not have yet.
    """
    tool.blocking = True  # type: ignore[attr-defined]
    return tool


@dataclass(frozen=True, slots=True)
class ModelEvent:
    """One thing the model session reported. Usually only one field is set.

    Offsets are seconds into the microphone audio sent so far. They are what the voice
    approval guard runs on, so they come from the model's own account of where speech
    began, not from when this event happened to arrive.
    """

    #: 24 kHz, 16-bit, mono PCM of the agent's voice.
    audio: bytes | None = None
    #: The agent's own speech, transcribed. Fragments first, then the whole utterance
    #: once with ``said_final``.
    said: str | None = None
    said_final: bool = False
    #: The user's speech, transcribed, in the same two forms.
    heard: str | None = None
    heard_final: bool = False
    speech_began_at: float | None = None
    speech_ended_at: float | None = None
    #: The user spoke over the agent. Audio already sent must not be played.
    interrupted: bool = False
    turn_complete: bool = False


class ModelSession(Protocol):
    def send_audio(self, pcm16k: bytes) -> None:
        """Forward 16 kHz, 16-bit, mono PCM from the microphone."""

    def send_text(self, text: str) -> None:
        """Send a typed message, or a notice from the server, as a user turn."""

    def events(self) -> AsyncIterator[ModelEvent]:
        """What the model does, until the session ends.

        Ends by raising when the session fails, and by returning when it closes. A
        conversation treats both as "this model session is over" and starts another.
        """
        ...

    async def close(self) -> None: ...


class LiveModel(Protocol):
    async def open(
        self, *, instruction: str, tools: Sequence[Tool], vocabulary: Sequence[str] = ()
    ) -> ModelSession:
        """Start a model session.

        ``vocabulary`` is words the transcriber should expect: names on the team's
        roster, mostly, which it otherwise spells by ear.
        """
        ...
