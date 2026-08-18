"""Fail-closed speaker/challenge prototype with no operating-system unlock."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Callable

from .interaction import EventName, InteractionEvent, SessionState
from .security import (
    AttemptThrottler,
    Challenge,
    ChallengeGenerator,
    SecurityEventSink,
    normalize_phrase,
)


class AuthenticationState(StrEnum):
    IDLE = "idle"
    IDENTIFYING = "identifying"
    CHALLENGE_ISSUED = "challenge_issued"
    VERIFIED_PROTOTYPE = "verified_prototype"
    FAILED = "failed"
    THROTTLED = "throttled"


@dataclass(frozen=True, slots=True)
class AuthenticationConfig:
    expected_identity: str
    minimum_speaker_similarity: float = 0.78
    minimum_liveness_confidence: float = 0.70
    challenge_timeout_seconds: float = 20.0

    def __post_init__(self) -> None:
        if not self.expected_identity.strip():
            raise ValueError("expected_identity is required")
        if not -1.0 <= self.minimum_speaker_similarity <= 1.0:
            raise ValueError("speaker threshold must be between -1 and 1")
        if not 0.0 <= self.minimum_liveness_confidence <= 1.0:
            raise ValueError("liveness threshold must be between 0 and 1")
        if self.challenge_timeout_seconds <= 0:
            raise ValueError("challenge timeout must be positive")


@dataclass(frozen=True, slots=True)
class AuthenticationDecision:
    state: AuthenticationState
    public_message: str
    event: InteractionEvent
    challenge_phrase: str | None = None
    authenticated: bool = False
    allows_os_unlock: bool = field(default=False, init=False)


@dataclass(slots=True)
class AuthenticationPrototype:
    """Evaluate a local identity gate without possessing Windows credentials."""

    event_log: SecurityEventSink
    config: AuthenticationConfig
    challenge_generator: ChallengeGenerator = field(default_factory=ChallengeGenerator)
    throttler: AttemptThrottler = field(default_factory=AttemptThrottler)
    state: AuthenticationState = field(default=AuthenticationState.IDLE, init=False)
    _challenge: Challenge | None = field(default=None, init=False)
    _activation_method: str = field(default="unknown", init=False)

    def start(
        self,
        timestamp: float,
        *,
        activation_method: str,
        session_state: SessionState,
    ) -> AuthenticationDecision:
        self._activation_method = activation_method
        self._challenge = None
        if session_state is not SessionState.LOCKED:
            self.state = AuthenticationState.FAILED
            self.event_log.record(
                "auth.failed",
                timestamp,
                activation_method=activation_method,
                session_state=session_state.value,
                outcome="failed",
                reason_code="invalid_session_state",
                os_unlock_attempted=False,
            )
            return self._decision(EventName.AUTH_FAILED, timestamp, "Authentication failed.")

        if not self.throttler.can_attempt(timestamp):
            self.state = AuthenticationState.THROTTLED
            self.event_log.record(
                "auth.throttled",
                timestamp,
                activation_method=activation_method,
                session_state=session_state.value,
                outcome="throttled",
                attempt_number=self.throttler.consecutive_failures + 1,
                os_unlock_attempted=False,
            )
            return self._decision(EventName.AUTH_THROTTLED, timestamp, "Authentication unavailable.")

        self.state = AuthenticationState.IDENTIFYING
        self.event_log.record(
            "auth.started",
            timestamp,
            activation_method=activation_method,
            session_state=session_state.value,
            outcome="pending",
            attempt_number=self.throttler.consecutive_failures + 1,
            os_unlock_attempted=False,
        )
        return self._decision(EventName.AUTH_STARTED, timestamp, "Identify yourself.")

    def submit_identity(
        self,
        timestamp: float,
        *,
        claimed_identity: str,
        speaker_similarity: float,
    ) -> AuthenticationDecision:
        if self.state is not AuthenticationState.IDENTIFYING:
            return self._fail(timestamp, "invalid_state", speaker_verified=False)
        self._validate_score(speaker_similarity)
        normalized_identity = normalize_phrase(self.config.expected_identity)
        normalized_claim = normalize_phrase(claimed_identity)
        identity_matches = normalized_claim in {
            normalized_identity,
            f"i am {normalized_identity}",
            f"my name is {normalized_identity}",
        }
        speaker_verified = speaker_similarity >= self.config.minimum_speaker_similarity
        if not identity_matches or not speaker_verified:
            return self._fail(timestamp, "identity_failed", speaker_verified=speaker_verified)

        self._challenge = self.challenge_generator.generate(timestamp)
        self.state = AuthenticationState.CHALLENGE_ISSUED
        self.event_log.record(
            "auth.challenge_issued",
            timestamp,
            activation_method=self._activation_method,
            speaker_verified=True,
            outcome="pending",
            attempt_number=self.throttler.consecutive_failures + 1,
            os_unlock_attempted=False,
        )
        return self._decision(
            EventName.AUTH_CHALLENGE_ISSUED,
            timestamp,
            f"Say: {self._challenge.phrase}.",
            challenge_phrase=self._challenge.phrase,
        )

    def submit_challenge(
        self,
        timestamp: float,
        *,
        transcript: str,
        speaker_similarity: float,
        liveness_confidence: float,
        verification_guard: Callable[[], bool] | None = None,
    ) -> AuthenticationDecision:
        if self.state is not AuthenticationState.CHALLENGE_ISSUED or self._challenge is None:
            return self._fail(timestamp, "invalid_state", speaker_verified=False)
        self._validate_score(speaker_similarity)
        self._validate_confidence(liveness_confidence)

        expired = (
            timestamp < self._challenge.issued_at
            or timestamp - self._challenge.issued_at > self.config.challenge_timeout_seconds
        )
        challenge_passed = not expired and normalize_phrase(transcript) == normalize_phrase(self._challenge.phrase)
        speaker_verified = speaker_similarity >= self.config.minimum_speaker_similarity
        liveness_passed = liveness_confidence >= self.config.minimum_liveness_confidence
        if not (challenge_passed and speaker_verified and liveness_passed):
            reason = "challenge_timeout" if expired else "challenge_verification_failed"
            return self._fail(
                timestamp,
                reason,
                speaker_verified=speaker_verified,
                challenge_passed=challenge_passed,
                liveness_passed=liveness_passed,
            )

        # Speaker matching and liveness inference can take several seconds.
        # Revalidate the external security boundary only after those checks
        # pass, and immediately before committing a successful result. A
        # missing/failed guard response must never authenticate the session.
        if verification_guard is not None:
            try:
                verification_allowed = verification_guard()
            except Exception:
                verification_allowed = False
            if not verification_allowed:
                return self._fail(
                    timestamp,
                    "session_state_changed",
                    speaker_verified=True,
                    challenge_passed=True,
                    liveness_passed=True,
                )

        self.state = AuthenticationState.VERIFIED_PROTOTYPE
        self.throttler.record_success()
        self.event_log.record(
            "auth.prototype_verified",
            timestamp,
            activation_method=self._activation_method,
            speaker_verified=True,
            challenge_passed=True,
            liveness_passed=True,
            outcome="verified_prototype_only",
            os_unlock_attempted=False,
        )
        return self._decision(
            EventName.AUTH_PROTOTYPE_VERIFIED,
            timestamp,
            "Identity verified. Complete Windows sign-in normally.",
            authenticated=True,
        )

    def mark_challenge_prompted(self, timestamp: float) -> None:
        """Start the reply timeout only after the local prompt is audible."""

        if self.state is not AuthenticationState.CHALLENGE_ISSUED or self._challenge is None:
            raise RuntimeError("no active authentication challenge")
        self._challenge = Challenge(self._challenge.phrase, timestamp)

    def fail_closed(self, timestamp: float, reason_code: str = "processing_failed") -> AuthenticationDecision:
        """Abort an in-progress attempt without exposing sensitive diagnostics."""

        return self._fail(timestamp, reason_code, speaker_verified=False)

    def _fail(
        self,
        timestamp: float,
        reason_code: str,
        *,
        speaker_verified: bool,
        challenge_passed: bool | None = None,
        liveness_passed: bool | None = None,
    ) -> AuthenticationDecision:
        self.state = AuthenticationState.FAILED
        attempt_number = self.throttler.consecutive_failures + 1
        self.throttler.record_failure(timestamp)
        self.event_log.record(
            "auth.failed",
            timestamp,
            activation_method=self._activation_method,
            speaker_verified=speaker_verified,
            challenge_passed=challenge_passed,
            liveness_passed=liveness_passed,
            outcome="failed",
            attempt_number=attempt_number,
            reason_code=reason_code,
            os_unlock_attempted=False,
        )
        self._challenge = None
        return self._decision(EventName.AUTH_FAILED, timestamp, "Authentication failed.")

    def _decision(
        self,
        event_name: EventName,
        timestamp: float,
        message: str,
        *,
        challenge_phrase: str | None = None,
        authenticated: bool = False,
    ) -> AuthenticationDecision:
        return AuthenticationDecision(
            state=self.state,
            public_message=message,
            event=InteractionEvent(event_name, timestamp, "authentication-prototype"),
            challenge_phrase=challenge_phrase,
            authenticated=authenticated,
        )

    @staticmethod
    def _validate_score(value: float) -> None:
        if not math.isfinite(value) or not -1.0 <= value <= 1.0:
            raise ValueError("speaker similarity must be between -1 and 1")

    @staticmethod
    def _validate_confidence(value: float) -> None:
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise ValueError("liveness confidence must be between 0 and 1")
