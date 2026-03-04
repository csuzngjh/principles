---
name: reflection-log
description: Final task reflection and evolution logging. Use to capture pain signals, update profiles, and propose new principles.
disable-model-invocation: true
---

# Reflection & Evolution (鍙嶆€濅笌钀界洏)

**鐩爣**: 灏嗗崟娆′换鍔＄殑缁忛獙杞寲涓虹郴缁熺殑姘镐箙璁板繂銆?

璇锋墽琛屼互涓嬬粨椤规搷浣滐細

## 1. Pain Summary (鐥涜嫤鎽樿)
- 绠€杩版湰娆′换鍔′腑鏈€鎶樼（銆佹渶鑰楁椂鎴栧鑷村け璐ョ殑鐐广€?

## 2. Issue Logging
- **Action**: 灏嗚缁嗙殑 Pain Signal 鍜岃瘖鏂粨鏋滆拷鍔犲埌 `docs/ISSUE_LOG.md`銆?

## 3. Evolution Candidates
- **Principle**: 鎻愯涓€鏉℃柊鍘熷垯锛圥-XX锛夈€?
- **Guardrail**: 寤鸿涓€涓叿浣撶殑 Hook銆丷ule 鎴?Test銆?
  - **璺緞鎷︽埅**: 寤鸿灏嗘晱鎰熺洰褰曞姞鍏?`docs/PROFILE.json` 鐨?`risk_paths`銆?
  - **琛屼负鎷︽埅**: 寤鸿鍦?`docs/PROFILE.json` 鐨?`custom_guards` 涓坊鍔犳鍒欙紝浠ユ嫤鎴壒瀹氬伐鍏风殑鍗遍櫓璋冪敤锛堝 `Edit.*SYSTEM`锛夈€?

## 4. Positive Reinforcement (姝ｅ悜寮哄寲)
- **妫€鏌ュ崜瓒婁俊鍙?*: 
  1. 鐢ㄦ埛鏄庣‘鐨勮禐璧?(Quote user).
  2. 鎬ц兘/璐ㄩ噺鎸囨爣鐨勫瑙傝穬杩?(Cite data).
  3. Reviewer 鐨勯珮搴﹁瘎浠?(Excellent/Elegant).
- **鎻愬彇妯″紡**: 濡傛灉瀛樺湪涓婅堪淇″彿锛屽湪 `docs/.user_verdict.json` 涓澶栬褰?`achievement` 瀛楁锛屾弿杩版湰娆℃垚鍔熺殑琛屼负妯″紡銆?

## 5. Attribution (鐢诲儚鏇存柊)
- **Agent Scorecard**: 璇勪及鏈浣跨敤鐨勫瓙鏅鸿兘浣撹〃鐜帮紝鍐欏叆 `docs/.verdict.json`銆傛牸寮忛伒寰?`@docs/schemas/agent_verdict_schema.json`銆?
- **User Profile**: 璇勪及鐢ㄦ埛鎸囦护璐ㄩ噺涓庡亸濂斤紝鍐欏叆 `docs/.user_verdict.json`銆傛牸寮忛伒寰?`@docs/schemas/user_verdict_schema.json`銆?

## 6. Cleanup
- 娓呯悊鎵€鏈変腑闂存爣璁版枃浠讹紙濡?`.pain_flag`, `.verdict.json` 绛夛級銆?
