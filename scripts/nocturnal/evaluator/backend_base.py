#!/usr/bin/env python3
"""
Nocturnal External Evaluator Backend Base
==========================================

Base class for all evaluator backends. Defines the stable contract:
- Input: EvaluationRequest (JSON file containing samples + checkpoint info)
- Output: EvaluationResult (JSON to stdout)

All backends must:
1. Read and validate the evaluation request
2. Load the checkpoint (base model + adapter)
3. Score each sample
4. Return normalized results that match EvaluationResult schema

Backends are pluggable: same contract, different implementations.
"""

import json
import sys
import os
import argparse
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional, Any, List


# ---------------------------------------------------------------------------
# Types (mirroring TypeScript contract)
# ---------------------------------------------------------------------------


@dataclass
class EvaluationSample:
    """A single ORPO sample to evaluate."""

    sampleFingerprint: str
    prompt: str
    chosen: str
    rejected: str
    rationale: str


@dataclass
class EvaluationRequest:
    """Request to evaluate a set of samples against a checkpoint."""

    requestId: str
    checkpointRef: str  # Reference to checkpoint (e.g., "ckpt-abc123")
    checkpointPath: str  # Path to the checkpoint directory
    baseModelName: str  # Base model name/path
    samples: List[EvaluationSample]
    mode: str  # 'prompt_assisted' | 'reduced_prompt'
    adapterFormat: str  # 'peft-adapter'

    @classmethod
    def from_dict(cls, data: dict) -> "EvaluationRequest":
        return cls(
            requestId=data["requestId"],
            checkpointRef=data["checkpointRef"],
            checkpointPath=data["checkpointPath"],
            baseModelName=data["baseModelName"],
            samples=[EvaluationSample(**s) for s in data["samples"]],
            mode=data["mode"],
            adapterFormat=data["adapterFormat"],
        )


@dataclass
class ScoredSample:
    """Result of scoring a single sample."""

    sampleFingerprint: str
    score: float  # 0.0 – 1.0
    justification: str
    mode: str


@dataclass
class EvaluationMetrics:
    """Aggregate metrics across all samples."""

    meanScore: float
    medianScore: float
    stdDev: float
    passRate: float  # fraction scoring above 0.7
    failRate: float  # fraction scoring below 0.3


@dataclass
class EvaluationResult:
    """Result of an evaluation run."""

    requestId: str
    checkpointRef: str
    status: str  # 'completed' | 'failed' | 'dry_run'
    scores: List[ScoredSample] = field(default_factory=list)
    metrics: Optional[EvaluationMetrics] = None
    errorMessage: Optional[str] = None
    evaluatorType: str = "local-model"
    evaluatorVersion: str = "0.1.0"
    createdAt: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")

    def to_dict(self) -> dict:
        result = {
            "requestId": self.requestId,
            "checkpointRef": self.checkpointRef,
            "status": self.status,
            "scores": [asdict(s) for s in self.scores],
            "metrics": asdict(self.metrics) if self.metrics else None,
            "errorMessage": self.errorMessage,
            "evaluatorType": self.evaluatorType,
            "evaluatorVersion": self.evaluatorVersion,
            "createdAt": self.createdAt,
        }
        return {k: v for k, v in result.items() if v is not None}


# ---------------------------------------------------------------------------
# EvaluatorBackend Base Class
# ---------------------------------------------------------------------------


class EvaluatorBackend(ABC):
    """
    Abstract base class for evaluator backends.

    Subclasses must implement:
    - validate_request(): Validate the evaluation request
    - load_checkpoint(): Load the model + adapter
    - score_sample(): Score a single sample
    """

    def __init__(self, request: EvaluationRequest):
        self.request = request
        self.errors: list[str] = []
        self._model = None
        self._tokenizer = None

    @abstractmethod
    def validate_request(self) -> bool:
        """
        Validate the evaluation request.
        Returns True if valid, False otherwise.
        Append errors to self.errors.
        """
        pass

    @abstractmethod
    def load_checkpoint(self) -> bool:
        """
        Load the model and adapter for evaluation.
        Returns True if successful, False otherwise.
        Sets self._model and self._tokenizer on success.
        """
        pass

    @abstractmethod
    def score_sample(self, sample: EvaluationSample) -> ScoredSample:
        """
        Score a single sample using the loaded model.
        Must be implemented by subclasses.
        """
        pass

    def run(self) -> EvaluationResult:
        """
        Main entry point. Validates request, loads checkpoint, scores samples.
        """
        # Validate request
        if not self.validate_request():
            return EvaluationResult(
                requestId=self.request.requestId,
                checkpointRef=self.request.checkpointRef,
                status="failed",
                errorMessage="Request validation failed: " + "; ".join(self.errors),
            )

        # Load checkpoint
        if not self.load_checkpoint():
            return EvaluationResult(
                requestId=self.request.requestId,
                checkpointRef=self.request.checkpointRef,
                status="failed",
                errorMessage="Checkpoint loading failed: " + "; ".join(self.errors),
            )

        # Score all samples
        try:
            scores: List[ScoredSample] = []
            for sample in self.request.samples:
                scored = self.score_sample(sample)
                scores.append(scored)

            # Compute aggregate metrics
            metrics = self._compute_metrics(scores)

            return EvaluationResult(
                requestId=self.request.requestId,
                checkpointRef=self.request.checkpointRef,
                status="completed",
                scores=scores,
                metrics=metrics,
            )
        except Exception as e:
            return EvaluationResult(
                requestId=self.request.requestId,
                checkpointRef=self.request.checkpointRef,
                status="failed",
                errorMessage=f"Score computation failed: {str(e)}",
            )

    def _compute_metrics(self, scores: List[ScoredSample]) -> EvaluationMetrics:
        """Compute aggregate metrics from scores."""
        if not scores:
            return EvaluationMetrics(
                meanScore=0.0,
                medianScore=0.0,
                stdDev=0.0,
                passRate=0.0,
                failRate=0.0,
            )

        values = sorted([s.score for s in scores])
        n = len(values)

        mean = sum(values) / n
        median = (
            values[n // 2] if n % 2 == 1 else (values[n // 2 - 1] + values[n // 2]) / 2
        )
        variance = sum((v - mean) ** 2 for v in values) / n
        std_dev = variance**0.5
        pass_rate = sum(1 for v in values if v >= 0.7) / n
        fail_rate = sum(1 for v in values if v < 0.3) / n

        return EvaluationMetrics(
            meanScore=round(mean, 4),
            medianScore=round(median, 4),
            stdDev=round(std_dev, 4),
            passRate=round(pass_rate, 4),
            failRate=round(fail_rate, 4),
        )


# ---------------------------------------------------------------------------
# CLI Argument Parser
# ---------------------------------------------------------------------------


def parse_args() -> tuple[str, str]:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Nocturnal External Evaluator Backend")
    parser.add_argument(
        "--request",
        required=True,
        help="Path to the evaluation request JSON file",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Output directory for evaluation results",
    )
    args = parser.parse_args()
    return args.request, args.output_dir


def load_request(request_path: str) -> EvaluationRequest:
    """Load and parse the evaluation request."""
    with open(request_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return EvaluationRequest.from_dict(data)


def save_result(result: EvaluationResult, output_dir: str) -> None:
    """Save result to output directory as backup."""
    output_path = Path(output_dir) / f"eval-result-{result.requestId}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result.to_dict(), f, indent=2)


def main() -> None:
    """
    Main entry point for evaluator backends.
    Loads request, determines backend, runs evaluation, outputs result.
    """
    request_path, output_dir = parse_args()

    # Ensure output directory exists
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Load request
    request = load_request(request_path)

    # Select backend based on adapter format
    backend_map = {
        "peft-adapter": "peft_checkpoint_evaluator",
        "dry-run": "dry_run_evaluator",
    }

    backend_name = backend_map.get(request.adapterFormat)
    if not backend_name:
        result = EvaluationResult(
            requestId=request.requestId,
            checkpointRef=request.checkpointRef,
            status="failed",
            errorMessage=f"Unknown adapter format: {request.adapterFormat}. Valid formats: {list(backend_map.keys())}",
        )
        print(json.dumps(result.to_dict(), indent=2))
        sys.exit(1)

    # Dynamically import the backend
    try:
        # Try scripts/nocturnal/evaluator path first
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            backend_name, Path(__file__).parent / f"{backend_name}.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        backend_class = module.EvaluatorBackend
    except (ImportError, FileNotFoundError) as e:
        result = EvaluationResult(
            requestId=request.requestId,
            checkpointRef=request.checkpointRef,
            status="failed",
            errorMessage=f"Backend module not found: {backend_name}. Error: {str(e)}",
        )
        print(json.dumps(result.to_dict(), indent=2))
        sys.exit(1)

    # Run backend
    backend = backend_class(request)
    result = backend.run()

    # Save result to output directory as backup
    save_result(result, output_dir)

    # Output result to stdout (machine-readable JSON only)
    print(json.dumps(result.to_dict(), indent=2))


if __name__ == "__main__":
    main()
