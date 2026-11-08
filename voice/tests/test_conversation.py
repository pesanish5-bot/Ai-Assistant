from __future__ import annotations

import unittest
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from voice.conversation import (
    ConversationMode,
    DoubleClapListeningSession,
    LocalConversationalVoicePipeline,
    UtteranceTimeoutError,
    VoiceMicrophoneError,
    VoicePipelineError,
    VoicePipelineStage,
    WakeWordParser,
)
from voice.interaction import EventName, InteractionEvent, TtsPlaybackGate
from voice.local_conversation_audio import FasterWhisperSmallAdapter, KokoroMichaelAdapter, MICHAEL_SPEAKER_ID


class StepClock:
    def __init__(self) -> None:
        self.value = 1.0

    def __call__(self) -> float:
        current = self.value
        self.value += 0.1
        return current


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[InteractionEvent] = []

    def publish(self, event: InteractionEvent) -> None:
        self.events.append(event)


class FakeCapture:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.paths: list[Path] = []
        self.timeouts: list[float | None] = []

    def capture(self, destination: Path, *, timeout_seconds: float | None = None) -> None:
        self.paths.append(destination)
        self.timeouts.append(timeout_seconds)
        if self.error:
            raise self.error
        destination.write_bytes(b"temporary conversational audio")


class QueueStt:
    def __init__(self, *transcripts: str, error: Exception | None = None) -> None:
        self.transcripts = list(transcripts)
        self.error = error
        self.paths: list[Path] = []

    def transcribe(self, audio_path: Path) -> str:
        self.paths.append(audio_path)
        if not audio_path.is_file():
            raise AssertionError("temporary WAV must exist during transcription")
        if self.error:
            raise self.error
        return self.transcripts.pop(0)


class FakeCore:
    def __init__(self, response: str = "Here is your plan.", error: Exception | None = None) -> None:
        self.response = response
        self.error = error
        self.messages: list[str] = []

    def execute(self, message: str) -> str:
        self.messages.append(message)
        if self.error:
            raise self.error
        return self.response


class FakeTts:
    def __init__(self, gate: TtsPlaybackGate, error: Exception | None = None) -> None:
        self.gate = gate
        self.error = error
        self.messages: list[str] = []
        self.was_gated: list[bool] = []

    def speak(self, text: str) -> None:
        self.messages.append(text)
        self.was_gated.append(self.gate.is_suppressed(0.0))
        if self.error:
            raise self.error


def make_pipeline(
    *,
    capture: FakeCapture,
    stt: QueueStt,
    core: FakeCore,
    tts_error: Exception | None = None,
    conversation_allowed=None,
) -> tuple[LocalConversationalVoicePipeline, RecordingSink, FakeTts, TtsPlaybackGate]:
    sink = RecordingSink()
    gate = TtsPlaybackGate(post_playback_ms=0)
    tts = FakeTts(gate, tts_error)
    pipeline = LocalConversationalVoicePipeline(
        capture=capture,
        stt=stt,
        core=core,
        tts=tts,
        events=sink,
        tts_gate=gate,
        conversation_allowed=conversation_allowed,
        clock=StepClock(),
    )
    return pipeline, sink, tts, gate


class ConversationalVoiceTests(unittest.TestCase):
    def test_kokoro_prewarm_and_speech_share_one_model_load(self) -> None:
        adapter = KokoroMichaelAdapter(model_directory=Path("."))
        loaded = object()
        loads: list[int] = []
        errors: list[Exception] = []

        def fake_load(_sherpa: object) -> object:
            if adapter._tts is None:
                loads.append(1)
                time.sleep(0.03)
                adapter._tts = loaded
            return adapter._tts

        sherpa = SimpleNamespace(GenerationConfig=lambda: SimpleNamespace())
        with (
            patch.dict("sys.modules", {"sherpa_onnx": sherpa, "sounddevice": SimpleNamespace()}),
            patch.object(adapter, "_load_tts", side_effect=fake_load),
            patch.object(adapter, "_stream_generated_audio") as stream,
        ):
            def prewarm() -> None:
                try:
                    adapter.prewarm()
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(target=prewarm)
            worker.start()
            adapter.speak("Hello.")
            worker.join(1)

        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(loads), 1)
        self.assertIs(adapter._tts, loaded)
        stream.assert_called_once()

    def test_speech_model_choice_is_explicit_and_bounded(self) -> None:
        self.assertEqual(FasterWhisperSmallAdapter(model_root=Path("."), model_size="base").model_size, "base")
        self.assertEqual(FasterWhisperSmallAdapter(model_root=Path(".")).model_size, "small")
        with self.assertRaises(ValueError):
            FasterWhisperSmallAdapter(model_root=Path("."), model_size="tiny")
        with self.assertRaises(ValueError):
            FasterWhisperSmallAdapter(model_root=Path("."), device="invalid")

    def test_cuda_inference_failure_falls_back_to_cpu_once(self) -> None:
        class BrokenGpu:
            def transcribe(self, *_args, **_kwargs):
                raise RuntimeError("GPU driver failed")

        class WorkingCpu:
            def transcribe(self, *_args, **_kwargs):
                return [SimpleNamespace(text="How are you?", no_speech_prob=0.1, avg_logprob=-0.2)], None

        adapter = FasterWhisperSmallAdapter(model_root=Path("."))
        gpu, cpu = BrokenGpu(), WorkingCpu()
        adapter._active_device = "cuda"
        with patch.object(adapter, "_load_model", side_effect=[gpu, cpu]):
            self.assertEqual(adapter.transcribe(Path("unused.wav")), "How are you?")
        self.assertTrue(adapter._gpu_unavailable)

    def test_forced_cuda_failure_does_not_silently_change_device(self) -> None:
        class BrokenGpu:
            def transcribe(self, *_args, **_kwargs):
                raise RuntimeError("GPU driver failed")

        adapter = FasterWhisperSmallAdapter(model_root=Path("."), device="cuda")
        adapter._active_device = "cuda"
        with patch.object(adapter, "_load_model", return_value=BrokenGpu()):
            with self.assertRaises(VoicePipelineError):
                adapter.transcribe(Path("unused.wav"))
        self.assertFalse(adapter._gpu_unavailable)

    def test_activation_allows_bounded_follow_up_without_repeating_wake_word(self) -> None:
        class FollowUpCapture(FakeCapture):
            def capture(self, destination: Path, *, timeout_seconds: float | None = None) -> None:
                if len(self.paths) == 2:
                    self.paths.append(destination)
                    self.timeouts.append(timeout_seconds)
                    raise UtteranceTimeoutError("no follow-up speech")
                super().capture(destination, timeout_seconds=timeout_seconds)

        capture = FollowUpCapture()
        core = FakeCore()
        pipeline, _sink, tts, _gate = make_pipeline(
            capture=capture,
            stt=QueueStt("Hello Ultron", "And what next?"),
            core=core,
        )
        delays: list[float] = []
        session = DoubleClapListeningSession(
            pipeline, max_follow_ups=3, follow_up_timeout_seconds=7.0,
            sleeper=delays.append,
        )
        session.start(1.0)

        self.assertEqual(core.messages, ["Hello Ultron", "And what next?"])
        self.assertEqual(len(tts.messages), 2)
        self.assertEqual(capture.timeouts, [None, 7.0, 7.0])
        self.assertEqual(delays, [0.0, 0.0])

    def test_full_wake_phrase_skips_second_capture_and_reaches_core(self) -> None:
        capture = FakeCapture()
        core = FakeCore("I can check that for you.")
        pipeline, _sink, tts, _gate = make_pipeline(
            capture=capture, stt=QueueStt(), core=core,
        )
        session = DoubleClapListeningSession(
            pipeline,
            max_follow_ups=0,
            pending_wake_transcript=lambda timestamp: (
                "Ultron, when is the match between Brazil and India?" if timestamp == 12.0 else None
            ),
        )
        session.start(12.0)
        self.assertEqual(capture.paths, [])
        self.assertEqual(core.messages, ["when is the match between Brazil and India?"])
        self.assertEqual(tts.messages, ["I can check that for you."])

    def test_repeated_wake_words_do_not_call_the_core_or_speak(self) -> None:
        core = FakeCore()
        pipeline, _sink, tts, _gate = make_pipeline(
            capture=FakeCapture(), stt=QueueStt(), core=core,
        )
        result = pipeline.run_preheard("Ultron, Ultron")
        self.assertFalse(result.accepted)
        self.assertEqual(core.messages, [])
        self.assertEqual(tts.messages, [])

    def test_no_follow_up_after_an_unaccepted_first_utterance(self) -> None:
        capture = FakeCapture()
        pipeline, _sink, _tts, _gate = make_pipeline(
            capture=capture, stt=QueueStt(""), core=FakeCore(),
        )
        session = DoubleClapListeningSession(pipeline, sleeper=lambda _seconds: self.fail("unexpected follow-up"))
        session.start(1.0)
        self.assertEqual(len(capture.paths), 1)

    def test_voice_stage_timings_contain_only_stage_names_and_durations(self) -> None:
        timings: list[tuple[str, int]] = []
        capture = FakeCapture()
        pipeline = LocalConversationalVoicePipeline(
            capture=capture, stt=QueueStt("Hello"), core=FakeCore(),
            tts=FakeTts(TtsPlaybackGate()), events=RecordingSink(),
            tts_gate=TtsPlaybackGate(), timing_reporter=lambda stage, duration: timings.append((stage, duration)),
        )
        pipeline.run_once()
        self.assertEqual([stage for stage, _ in timings], ["capture", "transcription", "core", "tts_and_playback"])
        self.assertTrue(all(isinstance(duration, int) and duration >= 0 for _, duration in timings))

    def test_local_tts_stops_between_chunks_when_session_locks(self) -> None:
        import numpy as np
        import types

        allowed = iter([True, True, False])

        class Stream:
            writes = 0

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def write(self, samples):
                self.writes += 1

        stream = Stream()

        class SoundDevice:
            default = types.SimpleNamespace(device=(0, 1))

            def query_devices(self):
                return [{"max_output_channels": 0}, {"max_output_channels": 2}]

            def check_output_settings(self, **kwargs):
                self.checked_device = kwargs["device"]

            def OutputStream(self, **kwargs):
                return stream

        adapter = KokoroMichaelAdapter(
            model_directory=Path("."),
            playback_allowed=allowed.__next__,
        )
        with self.assertRaises(VoicePipelineError):
            adapter._play_samples(SoundDevice(), np.zeros(2_000, dtype=np.float32), 16_000)
        self.assertEqual(stream.writes, 1)

    def test_tts_gain_increases_quiet_audio_without_clipping(self) -> None:
        import numpy as np
        import types

        class Stream:
            def __init__(self):
                self.blocks = []

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def write(self, block):
                self.blocks.append(block.copy())

        stream = Stream()
        sound = types.SimpleNamespace(
            default=types.SimpleNamespace(device=(0, 1)),
            query_devices=lambda: [{"max_output_channels": 0}, {"max_output_channels": 2}],
            check_output_settings=lambda **kwargs: None,
            OutputStream=lambda **kwargs: stream,
        )
        adapter = KokoroMichaelAdapter(model_directory=Path("."), gain=2.0)
        first_writes = []
        adapter._play_samples(
            sound, np.full(100, 0.3, dtype=np.float32), 1000,
            on_first_write=lambda: first_writes.append(True),
        )
        self.assertEqual(first_writes, [True])
        self.assertAlmostEqual(float(np.max(np.concatenate(stream.blocks))), 0.6, places=5)
        stream.blocks.clear()
        adapter._play_samples(sound, np.full(100, 0.8, dtype=np.float32), 1000)
        self.assertLessEqual(float(np.max(np.concatenate(stream.blocks))), 0.900001)

    def test_kokoro_streams_every_chunk_before_generation_finishes(self) -> None:
        import numpy as np
        import types

        events: list[str] = []

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                events.append("closed")

            def write(self, block):
                events.append(f"write:{len(block)}")

        class Tts:
            sample_rate = 1000

            def generate(self, _text, _config, callback):
                events.append("generate:start")
                self.assert_continues = callback(np.full(100, 0.2, dtype=np.float32), 0.5)
                events.append("generate:middle")
                self.assert_continues_again = callback(np.full(50, 0.2, dtype=np.float32), 1.0)
                events.append("generate:done")
                return types.SimpleNamespace(samples=np.full(150, 0.2, dtype=np.float32))

        sound = types.SimpleNamespace(
            default=types.SimpleNamespace(device=(0, 1)),
            query_devices=lambda: [{"max_output_channels": 0}, {"max_output_channels": 2}],
            check_output_settings=lambda **kwargs: None,
            OutputStream=lambda **kwargs: Stream(),
        )
        timings: list[str] = []
        adapter = KokoroMichaelAdapter(
            model_directory=Path("."),
            timing_reporter=lambda stage, _duration: timings.append(stage),
        )
        tts = Tts()
        adapter._stream_generated_audio(sound, tts, "Two sentences.", object(), 0.0)

        self.assertEqual(tts.assert_continues, 1)
        self.assertEqual(tts.assert_continues_again, 1)
        self.assertLess(events.index("write:50"), events.index("generate:middle"))
        self.assertEqual(events.count("write:50"), 3)
        self.assertEqual(events[-1], "closed")
        self.assertEqual(timings, ["tts_first_audio", "tts_stream_total"])

    def test_kokoro_stream_failure_closes_output_and_does_not_replay(self) -> None:
        import numpy as np
        import types

        events: list[str] = []

        class Stream:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                events.append("closed")

            def write(self, _block):
                events.append("write")
                raise OSError("speaker disconnected")

        class Tts:
            sample_rate = 1000

            def generate(self, _text, _config, callback):
                callback(np.ones(50, dtype=np.float32), 1.0)
                return types.SimpleNamespace(samples=np.ones(50, dtype=np.float32))

        sound = types.SimpleNamespace(
            default=types.SimpleNamespace(device=(0, 1)),
            query_devices=lambda: [{"max_output_channels": 0}, {"max_output_channels": 2}],
            check_output_settings=lambda **kwargs: None,
            OutputStream=lambda **kwargs: Stream(),
        )
        adapter = KokoroMichaelAdapter(model_directory=Path("."))
        with self.assertRaises(OSError):
            adapter._stream_generated_audio(sound, Tts(), "Hello.", object(), 0.0)
        self.assertEqual(events, ["write", "closed"])

    def test_spoken_text_removes_markdown_without_changing_visual_answer(self) -> None:
        capture = FakeCapture()
        core = FakeCore("**Important:** [open the dashboard](https://example.com).")
        pipeline, _sink, tts, _gate = make_pipeline(capture=capture, stt=QueueStt("Hello"), core=core)
        result = pipeline.run_once()
        self.assertEqual(result.response, "**Important:** [open the dashboard](https://example.com).")
        self.assertEqual(tts.messages, ["Important: open the dashboard."])

    def test_session_is_revalidated_before_normal_text_reaches_core(self) -> None:
        checks = iter([True, False])
        capture = FakeCapture()
        core = FakeCore()
        pipeline, _sink, tts, _gate = make_pipeline(
            capture=capture,
            stt=QueueStt("show my plan"),
            core=core,
            conversation_allowed=checks.__next__,
        )

        with self.assertRaises(VoicePipelineError):
            pipeline.run_once()

        self.assertEqual(len(capture.paths), 1)
        self.assertEqual(core.messages, [])
        self.assertEqual(tts.messages, [])

    def test_full_flow_is_local_until_normal_text_reaches_core(self) -> None:
        capture = FakeCapture()
        stt = QueueStt("Ultron, show my plan")
        core = FakeCore("Your three priorities are ready.")
        pipeline, sink, tts, gate = make_pipeline(capture=capture, stt=stt, core=core)

        result = pipeline.run_once(ConversationMode.WAKE_WORD)

        self.assertTrue(result.accepted)
        self.assertEqual(result.command, "show my plan")
        self.assertEqual(core.messages, ["show my plan"])
        self.assertEqual(tts.messages, ["Your three priorities are ready."])
        self.assertEqual(tts.was_gated, [True])
        self.assertFalse(gate.is_suppressed(100.0))
        self.assertEqual(
            [event.name for event in sink.events],
            [
                EventName.VOICE_LISTENING,
                EventName.VOICE_LISTENING,
                EventName.VOICE_TRANSCRIBING,
                EventName.VOICE_TRANSCRIBING,
                EventName.VOICE_THINKING,
                EventName.VOICE_THINKING,
                EventName.VOICE_SPEAKING,
                EventName.VOICE_SPEAKING,
            ],
        )
        self.assertEqual(
            [event.payload["active"] for event in sink.events],
            [True, False, True, False, True, False, True, False],
        )
        for event in sink.events:
            self.assertEqual(set(event.payload), {"active"})
        self.assertFalse(capture.paths[0].exists())
        self.assertFalse(stt.paths[0].exists())

    def test_wake_word_and_double_clap_modes_coexist(self) -> None:
        capture = FakeCapture()
        stt = QueueStt(
            "Ultron plan my day",
            "plan my day",
            "plan my day",
        )
        core = FakeCore()
        pipeline, _sink, tts, _gate = make_pipeline(capture=capture, stt=stt, core=core)

        prefixed = pipeline.run_once(ConversationMode.WAKE_WORD)
        missing_wake = pipeline.run_once(ConversationMode.WAKE_WORD)
        clap = pipeline.run_once(ConversationMode.DOUBLE_CLAP)

        self.assertTrue(prefixed.accepted)
        self.assertFalse(missing_wake.accepted)
        self.assertTrue(clap.accepted)
        self.assertEqual(core.messages, ["plan my day", "plan my day"])
        self.assertEqual(len(tts.messages), 2)

    def test_temporary_wav_is_deleted_when_core_fails(self) -> None:
        capture = FakeCapture()
        stt = QueueStt("What needs me today?")
        core = FakeCore(error=ConnectionError("core unavailable"))
        pipeline, sink, tts, _gate = make_pipeline(capture=capture, stt=stt, core=core)

        with self.assertRaises(VoicePipelineError) as raised:
            pipeline.run_once()

        self.assertEqual(raised.exception.stage, VoicePipelineStage.CORE)
        self.assertFalse(capture.paths[0].exists())
        self.assertEqual(tts.messages, [])
        self.assertNotIn(EventName.VOICE_SPEAKING, [event.name for event in sink.events])

    def test_tts_failure_releases_gate_and_emits_speaking_false(self) -> None:
        capture = FakeCapture()
        stt = QueueStt("What is next?")
        core = FakeCore()
        pipeline, sink, tts, gate = make_pipeline(
            capture=capture,
            stt=stt,
            core=core,
            tts_error=RuntimeError("speaker unavailable"),
        )

        with self.assertRaises(VoicePipelineError) as raised:
            pipeline.run_once()

        self.assertEqual(raised.exception.stage, VoicePipelineStage.TTS)
        self.assertEqual(tts.was_gated, [True])
        self.assertFalse(gate.is_suppressed(100.0))
        speaking = [event for event in sink.events if event.name is EventName.VOICE_SPEAKING]
        self.assertEqual([event.payload["active"] for event in speaking], [True, False])

    def test_microphone_failure_has_distinct_error_and_clears_state(self) -> None:
        capture = FakeCapture(error=OSError("device missing"))
        stt = QueueStt("unused")
        core = FakeCore()
        pipeline, sink, tts, _gate = make_pipeline(capture=capture, stt=stt, core=core)

        with self.assertRaises(VoiceMicrophoneError):
            pipeline.run_once()

        self.assertEqual(stt.paths, [])
        self.assertEqual(tts.messages, [])
        self.assertEqual(
            [event.payload["active"] for event in sink.events],
            [True, False],
        )

    def test_parser_does_not_accept_similar_non_prefix(self) -> None:
        parser = WakeWordParser()
        self.assertEqual(parser.parse("Ultron: hello", required=True), "hello")
        self.assertIsNone(parser.parse("Ultronic hello", required=True))
        self.assertEqual(parser.parse("hello", required=False), "hello")
        self.assertIsNone(parser.parse("Ultron", required=False))
        self.assertIsNone(parser.parse("Ultron, Ultron", required=False))
        self.assertIsNone(parser.parse("Ultron, Ultron, Ultron", required=True))
        self.assertEqual(parser.parse("Ultron, Ultron is my project", required=True), "Ultron is my project")
        self.assertTrue(parser.detected("Ultron"))
        self.assertTrue(parser.detected("Ultron, listen"))
        self.assertFalse(parser.detected("Ultronic hello"))

    def test_michael_speaker_id_is_fixed(self) -> None:
        self.assertEqual(MICHAEL_SPEAKER_ID, 6)


if __name__ == "__main__":
    unittest.main()
