"""Interactively enroll a configured speaker using auto-deleted recordings."""

from __future__ import annotations

import argparse
import math
import tempfile
import time
import winsound
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

from .sherpa_speaker import SPEAKER_SAMPLE_RATE, SherpaOnnxSpeakerEmbeddingBackend
from .speaker import EncryptedFileSpeakerProfileStore, EnrollmentService, resolve_speaker_name
from .stage2_stt_check import resolve_input_device


ENROLLMENT_PHRASES = (
    "Ultron, this is the enrolled speaker using this computer.",
    "Seven amber delta, the morning project is ready for review.",
    "My voice changes naturally when I speak quickly or slowly.",
    "Today I am speaking clearly at a natural and comfortable pace.",
    "Verify this final sample and protect my local speaker profile.",
)


def record_sample(path: Path, *, phrase: str, seconds: float, device: int) -> None:
    print(f"\nSay: {phrase}")
    print("Recording begins after the high beep.")
    for remaining in range(3, 0, -1):
        print(f"Starting in {remaining}...")
        winsound.Beep(760, 150)
        time.sleep(0.85)
    winsound.Beep(1_200, 220)
    samples = sd.rec(
        round(seconds * SPEAKER_SAMPLE_RATE),
        samplerate=SPEAKER_SAMPLE_RATE,
        channels=1,
        dtype="float32",
        device=device,
    )
    sd.wait()
    flattened = np.asarray(samples, dtype=np.float32).reshape(-1)
    rms = float(np.sqrt(np.mean(np.square(flattened, dtype=np.float64))))
    peak = float(np.max(np.abs(flattened)))
    if rms < 0.003 or peak < 0.02:
        raise RuntimeError("Recording was too quiet; enrollment stopped without saving a profile")
    print(f"Captured RMS={20 * math.log10(max(rms, 1e-10)):.1f} dBFS, peak={peak:.3f}")
    sf.write(path, flattened, SPEAKER_SAMPLE_RATE, subtype="PCM_16")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name")
    parser.add_argument("--device-id", type=int)
    parser.add_argument("--seconds", type=float, default=6.0)
    args = parser.parse_args()
    try:
        speaker_name = resolve_speaker_name(args.name)
    except ValueError as error:
        parser.error(str(error))
    if args.seconds < 3 or args.seconds > 12:
        raise ValueError("--seconds must be between 3 and 12")

    device = resolve_input_device(args.device_id)
    print(f"Speaker enrollment: {speaker_name}")
    print(f"Input device [{device}]: {sd.query_devices(device)['name']}")
    print("Five varied samples will be recorded locally and deleted after embedding extraction.")
    backend = SherpaOnnxSpeakerEmbeddingBackend()
    store = EncryptedFileSpeakerProfileStore.windows_default()

    with tempfile.TemporaryDirectory(prefix="ultron-enrollment-") as temporary:
        root = Path(temporary)
        paths: list[Path] = []
        for index, phrase in enumerate(ENROLLMENT_PHRASES, start=1):
            path = root / f"sample-{index}.wav"
            record_sample(path, phrase=phrase, seconds=args.seconds, device=device)
            paths.append(path)
        profile = EnrollmentService(backend, store).enroll(speaker_name, paths)

    print(f"\nSpeaker enrolled: {profile.display_name}")
    print(f"Profile: {profile.profile_id}; samples: {profile.sample_count}")
    print("Raw enrollment recordings were deleted. No Windows password was requested or stored.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
