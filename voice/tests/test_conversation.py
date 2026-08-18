from __future__ import annotations

import unittest
from pathlib import Path

from voice.conversation import (
    ConversationMode,
    LocalConversationalVoicePipeline,
    VoiceMicrophoneError,
    VoicePipelineError,
    VoicePipelineStage,
    WakeWordParser,
)
from voice.interaction import EventName, InteractionEvent, TtsPlaybackGate
from voice.local_conversation_audio import KokoroMichaelAdapter, MICHAEL_SPEAKER_ID


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

    def capture(self, destination: Path) -> None:
        self.paths.append(destination)
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
    def test_local_tts_stops_between_chunks_when_session_locks(self) -> None:
        import numpy as np

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
            def OutputStream(self, **kwargs):
                return stream

        adapter = KokoroMichaelAdapter(
            model_directory=Path("."),
            playback_allowed=allowed.__next__,
        )
        with self.assertRaises(VoicePipelineError):
            adapter._play_samples(SoundDevice(), np.zeros(2_000, dtype=np.float32), 16_000)
        self.assertEqual(stream.writes, 1)

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
                EventName.VOICE_SPEAKING,
                EventName.VOICE_SPEAKING,
            ],
        )
        self.assertEqual(
            [event.payload["active"] for event in sink.events],
            [True, False, True, False, True, False],
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
        self.assertTrue(parser.detected("Ultron"))
        self.assertTrue(parser.detected("Ultron, listen"))
        self.assertFalse(parser.detected("Ultronic hello"))

    def test_michael_speaker_id_is_fixed(self) -> None:
        self.assertEqual(MICHAEL_SPEAKER_ID, 6)


if __name__ == "__main__":
    unittest.main()
