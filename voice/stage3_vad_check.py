"""Verify automatic speech endpointing with Silero VAD and the microphone."""

from __future__ import annotations

import argparse
import os
import sys
import time
import winsound
from pathlib import Path

import numpy as np
import sherpa_onnx
import sounddevice as sd

from stage2_stt_check import SAMPLE_RATE, resolve_input_device


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def default_vad_model() -> Path:
    configured = os.environ.get("ULTRON_VOICE_MODEL_DIR")
    root = Path(configured).expanduser() if configured else Path.home() / ".cache" / "ultron-voice" / "models"
    return root.resolve() / "sherpa-onnx" / "silero_vad.onnx"


def create_vad(model: Path, threshold: float, silence_seconds: float) -> sherpa_onnx.VoiceActivityDetector:
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(model)
    config.silero_vad.threshold = threshold
    config.silero_vad.min_silence_duration = silence_seconds
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 30.0
    config.silero_vad.window_size = 512
    config.sample_rate = SAMPLE_RATE
    config.num_threads = 1
    config.provider = "cpu"
    if not config.validate():
        raise ValueError("Invalid Silero VAD configuration")
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=30)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=default_vad_model())
    parser.add_argument("--device-id", type=int)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--silence-seconds", type=float, default=0.7)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    model = args.model.expanduser().resolve()
    if not model.is_file():
        raise FileNotFoundError(f"VAD model not found: {model}")
    selected_device = resolve_input_device(args.device_id)
    device_name = sd.query_devices(selected_device)["name"]
    vad = create_vad(model, args.threshold, args.silence_seconds)

    print(f"Selected input [{selected_device}]: {device_name}")
    print("After the final high beep, speak one sentence and then remain silent.")
    for remaining in range(3, 0, -1):
        print(f"Starting in {remaining}...")
        winsound.Beep(760, 180)
        time.sleep(0.82)
    winsound.Beep(1_200, 250)

    started = time.perf_counter()
    speech_started_at: float | None = None
    block_size = 512
    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        blocksize=block_size,
        channels=1,
        dtype="float32",
        device=selected_device,
    ) as stream:
        while time.perf_counter() - started < args.timeout:
            block, overflowed = stream.read(block_size)
            if overflowed:
                print("Warning: microphone input overflowed")
            vad.accept_waveform(np.asarray(block, dtype=np.float32).reshape(-1))
            if vad.is_speech_detected() and speech_started_at is None:
                speech_started_at = time.perf_counter()
                print("Speech detected...")
            if not vad.empty():
                segment = vad.front
                samples = np.asarray(segment.samples, dtype=np.float32)
                vad.pop()
                elapsed = time.perf_counter() - started
                duration = len(samples) / SAMPLE_RATE
                peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
                print(
                    f"Endpoint detected after {elapsed:.2f}s: "
                    f"speech={duration:.2f}s, peak={peak:.4f}"
                )
                return 0

    vad.flush()
    raise TimeoutError(
        "No completed speech segment was detected. Check microphone mute/level "
        "or increase --timeout."
    )


if __name__ == "__main__":
    raise SystemExit(main())
