"""Measure local clap features without saving or transmitting microphone audio."""

from __future__ import annotations

import argparse
import heapq
import time

from .background_agent import SoundDeviceFrameSource
from .clap import extract_audio_features


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", type=int)
    parser.add_argument("--seconds", type=float, default=12.0)
    args = parser.parse_args()
    source = SoundDeviceFrameSource(device=args.device)
    strongest: list[tuple[float, int, object]] = []
    sequence = 0
    source.open()
    started = time.monotonic()
    print("CLAP NOW: make several double claps. Audio is analyzed in memory only.", flush=True)
    try:
        while time.monotonic() - started < args.seconds:
            frame = source.read()
            features = extract_audio_features(frame.samples, frame.sample_rate)
            sequence += 1
            item = (features.peak, sequence, features)
            if len(strongest) < 20:
                heapq.heappush(strongest, item)
            elif item > strongest[0]:
                heapq.heapreplace(strongest, item)
    finally:
        source.close()

    print("Strongest frames (peak descending):", flush=True)
    for _peak, _sequence, features in sorted(strongest, reverse=True):
        print(
            f"rms={features.rms:.4f} peak={features.peak:.4f} "
            f"crest={features.crest_factor:.2f} flat={features.spectral_flatness:.3f} "
            f"high={features.high_band_ratio:.3f} centroid={features.spectral_centroid_ratio:.3f}",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
