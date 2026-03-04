---
name: feedback
description: Standardized bug reporting and feedback mechanism. Collects system logs and profile data to generate a structured issue report for the Principles Disciple engineering team.
disable-model-invocation: true
---

# /feedback: 鎻愪氦绯荤粺鍙嶉

浣犻亣鍒颁簡绯荤粺 Bug 鎴栬璁＄己闄凤紵璇蜂娇鐢ㄦ鎶€鑳界敓鎴愪竴浠芥爣鍑嗗寲鐨勫弽棣堟姤鍛婏紝骞惰嚜鍔ㄦ姇閫掔粰涓婃父寮€鍙戝洟闃熴€?

## 鎵ц娴佺▼

### 1. 鏀堕泦璇佹嵁 (Evidence Collection)
- **Log Analysis**: 璇诲彇 `docs/ISSUE_LOG.md` (鏈€杩?20 琛? 鍜?`docs/SYSTEM.log` (濡傛灉鏈夋姤閿欏爢鏍?銆?
- **Config Check**: 璇诲彇 `docs/PROFILE.json` 纭褰撳墠閰嶇疆銆?
- **Version Check**: 灏濊瘯鑾峰彇褰撳墠鐗堟湰淇℃伅锛堝鏈夛級銆?

### 2. 鐢熸垚鎶ュ憡 (Report Generation)
鍦?`temp/` 鐩綍涓嬬敓鎴?`feedback-YYYYMMDD-HHMMSS.md`銆?
**鍐呭妯℃澘**:
```markdown
# Bug Report / Feature Request

**Severity**: HIGH | MEDIUM | LOW
**Component**: Agent | Hook | Skill | Installer
**Context**: [绠€杩颁綘鍦ㄥ仛浠€涔堟椂閬囧埌鐨勯棶棰榏

## Evidence
### Log Snippet
```
[绮樿创鏃ュ織]
```

### Diagnosis (Self-Correction)
鎴戝垎鏋愯繖涓棶棰樺彲鑳芥槸鐢变簬 [鍘熷洜] 瀵艰嚧鐨勩€?
寤鸿淇敼 [鏂囦欢] 鐨?[閫昏緫]銆?

## Environment
- OS: [OS]
- Project: [Project Name]
```

### 3. 鑷姩鎶曢€?(Auto-Delivery)
- **妫€鏌ヤ笂娓?*: 妫€鏌?`scripts/update_agent_framework.sh` 涓畾涔夌殑 `SOURCE_REPO` 璺緞銆?
- **鎶曢€?*:
  - 濡傛灉涓婃父鐩綍瀛樺湪涓斿彲鍐欙紝灏嗘姤鍛?*澶嶅埗**鍒?`$SOURCE_REPO/docs/feedback/`銆?
  - 杈撳嚭: "鉁?鎶ュ憡宸茬洿杈炬灦鏋勫笀妗岄潰 (docs/feedback/)"銆?
- **Fallback**: 濡傛灉涓嶅彲杈撅紝杈撳嚭鏂囦欢璺緞锛岃鐢ㄦ埛鎵嬪姩鍙戦€併€?

## 浜や簰
- 浣跨敤 `AskUserQuestion` 璇㈤棶鐢ㄦ埛闂鐨勪弗閲嶇▼搴﹀拰绠€瑕佹弿杩般€?

```
