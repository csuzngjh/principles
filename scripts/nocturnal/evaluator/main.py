#!/usr/bin/env python3
"""
Nocturnal Evaluator CLI Entry Point
===================================

Dispatches to the appropriate evaluator backend based on the request.

Usage:
    python main.py --request <request.json> --output-dir <output_dir>

The request JSON should have an 'adapterFormat' field that determines
which backend to use:
- 'peft-adapter': PeftCheckpointEvaluator
- 'dry-run': DryRunEvaluator
"""

import sys
from pathlib import Path

# Add parent directory to path so backend_base can be imported
sys.path.insert(0, str(Path(__file__).parent))

from backend_base import main

if __name__ == "__main__":
    main()
