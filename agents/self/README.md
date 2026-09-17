# agents/self

自用 agent 的登记与组织目录。本目录当前只放 skill 内嵌 agent 的 symlink，独立 agent 文件待第二批次建档。

## skill 内嵌 agent（symlink）

| Symlink | 实体位置 | 说明 |
|---------|---------|------|
| tech-design-review.md | ../../skills/self/tech-design/agents/tech-design-review.md | 设计文档对抗式主审 |
| tech-design-impact-review.md | ../../skills/self/tech-design/agents/tech-design-impact-review.md | 影响面审查 |
| tech-design-simplicity-review.md | ../../skills/self/tech-design/agents/tech-design-simplicity-review.md | 过度设计审查 |

单一事实源在 `skills/self/tech-design/agents/`，本目录 symlink 仅用于让 agents 视角可发现。**禁止把实体复制进来形成双源。**

## 待第二批次建档（尚未迁入，源头无版本管理）

- `~/.zcode/agents/`：context-builder、oracle、researcher、reviewer、u-dev、worker（真实文件副本，源头缺失）
- `~/.pi/agent/agents/`：general-purpose、harness-retrospect、vision-analyze

## 随 claude-code-tool 归档，不迁移

claude-code-tool `agents/` 下 9 个（batch-code-tracer、batch-issue-tracer、batch-review-tracer、bug-fixer、code-fixer、code-reviewer、rebase-conflict-resolver、rust-taste-check、ts-taste-check），消费点在 `~/.claude/agents/`。

## 安装约束

zcode 的 agent 发现入口用 `lstat` 校验、软链零容忍：同步到 `~/.zcode/agents/` 时必须复制真实文件，不能用本目录的 symlink。`~/.pi/agent/agents/` 无此限制，可软链。
