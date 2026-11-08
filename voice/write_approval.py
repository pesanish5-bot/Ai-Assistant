"""Voice-side helpers for trusted reversible write approval."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from .local_endpoint import local_base_url

_APPROVAL_PATTERN = re.compile(
    r"^\s*(yes[,.]?\s+do\s+it|yes\s+please|approve(\s+it)?|go\s+ahead|confirm)\s*[.!?]?\s*$",
    re.IGNORECASE,
)


def is_voice_write_approval(transcript: str) -> bool:
    """Return True when the utterance is a short spoken approval phrase."""

    return bool(_APPROVAL_PATTERN.match(transcript or ""))


@dataclass(slots=True)
class PendingWriteApproval:
    challenge_id: str
    message: str
    risk: str
    scope: str
    description: str
    expires_at: str | None = None


class LocalWriteConfirmAdapter:
    """POST write confirmations with the launcher event bearer token."""

    def __init__(
        self,
        endpoint: str | None = None,
        token: str | None = None,
        timeout: float = 5.0,
    ) -> None:
        endpoint = endpoint if endpoint is not None else local_base_url() + "/api/permissions/write-confirm"
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Ultron write-confirm endpoint must be loopback HTTP")
        if parsed.path != "/api/permissions/write-confirm":
            raise ValueError("Ultron write-confirm endpoint path must be /api/permissions/write-confirm")
        resolved_token = token or os.environ.get("ULTRON_LOCAL_EVENT_TOKEN")
        if not resolved_token or len(resolved_token) < 32:
            raise ValueError("ULTRON_LOCAL_EVENT_TOKEN must contain at least 32 characters")
        self.endpoint = endpoint
        self.token = resolved_token
        self.timeout = timeout

    def approve(self, challenge_id: str, *, speaker_verified: bool) -> dict[str, object]:
        return self._decide(challenge_id, approve=True, speaker_verified=speaker_verified)

    def deny(self, challenge_id: str, *, speaker_verified: bool = False) -> dict[str, object]:
        return self._decide(challenge_id, approve=False, speaker_verified=speaker_verified)

    def _decide(self, challenge_id: str, *, approve: bool, speaker_verified: bool) -> dict[str, object]:
        payload = {
            "challengeId": challenge_id,
            "approve": approve,
            "method": "voice",
            "speakerVerified": speaker_verified,
        }
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                try:
                    body = json.load(error)
                except Exception as parse_error:
                    raise RuntimeError("Ultron write confirmation failed") from parse_error
            message = body.get("error") if isinstance(body, dict) else None
            raise RuntimeError(message if isinstance(message, str) and message.strip() else "Ultron write confirmation failed") from None
        if not isinstance(body, dict):
            raise RuntimeError("Ultron write confirmation returned an invalid response")
        return body
