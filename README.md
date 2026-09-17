# zsw-skills

个人 skills 与 agents 的管理仓库，claude-code-tool（useful-dev-tools 仓库子目录）的继任者。

## 目录结构

```
skills/
  self/       原创自用 skill
  external/   抄来的/融合外部的 skill
agents/
  self/       自用 agent（skill 内嵌 agent 用 symlink 登记，见 agents/self/README.md）
  external/   外部 agent（暂空）
```

## 安装规范

- Skill：`ln -s <仓库路径>/skills/{self|external}/<name> ~/.agents/skills/<name>`，目录名必须与 SKILL.md frontmatter `name` 一致
- Agent 到 pi：`ln -s <仓库路径>/agents/self/<name>.md ~/.pi/agent/agents/<name>.md`
- Agent 到 zcode：**禁止软链**，zcode 发现入口 lstat 校验，必须复制真实文件副本到 `~/.zcode/agents/`

## skills/self（22）

| Skill | 用途 |
|-------|------|
| anysearch | 统一搜索：通用 web（Tavily wrapper）+ 垂直结构化（股票/CVE/论文/专利）+ 批量并行。由原 anysearch 与 tavily-web-search 融合 |
| browser-automation | 网页/Electron 调试：截图、元素检查、UI 交互、网络监控 |
| code-harden | 代码生产就绪加固：异常分级、重试策略、失败语义 |
| code-link | 从入口点追踪调用链到所有相关文件 |
| code-overdesign-audit | 审计过度设计/投机抽象，产出可裁决的简化候选（原名 over-engineering-audit） |
| code-quality-tool | 代码质量检查、规范审查 |
| code-simplify | 简化代码、清理重复与死代码 |
| design-code-sync | 校准代码实现与设计文档一致性 |
| dev-flow | 按已审查的技术设计文档落地为可运行代码 |
| directory-lookup | ~/Code、~/GitApp、~/Stock 目录索引查找。注意：运行时读 `~/.agents/lessons/directory-index.md`，lessons 迁移前依赖旧位置 |
| pi-flow-guided | pi 三层执行流程的流程图与决策指引 |
| quota-wait | 套餐额度耗尽时挂起任务并定时接续 |
| rethink | 跳出局部修补循环的思维框架 |
| subagent-ext-config | pi-subagent-workflow 引擎路由与同步收集配置说明 |
| tech-design | 技术设计文档写作与对抗式审查（内嵌 3 个 review agent） |
| test-quality | 测试设计与分层，最大化单位时间抓 bug 价值 |
| user-memory | 记录/读取用户偏好与习惯 |
| w25-contract | 周报管理与生成 |
| web-fetch | 无 API key 网页抓取、YouTube 字幕 |
| workflow-script-format | pi workflow JS 脚本编写规范 |
| worktree-manipulate | bare repo + worktree 工作区管理唯一入口 |
| zsw-session-cleanup | zcode 引擎残留会话清理与磁盘回收 |

## skills/external（8）

| Skill | 来源 | 用途 |
|-------|------|------|
| drawio-skill | GitApp/ai-skills | 图表/流程图/架构图绘制 |
| emil-animate-designer | 收录 | emilkowalski 动效方法论路由入口，子 skill 按绝对路径引用 |
| handoff | 收录 | 会话压缩成交接文档 |
| impeccable | GitApp/ai-skills | 前端界面设计/打磨/审查 |
| improve-codebase-architecture | 收录 | 架构改进与重构机会 |
| meta-prompt-creator | chat_project/meta-prompt-skill | AI agent 提示词设计/审查 |
| teach | 收录 | 教学模式 |
| visual-explainer | 收录 | 自包含 HTML 可视化产物 |

## 不在本仓库的资产

- claude-code-tool 未安装的 38 个 skill 与 agents/ 下 9 个 agent：随 useful-dev-tools 仓库归档
- pi-session-reader、plugin-management：源头仓库原地维护（~/Code/pi-session-reader、~/Code/dsh-test）
- lessons/、guide/、AGENTS.md、custom-tools、knowledge-engine、install 体系：仍留 claude-code-tool，退役清理事后议

## 待办（第二批次）

- 安装点切换：`~/.agents/skills/` 软链从 claude-code-tool 改指本仓库
- `~/.zcode/agents/` 六个无源头文件（context-builder、oracle、researcher、reviewer、u-dev、worker）与 pi 侧三个实体 agent 建档迁入 agents/self/
- lessons/ 纳入本仓库（解除 directory-lookup 对旧位置的依赖，claude-code-tool 方可退役）
- claude-code-tool 退役归档
