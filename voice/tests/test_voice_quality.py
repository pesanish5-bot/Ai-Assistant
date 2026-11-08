from __future__ import annotations

import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from voice.conversation import VoicePipelineError
from voice.local_conversation_audio import FasterWhisperSmallAdapter, SileroVadMicrophoneCapture
from voice.speech_text import for_speech, iter_speakable_units
from voice.evaluate_stt import PHRASES, main as evaluate_stt, word_error_count


class VoiceQualityTests(unittest.TestCase):
    def test_rejects_silence_clipping_and_too_short_audio(self) -> None:
        validate = SileroVadMicrophoneCapture._validate_speech
        for samples in (
            np.zeros(16_000, dtype=np.float32),
            np.ones(16_000, dtype=np.float32),
            np.full(1_000, 0.1, dtype=np.float32),
        ):
            with self.subTest(length=len(samples)), self.assertRaises(VoicePipelineError):
                validate(np, samples)
        valid = np.sin(np.linspace(0, 200, 16_000)).astype(np.float32) * 0.1
        validate(np, valid)

    def test_discards_weak_asr_segments_without_rewriting_good_words(self) -> None:
        adapter = FasterWhisperSmallAdapter(model_root=Path('.'))
        segments = [
            SimpleNamespace(text='Yeah I am John', no_speech_prob=0.81, avg_logprob=-0.2),
            SimpleNamespace(text='How are you?', no_speech_prob=0.05, avg_logprob=-0.2),
        ]
        adapter._model = SimpleNamespace(transcribe=lambda *_args, **_kwargs: (segments, None))
        self.assertEqual(adapter.transcribe(Path('unused.wav')), 'How are you?')

    def test_streamed_speech_units_split_on_sentence_boundaries(self) -> None:
        units = list(iter_speakable_units(iter(["Hello there. ", "How are ", "you today? Thanks!"])))
        self.assertEqual(units, ["Hello there.", "How are you today?", "Thanks!"])

    def test_speech_formatting_omits_code_and_urls(self) -> None:
        self.assertEqual(for_speech('## Result\n```js\nsecret()\n```\nSee https://example.com'),
                         'Result Code is shown on screen. See a link shown on screen')

    def test_word_error_metric_handles_substitutions_and_insertions(self) -> None:
        self.assertEqual(word_error_count('How are you?', 'How are you?'), (0, 3))
        self.assertEqual(word_error_count('How are you?', 'Yeah I am John'), (4, 3))

    def test_opt_in_live_evaluation_deletes_temporary_audio(self) -> None:
        captured: list[Path] = []

        def record(path: Path) -> None:
            path.write_bytes(b'private test audio')
            captured.append(path)

        def transcribe(path: Path) -> str:
            self.assertTrue(path.is_file())
            return PHRASES[path.stem]

        with patch('sys.argv', ['evaluate_stt', '--live']), \
             patch('builtins.input', return_value=''), \
             patch('voice.evaluate_stt.SileroVadMicrophoneCapture') as capture, \
             patch('voice.evaluate_stt.FasterWhisperSmallAdapter') as stt, \
             redirect_stdout(StringIO()):
            capture.return_value.capture.side_effect = record
            stt.return_value.transcribe.side_effect = transcribe
            self.assertEqual(evaluate_stt(), 0)
        self.assertEqual(len(captured), len(PHRASES))
        self.assertTrue(all(not path.exists() for path in captured))

    def test_live_evaluation_can_target_only_missed_phrases(self) -> None:
        captured: list[str] = []

        def record(path: Path) -> None:
            path.write_bytes(b'private test audio')
            captured.append(path.stem)

        with patch('sys.argv', ['evaluate_stt', '--live', '--phrases', 'explain', 'adda_ai']), \
             patch('builtins.input', return_value=''), \
             patch('voice.evaluate_stt.SileroVadMicrophoneCapture') as capture, \
             patch('voice.evaluate_stt.FasterWhisperSmallAdapter') as stt, \
             redirect_stdout(StringIO()):
            capture.return_value.capture.side_effect = record
            stt.return_value.transcribe.side_effect = lambda path: PHRASES[path.stem]
            self.assertEqual(evaluate_stt(), 0)
        self.assertEqual(captured, ['explain', 'adda_ai'])

    def test_evaluation_requires_exactly_one_audio_source(self) -> None:
        with patch('sys.argv', ['evaluate_stt']), redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit) as missing:
                evaluate_stt()
        self.assertEqual(missing.exception.code, 2)
        with patch('sys.argv', ['evaluate_stt', 'recordings', '--live']), redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit) as both:
                evaluate_stt()
        self.assertEqual(both.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
