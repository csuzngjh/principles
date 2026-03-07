#!/usr/bin/env python3
import json
import os
import shutil
import tempfile
import unittest
import sys
from pathlib import Path

# Fix for imports
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
sys.path.append(str(PROJECT_ROOT / "hooks"))

class TestUserContextPreservation(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.docs_dir = os.path.join(self.test_dir, "docs")
        os.makedirs(self.docs_dir)
        self.profile_path = os.path.join(self.docs_dir, "USER_PROFILE.json")
        self.context_path = os.path.join(self.docs_dir, "USER_CONTEXT.md")
        
        # 1. Prepare JSON (Target State)
        self.new_profile = {
            "domains": {"Automation": 15},
            "preferences": {"mode": "expert"},
            "achievements": []
        }
        with open(self.profile_path, "w", encoding="utf-8") as f:
            json.dump(self.new_profile, f)

        # 2. Prepare MD with Manual section
        self.manual_content = "### Manual Rules\n- Never use npm\n- Always use pnpm"
        self.marker = "<!-- MANUAL_START -->"
        initial_md = f"Old Header\n\n{self.marker}\n{self.manual_content}"
        
        with open(self.context_path, "w", encoding="utf-8") as f:
            f.write(initial_md)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_logic(self):
        import hook_runner
        # Run sync
        hook_runner.sync_user_context({}, self.test_dir)
        
        # Read back
        with open(self.context_path, "r", encoding="utf-8") as f:
            result = f.read()
            
        print("\n--- TEST RESULT ---")
        print(result)
        print("-------------------\n")

        # Verify system part updated
        self.assertIn("- **Automation**: [Expert] (Score: 15)", result)
        self.assertIn("- **mode**: expert", result)
        
        # Verify manual part preserved
        self.assertIn(self.marker, result)
        self.assertIn("- Never use npm", result)
        
        # Verify old system part gone
        self.assertNotIn("Old Header", result)

if __name__ == "__main__":
    unittest.main()