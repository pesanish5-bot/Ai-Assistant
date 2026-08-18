"""Local-only orchestration for speaker and randomized-challenge verification."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

from .authentication import AuthenticationDecision, AuthenticationPrototype
from .interaction import SessionState
from .speaker import (
    CosineSpeakerVerifier,
    LivenessDetector,
    SpeakerEmbeddingBackend,
    SpeakerProfileStore,
    SpeakerVerifier,
)


class AuthenticationTranscriber(Protocol):
    """A local STT boundary reserved for authentication audio."""

    def transcribe_file(self, audio_path: Path) -> str: ...


@dataclass(slots=True)
class AuthenticationSessionController:
    prototype: AuthenticationPrototype
    backend: SpeakerEmbeddingBackend
    profile_store: SpeakerProfileStore
    transcriber: AuthenticationTranscriber
    liveness_detector: LivenessDetector
    profile_id: str
    verifier: SpeakerVerifier = field(default_factory=CosineSpeakerVerifier)
    verification_guard: Callable[[], bool] | None = None
    _challenge_phrase: str | None = field(default=None, init=False, repr=False)

    def begin(self, timestamp: float, session_state: SessionState) -> AuthenticationDecision:
        self._challenge_phrase = None
        return self.prototype.start(
            timestamp,
            activation_method="double_clap",
            session_state=session_state,
        )

    def fail_closed(self, timestamp: float, reason_code: str) -> AuthenticationDecision:
        self._challenge_phrase = None
        return self.prototype.fail_closed(timestamp, reason_code)

    def submit_identity_audio(self, timestamp: float, audio_path: Path) -> AuthenticationDecision:
        try:
            profile = self.profile_store.load(self.profile_id)
            if profile.model_id != self.backend.model_id:
                raise ValueError("speaker profile model does not match the active backend")
            embedding = self.backend.embedding_from_file(audio_path)
            similarity = self.verifier.similarity(profile, embedding)
            claimed_identity = self.transcriber.transcribe_file(audio_path)
            decision = self.prototype.submit_identity(
                timestamp,
                claimed_identity=claimed_identity,
                speaker_similarity=similarity,
            )
            self._challenge_phrase = decision.challenge_phrase
            return decision
        except (FileNotFoundError, KeyError, OSError, RuntimeError, ValueError):
            self._challenge_phrase = None
            return self.prototype.fail_closed(timestamp, "identity_processing_failed")

    def submit_challenge_audio(self, timestamp: float, audio_path: Path) -> AuthenticationDecision:
        if not self._challenge_phrase:
            return self.prototype.fail_closed(timestamp, "challenge_missing")
        try:
            profile = self.profile_store.load(self.profile_id)
            if profile.model_id != self.backend.model_id:
                raise ValueError("speaker profile model does not match the active backend")
            embedding = self.backend.embedding_from_file(audio_path)
            similarity = self.verifier.similarity(profile, embedding)
            transcript = self.transcriber.transcribe_file(audio_path)
            liveness = self.liveness_detector.confidence(audio_path, self._challenge_phrase)
            decision = self.prototype.submit_challenge(
                timestamp,
                transcript=transcript,
                speaker_similarity=similarity,
                liveness_confidence=liveness,
                verification_guard=self.verification_guard,
            )
            self._challenge_phrase = None
            return decision
        except (FileNotFoundError, KeyError, OSError, RuntimeError, ValueError):
            self._challenge_phrase = None
            return self.prototype.fail_closed(timestamp, "challenge_processing_failed")

    def mark_challenge_prompted(self, timestamp: float) -> None:
        self.prototype.mark_challenge_prompted(timestamp)
