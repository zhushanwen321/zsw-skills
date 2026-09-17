---
name: merge
description: >-
  合并分支并发布。触发词：<填写项目常用说法>。
  执行合并发布流程。
---

# Merge

## 流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-new-feature`），不是 `main`。脚本会自动检测 `$WS_ROOT/main` 用于 bump/tag/push。传 `main` 会导致阶段 7 删除 main worktree。

```bash
cd <workspace-root>
bash ~/.agents/skills/merge-worktree/stages/0-init.sh <worktree-dir> [patch|minor|major]
```

### 阶段 1: 本地验证
```bash
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh
```

### 阶段 2: PR CI + 合并
```bash
bash ~/.agents/skills/merge-worktree/stages/2-pr-merge.sh
```

### 阶段 3: Post-merge CI
```bash
bash ~/.agents/skills/merge-worktree/stages/3-post-merge-ci.sh
```

### 阶段 4: 版本 bump + 发布
<!-- 检查项目是否有 scripts/publish.sh：
  - 有：全局 4-publish.sh 会自动委托执行
  - 无：全局 4-publish.sh 会自行 npm version + tag + push
  填写项目特化说明（如 changeset、Electron、Docker 等）
-->
```bash
bash ~/.agents/skills/merge-worktree/stages/4-publish.sh
```

### 阶段 5: Release Notes + Release
```bash
bash ~/.agents/skills/merge-worktree/stages/5-release.sh
```

### 阶段 6: 交付物验证
<!-- 填写项目特化验证命令。示例见 verify-*.md -->
```bash
bash ~/.agents/skills/merge-worktree/stages/6-verify.sh
```

### 阶段 7: 清理
```bash
bash ~/.agents/skills/merge-worktree/stages/7-cleanup.sh
```

## 项目特化要点
<!-- 填写：版本管理、交付物、hooks 等 -->
