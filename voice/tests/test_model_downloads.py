from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from voice.download_stage3_models import download, verify_sha256


class ModelDownloadIntegrityTests(unittest.TestCase):
    def test_existing_artifact_is_reused_only_when_checksum_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "model.bin"
            artifact.write_bytes(b"reviewed model bytes")
            expected = hashlib.sha256(artifact.read_bytes()).hexdigest()
            download("https://invalid.example/model", artifact, sha256=expected)

    def test_corrupt_cached_artifact_is_replaced_only_after_verified_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "model.bin"
            artifact.write_bytes(b"")
            payload = b"reviewed model bytes"
            expected = hashlib.sha256(payload).hexdigest()
            response = io.BytesIO(payload)
            response.headers = {"Content-Length": str(len(payload))}
            with patch("voice.download_stage3_models.urllib.request.urlopen", return_value=response):
                download("https://invalid.example/model", artifact, sha256=expected)
            self.assertEqual(artifact.read_bytes(), payload)
            self.assertFalse(artifact.with_suffix(".bin.part").exists())

    def test_failed_replacement_preserves_existing_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "model.bin"
            artifact.write_bytes(b"old corrupt cache")
            response = io.BytesIO(b"another corrupt download")
            response.headers = {}
            with patch("voice.download_stage3_models.urllib.request.urlopen", return_value=response):
                with self.assertRaises(RuntimeError):
                    download("https://invalid.example/model", artifact, sha256="0" * 64)
            self.assertEqual(artifact.read_bytes(), b"old corrupt cache")
            self.assertFalse(artifact.with_suffix(".bin.part").exists())

    def test_checksum_mismatch_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "model.bin"
            artifact.write_bytes(b"unexpected")
            with self.assertRaises(RuntimeError):
                verify_sha256(artifact, hashlib.sha256(b"expected").hexdigest())


if __name__ == "__main__":
    unittest.main()
