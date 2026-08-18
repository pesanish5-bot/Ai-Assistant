"""Stage 2 diagnostic for local microphone capture and faster-whisper.

This is intentionally isolated from the Ultron runtime until the speech-to-text
baseline has been verified. Recorded audio is stored in a temporary directory
and removed when the command exits.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
import time
import winsound
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf
from faster_whisper import WhisperModel


SAMPLE_RATE = 16_000

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def default_model_directory() -> Path:
    configured = os.environ.get("ULTRON_VOICE_MODEL_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".cache" / "ultron-voice" / "models"


def list_input_devices() -> None:
    default_input = sd.default.device[0]
    print(f"Default input device: {default_input}")
    for index, device in enumerate(sd.query_devices()):
        if int(device["max_input_channels"]) <= 0:
            continue
        marker = " (default)" if index == default_input else ""
        print(
            f"[{index}] {device['name']} | inputs={device['max_input_channels']} "
            f"| default_rate={device['default_samplerate']}{marker}"
        )


def resolve_input_device(configured_device: int | None) -> int:
    if configured_device is not None:
        return configured_device

    default_input = int(sd.default.device[0])
    default_name = str(sd.query_devices(default_input)["name"])
    if "stereo mix" not in default_name.lower():
        return default_input

    for index, device in enumerate(sd.query_devices()):
        name = str(device["name"])
        if int(device["max_input_channels"]) > 0 and "microphone array" in name.lower():
            print(
                f"Windows default input is '{default_name}', so the built-in "
                f"microphone array [{index}] was selected instead."
            )
            return index
    raise RuntimeError(
        "Windows default input is Stereo Mix and no microphone array was found; "
        "pass --device-id explicitly."
    )


def load_model(model_name: str, model_directory: Path) -> WhisperModel:
    model_directory.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    print(
        f"Loading faster-whisper model '{model_name}' on CPU with int8 "
        f"from {model_directory}"
    )
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        download_root=str(model_directory),
    )
    print(f"Model ready in {time.perf_counter() - started:.2f}s")
    return model


def record_microphone(seconds: float, device: int | None, destination: Path) -> None:
    selected_device = resolve_input_device(device)
    device_name = str(sd.query_devices(selected_device)["name"])
    frames = round(seconds * SAMPLE_RATE)
    print(
        f"Selected input [{selected_device}]: {device_name}\n"
        f"Recording will run for {seconds:.1f}s. Speak after the final high beep."
    )
    for remaining in range(3, 0, -1):
        print(f"Starting in {remaining}...")
        winsound.Beep(760, 180)
        time.sleep(0.82)
    winsound.Beep(1_200, 250)
    audio = sd.rec(
        frames,
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        device=selected_device,
    )
    sd.wait()
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    peak = float(np.max(np.abs(audio)))
    dbfs = 20 * math.log10(max(rms, 1e-10))
    sf.write(destination, audio, SAMPLE_RATE, subtype="PCM_16")
    print(f"Captured signal: RMS={dbfs:.1f} dBFS, peak={peak:.4f}")
    print("Recording complete; audio is temporary and will be deleted.")


def transcribe(model: WhisperModel, audio_path: Path, language: str | None) -> dict[str, object]:
    started = time.perf_counter()
    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=5,
        vad_filter=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    elapsed = time.perf_counter() - started
    result = {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "duration_seconds": round(info.duration, 3),
        "transcription_seconds": round(elapsed, 3),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--input-file", type=Path)
    parser.add_argument("--device-id", type=int)
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--language", help="Optional ISO language code such as en, hi, or bn")
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-dir", type=Path, default=default_model_directory())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.list_devices:
        list_input_devices()
        return 0

    model = load_model(args.model, args.model_dir.expanduser().resolve())
    if args.download_only:
        return 0

    if args.seconds <= 0:
        raise ValueError("--seconds must be greater than zero")

    if args.input_file:
        audio_path = args.input_file.expanduser().resolve()
        if not audio_path.is_file():
            raise FileNotFoundError(audio_path)
        transcribe(model, audio_path, args.language)
        return 0

    with tempfile.TemporaryDirectory(prefix="ultron-stt-") as temp_directory:
        audio_path = Path(temp_directory) / "microphone.wav"
        record_microphone(args.seconds, args.device_id, audio_path)
        transcribe(model, audio_path, args.language)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
