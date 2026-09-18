---
name: worktree-template
# 由 worktree-manipulate 路由调用，不直接暴露给模型自动加载
disable-model-invocation: true
description: >-
  为项目创建 worktree 工作流 skill。触发词："生成项目 skill"、
  "创建 workflow skill"、"worktree template"。指导用户/AI 从模板
  生成 pull-request、code-review、merge 等项目级 skill。不用于
  直接执行操作——那些由项目自己的 skill 处理。
---

# Worktree Template

## Overview

全局 shell 脚本保留为通用引擎，项目特化知识下沉到项目级 skill。每个项目按需创建自己的 skill（如 pull-request、code-review、merge），不再依赖 `.bare/custom-hooks/` 扩展点。

## When to Use

- 新项目需要建立 worktree 工作流 skill
- 已有项目想从 custom-hooks 迁移到 skill
- 项目特化知识（changeset、Electron、Docker 等）需要集中

**When NOT to use:**
- 直接执行 merge/create/remove 等操作 → 用项目自己的 skill
- 修改全局 shell 脚本 → 直接编辑本目录 `references/` 下的对应模板

## 生成步骤

1. 在项目 `.agents/skills/` 下创建 skill 目录
2. 从 references/ 复制模板
3. 复制所需的脚本到目标 skill 目录（**复制**，不要用 symlink）
4. 填写项目特化（触发词、验证命令、发布流程）
5. 验证：`python3 scripts/validate-skill-yaml.py SKILL.md`

## Skill 命名

项目内 skill 不需要前缀，直接命名：

| skill | 职责 |
|-------|------|
| `pull-request` | pre-merge 验证 + commit + push + PR 创建 |
| `code-review` | 代码审查，项目特化维度 |
| `merge` | 合并发布，项目特化阶段覆盖 |

## 模板文件

| 文件 | 用途 |
|------|------|
| [`references/pull-request.md`](references/pull-request.md) | PR 提交 skill 模板 |
| [`references/code-review.md`](references/code-review.md) | 代码审查 skill 模板 |
| [`references/merge.md`](references/merge.md) | 合并发布 skill 模板 |
| [`references/verify-npm.md`](references/verify-npm.md) | npm 交付物验证 |
| [`references/verify-electron.md`](references/verify-electron.md) | Electron 交付物验证 |
| [`references/changeset-publish.md`](references/changeset-publish.md) | changeset 发布流程 |

## Common Mistakes

| 错误 | 修复 |
|------|------|
| description 包含流程细节 | 只写触发词 |
| 用 symlink 链接脚本到项目 skill | 脚本必须**复制**到目标 skill 目录，确保项目 skill 自包含、可独立运行 |
| 项目 skill 和全局 skill 同名 | 项目 skill 用简短名（如 `merge` 而非 `merge-worktree`） |

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 必须遵守 | 严格遵守 |
| `[OPTIONAL]` | 可选 | 可根据项目调整 |
