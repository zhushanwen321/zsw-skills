---
name: worktree-manipulate
description: >-
  管理 bare repo + worktree 工作区的唯一入口：创建/清理 worktree、切换分支、
  工作区管理、githook 安装、为项目生成 worktree 工作流 skill。
  触发词：创建worktree、新 worktree、新建分支、开个新分支、删除worktree、
  清理worktree、清理分支、删除分支、清理工作区、worktree、workspace、
  切换分支、工作区管理、生成项目 skill、创建 workflow skill、worktree template、
  这个分支不要了、帮我清理一下、list worktrees、install hooks。
  本 skill 是路由入口——命中后先读正文路由表，再 read 匹配子 skill 执行，
  一次最多读 2 个。子 skill 不直接暴露，禁止按名字自行加载。
---

# Worktree Manipulate — worktree 操作路由入口

统一入口，路由到 4 个子 skill。**不要用本文件内容当执行指令**——路由判断后 `read` 匹配子 skill 的 SKILL.md（绝对路径见下），按其正文执行。一次只读 1 个，横跨多意图时最多 2 个。

子 skill 根目录：`~/.agents/skills/worktree-manipulate/`

---

## 路由表

### 一、创建 worktree（自动化脚本，推荐）
- **创建新分支的隔离工作目录**（自动检测 workspace、同步配置、装依赖、装 git hooks）
  → `read` `~/.agents/skills/worktree-manipulate/create-worktree/SKILL.md`
  触发：「创建worktree」「新 worktree」「新建分支」「开个新分支」「我要做一个新功能」「帮我开个分支做 xxx」

### 二、清理 worktree（安全删除）
- **删除 worktree**（默认检查是否已合并到 main，确认安全后才删；支持 `--force` / `--skip-sync`）
  → `read` `~/.agents/skills/worktree-manipulate/remove-worktree/SKILL.md`
  触发：「删除worktree」「清理worktree」「清理分支」「删除分支」「清理工作区」「这个分支不要了」「帮我清理一下」

### 三、原理 / 手工管理（无脚本，按命令操作）
- **bare-repo 布局原理、列出 worktree、切换分支、githook 安装/修复、新机器搭建、排错**
  → `read` `~/.agents/skills/worktree-manipulate/workspace-worktree/SKILL.md`
  触发：「工作区管理」「切换分支」「查看worktree」「list worktrees」「安装hooks」「hooks 没装」「新机器搭建」、多分支并行管理、hook/排错类问题

### 四、生成项目级 skill（模板生成，不执行操作）
- **为项目生成 pull-request / code-review / merge 等项目级 worktree 工作流 skill**
  → `read` `~/.agents/skills/worktree-manipulate/worktree-template/SKILL.md`
  触发：「生成项目 skill」「创建 workflow skill」「worktree template」

---

## 歧义消解

| 用户意图 | 路由到 |
|---------|--------|
| 「创建worktree」日常建分支 | create-worktree（脚本自动化） |
| 想知道布局原理 / 手工搭建 / hook 机制 | workspace-worktree |
| 「切换分支」 | workspace-worktree（不是 create） |
| 创建后 hook 缺失、目录名不匹配等排错 | workspace-worktree |
| 「生成 skill」「模板」 | worktree-template（不执行实际操作） |

## 关键约束

1. **4 个子 skill 均设 `disable-model-invocation: true`，不会自动触发**——用户表达对应意图时主动 `read` 指向它们，别等自动加载。
2. **一次最多读 2 个**：横跨多意图（如先创建后清理）时按需读，禁止一次全读。
3. **脚本路径已更新**：`bash ~/.agents/skills/worktree-manipulate/<子目录>/<脚本名>`。
4. **worktree-template 是生成器**：不做 merge/create/remove 等实际操作——那些走对应子 skill 或项目自己的 skill。
