---
name: watch-evolution
description: Start the background evolution daemon to process queued tasks from EVOLUTION_QUEUE.json.
---

# /watch-evolution: 鍚庡彴杩涘寲瀹堟姢鑰?

**鐩爣**: 鍚姩涓€涓寔缁繍琛岀殑杩涚▼锛岃嚜鍔ㄥ垎鏋愬苟淇绉帇鐨勪唬鐮侀棶棰樸€?

## 1. 杩愯鐜鍑嗗
- 纭繚宸查厤缃?`docs/PROFILE.json` 涓殑 `evolution_mode: "async"`銆?
- 纭繚 `docs/EVOLUTION_QUEUE.json` 瀛樺湪銆?

## 2. 鍚姩鎸囦护
璇疯繍琛屼互涓嬪懡浠ゅ惎鍔ㄥ畧鎶よ繘绋嬶細

```bash
python scripts/evolution_daemon.py
```

## 3. 宸ヤ綔娴佺▼
1. **鑷姩鎵弿**: 姣忛殧 30 绉掓壂鎻忎竴娆?`docs/EVOLUTION_QUEUE.json`銆?
2. **璋冨害绛栫暐**:
   - 鎸?`priority` 浠庨珮鍒颁綆澶勭悊浠诲姟锛堥珮浼樺厛绾у厛鎵ц锛夈€?
   - `status: retrying` 鐨勪换鍔′粎鍦?`next_retry_at` 鍒版湡鍚庢墠浼氬啀娆℃墽琛屻€?
   - 澶辫触浠诲姟杩涘叆鎸囨暟閫€閬块噸璇曪紝瓒呰繃鏈€澶у皾璇曟鏁板悗鏍囪涓?`failed`銆?
3. **璇婃柇 (Diagnosis)**: 鍔犺浇 `root-cause` 鎶€鑳斤紝閫氳繃 Headless 妯″紡瀹氫綅閿欒鏍瑰洜銆?
4. **淇 (Fix)**: 鍔犺浇淇鎶€鑳斤紝鑷姩淇敼浠ｇ爜骞惰繍琛屾祴璇曘€?
5. **钀界洏 (Log)**: 璋冪敤 `reflection-log` 灏嗙粡楠屽瓨鍏?`PRINCIPLES.md` 鍜?`ISSUE_LOG.md`銆?
6. **鐪嬫澘**: 瀹炴椂鏇存柊 `docs/EVOLUTION_PRD.md` 灞曠ず杩涘害銆?

## 4. 閫€鍑?
- 鎸?`Ctrl+C` 鍋滄鍚庡彴浠诲姟銆備换鍔＄殑鐘舵€佸皢琚繚鐣欏湪 JSON 涓紝涓嬫鍚姩鍙户缁墽琛屻€?
