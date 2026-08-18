"""CLI skeleton for multi-sample local speaker enrollment.

No embedding model is chosen here. A trusted local backend must be injected by
the future voice controller; this command never treats raw audio as a profile.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Mapping, Sequence, TextIO

from .speaker import (
    MINIMUM_ENROLLMENT_SAMPLES,
    EnrollmentService,
    SpeakerEmbeddingBackend,
    SpeakerProfileStore,
    resolve_speaker_name,
)


def run_enrollment(
    argv: Sequence[str],
    *,
    backend: SpeakerEmbeddingBackend | None = None,
    store: SpeakerProfileStore | None = None,
    output: TextIO = sys.stdout,
    environment: Mapping[str, str] | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name")
    parser.add_argument("--sample", action="append", type=Path, default=[])
    args = parser.parse_args(list(argv))

    try:
        speaker_name = resolve_speaker_name(args.name, environment=environment)
    except ValueError as error:
        print(f"Enrollment refused: {error}.", file=output)
        return 2
    if len(args.sample) < MINIMUM_ENROLLMENT_SAMPLES:
        print(
            f"Enrollment refused: provide at least {MINIMUM_ENROLLMENT_SAMPLES} varied audio samples.",
            file=output,
        )
        return 2
    if backend is None or store is None:
        print(
            "Enrollment unavailable: no reviewed local speaker-embedding backend and protected store are configured.",
            file=output,
        )
        return 2

    profile = EnrollmentService(backend, store).enroll(speaker_name, args.sample)
    print(f"Speaker enrolled: {profile.display_name}", file=output)
    print(f"Samples used: {profile.sample_count}; raw audio was not stored in the profile.", file=output)
    return 0


def main() -> int:
    from .sherpa_speaker import SherpaOnnxSpeakerEmbeddingBackend
    from .speaker import EncryptedFileSpeakerProfileStore

    try:
        backend = SherpaOnnxSpeakerEmbeddingBackend()
        store = EncryptedFileSpeakerProfileStore.windows_default()
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
        print(f"Enrollment unavailable: {error}")
        print("Run: python -m voice.download_speaker_model")
        return 2
    return run_enrollment(sys.argv[1:], backend=backend, store=store)


if __name__ == "__main__":
    raise SystemExit(main())
