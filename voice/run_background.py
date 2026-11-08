"""Run Ultron's ordinary per-user local activation host.

This command creates no service, scheduled task, registry entry, startup
shortcut, or Windows credential provider. It must be started explicitly.
"""

from __future__ import annotations

import argparse
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .adapters import LocalHudEventAdapter, is_hud_safe_event
from .activation_control import activation_enabled
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
from .local_conversation_audio import FasterWhisperSmallAdapter, KokoroMichaelAdapter, default_voice_model_root
from .local_endpoint import load_project_env
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
            if self.last_error is not None:
                print("ultron.hud.event_delivery recovered=true", flush=True)
            self.last_error = None
        except Exception as error:
            if self.last_error is None:
                print(f"ultron.hud.event_delivery failure={type(error).__name__}", flush=True)
            self.last_error = error


@dataclass(frozen=True, slots=True)
class FanoutEventSink:
    sinks: tuple[EventSink, ...]

    def publish(self, event: InteractionEvent) -> None:
        for sink in self.sinks:
            sink.publish(event)


def publish_outcome(outcome: ActivationOutcome, hud: BestEffortHudSink) -> None:
    method = "wake_word" if outcome.routed_event.source == "wake-word-router" else "clap"
    print(
        f"ultron.voice.activation method={method} listening_started={outcome.listening_started} "
        f"hud_ready={outcome.hud.ready if outcome.hud else False} "
        f"foreground={outcome.hud.foreground_acquired if outcome.hud else False} "
        f"visibility_fallback={outcome.hud.fallback_used if outcome.hud else False}",
        flush=True,
    )
    if outcome.failure_reason:
        print(f"ultron.voice.activation failure={outcome.failure_reason}", flush=True)
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
    clap_count: int = 2,
    listen_after_open: bool = True,
) -> PerUserActivationHost:
    if len(hud_token) < 32:
        raise ValueError("ULTRON_LOCAL_EVENT_TOKEN must contain at least 32 characters")

    follow_up_value = os.environ.get("ULTRON_VOICE_FOLLOW_UP_TURNS", "3")
    try:
        follow_up_turns = int(follow_up_value)
    except ValueError as error:
        raise ValueError("ULTRON_VOICE_FOLLOW_UP_TURNS must be an integer from 0 to 5") from error
    if not 0 <= follow_up_turns <= 5:
        raise ValueError("ULTRON_VOICE_FOLLOW_UP_TURNS must be an integer from 0 to 5")
    stt_model = os.environ.get("ULTRON_VOICE_STT_MODEL", "small").strip().lower()
    if stt_model not in {"base", "small"}:
        raise ValueError("ULTRON_VOICE_STT_MODEL must be base or small")
    stt_device = os.environ.get("ULTRON_VOICE_STT_DEVICE", "auto").strip().lower()
    if stt_device not in {"auto", "cpu", "cuda"}:
        raise ValueError("ULTRON_VOICE_STT_DEVICE must be auto, cpu, or cuda")

    tts_gate = TtsPlaybackGate(post_playback_ms=650)
    hud = BestEffortHudSink(LocalHudEventAdapter(token=hud_token))
    mailbox = ActivationMailbox()
    activation_sink = FanoutEventSink((mailbox, hud))
    clap = DoubleClapDetector(ClapConfig(required_claps=clap_count), tts_gate=tts_gate)
    model_root = default_voice_model_root().expanduser().resolve()
    shared_stt = FasterWhisperSmallAdapter(
        model_root=model_root, model_size=stt_model, device=stt_device,
    )
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
        activation_enabled=activation_enabled,
    )

    session_observer = WindowsSessionObserver()
    def take_pending_wake_transcript(timestamp: float) -> str | None:
        transcript = wake_worker.take_pending_transcript(timestamp)
        print(f"ultron.voice.handoff preheard={bool(transcript)}", flush=True)
        return transcript

    pipeline = build_local_conversation_pipeline(
        event_sink=hud,
        tts_gate=tts_gate,
        hud_token=hud_token,
        microphone_device=microphone_device,
        output_device=output_device,
        stt=shared_stt,
        conversation_allowed=lambda: activation_enabled() and session_observer.current_state() is SessionState.UNLOCKED,
        timing_reporter=lambda stage, duration_ms: print(
            f"ultron.voice.stage stage={stage} duration_ms={duration_ms}",
            flush=True,
        ),
    )

    def create_listening_session() -> DoubleClapListeningSession:
        return DoubleClapListeningSession(
            pipeline,
            max_follow_ups=follow_up_turns,
            pending_wake_transcript=take_pending_wake_transcript,
        )

    def warmup_tts() -> None:
        # Model loading is local and has no microphone or speaker side effects.
        # Failure is reported safely; the normal speech path can retry later.
        started = time.perf_counter()
        try:
            if activation_enabled() and isinstance(pipeline.tts, KokoroMichaelAdapter):
                pipeline.tts.prewarm()
                print(f"ultron.voice.stage stage=tts_warmup duration_ms={round((time.perf_counter() - started) * 1000)}", flush=True)
        except Exception as error:
            print(f"ultron.voice.stage stage=tts_warmup failure={type(error).__name__}", flush=True)

    def create_authentication_workflow():
        return build_locked_authentication_workflow(
            speaker_name=speaker_name,
            event_sink=hud,
            microphone_device=microphone_device,
            output_device=output_device,
            tts_gate=tts_gate,
            stt=FasterWhisperSmallAdapter(model_root=model_root, model_size="small"),
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
        activation_enabled=activation_enabled,
    )
    return PerUserActivationHost(session_observer, clap_agent, dispatcher, warmup=warmup_tts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--speaker-name")
    parser.add_argument("--microphone-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--clap-count", type=int, choices=(1, 2), default=2)
    parser.add_argument("--open-only", action="store_true", help="Open the HUD without entering listening")
    parser.add_argument("--ready-file", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    load_project_env(Path(__file__).resolve().parents[1] / ".env.local")
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
