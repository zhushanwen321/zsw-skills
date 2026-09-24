---
name: pull-request
description: >-
  提交 Pull Request。触发词：<填写项目常用说法>。
  执行 pre-merge 验证后 push 并创建 PR。
---

# Pull Request

## 前提

当前在 worktree 目录中，有未提交的变更。

## 步骤

### 1. pre-merge 验证

优先使用全局 merge-worktree 的 pre-merge-check.sh：

```bash
bash ~/.agents/skills/merge-worktree/pre-merge-check.sh
```

如果需要项目特化验证，在上方命令之后补充：

```bash
# <填写项目特有验证命令>
```

**零容忍**：任何失败都必须当场直接修复，不允许跳过。

### 2. commit message

让用户提供，或使用 zcommit 自动生成。

### 3. push + PR

使用全局 pr-worktree 脚本（自动处理 push、已有 PR 检测、创建/更新）：

```bash
bash ~/.agents/skills/pr-worktree/pr-worktree.sh
```

可选参数：`--draft`、`--title "xxx"`、`--body "xxx"`、`--base main`

## 项目特化

<!-- 填写：项目特有的验证要求、PR 规范等 -->
