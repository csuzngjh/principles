# Provider logo assets

Retrieved: **2026-11-18**. Everything here is bundled into the console build
(`dist/web/assets/providers/`) by `scripts/build-ui.mjs`; the runtime never
requests an external host.

These are the vendors' own published mark files (vendor site/favicon, vendor
CDN, vendor press/brand page, or the official file mirrored on Wikimedia
Commons). The mark itself is never redrawn, recolored, recombined or
watermarked. Raster files were only resized to a smaller square (canvas
unchanged) to keep the console bundle small; vector files are stored untouched.
This project is a non-commercial open-source project and makes **no claim of
authorization** for any mark — only the source, retrieval date and format are
recorded below.

## Included (all 16 catalog providers)

| PD provider id | File | Format | Source (retrieved 2026-11-18) |
| --- | --- | --- | --- |
| `deepseek` | `deepseek.png` | 128×128 PNG | `https://www.deepseek.com/favicon.ico` (225×225 ICO, converted to PNG) |
| `moonshotai-cn`, `kimi-coding` | `kimi.png` | 128×128 PNG | `https://www.kimi.com/pwa-192.png` (192×192, resized to 128) |
| `minimax-cn` | `minimax.png` | 32×32 PNG | `https://www.minimaxi.com/favicon.ico` (official 32×32) |
| `qwen-token-plan-cn` | `qwen.png` | 80×80 PNG | `https://img.alicdn.com/imgextra/i4/O1CN01OXv3EM1FN8t9W4P79_!!6000000000474-2-tps-80-80.png` (official qwen.ai icon) |
| `xiaomi` | `xiaomi.png` | 32×32 PNG | `https://s01.mifile.cn/favicon.ico` (official mi.com favicon) |
| `zai` | `zai.svg` | 30×30 SVG | `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` (official z.ai icon) |
| `anthropic` | `anthropic.png` | 128×128 PNG | `https://www.anthropic.com/images/icons/apple-touch-icon.png` (180×180, resized to 128) |
| `google` | `google.png` | 128×128 PNG | `https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png` (official Gemini web asset, 512→128) |
| `openai` | `openai.svg` | SVG symbol | `https://upload.wikimedia.org/wikipedia/commons/6/66/OpenAI_logo_2025_%28symbol%29.svg` (Wikimedia Commons `File:OpenAI logo 2025 (symbol).svg`; official OpenAI blossom) |
| `xai` | `xai.svg` | SVG symbol | `https://upload.wikimedia.org/wikipedia/commons/5/57/XAI-Logo.svg` (Wikimedia Commons `File:XAI-Logo.svg`) |
| `groq` | `groq.svg` | 33×33 SVG | `https://groq.com/favicon.svg` (official Groq favicon, orange/white) |
| `nvidia` | `nvidia.png` | 48×48 PNG | `https://www.nvidia.com/favicon.ico` (official favicon; extracted the 48×48 frame, green eye) |
| `openrouter` | `openrouter.svg` | SVG glyph | `https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-grape.svg` (official brand page `https://openrouter.ai/brand`) |
| `mistral` | `mistral.svg` | 48×48 SVG | `https://mistral.ai/cms-media/api/media/file/icon-m-book-red.svg` (official mistral.ai asset) |
| `together` | `together.svg` | SVG favicon | `https://www.together.ai/brand` → logo suite → `TogetherAI_Favicon.svg` |

## Fallback

Only the custom/unconfigured entry uses the neutral monogram/outline glyph.
It is not a vendor. Every one of the 16 catalog providers above has a real
vendor-published mark, so there is no vendor left on the initial-letter
fallback.

OpenAI and xAI publish monochrome marks by design; their official files above
are used as-is (no recolouring), on the same light plate as the colour marks.

## Dark-theme handling

Full-colour marks are authored for light surfaces (black wordmarks, white
glyphs). Instead of per-vendor dark variants, every tile uses one unified light
backing plate (`bg-white`) in both themes, with a constant subtle border and a
fixed 22 px glyph box. No vendor-specific inversion or outline exception is
applied. Light/dark screenshots of the list and the selected-provider detail
are taken against this plate.

## Size budget

15 files, about 60 KB total (vectors where the vendor publishes them; rasters
capped at 128 px except vendors whose only official file is smaller — MiniMax
32 px, Xiaomi 32 px, Qwen 80 px, NVIDIA 48 px). The previous icon set was about
15 KB, so this stays well below a tenfold increase. `provider-logos.test.ts`
enforces file existence, full 16-provider coverage, the fallback list, raster
dimensions, SVG safety and a 200 KB bundle ceiling.
