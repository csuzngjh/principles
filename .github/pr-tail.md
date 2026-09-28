### 鏄惁瑙﹀強浜у搧杈圭晫

* [ ] 鍚?* [ ] 鏄紝闇€瑕?Owner/maintainer 鏄庣‘鎵瑰噯

璇存槑锛?
---

### MVP Questions

#### `mvp-q-1-what-if-skip`

濡傛灉涓嶅仛锛屼細鍙戠敓浠€涔堬紵涓轰粈涔堣繖鏄綋鍓嶅€煎緱澶勭悊鐨勯棶棰橈紵

---

#### `mvp-q-2-how-observed`

Owner / operator 濡備綍瑙傚療瀹冪‘瀹炵敓鏁堬紵

---

#### `mvp-q-3-how-disabled`

鏈 rollback / disable / recovery strategy 鏄粈涔堬紵

* [ ] existing flag/config
* [ ] existing deactivation/state transition
* [ ] backward-compatible revert
* [ ] new feature flag
* [ ] N/A 鈥?no meaningful runtime rollback requirement

璇存槑锛?
---

> 鏂?feature flag 涓嶆槸榛樿绛旀銆傚彧鏈夌嫭绔?runtime disable 鑳芥彁渚涚湡瀹為闄╂帶鍒舵椂鎵嶆柊澧炪€?
#### `mvp-q-4-emotional-value`

* [ ] Owner-facing change
* [ ] N/A 鈥?internal engineering change

濡?Owner-facing锛?
闄嶄綆锛?
* [ ] 澶辨帶鎰?* [ ] 鐤叉儷鎰?* [ ] 閲嶅绾犳鎰?* [ ] 淇℃伅杩囪浇
* [ ] 鍏朵粬: ___

鍒涢€狅細

* [ ] 瀹夊績鎰?* [ ] 鎺屾帶鎰?* [ ] 娌夋穩鎰?* [ ] 娓呴啋鎰?* [ ] 鍏朵粬: ___

璇存槑锛?
---

---

## 鍙樻洿姒傝锛坅gent 濉級

### 鍙樻洿绫诲瀷

* [ ] 馃悰 Bug 淇
* [ ] 鉁?鏂板姛鑳?* [ ] 馃摑 鏂囨。
* [ ] 馃敡 閲嶆瀯 / architecture health
* [ ] 馃И 娴嬭瘯
* [ ] 馃敀 Security / safety
* [ ] 馃摝 Build / dependency / release

### 楂樺眰鍙樻洿

1. ---
2. ---
3. ---

### 褰卞搷鑼冨洿

* [ ] principles-core
* [ ] host-runtime
* [ ] openclaw-plugin
* [ ] codex-adapter
* [ ] pd-cli
* [ ] pd-console
* [ ] pd-companion
* [ ] installer / install-layout
* [ ] website
* [ ] docs
* [ ] scripts / CI / tooling
* [ ] other: ___

---

## Verification Evidence锛坅gent 濉級

### Targeted verification

| Command / scenario | Result | Why it matters |
| ------------------ | ----------- | -------------- |
| ___ | PASS / FAIL | ___ |
| ___ | PASS / FAIL | ___ |

### Production-path evidence

鏈鏄惁楠岃瘉浜嗙湡瀹?consumer / wiring锛?
* [ ] 鏄?* [ ] 涓嶉€傜敤

璇存槑锛?
---

### Merge gate

* [ ] `npm run verify:merge` PASS
* [ ] 鏈€氳繃锛屼絾纭鏄?pre-existing/environmental failure锛屽苟闄勮瘉鎹?
璇佹嵁锛?
---

---

## Error Experience / Task Risk Contract锛?..N锛?
<!--
Two-pass workflow (AGENTS.md 搂14):
1. BEFORE implementation 鈥?read ERROR_PATTERN_INDEX.md, run
   `npm run error:context -- --paths <expected-files> --signals <concepts>`,
   convert each hit's Required Evidence into the verification plan.
2. BEFORE handoff 鈥?rerun `npm run error:context` (diff mode) against the
   actual diff, reconcile newly triggered patterns, then fill this contract.
Zero patterns is valid. Do not manufacture entries to satisfy process.
-->

* Router command: `npm run error:context -- ___`
* Router result: `___锛坋.g. "EP-02 HIGH, EP-09 HIGH" / "no automatic match"锛塦
* Manual additions锛坮outer 鏈懡涓絾浜哄伐鍒ゆ柇鐩稿叧锛? `___`
* Manual exclusions锛坮outer 鍛戒腑浣嗘帓闄わ紝HIGH 蹇呴』缁欑悊鐢憋級: `___`

姣忎釜鐩稿叧 Pattern 涓€琛岋紙EP-XX 鎴?ERR-XXX锛夛細

* Pattern: `___` 鈥?Why relevant: `___`
  * Required evidence: `___`
  * Evidence produced: `___`
  * Result: PASS / FAIL / N/A-with-reason: `___`

绂佹鍙啓 `No materially relevant existing ERR pattern identified.`
鑰屼笉闄?`error:context` result + manual review statement鈥斺€?no-match 鏃跺繀椤荤矘璐?router 杈撳嚭骞惰鏄庝汉宸ラ槄璇?Pattern Index 鍚庣殑缁撹銆?
### New reusable error lesson discovered?

* [ ] 鍚?* [ ] 鏄紝宸叉寜 Error Experience policy 璁板綍/鏇存柊锛堢粡 `npm run error:record create-pattern | add-occurrence` 鍐欏叆 structured records锛宺ecurrence 椤诲甫 --invariant/--severity/--escaped/--caughtBy/--guard 缁撴瀯鍖栧瓧娈碉紝瑙?record-error skill锛?
璇存槑锛?
---

