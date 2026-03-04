---
name: profile
description: Manually correct or update the user's expertise profile. Use to tell the system "I am an expert in X" or "I am a novice in Y".
disable-model-invocation: true
---

# Profile Corrector (鐢诲儚淇)

浣犵幇鍦ㄦ槸鈥滀汉宸ュ共棰勭敾鍍忊€濈粍浠躲€?

**浠诲姟**:
1. 瑙ｆ瀽鐢ㄦ埛杈撳叆鐨?`$ARGUMENTS` (鏍煎紡濡?"Frontend: Expert")銆?
2. 鐢熸垚涓€涓?*澧為噺璇勪环**鏂囦欢 `docs/.user_verdict.json`锛屽己鍒跺皢璇ラ鍩熺殑鏉冮噸璁句负鏋侀珮锛堟垨鏋佷綆锛岃鐢ㄦ埛鎻忚堪鑰屽畾锛夈€?
3. 鎻愮ず鐢ㄦ埛锛氬彉鏇村皢鍦ㄤ换鍔＄粨鏉?(Stop) 鍚庣敓鏁堛€?

**JSON 妯℃澘**:
```json
{
  "updates": [
    {"domain": "<EXTRACTED_DOMAIN>", "delta": 10, "reason": "User self-declared expertise"}
  ]
}
```
*(娉ㄦ剰锛氬鏋滄槸 Novice锛宒elta 璁句负 -10)*
