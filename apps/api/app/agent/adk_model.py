"""The live model, over Google ADK and Gemini Live on Vertex AI.

The only module that imports ``google.adk``. It is imported lazily, and only by a
process started with ``AGENT_SERVE_LIVE``, so the API service never loads it.

What is here beyond plumbing, each from testing against the real service:

* **One model client, holding its credentials.** Left to its default, every live connect
  looks up Application Default Credentials and refreshes the token with blocking calls on
  the event loop, which every conversation on the instance shares. The client is built
  once, and the token is refreshed off the loop before a session opens.
* **Voice-activity signals are switched on.** They are what report where in the
  microphone stream each user utterance began, which the voice approval guard needs.
* **Session resumption is on**, so ADK can replace the Live API's connection, which
  lasts about ten minutes, without the conversation noticing. It retries a closed
  connection but not a connect that hangs; that case ends this session, and the
  conversation starts another.
"""

from __future__ import annotations

import asyncio
import threading
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

import google.auth
import google.auth.transport.requests
from google.adk.agents import Agent, LiveRequestQueue, RunConfig
from google.adk.agents.run_config import StreamingMode  # type: ignore[attr-defined]
from google.adk.models import Gemini
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool  # type: ignore[attr-defined]
from google.genai import types

from app.agent.model import ModelEvent, Tool
from app.config import Settings
from app.logging import get_logger

log = get_logger(__name__)

APP_NAME = "buildco_assistant"
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
#: Refresh a token this close to expiring, so a session never opens on one about to die.
REFRESH_WITHIN_SECONDS = 300


def _seconds(duration: str | None) -> float | None:
    """``"12.34s"`` as 12.34."""
    try:
        return float((duration or "").rstrip("s"))
    except ValueError:
        return None


class AdkLiveModel:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = threading.Lock()
        self._credentials: Any = None
        self._gemini: Gemini | None = None

    def _ready(self) -> Gemini:
        """Build the shared client on first use and keep its token fresh. Blocking."""
        with self._lock:
            if self._credentials is None:
                self._credentials, discovered = google.auth.default(scopes=SCOPES)
                project = self._settings.google_cloud_project or discovered
                if not project:
                    raise RuntimeError(
                        "GOOGLE_CLOUD_PROJECT is not set and no project could be found "
                        "from the credentials, so the assistant cannot reach its model."
                    )
                self._gemini = Gemini(
                    model=self._settings.agent_model,
                    client_kwargs={
                        "vertexai": True,
                        "project": project,
                        "location": self._settings.google_cloud_location,
                        "credentials": self._credentials,
                    },
                )
            credentials = self._credentials
            expiry = getattr(credentials, "expiry", None)
            stale = (
                not getattr(credentials, "token", None)
                or not credentials.valid
                or (
                    expiry is not None
                    and (expiry - _utcnow_naive()).total_seconds() < REFRESH_WITHIN_SECONDS
                )
            )
            if stale:
                credentials.refresh(google.auth.transport.requests.Request())
            assert self._gemini is not None
            return self._gemini

    async def open(
        self, *, instruction: str, tools: Sequence[Tool], vocabulary: Sequence[str] = ()
    ) -> AdkSession:
        gemini = await asyncio.to_thread(self._ready)
        return AdkSession(
            gemini=gemini,
            voice=self._settings.agent_voice,
            instruction=instruction,
            tools=tools,
            vocabulary=vocabulary,
        )


def _utcnow_naive() -> Any:
    # google-auth keeps ``expiry`` as a naive UTC datetime.
    from datetime import UTC, datetime

    return datetime.now(UTC).replace(tzinfo=None)


class AdkSession:
    def __init__(
        self,
        *,
        gemini: Gemini,
        voice: str,
        instruction: str,
        tools: Sequence[Tool],
        vocabulary: Sequence[str],
    ) -> None:
        wrapped = []
        for tool in tools:
            function_tool = FunctionTool(tool)
            if getattr(tool, "blocking", False):
                function_tool.behavior = types.Behavior.BLOCKING
            wrapped.append(function_tool)

        self._sessions = InMemorySessionService()
        self._runner = Runner(
            app_name=APP_NAME,
            agent=Agent(name=APP_NAME, model=gemini, instruction=instruction, tools=wrapped),
            session_service=self._sessions,
        )
        self._queue = LiveRequestQueue()
        self._session_id = uuid.uuid4().hex
        self._config = RunConfig(
            streaming_mode=StreamingMode.BIDI,
            response_modalities=[types.Modality.AUDIO],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                )
            ),
            input_audio_transcription=types.AudioTranscriptionConfig(
                custom_vocabulary=list(vocabulary) or None
            ),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            session_resumption=types.SessionResumptionConfig(transparent=True),
            explicit_vad_signal=True,
        )
        self._stream: Any = None

    def send_audio(self, pcm16k: bytes) -> None:
        self._queue.send_realtime(types.Blob(data=pcm16k, mime_type="audio/pcm;rate=16000"))

    def send_text(self, text: str) -> None:
        self._queue.send_content(types.Content(role="user", parts=[types.Part(text=text)]))

    async def events(self) -> AsyncIterator[ModelEvent]:
        await self._sessions.create_session(
            app_name=APP_NAME, user_id="user", session_id=self._session_id
        )
        self._stream = self._runner.run_live(
            user_id="user",
            session_id=self._session_id,
            live_request_queue=self._queue,
            run_config=self._config,
        )
        async for event in self._stream:
            for translated in _translate(event):
                yield translated

    async def close(self) -> None:
        self._queue.close()
        if self._stream is not None:
            await self._stream.aclose()


def _translate(event: Any) -> list[ModelEvent]:
    """One ADK event as the handful of things a conversation cares about."""
    out: list[ModelEvent] = []
    if event.error_code or event.error_message:
        raise RuntimeError(f"model error {event.error_code}: {event.error_message}")

    if event.content and event.content.parts:
        for part in event.content.parts:
            if part.inline_data and part.inline_data.data:
                out.append(ModelEvent(audio=part.inline_data.data))

    said = event.output_transcription
    if said and said.text:
        out.append(ModelEvent(said=said.text, said_final=bool(said.finished)))
    heard = event.input_transcription
    if heard and heard.text:
        out.append(ModelEvent(heard=heard.text, heard_final=bool(heard.finished)))

    activity = event.voice_activity
    if activity is not None:
        offset = _seconds(activity.audio_offset)
        if offset is not None:
            if activity.voice_activity_type == types.VoiceActivityType.ACTIVITY_START:
                out.append(ModelEvent(speech_began_at=offset))
            elif activity.voice_activity_type == types.VoiceActivityType.ACTIVITY_END:
                out.append(ModelEvent(speech_ended_at=offset))

    if event.interrupted:
        out.append(ModelEvent(interrupted=True))
    if event.turn_complete:
        out.append(ModelEvent(turn_complete=True))
    return out
