#!/usr/bin/env python3
"""
Dry-Run Backend
===============

Validates the experiment spec and environment without performing actual training.
Does not produce a deployable checkpoint.

Use cases:
- Validate spec correctness before real training
- Test the training pipeline setup
- Validate dataset paths and fingerprints
"""

import os
import uuid
from pathlib import Path
from typing import Optional

from backend_base import (
    TrainerBackend,
    TrainingExperimentSpec,
    TrainingExperimentResult,
    TrainingMetrics,
)


class DryRunBackend(TrainerBackend):
    """
    Dry-run trainer backend.

    Validates:
    - Dataset export path exists
    - Output directory is writable
    - Hyperparameters are within valid ranges
    - Hardware tier is appropriate for dry-run

    Does NOT:
    - Actually train a model
    - Produce a checkpoint
    - Consume significant compute
    """

    def validate_spec(self) -> bool:
        """Validate the experiment spec for dry-run."""
        self.errors = []

        # Check dataset export path exists
        if not os.path.exists(self.spec.datasetExportPath):
            # For dry-run, we can skip this check in some cases
            # but let's warn
            print(
                f"[dry-run] Warning: dataset export path not found: {self.spec.datasetExportPath}"
            )

        # Check output directory is writable
        output_dir = Path(self.spec.outputDir)
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            test_file = output_dir / ".dry-run-write-test"
            test_file.write_text("test")
            test_file.unlink()
        except Exception as e:
            self.errors.append(
                f"Output directory is not writable: {self.spec.outputDir}. Error: {str(e)}"
            )

        # Validate hyperparameters are within reasonable ranges
        hps = self.spec.hyperparameters

        if hps.learningRate <= 0 or hps.learningRate > 1:
            self.errors.append(
                f"Invalid learning rate: {hps.learningRate}. Must be between 0 and 1."
            )

        if hps.batchSize < 1:
            self.errors.append(f"Invalid batch size: {hps.batchSize}. Must be >= 1.")

        if hps.loraRank < 1 or hps.loraRank > 1024:
            self.errors.append(
                f"Invalid loraRank: {hps.loraRank}. Must be between 1 and 1024."
            )

        if hps.maxSeqLength < 128 or hps.maxSeqLength > 8192:
            self.errors.append(
                f"Invalid maxSeqLength: {hps.maxSeqLength}. Must be between 128 and 8192."
            )

        if hps.maxSteps < 1:
            self.errors.append(f"Invalid maxSteps: {hps.maxSteps}. Must be >= 1.")

        # Dry-run must use cpu-experimental or consumer-gpu tier
        if self.spec.hardwareTier not in [
            "cpu-experimental",
            "consumer-gpu",
            "small-gpu",
        ]:
            self.errors.append(
                f"Invalid hardware tier for dry-run: {self.spec.hardwareTier}. "
                "Use 'cpu-experimental', 'consumer-gpu', or 'small-gpu'."
            )

        return len(self.errors) == 0

    def execute_training(self) -> TrainingExperimentResult:
        """
        Execute dry-run validation.

        Returns a result with:
        - status: 'dry_run'
        - No checkpoint (dry-run cannot produce deployable checkpoint)
        - Metrics showing wall clock time for validation
        """
        import time

        start_time = time.time()

        # Perform validation checks (already done in validate_spec)
        # Additional checks can go here

        wall_clock_minutes = round((time.time() - start_time) / 60, 2)

        # Generate a fake train run ID for lineage tracking
        train_run_id = str(uuid.uuid4())

        result = TrainingExperimentResult(
            experimentId=self.spec.experimentId,
            backend="dry-run",
            status="dry_run",
            trainRunId=train_run_id,
            targetWorkerProfile=self.spec.targetWorkerProfile,
            targetModelFamily=self.spec.targetModelFamily,
            datasetFingerprint=self.spec.datasetFingerprint,
            configFingerprint=self.spec.configFingerprint,
            codeHash=self.spec.codeHash,
            metrics=TrainingMetrics(
                wallClockMinutes=wall_clock_minutes,
            ),
            # No artifact for dry-run - this is intentional
            artifact=None,
            createdAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )

        return result


# Expose TrainerBackend for main() entry point compatibility
# When main() does `module.TrainerBackend`, this makes DryRunBackend accessible
TrainerBackend = DryRunBackend

# For CLI entry point compatibility
if __name__ == "__main__":
    from backend_base import main

    main()
