---
name: project-workflow
description: >-
  <项目名>研发工作流。触发词："<项目简称> 合并"、"<项目简称> 提交"、
  "<项目简称> 发布"。用于 worktree 创建、PR 提交、合并发布、
  worktree 清理。不用于通用代码操作——用其他 skill 处理。
---

# <项目名> 研发工作流

## 快速入口

| 任务 | 命令 |
|------|------|
| 创建 worktree | `bash ~/.agents/skills/worktree-manipulate/create-worktree/create-worktree.sh feat/<name>` |
| 提交 PR | `bash ~/.agents/skills/pr-worktree/pr-worktree.sh` |
| 合并发布 | `bash ~/.agents/skills/merge-worktree/stages/N-*.sh` |
| 清理 worktree | `bash ~/.agents/skills/worktree-manipulate/remove-worktree/remove-worktree.sh <branch>` |

## 项目特化

### 版本管理
<!-- 填写：changeset / npm version / semver / 其他 -->

### 交付物验证
<!-- 填写：npm registry / GitHub Release / Docker / PyPI -->
See [references/verify.md](references/verify.md)

### Custom Hooks
<!-- 填写：`.bare/custom-hooks/` 下有哪些 hook，做什么 -->

### scripts/publish.sh
<!-- 填写：存在则描述委托行为，不存在则写"无，由 release.yml 自动处理" -->

## 完整流程

### 阶段 0: 初始化
```bash
cd <workspace-root>
bash ~/.agents/skills/merge-worktree/stages/0-init.sh <worktree-dir> [patch|minor|major]
```

### 阶段 1: 本地验证
```bash
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh
```
或直接用 pre-merge-check.sh：
```bash
bash ~/.agents/skills/merge-worktree/pre-merge-check.sh
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
```bash
bash ~/.agents/skills/merge-worktree/stages/4-publish.sh
```

### 阶段 5: Release Notes + Release
```bash
bash ~/.agents/skills/merge-worktree/stages/5-release.sh
```

### 阶段 6: 确认交付物
```bash
bash ~/.agents/skills/merge-worktree/stages/6-verify.sh
```

### 阶段 7: 清理
```bash
bash ~/.agents/skills/merge-worktree/stages/7-cleanup.sh
```

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 必须遵守 | 严格遵守 |
| `[OPTIONAL]` | 可选 | 可根据项目调整 |
