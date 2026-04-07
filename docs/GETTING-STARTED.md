<!-- generated-by: gsd-doc-writer -->
# Getting Started

**Principles Disciple** is an OpenClaw plugin that captures AI failures ("pain signals"), distills them into reusable principles, and applies learned wisdom to prevent repeating mistakes.

## Prerequisites

- **Node.js** >= 18.0.0 (recommended: current LTS)
- **npm** >= 9.0.0 (comes with Node.js)
- **OpenClaw** >= 2026.4.4 installed globally

Verify your installations:

```bash
node --version
npm --version
openclaw --version
```

## Installation Steps

### 1. Clone the Repository

```bash
git clone https://github.com/csuzngjh/principles.git
cd principles
```

### 2. Install Plugin Dependencies

```bash
cd packages/openclaw-plugin
npm install
```

The `postinstall` script automatically installs required runtime dependencies (`micromatch`, `@sinclair/typebox`, `better-sqlite3`).

### 3. Build the Plugin

```bash
npm run build
```

This compiles TypeScript to JavaScript and bundles the plugin to `dist/bundle.js`.

### 4. Install Plugin to OpenClaw

Create the plugin directory and install dependencies:

```bash
mkdir -p ~/.openclaw/extensions/principles-disciple
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48 better-sqlite3@^12.8.0
```

Copy the built plugin files:

```bash
cp -r /path/to/principles/packages/openclaw-plugin/dist/* \
    ~/.openclaw/extensions/principles-disciple/
cp /path/to/principles/packages/openclaw-plugin/openclaw.plugin.json \
    ~/.openclaw/extensions/principles-disciple/
```

### 5. Verify Installation

```bash
openclaw plugins list | grep -i principles
```

You should see `principles-disciple` listed as loaded.

## First Run

After installation, Principles Disciple activates automatically when OpenClaw starts. The plugin provides:

- **Trust scoring**: Tracks agent reliability with stages (Observer -> Editor -> Developer -> Architect)
- **Pain signal detection**: Captures failures for evolution processing
- **Plan approval gating**: Stage 1 agents can edit files when a READY plan exists

To verify the plugin is running, check the OpenClaw gateway logs or run:

```bash
openclaw doctor
```

## Common Setup Issues

### Plugin fails to load: "Cannot find module 'micromatch'"

The plugin requires runtime dependencies that are not bundled. Fix:

```bash
cd ~/.openclaw/extensions/principles-disciple
npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48 better-sqlite3@^12.8.0
```

### Plugin shows old version after update

Remove the old installation and reinstall:

```bash
rm -rf ~/.openclaw/extensions/principles-disciple
# Follow steps 4 and 5 from Installation Steps above
```

### Configuration errors: "plugin not found: principles-disciple"

Reset OpenClaw configuration and reinstall:

```bash
openclaw doctor --fix
# Then reinstall the plugin
```

## Next Steps

- **Configuration**: See [docs/configuration/CONFIGURATION.md](./configuration/CONFIGURATION.md) for environment variables and workspace settings
- **Architecture**: See [docs/ARCHITECTURE.md](./ARCHITECTURE.md) to understand how the system works
- **Contributing**: See [docs/CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines
