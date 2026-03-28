#!/usr/bin/env python3
"""
Nocturnal External Trainer Backend Base
=======================================

Base class for all trainer backends. Defines the stable contract:
- Input: TrainingExperimentSpec (JSON file)
- Output: TrainingExperimentResult (JSON to stdout)

All backends must:
1. Read and validate the experiment spec
2. Execute training (or simulate it)
3. Return a normalized result that matches TrainingExperimentResult schema

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
from typing import Optional, Any


# ---------------------------------------------------------------------------
# Types (mirroring TypeScript contract)
# ---------------------------------------------------------------------------


@dataclass
class TrainingHyperparameters:
    learningRate: float
    batchSize: int
    gradientAccumulation: int
    loraRank: int
    loraAlpha: int
    loraDropout: float
    warmupRatio: float
    maxSteps: int
    maxSeqLength: int


@dataclass
class TrainingBudget:
    maxWallClockMinutes: int
    maxTrainTokens: Optional[int] = None


@dataclass
class ExpectedArtifact:
    checkpointName: str
    adapterFormat: str  # 'peft-adapter'


@dataclass
class TrainingExperimentSpec:
    experimentId: str
    backend: str
    trainingMode: str  # 'orpo'
    targetWorkerProfile: str  # 'local-reader' | 'local-editor'
    targetModelFamily: str
    hardwareTier: str  # 'consumer-gpu' | 'small-gpu' | 'cpu-experimental'
    datasetExportId: str
    datasetExportPath: str
    datasetFingerprint: str
    benchmarkExportId: str
    outputDir: str
    configFingerprint: str
    codeHash: str
    hyperparameters: TrainingHyperparameters
    budget: TrainingBudget
    expectedArtifact: ExpectedArtifact

    @classmethod
    def from_dict(cls, data: dict) -> "TrainingExperimentSpec":
        return cls(
            experimentId=data["experimentId"],
            backend=data["backend"],
            trainingMode=data["trainingMode"],
            targetWorkerProfile=data["targetWorkerProfile"],
            targetModelFamily=data["targetModelFamily"],
            hardwareTier=data["hardwareTier"],
            datasetExportId=data["datasetExportId"],
            datasetExportPath=data["datasetExportPath"],
            datasetFingerprint=data["datasetFingerprint"],
            benchmarkExportId=data["benchmarkExportId"],
            outputDir=data["outputDir"],
            configFingerprint=data["configFingerprint"],
            codeHash=data["codeHash"],
            hyperparameters=TrainingHyperparameters(**data["hyperparameters"]),
            budget=TrainingBudget(**data["budget"]),
            expectedArtifact=ExpectedArtifact(**data["expectedArtifact"]),
        )


@dataclass
class TrainingMetrics:
    wallClockMinutes: int
    finalLoss: Optional[float] = None
    tokensSeen: Optional[int] = None


@dataclass
class TrainingArtifact:
    adapterFormat: str
    artifactPath: str


@dataclass
class TrainingExperimentResult:
    experimentId: str
    backend: str
    status: str  # 'completed' | 'failed' | 'dry_run'
    trainRunId: Optional[str] = None
    checkpointId: Optional[str] = None
    checkpointRef: Optional[str] = None
    targetWorkerProfile: str = ""
    targetModelFamily: str = ""
    datasetFingerprint: str = ""
    configFingerprint: str = ""
    codeHash: str = ""
    metrics: Optional[TrainingMetrics] = None
    artifact: Optional[TrainingArtifact] = None
    failureReason: Optional[str] = None
    createdAt: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")

    def to_dict(self) -> dict:
        result = {
            "experimentId": self.experimentId,
            "backend": self.backend,
            "status": self.status,
            "trainRunId": self.trainRunId,
            "checkpointId": self.checkpointId,
            "checkpointRef": self.checkpointRef,
            "targetWorkerProfile": self.targetWorkerProfile,
            "targetModelFamily": self.targetModelFamily,
            "datasetFingerprint": self.datasetFingerprint,
            "configFingerprint": self.configFingerprint,
            "codeHash": self.codeHash,
            "metrics": asdict(self.metrics) if self.metrics else None,
            "artifact": asdict(self.artifact) if self.artifact else None,
            "failureReason": self.failureReason,
            "createdAt": self.createdAt,
        }
        # Remove None values for cleaner output
        return {k: v for k, v in result.items() if v is not None}


# ---------------------------------------------------------------------------
# TrainerBackend Base Class
# ---------------------------------------------------------------------------


class TrainerBackend(ABC):
    """
    Abstract base class for trainer backends.

    Subclasses must implement:
    - validate_spec(): Validate the experiment spec
    - execute_training(): Execute the actual training
    """

    def __init__(self, spec: TrainingExperimentSpec):
        self.spec = spec
        self.errors: list[str] = []

    @abstractmethod
    def validate_spec(self) -> bool:
        """
        Validate the experiment spec.
        Returns True if valid, False otherwise.
        Append errors to self.errors.
        """
        pass

    @abstractmethod
    def execute_training(self) -> TrainingExperimentResult:
        """
        Execute training and return the result.
        """
        pass

    def run(self) -> TrainingExperimentResult:
        """
        Main entry point. Validates spec, executes training, returns result.
        """
        # Validate spec
        if not self.validate_spec():
            return TrainingExperimentResult(
                experimentId=self.spec.experimentId,
                backend=self.spec.backend,
                status="failed",
                failureReason="Spec validation failed: " + "; ".join(self.errors),
                targetWorkerProfile=self.spec.targetWorkerProfile,
                targetModelFamily=self.spec.targetModelFamily,
                datasetFingerprint=self.spec.datasetFingerprint,
                configFingerprint=self.spec.configFingerprint,
                codeHash=self.spec.codeHash,
            )

        # Execute training
        try:
            return self.execute_training()
        except Exception as e:
            return TrainingExperimentResult(
                experimentId=self.spec.experimentId,
                backend=self.spec.backend,
                status="failed",
                failureReason=f"Training execution failed: {str(e)}",
                targetWorkerProfile=self.spec.targetWorkerProfile,
                targetModelFamily=self.spec.targetModelFamily,
                datasetFingerprint=self.spec.datasetFingerprint,
                configFingerprint=self.spec.configFingerprint,
                codeHash=self.spec.codeHash,
            )


# ---------------------------------------------------------------------------
# CLI Argument Parser
# ---------------------------------------------------------------------------


def parse_args() -> tuple[str, str, str]:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Nocturnal External Trainer Backend")
    parser.add_argument(
        "--spec",
        required=True,
        help="Path to the experiment spec JSON file",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Output directory for checkpoints",
    )
    args = parser.parse_args()
    return args.spec, args.output_dir


def load_spec(spec_path: str) -> TrainingExperimentSpec:
    """Load and parse the experiment spec."""
    with open(spec_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return TrainingExperimentSpec.from_dict(data)


def save_result(result: TrainingExperimentResult, output_dir: str) -> None:
    """Save result to output directory."""
    output_path = Path(output_dir) / f"result-{result.experimentId}.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result.to_dict(), f, indent=2)


def main() -> None:
    """
    Main entry point for trainer backends.
    Loads spec, determines backend, runs training, outputs result.
    """
    spec_path, output_dir = parse_args()

    # Ensure output directory exists
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    # Load spec
    spec = load_spec(spec_path)

    # Select backend
    backend_map = {
        "peft-trl-orpo": "peft_trl_orpo_backend",
        "unsloth-orpo": "unsloth_orpo_backend",
        "dry-run": "dry_run_backend",
    }

    backend_name = backend_map.get(spec.backend)
    if not backend_name:
        result = TrainingExperimentResult(
            experimentId=spec.experimentId,
            backend=spec.backend,
            status="failed",
            failureReason=f"Unknown backend: {spec.backend}. Valid backends: {list(backend_map.keys())}",
        )
        print(json.dumps(result.to_dict(), indent=2))
        sys.exit(1)

    # Dynamically import the backend
    try:
        module = __import__(backend_name, fromlist=["TrainerBackend"])
        backend_class = module.TrainerBackend
    except ImportError as e:
        result = TrainingExperimentResult(
            experimentId=spec.experimentId,
            backend=spec.backend,
            status="failed",
            failureReason=f"Backend module not found: {backend_name}. Error: {str(e)}",
        )
        print(json.dumps(result.to_dict(), indent=2))
        sys.exit(1)

    # Run backend
    backend = backend_class(spec)
    result = backend.run()

    # Save result to output directory as backup (in case stdout parsing fails on plugin side)
    save_result(result, output_dir)

    # Output result to stdout (machine-readable JSON only - no logs mixed in)
    print(json.dumps(result.to_dict(), indent=2))


if __name__ == "__main__":
    main()
