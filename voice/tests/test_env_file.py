from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from voice.local_endpoint import load_project_env


class ProjectEnvTests(unittest.TestCase):
    def test_allowlisted_values_fill_gaps_without_loading_secrets_or_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env.local"
            env_file.write_text(
                "\n".join(
                    [
                        "# comment",
                        "OPENAI_API_KEY=sk-test-secret",
                        "GITHUB_TOKEN=ghp-test-secret",
                        'ULTRON_SPEAKER_NAME="Test User"',
                        "ULTRON_LOCAL_BASE_URL=http://localhost:3010",
                        "ULTRON_TIMEZONE=",
                        "export ULTRON_VOICE_MODEL_DIR=/tmp/models",
                        "ULTRON_LOCAL_EVENT_TOKEN=already-set-should-win",
                        "ULTRON_VOICE_FOLLOW_UP_TURNS=2",
                    ]
                ),
                encoding="utf-8",
            )
            environ = {"ULTRON_LOCAL_EVENT_TOKEN": "launcher-token"}
            applied = load_project_env(env_file, environ)

        self.assertEqual(applied, ["ULTRON_SPEAKER_NAME", "ULTRON_LOCAL_BASE_URL", "ULTRON_VOICE_MODEL_DIR", "ULTRON_VOICE_FOLLOW_UP_TURNS"])
        self.assertEqual(environ["ULTRON_SPEAKER_NAME"], "Test User")
        self.assertEqual(environ["ULTRON_LOCAL_BASE_URL"], "http://localhost:3010")
        self.assertEqual(environ["ULTRON_LOCAL_EVENT_TOKEN"], "launcher-token")
        self.assertEqual(environ["ULTRON_VOICE_FOLLOW_UP_TURNS"], "2")
        self.assertNotIn("OPENAI_API_KEY", environ)
        self.assertNotIn("GITHUB_TOKEN", environ)
        self.assertNotIn("ULTRON_TIMEZONE", environ)
