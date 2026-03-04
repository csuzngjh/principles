---
name: bootstrap-tools
description: Scans project tech stack and searches the web for the latest, most effective CLI tools to augment agent capabilities. Suggests and installs tools upon user approval.
disable-model-invocation: true
---

# /bootstrap-tools: 瑁呭鍗囩骇瀹?

浣犵殑鐩爣鏄鏅鸿兘浣撳洟闃熸嫢鏈夋渶鍏堣繘鐨勬鍣ㄣ€傞€氳繃鍒嗘瀽褰撳墠椤圭洰鏍堬紝骞?*瀹炴椂鑱旂綉鎼滅储**锛屽鎵捐兘鎻愬崌寮€鍙戙€侀噸鏋勩€佹祴璇曟晥鐜囩殑鏈€浣?CLI 宸ュ叿銆?

## 鎵ц娴佺▼

### 1. 渚﹀療 (Recon)
- **鍒嗘瀽鎶€鏈爤**: 璇诲彇 `package.json`, `Cargo.toml`, `requirements.txt` 绛夈€傜‘瀹氭牳蹇冩鏋讹紙濡?Next.js, FastAPI锛夈€?
- **鐩樼偣鐜扮姸**: 杩愯 `npm list -g --depth=0` 鍜?`command -v` 妫€鏌ュ凡瀹夎鐨勫伐鍏枫€?

### 2. 瀵诲疂 (Hunt)
- **鑱旂綉鎼滅储**: 閽堝褰撳墠鏍堬紝鎼滅储鏈€鏂扮殑 CLI 绁炲櫒銆?
  - *Query 绀轰緥*: "best CLI tools for Next.js 15 development 2025", "fastest rust-based grep alternative", "modern linter for python".
- **绛涢€夋爣鍑?*:
  - **Headless**: 蹇呴』鏄?CLI 宸ュ叿銆?
  - **Performance**: 浼樺厛鎺ㄨ崘 Rust/Go 缂栧啓鐨勯珮鎬ц兘宸ュ叿 (e.g., `ripgrep`, `ast-grep`, `oxc`).
  - **Relevance**: 鑳借В鍐冲疄闄呯棝鐐癸紙濡?`knip` 鏌ユ浠ｇ爜锛宍depcheck` 鏌ヤ緷璧栵級銆?

### 3. 鎻愭 (Pitch)
- 浣跨敤 `AskUserQuestion` 鍚戠敤鎴峰睍绀烘帹鑽愭竻鍗曘€?
- **鏍煎紡**:
  - **宸ュ叿鍚?*: [Name]
  - **鎺ㄨ崘鐞嗙敱**: [Why it helps the agent/project]
  - **瀹夎鍛戒护**: `npm i -g ...` 鎴?`apt-get ...`
  - **Demo**: 缁欏嚭涓€涓畝鍗曠殑鐢ㄦ硶绀轰緥銆?

### 4. 閮ㄧ讲涓庣櫥璁?(Deploy & Register)
- 鑾峰緱鎵瑰噯鍚庯紝鎵ц瀹夎鍛戒护銆?
    - **楠岃瘉 (Verification - 寮哄埗)**:
      - 瀹夎瀹屾垚鍚庯紝**蹇呴』**杩愯 `<tool> --version` 鎴?`command -v <tool>` 鏉ラ獙璇佹槸鍚︾湡鐨勫畨瑁呮垚鍔熴€?
      - **鑻ュけ璐?*: 鍛婄煡鐢ㄦ埛锛堝彲鑳芥槸鏉冮檺闂锛夛紝璇锋眰鐢ㄦ埛鎵嬪姩瀹夎锛?*涓嶈**鏇存柊鑳藉姏鏂囦欢銆?
      - **鑻ユ垚鍔?*: 
        - 鏇存柊 `docs/SYSTEM_CAPABILITIES.json`銆傝褰曟柊宸ュ叿鐨勮矾寰勩€?
        - **鍏ㄥ憳骞挎挱**: 
          - 鎵弿 `.claude/agents/*.md`銆?
          - 妫€鏌ユ瘡涓枃浠舵槸鍚﹀寘鍚?`@docs/SYSTEM_CAPABILITIES.json`銆?
          - 鑻ユ湭鍖呭惈锛屽湪鏂囦欢鏈熬杩藉姞锛?
            ```markdown
            
            ## Environment Capabilities
            Check @docs/SYSTEM_CAPABILITIES.json for high-performance tools (e.g., ripgrep, ast-grep) available in this environment. Use them!
            ```
          - 鎻愮ず鐢ㄦ埛杩愯 `/manage-okr` 鎴?`/admin diagnose` 浠ヨ Agent 鎰熺煡鏂拌兘鍔涖€?
## 鏍稿績鍘熷垯
- **鍠滄柊鍘屾棫**: 鏁簬鎺ㄨ崘鏂板伐鍏锋浛浠ｆ棫宸ュ叿锛堝鎺ㄨ崘 `pnpm` 鏇?`npm`锛屾帹鑽?`vitest` 鏇?`jest`锛夛紝浣嗚璇存槑鐞嗙敱銆?
- **瀹夊叏绗竴**: 鍦ㄥ畨瑁呭墠蹇呴』鑾峰緱鐢ㄦ埛鏄庣‘鎺堟潈銆?
