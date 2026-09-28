"""Resolve the shared loopback address for Ultron's native components."""

import os
from urllib.parse import urlparse


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
