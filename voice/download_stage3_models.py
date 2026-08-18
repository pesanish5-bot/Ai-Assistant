"""Download the official Silero VAD and Kokoro English model files."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


VAD_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "asr-models/silero_vad.onnx"
)
KOKORO_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "tts-models/kokoro-en-v0_19.tar.bz2"
)
KOKORO_NAME = "kokoro-en-v0_19"
VAD_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
KOKORO_ARCHIVE_SHA256 = "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def default_model_directory() -> Path:
    configured = os.environ.get("ULTRON_VOICE_MODEL_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".cache" / "ultron-voice" / "models"


def verify_sha256(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    actual = digest.hexdigest()
    if actual != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path.name}: expected {expected}, got {actual}")


def download(url: str, destination: Path, *, sha256: str | None = None) -> None:
    if destination.is_file():
        if sha256:
            verify_sha256(destination, sha256)
        print(f"Already downloaded: {destination}")
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "Ultron-Voice/1"})
    print(f"Downloading {url}\n  -> {destination}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as output:
            expected = int(response.headers.get("Content-Length", "0"))
            downloaded = 0
            next_report = 25 * 1024 * 1024
            while block := response.read(1024 * 1024):
                output.write(block)
                downloaded += len(block)
                if downloaded >= next_report:
                    if expected:
                        print(f"  {downloaded / 1024 / 1024:.0f}/{expected / 1024 / 1024:.0f} MB")
                    else:
                        print(f"  {downloaded / 1024 / 1024:.0f} MB")
                    next_report += 25 * 1024 * 1024
        if sha256:
            verify_sha256(partial, sha256)
        partial.replace(destination)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def validate_models(model_root: Path) -> None:
    vad = model_root / "sherpa-onnx" / "silero_vad.onnx"
    kokoro = model_root / "sherpa-onnx" / KOKORO_NAME
    required = {
        vad: 200_000,
        kokoro / "model.onnx": 300_000_000,
        kokoro / "voices.bin": 5_000_000,
        kokoro / "tokens.txt": 500,
        kokoro / "LICENSE": 1_000,
    }
    for path, minimum_size in required.items():
        if not path.is_file() or path.stat().st_size < minimum_size:
            raise RuntimeError(f"Missing or unexpectedly small model file: {path}")
    if not (kokoro / "espeak-ng-data").is_dir():
        raise RuntimeError(f"Missing Kokoro language data: {kokoro / 'espeak-ng-data'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=default_model_directory())
    args = parser.parse_args()

    model_root = args.model_dir.expanduser().resolve()
    sherpa_root = model_root / "sherpa-onnx"
    sherpa_root.mkdir(parents=True, exist_ok=True)

    vad_path = sherpa_root / "silero_vad.onnx"
    download(VAD_URL, vad_path, sha256=VAD_SHA256)

    kokoro_dir = sherpa_root / KOKORO_NAME
    if not kokoro_dir.is_dir():
        archive = sherpa_root / f"{KOKORO_NAME}.tar.bz2"
        download(KOKORO_URL, archive, sha256=KOKORO_ARCHIVE_SHA256)
        with tempfile.TemporaryDirectory(prefix="ultron-kokoro-", dir=sherpa_root) as temporary:
            temporary_root = Path(temporary)
            with tarfile.open(archive, "r:bz2") as bundle:
                bundle.extractall(temporary_root, filter="data")
            extracted = temporary_root / KOKORO_NAME
            if not extracted.is_dir():
                raise RuntimeError(f"Archive did not contain {KOKORO_NAME}")
            shutil.move(str(extracted), str(kokoro_dir))
        archive.unlink(missing_ok=True)
    else:
        print(f"Already extracted: {kokoro_dir}")

    validate_models(model_root)
    print(f"Stage 3 models verified in {sherpa_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
