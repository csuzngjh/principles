#!/usr/bin/env python3
"""
Unsloth ORPO Backend
====================

Accelerated implementation using Unsloth for ~2x faster training on consumer GPUs.
Emits the same normalized result schema as PEFT-TRL backend.

Unsloth is an optimization backend, NOT a different protocol.
Both backends must produce identical result shapes.

Key advantages of Unsloth:
- ~2x faster training through optimized kernels
- 60% less memory usage via gradient checkpointing
- 4-bit quantization (QLoRA) built-in
- Same checkpoint format (PEFT adapter)

Requirements:
- unsloth
- transformers
- peft
- trl
- torch

See: https://github.com/unsloth/unsloth
"""

import json
import os
import sys
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Dependency Check
# ---------------------------------------------------------------------------


def _check_and_import_deps():
    """
    Check dependencies and import required modules.
    """
    missing = []

    try:
        import torch
    except ImportError:
        missing.append("torch")

    try:
        from transformers import AutoTokenizer
    except ImportError:
        missing.append("transformers")

    try:
        import peft
    except ImportError:
        missing.append("peft")

    try:
        # Try new location first (trl >= 0.12)
        from trl import ORPOConfig, ORPOTrainer
    except ImportError:
        try:
            # Fall back to experimental location
            from trl.experimental.orpo import ORPOConfig, ORPOTrainer
        except ImportError:
            missing.append("trl")

    try:
        # Unsloth specific imports
        from unsloth import FastLanguageModel
    except ImportError:
        missing.append("unsloth")

    try:
        from datasets import load_dataset, Dataset
    except ImportError:
        missing.append("datasets")

    if missing:
        raise ImportError(
            f"Missing required dependencies: {', '.join(missing)}\n"
            "Please install them with:\n"
            "  pip install torch transformers peft trl datasets unsloth\n"
        )

    return (
        torch,
        AutoTokenizer,
        ORPOConfig,
        ORPOTrainer,
        FastLanguageModel,
        load_dataset,
        Dataset,
    )


# ---------------------------------------------------------------------------
# Base imports (always available)
# ---------------------------------------------------------------------------

from backend_base import (
    TrainerBackend,
    TrainingExperimentSpec,
    TrainingExperimentResult,
    TrainingMetrics,
    TrainingArtifact,
)


# ---------------------------------------------------------------------------
# Dataset Loading
# ---------------------------------------------------------------------------


def load_orpo_dataset(dataset_path: str) -> "Dataset":
    """
    Load an ORPO dataset from a JSONL file.

    Expected format (one JSON object per line):
    {
        "prompt": "the suboptimal decision/bad choice",
        "chosen": "the correct decision/response",
        "rejected": "the suboptimal decision (same as prompt)",
        ... (other fields are ignored)
    }

    The ORPOTrainer expects columns: 'prompt', 'chosen', 'rejected'
    """
    samples = []
    with open(dataset_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                sample = {
                    "prompt": obj.get("prompt", ""),
                    "chosen": obj.get("chosen", ""),
                    "rejected": obj.get("rejected", ""),
                }
                # Include additional metadata
                for key, value in obj.items():
                    if key not in ("prompt", "chosen", "rejected"):
                        sample[key] = value
                samples.append(sample)
            except json.JSONDecodeError as e:
                raise ValueError(f"Invalid JSON on line {line_num}: {e}")

    if not samples:
        raise ValueError(
            f"Dataset is empty or contains no valid samples: {dataset_path}"
        )

    from datasets import Dataset

    return Dataset.from_list(samples)


def prepare_dataset_for_orpo(
    dataset: "Dataset", tokenizer: "AutoTokenizer"
) -> "Dataset":
    """
    Apply chat template and tokenization to the dataset for ORPO training.
    """

    def format_sample(sample: Dict[str, Any]) -> Dict[str, Any]:
        """Format a single sample with chat template."""
        prompt_text = sample["prompt"]
        chosen_text = sample["chosen"]
        rejected_text = sample["rejected"]

        # Use chat template if available
        if hasattr(tokenizer, "chat_template") and tokenizer.chat_template:
            prompt_conv = [{"role": "user", "content": prompt_text}]
            chosen_conv = [
                {"role": "user", "content": prompt_text},
                {"role": "assistant", "content": chosen_text},
            ]
            rejected_conv = [
                {"role": "user", "content": prompt_text},
                {"role": "assistant", "content": rejected_text},
            ]

            sample["prompt"] = tokenizer.apply_chat_template(
                prompt_conv, tokenize=False, add_generation_prompt=True
            )
            sample["chosen"] = tokenizer.apply_chat_template(
                chosen_conv, tokenize=False
            )
            sample["rejected"] = tokenizer.apply_chat_template(
                rejected_conv, tokenize=False
            )
        else:
            sample["prompt"] = f"User: {prompt_text}\nAssistant:"
            sample["chosen"] = f"User: {prompt_text}\nAssistant: {chosen_text}"
            sample["rejected"] = f"User: {prompt_text}\nAssistant: {rejected_text}"

        return sample

    dataset = dataset.map(format_sample, desc="Formatting samples")
    return dataset


# ---------------------------------------------------------------------------
# UnslothORPOBackend
# ---------------------------------------------------------------------------


class UnslothORPOBackend(TrainerBackend):
    """
    Unsloth-accelerated ORPO trainer backend.

    This backend:
    - Uses Unsloth FastLanguageModel for 2x faster training
    - Uses 4-bit quantization (QLoRA) for memory efficiency
    - Produces checkpoints in the same PEFT adapter format
    - Emits the same result schema as peft-trl-orpo backend

    Key invariant: Unsloth is an ACCELERATION backend, not a different protocol.
    The input contract and output contract are IDENTICAL to peft-trl-orpo.
    """

    def validate_spec(self) -> bool:
        """Validate the experiment spec for Unsloth ORPO training."""
        self.errors = []

        # Check training mode is ORPO
        if self.spec.trainingMode != "orpo":
            self.errors.append(
                f"Unsloth backend only supports 'orpo' training mode. "
                f"Got: '{self.spec.trainingMode}'"
            )

        # Check dataset export path exists
        if not os.path.exists(self.spec.datasetExportPath):
            self.errors.append(
                f"Dataset export not found: {self.spec.datasetExportPath}. "
                "Please ensure the ORPO export has been generated before training."
            )

        # Check output directory is writable
        output_dir = Path(self.spec.outputDir)
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            self.errors.append(
                f"Cannot create output directory: {self.spec.outputDir}. Error: {str(e)}"
            )

        # Validate hyperparameters
        hps = self.spec.hyperparameters

        if hps.learningRate <= 0 or hps.learningRate > 1e-2:
            self.errors.append(
                f"Learning rate {hps.learningRate} may be too high for ORPO. "
                "Recommended: 1e-5 to 1e-3"
            )

        if hps.loraRank < 4 or hps.loraRank > 128:
            self.errors.append(
                f"LoRA rank {hps.loraRank} is outside recommended range (4-128)."
            )

        if hps.maxSeqLength > 4096:
            self.errors.append(
                f"Max sequence length {hps.maxSeqLength} exceeds recommended maximum (4096)."
            )

        # Validate hardware tier
        if self.spec.hardwareTier == "cpu-experimental":
            self.errors.append(
                "Unsloth backend requires GPU. Use 'consumer-gpu' or 'small-gpu'. "
                "For CPU-only validation, use 'dry-run' backend."
            )

        return len(self.errors) == 0

    def execute_training(self) -> TrainingExperimentResult:
        """
        Execute ORPO training using Unsloth acceleration.

        This produces the SAME output contract as peft-trl-orpo:
        - Same TrainingExperimentResult schema
        - Same checkpoint structure
        - Same PEFT adapter format
        """
        # Lazy import of training dependencies
        (
            torch,
            AutoTokenizer,
            ORPOConfig,
            ORPOTrainer,
            FastLanguageModel,
            load_dataset,
            Dataset,
        ) = _check_and_import_deps()

        start_time = time.time()

        # Generate IDs for lineage tracking
        train_run_id = str(uuid.uuid4())
        checkpoint_id = str(uuid.uuid4())

        try:
            # -----------------------------------------------------------------
            # Step 1: Load dataset
            # -----------------------------------------------------------------
            print(f"[unsloth-orpo] Loading dataset from {self.spec.datasetExportPath}")
            dataset = load_orpo_dataset(self.spec.datasetExportPath)
            print(f"[unsloth-orpo] Loaded {len(dataset)} samples")

            # -----------------------------------------------------------------
            # Step 2: Load tokenizer with Unsloth
            # -----------------------------------------------------------------
            print(f"[unsloth-orpo] Loading tokenizer for {self.spec.targetModelFamily}")
            tokenizer = AutoTokenizer.from_pretrained(
                self.spec.targetModelFamily,
                trust_remote_code=True,
            )
            if tokenizer.pad_token is None:
                tokenizer.pad_token = tokenizer.eos_token
            tokenizer.padding_side = "right"

            # Apply chat template formatting
            dataset = prepare_dataset_for_orpo(dataset, tokenizer)
            print(f"[unsloth-orpo] Dataset formatted with chat template")

            # -----------------------------------------------------------------
            # Step 3: Load model with Unsloth FastLanguageModel
            # -----------------------------------------------------------------
            # Unsloth's key advantage: built-in 4-bit quantization and
            # optimized forward pass
            print(f"[unsloth-orpo] Loading {self.spec.targetModelFamily} with Unsloth")

            model, tokenizer = FastLanguageModel.from_pretrained(
                model_name=self.spec.targetModelFamily,
                max_seq_length=self.spec.hyperparameters.maxSeqLength,
                dtype=None,  # Auto-detect dtype
                load_in_4bit=True,  # 4-bit quantization (QLoRA)
                trust_remote_code=True,
            )

            # -----------------------------------------------------------------
            # Step 4: Add LoRA adapters using FastLanguageModel.get_peft_model
            # -----------------------------------------------------------------
            hps = self.spec.hyperparameters
            model = FastLanguageModel.get_peft_model(
                model,
                r=hps.loraRank,
                target_modules=[
                    "q_proj",
                    "v_proj",
                    "k_proj",
                    "o_proj",
                    "gate_proj",
                    "up_proj",
                    "down_proj",
                ],
                lora_alpha=hps.loraAlpha,
                lora_dropout=hps.loraDropout,
                bias="none",
                use_gradient_checkpointing="unsloth",  # Unsloth's gradient checkpointing
                random_state=42,
            )

            print(
                f"[unsloth-orpo] LoRA config: rank={hps.loraRank}, alpha={hps.loraAlpha}, "
                f"dropout={hps.loraDropout}"
            )

            # -----------------------------------------------------------------
            # Step 5: Configure ORPO training
            # -----------------------------------------------------------------
            output_dir = Path(self.spec.outputDir) / f"checkpoint-{checkpoint_id}"
            output_dir.mkdir(parents=True, exist_ok=True)

            orpo_config = ORPOConfig(
                output_dir=str(output_dir),
                beta=0.1,  # ORPO penalty coefficient
                learning_rate=hps.learningRate,
                per_device_train_batch_size=hps.batchSize,
                gradient_accumulation_steps=hps.gradientAccumulation,
                max_steps=hps.maxSteps,
                max_seq_length=hps.maxSeqLength,
                warmup_ratio=hps.warmupRatio,
                logging_steps=10,
                save_strategy="steps",
                save_steps=max(1, hps.maxSteps // 5),
                save_total_limit=1,
                report_to="none",
                fp16=False,
                bf16=self.spec.hardwareTier in ("consumer-gpu", "small-gpu"),
                remove_unused_columns=False,
                # Unsloth uses its own optimizer internally
                # but we can still specify the optimizer type
                optim="paged_adamw_32bit",
                ddp_find_unused_parameters=False,
            )

            print(
                f"[unsloth-orpo] ORPO config: steps={hps.maxSteps}, "
                f"batch_size={hps.batchSize}, lr={hps.learningRate}"
            )

            # -----------------------------------------------------------------
            # Step 6: Initialize ORPO Trainer
            # -----------------------------------------------------------------
            trainer = ORPOTrainer(
                model=model,
                args=orpo_config,
                train_dataset=dataset,
                processing_class=tokenizer,
            )

            # -----------------------------------------------------------------
            # Step 7: Train!
            # -----------------------------------------------------------------
            print(f"[unsloth-orpo] Starting ORPO training for {hps.maxSteps} steps...")
            training_output = trainer.train()
            print(f"[unsloth-orpo] Training completed")

            # -----------------------------------------------------------------
            # Step 8: Save adapter checkpoint
            # -----------------------------------------------------------------
            adapter_path = output_dir / "adapter"
            model.save_pretrained(str(adapter_path))
            print(f"[unsloth-orpo] Adapter saved to {adapter_path}")

            # Save adapter config
            adapter_config = {
                "adapter_name": checkpoint_id,
                "base_model_name_or_path": self.spec.targetModelFamily,
                "peft_type": "LORA",
                "task_type": "CAUSAL_LM",
                "lora_alpha": hps.loraAlpha,
                "lora_dropout": hps.loraDropout,
                "r": hps.loraRank,
                "target_modules": [
                    "q_proj",
                    "v_proj",
                    "k_proj",
                    "o_proj",
                    "gate_proj",
                    "up_proj",
                    "down_proj",
                ],
                "bias": "none",
                "inference_mode": False,
                # Unsloth-specific marker
                "unsloth_optimized": True,
            }
            with open(adapter_path / "adapter_config.json", "w") as f:
                json.dump(adapter_config, f, indent=2)

            # Save checkpoint metadata
            checkpoint_meta = {
                "checkpointId": checkpoint_id,
                "experimentId": self.spec.experimentId,
                "trainRunId": train_run_id,
                "targetModelFamily": self.spec.targetModelFamily,
                "targetWorkerProfile": self.spec.targetWorkerProfile,
                "datasetFingerprint": self.spec.datasetFingerprint,
                "configFingerprint": self.spec.configFingerprint,
                "codeHash": self.spec.codeHash,
                "hyperparameters": asdict(self.spec.hyperparameters),
                "backend": "unsloth-orpo",
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            with open(output_dir / "metadata.json", "w") as f:
                json.dump(checkpoint_meta, f, indent=2)

            # -----------------------------------------------------------------
            # Step 9: Compute metrics
            # -----------------------------------------------------------------
            elapsed = time.time() - start_time
            wall_clock_minutes = round(elapsed / 60, 2)

            # Extract metrics from training output
            final_loss = None
            tokens_seen = None
            if training_output and hasattr(training_output, "metrics"):
                metrics = training_output.metrics
                final_loss = metrics.get("train_loss")
                tokens_seen = (
                    hps.maxSteps
                    * hps.batchSize
                    * hps.gradientAccumulation
                    * hps.maxSeqLength
                )

            # -----------------------------------------------------------------
            # Step 10: Return result
            # -----------------------------------------------------------------
            result = TrainingExperimentResult(
                experimentId=self.spec.experimentId,
                backend="unsloth-orpo",
                status="completed",
                trainRunId=train_run_id,
                checkpointId=checkpoint_id,
                checkpointRef=f"ckpt-{checkpoint_id[:8]}",
                targetWorkerProfile=self.spec.targetWorkerProfile,
                targetModelFamily=self.spec.targetModelFamily,
                datasetFingerprint=self.spec.datasetFingerprint,
                configFingerprint=self.spec.configFingerprint,
                codeHash=self.spec.codeHash,
                metrics=TrainingMetrics(
                    wallClockMinutes=wall_clock_minutes,
                    finalLoss=round(final_loss, 4) if final_loss is not None else None,
                    tokensSeen=tokens_seen,
                ),
                artifact=TrainingArtifact(
                    adapterFormat="peft-adapter",
                    artifactPath=str(output_dir),
                ),
                createdAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            )

            print(
                f"[unsloth-orpo] Training complete! Wall time: {wall_clock_minutes} minutes"
            )
            return result

        except Exception as e:
            import traceback

            error_msg = f"{type(e).__name__}: {str(e)}"
            print(f"[unsloth-orpo] Training failed: {error_msg}")
            traceback.print_exc()

            return TrainingExperimentResult(
                experimentId=self.spec.experimentId,
                backend="unsloth-orpo",
                status="failed",
                failureReason=error_msg,
                targetWorkerProfile=self.spec.targetWorkerProfile,
                targetModelFamily=self.spec.targetModelFamily,
                datasetFingerprint=self.spec.datasetFingerprint,
                configFingerprint=self.spec.configFingerprint,
                codeHash=self.spec.codeHash,
            )


# ---------------------------------------------------------------------------
# Module exports
# ---------------------------------------------------------------------------

TrainerBackend = UnslothORPOBackend


if __name__ == "__main__":
    from backend_base import main

    main()
