#!/usr/bin/env python3
"""
Unit tests for the pure scoring helpers in peft_checkpoint_evaluator.py.
These tests do not require torch/transformers/peft.
"""

from peft_checkpoint_evaluator import (
    _extract_response_token_logprobs,
    _sigmoid_preference,
)


def test_extract_response_token_logprobs_gathers_target_token_scores():
    # token ids: [prompt_token, chosen_1, chosen_2]
    token_ids = [0, 2, 1]
    # each row predicts the next token
    log_prob_rows = [
        [-10.0, -5.0, -0.2],   # predicts token_ids[1] == 2
        [-10.0, -0.3, -7.0],   # predicts token_ids[2] == 1
    ]

    gathered, avg = _extract_response_token_logprobs(
        log_prob_rows=log_prob_rows,
        token_ids=token_ids,
        prompt_token_count=1,
    )

    assert gathered == [-0.2, -0.3]
    assert round(avg, 4) == -0.25


def test_extract_response_token_logprobs_rejects_missing_response_span():
    try:
        _extract_response_token_logprobs(
            log_prob_rows=[[-0.1, -0.2]],
            token_ids=[1],
            prompt_token_count=1,
        )
        assert False, "expected ValueError"
    except ValueError as err:
        assert "No response tokens" in str(err)


def test_sigmoid_preference_prefers_higher_logprob_response():
    score = _sigmoid_preference(chosen_avg_logprob=-0.2, rejected_avg_logprob=-1.1)
    assert 0.5 < score < 1.0
