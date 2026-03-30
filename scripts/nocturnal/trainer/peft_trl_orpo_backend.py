#!/usr/bin/env python3
from __future__ import annotations

"""
PEFT-TRL ORPO Backend
=====================

Reference implementation using PEFT for adapter/checkpoint semantics
and TRL for ORPO training semantics.

This backend performs real ORPO (Odds Ratio Preference Optimization) training:
1. Loads the base model (with optional 4-bit quantization for consumer GPUs)
2. Applies PEFT LoRA adapter
3. Loads ORPO preference dataset (JSONL format)
4. Runs TRL ORPOTrainer for preference optimization
5. Saves the trained PEFT adapter checkpoint

Requirements:
- transformers
- peft
- trl
- torch
- bitsandbytes (for QLoRA quantization, optional)

See: https://github.com/huggingface/trl
See: https://github.com/huggingface/peft
"""

import json
import os
import sys
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Optional, List, Dict, Any

# ---------------------------------------------------------------------------
# Lazy import helpers (defer actual imports until training time)
# ---------------------------------------------------------------------------


def _check_and_import_deps():
    """
    Check dependencies and import required modules.
    Called at training execution time, not at module load time.
    Raises ImportError with clear message if dependencies are missing.
    """
    missing = []

    try:
        import torch
    except ImportError:
        missing.append("torch")

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
    except ImportError:
        missing.append("transformers")

    try:
        import peft
        from peft import LoraConfig, get_peft_model, TaskType
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
        from datasets import load_dataset, Dataset
    except ImportError:
        missing.append("datasets")

    if missing:
        raise ImportError(
            f"Missing required dependencies: {', '.join(missing)}\n"
            "Please install them with:\n"
            "  pip install torch transformers peft trl datasets\n"
            "  # Optional, for 4-bit quantization:\n"
            "  pip install bitsandbytes\n"
        )

    return (
        torch,
        AutoModelForCausalLM,
        AutoTokenizer,
        LoraConfig,
        get_peft_model,
        TaskType,
        ORPOConfig,
        ORPOTrainer,
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
                # Map the exported format to ORPO expected format
                sample = {
                    "prompt": obj.get("prompt", ""),
                    "chosen": obj.get("chosen", ""),
                    "rejected": obj.get("rejected", ""),
                }
                # Include additional metadata as extra columns (ignored by ORPOTrainer)
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

    # Import Dataset here (lazy import)
    from datasets import Dataset

    return Dataset.from_list(samples)


def prepare_dataset_for_orpo(
    dataset: "Dataset", tokenizer: "AutoTokenizer"
) -> "Dataset":
    """
    Apply chat template and tokenization to the dataset for ORPO training.

    The dataset should have 'prompt', 'chosen', 'rejected' columns.
    We apply the tokenizer's chat template and ensure proper formatting.
    """

    def format_sample(sample: Dict[str, Any]) -> Dict[str, Any]:
        """Format a single sample with chat template."""
        # Format prompt as a conversation with user role
        prompt_text = sample["prompt"]
        chosen_text = sample["chosen"]
        rejected_text = sample["rejected"]

        # Use chat template if available
        if hasattr(tokenizer, "chat_template") and tokenizer.chat_template:
            # Build conversation structure
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
            # Fallback: simple concatenation
            sample["prompt"] = f"User: {prompt_text}\nAssistant:"
            sample["chosen"] = f"User: {prompt_text}\nAssistant: {chosen_text}"
            sample["rejected"] = f"User: {prompt_text}\nAssistant: {rejected_text}"

        return sample

    # Apply formatting to all samples
    dataset = dataset.map(format_sample, desc="Formatting samples")

    return dataset


# ---------------------------------------------------------------------------
# Model Loading
# ---------------------------------------------------------------------------


def load_model_for_training(
    model_name: str,
    hardware_tier: str,
    lora_config: LoraConfig,
    tokenizer: "AutoTokenizer",
    torch,
    AutoModelForCausalLM,
    get_peft_model,
    bitsandbytes=None,
) -> "Any":
    """
    Load a model for ORPO training with optional PEFT/quantization.

    Args:
        model_name: HuggingFace model name or local path
        hardware_tier: 'consumer-gpu', 'small-gpu', or 'cpu-experimental'
        lora_config: PEFT LoRA configuration
        tokenizer: Tokenizer for the model
        torch: PyTorch module
        AutoModelForCausalLM: Transformers auto model class
        get_peft_model: PEFT's get_peft_model function
        bitsandbytes: Optional bitsandbytes module for 4-bit quantization

    Returns:
        Model wrapped with PEFT (may also be quantized)
    """
    load_kwargs: Dict[str, Any] = {
        "trust_remote_code": True,
    }

    # Configure quantization based on hardware tier
    if hardware_tier in ("consumer-gpu", "small-gpu"):
        if bitsandbytes is not None:
            try:
                # Try 4-bit quantization for memory efficiency (QLoRA-style)
                load_kwargs["quantization_config"] = bitsandbytes.BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_use_double_quant=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.bfloat16,
                )
                load_kwargs["torch_dtype"] = torch.bfloat16
                load_kwargs["device_map"] = "auto"
                print(
                    f"[peft-trl-orpo] Loading {model_name} with 4-bit quantization (QLoRA)"
                )
            except (ImportError, Exception) as e:
                # Fall back to bfloat16 without quantization
                print(
                    f"[peft-trl-orpo] 4-bit quantization unavailable ({e}), using bfloat16"
                )
                load_kwargs["torch_dtype"] = torch.bfloat16
                load_kwargs["device_map"] = "auto"
        else:
            # bitsandbytes not available, use bfloat16
            load_kwargs["torch_dtype"] = torch.bfloat16
            load_kwargs["device_map"] = "auto"
            print(
                f"[peft-trl-orpo] Loading {model_name} with bfloat16 (bitsandbytes not available)"
            )
    else:
        # CPU mode: use float32 with CPU mapping and memory optimizations
        load_kwargs["torch_dtype"] = torch.float32
        load_kwargs["device_map"] = "cpu"
        # Enable low_cpu_mem_usage for faster loading on memory-constrained systems
        load_kwargs["low_cpu_mem_usage"] = True
        print(f"[peft-trl-orpo] Loading {model_name} for CPU training (float32)")
        print("[peft-trl-orpo] CPU mode: low_cpu_mem_usage enabled")

    # Load base model
    model = AutoModelForCausalLM.from_pretrained(model_name, **load_kwargs)

    # Apply chat template if not already set
    if not tokenizer.chat_template:
        if hasattr(tokenizer, "default_chat_template"):
            tokenizer.chat_template = tokenizer.default_chat_template

    # Wrap with PEFT LoRA
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    return model


# ---------------------------------------------------------------------------
# PeftTrlORPOBackend
# ---------------------------------------------------------------------------


class PeftTrlORPOBackend(TrainerBackend):
    """
    PEFT + TRL ORPO trainer backend.

    This backend:
    - Uses PEFT to create/manage LoRA adapter checkpoints
    - Uses TRL's ORPO Trainer for preference optimization
    - Produces deployable checkpoints compatible with the plugin's deployment registry

    Requirements:
    - transformers
    - peft
    - trl
    - torch
    - bitsandbytes (for QLoRA quantization, optional but recommended)
    """

    def validate_spec(self) -> bool:
        """Validate the experiment spec for PEFT-TRL ORPO training."""
        self.errors = []

        # Check training mode is ORPO
        if self.spec.trainingMode != "orpo":
            self.errors.append(
                f"PEFT-TRL backend only supports 'orpo' training mode. "
                f"Got: '{self.spec.trainingMode}'"
            )

        # Check dataset export path exists and is readable
        if not os.path.exists(self.spec.datasetExportPath):
            self.errors.append(
                f"Dataset export not found: {self.spec.datasetExportPath}. "
                "Please ensure the ORPO export has been generated before training."
            )
        elif not os.path.getsize(self.spec.datasetExportPath) > 0:
            self.errors.append(
                f"Dataset export is empty: {self.spec.datasetExportPath}"
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
                "Recommended: 1e-6 to 1e-3"
            )

        if hps.loraRank < 4 or hps.loraRank > 256:
            self.errors.append(
                f"LoRA rank {hps.loraRank} is outside recommended range (4-256). "
                "Higher ranks increase adapter capacity but use more memory."
            )

        if hps.loraAlpha < 1:
            self.errors.append(f"LoRA alpha must be >= 1, got {hps.loraAlpha}")

        if hps.maxSeqLength < 128 or hps.maxSeqLength > 8192:
            self.errors.append(
                f"Max sequence length {hps.maxSeqLength} is outside recommended range (128-8192)."
            )

        if hps.batchSize < 1:
            self.errors.append(f"Batch size must be >= 1, got {hps.batchSize}")

        if hps.gradientAccumulation < 1:
            self.errors.append(
                f"Gradient accumulation must be >= 1, got {hps.gradientAccumulation}"
            )

        # Validate hardware tier
        if self.spec.hardwareTier == "cpu-experimental":
            # CPU training is supported but requires careful configuration
            print("[peft-trl-orpo] WARNING: CPU training is extremely slow.")
            print("[peft-trl-orpo] Recommendations:")
            print("  - Use small models (Qwen2-0.5B, Qwen2-1.5B)")
            print("  - Use batch_size=1, gradient_accumulation=1")
            print("  - Use max_seq_length <= 1024")
            print("  - Expect training to take hours instead of minutes")

        return len(self.errors) == 0

    def execute_training(self) -> TrainingExperimentResult:
        """
        Execute ORPO training using PEFT + TRL.

        Steps:
        1. Load and validate dataset
        2. Load base model with PEFT/quantization
        3. Configure ORPO trainer
        4. Run training
        5. Save adapter checkpoint
        6. Return training result
        """
        # -----------------------------------------------------------------
        # Lazy import of training dependencies
        # -----------------------------------------------------------------
        (
            torch,
            AutoModelForCausalLM,
            AutoTokenizer,
            LoraConfig,
            get_peft_model,
            TaskType,
            ORPOConfig,
            ORPOTrainer,
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
            print(f"[peft-trl-orpo] Loading dataset from {self.spec.datasetExportPath}")
            dataset = load_orpo_dataset(self.spec.datasetExportPath)
            print(f"[peft-trl-orpo] Loaded {len(dataset)} samples")

            # -----------------------------------------------------------------
            # Step 2: Load tokenizer
            # -----------------------------------------------------------------
            print(
                f"[peft-trl-orpo] Loading tokenizer for {self.spec.targetModelFamily}"
            )
            tokenizer = AutoTokenizer.from_pretrained(
                self.spec.targetModelFamily,
                trust_remote_code=True,
            )
            # Ensure pad token exists
            if tokenizer.pad_token is None:
                tokenizer.pad_token = tokenizer.eos_token
            tokenizer.padding_side = "right"

            # Apply chat template formatting
            dataset = prepare_dataset_for_orpo(dataset, tokenizer)
            print(f"[peft-trl-orpo] Dataset formatted with chat template")

            # -----------------------------------------------------------------
            # Step 3: Configure PEFT LoRA
            # -----------------------------------------------------------------
            hps = self.spec.hyperparameters
            lora_config = LoraConfig(
                task_type=TaskType.CAUSAL_LM,
                r=hps.loraRank,
                lora_alpha=hps.loraAlpha,
                lora_dropout=hps.loraDropout,
                target_modules=[
                    "q_proj",
                    "v_proj",
                    "k_proj",
                    "o_proj",
                    "gate_proj",
                    "up_proj",
                    "down_proj",
                ],
                bias="none",
                inference_mode=False,
            )
            print(
                f"[peft-trl-orpo] LoRA config: rank={hps.loraRank}, alpha={hps.loraAlpha}, dropout={hps.loraDropout}"
            )

            # -----------------------------------------------------------------
            # Step 4: Load model with PEFT
            # -----------------------------------------------------------------
            # Try to import bitsandbytes for 4-bit quantization
            bitsandbytes = None
            try:
                import bitsandbytes
            except ImportError:
                pass

            model = load_model_for_training(
                model_name=self.spec.targetModelFamily,
                hardware_tier=self.spec.hardwareTier,
                lora_config=lora_config,
                tokenizer=tokenizer,
                torch=torch,
                AutoModelForCausalLM=AutoModelForCausalLM,
                get_peft_model=get_peft_model,
                bitsandbytes=bitsandbytes,
            )

            # -----------------------------------------------------------------
            # Step 5: Configure ORPO training
            # -----------------------------------------------------------------
            output_dir = Path(self.spec.outputDir) / f"checkpoint-{checkpoint_id}"
            output_dir.mkdir(parents=True, exist_ok=True)

            # CPU-specific configuration
            is_cpu = self.spec.hardwareTier == "cpu-experimental"
            if is_cpu:
                # CPU mode: use memory-efficient settings
                # - No mixed precision (fp32 only)
                # - Use adafactor or adamw_torch (paged_adamw_8bit requires GPU)
                # - Enable gradient checkpointing to save memory
                # - Single-threaded dataloader to avoid issues
                optim = "adafactor"  # Memory-efficient, works on CPU
                use_bf16 = False
                use_fp16 = False
                gradient_checkpointing = True
                dataloader_num_workers = 0
                print("[peft-trl-orpo] CPU mode: using adafactor optimizer, gradient checkpointing enabled")
            else:
                # GPU mode: use 8-bit optimizer and bf16
                optim = "paged_adamw_8bit"
                use_bf16 = True
                use_fp16 = False
                gradient_checkpointing = False
                dataloader_num_workers = 0  # Safe default

            orpo_config = ORPOConfig(
                output_dir=str(output_dir),
                beta=0.1,  # ORPO penalty coefficient (from paper)
                learning_rate=hps.learningRate,
                per_device_train_batch_size=hps.batchSize,
                gradient_accumulation_steps=hps.gradientAccumulation,
                max_steps=hps.maxSteps,
                max_length=hps.maxSeqLength,  # TRL 0.29 uses max_length
                warmup_ratio=hps.warmupRatio,
                logging_steps=10,
                save_strategy="steps",
                save_steps=max(1, hps.maxSteps // 5),  # Save 5 times during training
                save_total_limit=1,  # Keep only best checkpoint
                report_to="none",  # Disable wandb/etc unless explicitly configured
                fp16=use_fp16,
                bf16=use_bf16,
                remove_unused_columns=False,
                optim=optim,
                ddp_find_unused_parameters=False,
                gradient_checkpointing=gradient_checkpointing,
                dataloader_num_workers=dataloader_num_workers,
            )
            print(
                f"[peft-trl-orpo] ORPO config: steps={hps.maxSteps}, batch_size={hps.batchSize}, lr={hps.learningRate}"
            )

            # -----------------------------------------------------------------
            # Step 6: Enable gradient checkpointing for CPU mode
            # -----------------------------------------------------------------
            if is_cpu:
                # Enable gradient checkpointing on the model to save memory
                if hasattr(model, "gradient_checkpointing_enable"):
                    model.gradient_checkpointing_enable()
                    print("[peft-trl-orpo] Gradient checkpointing enabled on model")

            # -----------------------------------------------------------------
            # Step 7: Initialize ORPO Trainer
            # -----------------------------------------------------------------
            # Note: Don't pass peft_config to ORPOTrainer since we already
            # wrapped the model with PEFT in load_model_for_training.
            # TRL 0.29+ doesn't allow both.
            trainer = ORPOTrainer(
                model=model,
                args=orpo_config,
                processing_class=tokenizer,
                train_dataset=dataset,
            )

            # -----------------------------------------------------------------
            # Step 8: Train!
            # -----------------------------------------------------------------
            print(f"[peft-trl-orpo] Starting ORPO training for {hps.maxSteps} steps...")
            training_output = trainer.train()
            print(f"[peft-trl-orpo] Training completed")

            # -----------------------------------------------------------------
            # Step 9: Save adapter checkpoint
            # -----------------------------------------------------------------
            adapter_path = output_dir / "adapter"
            model.save_pretrained(str(adapter_path))
            print(f"[peft-trl-orpo] Adapter saved to {adapter_path}")

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
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            with open(output_dir / "metadata.json", "w") as f:
                json.dump(checkpoint_meta, f, indent=2)

            # -----------------------------------------------------------------
            # Step 10: Compute metrics
            # -----------------------------------------------------------------
            elapsed = time.time() - start_time
            wall_clock_minutes = round(elapsed / 60, 2)

            # Extract metrics from training output
            final_loss = None
            tokens_seen = None
            if training_output and hasattr(training_output, "metrics"):
                metrics = training_output.metrics
                final_loss = metrics.get("train_loss")
                # Estimate tokens seen from steps and batch config
                tokens_seen = (
                    hps.maxSteps
                    * hps.batchSize
                    * hps.gradientAccumulation
                    * hps.maxSeqLength
                )

            # -----------------------------------------------------------------
            # Step 11: Return result
            # -----------------------------------------------------------------
            result = TrainingExperimentResult(
                experimentId=self.spec.experimentId,
                backend="peft-trl-orpo",
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
                f"[peft-trl-orpo] Training complete! Wall time: {wall_clock_minutes} minutes"
            )
            return result

        except Exception as e:
            # Training failed - return failure result
            import traceback

            error_msg = f"{type(e).__name__}: {str(e)}"
            print(f"[peft-trl-orpo] Training failed: {error_msg}")
            traceback.print_exc()

            return TrainingExperimentResult(
                experimentId=self.spec.experimentId,
                backend="peft-trl-orpo",
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

# Expose TrainerBackend for main() entry point compatibility
TrainerBackend = PeftTrlORPOBackend


# CLI entry point
if __name__ == "__main__":
    from backend_base import main

    main()
