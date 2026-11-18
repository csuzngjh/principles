# Provider logo assets

Retrieved: **2026-11-18**. Everything here is bundled into the console build
(`dist/web/assets/providers/`) by `scripts/build-ui.mjs`; the runtime never
requests an external host.

Only vendor-published assets are stored. The mark itself is never redrawn,
recolored, or recombined. Raster files were only resized to a smaller square
(canvas unchanged) to keep the console bundle small; vector files are stored
untouched.

## Included

| PD provider id | File | Format | Source (vendor channel) | Notes |
| --- | --- | --- | --- | --- |
| `deepseek` | `deepseek.png` | 128×128 PNG | `https://www.deepseek.com/favicon.ico` (official site icon, 225×225 ICO) | Converted from the official ICO; mark unchanged. No public brand terms located. |
| `moonshotai-cn`, `kimi-coding` | `kimi.png` | 128×128 PNG | `https://www.kimi.com/pwa-192.png` (official PWA icon, 192×192) | Resized 192→128. Both PD ids are the same Kimi brand. No public brand terms located. |
| `minimax-cn` | `minimax.png` | 32×32 PNG | `https://www.minimaxi.com/favicon.ico` (official favicon) | Official file is 32×32 (source limit); displayed at 22 px. No public brand terms located. |
| `qwen-token-plan-cn` | `qwen.png` | 80×80 PNG | `https://img.alicdn.com/imgextra/i4/O1CN01OXv3EM1FN8t9W4P79_!!6000000000474-2-tps-80-80.png` (official qwen.ai icon) | Official file is 80×80 (source limit). No public brand terms located. |
| `xiaomi` | `xiaomi.png` | 32×32 PNG | `https://s01.mifile.cn/favicon.ico` (official mi.com favicon) | Official file is 32×32 (source limit); displayed at 22 px. No public brand terms located. |
| `zai` | `zai.svg` | 30×30 SVG | `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` (official z.ai favicon/apple-touch asset) | Vector, full colour incl. gradients. No public brand terms located. |
| `anthropic` | `anthropic.png` | 128×128 PNG | `https://www.anthropic.com/images/icons/apple-touch-icon.png` (official site icon, 180×180) | Resized 180→128. Anthropic press assets also live at `https://brandfolder.com/anthropic/newsroom`. Official palette is cream + black (no saturated full-colour version). |
| `google` | `google.png` | 128×128 PNG | `https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png` (official Gemini web asset) | Resized 512→128. Use is subject to Google's brand-feature guidelines (truthful reference, no modification). |
| `openrouter` | `openrouter.svg` | SVG glyph | `https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape.svg` (official brand page `https://openrouter.ai/brand`) | Vector. Brand page states: do not stretch, recolor, or remix the marks. |
| `mistral` | `mistral.svg` | 48×48 SVG | `https://mistral.ai/cms-media/api/media/file/icon-m-book-red.svg` (official mistral.ai asset) | Vector. No public brand terms located. |
| `together` | `together.svg` | SVG favicon | `https://www.together.ai/brand` → logo suite → `TogetherAI_Favicon.svg` | Vector, unmodified. |

## Excluded — no usable full-colour official asset

These providers keep the shared monogram fallback. No invented or third-party
lookalike is shipped.

| PD provider id | Reason |
| --- | --- |
| `openai` | The official site refuses automated asset retrieval (HTTP 403, including its favicon), and `openai.com/brand` exposes guidelines but no downloadable file. OpenAI's official mark is also monochrome. Not substituted from third-party mirrors. |
| `xai` | The official identity is monochrome and the official site refuses automated retrieval; there is no full-colour official asset to bundle. |
| `groq` | Groq's Trademark Policy states: “You may not … use Groq logos in ads, packaging, UI, or signage without a license from Groq.” The console UI is not licensed, so the official colour favicon is deliberately not shipped. |
| `nvidia` | NVIDIA's brand guidelines state that assets “may not be used in any manner that isn't expressly authorized in writing by NVIDIA.” No written authorization exists, so it is not shipped. |
| custom / unconfigured | Not a vendor; rendered with a neutral outline glyph. |

## Dark-theme handling

Full-colour marks are white-backed brand assets and several rely on light
contrast (black wordmarks, white glyphs). Instead of per-vendor dark variants,
every tile uses one unified light backing plate (`bg-white`) in both themes,
with a constant subtle border and fixed 22 px glyph box. No vendor-specific
inversion or outline exceptions are applied. Light/dark screenshots of the
provider list and the selected-provider detail are taken against this plate.

## Size budget

11 files, about 56 KB total (vectors where the vendor publishes them; rasters
capped at 128 px except vendors whose only official file is smaller). The
previous icon set was about 15 KB, so this stays well below a tenfold increase.
`provider-logos.test.ts` enforces file existence, the fallback list, raster
dimensions, and a bundle-size ceiling.
