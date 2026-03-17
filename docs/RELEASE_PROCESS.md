# Release Process

[English](RELEASE_PROCESS.md) | [中文](RELEASE_PROCESS_ZH.md)

This document describes the automated release process for Principles Disciple packages.

## Packages

| Package | Path | npm Name |
|---------|------|----------|
| OpenClaw Plugin | `packages/openclaw-plugin` | `principles-disciple` |
| Installer | `packages/create-principles-disciple` | `create-principles-disciple` |

## Automated Release Flow

```
Code Change → Pull Request → Merge to main → GitHub Actions → npm publish → Tag Created
```

### Trigger Conditions

The release workflow automatically runs when:

1. **PR Merged to main** - Any PR merged to `main` that modifies files in:
   - `packages/openclaw-plugin/**`
   - `packages/create-principles-disciple/**`

2. **Manual Trigger** - Workflow dispatch with options:
   - Package selection
   - Version bump type (patch/minor/major)

3. **Tag Push** - Push tags matching:
   - `principles-disciple-v*`
   - `create-principles-disciple-v*`

## Version Management

### Version Bump Rules

| Trigger | Bump Type |
|---------|-----------|
| PR merged to main | `patch` (default) |
| Manual workflow dispatch | User selected |

### Version Format

```
{MAJOR}.{MINOR}.{PATCH}
```

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes

## Setup Required

### 1. npm Token

1. Go to [npmjs.com → Access Tokens](https://www.npmjs.com/settings/tokens)
2. Create "Automation" token (bypasses 2FA for CI)
3. Add to GitHub:

```
Repository → Settings → Secrets → Actions
Name: NPM_TOKEN
Value: your-npm-automation-token
```

### 2. Trusted Publishing (Recommended)

1. npm: Package Settings → Publishing → Add CI
2. Add your GitHub repository
3. The workflow uses `id-token: write` for provenance

## Local Development

### Manual Publish

```bash
cd packages/openclaw-plugin
npm run build:production
npm publish --access public
```

### Check Version

```bash
cat packages/openclaw-plugin/package.json | grep version
npm view principles-disciple version
```

### Plugin Version Check

After installation, run in OpenClaw:

```
/pd-version
```

## Best Practices

1. **Always test locally first**:
   ```bash
   npm run build
   npm run test
   ```

2. **Use conventional commits**:
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation
   - `chore:` - Maintenance

3. **Test the plugin**:
   ```bash
   npm install -g principles-disciple@latest
   openclaw gateway restart
   /pd-version
   ```

## Troubleshooting

### Build Fails

Check for merge conflicts in source files:

```bash
git diff --check
```

### Publish Fails

1. Verify npm token: `npm whoami`
2. Check package name in `package.json`
3. Ensure version is unique: `npm view principles-disciple versions`

## Rollback

If a release fails:

```bash
git revert HEAD
git push
```

npm does not support deleting versions. If critical, publish a patch fix.
