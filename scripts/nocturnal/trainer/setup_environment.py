#!/usr/bin/env python3
"""
Nocturnal Trainer 环境检查与安装脚本
====================================

自动检测环境并安装所需依赖。

用法:
    python setup_environment.py           # 自动检测并安装
    python setup_environment.py --gpu     # 强制 GPU 模式
    python setup_environment.py --cpu     # 强制 CPU 模式
    python setup_environment.py --check   # 仅检查当前环境
"""

import sys
import os
import subprocess
import argparse
from pathlib import Path


def get_args():
    parser = argparse.ArgumentParser(description="Nocturnal Trainer 环境检查与安装")
    parser.add_argument("--gpu", action="store_true", help="强制使用 GPU")
    parser.add_argument("--cpu", action="store_true", help="强制使用 CPU (慢速)")
    parser.add_argument("--check", action="store_true", help="仅检查当前环境")
    return parser.parse_args()


def run_command(cmd: str, description: str) -> tuple[bool, str]:
    """运行命令并返回 (成功与否, 输出)"""
    print(f"\n{'=' * 60}")
    print(f"[INSTALL] {description}")
    print(f"{'=' * 60}")
    print(f"Running: {cmd}\n")
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=600,  # 10 分钟超时
        )
        output = result.stdout + result.stderr
        success = result.returncode == 0
        if success:
            print(f"[OK] 成功")
        else:
            print(f"[FAIL] 失败 (返回码: {result.returncode})")
        if output.strip():
            print(output[:2000])  # 限制输出长度
        return success, output
    except subprocess.TimeoutExpired:
        print(f"[FAIL] 超时 (10分钟)")
        return False, "Timeout"
    except Exception as e:
        print(f"[FAIL] 错误: {e}")
        return False, str(e)


def check_python() -> tuple[bool, str]:
    """检查 Python 版本"""
    version = sys.version_info
    version_str = f"{version.major}.{version.minor}.{version.micro}"
    if version.major < 3 or (version.major == 3 and version.minor < 8):
        return False, f"Python {version_str} 不支持 (需要 3.8+)"
    return True, f"Python {version_str}"


def check_gpu() -> tuple[bool, str]:
    """检查 GPU 可用性"""
    try:
        import torch

        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
            return True, f"[OK] GPU: {gpu_name} ({gpu_memory:.1f} GB)"
        else:
            return False, "[WARN] 未检测到 CUDA GPU"
    except ImportError:
        return False, "[WARN] PyTorch 未安装 (无法检测 GPU)"


def check_dependencies() -> dict[str, bool]:
    """检查各个依赖是否已安装"""
    deps = {}

    deps["torch"] = check_package("torch")
    deps["transformers"] = check_package("transformers")
    deps["peft"] = check_package("peft")
    deps["trl"] = check_package("trl")
    deps["datasets"] = check_package("datasets")
    deps["bitsandbytes"] = check_package("bitsandbytes")
    deps["unsloth"] = check_package("unsloth")

    return deps


def check_package(name: str) -> bool:
    """检查包是否已安装"""
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def print_dependencies_status(deps: dict[str, bool]):
    """打印依赖状态"""
    print(f"\n{'=' * 60}")
    print(f"[CHECK] 依赖检查结果")
    print(f"{'=' * 60}")

    all_core = ["torch", "transformers", "peft", "trl", "datasets"]
    all_optional = ["bitsandbytes", "unsloth"]

    print("\n核心依赖 (必须有):")
    for dep in all_core:
        status = "[OK]" if deps.get(dep) else "[FAIL]"
        print(f"  {status} {dep}")

    print("\n可选依赖 (用于加速):")
    for dep in all_optional:
        status = "[OK]" if deps.get(dep) else "[WARN]"
        print(f"  {status} {dep}")

    all_core_ok = all(deps.get(d) for d in all_core)
    return all_core_ok


def install_dependencies(force_cpu: bool = False, force_gpu: bool = False) -> bool:
    """安装所有依赖"""

    # 确定安装目标
    if force_cpu:
        target = "cpu"
        extra_index = ""
    elif force_gpu:
        target = "gpu"
        extra_index = ""
    else:
        # 自动检测
        has_gpu, gpu_msg = check_gpu()
        if has_gpu:
            target = "gpu"
            print(f"自动检测: {gpu_msg}")
        else:
            target = "cpu"
            print(f"自动检测: {gpu_msg}, 将安装 CPU 版本")

    print(f"\n[TARGET] 安装目标: {target.upper()}")

    # 构建安装命令
    if target == "cpu":
        # CPU 版本 - 使用 CPU-only 的 PyTorch
        cmd = (
            "pip install --upgrade pip && "
            "pip install torch torchvision torchaudio "
            "--index-url https://download.pytorch.org/whl/cpu && "
            "pip install transformers peft trl datasets accelerate bitsandbytes"
        )
    else:
        # GPU 版本
        cmd = (
            "pip install --upgrade pip && "
            "pip install torch torchvision torchaudio "
            "pip install transformers peft trl datasets accelerate bitsandbytes"
        )

    success, output = run_command(cmd, "安装 Python 依赖")

    if success:
        print("\n[OK] 依赖安装完成!")
    else:
        print("\n[FAIL] 依赖安装失败")
        print("错误信息:", output[-1000:] if len(output) > 1000 else output)

    return success


def test_backend_import() -> bool:
    """测试 backend 是否可以导入"""
    print(f"\n{'=' * 60}")
    print(f"[TEST] 测试 Backend 导入")
    print(f"{'=' * 60}")

    # 添加 trainer 目录到路径
    trainer_dir = Path(__file__).parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

    try:
        # 尝试导入各个 backend
        from backend_base import TrainerBackend

        print("[OK] backend_base 导入成功")

        # 检查 peft_trl_orpo_backend 的懒加载是否工作
        from peft_trl_orpo_backend import PeftTrlORPOBackend

        print("[OK] peft_trl_orpo_backend 导入成功 (懒加载机制正常)")

        from dry_run_backend import DryRunBackend

        print("[OK] dry_run_backend 导入成功")

        return True

    except ImportError as e:
        print(f"[FAIL] 导入失败: {e}")
        return False
    except Exception as e:
        print(f"[FAIL] 错误: {e}")
        return False


def print_usage_guide():
    """打印使用指南"""
    print(f"\n{'=' * 60}")
    print(f"[GUIDE] 使用指南")
    print(f"{'=' * 60}")

    trainer_dir = Path(__file__).parent

    print(f"""
[SUCCESS] 环境设置完成！

下一步: 运行训练

1. 准备 ORPO 数据集导出:
   cd {trainer_dir.parent.parent.parent}
   # 使用插件命令导出训练数据
   # 参考 nocturnal-export.ts 的实现

2. 运行 dry-run 测试 (验证环境):
   python {trainer_dir}/main.py --spec test_spec.json --output-dir ./output

3. 运行真实训练 (需要 GPU):
   python {trainer_dir}/main.py --spec your_experiment.json --output-dir ./checkpoints

4. 查看帮助:
   python {trainer_dir}/main.py --help

训练后检查点位置: ./checkpoints/checkpoint-<id>/adapter/
""")

    # 检查 Unsloth
    if check_package("unsloth"):
        print("""
[TIP] 提示: 检测到 Unsloth 已安装
   Unsloth 可以加速训练 (~2x)。未来启用时:
   - 使用 backend='unsloth-orpo' 而不是 'peft-trl-orpo'
   - 或等待 unsloth_orpo_backend.py 实现完成
""")


def main():
    args = get_args()

    print(f"\n{'=' * 60}")
    print(f"[SETUP] Nocturnal Trainer 环境检查与安装")
    print(f"{'=' * 60}")

    # 1. 检查 Python
    print(f"\n[PYTHON] Python 版本:")
    py_ok, py_msg = check_python()
    print(f"   {py_msg}")
    if not py_ok:
        print(f"\n[FAIL] Python 版本不支持，请升级到 Python 3.8+")
        sys.exit(1)

    # 2. 检查 GPU
    print(f"\n[GPU] GPU 检测:")
    gpu_ok, gpu_msg = check_gpu()
    print(f"   {gpu_msg}")

    # 3. 检查依赖
    deps = check_dependencies()
    core_ok = print_dependencies_status(deps)

    if args.check:
        print(f"\n{'=' * 60}")
        print(f"检查完成{'[OK]' if core_ok else '[WARN]'}")
        if core_ok:
            # 尝试导入测试
            test_backend_import()
        return

    if not core_ok:
        print(f"\n[WARN] 部分核心依赖缺失，开始安装...")
        install_dependencies(force_cpu=args.cpu, force_gpu=args.gpu)

        # 重新检查
        deps = check_dependencies()
        core_ok = print_dependencies_status(deps)
    else:
        print(f"\n[OK] 所有核心依赖已安装")
        response = input("\n是否要重新安装依赖? (y/N): ").strip().lower()
        if response == "y":
            install_dependencies(force_cpu=args.cpu, force_gpu=args.gpu)
            deps = check_dependencies()
            core_ok = print_dependencies_status(deps)

    # 4. 测试导入
    print(f"\n{'=' * 60}")
    print(f"[VERIFY] 最终验证")
    print(f"{'=' * 60}")

    import_test_ok = test_backend_import()

    if core_ok and import_test_ok:
        print(f"\n[OK] 环境就绪!")
        print_usage_guide()
    else:
        print(f"\n[WARN] 环境可能有问题，请检查上述错误信息")
        print(f"\n常见问题:")
        print(f"  1. 如果安装太慢，可以尝试手动安装:")
        print(
            f"     pip install torch --index-url https://download.pytorch.org/whl/cpu"
        )
        print(f"     pip install transformers peft trl datasets accelerate")


if __name__ == "__main__":
    main()
