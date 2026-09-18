# agents/self

自用 agent 登记目录。

## skill 内嵌 agent（symlink）

| Symlink | 实体位置 | 说明 |
|---------|---------|------|
| tech-design-review.md | ../../skills/self/dev-workflow/tech-design/agents/tech-design-review.md | 设计文档对抗式主审 |
| tech-design-impact-review.md | ../../skills/self/dev-workflow/tech-design/agents/tech-design-impact-review.md | 影响面审查 |
| tech-design-simplicity-review.md | ../../skills/self/dev-workflow/tech-design/agents/tech-design-simplicity-review.md | 过度设计审查 |

单一事实源在 `skills/self/dev-workflow/tech-design/agents/`，本目录 symlink 仅用于 agents 视角发现。**禁止把实体复制进来形成双源。**

## 安装约束

zcode 的 agent 发现入口用 `lstat` 校验、软链零容忍：同步到 `~/.zcode/agents/` 时必须复制真实文件，不能用本目录的 symlink。`~/.pi/agent/agents/` 无此限制，可软链。
