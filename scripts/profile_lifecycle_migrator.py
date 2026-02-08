#!/usr/bin/env python3
import argparse
import copy
import json
import os
import sys

LIFECYCLE_DEFAULTS = {
    "enabled": True,
    "require_owner_approval_for_risk_writes": True,
    "require_challenge_before_approval": True,
    "heartbeat_timeout_minutes": 180,
}


class MigrationResult:
    def __init__(self, status, message):
        self.status = status
        self.message = message


def migrate_profile_file(profile_path):
    if not os.path.isfile(profile_path):
        return MigrationResult("missing", f"PROFILE not found: {profile_path}")

    try:
        with open(profile_path, "r", encoding="utf-8") as handle:
            profile = json.load(handle)
    except json.JSONDecodeError as exc:
        return MigrationResult("invalid_json", f"Invalid PROFILE.json: {exc}")
    except OSError as exc:
        return MigrationResult("io_error", f"Failed to read PROFILE.json: {exc}")

    if not isinstance(profile, dict):
        return MigrationResult("invalid_root", "PROFILE root must be a JSON object.")

    lifecycle = profile.get("lifecycle")
    changed = False
    status = "unchanged"

    if lifecycle is None:
        profile["lifecycle"] = copy.deepcopy(LIFECYCLE_DEFAULTS)
        changed = True
        status = "added"
    elif isinstance(lifecycle, dict):
        merged = dict(lifecycle)
        for key, value in LIFECYCLE_DEFAULTS.items():
            if key not in merged:
                merged[key] = value
                changed = True
        if changed:
            profile["lifecycle"] = merged
            status = "patched"
    else:
        return MigrationResult(
            "invalid_lifecycle_type",
            "PROFILE.lifecycle must be an object when present.",
        )

    if changed:
        try:
            with open(profile_path, "w", encoding="utf-8") as handle:
                json.dump(profile, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
        except OSError as exc:
            return MigrationResult("io_error", f"Failed to write PROFILE.json: {exc}")

    messages = {
        "added": "Lifecycle config added to docs/PROFILE.json.",
        "patched": "Lifecycle config patched in docs/PROFILE.json (missing keys filled).",
        "unchanged": "Lifecycle config already present in docs/PROFILE.json.",
    }
    return MigrationResult(status, messages.get(status, status))


def build_parser():
    parser = argparse.ArgumentParser(description="Migrate PROFILE.json lifecycle section.")
    parser.add_argument(
        "--profile",
        required=True,
        help="Path to docs/PROFILE.json",
    )
    return parser


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = build_parser()
    args = parser.parse_args(argv)

    result = migrate_profile_file(args.profile)
    print(result.message)

    if result.status in {"added", "patched", "unchanged", "missing"}:
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
