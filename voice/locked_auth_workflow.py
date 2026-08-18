"""Local speaker/challenge workflow that deliberately stops before OS unlock."""

from __future__ import annotations

import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from .auth_session import AuthenticationSessionController, AuthenticationTranscriber
from .authentication import (
    AuthenticationConfig,
    AuthenticationDecision,
    AuthenticationPrototype,
    AuthenticationState,
)
from .interaction import InteractionEvent, SessionState, TtsPlaybackGate
from .liveness import LocalAudioLivenessHeuristic
from .security import ProtectedAttemptThrottler, ProtectedSecurityEventLog
from .sherpa_speaker import SherpaOnnxSpeakerEmbeddingBackend
from .speaker import (
    EncryptedFileSpeakerProfileStore,
    resolve_speaker_name,
    speaker_profile_id,
)


class AuthenticationRecorder(Protocol):
    def capture(self, destination: Path) -> None: ...


class AuthenticationSpeaker(Protocol):
    def speak(self, text: str) -> None: ...


class AuthenticationEventSink(Protocol):
    def publish(self, event: InteractionEvent) -> None: ...


@dataclass(slots=True)
class TtsGatedAuthenticationSpeaker:
    """Gate local activation while an authentication prompt is audible."""

    speaker: AuthenticationSpeaker
    gate: TtsPlaybackGate
    events: AuthenticationEventSink | None = None
    clock: Callable[[], float] = time.time

    def speak(self, text: str) -> None:
        self._publish(self.gate.playback_started(self.clock()))
        try:
            self.speaker.speak(text)
        finally:
            # Always release the gate, including when the audio device fails.
            self._publish(self.gate.playback_finished(self.clock()))

    def _publish(self, event: InteractionEvent) -> None:
        if self.events is None:
            return
        try:
            self.events.publish(event)
        except Exception:
            # HUD state is informational and never changes authentication.
            pass


@dataclass(frozen=True, slots=True)
class SttAuthenticationAdapter(AuthenticationTranscriber):
    stt: object

    def transcribe_file(self, audio_path: Path) -> str:
        return self.stt.transcribe(audio_path)  # type: ignore[attr-defined]


@dataclass(slots=True)
class LockedAuthenticationWorkflow:
    session: AuthenticationSessionController
    recorder: AuthenticationRecorder
    speaker: AuthenticationSpeaker
    events: AuthenticationEventSink | None = None
    clock: Callable[[], float] = time.time
    session_guard: Callable[[], bool] | None = None

    def __post_init__(self) -> None:
        # The workflow checks before and after each hardware operation. The
        # controller also needs the same authoritative lock-state check at the
        # final commit boundary after slow speaker/liveness inference.
        self.session.verification_guard = self.session_guard

    def start(
        self,
        timestamp: float,
        *,
        activation_method: str,
        session_state: SessionState,
    ) -> AuthenticationDecision:
        if activation_method != "double_clap":
            return self.session.fail_closed(timestamp, "invalid_activation_method")
        decision = self.session.begin(timestamp, session_state)
        self._publish(decision.event)
        if decision.state is not AuthenticationState.IDENTIFYING:
            return decision

        try:
            self._require_locked()
            self.speaker.speak(decision.public_message)
            with tempfile.TemporaryDirectory(prefix="ultron-auth-") as temporary:
                identity_path = Path(temporary) / "identity.wav"
                self._require_locked()
                self.recorder.capture(identity_path)
                self._require_locked()
                decision = self.session.submit_identity_audio(self.clock(), identity_path)
                if decision.state is not AuthenticationState.CHALLENGE_ISSUED:
                    self._publish(decision.event)
                    try:
                        self.speaker.speak(decision.public_message)
                    except Exception:
                        # The attempt is already terminal and counted. Output
                        # failure must not record a second failed attempt.
                        pass
                    return decision

                # The randomized phrase is spoken locally only. It is not sent
                # through the HUD bridge, normal core, LLM, Vault, or logs.
                self.speaker.speak(decision.public_message)
                self.session.mark_challenge_prompted(self.clock())
                challenge_path = Path(temporary) / "challenge.wav"
                self._require_locked()
                self.recorder.capture(challenge_path)
                self._require_locked()
                decision = self.session.submit_challenge_audio(self.clock(), challenge_path)
        except Exception:
            decision = self.session.fail_closed(self.clock(), "authentication_io_failed")

        self._publish(decision.event)
        try:
            self.speaker.speak(decision.public_message)
        except Exception:
            if decision.authenticated:
                decision = self.session.fail_closed(self.clock(), "authentication_output_failed")
                self._publish(decision.event)
        return decision

    def _require_locked(self) -> None:
        if self.session_guard is None:
            return
        if not self.session_guard():
            raise RuntimeError("Windows session state changed")

    def _publish(self, event: InteractionEvent) -> None:
        if self.events is None:
            return
        try:
            self.events.publish(event)
        except Exception:
            # Browser state is informational and never changes the auth result.
            pass


def build_locked_authentication_workflow(
    *,
    speaker_name: str | None = None,
    event_sink: AuthenticationEventSink | None = None,
    microphone_device: int | None = None,
    output_device: int | None = None,
    tts_gate: TtsPlaybackGate | None = None,
    stt: object | None = None,
    session_guard: Callable[[], bool] | None = None,
) -> LockedAuthenticationWorkflow:
    from .local_conversation_audio import (
        FasterWhisperSmallAdapter,
        KokoroMichaelAdapter,
        SileroVadMicrophoneCapture,
        default_voice_model_root,
    )

    configured_name = resolve_speaker_name(speaker_name)
    root = default_voice_model_root().expanduser().resolve()
    backend = SherpaOnnxSpeakerEmbeddingBackend()
    shared_stt = stt or FasterWhisperSmallAdapter(model_root=root)
    session = AuthenticationSessionController(
        AuthenticationPrototype(
            ProtectedSecurityEventLog.windows_default(),
            AuthenticationConfig(expected_identity=configured_name),
            throttler=ProtectedAttemptThrottler.windows_default(),
        ),
        backend,
        EncryptedFileSpeakerProfileStore.windows_default(),
        SttAuthenticationAdapter(shared_stt),
        LocalAudioLivenessHeuristic(),
        speaker_profile_id(configured_name),
    )
    michael = KokoroMichaelAdapter(
        model_directory=root / "sherpa-onnx" / "kokoro-en-v0_19",
        device=output_device,
    )
    return LockedAuthenticationWorkflow(
        session,
        SileroVadMicrophoneCapture(
            model_path=root / "sherpa-onnx" / "silero_vad.onnx",
            device=microphone_device,
        ),
        TtsGatedAuthenticationSpeaker(
            michael,
            tts_gate or TtsPlaybackGate(post_playback_ms=650),
            event_sink,
        ),
        event_sink,
        session_guard=session_guard,
    )
