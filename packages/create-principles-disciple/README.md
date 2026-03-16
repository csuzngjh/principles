# create-principles-disciple

Interactive CLI installer for [Principles Disciple](https://github.com/csuzngjh/principles) OpenClaw plugin.

## Usage

```bash
npx create-principles-disciple
```

## Options

```
--lang <en|zh>        Language preference (default: zh)
--force               Force overwrite existing installation
--smart               Smart merge mode (generate .update files)
--non-interactive     Skip prompts; if --force is not set, mode defaults to smart
--features <list>     Comma-separated features: evolution,trust,pain,reflection,okr,hygiene
```

## Commands

- `install` - Install OpenClaw plugin (default)
- `uninstall` - Remove OpenClaw plugin
- `status` - Show installation status

## Requirements

- Node.js >= 18.0.0
- Claude Code CLI

## License

MIT
