# Principles Disciple — CNB 云原生开发环境（Cloud Agent Worker 基础环境）
#
# 定位：**开发/分析环境**，不是 PD 产品运行时的一部分。
#   本文件只在 cnb.cool 侧被读取（云原生开发 / NPC 流水线）。
#   它不参与 GitHub Actions、不影响本地开发、不改动任何 packages/**。
#
# 设计依据：
#   docs/audit/cnb-environment-compatibility-report.md  §2 必需依赖
#   docs/audit/cnb-capability-validation-report.md      §2 Dockerfile 自定义开发环境
#
# 选型说明（依 AGENTS.md P1「证据优先」，全部对齐仓库真实状态）：
#   - node:22  ← packages/create-principles-disciple/package.json:68-70 `"node": ">=22.0.0"`
#                且 .github/workflows/ci.yml 全部 21 处均用 node 22
#   - python3 / make / g++  ← better-sqlite3@^13.0.3 需 node-gyp 编译
#                （ci.yml:170 `npm rebuild better-sqlite3`）
#   - git-lfs   ← .gitattributes:46-50，*.mp4/*.webm/*.webp 走 LFS
#   - ripgrep / jq ← PD 工具链约定
#   - openssh-server ← VS Code / Cursor 经 Remote-SSH 接入（CNB 官方要求）

FROM node:22-bookworm-slim

# 非交互 apt
ENV DEBIAN_FRONTEND=noninteractive

# 字符集（支持中文输入/输出）；跟随 CNB 官方示例
ENV LANG=C.UTF-8
ENV LANGUAGE=C.UTF-8

# ---------------------------------------------------------------------------
# 1) 系统工具链
#    PD 必需：python3 + make + g++（原生模块）、git + git-lfs（LFS 资产）、
#             ripgrep（代码检索）、jq（脚本 JSON 处理）
#    CNB 必需：openssh-server（Remote-SSH）、curl/wget/xz-utils（装 code-server）
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      wget \
      git \
      git-lfs \
      openssh-server \
      less \
      jq \
      unzip \
      xz-utils \
      ripgrep \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install --system

# ---------------------------------------------------------------------------
# 2) code-server（Web IDE）
#    镜像内含 code-server ⇒ CNB 以「单容器模式」启动开发环境；
#    未安装则退化为「双容器模式」（IDE 在 sidecar）。显式安装以固定行为。
# ---------------------------------------------------------------------------
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Remote-SSH 需要 sshd 运行目录
RUN mkdir -p /var/run/sshd

# ---------------------------------------------------------------------------
# 3) pnpm（任务书工具清单要求）
#
#    ⚠️ 重要事实：PD 仓库是 **npm workspaces**（根 package.json:7-9 + package-lock.json），
#       不存在 pnpm-lock.yaml。/pnpm-workspace.yaml。**npm 才是 PD 的权威链路。**
#
#    因此本步骤为「按任务书要求预置工具」，而非 PD 依赖。
#    且以显式告警的方式容错：corepack/registry 不可达时**不阻断环境构建**
#    （环境可用性是主要用途，pnpm 缺失不影响 PD 的安装/测试链路）。
# ---------------------------------------------------------------------------
RUN if corepack enable && corepack prepare pnpm@latest --activate; then \
      echo "[PD] pnpm 已通过 corepack 预置：$(pnpm --version)"; \
    else \
      echo "[PD] WARNING: pnpm 预置失败（corepack 或 registry 不可达）。" >&2; \
      echo "[PD]           PD 的权威包管理器是 npm workspaces，本环境主要用途不受影响。" >&2; \
    fi

WORKDIR /workspace

# ---------------------------------------------------------------------------
# 4) 构建期自检 —— fail loud（任一必需工具缺失则镜像构建失败）
#    对应 Phase 3/5 的版本验证要求；不把问题留到运行时才发现。
# ---------------------------------------------------------------------------
RUN set -eux; \
    node --version; \
    npm --version; \
    git --version; \
    git lfs version; \
    rg --version; \
    python3 --version; \
    printf '#include <cstdio>\nint main(){puts("ok");}\n' > /tmp/cc.c; \
    g++ /tmp/cc.c -o /tmp/cc && /tmp/cc; \
    rm -f /tmp/cc.c /tmp/cc; \
    echo "[PD] 环境自检通过。"

# 说明：不在此处执行 `npm ci`。
#   1) 首次安装约 25 分钟，不应阻塞每次环境/流水线启动；
#   2) 依赖应由使用者在 workspace 内按需安装，或由流水线的显式 stage 安装。
#   详见 docs/audit/cnb-cloud-agent-architecture.md §4.2
