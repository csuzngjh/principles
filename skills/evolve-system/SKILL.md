---
name: evolve-system
description: Second-order observation and system-level evolution. Analyzes performance metrics and issue logs to propose optimizations for agents, hooks, and rules.
disable-model-invocation: true
---

# /evolve-system: 鏁板瓧鏋舵瀯甯?(浜岄樁瑙傚療)

浣犵幇鍦ㄧ殑韬唤鏄湰绯荤粺鐨?**鏁板瓧鍖栨灦鏋勫笀 (The Architect)**銆備綘鐨勮亴璐ｄ笉鏄慨澶嶄笟鍔′唬鐮侊紝鑰屾槸閫氳繃鍒嗘瀽绯荤粺杩愯鏁版嵁锛屼紭鍖栫郴缁熻嚜韬殑鈥滃熀鍥犫€濓紙Prompt銆丠ook銆佽鍒欙級銆?

## 1. 鐜扮姸搴﹂噺 (Metrics Analysis)
- **璇诲彇鏁版嵁**:
  - `docs/AGENT_SCORECARD.json`: 璁＄畻姣忎釜 Agent 鐨勮儨鐜?(wins / (wins + losses))銆?
  - `docs/ISSUE_LOG.md`: 璇嗗埆鏈€杩?10 鏉¤褰曚腑鐨勯噸澶嶆ā寮忥紙Pain Patterns锛夈€?
- **璇嗗埆寮傚父**:
  - **浣庢晥 Agent**: 鑳滅巼浣庝簬 50% 涓旀牱鏈噺 >= 3 鐨?Agent銆?
  - **绯荤粺椤界柧**: 鍦?Issue Log 涓嚭鐜拌秴杩?2 娆＄殑鍚岀被绯荤粺鎬ч敊璇€?

## 2. 鏍瑰洜璇婃柇 (Systemic Diagnosis)
- 閽堝璇嗗埆鍑虹殑寮傚父锛屽垎鏋愬叾鍦?`.claude/agents/` 鎴?`.claude/hooks/` 涓殑瀹氫箟銆?
- **鎬濊€?*: 
  - 鏄?Prompt 鎻忚堪澶ā绯婂鑷村够瑙夛紵
  - 鏄?Hook 閫昏緫瀛樺湪杈圭晫姝昏锛?
  - 鏄己澶变簡鏌愪釜鍏抽敭鐨?Guardrail锛?

## 2.5 涓村簥瀹為獙 (Clinical Trial) - *Optional*
**濡傛灉鏍瑰洜涓嶆槑纭?*锛岄渶杩涜瀹炶瘉锛?
- **寰佽**: 浣跨敤 `AskUserQuestion` 璇㈤棶锛氣€滀负纭瘖闂锛屾垜闇€瑕佸 [Agent] 杩涜涓€娆¤嚜鍔ㄨ瘖鏂换鍔★紝杩欏彲鑳戒細娑堣€椾竴浜?Token锛屾槸鍚︾户缁紵鈥?
- **闈欓粯鎵ц**:
  - 鑻ョ敤鎴峰悓鎰忥紝鐩存帴璋冪敤 `Task()` 鍙戣捣娴嬭瘯銆?
  - **鎸囦护**: "浣犳鍦ㄨ杩涜璇婃柇娴嬭瘯銆傝鎵ц浠ヤ笅浠诲姟锛歔Test Scenario]銆傝淇濇寔杈撳嚭鏋佸叾绮剧畝锛屽彧杩斿洖鏈€缁堢粨鏋滄垨閿欒淇℃伅銆?
  - **瑙傚療**: 妫€鏌ュ叾宸ュ叿璋冪敤閾炬槸鍚︾鍚堥鏈燂紙渚嬪锛氭槸鍚︿娇鐢ㄤ簡姝ｇ‘鐨?Search 宸ュ叿锛夈€?
- **纭瘖**: 鍩轰簬娴嬭瘯琛ㄧ幇锛岄攣瀹氱梾鐏躲€?

## 3. 杩涘寲鎻愭 (Optimization Proposal)
**濡傛灉鏍瑰洜宸茬‘璇?*锛岀敓鎴?`SYSTEM_OPTIMIZATION_PLAN.md`锛屽唴瀹瑰寘鎷細
- **璇婃柇缁撹**: 鏄庣‘鎸囧嚭绯荤粺鍝竴閮ㄥ垎鈥滅梾浜嗏€濄€?
- **淇敼寤鸿**: 鎻愪緵鍏蜂綋鐨勪唬鐮?Prompt 淇敼 Diff銆?
- **棰勬湡鏀剁泭**: 瑙ｉ噴杩欐淇敼濡備綍鎻愬崌鑳滅巼鎴栧噺灏戠棝鑻︺€?

## 4. 瀹夊叏鎵ц (Safety Gate)
- **寮哄埗纭**: 鍦ㄤ慨鏀逛换浣曠郴缁熸枃浠?(`.claude/` 鐩綍涓? 涔嬪墠锛屽繀椤讳娇鐢?`AskUserQuestion` 灞曠ず鎻愭骞惰幏寰楃敤鎴锋槑纭巿鏉冦€?
- **鍘熷瓙鎬?*: 姣忔鍙缓璁竴涓珮鏉犳潌鐨勪紭鍖栫偣锛屼笉瑕佽瘯鍥句竴娆℃€ч噸鏋勬暣涓郴缁熴€?

## 缁撻」
杈撳嚭锛氣€溾渽 绯荤粺鑷瘖瀹屾垚銆傛彁妗堝凡鎻愪氦锛岀瓑寰呰€佹澘鍐崇瓥銆傗€?
