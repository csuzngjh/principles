{
  "auditAt": "2026-10-25T12:03:33.939Z",
  "zipFile": "CEB-001-ai-blind-review-input.zip",
  "zipSize": 77199,
  "checks": [
    {
      "item": "candidate count",
      "expected": 60,
      "actual": 60,
      "pass": true
    },
    {
      "item": "RV id uniqueness",
      "expected": "60 unique",
      "actual": "60 unique (RV-001..060)",
      "pass": true
    },
    {
      "item": "no goldTruth in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no implies in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no acceptableVerdicts in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no expectedMode in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no provenance in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no sourceBinding in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no model identity in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no arm labels (B0/B1/E) in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no generation metadata in packets",
      "found": 0,
      "pass": true
    },
    {
      "item": "no API keys or credentials",
      "found": 0,
      "pass": true
    },
    {
      "item": "no absolute paths",
      "found": 0,
      "pass": true
    },
    {
      "item": "rv-to-source.json excluded from zip",
      "pass": true
    },
    {
      "item": "judge-only dir excluded from zip",
      "pass": true
    },
    {
      "item": "candidates.json content deep-scan (24 forbidden terms)",
      "pass": true
    }
  ],
  "unresolved": []
}
