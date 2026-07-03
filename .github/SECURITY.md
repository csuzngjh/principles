# Security Policy

## Reporting a Vulnerability

The Principles Disciple (PD) team takes security vulnerabilities seriously. We appreciate your efforts to responsibly disclose your findings.

**⚠️ DO NOT open a public GitHub issue for security vulnerabilities.**

### Preferred Reporting Channel

Please report security vulnerabilities via **GitHub Security Advisory**:

1. Go to https://github.com/csuzngjh/principles/security/advisories/new
2. Click "Report a vulnerability"
3. Fill in the title, description, and reproduction steps
4. Submit

This channel allows encrypted communication with maintainers and lets you request a CVE identifier once the vulnerability is confirmed.

### What to Include

- Description of the vulnerability and its impact
- Affected version(s) (run `npm list principles-disciple` or check `package.json`)
- Step-by-step reproduction (minimal viable reproduction preferred)
- Your assessment of severity (low / medium / high / critical)
- Suggested fix, if any

### Response Time (SLA)

| Stage | Target |
|-------|--------|
| Acknowledgment of receipt | 48 hours |
| Initial assessment (severity + triage) | 5 business days |
| Fix or mitigation for High/Critical | 14 days |
| Fix or mitigation for Medium/Low | 30 days |
| Public disclosure (after fix released) | Coordinated with reporter |

These SLAs are best-effort targets, not contractual guarantees.

### Scope

**In scope:**
- Vulnerabilities in PD runtime code (`packages/openclaw-plugin/`, `packages/principles-core/`)
- Supply chain attacks against the published `principles-disciple` npm package
- Sandbox escape from `node:vm` RuleHost execution
- PII or secret leakage into logs, trajectories, or audit artifacts
- Local WebUI (`pd-console`) binding or authentication bypass

**Out of scope:**
- Vulnerabilities in dependencies (report to upstream maintainers)
- Vulnerabilities requiring already-compromised host (physical access, root)
- Theoretical V8 0day escapes from `node:vm` (PD documents this as accepted residual risk — see [docs/architecture/SECURITY_BASELINE.md](../docs/architecture/SECURITY_BASELINE.md))

### Public Disclosure

We follow coordinated disclosure. Once a fix is released, we will:
1. Publish a GitHub Security Advisory with CVE (if applicable)
2. Credit the reporter (unless they prefer to remain anonymous)

## Safe Harbor

Good-faith security research on PD is welcome. We will not pursue legal action against researchers who:
- Avoid accessing or modifying other users' data
- Do not degrade service availability
- Report promptly and coordinate with us on disclosure
