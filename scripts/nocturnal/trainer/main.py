#!/usr/bin/env python3
"""
Nocturnal Trainer Main Entry Point
==================================

Routes to the appropriate trainer backend based on the experiment spec.

Usage:
    python main.py --spec experiment.json --output-dir /path/to/output

Backends:
    - peft-trl-orpo: Reference PEFT + TRL ORPO implementation
    - unsloth-orpo: Unsloth-accelerated ORPO (same contract)
    - dry-run: Validation only, no real training
"""

from backend_base import main

if __name__ == "__main__":
    main()
