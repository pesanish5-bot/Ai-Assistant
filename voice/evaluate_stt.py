"""Local, opt-in STT evaluation. Audio and transcripts are never retained here."""

from __future__ import annotations

import argparse
import re
import tempfile
from pathlib import Path

from .local_conversation_audio import (
    FasterWhisperSmallAdapter,
    SileroVadMicrophoneCapture,
    default_voice_model_root,
)


PHRASES = {
    "how_are_you": "How are you?",
    "what_time": "What time is it?",
    "open_dashboard": "Open my dashboard.",
    "explain": "Explain what you're doing.",
    "adda_ai": "Tell me about ADDA AI.",
    "hear_clearly": "Can you hear me clearly?",
}


def words(text: str) -> list[str]:
    return re.findall(r"[\w']+", text.casefold())


def word_error_count(reference: str, hypothesis: str) -> tuple[int, int]:
    expected, actual = words(reference), words(hypothesis)
    previous = list(range(len(actual) + 1))
    for row, expected_word in enumerate(expected, 1):
        current = [row]
        for column, actual_word in enumerate(actual, 1):
            current.append(min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + (expected_word != actual_word),
            ))
        previous = current
    return previous[-1], len(expected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recordings", type=Path, nargs="?", help="Private folder of WAVs named after the phrase IDs")
    parser.add_argument("--live", action="store_true", help="Prompt for six microphone phrases; delete each temporary WAV")
    parser.add_argument("--device-id", type=int, help="Input device for --live; defaults to the selected microphone")
    parser.add_argument("--model", choices=("base", "small"), default="small")
    parser.add_argument("--phrases", nargs="+", choices=tuple(PHRASES), help="Evaluate only these phrase IDs")
    parser.add_argument("--show-transcripts", action="store_true", help="Print private transcript text to this terminal")
    args = parser.parse_args()
    if args.live == (args.recordings is not None):
        parser.error("provide either a recordings folder or --live")
    if args.device_id is not None and not args.live:
        parser.error("--device-id requires --live")
    stt = FasterWhisperSmallAdapter(model_root=default_voice_model_root(), model_size=args.model)
    capture = (
        SileroVadMicrophoneCapture(
            model_path=default_voice_model_root() / "sherpa-onnx" / "silero_vad.onnx",
            device=args.device_id,
        ) if args.live else None
    )
    total_errors = total_words = checked = 0
    with tempfile.TemporaryDirectory(prefix="ultron-stt-evaluation-") as temporary:
        selected = args.phrases if args.phrases else PHRASES
        for phrase_id in selected:
            expected = PHRASES[phrase_id]
            path = Path(temporary) / f"{phrase_id}.wav" if args.live else args.recordings / f"{phrase_id}.wav"
            if capture is not None:
                try:
                    input(f"Say: {expected}\nPress Enter when ready to record... ")
                    capture.capture(path)
                except (EOFError, KeyboardInterrupt):
                    print("Evaluation cancelled; temporary audio is being deleted.")
                    return 130
                except Exception as error:
                    print(f"{phrase_id}: capture failed ({type(error).__name__})")
                    continue
            elif not path.is_file():
                print(f"{phrase_id}: missing recording")
                continue
            try:
                actual = stt.transcribe(path)
            except Exception as error:
                print(f"{phrase_id}: transcription failed ({type(error).__name__})")
                continue
            errors, count = word_error_count(expected, actual)
            total_errors += errors
            total_words += count
            checked += 1
            print(f"{phrase_id}: WER={errors / count:.2%}" + (f" transcript={actual!r}" if args.show_transcripts else ""))
    if not checked:
        print("No recordings found. No accuracy claim can be made.")
        return 2
    print(f"Overall WER={total_errors / total_words:.2%} over {checked} recordings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
