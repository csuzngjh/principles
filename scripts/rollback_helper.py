def _rollback_stash(stash_name):
    """回滚到指定的 git stash 快照"""
    try:
        # 查找 stash
        result = subprocess.run(
            ["git", "stash", "list"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=True
        )
        
        stash_index = None
        for i, line in enumerate(result.stdout.splitlines()):
            if stash_name in line:
                stash_index = f"stash@{{{i}}}"
                break
        
        if stash_index:
            # 重置到 stash 状态
            subprocess.run(
                ["git", "reset", "--hard"],
                cwd=PROJECT_ROOT,
                capture_output=True,
                check=True
            )
            subprocess.run(
                ["git", "stash", "apply", stash_index],
                cwd=PROJECT_ROOT,
                capture_output=True,
                check=True
            )
            logging.info(f"Rollback successful: applied {stash_index}")
        else:
            logging.warning(f"Stash {stash_name} not found, skipping rollback")
            
    except Exception as exc:
        logging.error(f"Rollback failed: {exc}")
