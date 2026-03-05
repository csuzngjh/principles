#!/bin/bash
set -e

# Principles Disciple - OpenClaw Plugin Installer
# -----------------------------------------------

# 1. Path configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="$PROJECT_ROOT/packages/openclaw-plugin"

# Default OpenClaw workspace — override via OPENCLAW_WORKSPACE env var
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$HOME/clawd}"
EXTENSIONS_DIR="$OPENCLAW_WORKSPACE/.openclaw/extensions"
TARGET_DIR="$EXTENSIONS_DIR/principles-disciple"

echo "🦞 Principles Disciple - OpenClaw Installer"
echo "------------------------------------------"
echo "  Workspace : $OPENCLAW_WORKSPACE"
echo "  Plugin src: $PLUGIN_SRC"
echo ""

# 2. Check source directory exists
if [ ! -d "$PLUGIN_SRC" ]; then
    echo "❌ Error: Plugin source not found at $PLUGIN_SRC"
    exit 1
fi

# 3. Build plugin
echo "📦 Building plugin..."
cd "$PLUGIN_SRC"
npm install --silent
npm run build --silent
echo "✅ Build complete."

# 4. Ensure extensions directory exists
mkdir -p "$EXTENSIONS_DIR"

# 5. Deploy
if [[ "$1" == "--copy" ]]; then
    # ── RELEASE MODE (copy files) ───────────────────────────────────────
    echo "🚚 Deploying in RELEASE mode (copying files)..."
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"

    # Copy plugin specifics
    cp -r dist package.json openclaw.plugin.json "$TARGET_DIR/"
    [ -f "tsconfig.json" ] && cp tsconfig.json "$TARGET_DIR/"

    # Copy shared assets from project root so that openclaw.plugin.json
    # can resolve "./agents" and "./skills" relative to plugin root.
    cp -r "$PROJECT_ROOT/agents" "$TARGET_DIR/agents"
    cp -r "$PROJECT_ROOT/skills"  "$TARGET_DIR/skills"

    echo "✅ Files copied to $TARGET_DIR"
else
    # ── DEV MODE (symlink) ──────────────────────────────────────────────
    echo "🔗 Deploying in DEV mode (creating symlink)..."

    if [ -L "$TARGET_DIR" ]; then
        rm "$TARGET_DIR"
    elif [ -d "$TARGET_DIR" ]; then
        echo "⚠️ Warning: $TARGET_DIR already exists as a directory."
        echo "   Remove it manually or use --copy to overwrite."
        exit 1
    fi

    ln -s "$PLUGIN_SRC" "$TARGET_DIR"
    echo "✅ Symlink created: $TARGET_DIR -> $PLUGIN_SRC"

    # In dev mode openclaw.plugin.json resolves "./agents" and "./skills"
    # relative to $PLUGIN_SRC. Create symlinks there if they don't exist yet.
    for dir in agents skills; do
        LINK="$PLUGIN_SRC/$dir"
        TARGET="$PROJECT_ROOT/$dir"
        if [ ! -e "$LINK" ]; then
            ln -s "$TARGET" "$LINK"
            echo "🔗 Linked: $LINK -> $TARGET"
        fi
    done
fi

# 6. Deploy runtime workspace documents (safe — only creates, never overwrites)
echo ""
echo "🧬 Installing OpenClaw workspace documents (safe mode)..."
DOCS_SRC="$PLUGIN_SRC/templates/openclaw"

for doc in SOUL.md AGENTS.md TOOLS.md USER.md HEARTBEAT.md IDENTITY.md; do
    DEST="$OPENCLAW_WORKSPACE/$doc"
    SRC="$DOCS_SRC/$doc"
    if [ ! -f "$SRC" ]; then
        continue
    fi
    if [ -f "$DEST" ]; then
        echo "  ⏭️  Skipping $doc (already exists). Delete it first if you want to reset."
    else
        cp "$SRC" "$DEST"
        echo "  📄 Created: $doc"
    fi
done

# 7. Register cron jobs (optional — requires openclaw CLI)
echo ""
echo "⏰ Registering cron jobs..."
if command -v openclaw > /dev/null 2>&1; then
    # Helper to avoid duplicates
    add_cron_if_missing() {
        local NAME="$1"
        local CRON="$2"
        local MSG="$3"
        
        if openclaw cron list | grep -Fq "$NAME"; then
            echo "  ⏭️  Skipping $NAME (already exists)."
        else
            openclaw cron add \
              --name "$NAME" \
              --cron "$CRON" \
              --message "$MSG" \
              2>/dev/null && echo "  ✅ $NAME cron registered." \
              || echo "  ⚠️ Failed to add $NAME cron."
        fi
    }

    add_cron_if_missing "PD Weekly Governance" "0 16 * * 5" \
      "Execute full weekly governance flow: review WEEK_EVENTS.jsonl, align OKRs, and produce a weekly summary in docs/okr/WEEK_STATE.json."

    add_cron_if_missing "PD Daily Reflection" "0 21 * * *" \
      "Review docs/ISSUE_LOG.md and docs/.pain_flag. Identify recurring pain points and append new principles to docs/PRINCIPLES.md."

    add_cron_if_missing "PD Capability Research" "0 0 1 * *" \
      "Research the web for the latest and most efficient CLI tools related to our current tech stack (see docs/SYSTEM_CAPABILITIES.json). If better alternatives exist, suggest an upgrade path."
else
    echo "  ⚠️ 'openclaw' not found. Skipping cron registration."
    echo "  💡 Run this script again after installing OpenClaw to register cron jobs."
fi

echo ""
echo "------------------------------------------"
echo "🎉 Deployment Complete!"
echo ""
echo "👉 Next steps:"
echo "   1. Restart your OpenClaw Gateway to apply the plugin."
echo "   2. Check logs for: [Principles Disciple] Plugin registered."
echo "   3. Run /system-status to verify the plugin is active."
