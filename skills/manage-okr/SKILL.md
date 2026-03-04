---
name: manage-okr
description: Full-lifecycle OKR management. Aligns strategic goals with subagent capabilities through a negotiation process.
disable-model-invocation: true
user-invocable: true
metadata: '{"openclaw": {"category": "strategy", "priority": 9}}'
---

# /manage-okr: 鐩爣涓庡叧閿粨鏋滅鐞?

浣犳槸涓€浣?OKR 缁勭粐涓撳銆備綘鐨勪换鍔℃槸鍗忚皟鎬绘垬鐣?(`STRATEGY.md`) 涓庡悇宀椾綅瀛愭櫤鑳戒綋 (`agents/*.md`) 涔嬮棿鐨勭洰鏍囧榻愩€?

## 鎵ц鍘熷垯 (The Principles)
1. **SMART 寮哄埗**: 鎵€鏈夌殑 KR 蹇呴』鍙噺鍖栥€佹湁杈圭晫銆佹湁鏃堕檺銆?
2. **閫夋嫨棰樹紭鍏?(Options First)**: 鍦ㄧ‘璁ゆ垨澶嶇洏鏃讹紝浣跨敤 `AskUserQuestion` 鎻愪緵 ["鎵瑰噯", "淇敼", "椹冲洖"] 鎴?["On Track", "At Risk"] 绛夐€夐」锛屽噺灏戠敤鎴疯緭鍏ャ€?
3. **鑱岃矗瀵归綈**: 鑷姩璇嗗埆 KR 搴旇褰掑睘浜庡摢涓淮搴︼紙璐ㄩ噺/鏋舵瀯/鎵ц閫熷害锛夈€?
4. **鍔ㄦ€佹紨杩?*: KR 鏄湁鐢熷懡鍛ㄦ湡鐨勩€傞€氳繃姝ゅ懡浠ゅ彲浠ユ洿鏂般€佸畬鎴愭垨搴熷純 KR銆?
5. **娌荤悊鍗忚寮哄埗**:
   - `Proposal` 鏄祦绋嬮樁娈碉紝涓嶆槸鏂板瑙掕壊銆?
   - 鎻愭鑰呭彲浠ユ槸涓绘櫤鑳戒綋鎴?OKR owner锛屼絾鎸戞垬鑰呭繀椤绘槸涓嶅悓鏅鸿兘浣撱€?
   - 鏈€缁堟墽琛岃鍒掑繀椤婚€氳繃 `AskUserQuestion` 鑾峰緱 Owner 鎵瑰噯鍚庢墠鑳介攣瀹氭墽琛屻€?

### 鐢熷懡鍛ㄦ湡娌荤悊鏂囦欢锛堝繀椤荤淮鎶わ級
- `docs/okr/WEEK_STATE.json`: 鍛ㄧ姸鎬佹満锛圖RAFT/CHALLENGE/PENDING_OWNER_APPROVAL/LOCKED/EXECUTING/REVIEW/CLOSED/INTERRUPTED锛?
- `docs/okr/WEEK_EVENTS.jsonl`: 鎵ц浜嬩欢娴侊紙task_started/heartbeat/blocker/task_completed锛?
- `docs/okr/WEEK_PLAN_LOCK.json`: Owner 鎵瑰噯鍚庣殑閿佹枃浠?

### 娌荤悊鍛戒护锛堟帹鑽愮敤鑴氭湰锛屽噺灏戞墜鍐欓敊璇級
```bash
python scripts/weekly_governance.py new-week --goal "<week goal>"
python scripts/weekly_governance.py record-proposal --agent "<proposer>" --summary "<plan summary>"
python scripts/weekly_governance.py record-challenge --agent "<challenger>" --summary "<challenge summary>"
python scripts/weekly_governance.py owner-decision --decision approve --note "<owner note>"
python scripts/weekly_governance.py status
```

### 1. 鍑嗗涓庣姸鎬佹鏌?(Preparation & Resume)
- 璇诲彇 `docs/STRATEGY.md`銆?
- **鏋勫缓鍏ㄩ噺鍚嶅唽**:
  - **鏍稿績鍥㈤槦**: `explorer`, `diagnostician`, `auditor`, `planner`, `implementer`, `reviewer`銆?
  - **鎵╁睍鍥㈤槦**: 鎵弿椤圭洰鏍圭洰褰?`.claude/agents/*.md`锛屾彁鍙栧悕绉般€?
- **鏂偣缁紶妫€鏌?*:
  - 妫€鏌ユ槸鍚﹀瓨鍦?`docs/okr/.negotiation_status.json`銆?
  - **鑻ュ瓨鍦?*: 璇诲彇 `pending` 鍒楄〃銆傚憡鐭ョ敤鎴凤細鈥滄娴嬪埌涓婃鏈畬鎴愮殑鍗忓晢锛堝墿浣? ...锛夈€傛鍦ㄦ仮澶嶈繘搴︺€傗€?
  - **鑻ヤ笉瀛樺湪**: 鍒濆鍖栬鏂囦欢锛屽皢鎵€鏈夊悕鍐屽啓鍏?`pending` 鍒楄〃銆?
- **鍛ㄦ不鐞嗙姸鎬佹鏌ワ紙鏂板锛?*:
  - 璇诲彇 `docs/okr/WEEK_STATE.json`锛堝鏋滀笉瀛樺湪锛屼娇鐢?`weekly_governance.py new-week` 鍒濆鍖栵級銆?
  - 鑻?`stage=INTERRUPTED`锛屽厛缁勭粐鎭㈠鏂规骞朵笌鐢ㄦ埛纭锛屽啀缁х画璁″垝缂栨帓銆?

### 2. 鐢ㄦ埛鎵胯 (User Commitment)
- **杞悜鐢ㄦ埛**: 鍦ㄩ潰璇曞瓙鏅鸿兘浣撲箣鍓嶏紝鍏堜笌鐢ㄦ埛瀵归綈銆?
- **鎻愰棶**: 浣跨敤 `AskUserQuestion`銆?
  > "涓轰簡纭繚椤圭洰鎴愬姛锛岄櫎浜?AI 鍥㈤槦鐨勫姫鍔涳紝涔熼渶瑕佹偍鐨勫崗鍚屻€?
  > **鎮ㄥ湪鏈懆鏈熺殑涓汉 OKR 鏄粈涔堬紵**
  > (寤鸿鏂瑰悜锛氳涓虹害鏉熷'涓嶆敼闇€姹?銆佷釜浜鸿础鐚'瀹屾垚璁捐绋?銆佹垨瀛︿範鐩爣)"
- **钀界洏**: 灏嗙敤鎴锋壙璇哄啓鍏?`docs/okr/user.md`銆?

### 3. 鍗忓晢涓庡榻?(Negotiation & Alignment)
- **璋冨害鍘熷垯**: 鈿狅笍 **鍙楁帶骞跺彂 (Throttled Concurrency)**銆傛瘡娆℃渶澶氬苟鍙戝娲?**2-3 涓?* 浠诲姟锛岀瓑寰呯粨鏋滆繑鍥炲悗鍐嶈ˉ鍏呮柊鐨勪换鍔°€?
- **闈㈣瘯寰幆**:
  1. 浠?`pending` 涓彇鍑轰竴鎵?Agent (2-3涓?銆?
  2. 璋冪敤 `agent_send` 鍙戣捣闈㈣瘯锛堟惡甯?`--session-id`锛夈€?
  3. 姣忚幏鍙栦竴涓洖澶嶅悗锛?*绔嬪嵆鏇存柊** `docs/okr/.negotiation_status.json`锛?
     - 灏嗚 Agent 绉诲叆 `completed` 鍒楄〃銆?
- **闈㈣瘯 Prompt**:
  > "浣犲ソ锛?AgentName>銆傚叕鍙哥殑骞村害鎴樼暐鏄?[Strategy Summary]銆傚熀浜庝綘鐨勫疄鍦拌皟鐮斻€佽兘鍔涘拰鎴樼暐锛屾彁鍑?1-3 涓叧閿粨鏋?(KR)銆?

### 3.5 鍙嶅悜鎸戞垬涓庢瘮杈?
- 浠庡€欓€夋柟妗堜腑閫夋嫨涓€涓彁妗堣€呰緭鍑?Proposal銆?
- 鎸囨淳涓嶅悓鏅鸿兘浣撹緭鍑?Challenge锛堣嚦灏?3 鏉℃壒璇?+ 1 涓浛浠ｆ柟妗堬級銆?
- 灏?Proposal 涓?Challenge 鍚堝苟涓?Final Plan 鑽夋銆?

### 3. 纭涓庡叕绀?(Confirmation)
- 姹囨€绘墍鏈夋彁妗堛€?
- 浣跨敤 `AskUserQuestion` 灞曠ず缁欑敤鎴风‘璁ゃ€?

### 4. 钀界洏 (Commitment)
- 浠呭湪 `WEEK_PLAN_LOCK.json` 瀛樺湪鏃惰繘鍏ユ湰姝ラ銆?
- 灏嗘瘡涓?Agent 鐨?KR 鍐欏叆涓撳睘鏂囦欢 `docs/okr/<agent_name>.md`銆?
- **姹囨€婚噸鐐?*: 鏇存柊 `docs/okr/CURRENT_FOCUS.md`銆?

### 5. 杩涘害澶嶇洏 (Check-in) - *Optional*
- 濡傛灉鐢ㄦ埛鐩殑鏄鐩橈紝鍒欒鍙栦笂杩版枃浠讹紝璇㈤棶鐢ㄦ埛褰撳墠杩涘害銆?

## 缁撻」
杈撳嚭锛氣€溾渽 OKR 鍗忓晢宸插畬鎴愩€傚叏鍛樼洰鏍囧凡瀵归綈銆傗€?
