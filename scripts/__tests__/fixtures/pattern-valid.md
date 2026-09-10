# Error Pattern Index

## Pattern Cards

### EP-01 Trust Boundary Validation

<!-- error-pattern-routing
{
  "id": "EP-01",
  "risk": "high",
  "pathSignals": [
    "src/adapters"
  ],
  "diffSignals": [
    "JSON.parse"
  ],
  "requiredEvidence": [
    "Untrusted values stay unknown until a runtime guard validates them."
  ],
  "enforcement": "mixed"
}
-->

- **Use when**: handling parsed JSON, LLM output, SQLite rows, CLI options, artifact metadata, YAML, or caught errors.
