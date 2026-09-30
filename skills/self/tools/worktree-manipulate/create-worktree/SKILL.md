---
name: create-worktree
# 由 worktree-manipulate 路由调用，不直接暴露给模型自动加载
disable-model-invocation: true
description: >-
  在 bare repo + worktree 结构中创建隔离的工作目录。自动检测 workspace、同步配置、 安装依赖和 git hooks。当用户说"创建 worktree"、"新 worktree"、"create worktree"、 "新建分支"、"开个新分支"时使用此 skill。即使用户只是说"我要做一个新功能"或 "帮我开个分支做 xxx"，也应考虑触发此 skill。
---

# Create Worktree

在 bare repo + worktree 结构中创建新分支的隔离工作目录。

## 脚本

```
create-worktree.sh <branch-name> [base-branch]
```

### 参数

| 参数 | 位置 | 必填 | 说明 |
|------|------|------|------|
| `branch-name` | $1 | 是 | 分支名，如 `feat/new-feature`。`/` 自动转为 `-` 作为目录名 |
| `base-branch` | $2 | 否 | 基础分支，省略时为 `main` |

### 用法示例

```bash
# 创建新功能分支（基于 main）
bash ~/.agents/skills/worktree-manipulate/create-worktree/create-worktree.sh feat/new-feature

# 基于指定分支创建
bash ~/.agents/skills/worktree-manipulate/create-worktree/create-worktree.sh fix/bug develop

# 检出已有分支
bash ~/.agents/skills/worktree-manipulate/create-worktree/create-worktree.sh 024-ai-data-api
```

### 脚本行为

1. 从当前目录向上查找 workspace 根（包含 `.bare/` 的目录）——`find_workspace_root` 来自共享库 `_lib/workspace.sh`（本脚本 source 复用，不维护私有副本）
2. 同步远程引用：取**第一个非 `origin` 的远端**（通常为 `github`/`upstream`）执行 `git fetch --prune`；没有非 `origin` 远端时回退 `fetch origin --prune`
3. 存在非 `origin` 远端时，把各 `origin/*` 引用改写为该远端的对应 sha（`git update-ref`），使基于 `origin/main` 的创建能拿到最新代码
4. 同步本地 `main`：仅当本地 `main` 可 fast-forward 到该远端的 `main` 时，才把 `refs/heads/main` 移动到远端 sha。**副作用警告：本地 `main` 有远程没有的领先提交时，脚本跳过同步并输出 `Warning: 本地 main 有远程没有的提交，跳过本地 main 同步（保留本地提交）`**——裸仓库默认不记 reflog，直接改写会让这些提交移出分支且不可恢复
5. 分支处理：本地分支已存在 → 直接 `worktree add` 检出；否则创建新分支，base 优先取 bare repo 本地分支，本地不存在时回退 `origin/<base-branch>`
6. 从 main/master worktree 复制 `.claude/settings.local.json` 到新 worktree（源文件与新 worktree 的 `.claude/` 目录都存在时才复制）
7. 安装依赖（在新 worktree 内执行）：
   - 项目脚本 `<workspace 根>/.bare/custom-hooks/setup-worktree.sh` 存在且可执行 → 执行它（参数为新 worktree 路径），**跳过通用安装**
   - 否则通用安装：`backend/pyproject.toml` → `uv sync`；`frontend/package.json` → `pnpm install`（无 npm 回退，不处理根目录 `package.json`）
   - 任一安装失败仅输出 `Warning: ... 请手动安装`，**不阻断创建流程**
8. 从 main/master worktree 复制已安装的 `pre-commit` hook 到新 worktree（存在时才复制）
9. 依赖安装 / hook 复制阶段失败 → 脚本自动清理已创建的 worktree，以非零码退出

### 输出

成功时输出（`Syncing origin refs` 段仅在非 `origin` 远端存在时出现；settings 复制 / setup hook / 依赖安装 / hooks 复制为条件行，按项目结构增减）：

```
Workspace: /path/to/project-workspace
Fetching from remote...
Syncing origin refs from github...
  origin/main -> a1b2c3d4
  local main -> a1b2c3d4
创建分支 'feat/new-feature' (基于 main)...
已复制 .claude/settings.local.json (from main)
已安装 git hooks (from primary worktree)

============================================
Worktree 创建完成!
  分支: feat/new-feature
  路径: /path/to/project-workspace/feat-new-feature
============================================
```

成功判据：输出包含 `Worktree 创建完成!`。

### 错误场景

| 退出码 | 输出 | 原因 |
|--------|------|------|
| 1 | `Error: 未找到 workspace` | 当前目录不在 workspace 内，需要 cd 到 workspace 子目录 |
| 1 | `Error: .bare/ 不是一个有效的 bare git 仓库` | workspace 结构损坏 |
| 1 | `Error: 目录 'xxx' 已存在` | 同名 worktree 已存在 |

### AI 操作步骤

1. 向用户获取分支名（必填）和基础分支（可选，省略时为 `main`）
2. 运行 `bash ~/.agents/skills/worktree-manipulate/create-worktree/create-worktree.sh <branch-name> [base-branch]`
3. 确认输出包含 `"Worktree 创建完成!"`
4. 告诉用户新 worktree 的路径
