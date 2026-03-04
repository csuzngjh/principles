---
name: reflection
description: Perform a deep metacognitive reflection on the current task status, user sentiment, and systemic issues. Use this before context compaction or when stuck.
disable-model-invocation: false
---

# 鐥涘畾鎬濈棝 (Metacognitive Reflection)

**瑙﹀彂鍦烘櫙**: 涓婁笅鏂囧嵆灏嗗帇缂?(Memory Loss Imminent) 鎴?浠诲姟闀挎湡鍋滄粸銆?
**鐩爣**: 鍦ㄩ仐蹇樿缁嗚繃绋嬩箣鍓嶏紝鎻愬彇鈥滅棝鑻︽暀璁€濆苟鍥哄寲涓哄師鍒欍€?

璇锋墽琛屼互涓嬪弽鎬濇楠わ細

## 1. 鐜扮姸鎵弿 (Status Scan)
- **Goal**: 鎴戜滑鏈€鍒濈殑鐩爣鏄粈涔堬紵(Check `docs/PLAN.md` or early conversation)
- **Status**: 鐜板湪瀹屾垚浜嗗灏戯紵鍗″湪鍝噷锛?
- **Cost**: 鎴戜滑娑堣€椾簡澶ч噺 Token锛屼骇鍑烘槸鍚﹀尮閰嶏紵

## 2. 鐥涜嫤鎰熺煡 (Pain Detection)
璇疯瘹瀹炲洖绛斾互涓嬮棶棰橈紙Yes/No锛夛細
- [ ] **浠诲姟鍋滄粸**: 鏄惁杩炵画 3 杞互涓婃病鏈夊疄璐ㄦ€т唬鐮佽繘灞曪紵
- [ ] **閲嶅鐘敊**: 鏄惁鏈?Bug 琚慨澶嶅悗鍙堥噸鐜帮紝鎴栧悓鏍风殑閿欒鎶ヤ簡涓ゆ锛?
- [ ] **鐢ㄦ埛鎸触**: 鐢ㄦ埛鏄惁浣跨敤浜嗏€滀笉瀵光€濄€佲€滀笉鏄€濄€佲€滃仠涓嬧€濈瓑鍚﹀畾璇嶏紝鎴栬姘斿彉寰楁€ヨ簛锛?
- [ ] **鐩茬洰琛屽姩**: 鏄惁鍦ㄦ病鏈?PLAN 鎴?AUDIT 鐨勬儏鍐典笅鐩存帴淇敼浜嗕唬鐮侊紵
- [ ] **鏋舵瀯鍔ｅ寲**: 鐜板湪鐨勪唬鐮佹槸鍚︽瘮寮€濮嬫椂鏇翠贡浜嗭紵

## 3. 鏍瑰洜鍒嗘瀽 (If Pain Detected)
濡傛灉涓婅堪浠讳竴涓?Yes锛屽繀椤昏繘琛屾繁灞傚綊鍥狅細
- **Direct Cause**: 鎴戜滑鍋氫簡浠€涔堬紙鎴栨病鍋氫粈涔堬級瀵艰嚧浜嗙幇鍦ㄧ殑灞€闈紵
- **Root Cause**: 鎬濈淮妯″瀷鍝噷鍑轰簡闂锛燂紙鏄お鎬ヤ簬姹傛垚锛熻繕鏄拷瑙嗕簡宸叉湁鏂囦欢锛熻繕鏄交瑙嗕簡娴嬭瘯锛燂級

## 4. 杩涘寲钀界洏 (Evolution)
濡傛灉妫€娴嬪埌鐥涜嫤锛屽繀椤绘墽琛岋細
1. **璁板綍**: 灏嗗垎鏋愮粨鏋滃啓鍏?`docs/ISSUE_LOG.md`銆?
2. **鎻愮偧**: 濡傛灉杩欐槸绗簩娆″彂鐢燂紝鎻愮偧涓€鏉?**绂佹鎬у師鍒?(Must NOT)**銆?
3. **鍔犲浐**: 寤鸿涓€涓叿浣撶殑 Hook 鎴?Test 鏉ラ槻姝㈡湭鏉ラ噸鐘€?

## 5. 鎭㈠璁″垝 (Recovery)
- 鏃㈢劧瑕佸帇缂╀笂涓嬫枃锛屾垜浠笅涓€姝ヨ濡備綍浠モ€滄渶骞插噣鈥濈殑鐘舵€佺户缁紵
- 鏇存柊 `docs/PLAN.md`锛屾爣璁板綋鍓嶈繘搴︼紝纭繚鍘嬬缉鍚庤兘鏃犵紳琛旀帴銆?
