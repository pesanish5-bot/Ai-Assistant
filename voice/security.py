"""Challenge generation, attempt throttling, and protected security events."""

from __future__ import annotations

import base64
import json
import math
import os
import random
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .protection import DataProtector, WindowsUserDpapiProtector, default_auth_directory


def normalize_phrase(value: str) -> str:
    words = re.findall(r"[a-z0-9]+", value.casefold())
    return " ".join(words)


@dataclass(frozen=True, slots=True)
class Challenge:
    phrase: str
    issued_at: float


@dataclass(slots=True)
class ChallengeGenerator:
    # Five words from 128 distinct tokens yields about 34.8 bits of challenge
    # entropy (ordered sampling without replacement). This is still only one
    # layer of the local prototype, but is materially harder to pre-record or
    # splice than the former 3-of-12 vocabulary.
    token_count: int = 5
    random_source: random.Random = field(default_factory=secrets.SystemRandom)
    vocabulary: tuple[str, ...] = (
        "seven",
        "amber",
        "delta",
        "four",
        "cedar",
        "north",
        "nine",
        "silver",
        "river",
        "two",
        "violet",
        "orbit",
        "acorn",
        "alpine",
        "anchor",
        "apricot",
        "arrow",
        "atlas",
        "aurora",
        "badger",
        "bamboo",
        "beacon",
        "birch",
        "bison",
        "blue",
        "breeze",
        "bronze",
        "canyon",
        "cobalt",
        "comet",
        "coral",
        "cosmos",
        "crane",
        "crystal",
        "dawn",
        "denim",
        "drift",
        "eagle",
        "echo",
        "elm",
        "ember",
        "falcon",
        "fern",
        "fjord",
        "flint",
        "forest",
        "frost",
        "galaxy",
        "garden",
        "glacier",
        "granite",
        "harbor",
        "hazel",
        "heron",
        "horizon",
        "indigo",
        "island",
        "ivory",
        "jade",
        "jasmine",
        "juniper",
        "kite",
        "lagoon",
        "lark",
        "laurel",
        "lemon",
        "linen",
        "lotus",
        "lunar",
        "maple",
        "marble",
        "meadow",
        "mercury",
        "mesa",
        "meteor",
        "mint",
        "moss",
        "nebula",
        "oasis",
        "ocean",
        "olive",
        "onyx",
        "opal",
        "orchid",
        "otter",
        "pearl",
        "pepper",
        "pine",
        "plum",
        "prairie",
        "quartz",
        "raven",
        "redwood",
        "reef",
        "robin",
        "saffron",
        "sage",
        "saturn",
        "scarlet",
        "shadow",
        "sierra",
        "sky",
        "slate",
        "snow",
        "solar",
        "sparrow",
        "spruce",
        "stone",
        "storm",
        "summit",
        "sunset",
        "tango",
        "thistle",
        "timber",
        "topaz",
        "tundra",
        "valley",
        "velvet",
        "vermilion",
        "willow",
        "winter",
        "wren",
        "zephyr",
        "zero",
        "five",
        "six",
        "eight",
        "three",
    )

    def __post_init__(self) -> None:
        if self.token_count < 2:
            raise ValueError("challenge must contain at least two tokens")
        if self.token_count > len(self.vocabulary):
            raise ValueError("challenge vocabulary is too small")
        if len(set(self.vocabulary)) != len(self.vocabulary):
            raise ValueError("challenge vocabulary must contain unique tokens")

    def generate(self, timestamp: float) -> Challenge:
        if timestamp < 0:
            raise ValueError("timestamp must be non-negative")
        phrase = " ".join(self.random_source.sample(self.vocabulary, self.token_count))
        return Challenge(phrase=phrase, issued_at=timestamp)


@dataclass(frozen=True, slots=True)
class AttemptThrottleConfig:
    base_delay_seconds: float = 2.0
    maximum_delay_seconds: float = 60.0
    hard_lockout_after: int = 5
    hard_lockout_seconds: float = 300.0

    def __post_init__(self) -> None:
        if self.base_delay_seconds <= 0 or self.maximum_delay_seconds <= 0:
            raise ValueError("throttle delays must be positive")
        if self.base_delay_seconds > self.maximum_delay_seconds:
            raise ValueError("base delay cannot exceed maximum delay")
        if self.hard_lockout_after < 2 or self.hard_lockout_seconds <= 0:
            raise ValueError("hard lockout configuration is invalid")


@dataclass(slots=True)
class AttemptThrottler:
    config: AttemptThrottleConfig = field(default_factory=AttemptThrottleConfig)
    consecutive_failures: int = field(default=0, init=False)
    blocked_until: float = field(default=0.0, init=False)

    def can_attempt(self, timestamp: float) -> bool:
        self._validate_time(timestamp)
        return timestamp >= self.blocked_until

    def retry_after(self, timestamp: float) -> float:
        self._validate_time(timestamp)
        return max(0.0, self.blocked_until - timestamp)

    def record_failure(self, timestamp: float) -> float:
        self._validate_time(timestamp)
        self.consecutive_failures += 1
        if self.consecutive_failures >= self.config.hard_lockout_after:
            delay = self.config.hard_lockout_seconds
        else:
            delay = min(
                self.config.maximum_delay_seconds,
                self.config.base_delay_seconds * 2 ** (self.consecutive_failures - 1),
            )
        self.blocked_until = max(self.blocked_until, timestamp + delay)
        return delay

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.blocked_until = 0.0

    @staticmethod
    def _validate_time(timestamp: float) -> None:
        if not math.isfinite(timestamp) or timestamp < 0:
            raise ValueError("timestamp must be finite and non-negative")


class ProtectedAttemptThrottler(AttemptThrottler):
    """Persist retry state with current-user DPAPI across host restarts."""

    __slots__ = ("path", "protector")

    def __init__(
        self,
        path: Path,
        protector: DataProtector,
        config: AttemptThrottleConfig | None = None,
    ) -> None:
        super().__init__(config or AttemptThrottleConfig())
        self.path = path
        self.protector = protector
        self._load()

    def record_failure(self, timestamp: float) -> float:
        delay = super().record_failure(timestamp)
        self._persist()
        return delay

    def record_success(self) -> None:
        super().record_success()
        self._persist()

    def _load(self) -> None:
        if not self.path.exists():
            return
        plaintext = self.protector.unprotect(self.path.read_bytes())
        payload = json.loads(plaintext)
        if set(payload) != {"version", "consecutive_failures", "blocked_until"}:
            raise ValueError("protected throttle state contains unexpected fields")
        if payload["version"] != 1:
            raise ValueError("protected throttle state version is unsupported")
        failures = int(payload["consecutive_failures"])
        blocked_until = float(payload["blocked_until"])
        if failures < 0 or not math.isfinite(blocked_until) or blocked_until < 0:
            raise ValueError("protected throttle state is invalid")
        self.consecutive_failures = failures
        self.blocked_until = blocked_until

    def _persist(self) -> None:
        payload = {
            "version": 1,
            "consecutive_failures": self.consecutive_failures,
            "blocked_until": self.blocked_until,
        }
        protected = self.protector.protect(
            json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as output:
                output.write(protected)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    @classmethod
    def windows_default(cls) -> "ProtectedAttemptThrottler":
        return cls(
            Path(default_auth_directory()) / "attempt-throttle.dpapi.state",
            WindowsUserDpapiProtector(),
        )


SAFE_SECURITY_FIELDS = frozenset(
    {
        "activation_method",
        "session_state",
        "speaker_verified",
        "challenge_passed",
        "liveness_passed",
        "outcome",
        "attempt_number",
        "reason_code",
        "os_unlock_attempted",
    }
)


class SecurityEventSink(Protocol):
    def record(self, event: str, timestamp: float, **fields: object) -> None: ...


@dataclass(slots=True)
class MemorySecurityEventLog:
    events: list[dict[str, object]] = field(default_factory=list)

    def record(self, event: str, timestamp: float, **fields: object) -> None:
        self.events.append(_safe_event(event, timestamp, fields))


@dataclass(slots=True)
class ProtectedSecurityEventLog:
    path: Path
    protector: DataProtector

    def record(self, event: str, timestamp: float, **fields: object) -> None:
        payload = _safe_event(event, timestamp, fields)
        plaintext = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode()
        protected = self.protector.protect(plaintext)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("ab") as output:
            output.write(base64.b64encode(protected) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def read_events(self) -> list[dict[str, object]]:
        if not self.path.exists():
            return []
        events: list[dict[str, object]] = []
        for line in self.path.read_bytes().splitlines():
            plaintext = self.protector.unprotect(base64.b64decode(line, validate=True))
            events.append(json.loads(plaintext))
        return events

    @classmethod
    def windows_default(cls) -> "ProtectedSecurityEventLog":
        return cls(
            Path(default_auth_directory()) / "security-events.dpapi.jsonl",
            WindowsUserDpapiProtector(),
        )


def _safe_event(event: str, timestamp: float, fields: dict[str, object]) -> dict[str, object]:
    if not event or not re.fullmatch(r"[a-z0-9_.-]+", event):
        raise ValueError("security event name is invalid")
    if not math.isfinite(timestamp) or timestamp < 0:
        raise ValueError("timestamp must be finite and non-negative")
    unsafe = set(fields) - SAFE_SECURITY_FIELDS
    if unsafe:
        raise ValueError(f"unsafe security event fields: {', '.join(sorted(unsafe))}")
    payload: dict[str, object] = {
        "timestamp": datetime.fromtimestamp(timestamp, UTC).isoformat(),
        "event": event,
    }
    for key, value in fields.items():
        if not isinstance(value, (str, int, float, bool, type(None))):
            raise TypeError(f"security event field {key} must be scalar")
        payload[key] = value
    return payload
