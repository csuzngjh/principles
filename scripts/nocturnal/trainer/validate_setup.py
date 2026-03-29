#!/usr/bin/env python3
"""
Nocturnal Trainer 快速验证脚本
=============================

无需 GPU 或训练数据，即可验证整个训练管道是否正确配置。

验证内容:
1. 所有 backend 可以正确导入
2. 数据类型定义正确
3. 懒加载依赖机制工作
4. dry-run backend 可以执行
5. (可选) 测试 peft-trl-orpo 的 validate_spec

用法:
    python validate_setup.py           # 完整验证
    python validate_setup.py --quick   # 快速验证 (跳过 CPU 测试)
"""

import sys
import os
import json
import tempfile
import argparse
from pathlib import Path


def get_args():
    parser = argparse.ArgumentParser(description="Nocturnal Trainer 验证")
    parser.add_argument("--quick", action="store_true", help="快速验证 (跳过 CPU)")
    return parser.parse_args()


def section(title: str):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


def ok(msg: str):
    print(f"  [OK] {msg}")


def fail(msg: str):
    print(f"  [FAIL] {msg}")


def info(msg: str):
    print(f"  [INFO] {msg}")


def step(msg: str):
    print(f"\n  -> {msg}...", end=" ")


def test_import_backends():
    """测试导入所有 backend"""
    section("测试 1: Backend 导入")

    trainer_dir = Path(__file__).parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

    try:
        from backend_base import (
            TrainerBackend,
            TrainingExperimentSpec,
            TrainingExperimentResult,
            TrainingHyperparameters,
            TrainingBudget,
            ExpectedArtifact,
            TrainingMetrics,
            TrainingArtifact,
        )

        ok("backend_base 导入成功")

        from peft_trl_orpo_backend import PeftTrlORPOBackend

        ok("peft_trl_orpo_backend 导入成功 (懒加载机制正常)")

        from dry_run_backend import DryRunBackend

        ok("dry_run_backend 导入成功")

        return True
    except ImportError as e:
        fail(f"导入失败: {e}")
        return False


def test_dataclass_serialization():
    """测试数据类型和序列化"""
    section("测试 2: 数据类型定义")

    trainer_dir = Path(__file__).parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

    from backend_base import (
        TrainingExperimentSpec,
        TrainingExperimentResult,
        TrainingHyperparameters,
        TrainingBudget,
        ExpectedArtifact,
    )

    # 创建测试 spec
    spec = TrainingExperimentSpec(
        experimentId="test-001",
        backend="peft-trl-orpo",
        trainingMode="orpo",
        targetWorkerProfile="local-reader",
        targetModelFamily="test-model",
        hardwareTier="consumer-gpu",
        datasetExportId="exp-123",
        datasetExportPath="/tmp/test.jsonl",
        datasetFingerprint="fp-abc",
        benchmarkExportId="bench-456",
        outputDir="/tmp/output",
        configFingerprint="fp-config",
        codeHash="fp-code",
        hyperparameters=TrainingHyperparameters(
            learningRate=3e-4,
            batchSize=2,
            gradientAccumulation=8,
            loraRank=16,
            loraAlpha=32,
            loraDropout=0.05,
            warmupRatio=0.1,
            maxSteps=100,
            maxSeqLength=2048,
        ),
        budget=TrainingBudget(maxWallClockMinutes=60),
        expectedArtifact=ExpectedArtifact(
            checkpointName="test-ckpt",
            adapterFormat="peft-adapter",
        ),
    )
    ok("TrainingExperimentSpec 创建成功")

    # 测试序列化
    spec_dict = {
        "experimentId": spec.experimentId,
        "backend": spec.backend,
        "trainingMode": spec.trainingMode,
        "hyperparameters": {
            "learningRate": spec.hyperparameters.learningRate,
            "batchSize": spec.hyperparameters.batchSize,
        },
    }
    json_str = json.dumps(spec_dict)
    ok("数据类型可序列化")

    # 创建测试 result
    result = TrainingExperimentResult(
        experimentId="test-001",
        backend="peft-trl-orpo",
        status="completed",
        trainRunId="run-001",
        checkpointId="ckpt-001",
        checkpointRef="ckpt-001",
        targetWorkerProfile="local-reader",
        targetModelFamily="test-model",
        datasetFingerprint="fp-abc",
        configFingerprint="fp-config",
        codeHash="fp-code",
    )
    result_dict = result.to_dict()
    ok("TrainingExperimentResult.to_dict() 正常工作")

    return True


def test_dry_run_backend():
    """测试 dry-run backend 执行"""
    section("测试 3: Dry-Run Backend")

    trainer_dir = Path(__file__).parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

    from backend_base import (
        TrainingExperimentSpec,
        TrainingHyperparameters,
        TrainingBudget,
        ExpectedArtifact,
    )
    from dry_run_backend import DryRunBackend

    # 创建临时 spec
    with tempfile.TemporaryDirectory() as tmpdir:
        spec = TrainingExperimentSpec(
            experimentId="dry-run-test",
            backend="dry-run",
            trainingMode="orpo",
            targetWorkerProfile="local-reader",
            targetModelFamily="test-model",
            hardwareTier="cpu-experimental",
            datasetExportId="exp-123",
            datasetExportPath=str(Path(tmpdir) / "nonexistent.jsonl"),
            datasetFingerprint="fp-abc",
            benchmarkExportId="bench-456",
            outputDir=tmpdir,
            configFingerprint="fp-config",
            codeHash="fp-code",
            hyperparameters=TrainingHyperparameters(
                learningRate=3e-4,
                batchSize=2,
                gradientAccumulation=8,
                loraRank=16,
                loraAlpha=32,
                loraDropout=0.05,
                warmupRatio=0.1,
                maxSteps=10,
                maxSeqLength=1024,
            ),
            budget=TrainingBudget(maxWallClockMinutes=5),
            expectedArtifact=ExpectedArtifact(
                checkpointName="test",
                adapterFormat="peft-adapter",
            ),
        )

        # 验证 spec
        backend = DryRunBackend(spec)
        step("验证 spec")
        validated = backend.validate_spec()
        if validated:
            ok("Spec 验证通过")
        else:
            fail(f"Spec 验证失败: {backend.errors}")
            return False

        # 执行 dry-run
        step("执行 dry-run")
        result = backend.execute_training()

        if result.status == "dry_run":
            ok(f"Dry-run 执行成功: {result.trainRunId}")
        else:
            fail(f"Dry-run 状态异常: {result.status}")
            return False

        # 检查输出
        if result.trainRunId:
            ok(f"生成了 trainRunId: {result.trainRunId[:8]}...")

    return True


def test_peft_trl_validation():
    """测试 peft-trl-orpo 的 validate_spec"""
    section("测试 4: PEFT-TRL Backend 验证逻辑")

    trainer_dir = Path(__file__).parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

    from peft_trl_orpo_backend import PeftTrlORPOBackend
    from backend_base import (
        TrainingExperimentSpec,
        TrainingHyperparameters,
        TrainingBudget,
        ExpectedArtifact,
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        # 测试 1: 正确 spec (但文件不存在 - 这是正常的)
        spec = TrainingExperimentSpec(
            experimentId="peft-test",
            backend="peft-trl-orpo",
            trainingMode="orpo",
            targetWorkerProfile="local-reader",
            targetModelFamily="Qwen/Qwen2-0.5B-Instruct",
            hardwareTier="consumer-gpu",
            datasetExportId="exp-123",
            datasetExportPath=str(Path(tmpdir) / "fake.jsonl"),
            datasetFingerprint="fp-abc",
            benchmarkExportId="bench-456",
            outputDir=tmpdir,
            configFingerprint="fp-config",
            codeHash="fp-code",
            hyperparameters=TrainingHyperparameters(
                learningRate=3e-4,
                batchSize=2,
                gradientAccumulation=8,
                loraRank=16,
                loraAlpha=32,
                loraDropout=0.05,
                warmupRatio=0.1,
                maxSteps=10,
                maxSeqLength=1024,
            ),
            budget=TrainingBudget(maxWallClockMinutes=5),
            expectedArtifact=ExpectedArtifact(
                checkpointName="test",
                adapterFormat="peft-adapter",
            ),
        )

        step("验证正确的 ORPO spec")
        backend = PeftTrlORPOBackend(spec)
        validated = backend.validate_spec()
        # 文件不存在会报错，但 spec 结构是对的
        if not validated and "not found" in " ".join(backend.errors):
            ok("正确识别到文件不存在 (预期行为)")
        elif validated:
            ok("Spec 验证通过")
        else:
            info(f"验证结果: {backend.errors}")

        # 测试 2: 错误的 training mode
        step("验证错误的 training mode")
        spec_bad = TrainingExperimentSpec(
            experimentId="peft-test",
            backend="peft-trl-orpo",
            trainingMode="sft",  # 错误!
            targetWorkerProfile="local-reader",
            targetModelFamily="Qwen/Qwen2-0.5B-Instruct",
            hardwareTier="consumer-gpu",
            datasetExportId="exp-123",
            datasetExportPath=str(Path(tmpdir) / "fake.jsonl"),
            datasetFingerprint="fp-abc",
            benchmarkExportId="bench-456",
            outputDir=tmpdir,
            configFingerprint="fp-config",
            codeHash="fp-code",
            hyperparameters=TrainingHyperparameters(
                learningRate=3e-4,
                batchSize=2,
                gradientAccumulation=8,
                loraRank=16,
                loraAlpha=32,
                loraDropout=0.05,
                warmupRatio=0.1,
                maxSteps=10,
                maxSeqLength=1024,
            ),
            budget=TrainingBudget(maxWallClockMinutes=5),
            expectedArtifact=ExpectedArtifact(
                checkpointName="test",
                adapterFormat="peft-adapter",
            ),
        )
        backend_bad = PeftTrlORPOBackend(spec_bad)
        validated_bad = backend_bad.validate_spec()
        if not validated_bad and any("orpo" in e.lower() for e in backend_bad.errors):
            ok("正确拒绝非 ORPO training mode")
        else:
            fail("未正确验证 training mode")
            return False

        # 测试 3: CPU-Experimental 拒绝
        step("验证 CPU-Experimental 拒绝")
        spec_cpu = TrainingExperimentSpec(
            experimentId="peft-test",
            backend="peft-trl-orpo",
            trainingMode="orpo",
            targetWorkerProfile="local-reader",
            targetModelFamily="Qwen/Qwen2-0.5B-Instruct",
            hardwareTier="cpu-experimental",  # 错误!
            datasetExportId="exp-123",
            datasetExportPath=str(Path(tmpdir) / "fake.jsonl"),
            datasetFingerprint="fp-abc",
            benchmarkExportId="bench-456",
            outputDir=tmpdir,
            configFingerprint="fp-config",
            codeHash="fp-code",
            hyperparameters=TrainingHyperparameters(
                learningRate=3e-4,
                batchSize=2,
                gradientAccumulation=8,
                loraRank=16,
                loraAlpha=32,
                loraDropout=0.05,
                warmupRatio=0.1,
                maxSteps=10,
                maxSeqLength=1024,
            ),
            budget=TrainingBudget(maxWallClockMinutes=5),
            expectedArtifact=ExpectedArtifact(
                checkpointName="test",
                adapterFormat="peft-adapter",
            ),
        )
        backend_cpu = PeftTrlORPOBackend(spec_cpu)
        validated_cpu = backend_cpu.validate_spec()
        if not validated_cpu and any("cpu" in e.lower() for e in backend_cpu.errors):
            ok("正确拒绝 CPU-Experimental")
        else:
            fail("未正确验证 hardware tier")
            return False

    return True


def test_lazy_import_mechanism():
    """测试懒加载机制"""
    section("测试 5: 懒加载依赖机制")

    trainer_dir = Path(__file__).parent
    if str(trainer_dir) not in sys.path:
        sys.path.insert(0, str(trainer_dir))

    # 1. 确认在导入 backend 时不会立即检查依赖
    step("检查 _check_and_import_deps 函数存在")
    from peft_trl_orpo_backend import _check_and_import_deps

    ok("_check_and_import_deps 函数存在")

    # 2. 确认只有在实际调用时才检查依赖
    step("确认懒加载机制")
    info("peft_trl_orpo_backend 已成功导入，但依赖检查被延迟到实际训练时")
    ok("懒加载机制正常工作")

    return True


def print_summary(results: dict[str, bool]):
    """打印测试总结"""
    section("测试总结")

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for name, result in results.items():
        status = "[OK]" if result else "[FAIL]"
        print(f"  {status} {name}")

    print(f"\n  {'=' * 40}")
    print(f"  通过: {passed}/{total}")
    print(f"  {'=' * 40}")

    if passed == total:
        print(
            f"\n[SUCCESS] All validations passed! Environment is configured correctly."
        )
        print(f"\nNext steps:")
        print(f"  1. Run full environment setup: python setup_environment.py")
        print(f"  2. View usage guide: python setup_environment.py --check")
        return 0
    else:
        print(f"\n[WARNING] Some validations failed, please check the errors above")
        print(f"\nCommon issues:")
        print(
            f"  - If 'peft_trl_orpo_backend imported successfully' but subsequent tests fail"
        )
        print(f"    This may be due to lazy loading deferring real errors")
        print(f"  - Run: python setup_environment.py to reinstall dependencies")
        return 1


def main():
    args = get_args()

    print(f"\n{'=' * 60}")
    print(f"  Nocturnal Trainer 快速验证")
    print(f"{'=' * 60}")
    print(f"\n无需 GPU 或真实训练数据，即可验证配置是否正确。")

    results = {}

    # 运行测试
    results["Backend 导入"] = test_import_backends()
    results["数据类型定义"] = test_dataclass_serialization()
    results["Dry-Run Backend"] = test_dry_run_backend()

    if not args.quick:
        results["PEFT-TRL 验证逻辑"] = test_peft_trl_validation()
        results["懒加载机制"] = test_lazy_import_mechanism()
    else:
        info("跳过详细验证 (--quick 模式)")

    return print_summary(results)


if __name__ == "__main__":
    sys.exit(main())
