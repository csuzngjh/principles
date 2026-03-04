---
name: evolve-task
description: Run the full evolution loop (triage 鈫?diagnosis 鈫?audit 鈫?plan 鈫?execute 鈫?review 鈫?log)
disable-model-invocation: true
user-invocable: true
metadata: '{"openclaw": {"category": "evolution", "priority": 8}}'
---

浣犲繀椤绘寜椤哄簭鎵ц浠ヤ笅姝ラ锛堜笉寰楄烦姝ワ級銆侫RGUMENTS: $ARGUMENTS

## Step 0: 鎭㈠涓婁笅鏂囷紙寮哄埗锛?
- 璇诲彇 docs/CHECKPOINT.md 鐨勬渶鍚庝竴鏉?
- 璇诲彇 docs/ISSUE_LOG.md 鐨勬渶杩?3 鏉?
- 璇诲彇 docs/DECISIONS.md 鐨勬渶杩戝喅绛?
- 濡傛灉瀛樺湪 docs/.pain_flag锛屽厛澶勭悊鏂偣鎭㈠

## Step 1: 璇诲彇杩愯鍙傛暟涓庤兘鍔涜嚜妫€
- 璇诲彇 docs/PROFILE.json锛岀悊瑙?risk_paths銆乬ate銆乼ests.commands銆?
- **鑳藉姏鑷**: 蹇€熸壂鎻忔彃浠剁洰褰曚笅鐨?`skills/` 鍜?`agents/`銆?

## Step 1.5: 鍏ㄧ淮鐜鎰熺煡 (Full-Spectrum Awareness)
- **鏈湴**: 杩愯 `git status` 鍜?`git log -n 5` 浜嗚В浠ｇ爜鐜扮姸銆?
- **杩滅▼**: 濡傛灉鍙敤 `gh`锛屽繀椤昏繍琛?`gh issue list --limit 5` 鍜?`gh pr list --limit 5`銆?

## Step 2: TRIAGE锛堣ˉ榻愪俊鎭級
- **鍦板浘浼樺厛**: 蹇呴』鍏堥槄璇?`codemaps/` 涓嬫灦鏋勫浘鎴?`docs/SYSTEM_PANORAMA.md`銆?
杈撳嚭锛欸oal, Problem, Evidence, Risk level.

## Step 3: 濮旀淳 Explorer锛堣瘉鎹敹闆嗭級
- 浣跨敤 `agent_send --agent explorer` 杩涜璇佹嵁鏀堕泦銆?
- **缁╂晥璇勪及**: 鍐欏叆 `docs/.verdict.json`銆?

## Step 4: 濮旀淳 Diagnostician锛堟牴鍥狅級
- 浣跨敤 `agent_send --agent diagnostician` 杩涜鏍瑰洜鍒嗘瀽銆?

## Step 5: 濮旀淳 Auditor锛堟紨缁庡璁★級
- 浣跨敤 `agent_send --agent auditor` 杩涜瀹¤銆?
- 缁撴灉鍐欏叆 `docs/AUDIT.md`銆?

## Step 6: 濮旀淳 Planner锛堣鍒掞級
- 浣跨敤 `agent_send --agent planner` 鐢熸垚璁″垝銆?
- 璁″垝鍐欏叆 `docs/PLAN.md`銆?

## Step 7: 濮旀淳 Implementer锛堟墽琛岋級
- 浣跨敤 `agent_send --agent implementer` 鎸夎鍒掓墽琛屻€?

## Step 8: 濮旀淳 Reviewer锛堝鏌ワ級
- 浣跨敤 `agent_send --agent reviewer` 瀹℃煡缁撴灉銆?

## Step 9: 鍙嶆€濅笌钀界洏
1. **绯荤粺杩涘寲**: 灏?Pain/Root cause 杩藉姞鍒?`docs/ISSUE_LOG.md`銆?
2. **鐢ㄦ埛鐢诲儚鏇存柊**: 鍐欏叆 `docs/.user_verdict.json`銆?

## Step 10: 鏈€缁堟眹鎶?(Final Briefing)
- 浣跨敤 `agent_send --agent reporter` 杩涜缁撻」闄堣堪銆?
