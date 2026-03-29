#!/usr/bin/env python3
"""
PEFT Checkpoint Evaluator
==========================

Real checkpoint-aware evaluator using PEFT adapters.

This evaluator:
1. Loads a base model with a PEFT adapter from a checkpoint directory
2. Runs inference on ORPO samples (prompt, chosen, rejected)
3. Scores each sample based on the model's preference for chosen vs rejected
4. Uses log probability difference to compute preference scores

Scoring approach:
- For each sample, compute log P(response | prompt) for both chosen and rejected
- Score = sigmoid(log P(chosen) - log P(rejected)) = P(prefer chosen) / (P(chosen) + P(rejected))
- This gives a 0-1 score where 0.5 means the model is indifferent

Requirements:
- transformers
- peft
- torch
"""

import math
import os
import sys
from pathlib import Path
from typing import Optional, List

from backend_base import (
    EvaluatorBackend,
    EvaluationRequest,
    EvaluationSample,
    ScoredSample,
)


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
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        missing.append("transformers")

    try:
        import peft
    except ImportError:
        missing.append("peft")

    if missing:
        raise ImportError(
            f"Missing required dependencies: {', '.join(missing)}\n"
            "Please install them with:\n"
            "  pip install torch transformers peft\n"
        )

    return torch, AutoModelForCausalLM, AutoTokenizer


def _extract_response_token_logprobs(
    log_prob_rows: List[List[float]],
    token_ids: List[int],
    prompt_token_count: int,
) -> tuple[List[float], float]:
    """
    Gather the log-probabilities assigned to the actual response tokens.

    Each row in `log_prob_rows` predicts the next token, so row `i` predicts
    `token_ids[i + 1]`. Response tokens begin at `token_ids[prompt_token_count]`.
    """
    if prompt_token_count >= len(token_ids):
        raise ValueError("No response tokens available after the prompt span")

    gathered: List[float] = []
    for token_pos in range(prompt_token_count, len(token_ids)):
        row_idx = token_pos - 1
        if row_idx < 0 or row_idx >= len(log_prob_rows):
            raise ValueError("Response token position is out of range for logits")
        token_id = token_ids[token_pos]
        row = log_prob_rows[row_idx]
        if token_id < 0 or token_id >= len(row):
            raise ValueError(f"Token id {token_id} out of vocabulary range")
        gathered.append(float(row[token_id]))

    if not gathered:
        raise ValueError("No response tokens gathered for scoring")

    return gathered, sum(gathered) / len(gathered)


def _sigmoid_preference(chosen_avg_logprob: float, rejected_avg_logprob: float) -> float:
    return 1 / (1 + math.exp(-(chosen_avg_logprob - rejected_avg_logprob)))


class PeftCheckpointEvaluator(EvaluatorBackend):
    """
    PEFT-based checkpoint evaluator.

    Loads a base model with a PEFT adapter and uses log probability
    differences to score ORPO preference samples.
    """

    def validate_request(self) -> bool:
        """Validate the evaluation request."""
        self.errors = []

        # Check checkpoint path exists
        if not os.path.exists(self.request.checkpointPath):
            self.errors.append(
                f"Checkpoint path not found: {self.request.checkpointPath}"
            )
        elif not os.path.isdir(self.request.checkpointPath):
            self.errors.append(
                f"Checkpoint path is not a directory: {self.request.checkpointPath}"
            )

        # Check base model name is provided
        if not self.request.baseModelName:
            self.errors.append("Base model name is required")

        # Check samples are provided
        if not self.request.samples:
            self.errors.append("No samples provided for evaluation")

        # Check mode is valid
        if self.request.mode not in ("prompt_assisted", "reduced_prompt"):
            self.errors.append(
                f"Invalid mode: {self.request.mode}. Must be 'prompt_assisted' or 'reduced_prompt'"
            )

        return len(self.errors) == 0

    def load_checkpoint(self) -> bool:
        """Load the base model with PEFT adapter."""
        self.errors = []

        try:
            torch, AutoModelForCausalLM, AutoTokenizer = _check_and_import_deps()

            # Load tokenizer
            self._tokenizer = AutoTokenizer.from_pretrained(
                self.request.baseModelName,
                trust_remote_code=True,
            )
            if self._tokenizer.pad_token is None:
                self._tokenizer.pad_token = self._tokenizer.eos_token
            self._tokenizer.padding_side = "right"

            # Load base model
            load_kwargs: dict = {
                "trust_remote_code": True,
                "torch_dtype": torch.float16,
                "device_map": "auto",
            }

            self._model = AutoModelForCausalLM.from_pretrained(
                self.request.baseModelName, **load_kwargs
            )

            # Load PEFT adapter
            adapter_path = Path(self.request.checkpointPath)
            if not adapter_path.exists():
                raise FileNotFoundError(f"Adapter not found at: {adapter_path}")

            from peft import PeftModel

            self._model = PeftModel.from_pretrained(
                self._model, str(adapter_path), is_trainable=False
            )

            self._model.eval()

            print(f"[peft-evaluator] Loaded base model: {self.request.baseModelName}", file=sys.stderr)
            print(
                f"[peft-evaluator] Loaded adapter from: {self.request.checkpointPath}",
                file=sys.stderr,
            )

            return True

        except Exception as e:
            self.errors.append(f"Failed to load checkpoint: {str(e)}")
            return False

    def score_sample(self, sample: EvaluationSample) -> ScoredSample:
        """
        Score a single ORPO sample using log probability comparison.

        The score is the probability that the model prefers 'chosen' over 'rejected'
        given the prompt. Computed as sigmoid(log_prob_chosen - log_prob_rejected).

        Key implementation details:
        - Both sequences share the same prompt, so we compare response tokens only
        - Attention mask is used to exclude padding tokens from the sum
        - Normalized by response length to avoid bias toward shorter sequences
        - Uses log softmax to get per-token log probabilities
        """
        import torch

        tokenizer = self._tokenizer
        model = self._model

        prompt_text = sample.prompt
        chosen_text = sample.chosen
        rejected_text = sample.rejected

        prompt_prefix = f"{prompt_text}\n"
        chosen_enc = tokenizer(
            f"{prompt_prefix}{chosen_text}",
            return_tensors="pt",
            truncation=True,
            max_length=2048,
            add_special_tokens=False,
        )
        rejected_enc = tokenizer(
            f"{prompt_prefix}{rejected_text}",
            return_tensors="pt",
            truncation=True,
            max_length=2048,
            add_special_tokens=False,
        )
        chosen_prompt_len = len(
            tokenizer(
                prompt_prefix,
                truncation=True,
                max_length=2048,
                add_special_tokens=False,
            )["input_ids"]
        )
        rejected_prompt_len = len(
            tokenizer(
                prompt_prefix,
                truncation=True,
                max_length=2048,
                add_special_tokens=False,
            )["input_ids"]
        )

        # Move to model device
        device = next(model.parameters()).device
        chosen_enc = {k: v.to(device) for k, v in chosen_enc.items()}
        rejected_enc = {k: v.to(device) for k, v in rejected_enc.items()}

        with torch.no_grad():
            # Compute logits for both sequences
            chosen_logits = model(**chosen_enc).logits  # [1, seq_len, vocab]
            rejected_logits = model(**rejected_enc).logits  # [1, seq_len, vocab]

            # Convert to next-token log probabilities
            chosen_log_probs = torch.log_softmax(chosen_logits, dim=-1)
            rejected_log_probs = torch.log_softmax(rejected_logits, dim=-1)
            chosen_rows = chosen_log_probs.squeeze(0)[:-1].tolist()
            rejected_rows = rejected_log_probs.squeeze(0)[:-1].tolist()
            chosen_ids = chosen_enc["input_ids"].squeeze(0).tolist()
            rejected_ids = rejected_enc["input_ids"].squeeze(0).tolist()

            _, chosen_avg = _extract_response_token_logprobs(
                log_prob_rows=chosen_rows,
                token_ids=chosen_ids,
                prompt_token_count=chosen_prompt_len,
            )
            _, rejected_avg = _extract_response_token_logprobs(
                log_prob_rows=rejected_rows,
                token_ids=rejected_ids,
                prompt_token_count=rejected_prompt_len,
            )

            chosen_count = len(chosen_ids) - chosen_prompt_len
            rejected_count = len(rejected_ids) - rejected_prompt_len

            preference_score = _sigmoid_preference(chosen_avg, rejected_avg)
            score = max(0.0, min(1.0, preference_score))

            justification = (
                f"[peft-evaluator:{self.request.mode}] "
                f"pref={score:.3f} "
                f"(chosen_avg={chosen_avg:.3f}, rejected_avg={rejected_avg:.3f}, "
                f"n_chosen={int(chosen_count)}, n_rejected={int(rejected_count)})"
            )

        return ScoredSample(
            sampleFingerprint=sample.sampleFingerprint,
            score=round(score, 4),
            justification=justification,
            mode=self.request.mode,
        )


# Expose EvaluatorBackend for main() entry point compatibility
EvaluatorBackend = PeftCheckpointEvaluator


# CLI entry point
if __name__ == "__main__":
    from backend_base import main

    main()
