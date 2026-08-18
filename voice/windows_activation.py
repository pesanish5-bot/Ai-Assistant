"""Route per-user Windows activation into the one existing Ultron core."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol

from .authentication import AuthenticationDecision
from .interaction import (
    EventName,
    InteractionEvent,
    LockStateProvider,
    LockStateRouter,
    SessionState,
)
from .windows_hud import HudOpenResult


class MicrophoneUnavailableError(RuntimeError):
    """Raised when the requested local microphone pipeline cannot start."""


class ListeningPipelineError(RuntimeError):
    """Raised when local STT, the core, or local TTS cannot complete a turn."""


class HudController(Protocol):
    def open_or_focus(self) -> HudOpenResult: ...


class ListeningSession(Protocol):
    def start(self, timestamp: float) -> InteractionEvent | None: ...


class ListeningController(Protocol):
    def start_listening(self, timestamp: float) -> InteractionEvent | None: ...


class AuthenticationStarter(Protocol):
    def start(
        self,
        timestamp: float,
        *,
        activation_method: str,
        session_state: SessionState,
    ) -> AuthenticationDecision: ...


@dataclass(slots=True)
class DeferredAuthenticationStarter:
    """Load biometric models only after a locked-session activation."""

    factory: Callable[[], AuthenticationStarter]
    _starter: AuthenticationStarter | None = field(default=None, init=False)

    def start(
        self,
        timestamp: float,
        *,
        activation_method: str,
        session_state: SessionState,
    ) -> AuthenticationDecision:
        if self._starter is None:
            self._starter = self.factory()
        return self._starter.start(
            timestamp,
            activation_method=activation_method,
            session_state=session_state,
        )


@dataclass(slots=True)
class DeferredListeningController:
    """Load VAD/STT only after an accepted activation event."""

    factory: Callable[[], ListeningSession]
    _session: ListeningSession | None = field(default=None, init=False)

    def start_listening(self, timestamp: float) -> InteractionEvent | None:
        if self._session is None:
            try:
                self._session = self.factory()
            except MicrophoneUnavailableError:
                raise
            except Exception as error:
                raise MicrophoneUnavailableError("local voice pipeline is unavailable") from error
        try:
            return self._session.start(timestamp)
        except MicrophoneUnavailableError:
            raise
        except ListeningPipelineError:
            raise
        except Exception as error:
            raise ListeningPipelineError("local listening pipeline failed") from error


@dataclass(frozen=True, slots=True)
class ActivationOutcome:
    routed_event: InteractionEvent
    emitted_events: tuple[InteractionEvent, ...]
    hud: HudOpenResult | None = None
    authentication: AuthenticationDecision | None = None
    listening_started: bool = False
    failure_reason: str | None = None


@dataclass(slots=True)
class WindowsActivationController:
    """Route local activation without granting wake words lock-screen authority."""

    session_state: LockStateProvider
    hud: HudController
    listener: ListeningController
    authentication: AuthenticationStarter
    router: LockStateRouter = field(default_factory=LockStateRouter)

    def handle(self, event: InteractionEvent) -> ActivationOutcome:
        routed = self._route(event, self.session_state.current_state())
        events: list[InteractionEvent] = [routed]

        if routed.name is EventName.HUD_OPEN_REQUESTED:
            hud_result = self.hud.open_or_focus()
            if not hud_result.ready:
                rejected = InteractionEvent(
                    EventName.ACTIVATION_REJECTED,
                    event.timestamp,
                    "windows-activation-controller",
                    {"reason": "hud_unavailable"},
                )
                events.append(rejected)
                return ActivationOutcome(
                    routed,
                    tuple(events),
                    hud=hud_result,
                    failure_reason="hud_unavailable",
                )

            if bool(routed.payload.get("enter_listening")):
                # Opening/focusing a window can take long enough for Windows
                # to lock. Revalidate immediately before acquiring speech or
                # allowing any conversational command to reach the core.
                if self.session_state.current_state() is not SessionState.UNLOCKED:
                    rejected = InteractionEvent(
                        EventName.ACTIVATION_REJECTED,
                        event.timestamp,
                        "windows-activation-controller",
                        {"reason": "session_state_changed"},
                    )
                    events.append(rejected)
                    return ActivationOutcome(
                        routed,
                        tuple(events),
                        hud=hud_result,
                        failure_reason="session_state_changed",
                    )
                try:
                    listening_event = self.listener.start_listening(event.timestamp)
                except MicrophoneUnavailableError:
                    rejected = InteractionEvent(
                        EventName.ACTIVATION_REJECTED,
                        event.timestamp,
                        "windows-activation-controller",
                        {"reason": "microphone_unavailable"},
                    )
                    events.append(rejected)
                    return ActivationOutcome(
                        routed,
                        tuple(events),
                        hud=hud_result,
                        failure_reason="microphone_unavailable",
                    )
                except ListeningPipelineError:
                    rejected = InteractionEvent(
                        EventName.ACTIVATION_REJECTED,
                        event.timestamp,
                        "windows-activation-controller",
                        {"reason": "voice_pipeline_unavailable"},
                    )
                    events.append(rejected)
                    return ActivationOutcome(
                        routed,
                        tuple(events),
                        hud=hud_result,
                        failure_reason="voice_pipeline_unavailable",
                    )
                if listening_event is not None:
                    events.append(listening_event)
                return ActivationOutcome(
                    routed,
                    tuple(events),
                    hud=hud_result,
                    listening_started=True,
                )

            return ActivationOutcome(routed, tuple(events), hud=hud_result)

        if routed.name is EventName.AUTH_START_REQUESTED:
            if self.session_state.current_state() is not SessionState.LOCKED:
                rejected = InteractionEvent(
                    EventName.ACTIVATION_REJECTED,
                    event.timestamp,
                    "windows-activation-controller",
                    {"reason": "session_state_changed"},
                )
                events.append(rejected)
                return ActivationOutcome(
                    routed,
                    tuple(events),
                    failure_reason="session_state_changed",
                )
            try:
                decision = self.authentication.start(
                    event.timestamp,
                    activation_method="double_clap",
                    session_state=SessionState.LOCKED,
                )
            except Exception:
                failed = InteractionEvent(
                    EventName.AUTH_FAILED,
                    event.timestamp,
                    "windows-activation-controller",
                    {"reason": "authentication_unavailable"},
                )
                events.append(failed)
                return ActivationOutcome(
                    routed,
                    tuple(events),
                    failure_reason="authentication_unavailable",
                )
            events.append(decision.event)
            return ActivationOutcome(routed, tuple(events), authentication=decision)

        return ActivationOutcome(
            routed,
            tuple(events),
            failure_reason=str(routed.payload.get("reason", "activation_rejected")),
        )

    def _route(self, event: InteractionEvent, session_state: SessionState) -> InteractionEvent:
        if event.name in {
            EventName.CLAP_ACTIVATION_DETECTED,
            EventName.CLAP_DOUBLE_DETECTED,
        }:
            return self.router.route(event, session_state)
        if event.name is not EventName.VOICE_WAKE_DETECTED:
            raise ValueError(f"unsupported activation event: {event.name.value}")

        if session_state is SessionState.UNLOCKED:
            return InteractionEvent(
                EventName.HUD_OPEN_REQUESTED,
                event.timestamp,
                "wake-word-router",
                {"enter_listening": True, "activation_method": "wake_word"},
            )

        reason = (
            "wake_word_locked"
            if session_state is SessionState.LOCKED
            else "lock_state_unknown"
        )
        return InteractionEvent(
            EventName.ACTIVATION_REJECTED,
            event.timestamp,
            "wake-word-router",
            {"reason": reason},
        )
