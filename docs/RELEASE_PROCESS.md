# Release Process

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

---

## For AI Agents (Quick Start)

### One-Line Release

```
PR merged to main → Auto publish ✅
```

### Commit Format Cheat Sheet

| Commit | Version Change | Example |
|--------|---------------|---------|
| `feat:` | +0.1.0 | New feature |
| `fix:` | +0.0.1 | Bug fix |
| `feat!:` | +1.0.0 | Breaking change |

### Steps

1. Create PR with correct commit format
2. Merge to main
3. Wait for auto-publish (~2 min)

---

## For Developers

### Auto Release Flow

```
PR → main → GitHub Actions → npm publish → 5-file sync → Git tag
```

### Triggers

| Trigger | Description |
|---------|-------------|
| PR merged to main | Auto-trigger on `packages/**` changes |
| Manual dispatch | Actions → Publish to npm → Run |
| Tag push | `git push origin v1.5.6` |

### Smart Version Bump

Analyzes PR commits to determine version type:

| Commit Type | Bump | Scenario |
|------------|------|----------|
| `feat!:` / `feat(...)!:` | MAJOR | Breaking change |
| `feat:` / `feature:` | MINOR | New feature |
| Others (`fix:`, `docs:`, `chore:`) | PATCH | Default |

### Version Sync (5 Files)

| File | Description |
|------|-------------|
| `packages/openclaw-plugin/package.json` | npm package |
| `packages/openclaw-plugin/openclaw.plugin.json` | Plugin manifest |
| `package.json` (root) | Monorepo version |
| `README.md` | Documentation |
| `README_ZH.md` | Documentation |

---

## Local Operations

### Sync Version

```bash
./scripts/sync-version.sh           # From Git tag
./scripts/sync-version.sh 1.5.6    # Specify version
```

### Manual Publish

```bash
cd packages/openclaw-plugin
npm run build:production
npm publish --access public
```

### Check Version

```bash
npm view principles-disciple version
/pd-version  # In OpenClaw
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Version mismatch | `./scripts/sync-version.sh` |
| Publish failed | Check `NPM_TOKEN` validity |
| Build failed | `git diff --check` for conflicts |

---

## Setup Required

### npm Token

1. [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. Create "Automation" token
3. GitHub → Settings → Secrets → `NPM_TOKEN`
