# Nocturnal Trainer

外部训练后端 - 负责执行真实的 ORPO (Odds Ratio Preference Optimization) 训练。

## 目录结构

```
trainer/
├── backend_base.py           # 基类和通用类型定义
├── peft_trl_orpo_backend.py  # ✅ 主训练后端 (真实 ORPO)
├── unsloth_orpo_backend.py   # ⚠️ 次级加速后端 (placeholder)
├── dry_run_backend.py         # 验证模式 (不执行真实训练)
├── main.py                    # CLI 入口
├── setup_environment.py       # 环境检查与安装脚本
├── validate_setup.py          # 快速验证脚本
├── test_backends.py           # 后端合约测试
└── README.md                  # 本文件
```

## 快速开始

### 1. 检查环境

```bash
cd scripts/nocturnal/trainer

# 检查当前环境状态 (不安装任何东西)
python setup_environment.py --check

# 完整检查 + 安装缺失依赖
python setup_environment.py
```

### 2. 验证安装

```bash
# 快速验证 (无需 GPU)
python validate_setup.py

# 完整验证 (测试 PEFT-TRL 验证逻辑)
python validate_setup.py --quick
```

### 3. 运行训练

#### Dry-Run 模式 (验证配置)

```bash
# 创建测试 spec
python -c "
import json, tempfile, os
spec = {
    'experimentId': 'test-001',
    'backend': 'dry-run',
    'trainingMode': 'orpo',
    'targetWorkerProfile': 'local-reader',
    'targetModelFamily': 'Qwen/Qwen2-0.5B-Instruct',
    'hardwareTier': 'cpu-experimental',
    'datasetExportId': 'exp-123',
    'datasetExportPath': os.path.join(tempfile.gettempdir(), 'test.jsonl'),
    'datasetFingerprint': 'fp-abc',
    'benchmarkExportId': 'bench-456',
    'outputDir': tempfile.gettempdir(),
    'configFingerprint': 'fp-config',
    'codeHash': 'fp-code',
    'hyperparameters': {
        'learningRate': 3e-4, 'batchSize': 2, 'gradientAccumulation': 8,
        'loraRank': 16, 'loraAlpha': 32, 'loraDropout': 0.05,
        'warmupRatio': 0.1, 'maxSteps': 10, 'maxSeqLength': 1024
    },
    'budget': {'maxWallClockMinutes': 5},
    'expectedArtifact': {'checkpointName': 'test', 'adapterFormat': 'peft-adapter'}
}
print(json.dumps(spec, indent=2))
" > test_spec.json

# 运行 dry-run
python main.py --spec test_spec.json --output-dir ./output
```

#### 真实训练 (需要 GPU)

```bash
# 1. 准备好 ORPO 数据集导出文件
#    (通过插件的 nocturnal-export 功能生成)
#    格式: JSONL，每行包含 prompt, chosen, rejected 字段

# 2. 创建 experiment spec
python -c "
import json
spec = {
    'experimentId': 'exp-001',
    'backend': 'peft-trl-orpo',
    'trainingMode': 'orpo',
    'targetWorkerProfile': 'local-reader',
    'targetModelFamily': 'Qwen/Qwen2-0.5B-Instruct',
    'hardwareTier': 'consumer-gpu',
    'datasetExportId': 'export-123',
    'datasetExportPath': 'D:/path/to/your/export.jsonl',
    'datasetFingerprint': 'fp-abc123',
    'benchmarkExportId': 'bench-456',
    'outputDir': 'D:/checkpoints',
    'configFingerprint': 'fp-config',
    'codeHash': 'fp-code',
    'hyperparameters': {
        'learningRate': 3e-4, 'batchSize': 2, 'gradientAccumulation': 8,
        'loraRank': 16, 'loraAlpha': 32, 'loraDropout': 0.05,
        'warmupRatio': 0.1, 'maxSteps': 100, 'maxSeqLength': 2048
    },
    'budget': {'maxWallClockMinutes': 60},
    'expectedArtifact': {'checkpointName': 'reader-checkpoint', 'adapterFormat': 'peft-adapter'}
}
print(json.dumps(spec, indent=2))
" > my_experiment.json

# 3. 运行训练
python main.py --spec my_experiment.json --output-dir ./checkpoints
```

#### CPU 训练 (实验性)

CPU 训练**极慢**，但可以在没有 GPU 的环境中运行。适合：
- 测试训练流程
- 小规模数据集验证
- 学习和调试

```bash
# 创建 CPU 训练 spec
python -c "
import json, tempfile
spec = {
    'experimentId': 'cpu-test-001',
    'backend': 'peft-trl-orpo',
    'trainingMode': 'orpo',
    'targetWorkerProfile': 'local-reader',
    # 必须使用小模型！推荐 0.5B 或 1.5B
    'targetModelFamily': 'Qwen/Qwen2-0.5B-Instruct',
    'hardwareTier': 'cpu-experimental',
    'datasetExportId': 'export-123',
    'datasetExportPath': '/path/to/your/export.jsonl',
    'datasetFingerprint': 'fp-abc',
    'benchmarkExportId': 'bench-456',
    'outputDir': tempfile.gettempdir(),
    'configFingerprint': 'fp-config',
    'codeHash': 'fp-code',
    'hyperparameters': {
        'learningRate': 3e-4,
        'batchSize': 1,           # CPU 必须用 1
        'gradientAccumulation': 4, # 用梯度累积补偿小 batch
        'loraRank': 8,            # 减小 LoRA rank 节省内存
        'loraAlpha': 16,
        'loraDropout': 0.05,
        'warmupRatio': 0.1,
        'maxSteps': 50,           # 减少步数
        'maxSeqLength': 512       # 减短序列长度
    },
    'budget': {'maxWallClockMinutes': 120},
    'expectedArtifact': {'checkpointName': 'cpu-checkpoint', 'adapterFormat': 'peft-adapter'}
}
print(json.dumps(spec, indent=2))
" > cpu_experiment.json

# 运行 CPU 训练
python main.py --spec cpu_experiment.json --output-dir ./checkpoints
```

**CPU 训练优化建议：**

| 参数 | GPU 推荐 | CPU 推荐 | 原因 |
|------|----------|----------|------|
| 模型大小 | 7B-14B | **0.5B-1.5B** | 大模型内存不足 |
| batchSize | 2-4 | **1** | CPU 内存有限 |
| gradientAccumulation | 8 | **4-16** | 补偿小 batch |
| loraRank | 16-32 | **4-8** | 减少参数 |
| maxSeqLength | 2048 | **512-1024** | 减少内存 |
| maxSteps | 1000+ | **50-200** | 时间限制 |

**预计时间对比：**
- GPU (RTX 4090): 100 steps ≈ 5 分钟
- CPU (8核): 100 steps ≈ 2-4 小时

## 环境要求

### 最低要求

| 组件 | Dry-Run | CPU 训练 | GPU 训练 |
|------|---------|----------|----------|
| Python | 3.8+ | 3.8+ | 3.8+ |
| 内存 | 4 GB | **16 GB** | 8 GB |
| 显存 | - | - | 8 GB (如 RTX 3070) |
| 存储 | 1 GB | 5 GB | 10 GB |

### 推荐配置 (GPU 训练)

| 组件 | 推荐 |
|------|------|
| GPU | NVIDIA RTX 4090 (24GB) 或 RTX 3090 (24GB) |
| 内存 | 32 GB |
| 显存 | 24 GB |
| 存储 | 50 GB (用于模型缓存) |

### 已测试的 GPU

- ✅ RTX 4090 24GB (consumer-gpu)
- ✅ RTX 3090 24GB (consumer-gpu)
- ✅ RTX 4070 Ti 16GB (small-gpu)
- ⚠️ RTX 3060 12GB (small-gpu, 可能需要减小 batch size)

## 依赖安装

### 自动安装 (推荐)

```bash
python setup_environment.py
```

脚本会自动:
1. 检测 GPU 可用性
2. 选择合适的 PyTorch 版本 (CPU/GPU)
3. 安装所有核心依赖
4. 验证安装

### 手动安装

#### CPU 版本 (慢速, 仅测试用)

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install transformers peft trl datasets accelerate
```

#### GPU 版本 (推荐)

```bash
pip install torch torchvision torchaudio
pip install transformers peft trl datasets accelerate bitsandbytes
```

#### 可选: Unsloth 加速

如果你已经按照 [Unsloth 安装指南](https://unsloth.ai/docs/new/studio) 安装了 Unsloth:

```powershell
irm https://unsloth.ai/install.ps1 | iex
```

注意: 当前 `unsloth-orpo` 后端尚未实现，训练仍然使用 `peft-trl-orpo`。

## 后端说明

### peft-trl-orpo (主后端) ✅

使用 PEFT + TRL 实现真实的 ORPO 训练:

- **模型**: AutoModelForCausalLM + PEFT LoRA
- **量化**: 4-bit QLoRA (可选，节省显存)
- **优化器**: Paged AdamW 8-bit (内存高效)
- **训练**: TRL ORPOTrainer

特点:
- 支持 consumer-gpu (24GB) 和 small-gpu (8-16GB)
- 懒加载依赖，不影响测试
- 完整的 checkpoint 保存

### unsloth-orpo (次级后端) ⚠️

Unsloth 加速版本。当前为 placeholder，未来计划支持。

优势:
- 比 peft-trl-orpo 快约 2x
- 更低的显存占用

### dry-run (验证后端)

不执行真实训练，用于:
- 验证 experiment spec 格式
- 测试训练管道配置
- 检查数据集路径

## 数据集格式

ORPO 训练需要 JSONL 格式的数据集，每行包含:

```json
{
  "prompt": "用户的输入或问题",
  "chosen": "好的回复 (模型应该学习的)",
  "rejected": "不好的回复 (模型应该避免的)"
}
```

### 示例

```jsonl
{"prompt": "如何写一个排序算法?", "chosen": "可以使用快速排序，它的时间复杂度是 O(n log n)...", "rejected": "直接用 for 循环遍历所有元素比较大小即可..."}
{"prompt": "Python 怎么定义一个函数?", "chosen": "使用 def 关键字: def func_name(params): ...", "rejected": "函数没法定义，只能用现成的..."}
```

### 提示

- `prompt` 是共同的输入 (问题/指令)
- `chosen` 和 `rejected` 是同一个 prompt 的两个不同回复
- `chosen` 应该是更好的回答

## 常见问题

### Q: 报 `ModuleNotFoundError: No module named 'torch'`

你需要安装 PyTorch。运行:

```bash
python setup_environment.py
```

或手动安装 GPU 版本:

```bash
pip install torch torchvision torchaudio
```

### Q: 报 `CUDA out of memory`

显存不足。尝试:

1. 减小 `batchSize`: 2 → 1
2. 减小 `maxSeqLength`: 2048 → 1024
3. 确保使用 `hardwareTier: "small-gpu"` (适合 8-16GB 显存)

### Q: 报 `bitsandbytes` 错误

4-bit 量化有问题。尝试安装:

```bash
pip install bitsandbytes
```

如果仍然失败，可以在 `peft_trl_orpo_backend.py` 中禁用量化 (设置 `load_in_4bit=False`)。

### Q: 训练很慢

正常。ORPO 训练本身就慢。可以尝试:

1. 使用 Unsloth (未来支持)
2. 减小 `maxSteps`
3. 使用更小的模型

### Q: 如何确认训练成功了?

训练完成后，检查输出目录:

```
checkpoints/
└── checkpoint-<id>/
    ├── adapter/
    │   ├── adapter_config.json  # PEFT 配置
    │   └── model.safetensors     # 适配器权重
    └── metadata.json             # 训练元数据
```

### Q: 模型保存在哪里?

默认保存在你指定的 `--output-dir` 下:

```
<output-dir>/
└── checkpoint-<checkpoint-id>/
    └── adapter/                 # PEFT 适配器
        ├── adapter_config.json
        └── model.safetensors
```

## 架构说明

```
Plugin (TypeScript)
    │
    ├── 创建 TrainingExperimentSpec (JSON)
    │
    ▼
main.py (CLI)
    │
    ├── 加载 spec
    │
    ├── 选择后端 (peft-trl-orpo / unsloth-orpo / dry-run)
    │
    ▼
TrainerBackend.execute_training()
    │
    ├── 加载数据集 (JSONL)
    │
    ├── 加载模型 + PEFT LoRA
    │
    ├── 配置 ORPOTrainer
    │
    ├── 执行训练 (trainer.train())
    │
    ├── 保存 checkpoint
    │
    ▼
TrainingExperimentResult (JSON)
    │
    ├── checkpointId
    ├── metrics
    └── artifact path
```

## 参考资料

- [TRL ORPO Trainer 文档](https://huggingface.co/docs/trl/en/orpo_trainer)
- [PEFT 文档](https://huggingface.co/docs/peft)
- [ORPO 论文](https://arxiv.org/abs/2403.07691)
- [Unsloth](https://unsloth.ai)

## 获取帮助

```bash
# 检查环境
python setup_environment.py --check

# 验证安装
python validate_setup.py

# 查看 main.py 帮助
python main.py --help
```
