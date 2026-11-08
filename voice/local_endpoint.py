"""Resolve the shared loopback address for Ultron's native components."""

import os
from pathlib import Path
from urllib.parse import urlparse

# The voice process must not receive cloud or repository credentials.
PROJECT_ENV_ALLOWLIST = frozenset(
    {
        "ULTRON_SPEAKER_NAME",
        "ULTRON_LOCAL_BASE_URL",
        "ULTRON_VOICE_MODEL_DIR",
        "ULTRON_VOICE_PYTHON",
        "ULTRON_TIMEZONE",
        "ULTRON_LOCAL_EVENT_TOKEN",
        "ULTRON_VOICE_FOLLOW_UP_TURNS",
        "ULTRON_VOICE_STT_MODEL",
    }
)


def local_base_url() -> str:
    value = os.environ.get("ULTRON_LOCAL_BASE_URL", "http://localhost:3000").rstrip("/")
    parsed = urlparse(value)
    if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ValueError("ULTRON_LOCAL_BASE_URL must be a loopback HTTP origin")
    port = parsed.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("Ultron local port is invalid")
    return value


def load_project_env(path: Path, environ: dict[str, str] | None = None) -> list[str]:
    """Fill missing allowlisted variables from a local env file.

    Existing values win. Secrets outside the allowlist are ignored. The return
    value is the list of keys applied, never their values.
    """

    target = os.environ if environ is None else environ
    applied: list[str] = []
    if not path.is_file():
        return applied
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in PROJECT_ENV_ALLOWLIST or target.get(key, "").strip():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if not value:
            continue
        target[key] = value
        applied.append(key)
    return applied
