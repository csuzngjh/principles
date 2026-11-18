# Provider logo assets

These files are official brand marks, bundled with the console. Nothing is
fetched from a CDN or a vendor site at runtime; the build copies this directory
to `dist/web/assets/providers/`.

**Source:** [Simple Icons](https://simpleicons.org) (icon files retrieved from
`https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/<slug>.svg` with a
`raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/<slug>.svg`
fallback), retrieved 2026-11-18.

**License:** the Simple Icons SVG files are released under CC0 1.0. The brand
marks themselves remain trademarks of their respective owners and are used here
only to identify the provider a user is configuring.

| PD provider id | Simple Icons slug | File |
| --- | --- | --- |
| `deepseek` | `deepseek` | `deepseek.svg` |
| `moonshotai-cn` | `moonshotai` | `moonshotai-cn.svg` |
| `minimax-cn` | `minimax` | `minimax-cn.svg` |
| `kimi-coding` | `kimi` | `kimi-coding.svg` |
| `qwen-token-plan-cn` | `qwen` | `qwen-token-plan-cn.svg` |
| `xiaomi` | `xiaomi` | `xiaomi.svg` |
| `openai` | `openai` | `openai.svg` |
| `anthropic` | `anthropic` | `anthropic.svg` |
| `google` | `google` | `google.svg` |
| `openrouter` | `openrouter` | `openrouter.svg` |
| `mistral` | `mistralai` | `mistral.svg` |
| `nvidia` | `nvidia` | `nvidia.svg` |

## Providers without an official icon in this source

No official mark was available from Simple Icons at retrieval time, so these
fall back to a neutral monogram tile plus the provider name:

* `zai` — 智谱 GLM
* `xai` — xAI Grok
* `groq` — Groq
* `together` — Together AI
* `__custom__` — user-supplied endpoint

We deliberately do not approximate or invent a brand mark for these. If a
vendor publishes an official SVG, add it here and map it in
`src/ui/pages/control-center/provider-logos.ts`.
