"""Generate and optionally play Kokoro's local Michael voice."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
import sounddevice as sd
import soundfile as sf


MICHAEL_SPEAKER_ID = 6

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def default_kokoro_directory() -> Path:
    configured = os.environ.get("ULTRON_VOICE_MODEL_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".cache" / "ultron-voice" / "models"
    return root.resolve() / "sherpa-onnx" / "kokoro-en-v0_19"


def list_output_devices() -> None:
    default_output = sd.default.device[1]
    print(f"Default output device: {default_output}")
    for index, device in enumerate(sd.query_devices()):
        if int(device["max_output_channels"]) <= 0:
            continue
        marker = " (default)" if index == default_output else ""
        print(
            f"[{index}] {device['name']} | outputs={device['max_output_channels']} "
            f"| default_rate={device['default_samplerate']}{marker}"
        )


def create_tts(model_directory: Path, threads: int) -> sherpa_onnx.OfflineTts:
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                model=str(model_directory / "model.onnx"),
                voices=str(model_directory / "voices.bin"),
                tokens=str(model_directory / "tokens.txt"),
                data_dir=str(model_directory / "espeak-ng-data"),
            ),
            provider="cpu",
            debug=False,
            num_threads=threads,
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ValueError("Invalid Kokoro TTS configuration")
    return sherpa_onnx.OfflineTts(config)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_kokoro_directory())
    parser.add_argument("--text", default="Hello. Ultron's local voice diagnostic is working.")
    parser.add_argument("--speaker-id", type=int, default=MICHAEL_SPEAKER_ID)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--device-id", type=int)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--no-play", action="store_true")
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()

    if args.list_devices:
        list_output_devices()
        return 0

    model_directory = args.model_dir.expanduser().resolve()
    if not (model_directory / "model.onnx").is_file():
        raise FileNotFoundError(f"Kokoro model not found: {model_directory}")

    loaded_at = time.perf_counter()
    tts = create_tts(model_directory, args.threads)
    print(f"Kokoro ready in {time.perf_counter() - loaded_at:.2f}s")
    generation = sherpa_onnx.GenerationConfig()
    generation.sid = args.speaker_id
    generation.speed = args.speed
    generation.silence_scale = 0.2

    started = time.perf_counter()
    audio = tts.generate(args.text, generation)
    elapsed = time.perf_counter() - started
    samples = np.asarray(audio.samples, dtype=np.float32)
    if len(samples) == 0:
        raise RuntimeError("Kokoro generated no audio")
    duration = len(samples) / audio.sample_rate
    print(
        f"Generated {duration:.2f}s at {audio.sample_rate} Hz in {elapsed:.2f}s "
        f"(RTF={elapsed / duration:.3f}, speaker=am_michael/{args.speaker_id})"
    )

    if args.output:
        output = args.output.expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(output, samples, audio.sample_rate, subtype="PCM_16")
        print(f"Saved: {output}")
    if not args.no_play:
        print("Playing through the selected Windows output device...")
        sd.play(samples, audio.sample_rate, device=args.device_id)
        sd.wait()
        print("Playback complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
