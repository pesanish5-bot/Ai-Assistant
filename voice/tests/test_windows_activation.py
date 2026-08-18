from __future__ import annotations

import threading
import unittest
from dataclasses import dataclass
from pathlib import Path

from voice.authentication import AuthenticationDecision, AuthenticationState
from voice.background_agent import (
    ActivationDispatcher,
    ActivationMailbox,
    BackgroundAgentStatus,
    BackgroundClapAgent,
    MicrophoneFrame,
    PerUserActivationHost,
)
from voice.interaction import EventName, InteractionEvent, SessionState
from voice.windows_activation import (
    DeferredListeningController,
    ListeningPipelineError,
    MicrophoneUnavailableError,
    WindowsActivationController,
)
from voice.windows_hud import (
    EdgeAppHudController,
    HudOpenResult,
    Win32WindowController,
)
from voice.windows_session import (
    WindowsSessionObserver,
    state_from_session_flags,
    state_from_wts_change,
)


class FixedSessionState:
    def __init__(self, state: SessionState) -> None:
        self.state = state

    def current_state(self) -> SessionState:
        return self.state


class FakeHud:
    def __init__(self, ready: bool = True) -> None:
        self.calls = 0
        self.ready = ready

    def open_or_focus(self) -> HudOpenResult:
        self.calls += 1
        return HudOpenResult(self.ready, False, True, True, False, hwnd=22)


class FakeListeningSession:
    def __init__(self) -> None:
        self.calls = 0

    def start(self, timestamp: float) -> InteractionEvent:
        self.calls += 1
        return InteractionEvent(EventName.VOICE_LISTENING, timestamp, "fake-listener")


class FakeAuthentication:
    def __init__(self) -> None:
        self.calls = 0

    def start(
        self,
        timestamp: float,
        *,
        activation_method: str,
        session_state: SessionState,
    ) -> AuthenticationDecision:
        self.calls += 1
        return AuthenticationDecision(
            AuthenticationState.IDENTIFYING,
            "Identify yourself.",
            InteractionEvent(EventName.AUTH_STARTED, timestamp, "fake-auth"),
        )


def clap_event(timestamp: float = 10.0) -> InteractionEvent:
    return InteractionEvent(EventName.CLAP_DOUBLE_DETECTED, timestamp, "test")


class SessionObserverTests(unittest.TestCase):
    def test_wts_flags_and_notifications_are_explicit(self) -> None:
        self.assertEqual(
            state_from_session_flags(0, windows_version=(10, 0)),
            SessionState.LOCKED,
        )
        self.assertEqual(
            state_from_session_flags(1, windows_version=(10, 0)),
            SessionState.UNLOCKED,
        )
        self.assertEqual(
            state_from_session_flags(0, windows_version=(6, 1)),
            SessionState.UNLOCKED,
        )
        self.assertEqual(state_from_wts_change(0x7), SessionState.LOCKED)
        self.assertEqual(state_from_wts_change(0x8), SessionState.UNLOCKED)
        self.assertIsNone(state_from_wts_change(0x3))

    def test_observer_seeds_from_query_and_receives_notifications(self) -> None:
        changed = threading.Event()

        class Backend:
            state = SessionState.UNLOCKED

            def query_current_state(self) -> SessionState:
                return self.state

            def watch(self, on_state, stop_event: threading.Event) -> None:
                self.state = SessionState.LOCKED
                on_state(SessionState.LOCKED)
                changed.set()
                stop_event.wait(0.2)

        observer = WindowsSessionObserver(Backend())
        observer.start()
        self.assertTrue(changed.wait(1.0))
        self.assertEqual(observer.current_state(), SessionState.LOCKED)
        observer.stop()

    def test_authoritative_query_replaces_stale_cached_state_and_fails_closed(self) -> None:
        class Backend:
            state = SessionState.UNLOCKED
            fail = False

            def query_current_state(self) -> SessionState:
                if self.fail:
                    raise OSError("WTS unavailable")
                return self.state

            def watch(self, on_state, stop_event: threading.Event) -> None:
                stop_event.wait(0.2)

        backend = Backend()
        observer = WindowsSessionObserver(backend)
        observer.start()
        backend.state = SessionState.LOCKED
        self.assertEqual(observer.current_state(), SessionState.LOCKED)
        backend.fail = True
        self.assertEqual(observer.current_state(), SessionState.UNKNOWN)
        observer.stop()


class ActivationRoutingTests(unittest.TestCase):
    def test_lock_transition_after_hud_open_prevents_listening(self) -> None:
        class ChangingState:
            states = iter([SessionState.UNLOCKED, SessionState.LOCKED])

            def current_state(self):
                return next(self.states)

        listener = FakeListeningSession()
        controller = WindowsActivationController(
            ChangingState(),
            FakeHud(),
            DeferredListeningController(lambda: listener),
            FakeAuthentication(),
        )
        outcome = controller.handle(clap_event())
        self.assertEqual(outcome.failure_reason, "session_state_changed")
        self.assertEqual(listener.calls, 0)

    def test_authentication_setup_failure_is_contained(self) -> None:
        class BrokenAuthentication:
            def start(self, *args, **kwargs):
                raise OSError("profile unavailable")

        controller = WindowsActivationController(
            FixedSessionState(SessionState.LOCKED),
            FakeHud(),
            DeferredListeningController(lambda: FakeListeningSession()),
            BrokenAuthentication(),
        )
        outcome = controller.handle(clap_event())
        self.assertEqual(outcome.failure_reason, "authentication_unavailable")
        self.assertEqual(outcome.emitted_events[-1].name, EventName.AUTH_FAILED)

    def test_unlocked_opens_hud_and_only_then_loads_listening_pipeline(self) -> None:
        loads = 0
        listening = FakeListeningSession()

        def load_voice() -> FakeListeningSession:
            nonlocal loads
            loads += 1
            return listening

        deferred = DeferredListeningController(load_voice)
        hud = FakeHud()
        auth = FakeAuthentication()
        controller = WindowsActivationController(
            FixedSessionState(SessionState.UNLOCKED), hud, deferred, auth
        )
        self.assertEqual(loads, 0)
        outcome = controller.handle(clap_event())
        self.assertEqual(hud.calls, 1)
        self.assertTrue(outcome.listening_started)
        self.assertEqual(loads, 1)
        self.assertEqual(listening.calls, 1)
        self.assertEqual(auth.calls, 0)

    def test_locked_starts_fail_closed_auth_without_hud_or_voice_pipeline(self) -> None:
        loads = 0

        def load_voice() -> FakeListeningSession:
            nonlocal loads
            loads += 1
            return FakeListeningSession()

        hud = FakeHud()
        auth = FakeAuthentication()
        controller = WindowsActivationController(
            FixedSessionState(SessionState.LOCKED),
            hud,
            DeferredListeningController(load_voice),
            auth,
        )
        outcome = controller.handle(clap_event())
        self.assertEqual(hud.calls, 0)
        self.assertEqual(loads, 0)
        self.assertEqual(auth.calls, 1)
        self.assertIsNotNone(outcome.authentication)
        assert outcome.authentication is not None
        self.assertFalse(outcome.authentication.allows_os_unlock)

    def test_microphone_unavailable_keeps_hud_open_and_degrades_gracefully(self) -> None:
        def unavailable():
            raise MicrophoneUnavailableError("no microphone")

        controller = WindowsActivationController(
            FixedSessionState(SessionState.UNLOCKED),
            FakeHud(),
            DeferredListeningController(unavailable),
            FakeAuthentication(),
        )
        outcome = controller.handle(clap_event())
        self.assertIsNotNone(outcome.hud)
        assert outcome.hud is not None
        self.assertTrue(outcome.hud.ready)
        self.assertFalse(outcome.listening_started)
        self.assertEqual(outcome.failure_reason, "microphone_unavailable")
        self.assertEqual(outcome.emitted_events[-1].name, EventName.ACTIVATION_REJECTED)

    def test_voice_pipeline_failure_is_not_misreported_as_microphone_failure(self) -> None:
        class BrokenPipeline:
            def start(self, timestamp: float):
                raise ListeningPipelineError("core unavailable")

        controller = WindowsActivationController(
            FixedSessionState(SessionState.UNLOCKED),
            FakeHud(),
            DeferredListeningController(lambda: BrokenPipeline()),
            FakeAuthentication(),
        )
        outcome = controller.handle(clap_event())
        self.assertEqual(outcome.failure_reason, "voice_pipeline_unavailable")
        self.assertEqual(outcome.emitted_events[-1].payload["reason"], "voice_pipeline_unavailable")


@dataclass
class FakeProcess:
    pid: int = 101
    return_code: int | None = None

    def poll(self) -> int | None:
        return self.return_code


class FakeLauncher:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.process = FakeProcess()

    def launch(self, command) -> FakeProcess:
        self.calls.append(list(command))
        return self.process


class FakeWindows:
    def __init__(self) -> None:
        self.hwnd: int | None = None
        self.activations = 0

    def find_window(self, process_id: int | None, title_hint: str) -> int | None:
        return self.hwnd

    def activate(self, hwnd: int):
        from voice.windows_hud import WindowActivationResult

        self.activations += 1
        return WindowActivationResult(hwnd, True, False)


class HudControllerTests(unittest.TestCase):
    def test_wrong_title_from_launched_pid_is_not_treated_as_ready(self) -> None:
        launcher = FakeLauncher()

        class TitleAwareWindows(FakeWindows):
            def __init__(self) -> None:
                super().__init__()
                self.searches = 0

            def find_window(self, process_id: int | None, title_hint: str) -> int | None:
                self.searches += 1
                # Model the Win32 adapter contract: an unrelated Edge window
                # sharing the launched PID is not returned for Ultron's title.
                return None

        windows = TitleAwareWindows()
        controller = EdgeAppHudController(
            edge_executable=Path("C:/fake/msedge.exe"),
            launcher=launcher,
            windows=windows,
            window_attempts=1,
            retry_interval_seconds=0,
        )
        result = controller.open_or_focus()
        self.assertFalse(result.ready)
        self.assertEqual(windows.activations, 0)

    def test_live_edge_process_without_window_is_relaunched(self) -> None:
        launcher = FakeLauncher()
        windows = FakeWindows()
        controller = EdgeAppHudController(
            edge_executable=Path("C:/fake/msedge.exe"),
            launcher=launcher,
            windows=windows,
            window_attempts=1,
            retry_interval_seconds=0,
        )
        controller._process = FakeProcess(pid=77)
        searches = 0

        def find_after_relaunch(process_id, title_hint):
            nonlocal searches
            searches += 1
            return 99 if process_id == 101 else None

        windows.find_window = find_after_relaunch
        result = controller.open_or_focus()
        self.assertTrue(result.ready)
        self.assertTrue(result.launched)
        self.assertEqual(len(launcher.calls), 1)

    def test_warm_hud_process_is_reused(self) -> None:
        launcher = FakeLauncher()
        windows = FakeWindows()
        cold = EdgeAppHudController(
            edge_executable=Path("C:/fake/msedge.exe"),
            launcher=launcher,
            windows=windows,
            window_attempts=1,
            retry_interval_seconds=0,
        )
        original_find = windows.find_window
        searches = 0

        def find_after_launch(process_id, title_hint):
            nonlocal searches
            searches += 1
            return 66 if process_id == 101 else None

        windows.find_window = find_after_launch
        launched = cold.open_or_focus()
        reused = cold.open_or_focus()
        windows.find_window = original_find
        self.assertTrue(launched.launched)
        self.assertTrue(reused.reused)
        self.assertEqual(len(launcher.calls), 1)
        self.assertEqual(searches, 3)
        self.assertEqual(windows.activations, 2)

    def test_foreground_denial_uses_non_input_topmost_fallback(self) -> None:
        class Api:
            def __init__(self) -> None:
                self.positions: list[int] = []

            def find_window(self, process_id, title_hint):
                return 88

            def show_window(self, hwnd, command):
                return None

            def set_window_position(self, hwnd, insert_after, flags):
                self.positions.append(insert_after)
                return True

            def set_foreground_window(self, hwnd):
                return False

        api = Api()
        scheduled: list[tuple[float, object]] = []
        result = Win32WindowController(
            api,
            fallback_hold_seconds=5.0,
            demotion_scheduler=lambda delay, callback: scheduled.append((delay, callback)),
        ).activate(88)
        self.assertFalse(result.foreground_acquired)
        self.assertTrue(result.fallback_used)
        self.assertEqual(api.positions, [0, -1])
        self.assertEqual(scheduled[0][0], 5.0)
        scheduled[0][1]()
        self.assertEqual(api.positions, [0, -1, -2])


class BackgroundCommunicationTests(unittest.TestCase):
    def test_startup_readiness_waits_for_microphone_open(self) -> None:
        opening = threading.Event()
        release = threading.Event()
        stop = threading.Event()

        class Source:
            def open(self):
                opening.set()
                release.wait(1.0)

            def read(self):
                stop.wait(1.0)
                return MicrophoneFrame([0.0] * 8, 16_000, 4.0)

            def close(self):
                return None

        class Detector:
            def process_samples(self, samples, sample_rate, timestamp):
                return None

        agent = BackgroundClapAgent(Source, Detector(), ActivationMailbox())
        thread = threading.Thread(target=agent.run, args=(stop,), daemon=True)
        thread.start()
        self.assertTrue(opening.wait(1.0))
        self.assertIsNone(agent.wait_until_started(0.01))
        release.set()
        self.assertEqual(agent.wait_until_started(1.0), BackgroundAgentStatus.READY)
        stop.set()
        thread.join(1.0)

    def test_host_ready_callback_runs_after_observer_and_microphone(self) -> None:
        stop = threading.Event()
        observed: list[str] = []

        class Observer:
            def start(self):
                observed.append("observer")

            def stop(self, timeout=2.0):
                observed.append("observer-stopped")

        class Source:
            def open(self):
                observed.append("microphone")

            def read(self):
                stop.wait(1.0)
                return MicrophoneFrame([0.0] * 8, 16_000, 4.0)

            def close(self):
                return None

        class Detector:
            def process_samples(self, samples, sample_rate, timestamp):
                return None

        class Dispatcher:
            def dispatch_once(self, timeout=None):
                stop.wait(timeout or 0)
                return None

        agent = BackgroundClapAgent(Source, Detector(), ActivationMailbox())
        host = PerUserActivationHost(Observer(), agent, Dispatcher())

        def ready() -> None:
            observed.append("ready")
            stop.set()

        host.run(stop, ready_callback=ready, startup_timeout=1.0)
        self.assertEqual(observed[:3], ["observer", "microphone", "ready"])
        self.assertEqual(observed[-1], "observer-stopped")

    def test_host_raises_when_microphone_never_opens(self) -> None:
        class Observer:
            stopped = False

            def start(self):
                return None

            def stop(self, timeout=2.0):
                self.stopped = True

        class Detector:
            def process_samples(self, samples, sample_rate, timestamp):
                return None

        observer = Observer()
        agent = BackgroundClapAgent(
            lambda: (_ for _ in ()).throw(MicrophoneUnavailableError("missing")),
            Detector(),
            ActivationMailbox(),
        )

        class Dispatcher:
            def dispatch_once(self, timeout=None):
                return None

        host = PerUserActivationHost(observer, agent, Dispatcher())
        with self.assertRaises(MicrophoneUnavailableError):
            host.run(threading.Event(), startup_timeout=1.0)
        self.assertTrue(observer.stopped)

    def test_microphone_is_closed_before_activation_is_published(self) -> None:
        class Source:
            closed = False

            def open(self):
                return None

            def read(self):
                return MicrophoneFrame([0.0] * 8, 16_000, 4.0)

            def close(self):
                self.closed = True

        source = Source()

        class Detector:
            def process_samples(self, samples, sample_rate, timestamp):
                return clap_event(timestamp)

        class Sink:
            def publish(self, event):
                self.closed_at_publish = source.closed

        sink = Sink()
        agent = BackgroundClapAgent(lambda: source, Detector(), sink)
        agent.poll_once()
        self.assertTrue(sink.closed_at_publish)

    def test_microphone_open_failure_is_reported_once(self) -> None:
        mailbox = ActivationMailbox()

        def unavailable_source():
            raise MicrophoneUnavailableError("missing microphone")

        class Detector:
            def process_samples(self, samples, sample_rate, timestamp):
                raise AssertionError("detector must not run")

        agent = BackgroundClapAgent(unavailable_source, Detector(), mailbox, clock=lambda: 3.0)
        self.assertIsNone(agent.poll_once())
        self.assertIsNone(agent.poll_once())
        self.assertEqual(agent.status, BackgroundAgentStatus.MICROPHONE_UNAVAILABLE)
        event = mailbox.receive(0)
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event.payload["reason"], "microphone_unavailable")
        self.assertIsNone(mailbox.receive(0))

    def test_clap_crosses_mailbox_and_dispatches_to_one_controller(self) -> None:
        mailbox = ActivationMailbox()

        class Source:
            def open(self):
                return None

            def read(self):
                return MicrophoneFrame([0.0] * 8, 16_000, 4.0)

            def close(self):
                return None

        class Detector:
            def process_samples(self, samples, sample_rate, timestamp):
                return clap_event(timestamp)

        listener = FakeListeningSession()
        controller = WindowsActivationController(
            FixedSessionState(SessionState.UNLOCKED),
            FakeHud(),
            DeferredListeningController(lambda: listener),
            FakeAuthentication(),
        )
        agent = BackgroundClapAgent(Source, Detector(), mailbox)
        dispatcher = ActivationDispatcher(mailbox, controller)
        self.assertIsNotNone(agent.poll_once())
        self.assertTrue(agent.activation_pending)
        outcome = dispatcher.dispatch_once(0)
        self.assertIsNotNone(outcome)
        assert outcome is not None
        self.assertTrue(outcome.listening_started)
        self.assertEqual(listener.calls, 1)
        agent.resume()
        self.assertFalse(agent.activation_pending)
        agent.close()


if __name__ == "__main__":
    unittest.main()
