from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from voice.download_stage3_models import download, verify_sha256


class ModelDownloadIntegrityTests(unittest.TestCase):
    def test_existing_artifact_requires_matching_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "model.bin"
            artifact.write_bytes(b"reviewed model bytes")
            expected = hashlib.sha256(artifact.read_bytes()).hexdigest()
            download("https://invalid.example/model", artifact, sha256=expected)
            with self.assertRaises(RuntimeError):
                download("https://invalid.example/model", artifact, sha256="0" * 64)

    def test_checksum_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "model.bin"
            artifact.write_bytes(b"unexpected")
            with self.assertRaises(RuntimeError):
                verify_sha256(artifact, hashlib.sha256(b"expected").hexdigest())


if __name__ == "__main__":
    unittest.main()
