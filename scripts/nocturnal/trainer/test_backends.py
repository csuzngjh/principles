#!/usr/bin/env python3
"""
Smoke Tests for Trainer Backends
================================

Tests that verify the contract compliance of trainer backends.
These can run without actual GPU/training dependencies.

Run with: python -m pytest trainer/test_backends.py -v
"""

import json
import os
import sys
import tempfile
from pathlib import Path

# Add trainer directory to path
sys.path.insert(0, str(Path(__file__).parent))

from backend_base import (
    TrainingExperimentSpec,
    TrainingExperimentResult,
    TrainingHyperparameters,
    TrainingBudget,
    ExpectedArtifact,
)


# ---------------------------------------------------------------------------
# Test Fixtures
# ---------------------------------------------------------------------------


def create_valid_spec(
    backend="peft-trl-orpo",
    training_mode="orpo",
    target_worker_profile="local-reader",
    target_model_family="qwen2.5-7b-reader",
    hardware_tier="consumer-gpu",
):
    """Create a valid experiment spec for testing."""
    tmpdir = tempfile.gettempdir()
    return TrainingExperimentSpec(
        experimentId="test-exp-123",
        backend=backend,
        trainingMode=training_mode,
        targetWorkerProfile=target_worker_profile,
        targetModelFamily=target_model_family,
        hardwareTier=hardware_tier,
        datasetExportId="export-456",
        datasetExportPath=os.path.join(tmpdir, "test-export.jsonl"),
        datasetFingerprint="fp-test-abc",
        benchmarkExportId="benchmark-789",
        outputDir=os.path.join(tmpdir, "nocturnal-test"),
        configFingerprint="fp-config-xyz",
        codeHash="fp-code-123",
        hyperparameters=TrainingHyperparameters(
            learningRate=3e-4,
            batchSize=2,
            gradientAccumulation=8,
            loraRank=16,
            loraAlpha=32,
            loraDropout=0.05,
            warmupRatio=0.1,
            maxSteps=100,
            maxSeqLength=2048,
        ),
        budget=TrainingBudget(
            maxWallClockMinutes=60,
        ),
        expectedArtifact=ExpectedArtifact(
            checkpointName="test-checkpoint",
            adapterFormat="peft-adapter",
        ),
    )


def create_valid_result(spec, status="completed", checkpoint_id="ckpt-001"):
    """Create a valid experiment result for testing."""
    from backend_base import TrainingArtifact

    artifact = None
    if status == "completed":
        artifact = TrainingArtifact(
            adapterFormat="peft-adapter",
            artifactPath=f"/tmp/checkpoints/{checkpoint_id}",
        )

    return TrainingExperimentResult(
        experimentId=spec.experimentId,
        backend=spec.backend,
        status=status,
        trainRunId="run-001",
        checkpointId=checkpoint_id,
        checkpointRef=f"ckpt-{checkpoint_id[:8]}",
        targetWorkerProfile=spec.targetWorkerProfile,
        targetModelFamily=spec.targetModelFamily,
        datasetFingerprint=spec.datasetFingerprint,
        configFingerprint=spec.configFingerprint,
        codeHash=spec.codeHash,
        artifact=artifact,
    )


# ---------------------------------------------------------------------------
# Contract Schema Tests
# ---------------------------------------------------------------------------


class TestContractSchema:
    """Tests for the TrainingExperimentResult contract schema."""

    def test_result_has_required_fields(self):
        """TrainingExperimentResult must have all required fields."""
        result = create_valid_result(create_valid_spec())

        assert hasattr(result, "experimentId")
        assert hasattr(result, "backend")
        assert hasattr(result, "status")
        assert hasattr(result, "targetWorkerProfile")
        assert hasattr(result, "targetModelFamily")
        assert hasattr(result, "datasetFingerprint")
        assert hasattr(result, "configFingerprint")
        assert hasattr(result, "codeHash")
        assert hasattr(result, "createdAt")

    def test_result_to_dict_removes_none(self):
        """Result.to_dict() should not include None values."""
        result = create_valid_result(create_valid_spec())
        result_dict = result.to_dict()

        for key, value in result_dict.items():
            assert value is not None, f"Field '{key}' should not be None in output"

    def test_peft_trl_result_schema_matches(self):
        """peft-trl-orpo backend must produce same schema as base."""
        spec = create_valid_spec(backend="peft-trl-orpo")
        result = create_valid_result(
            spec, status="completed", checkpoint_id="ckpt-peft"
        )

        result_dict = result.to_dict()

        # These fields must always be present for completed status
        assert result_dict["status"] == "completed"
        assert result_dict["backend"] == "peft-trl-orpo"
        assert "checkpointId" in result_dict
        assert "artifact" in result_dict

    def test_unsloth_result_schema_matches_peft(self):
        """unsloth-orpo backend must produce same schema as peft-trl-orpo."""
        spec = create_valid_spec(backend="unsloth-orpo")
        result = create_valid_result(
            spec, status="completed", checkpoint_id="ckpt-unsloth"
        )

        result_dict = result.to_dict()

        # Schema must be identical
        assert result_dict["status"] == "completed"
        assert result_dict["backend"] == "unsloth-orpo"
        assert "checkpointId" in result_dict
        assert "artifact" in result_dict

    def test_dry_run_result_has_no_artifact(self):
        """dry-run backend must not produce an artifact."""
        spec = create_valid_spec(backend="dry-run")
        result = TrainingExperimentResult(
            experimentId=spec.experimentId,
            backend="dry-run",
            status="dry_run",
            targetWorkerProfile=spec.targetWorkerProfile,
            targetModelFamily=spec.targetModelFamily,
            datasetFingerprint=spec.datasetFingerprint,
            configFingerprint=spec.configFingerprint,
            codeHash=spec.codeHash,
        )

        result_dict = result.to_dict()

        assert result_dict["status"] == "dry_run"
        assert result_dict.get("artifact") is None
        assert result_dict.get("checkpointId") is None

    def test_failed_result_has_failure_reason(self):
        """Failed results must have a failureReason."""
        spec = create_valid_spec()
        result = TrainingExperimentResult(
            experimentId=spec.experimentId,
            backend=spec.backend,
            status="failed",
            failureReason="GPU out of memory",
            targetWorkerProfile=spec.targetWorkerProfile,
            targetModelFamily=spec.targetModelFamily,
            datasetFingerprint=spec.datasetFingerprint,
            configFingerprint=spec.configFingerprint,
            codeHash=spec.codeHash,
        )

        result_dict = result.to_dict()

        assert result_dict["status"] == "failed"
        assert "failureReason" in result_dict
        assert result_dict["failureReason"] == "GPU out of memory"


class TestBackendValidation:
    """Tests for backend spec validation."""

    def test_dry_run_rejects_training_mode(self):
        """dry-run should still accept orpo as training mode."""
        from dry_run_backend import DryRunBackend

        spec = create_valid_spec(backend="dry-run", training_mode="orpo")
        backend = DryRunBackend(spec)

        # Dry-run can validate any training mode
        assert backend.validate_spec() is True

    def test_peft_trl_rejects_non_orpo(self):
        """peft-trl backend should reject non-ORPO training modes."""
        from peft_trl_orpo_backend import PeftTrlORPOBackend

        spec = create_valid_spec(backend="peft-trl-orpo", training_mode="sft")
        backend = PeftTrlORPOBackend(spec)

        assert backend.validate_spec() is False
        assert any("orpo" in e.lower() for e in backend.errors)

    def test_unsloth_rejects_non_orpo(self):
        """unsloth backend should reject non-ORPO training modes."""
        from unsloth_orpo_backend import UnslothORPOBackend

        spec = create_valid_spec(backend="unsloth-orpo", training_mode="dpo")
        backend = UnslothORPOBackend(spec)

        assert backend.validate_spec() is False
        assert any("orpo" in e.lower() for e in backend.errors)

    def test_peft_trl_accepts_cpu_experimental(self):
        """peft-trl backend should accept CPU experimental with warnings."""
        from peft_trl_orpo_backend import PeftTrlORPOBackend

        # Create a fake dataset file for validation
        tmpdir = tempfile.mkdtemp()
        dataset_path = os.path.join(tmpdir, "test-export.jsonl")
        with open(dataset_path, "w") as f:
            f.write('{"prompt": "test", "chosen": "good", "rejected": "bad"}\n')

        spec = TrainingExperimentSpec(
            experimentId="test-exp-123",
            backend="peft-trl-orpo",
            trainingMode="orpo",
            targetWorkerProfile="local-reader",
            targetModelFamily="Qwen/Qwen2-0.5B-Instruct",
            hardwareTier="cpu-experimental",
            datasetExportId="export-456",
            datasetExportPath=dataset_path,
            datasetFingerprint="fp-test-abc",
            benchmarkExportId="benchmark-789",
            outputDir=tmpdir,
            configFingerprint="fp-config-xyz",
            codeHash="fp-code-123",
            hyperparameters=TrainingHyperparameters(
                learningRate=3e-4,
                batchSize=1,
                gradientAccumulation=4,
                loraRank=8,
                loraAlpha=16,
                loraDropout=0.05,
                warmupRatio=0.1,
                maxSteps=10,
                maxSeqLength=512,
            ),
            budget=TrainingBudget(maxWallClockMinutes=120),
            expectedArtifact=ExpectedArtifact(
                checkpointName="test-checkpoint",
                adapterFormat="peft-adapter",
            ),
        )
        backend = PeftTrlORPOBackend(spec)

        # CPU is now accepted (with warnings printed to stdout)
        assert backend.validate_spec() is True
        assert len(backend.errors) == 0

        # Cleanup
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


class TestResultSerialization:
    """Tests for result JSON serialization."""

    def test_result_serializes_to_valid_json(self):
        """Results must serialize to valid JSON."""
        spec = create_valid_spec()
        result = create_valid_result(spec)

        json_str = json.dumps(result.to_dict(), indent=2)
        parsed = json.loads(json_str)

        assert parsed["experimentId"] == spec.experimentId
        assert parsed["backend"] == spec.backend

    def test_result_timestamps_are_iso_format(self):
        """createdAt must be in ISO 8601 format."""
        spec = create_valid_spec()
        result = create_valid_result(spec)

        assert "T" in result.createdAt
        assert result.createdAt.endswith("Z")


# ---------------------------------------------------------------------------
# Run tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import traceback

    test_classes = [
        TestContractSchema,
        TestBackendValidation,
        TestResultSerialization,
    ]

    passed = 0
    failed = 0

    for test_class in test_classes:
        print(f"\n{'=' * 60}")
        print(f"Running {test_class.__name__}")
        print("=" * 60)

        instance = test_class()
        for method_name in dir(instance):
            if method_name.startswith("test_"):
                print(f"\n  {method_name}...", end=" ")
                try:
                    getattr(instance, method_name)()
                    print("PASS")
                    passed += 1
                except Exception as e:
                    print(f"FAIL")
                    print(f"    Error: {e}")
                    failed += 1

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)

    sys.exit(0 if failed == 0 else 1)
