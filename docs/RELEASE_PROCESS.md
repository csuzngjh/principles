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
Code Change → Pull Request → Merge to main → GitHub Actions → npm publish → Version Sync → Tag Created
```

### Trigger Conditions

The release workflow automatically runs when:

1. **PR Merged to main** - Any PR merged to `main` that modifies files in:
   - `packages/openclaw-plugin/**`
   - `packages/create-principles-disciple/**`

2. **Manual Trigger** - Workflow dispatch with options:
   - Package selection
   - Version bump type (`auto`/`patch`/`minor`/`major`)

3. **Tag Push** - Push tags matching `v*`

## Smart Version Management

### Automatic Version Bump

The system analyzes commits in the PR to determine version type:

| Commit Type | Version Bump |
|-------------|--------------|
| `feat!:` or `feat(...)!:` | **MAJOR** (breaking change) |
| `feat:` or `feature:` | **MINOR** (new feature) |
| `fix:`, `docs:`, `chore:`, etc. | **PATCH** (default) |

### Version Synchronization

Each release automatically syncs version across 5 files:

| File | Description |
|------|-------------|
| `packages/openclaw-plugin/package.json` | npm package version |
| `packages/openclaw-plugin/openclaw.plugin.json` | Plugin manifest version |
| `package.json` (root) | Monorepo version |
| `README.md` | Documentation version badge |
| `README_ZH.md` | Documentation version badge |

### Version Format

```
{MAJOR}.{MINOR}.{PATCH}
```

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes

## Automatic Changelog Generation

Releases automatically generate categorized changelogs:

- 🚀 **Features** - New features
- 🐛 **Bug Fixes** - Bug fixes
- 🔧 **Other Changes** - Other changes

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

### Manual Version Sync

Use the `sync-version.sh` script:

```bash
# Sync from latest Git Tag
./scripts/sync-version.sh

# Specify version
./scripts/sync-version.sh 1.5.6
```

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
   - `feat:` - New feature → minor version
   - `fix:` - Bug fix → patch version
   - `feat!:` - Breaking change → major version
   - `docs:`, `chore:` - Other → patch version

3. **Test the plugin**:
   ```bash
   npm install -g principles-disciple@latest
   openclaw gateway restart
   /pd-version
   ```

## Release Process Details

### Automatic Release (Recommended)

1. Create PR with proper commit format
2. Merge PR to main
3. GitHub Actions automatically:
   - Analyzes commits to determine version type
   - Bumps version number
   - Syncs all files
   - Publishes to npm
   - Creates Git tag
   - Generates GitHub Release

### Manual Trigger

1. Go to Actions → Publish to npm
2. Select "Run workflow"
3. Choose package and version bump type
4. Click "Run workflow"

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

### Version Out of Sync

Run the sync script:

```bash
./scripts/sync-version.sh
git add -A && git commit -m 'chore: sync version'
```

## Rollback

If a release fails:

```bash
git revert HEAD
git push
```

npm does not support deleting versions. If critical, publish a patch fix.