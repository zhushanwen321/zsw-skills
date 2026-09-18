# zsw-skills

个人 skills 与 agents 管理仓库。

[English](README.en.md) | 中文

## 仓库结构

```
skills/
  self/            原创 skill，按功能域分类
    dev-workflow/    常规开发流程
    code-optimize/   代码优化
    thinking/        复杂问题
    prompting/       提示词优化
    tools/           其他工具
  external/        收录的外部 skill
agents/
  self/            自用 agent
  external/        预留
```

## Skills

### dev-workflow/ — 常规开发流程

| Skill | 说明 |
|-------|------|
| tech-design | 技术设计文档的写作与对抗式审查，内嵌 3 个 review agent |
| dev-flow | 将已通过审查的技术设计文档落地为可运行代码 |
| design-code-sync | 校准代码实现与设计文档的一致性 |

### code-optimize/ — 代码优化

| Skill | 说明 |
|-------|------|
| code-simplify | 简化代码：清理重复、死代码与本次改动 |
| code-harden | 代码生产就绪加固：异常分级、重试策略、失败语义、错误处理策略裁决 |
| code-overdesign-audit | 审计过度设计与投机抽象，产出可裁决的简化候选 |
| test-quality | 测试设计与分层，最大化单位时间抓 bug 价值 |

### thinking/ — 复杂问题

| Skill | 说明 |
|-------|------|
| rethink | 跳出局部修补循环、从全局重新审视问题的思维框架 |

### prompting/ — 提示词优化

| Skill | 说明 |
|-------|------|
| meta-prompt-guidance | AI agent 提示词的设计、编写与审查方法论 |

### tools/ — 其他工具

| Skill | 说明 |
|-------|------|
| anysearch | 统一搜索：通用 web、新闻、URL 提取/爬取，垂直结构化检索（股票/CVE/论文/专利）与批量并行搜索 |
| browser-automation | 网页/Electron 调试：截图、元素检查、UI 交互、网络监控 |
| quota-wait | 模型套餐额度耗尽时挂起任务并定时接续 |
| user-memory | 记录与读取用户偏好、习惯 |
| worktree-manipulate | bare repo + worktree 工作区管理唯一入口 |

### external/ — 收录

| Skill | 上游 | 说明 |
|-------|------|------|
| drawio-skill | [Agents365-ai/drawio-skill](https://github.com/Agents365-ai/drawio-skill) | drawio 图表绘制：流程图、架构图、ER 图 |
| emil-animate-designer | [emilkowalski/skills](https://github.com/emilkowalski/skills) | 动效方法论路由入口，9 个子 skill 收录于 `sub-skills/` |
| handoff | 收录 | 将当前会话压缩成交接文档 |
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | 前端界面设计、打磨与审查 |
| improve-codebase-architecture | 收录 | 架构改进与重构机会识别 |
| teach | 收录 | 交互式教学 |
| visual-explainer | 收录 | 自包含 HTML 可视化产物：图表、diff 审查、项目回顾 |

## Agents

skill 内嵌 agent 以 symlink 登记在 `agents/self/`（如 tech-design 的 tech-design-review、tech-design-impact-review、tech-design-simplicity-review），实体单一事实源在所属 skill 目录内，禁止复制副本进来形成双源。`agents/external/` 预留。
