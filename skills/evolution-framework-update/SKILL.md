---
name: evolution-framework-update
description: 鎷夊彇鍘熷垯淇″緬杩涘寲妗嗘灦鐨勬渶鏂版洿鏂帮紙鍖呭惈 Orchestrator 妯″紡銆佸紓姝ラ槦鍒楀強鍦板浘浼樺厛鍗忚锛夈€?
---

# /evolution-framework-update: 杩涘寲妗嗘灦鑷洿鏂?

**鐩爣**: 鍚屾涓婃父妗嗘灦鐨勬渶鏂颁唬鐮侊紙Hooks, Skills, Agents, Daemon锛夛紝淇濇寔绯荤粺杩涘寲鑳藉姏銆?

## 1. 鎵ц鏇存柊
杩愯浠ヤ笅鑴氭湰鎷夊彇鏈€鏂颁唬鐮侊細

```bash
bash scripts/update_agent_framework.sh
```

## 2. 鍐茬獊澶勭悊 (Smart Merge)
鑴氭湰杩愯鍚庯紝璇锋鏌ヨ緭鍑猴細
- **鏃犲啿绐?*: 濡傛灉鏄剧ず "鉁?Update complete"锛屽垯鏃犻渶鎿嶄綔銆?
- **鏈夊啿绐?*: 濡傛灉鏄剧ず "鈿狅笍 Updates found with conflicts"锛?
  1. 鏌ユ壘鎵€鏈?`.update` 鏂囦欢锛?
     ```bash
     find .claude -name "*.update"
     ```
  2. 瀵逛簬姣忎竴涓啿绐佹枃浠讹紙渚嬪 `rules/00-kernel.md` vs `rules/00-kernel.md.update`锛夛細
     - **璇诲彇** 鍘熸枃浠跺拰 `.update` 鏂囦欢銆?
     - **鍒嗘瀽** 宸紓锛氬悎鍏ヤ笂娓哥殑鏂板姛鑳斤紝淇濈暀鏈湴鐨勪釜鎬у寲閰嶇疆銆?
     - **娓呯悊**锛氬悎骞跺畬鎴愬悗鍒犻櫎 `.update` 鏂囦欢銆?

## 3. 閲嶅惎鐢熸晥
鏇存柊瀹屾垚鍚庯紝寤鸿閲嶅惎 Session 浠ュ姞杞芥渶鏂扮殑绁炵粡涓灑閫昏緫銆
