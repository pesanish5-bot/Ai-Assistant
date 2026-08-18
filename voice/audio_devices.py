"""Local audio-device selection shared by activation and conversation capture."""

from __future__ import annotations

import re
from typing import Sequence


_GENERIC_AUDIO_TOKENS = {
    "audio", "device", "headphone", "headphones", "headset", "input",
    "microphone", "output", "primary", "sound", "windows",
}


def select_preferred_input_device(default_pair: object, devices: Sequence[object]) -> int | None:
    """Prefer the mic matching an active headset output, otherwise the default input."""

    try:
        default_input = int(default_pair[0])  # type: ignore[index]
        default_output = int(default_pair[1])  # type: ignore[index]
    except (IndexError, TypeError, ValueError):
        return None
    if not 0 <= default_output < len(devices):
        return default_input if default_input >= 0 else None
    output = devices[default_output]
    output_name = str(output["name"]).casefold()  # type: ignore[index]
    if "headphone" not in output_name and "headset" not in output_name:
        return default_input if default_input >= 0 else None
    output_tokens = set(re.findall(r"[a-z0-9]+", output_name)) - _GENERIC_AUDIO_TOKENS
    output_host = output["hostapi"]  # type: ignore[index]
    best_index: int | None = None
    best_score = 0
    for index, candidate in enumerate(devices):
        if int(candidate["max_input_channels"]) < 1:  # type: ignore[index]
            continue
        if candidate["hostapi"] != output_host:  # type: ignore[index]
            continue
        candidate_tokens = set(
            re.findall(r"[a-z0-9]+", str(candidate["name"]).casefold())  # type: ignore[index]
        ) - _GENERIC_AUDIO_TOKENS
        score = len(output_tokens & candidate_tokens)
        if score > best_score:
            best_index, best_score = index, score
    return best_index if best_index is not None and best_score > 0 else (
        default_input if default_input >= 0 else None
    )


def default_input_device(sounddevice: object) -> int | None:
    pair = sounddevice.default.device  # type: ignore[attr-defined]
    try:
        index = int(pair[0])  # type: ignore[index]
    except (IndexError, TypeError, ValueError):
        return None
    return index if index >= 0 else None


def preferred_input_device(sounddevice: object) -> int | None:
    return select_preferred_input_device(
        sounddevice.default.device,  # type: ignore[attr-defined]
        sounddevice.query_devices(),  # type: ignore[attr-defined]
    )
