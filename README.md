# zsw-skills

个人 skills 与 agents 管理仓库。

[English](README.en.md) | 中文

## 仓库结构

```
skills/
  self/            原创 skill，按功能域分类
    dev-workflow/    常规开发流程（含双平台 workflow 脚本，见「workflow 双平台构建」）
    code-optimize/   代码优化
    thinking/        复杂问题
    prompting/       提示词与用语
    tools/           其他工具
  external/        收录的外部 skill
agents/
  self/            自用 agent（symlink 登记）
  external/        预留
scripts/           workflow 双平台构建与校验脚本
.archived/         已退役技能与产物归档（V1-V3 代，不入版本库，仅本机）
```

## Skills

### dev-workflow/ — 常规开发流程

| Skill | 说明 |
|-------|------|
| tech-design-v4 | 在 V3 基线（归档代）上增加质量传递：验收断言与方案机制对账、反例场景测试绑定、T2 冲突清零与 T3 引用完备检查 |
| dev-flow-v4 | 在 V3 基线（归档代）上增加三方一致性审查、D3 后候选反例审查、D4 当前版本探索与 must-fix 清零门，以及受控修复路径 |
| delivery-v4 | 在 V3 基线（归档代）上增加 schema 2 验收断言与反例场景、断言级裁决、full/recheck 双模式、统一修复循环，以及第 4 轮修复或第 11 条不同 must-fix 的 process-failed |
| tech-design-v5 | 在 V4 基线上接入 delivery-core 内核：T2 方向审重写回边至多 2 次（超限停回用户），验收复审轮预算 ≤6 |
| dev-flow-v5 | 在 V4 基线上接入 delivery-core 内核：W2 节点状态六写入点收敛为单一转移入口（attempts 修复——派发即计数、重派不清零）、D2 条目回流上限 ≤2、人工处置显式转移（node-transition manual-disposition） |
| delivery-v5 | 在 V4 基线上落地交付事务内核 delivery-core：五域转移表与静态校验（进 CI）、判定单源库（open 集/探索集/due/修复轮预算唯一实现）、事件意图提交（信封内核构造 + 写入矩阵「角色×阶段×目标域」+ domain 章，append 退役）、验收包写入防护（冻结 + open-revision + 篡改检测）、status.json 派生视图（node-project）、过程记录读侧合流（events）、定级护栏（发现域三护栏 + T2/D2 聚合改判熔断）、循环预算三档、pending-actions 待办实体、golden 任务端到端与历史回放（replay） |
| tech-design-v6 | 在 V5 基线上实施结构化交付优化（设计二至五步）：计划单源渲染承接 + 项目静态能力快照（只读探测）+ D0 编译器接管生成（dev/acceptance 分阶段）+ 逐断言引用索引与证据内容索引 + reviewer 候选定位 |
| dev-flow-v6 | 在 V5 基线上实施结构化交付优化：D0 编译器分阶段接管（exec-plan/promptFile/status 生成）、D2 审查索引定位入口、D3 证据内容索引、执行期写入方全走 JSON 单源 + 重渲染 |
| delivery-v6 | 在 V5 基线上实施结构化交付优化：验收起草前置项目能力快照（命令/资产一次探测、unknown 显式）、验收审查断言×证据×资产表自动生成、独立保证按统一证据内容索引定位原始记录 |
| symbol-watchlist | 符号词表生成与自验工具（extract-backticks.mjs）：tech-design-v5 T3 产词表、dev-flow-v5 D5 发起前自验的共享契约载体 |
| design-code-sync | 校准代码实现与设计文档的一致性 |
| architecture-clean-domain-design | 以 DDD 与六边形架构为分析视角的领域建模与架构分析：统一语言、限界上下文、聚合不变量、圈层性质判定；只做映射与登记，不输出结构改造设计 |
| workflow-authoring | 双平台 workflow 撰写与观测接入规范：单源构建结构、GUI 泳道约束、观测接入五步、检查门禁与数据落盘 |

内部模块 `dev-workflow/conformance-plane/` — 设计义务一致性控制平面（D5 v2 对账引擎的领域核；模块地图与命令见 `skills/self/dev-workflow/conformance-plane/README.md`）：

| 子目录 | 说明 |
|--------|------|
| kernel/ | 状态仓（append-only 事件 JSONL + 快照 + 单写者锁）、确定性 fold、证据哈希失效、事实 schema（全文事件词表唯一权威登记处） |
| extractors/ + checkers/ | conformance 绑定义务提取（覆盖率分母只含绑定义务）、checker registry（退出契约 0/10/20）、语义缓存、backlog 采纳闭环 |
| workspace/ + changeset/ + integration/ | 真实路径仓库清单、隔离 worktree sandbox（正式仓零写入）、多仓补丁 manifest、集成器唯一写入门径（apply 预检 + 宿主挂钩 + 两阶段提交）、文档提案裁决闭环 |
| reports/ | 四层结论派生（scriptStatus / engineOutcome / integrationOutcome / deliveryOutcome，全部从事件流 fold 计算）与五视图渲染（current/final/matrix/trajectory/ledger，落盘设计包 `<name>/v2/`） |
| migration/ | 旧 final 导入（alias + 人工映射裁决 + 四项结构校验 + 幂等重放）与按包灰度切换（cutover 标记、旧档改名归档 + tombstone 指针、Unarchived 复活通道） |

### code-optimize/ — 代码优化

| Skill | 说明 |
|-------|------|
| code-simplify | 简化代码：清理重复、死代码与本次改动 |
| code-harden | 代码生产就绪加固：异常分级、重试策略、失败语义、错误处理策略裁决 |
| code-domain-review | diff 业务逻辑正确性审查：对抗式验证意图达成、边界条件、错误路径、副作用与聚合不变量核对，内嵌 review-fix-loop 兼容 reviewer |
| code-arch-review | 单次架构走查（improve-codebase-architecture 方法论本体）：模块深浅、接缝、可测试性、依赖健康双视角，产出候选卡只审不改 |
| code-overdesign-audit | 审计过度设计与投机抽象，产出可裁决的简化候选 |
| architecture-decay-audit | 审计架构腐化：补偿机制堆积、绕弯设计等，产出可裁决的腐化清单与修复方向 |
| architecture-improve-loop | 架构改进循环：审查、修复、复审，直接落地改进候选而不止出报告 |
| test-quality | 测试设计与分层，最大化单位时间抓 bug 价值 |

### thinking/ — 复杂问题

| Skill | 说明 |
|-------|------|
| rethink | 跳出局部修补循环、从全局重新审视问题的思维框架 |

### prompting/ — 提示词与用语

| Skill | 说明 |
|-------|------|
| meta-prompt-guidance | AI agent 提示词的设计、编写与审查方法论 |
| meta-words-guidance | 用语审查：清理黑话与难懂词，附裁决词表与扫描脚本 |

### tools/ — 其他工具

| Skill | 说明 |
|-------|------|
| anysearch | 统一搜索：通用 web、新闻、URL 提取/爬取，垂直结构化检索（股票/CVE/论文/专利）与批量并行搜索 |
| browser-automation | 网页/Electron 调试：截图、元素检查、UI 交互、网络监控 |
| quota-wait | 模型套餐额度耗尽时挂起任务或设守望检查点；自带 CLI 轮询套餐额度，恢复或到点自动返回 |
| user-memory | 记录与读取用户偏好、习惯 |
| worktree-manipulate | bare repo + worktree 工作区管理唯一入口 |
| zsession-wait | 等待 / 监控另一个 zcode 会话完全停止（会话静默 + subagent / workflow / 后台 bash 全收尾）的旁观 CLI；判「停止」不判「成功」 |

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

## workflow 双平台构建

dev-workflow 系 skill 的 workflow 脚本同时维护 zcode 与 pi 两个平台的版本，以单源方式管理：

- 源：`skills/self/dev-workflow/workflows/src/`，每对脚本一个 `*.shared.ts` 单源公共体加双平台壳模板
- 产物：zcode 侧 `workflows/*.dwf.ts`，pi 侧 `workflows/pi/*.js`

`scripts/` 下的校验脚本，staged 变更涉及 workflow 源或产物时由 pre-commit（`core.hooksPath` 指向 `.githooks/`）执行：

| 脚本 | 说明 |
|------|------|
| build-workflows.mjs | 从 `workflows/src/` 构建双平台产物 |
| check-workflow-parity.mjs | zcode/pi 双平台产物对账校验 |
| check-workflow-types.mjs | 用平台 facade 声明（`wf-facade.d.ts`）对 zcode 产物跑 tsc strict |
| check-commit-contract.mjs | 提交说明结构契约校验：渲染侧与反查侧同源往返（仅 wave-executor 相关变更时触发） |

## Agents

skill 内嵌 agent 以 symlink 登记在 `agents/self/`，实体单一事实源在所属 skill 目录内，禁止复制副本进来形成双源。`agents/external/` 预留。
