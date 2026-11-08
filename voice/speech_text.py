"""Turn display-oriented answers into short, pronounceable local TTS text."""

from __future__ import annotations

import re
from typing import Iterator


_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?…])(?:[\"')\]]+)?(?:\s+|$)")


def iter_speakable_units(chunks: Iterator[str], *, soft_limit: int = 110) -> Iterator[str]:
    """Yield complete sentences as streamed text arrives; flush a long clause if needed."""

    if soft_limit < 40:
        raise ValueError("soft_limit is too small")
    buffer = ""
    for chunk in chunks:
        if not chunk:
            continue
        buffer += chunk
        while True:
            match = _SENTENCE_BOUNDARY.search(buffer)
            if match:
                unit = buffer[: match.end()].strip()
                buffer = buffer[match.end() :]
                if unit:
                    yield unit
                continue
            if len(buffer) >= soft_limit:
                split_at = max(buffer.rfind(", "), buffer.rfind("; "), buffer.rfind(" "))
                if split_at < soft_limit // 3:
                    break
                unit = buffer[:split_at].strip()
                buffer = buffer[split_at + 1 :].lstrip()
                if unit:
                    yield unit
                continue
            break
    if buffer.strip():
        yield buffer.strip()


def for_speech(text: str, *, max_characters: int = 900) -> str:
    if max_characters < 80:
        raise ValueError("speech limit is too small")
    spoken = re.sub(r"```[\s\S]*?```", " Code is shown on screen. ", text)
    spoken = re.sub(r"`([^`]+)`", r"\1", spoken)
    spoken = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", spoken)
    spoken = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", spoken)
    spoken = re.sub(r"https?://\S+", " a link shown on screen ", spoken)
    spoken = re.sub(r"(?m)^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+|>\s*)", "", spoken)
    spoken = re.sub(r"[*_~]+", "", spoken)
    spoken = re.sub(r"\s+", " ", spoken).strip()
    if not spoken:
        return "I put the details on screen."
    if len(spoken) > max_characters:
        boundary = max(spoken.rfind(". ", 0, max_characters), spoken.rfind("? ", 0, max_characters))
        spoken = spoken[: boundary + 1 if boundary > max_characters // 2 else max_characters].rstrip()
        spoken += " You can read the rest on screen."
    return spoken
