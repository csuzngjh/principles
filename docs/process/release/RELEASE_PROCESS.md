# Release Process

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## 🌟 For Everyday Users

### One-Line Release

```
PR merged to main → Auto publish ✅
```

### Commit Format Cheat Sheet

| You Write | Version Change |
|-----------|---------------|
| `feat: new feature` | +0.1.0 |
| `fix: bug fix` | +0.0.1 |
| `feat!: breaking change` | +1.0.0 |

### How to Release?

1. Create PR with correct commit format
2. Merge to main
3. Wait 2 min, auto-published to npm

---

## 🤖 For AI Agents

### Auto Flow

```
PR → main → Actions → npm → 5-file sync → tag
```

### Triggers

- **Auto**: PR merged to main with `packages/**` changes
- **Manual**: Actions → Publish to npm → Run
- **Tag**: `git push origin v1.8.2`

### Smart Version Bump

Analyzes PR commits:

| Commit | Bump |
|--------|------|
| `feat!:` / `feat(...)!:` | MAJOR |
| `feat:` / `feature:` | MINOR |
| Others | PATCH |

### Version Sync Scope

- `packages/openclaw-plugin/package.json`
- `packages/openclaw-plugin/openclaw.plugin.json`
- `package.json` (root)
- `README.md` / `README_ZH.md`

---

## 🛠️ For Geeks & Developers

### Local Operations

```bash
# Sync version
./scripts/sync-version.sh           # From tag
./scripts/sync-version.sh 1.5.6    # Specify

# Manual publish
cd packages/openclaw-plugin
npm run build:production
npm publish --access public

# Check
npm view principles-disciple version
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| Version mismatch | `./scripts/sync-version.sh` |
| Publish failed | Check `NPM_TOKEN` |
| Build failed | `git diff --check` |

### Required Setup

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. Create "Automation" token
3. GitHub → Secrets → `NPM_TOKEN`