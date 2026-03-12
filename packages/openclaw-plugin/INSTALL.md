# Installation Guide

## ⚠️ Known Issue: Plugin Dependencies

### Problem

When installing the plugin from source, you may encounter errors like:

```bash
Error: Cannot find module 'micromatch'
Error: Cannot find module '@sinclair/typebox'
```

**Root Cause**: The plugin depends on external npm packages that are not automatically installed when using `openclaw plugins install` with a local path.

---

## ✅ Solution

### Option 1: Automated Installation Script (Recommended)

Run the provided installation script:

```bash
cd /path/to/principles
./packages/openclaw-plugin/scripts/install.sh
```

This script will:
1. ✅ Build the plugin
2. ✅ Install all dependencies
3. ✅ Copy files to the correct location
4. ✅ Verify installation

---

### Option 2: Manual Installation

If the script doesn't work, follow these steps:

#### Step 1: Build the plugin

```bash
cd /path/to/principles/packages/openclaw-plugin
npm install
npm run build
```

#### Step 2: Install plugin dependencies

```bash
# Create the plugin directory
mkdir -p ~/.openclaw/extensions/principles-disciple

# Install dependencies in the plugin directory
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48
```

#### Step 3: Copy plugin files

```bash
# Copy built files
cp -r /path/to/principles/packages/openclaw-plugin/dist/* \
    ~/.openclaw/extensions/principles-disciple/

# Copy plugin metadata
cp /path/to/principles/packages/openclaw-plugin/openclaw.plugin.json \
    ~/.openclaw/extensions/principles-disciple/
```

#### Step 4: Verify installation

```bash
openclaw plugins list | grep -A 2 "Principles"
```

You should see:
```
│ Principles   │ principl │ loaded   │ ...
```

---

### Option 3: Install from npm (Future)

In future releases, the plugin will be published to npm:

```bash
npm install -g @openclaw/principles-disciple
openclaw plugins install principles-disciple
```

This will automatically handle all dependencies.

---

## 📁 Workspace Configuration

Principles Disciple needs to know where your agent's workspace directory is located. This is configured during installation.

### Automatic Configuration

The installer will automatically detect your OpenClaw workspace directory. You can also specify a custom directory:

```bash
# Run installer with custom workspace
./install-openclaw.sh
# Select "Custom directory" when prompted
```

### Manual Configuration

If you skipped configuration during installation, you can set it up manually:

#### Option 1: Configuration File (Recommended)

Create `~/.openclaw/principles-disciple.json`:

```json
{
  "workspace": "/path/to/your/workspace",
  "state": "/path/to/your/workspace/.state",
  "debug": false
}
```

#### Option 2: Environment Variables

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc)
export PD_WORKSPACE_DIR=/path/to/your/workspace
export PD_STATE_DIR=/path/to/your/workspace/.state

# Or set when starting OpenClaw
PD_WORKSPACE_DIR=/path/to/your/workspace openclaw-gateway start
```

#### Option 3: Debug Mode

To enable debug logging for path resolution:

```bash
export DEBUG=true
```

This will show detailed logs like:

```
[PD:PathResolver] Using workspace from config file: /home/user/workspace
[PD:WorkspaceContext] Normalized workspaceDir: /home/user/clawd/memory -> /home/user/clawd
```

### Configuration Priority

Configuration is resolved in this order (highest to lowest):

1. Environment variables (`PD_WORKSPACE_DIR`, `PD_STATE_DIR`)
2. Configuration file (`~/.openclaw/principles-disciple.json`)
3. OpenClaw environment (`OPENCLAW_WORKSPACE`)
4. Default (`~/.openclaw/workspace`)

---

## 🔍 Troubleshooting

### Plugin fails to load

**Error**: `Cannot find module 'micromatch'`

**Solution**:
```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8
```

### Plugin version mismatch

**Error**: Plugin shows old version

**Solution**:
```bash
# Remove old version
rm -rf ~/.openclaw/extensions/principles-disciple

# Reinstall
cd /path/to/principles
./packages/openclaw-plugin/scripts/install.sh
```

### Configuration errors

**Error**: `Invalid config: plugin not found: principles-disciple`

**Solution**:
```bash
# Reset OpenClaw config
openclaw doctor --fix

# Reinstall plugin
./packages/openclaw-plugin/scripts/install.sh
```

---

## 📦 Dependencies

The plugin requires the following npm packages:

| Package | Version | Purpose |
|---------|---------|---------|
| `micromatch` | ^4.0.8 | Glob pattern matching for PLAN whitelist |
| `@sinclair/typebox` | ^0.34.48 | Type definitions and validation |

These are **not** included in the plugin bundle to keep the distribution size small. They must be installed separately in the plugin directory.

---

## 🚀 Quick Start

After installation, enable the PLAN whitelist feature:

1. Edit your workspace's `docs/PROFILE.json`:

```json
{
  "progressive_gate": {
    "enabled": true,
    "plan_approvals": {
      "enabled": true,
      "max_lines_override": -1,
      "allowed_patterns": ["docs/**", "skills/**"],
      "allowed_operations": ["write", "edit"]
    }
  }
}
```

2. Ensure `docs/PLAN.md` has `STATUS: READY`

3. Restart your agent session

Now even Stage 1 agents can edit files when a READY plan exists!

---

## 📞 Support

If you encounter issues not covered here:

1. Check the [GitHub Issues](https://github.com/csuzngjh/principles/issues)
2. Create a new issue with:
   - Error message
   - OpenClaw version (`openclaw --version`)
   - Plugin version (check in `openclaw plugins list`)
   - Installation method used
