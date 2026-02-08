#!/usr/bin/env python3
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts import profile_lifecycle_migrator


class TestProfileLifecycleMigrator(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.profile_path = os.path.join(self.test_dir, "PROFILE.json")

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _write_profile(self, data):
        with open(self.profile_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)

    def _read_profile(self):
        with open(self.profile_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def test_adds_lifecycle_when_missing(self):
        self._write_profile({"audit_level": "medium"})
        result = profile_lifecycle_migrator.migrate_profile_file(self.profile_path)
        self.assertEqual(result.status, "added")
        profile = self._read_profile()
        self.assertIn("lifecycle", profile)
        self.assertTrue(profile["lifecycle"]["enabled"])

    def test_patches_missing_lifecycle_fields(self):
        self._write_profile({"lifecycle": {"enabled": False}})
        result = profile_lifecycle_migrator.migrate_profile_file(self.profile_path)
        self.assertEqual(result.status, "patched")
        profile = self._read_profile()
        self.assertEqual(profile["lifecycle"]["enabled"], False)
        self.assertIn("heartbeat_timeout_minutes", profile["lifecycle"])

    def test_keeps_profile_when_lifecycle_complete(self):
        self._write_profile(
            {
                "lifecycle": {
                    "enabled": True,
                    "require_owner_approval_for_risk_writes": True,
                    "require_challenge_before_approval": True,
                    "heartbeat_timeout_minutes": 120,
                }
            }
        )
        result = profile_lifecycle_migrator.migrate_profile_file(self.profile_path)
        self.assertEqual(result.status, "unchanged")
        profile = self._read_profile()
        self.assertEqual(profile["lifecycle"]["heartbeat_timeout_minutes"], 120)

    def test_reports_invalid_json(self):
        with open(self.profile_path, "w", encoding="utf-8") as handle:
            handle.write("{ invalid")
        result = profile_lifecycle_migrator.migrate_profile_file(self.profile_path)
        self.assertEqual(result.status, "invalid_json")

    def test_reports_invalid_lifecycle_type(self):
        self._write_profile({"lifecycle": "enabled"})
        result = profile_lifecycle_migrator.migrate_profile_file(self.profile_path)
        self.assertEqual(result.status, "invalid_lifecycle_type")


if __name__ == "__main__":
    unittest.main()
