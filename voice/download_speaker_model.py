"""Download and verify Ultron's local English CAM++ speaker model."""

from __future__ import annotations

import argparse
from pathlib import Path

from .download_stage3_models import default_model_directory, download
from .sherpa_speaker import (
    SPEAKER_MODEL_NAME,
    SPEAKER_MODEL_SHA256,
    verify_speaker_model,
)


SPEAKER_MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_model_directory())
    args = parser.parse_args()
    destination = args.model_dir.expanduser().resolve() / "sherpa-onnx" / SPEAKER_MODEL_NAME
    download(SPEAKER_MODEL_URL, destination, sha256=SPEAKER_MODEL_SHA256)
    verify_speaker_model(destination)
    print(f"Speaker model verified: {destination}")
    print(f"SHA-256: {SPEAKER_MODEL_SHA256}")
    print("Attribution: WeSpeaker Apache-2.0 software; VoxCeleb-trained model CC BY 4.0.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
