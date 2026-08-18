"""Lightweight per-user clap agent and local in-process communication seams."""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Callable, Protocol, Sequence

from .interaction import EventName, InteractionEvent
from .audio_devices import default_input_device
from .windows_activation import ActivationOutcome, MicrophoneUnavailableError, WindowsActivationController


@dataclass(frozen=True, slots=True)
class MicrophoneFrame:
    samples: Sequence[float]
    sample_rate: int
    timestamp: float

    def __post_init__(self) -> None:
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if self.timestamp < 0:
            raise ValueError("timestamp must be non-negative")


class MicrophoneFrameSource(Protocol):
    def open(self) -> None: ...

    def read(self) -> MicrophoneFrame: ...

    def close(self) -> None: ...


class ClapDetector(Protocol):
    def process_samples(
        self,
        samples: Sequence[float],
        sample_rate: int,
        timestamp: float,
    ) -> InteractionEvent | None: ...


class EventSink(Protocol):
    def publish(self, event: InteractionEvent) -> None: ...


class SoundDeviceFrameSource:
    """Small 16 kHz reader that follows the Windows default input device."""

    def __init__(
        self,
        *,
        sample_rate: int = 16_000,
        block_size: int = 512,
        device: int | None = None,
        device_probe_interval: float = 1.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.sample_rate = sample_rate
        self.block_size = block_size
        self.device = device
        self.device_probe_interval = device_probe_interval
        self.clock = clock
        self._stream: object | None = None
        self._active_device: int | None = None
        self._next_device_probe = 0.0

    def open(self) -> None:
        try:
            import sounddevice as sd
            self._replace_stream(sd, self.device if self.device is not None else self._default_device(sd))
        except Exception as error:
            raise MicrophoneUnavailableError("clap microphone is unavailable") from error

    def read(self) -> MicrophoneFrame:
        if self._stream is None:
            raise MicrophoneUnavailableError("clap microphone is not open")
        try:
            self._follow_default_device()
            assert self._stream is not None
            block, _overflowed = self._stream.read(self.block_size)  # type: ignore[attr-defined]
            samples = block.reshape(-1).tolist()
            return MicrophoneFrame(samples, self.sample_rate, time.time())
        except Exception as error:
            raise MicrophoneUnavailableError("clap microphone read failed") from error

    def close(self) -> None:
        stream, self._stream = self._stream, None
        self._active_device = None
        if stream is not None:
            try:
                stream.stop()  # type: ignore[attr-defined]
                stream.close()  # type: ignore[attr-defined]
            except Exception:
                pass

    @staticmethod
    def _default_device(sounddevice: object) -> int | None:
        # Clap detection deliberately uses the normal capture/default input.
        # Bluetooth headset processing often suppresses clap transients; the
        # conversational capture separately selects the matching headset mic.
        return default_input_device(sounddevice)

    def _follow_default_device(self) -> None:
        if self.device is not None or self.clock() < self._next_device_probe:
            return
        self._next_device_probe = self.clock() + self.device_probe_interval
        import sounddevice as sd

        selected = self._default_device(sd)
        if selected != self._active_device:
            try:
                self._replace_stream(sd, selected)
            except Exception:
                # A Bluetooth profile may be briefly unavailable while Windows
                # changes output mode. Keep the working microphone and retry.
                self._next_device_probe = self.clock() + max(3.0, self.device_probe_interval)

    def _replace_stream(self, sounddevice: object, device: int | None) -> None:
        new_stream = sounddevice.InputStream(  # type: ignore[attr-defined]
            samplerate=self.sample_rate,
            blocksize=self.block_size,
            channels=1,
            dtype="float32",
            device=device,
        )
        new_stream.start()
        old_stream, self._stream = self._stream, new_stream
        self._active_device = device
        self._next_device_probe = self.clock() + self.device_probe_interval
        if old_stream is not None:
            old_stream.stop()
            old_stream.close()


@dataclass(slots=True)
class ActivationMailbox:
    """Bounded local channel between the audio loop and activation controller."""

    capacity: int = 16
    _queue: queue.Queue[InteractionEvent] = field(init=False)

    def __post_init__(self) -> None:
        if self.capacity < 1:
            raise ValueError("capacity must be positive")
        self._queue = queue.Queue(self.capacity)

    def publish(self, event: InteractionEvent) -> None:
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            # Drop the oldest activation rather than blocking the always-on
            # microphone callback or building an unbounded command backlog.
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            self._queue.put_nowait(event)

    def receive(self, timeout: float | None = None) -> InteractionEvent | None:
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None


class BackgroundAgentStatus(StrEnum):
    STOPPED = "stopped"
    READY = "ready"
    MICROPHONE_UNAVAILABLE = "microphone_unavailable"
    ERROR = "error"


@dataclass(slots=True)
class BackgroundClapAgent:
    """Run a lightweight frame detector until a local activation is emitted."""

    source_factory: Callable[[], MicrophoneFrameSource]
    detector: ClapDetector
    sink: EventSink
    clock: Callable[[], float] = time.time
    status: BackgroundAgentStatus = field(default=BackgroundAgentStatus.STOPPED, init=False)
    _source: MicrophoneFrameSource | None = field(default=None, init=False)
    _microphone_error_reported: bool = field(default=False, init=False)
    _resume_event: threading.Event = field(default_factory=threading.Event, init=False)
    _startup_event: threading.Event = field(default_factory=threading.Event, init=False)
    _startup_status: BackgroundAgentStatus | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self._resume_event.set()

    def poll_once(self) -> InteractionEvent | None:
        if not self._ensure_source():
            return None
        assert self._source is not None
        try:
            frame = self._source.read()
            event = self.detector.process_samples(frame.samples, frame.sample_rate, frame.timestamp)
            if event is not None:
                # Release the microphone before VAD/STT or authentication tries
                # to acquire it. The host resumes lightweight clap monitoring
                # only after the routed interaction completes.
                self._resume_event.clear()
                self.close()
                self.sink.publish(event)
            return event
        except MicrophoneUnavailableError:
            self._report_microphone_unavailable()
            self.close()
            self.status = BackgroundAgentStatus.MICROPHONE_UNAVAILABLE
            return None
        except Exception:
            self.status = BackgroundAgentStatus.ERROR
            self.close()
            return None

    def run(self, stop_event: threading.Event) -> None:
        try:
            while not stop_event.is_set():
                if not self._resume_event.wait(0.1):
                    continue
                if not self._ensure_source():
                    return
                self.poll_once()
                if self.status in {
                    BackgroundAgentStatus.ERROR,
                    BackgroundAgentStatus.MICROPHONE_UNAVAILABLE,
                }:
                    return
        finally:
            self.close()

    def close(self) -> None:
        source, self._source = self._source, None
        if source is not None:
            source.close()
        if self.status is BackgroundAgentStatus.READY:
            self.status = BackgroundAgentStatus.STOPPED

    @property
    def activation_pending(self) -> bool:
        return not self._resume_event.is_set()

    def resume(self) -> None:
        self._resume_event.set()

    def wait_until_started(self, timeout: float | None = None) -> BackgroundAgentStatus | None:
        """Wait for the first microphone-open result without polling mutable status."""

        if not self._startup_event.wait(timeout):
            return None
        return self._startup_status

    def _ensure_source(self) -> bool:
        if self._source is not None:
            return True
        source: MicrophoneFrameSource | None = None
        try:
            source = self.source_factory()
            source.open()
            self._source = source
            self.status = BackgroundAgentStatus.READY
            self._record_startup_status(BackgroundAgentStatus.READY)
            return True
        except Exception:
            if source is not None:
                try:
                    source.close()
                except Exception:
                    pass
            self.status = BackgroundAgentStatus.MICROPHONE_UNAVAILABLE
            self._record_startup_status(BackgroundAgentStatus.MICROPHONE_UNAVAILABLE)
            self._report_microphone_unavailable()
            return False

    def _record_startup_status(self, status: BackgroundAgentStatus) -> None:
        if self._startup_event.is_set():
            return
        self._startup_status = status
        self._startup_event.set()

    def _report_microphone_unavailable(self) -> None:
        if self._microphone_error_reported:
            return
        self._microphone_error_reported = True
        self.sink.publish(
            InteractionEvent(
                EventName.ACTIVATION_REJECTED,
                self.clock(),
                "background-clap-agent",
                {"reason": "microphone_unavailable"},
            )
        )


@dataclass(slots=True)
class ActivationDispatcher:
    mailbox: ActivationMailbox
    controller: WindowsActivationController
    on_outcome: Callable[[ActivationOutcome], None] | None = None

    def dispatch_once(self, timeout: float | None = None) -> ActivationOutcome | None:
        event = self.mailbox.receive(timeout)
        if event is None:
            return None
        if event.name not in {
            EventName.CLAP_ACTIVATION_DETECTED,
            EventName.CLAP_DOUBLE_DETECTED,
            EventName.VOICE_WAKE_DETECTED,
        }:
            return None
        outcome = self.controller.handle(event)
        if self.on_outcome:
            self.on_outcome(outcome)
        return outcome


class SessionObserverControl(Protocol):
    def start(self) -> None: ...

    def stop(self, timeout: float = 2.0) -> None: ...


@dataclass(slots=True)
class PerUserActivationHost:
    """Ordinary user-session host; it is not a service or startup entry."""

    session_observer: SessionObserverControl
    clap_agent: BackgroundClapAgent
    dispatcher: ActivationDispatcher

    def run(
        self,
        stop_event: threading.Event,
        *,
        ready_callback: Callable[[], None] | None = None,
        startup_timeout: float = 10.0,
    ) -> None:
        self.session_observer.start()
        audio_thread = threading.Thread(
            target=self.clap_agent.run,
            args=(stop_event,),
            name="UltronClapDetector",
            daemon=True,
        )
        audio_thread.start()
        try:
            startup_status = self.clap_agent.wait_until_started(startup_timeout)
            if startup_status is BackgroundAgentStatus.MICROPHONE_UNAVAILABLE:
                raise MicrophoneUnavailableError("activation microphone could not be opened")
            if startup_status is not BackgroundAgentStatus.READY:
                raise RuntimeError("activation microphone did not become ready")
            if ready_callback is not None:
                ready_callback()

            while not stop_event.is_set():
                try:
                    outcome = self.dispatcher.dispatch_once(timeout=0.1)
                finally:
                    if self.clap_agent.activation_pending:
                        self.clap_agent.resume()
                if not audio_thread.is_alive():
                    if self.clap_agent.status is BackgroundAgentStatus.MICROPHONE_UNAVAILABLE:
                        raise MicrophoneUnavailableError("activation microphone became unavailable")
                    raise RuntimeError("activation audio detector stopped unexpectedly")
        finally:
            stop_event.set()
            self.clap_agent.close()
            detector_reset = getattr(self.clap_agent.detector, "reset", None)
            if detector_reset is not None:
                try:
                    detector_reset()
                except Exception:
                    pass
            audio_thread.join(2.0)
            self.session_observer.stop()
