#!/usr/bin/env python3
"""
Dry-Run Evaluator
=================

Validates the evaluation request without performing actual model inference.
Does not produce meaningful scores.
"""

import os
import sys
from pathlib import Path
from typing import List

from backend_base import (
    EvaluatorBackend,
    EvaluationRequest,
    EvaluationSample,
    ScoredSample,
)


class DryRunEvaluator(EvaluatorBackend):
    """
    Dry-run evaluator backend.

    Validates:
    - Request format is correct
    - Checkpoint path exists (or is mockable)
    - Samples are provided

    Does NOT:
    - Actually load a model
    - Run real inference
    - Produce meaningful scores

    Returns stub scores (0.5 for all samples).
    """

    def validate_request(self) -> bool:
        """Validate the evaluation request for dry-run."""
        self.errors = []

        # For dry-run, we don't require the checkpoint to exist
        # but we do validate the path format
        if not self.request.checkpointRef:
            self.errors.append("checkpointRef is required")

        if not self.request.samples:
            self.errors.append("No samples provided for evaluation")

        if self.request.mode not in ("prompt_assisted", "reduced_prompt"):
            self.errors.append(
                f"Invalid mode: {self.request.mode}. Must be 'prompt_assisted' or 'reduced_prompt'"
            )

        return len(self.errors) == 0

    def load_checkpoint(self) -> bool:
        """Dry-run: no actual model loading."""
        print(f"[dry-run-evaluator] Dry-run mode: skipping checkpoint load", file=sys.stderr)
        print(
            f"[dry-run-evaluator] Would load checkpoint: {self.request.checkpointRef}",
            file=sys.stderr,
        )
        print(f"[dry-run-evaluator] Would use base model: {self.request.baseModelName}", file=sys.stderr)
        return True

    def score_sample(self, sample: EvaluationSample) -> ScoredSample:
        """
        Return a stub score for dry-run.

        In a real evaluator, this would call the model and compute
        a genuine preference score.
        """
        return ScoredSample(
            sampleFingerprint=sample.sampleFingerprint,
            score=0.5,  # Stub: neutral score
            justification=(
                f"[dry-run-evaluator:{self.request.mode}] "
                f"stub score 0.500 — dry-run does not perform real inference"
            ),
            mode=self.request.mode,
        )


# Expose EvaluatorBackend for main() entry point compatibility
EvaluatorBackend = DryRunEvaluator


# CLI entry point
if __name__ == "__main__":
    from backend_base import main

    main()
