"""Run Ultron's ordinary per-user local activation host.

This command creates no service, scheduled task, registry entry, startup
shortcut, or Windows credential provider. It must be started explicitly.
"""

from __future__ import annotations

import argparse
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .adapters import LocalHudEventAdapter, is_hud_safe_event
from .background_agent import (
    ActivationDispatcher,
    ActivationMailbox,
    BackgroundClapAgent,
    PerUserActivationHost,
    SoundDeviceFrameSource,
)
from .clap import ClapConfig, DoubleClapDetector
from .conversation import DoubleClapListeningSession, build_local_conversation_pipeline
from .interaction import EventName, InteractionEvent, SessionState, TtsPlaybackGate
from .locked_auth_workflow import build_locked_authentication_workflow
from .local_conversation_audio import FasterWhisperSmallAdapter, default_voice_model_root
from .wake_word import (
    BoundedWakeTranscriber,
    CompositeActivationDetector,
    SherpaSileroFrameVad,
)
from .windows_activation import (
    ActivationOutcome,
    DeferredAuthenticationStarter,
    DeferredListeningController,
    WindowsActivationController,
)
from .windows_hud import EdgeAppHudController
from .windows_session import WindowsSessionObserver


class EventSink(Protocol):
    def publish(self, event: InteractionEvent) -> None: ...


@dataclass(slots=True)
class BestEffortHudSink:
    """Keep local activation working when the browser bridge is temporarily down."""

    adapter: LocalHudEventAdapter
    last_error: Exception | None = field(default=None, init=False)

    def publish(self, event: InteractionEvent) -> None:
        if not is_hud_safe_event(event):
            return
        try:
            self.adapter.publish(event)
            self.last_error = None
        except Exception as error:
            self.last_error = error


@dataclass(frozen=True, slots=True)
class FanoutEventSink:
    sinks: tuple[EventSink, ...]

    def publish(self, event: InteractionEvent) -> None:
        for sink in self.sinks:
            sink.publish(event)


def publish_outcome(outcome: ActivationOutcome, hud: BestEffortHudSink) -> None:
    for event in outcome.emitted_events:
        if event.name is EventName.AUTH_THROTTLED:
            hud.publish(
                InteractionEvent(
                    EventName.AUTH_FAILED,
                    event.timestamp,
                    "authentication-prototype",
                    {"reason": "throttled"},
                )
            )
        else:
            hud.publish(event)


def write_ready_marker(path: Path) -> None:
    """Atomically signal launcher readiness without storing credentials."""

    path = path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as marker:
            marker.write("ready\n")
            marker.flush()
            os.fsync(marker.fileno())
        temporary.rename(path)
    finally:
        temporary.unlink(missing_ok=True)


def build_activation_host(
    *,
    hud_token: str,
    speaker_name: str | None = None,
    microphone_device: int | None = None,
    output_device: int | None = None,
    clap_count: int = 1,
    listen_after_open: bool = True,
) -> PerUserActivationHost:
    if len(hud_token) < 32:
        raise ValueError("ULTRON_LOCAL_EVENT_TOKEN must contain at least 32 characters")

    tts_gate = TtsPlaybackGate(post_playback_ms=650)
    hud = BestEffortHudSink(LocalHudEventAdapter(token=hud_token))
    mailbox = ActivationMailbox()
    activation_sink = FanoutEventSink((mailbox, hud))
    clap = DoubleClapDetector(ClapConfig(required_claps=clap_count), tts_gate=tts_gate)
    model_root = default_voice_model_root().expanduser().resolve()
    shared_stt = FasterWhisperSmallAdapter(model_root=model_root)
    wake_worker = BoundedWakeTranscriber(
        shared_stt,
    )
    activation_detector = CompositeActivationDetector(
        clap=clap,
        wake_vad=SherpaSileroFrameVad(
            model_root / "sherpa-onnx" / "silero_vad.onnx",
        ),
        wake_worker=wake_worker,
        tts_gate=tts_gate,
    )
    clap_agent = BackgroundClapAgent(
        lambda: SoundDeviceFrameSource(device=microphone_device),
        activation_detector,
        activation_sink,
    )

    session_observer = WindowsSessionObserver()
    def create_listening_session() -> DoubleClapListeningSession:
        pipeline = build_local_conversation_pipeline(
            event_sink=hud,
            tts_gate=tts_gate,
            hud_token=hud_token,
            microphone_device=microphone_device,
            output_device=output_device,
            stt=shared_stt,
            conversation_allowed=lambda: session_observer.current_state() is SessionState.UNLOCKED,
        )
        return DoubleClapListeningSession(pipeline)

    def create_authentication_workflow():
        return build_locked_authentication_workflow(
            speaker_name=speaker_name,
            event_sink=hud,
            microphone_device=microphone_device,
            output_device=output_device,
            tts_gate=tts_gate,
            stt=shared_stt,
            session_guard=lambda: session_observer.current_state() is SessionState.LOCKED,
        )

    controller = WindowsActivationController(
        session_observer,
        EdgeAppHudController(),
        DeferredListeningController(create_listening_session),
        DeferredAuthenticationStarter(create_authentication_workflow),
    )
    controller.router.listen_after_open = listen_after_open
    dispatcher = ActivationDispatcher(
        mailbox,
        controller,
        on_outcome=lambda outcome: publish_outcome(outcome, hud),
    )
    return PerUserActivationHost(session_observer, clap_agent, dispatcher)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--speaker-name")
    parser.add_argument("--microphone-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--clap-count", type=int, choices=(1, 2), default=1)
    parser.add_argument("--open-only", action="store_true", help="Open the HUD without entering listening")
    parser.add_argument("--ready-file", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    token = os.environ.get("ULTRON_LOCAL_EVENT_TOKEN", "")
    if len(token) < 32:
        print("Ultron activation refused: set an ephemeral ULTRON_LOCAL_EVENT_TOKEN (32+ characters).")
        return 2

    speaker_name = args.speaker_name or os.environ.get("ULTRON_SPEAKER_NAME")
    ready_value = args.ready_file or os.environ.get("ULTRON_ACTIVATION_READY_FILE")
    ready_file = Path(ready_value) if ready_value else None
    try:
        host = build_activation_host(
            hud_token=token,
            speaker_name=speaker_name,
            microphone_device=args.microphone_device,
            output_device=args.output_device,
            clap_count=args.clap_count,
            listen_after_open=not args.open_only,
        )
    except Exception as error:
        print(f"Ultron activation initialization failed: {type(error).__name__}.")
        return 1
    stop = threading.Event()
    print("UltronActivationHost is running for this user session.")
    print("Responsibilities: local clap detection, WTS lock state, HUD activation, and on-demand local voice.")
    print("No Windows startup entry or unlock credential provider has been registered. Press Ctrl+C to stop.")
    try:
        host.run(
            stop,
            ready_callback=(lambda: write_ready_marker(ready_file)) if ready_file else None,
        )
    except KeyboardInterrupt:
        stop.set()
        return 0
    except Exception as error:
        print(f"Ultron activation stopped: {type(error).__name__}.")
        return 1
    print("Ultron activation stopped unexpectedly.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
