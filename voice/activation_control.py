"""Private local switch shared with the HUD; no microphone data is stored here."""

from __future__ import annotations

import json
from pathlib import Path


def activation_control_path() -> Path:
    return Path(__file__).resolve().parents[1] / ".ultron" / "runtime" / "activation-control.json"


def activation_enabled(path: Path | None = None) -> bool:
    target = path or activation_control_path()
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        return False
    return type(value) is dict and value.get("enabled") is True
