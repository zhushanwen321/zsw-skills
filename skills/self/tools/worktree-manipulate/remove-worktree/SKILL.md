---
name: remove-worktree
# 由 worktree-manipulate 路由调用，不直接暴露给模型自动加载
disable-model-invocation: true
description: >-
  清理 git worktree。默认检查分支是否已合并到 main，确认安全后才删除。 支持参数：--force（跳过合并检查，强制清理）、--skip-sync（跳过同步其他 worktree）。 当用户说\"删除worktree\"、\"remove worktree\"、\"清理worktree\"、\"清理分支\"、\"删除分支\"、 \"remove-worktree\"、\"清理工作区\"时使用此 skill。即使用户只是说\"这个分支不要了\"或 \"帮我清理一下\"，也应考虑触发此 skill。
---

# Remove Worktree

安全清理 git worktree，支持合并状态检查和同步其他 worktree。

## 脚本

```
remove-worktree.sh <branch-name> [--force] [--skip-sync]
```

### 参数

| 参数 | 位置/标志 | 必填 | 说明 |
|------|----------|------|------|
| `branch-name` | $1 | 是 | 要清理的分支名，如 `feat/old-feature`。`/` 自动转为 `-` 作为目录名 |
| `--force` | flag | 否 | 跳过合并检查和未提交变更检查，强制删除 |
| `--skip-sync` | flag | 否 | 跳过同步其他 worktree 到远程主分支 |

### 用法示例

```bash
# 安全模式：检查已合并 → 同步其他 worktree → 删除
bash ~/.agents/skills/worktree-manipulate/remove-worktree/remove-worktree.sh feat/old-feature

# 强制删除（未合并的分支）
bash ~/.agents/skills/worktree-manipulate/remove-worktree/remove-worktree.sh feat/experiment --force

# 强制删除且跳过同步
bash ~/.agents/skills/worktree-manipulate/remove-worktree/remove-worktree.sh feat/quick-test --force --skip-sync

# 只删除不同步（比如知道其他 worktree 有冲突不想处理）
bash ~/.agents/skills/worktree-manipulate/remove-worktree/remove-worktree.sh feat/done-feature --skip-sync
```

### 脚本行为

#### 默认模式（无 --force）

1. 判定真实远端并同步远程引用：取 `.bare` 的第一个非 `origin` 远端作为真实远端（通常为 `github`），无有效非 `origin` 远端时回退 `origin`；随后 `git fetch <真实远端> --prune` 获取最新远程状态
2. 探测主分支名：`git remote show <真实远端>` 的 HEAD branch，默认 `main`；以 `git branch --merged <真实远端>/<主分支>` 检查分支是否已合并

   **依赖前提**：GitHub PR 必须使用 **Create a merge commit** 合并。如果仓库使用 Squash merge 或 Rebase merge，`git branch --merged` 会误判为"未合并"（因为原始 commit hash 不会进入 main）。此时需用 `--force` 强制删除，或通过 `gh pr list --state merged --json headRefName` 确认 PR 状态。
3. **未合并 → 拒绝删除，显示未合并 commits**，提示使用 `--force`
4. 检查未提交变更（有变更 → 拒绝删除）
5. 同步其他 worktree：对每个其他分支的 worktree 执行 `git fetch <真实远端> <主分支>` + `git merge --no-ff <真实远端>/<主分支>`（真实远端与主分支名判定同步骤 1-2）
6. 冲突时不 abort，保留冲突状态供 AI 处理
7. 删除目标 worktree 和本地分支

#### 删除语义（显式两步，自动执行）

删除固定为两步，**先 `rm -rf <worktree 目录>`，后 `git worktree prune` 清登记**。该顺序下任一步中途失败，git worktree 登记与本地分支都未动，状态可从兄弟 worktree 诊断后重跑本脚本。`git worktree prune` 幂等：只清理目录已丢失的登记，不碰活跃 worktree。

`rm -rf` 失败（文件锁 / 权限 / 外部挂载等）时，脚本输出单命令恢复配方并以退出码 1 结束：

```
Error: 目录删除失败：<worktree 路径>（rm stderr 见上）。git 登记与分支均未动。
       排查根因（文件锁 / 权限 / 外部挂载）后重跑本脚本，或执行单命令：
       rm -rf '<worktree 路径>' && git -C '<workspace 根>/.bare' worktree prune
```

安全性（进入删除阶段前）：非 force 模式下未提交 / 未跟踪（非 ignored）文件拦下删除；`--force` 时先打印 `git status --short` 清单、让将销毁的内容可见后才删。分支删除先 `-d`，失败再 `-D`（非 force 的删除资格由上面的合并检查保证，force 由用户显式指定保证）。

**半删态识别**（现行脚本结构上不产生；出现即手工操作或旧产物残留）：特征是 worktree 目录还在，但目录内一切 git 命令报 `fatal: not a git repository`，且 `.bare/worktrees/<name>/` 登记已消失。此时 git 状态不可读会被脏检查当作有变更——用 `--force` 重跑本脚本即可完成清理（`rm -rf` + prune 会一并收尾）。

#### 强制模式（--force）

1. 跳过合并检查
2. 有未提交变更时警告但仍继续
3. 同步其他 worktree（除非 --skip-sync）
4. 删除目标 worktree 和本地分支（分支先 `-d`、失败再 `-D`）

### 输出

安全模式（已合并）：
```
Workspace: /path/to/project-workspace

=== 检查合并状态 ===
✓ 分支 'feat/old-feature' 已合并到 github/main

=== 同步其他 worktree 到 github/main ===
同步 feat-other (feat/other)...
  OK: feat-other 已同步到最新 main

=== 清理 worktree feat/old-feature ===
删除 worktree 'feat-old-feature'（rm -rf + prune）...
删除本地分支 'feat/old-feature'...

============================================
Remove worktree 完成!
  已删除: feat/old-feature
  已同步: 1 个 worktree
  冲突: 0
============================================
```

未合并时拒绝：
```
=== 检查合并状态 ===
✗ 分支 'feat/wip' 尚未合并到 github/main

未合并的 commits:
  a1b2c3d feat: work in progress
  e4f5g6h wip: more changes

Error: 分支未合并，拒绝删除。使用 --force 强制清理。
```

强制模式：
```
=== 强制模式（跳过合并检查）===

Warning: worktree 有未提交变更（--force 模式下继续删除）:
  M src/main.ts

=== 同步其他 worktree 到 github/main ===

=== 清理 worktree feat/experiment ===
删除 worktree 'feat-experiment'（rm -rf + prune）...
删除本地分支 'feat/experiment'...

============================================
Remove worktree 完成!
  已删除: feat/experiment
  已同步: 0 个 worktree
  冲突: 0
============================================
```

### 错误场景

| 输出 | 原因 | 解决 |
|------|------|------|
| `分支未合并，拒绝删除` | 分支未合并到 main | 确认不需要后加 `--force` |
| `worktree 有未提交变更` | 有未保存改动 | 提交或暂存后重试，或 `--force` |
| `Error: 目录删除失败` + 单命令配方 | `rm -rf` 失败（文件锁 / 权限 / 外部挂载）；git 登记与分支均未动 | 按配方排查根因后重跑脚本，或执行配方里的单命令 |
| `worktree 目录不存在` | 分支名错误或已删除 | 检查 `git worktree list` |
| `未找到 workspace` | 不在 workspace 目录下 | cd 到 workspace 子目录 |

### bash 会话报废信号（删除自身所在目录后）

remove-worktree.sh 删除 worktree 目录时，若 bash 工具的启动目录就在被删目录内，删除后本会话所有 bash 调用会返回**工具层错误**（没有任何命令输出）：

```
Working directory does not exist: <被删 worktree 路径>
Cannot execute bash commands.
```

1. **删除已成功的证明**（目录已从磁盘消失），不是失败信号；命令本身没有被执行
2. **重试无意义**：工具在启动 shell 前就因 cwd 目录不存在而拒绝，`cd <别处> &&` 前缀救不了（拒绝发生在命令文本被解释之前）
3. **会话级永久状态**：立即停止一切 bash 调用。收尾判断——脚本输出过 `Remove worktree 完成!` → 全部完成，直接输出总结；脚本在删目录之后报过错 → 按错误信息里的恢复配方处理，残留无破坏性，写进总结交给用户。剩余收尾改用 read/write 类工具完成；剩余 shell 操作列成命令清单写进总结交给用户执行，不自行尝试

预防：执行清理脚本前先 cd 到 workspace 根目录（见「AI 操作步骤」第 3 步），把 bash 启动目录留在被删目录之外。

### AI 操作步骤

1. 向用户确认要清理的分支名
2. 询问是否强制删除（如果分支可能未合并）
3. **先 cd 到 workspace 根目录**（避免后续删除当前工作目录导致 bash 失败）：
   ```bash
   cd <workspace 根目录>
   ```
4. 运行清理脚本：
   ```bash
   bash ~/.agents/skills/worktree-manipulate/remove-worktree/remove-worktree.sh <branch-name> [--force] [--skip-sync]
   ```
5. 确认输出包含 `"Remove worktree 完成!"`
6. 如果有 merge 冲突，处理冲突：
   - 冲突文件列表：`git diff --name-only --diff-filter=U`
   - 解决后：`git add . && git commit`
   - 放弃同步：`git merge --abort`
