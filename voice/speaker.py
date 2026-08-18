"""Speaker-verification interfaces, protected profiles, and enrollment logic."""

from __future__ import annotations

import json
import hashlib
import math
import os
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping, Protocol, Sequence
from uuid import uuid4

from .protection import DataProtector, WindowsUserDpapiProtector, default_auth_directory


MINIMUM_ENROLLMENT_SAMPLES = 3
SPEAKER_NAME_ENV = "ULTRON_SPEAKER_NAME"


def resolve_speaker_name(
    explicit_name: str | None = None,
    *,
    environment: Mapping[str, str] | None = None,
) -> str:
    """Resolve an explicitly configured speaker name or fail closed."""

    source = environment if environment is not None else os.environ
    candidate = explicit_name if explicit_name is not None else source.get(SPEAKER_NAME_ENV)
    name = candidate.strip() if candidate else ""
    if not name:
        raise ValueError(
            f"speaker identity is not configured; pass --name or set {SPEAKER_NAME_ENV}"
        )
    return name


def speaker_profile_id(display_name: str) -> str:
    """Return the stable protected-profile identifier for a display name."""

    name = display_name.strip()
    if not name:
        raise ValueError("speaker name is required")
    ascii_name = (
        unicodedata.normalize("NFKD", name)
        .encode("ascii", errors="ignore")
        .decode("ascii")
        .casefold()
    )
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")[:64]
    if slug:
        return slug
    digest = hashlib.sha256(name.casefold().encode("utf-8")).hexdigest()[:16]
    return f"speaker-{digest}"


class SpeakerEmbeddingBackend(Protocol):
    model_id: str

    def embedding_from_file(self, audio_path: Path) -> Sequence[float]: ...


class SpeakerVerifier(Protocol):
    def similarity(self, profile: "SpeakerProfile", candidate_embedding: Sequence[float]) -> float: ...


class LivenessDetector(Protocol):
    def confidence(self, audio_path: Path, expected_challenge: str) -> float: ...


class SpeakerProfileStore(Protocol):
    def save(self, profile: "SpeakerProfile") -> None: ...

    def load(self, profile_id: str) -> "SpeakerProfile": ...


@dataclass(frozen=True, slots=True)
class SpeakerProfile:
    profile_id: str
    display_name: str
    model_id: str
    embedding: tuple[float, ...]
    sample_count: int
    created_at: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", self.profile_id):
            raise ValueError("profile_id is invalid")
        if not self.display_name.strip() or not self.model_id.strip():
            raise ValueError("profile name and model are required")
        if self.sample_count < MINIMUM_ENROLLMENT_SAMPLES:
            raise ValueError("speaker profiles require multiple enrollment samples")
        if not self.embedding or any(not math.isfinite(value) for value in self.embedding):
            raise ValueError("speaker embedding must contain finite values")


@dataclass(slots=True)
class CosineSpeakerVerifier:
    def similarity(self, profile: SpeakerProfile, candidate_embedding: Sequence[float]) -> float:
        candidate = _validated_embedding(candidate_embedding)
        if len(candidate) != len(profile.embedding):
            return -1.0
        dot = sum(left * right for left, right in zip(profile.embedding, candidate))
        left_norm = math.sqrt(sum(value * value for value in profile.embedding))
        right_norm = math.sqrt(sum(value * value for value in candidate))
        if left_norm <= 1e-12 or right_norm <= 1e-12:
            return -1.0
        return max(-1.0, min(1.0, dot / (left_norm * right_norm)))


@dataclass(slots=True)
class MockSpeakerVerifier:
    score: float

    def similarity(self, profile: SpeakerProfile, candidate_embedding: Sequence[float]) -> float:
        return self.score


@dataclass(slots=True)
class MockLivenessDetector:
    score: float

    def confidence(self, audio_path: Path, expected_challenge: str) -> float:
        return self.score


@dataclass(slots=True)
class MemorySpeakerProfileStore:
    profiles: dict[str, SpeakerProfile] = field(default_factory=dict)

    def save(self, profile: SpeakerProfile) -> None:
        self.profiles[profile.profile_id] = profile

    def load(self, profile_id: str) -> SpeakerProfile:
        return self.profiles[profile_id]


@dataclass(slots=True)
class EncryptedFileSpeakerProfileStore:
    root: Path
    protector: DataProtector

    def save(self, profile: SpeakerProfile) -> None:
        path = self._path(profile.profile_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = asdict(profile)
        payload["embedding"] = list(profile.embedding)
        plaintext = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        protected = self.protector.protect(plaintext)
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            with temporary.open("xb") as output:
                output.write(protected)
                output.flush()
                os.fsync(output.fileno())
            try:
                os.chmod(temporary, 0o600)
            except OSError:
                pass
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self, profile_id: str) -> SpeakerProfile:
        plaintext = self.protector.unprotect(self._path(profile_id).read_bytes())
        payload = json.loads(plaintext)
        allowed = {"profile_id", "display_name", "model_id", "embedding", "sample_count", "created_at"}
        if set(payload) != allowed:
            raise ValueError("speaker profile contains unexpected fields")
        return SpeakerProfile(
            profile_id=str(payload["profile_id"]),
            display_name=str(payload["display_name"]),
            model_id=str(payload["model_id"]),
            embedding=tuple(float(value) for value in payload["embedding"]),
            sample_count=int(payload["sample_count"]),
            created_at=str(payload["created_at"]),
        )

    def _path(self, profile_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", profile_id):
            raise ValueError("profile_id is invalid")
        return self.root / f"{profile_id}.dpapi.profile"

    @classmethod
    def windows_default(cls) -> "EncryptedFileSpeakerProfileStore":
        return cls(
            Path(default_auth_directory()) / "speaker-profiles",
            WindowsUserDpapiProtector(),
        )


@dataclass(slots=True)
class EnrollmentService:
    backend: SpeakerEmbeddingBackend
    store: SpeakerProfileStore

    def enroll(self, display_name: str, audio_paths: Sequence[Path]) -> SpeakerProfile:
        if len(audio_paths) < MINIMUM_ENROLLMENT_SAMPLES:
            raise ValueError(
                f"speaker enrollment requires at least {MINIMUM_ENROLLMENT_SAMPLES} varied samples"
            )
        embeddings: list[tuple[float, ...]] = []
        for audio_path in audio_paths:
            if not audio_path.is_file():
                raise FileNotFoundError(audio_path)
            embeddings.append(_validated_embedding(self.backend.embedding_from_file(audio_path)))
        dimensions = {len(embedding) for embedding in embeddings}
        if len(dimensions) != 1:
            raise ValueError("speaker embeddings have inconsistent dimensions")

        centroid = [sum(values) / len(embeddings) for values in zip(*embeddings)]
        norm = math.sqrt(sum(value * value for value in centroid))
        if norm <= 1e-12:
            raise ValueError("speaker enrollment produced an empty profile")
        normalized = tuple(value / norm for value in centroid)
        display_name = display_name.strip()
        profile_id = speaker_profile_id(display_name)
        profile = SpeakerProfile(
            profile_id=profile_id,
            display_name=display_name,
            model_id=self.backend.model_id,
            embedding=normalized,
            sample_count=len(audio_paths),
            created_at=datetime.now(UTC).isoformat(),
        )
        self.store.save(profile)
        return profile


def _validated_embedding(values: Sequence[float]) -> tuple[float, ...]:
    embedding = tuple(float(value) for value in values)
    if not embedding or any(not math.isfinite(value) for value in embedding):
        raise ValueError("embedding must contain finite values")
    return embedding
