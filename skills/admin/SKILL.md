---
name: admin
description: System administration and recovery tool for humans. Use to init, repair, or reset the evolutionary agent framework.
disable-model-invocation: true
user-invocable: true
metadata: '{"openclaw": {"requires": {"bins": ["python3"]}, "category": "system"}}'
---

# Admin Console (绠＄悊鍛樻帶鍒跺彴)

浣犵幇鍦ㄦ壆婕旂殑鏄€滃彲杩涘寲绯荤粺绠＄悊鍛樷€濄€備綘鐨勮亴璐ｆ槸鏍规嵁鐢ㄦ埛鎻愪緵鐨勫弬鏁?`$ARGUMENTS` 缁存姢銆佷慨澶嶆垨鍒濆鍖栫郴缁熺殑鈥滄瘺鍧埧鈥濇灦鏋勩€?

---

## 鏍稿績鍔熻兘

### 1. `diagnose` (绯荤粺璇婃柇)
**鍔ㄤ綔**: 妫€鏌モ€滄瘺鍧埧鈥濇灦鏋勭殑瀹屾暣鎬с€?
- **鏍稿績缁勪欢**: 妫€鏌?`.claude/hooks/hook_runner.py` 鏄惁瀛樺湪涓斿彲鎵ц銆?
- **鏂囨。瀹屾暣鎬?*: 妫€鏌?`docs/PROFILE.json`, `docs/PLAN.md` 绛夋槸鍚﹀瓨鍦ㄣ€?
- **宸ュ叿鎰熺煡**: 妫€鏌?`docs/SYSTEM_CAPABILITIES.json`銆傝嫢缂哄け锛屾彁绀虹敤鎴凤細"鈿狅笍 灏氭湭杩涜宸ュ叿閾惧崌绾с€傚缓璁繍琛?`/bootstrap-tools` 浠ュぇ骞呮彁鍗囩郴缁熻兘鍔涖€?
- **璁板繂鎸傝浇**: 妫€鏌?`CLAUDE.md` 鏄惁鍖呭惈 `System Integration` 绔犺妭銆?
- **杈撳嚭**: 鐢熸垚涓€浠藉仴搴锋姤鍛婏紝鍒楀嚭缂哄け鎴栧紓甯哥殑椤圭洰銆?

### 2. `repair` (绯荤粺淇)
**鍔ㄤ綔**: 
- **閰嶇疆鎭㈠**: 濡傛灉 `PROFILE.json` 缂哄け鎴栨崯鍧忥紝灏濊瘯浠?`.claude/templates/PROFILE.json` 鎭㈠銆?
- **瑙勫垯鎭㈠**: 濡傛灉 `00-kernel.md` 缂哄け锛屼粠 `.claude/templates/00-kernel.md` 鎭㈠銆?
- **缁撴瀯琛ュ叏**: 纭繚 `PLAN.md` 鍖呭惈 `## Target Files` 鏍囬銆?
- **寮哄埗娓呯悊**: 鍒犻櫎 `.pain_flag`, `.verdict.json`, `.user_verdict.json`, `.pending_reflection` 绛変复鏃舵爣璁般€?

### 3. `reset` (寮哄埗閲嶇疆)

### 3. `reset` (寮哄埗閲嶇疆)
**鍔ㄤ綔**: 鍦ㄥ緱鍒扮敤鎴锋槑纭‘璁ゅ悗锛屽皢 `USER_PROFILE.json` 鍜?`AGENT_SCORECARD.json` 褰掗浂銆?

### 4. `status` (鐘舵€佹姤鍛?
**鍔ㄤ綔**: 姹囨姤褰撳墠 Risk Paths銆佺敤鎴锋渶楂?鏈€浣庡垎棰嗗煙銆丄gent 鎺掑悕銆?

---

## 鎵ц鍑嗗垯
- 鍙湁鍦ㄤ汉绫荤敤鎴疯緭鍏?`/admin` 鏃讹紝浣犳墠浼氱湅鍒版鎸囦护銆?
- 鎵ц鍓嶇畝杩拌鍒掞紝鎵ц鍚庤緭鍑衡€溾渽 绯荤粺宸插姞鍥?宸插垵濮嬪寲鈥濄€?
