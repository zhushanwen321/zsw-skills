# 设计文档 JSON 权威源 schema

> **本文件是设计文档 JSON 产物的唯一权威规格**：设计包目录结构、六个章节 JSON 的字段定义、跨章节引用规则、渲染产物地位与存量 md 设计包的处理指引。写作流程按本规格产出章节 JSON（`flow/write.md`）；机器校验按本规格判定合法性（`scripts/check-design-doc.mjs`）；阅读视图由渲染脚本从章节 JSON 生成（`scripts/render-design-doc.mjs`）。各章节「写什么 / 为什么 / 怎么写好」的语义见 `references/doc-structure.md` 五段骨架，本文在各字段填写要求中引用其语义，不重复展开。

## 1. 总则

1. **权威源 = 分章节 JSON**。设计文档 = `<name>/` 目录下六个章节 JSON；大段叙述文本（SCQA 开篇、现状描述、终态形态等）是 JSON 字段值。
2. **渲染产物非权威**。`<name>.rendered.md` 由渲染脚本生成，仅供人与审查者阅读；禁止手改渲染产物——修改一律回到章节 JSON，改完重跑渲染脚本（见 §10）。
3. **跨章节引用一律用 id 字段显式引用**，禁止用文字描述指代其他章节的条目（引用字段清单见 §9）。
4. 本 schema 保持通用：不含项目专名与本机绝对路径；示例中的路径均为格式示意。

## 2. 设计包目录结构

```
<name>/               设计包目录（<name> = 设计名，kebab-case）
  meta.json           头部元信息（分型 / P 级 / 风险分 / 人工审核导航 / 关联登记）
  s1-context.json     §1 背景目标
  s2-status.json      §2 现状与问题（问题清单 / 前提清单 / 四张产物表）
  s3-solution.json    §3 解决方案（终态 / 方案对比 / 决策 / 迁移波次）
  s4-accept.json      §4 验收（场景 / 断言-红灯 / e2e 影响面评估）
  s5-breakdown.json   §5 下一层拆分（拆分单元 / 文件改动地图）
  <name>.rendered.md  渲染产物（脚本生成，非权威，给人 / 审查者读）
```

`<name>.rendered.md` 由渲染脚本按「目录 basename + `.rendered.md`」命名并写入设计目录内，不是设计者手工维护的文件。

## 3. meta.json —— 头部元信息

对应 `references/doc-structure.md`「文档头部声明行」：设计分型、功能分级与风险分三件并列，人工审核导航位于正文之前。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| name | string | 必填 | 设计名，kebab-case，与目录名一致 |
| designType | string 枚举 | 必填 | `terminal`（终态型）/ `evolution`（演进型）。判定规则见 `flow/write.md` Step D；终态型须有触发依据，演进型须有一句「为什么不需要终态视角」的辩护 |
| typeRationale | string | 必填 | 分型依据一句话（终态型写触发依据，演进型写辩护）；不以分型名「终态型 / 演进型」开头——渲染器在「设计分型」行已带枚举前缀，理由再以分型名开头会在渲染产物中重复（机器检查规则 7 拦截） |
| priority | string 枚举 | 必填 | `P0` / `P1` / `P2` / `P3`，判定规则见 `flow/write.md` 前置「判断层性质」 |
| riskScore | number | 必填 | 风险分（整数） |
| riskRationale | string | 必填 | 风险分依据一句话 |
| reviewNav | object 数组 | 必填 | 人工审核导航，每条 A/B 级决策一行；全部 decisionId 的集合必须与 `s3-solution.json` decisions 的 id 集合完全一致（A/B 级决策不得缺导航行） |
| relatedDocs | object 数组 | 可选（默认空数组） | 关联登记清单：本设计触及、修改、推翻的项目内存量权威文档（决策记录 ADR、产品定义、领域模型等），供下游终态同步（design-code-sync）核对回写——登记了没同步 = 可立项的遗漏。纯语义登记，不强制非空（无关联时空数组，校验只查数组形态）；渲染为头部表「关联登记」行（空数组不渲染该行） |

**reviewNav 行内字段**：

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| decisionId | string | 必填 | 引用 `s3-solution.json` decisions[].id（见 §9） |
| anchor | string | 必填 | 渲染视图中的锚点（如 `§3.3`） |
| level | string 枚举 | 必填 | `A` / `B`，与被引用决策的 level 一致 |
| title | string | 必填 | 决策标题，与被引用决策的 title 一致 |
| criteria | string | 必填 | 命中的审查判据编号 |
| impact | string | 必填 | 关键影响简述（写有实质影响的维度，不写「无」） |

**relatedDocs 行内字段**：

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| path | string | 必填 | 关联文档的项目内相对路径 |
| relation | string | 必填 | 本设计与该文档的关系一句话（触及 / 修改 / 推翻了它的什么语义） |

## 4. s1-context.json —— §1 背景目标

章节语义见 `references/doc-structure.md` §1（SCQA 开篇 + 设计目标 + 范围声明）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| background | string（长文本） | 必填 | SCQA 开篇四句（情境 / 冲突 / 问题 / 答案）+ 一两段「系统是什么」，让未接触过的人建立基本认知；问题必须是验证过的真问题 |
| goals | object 数组 | 必填 | 设计目标清单，从使用者体验倒推（使用者要做到什么），不是功能清单 |
| outOfScope | string | 必填 | 显式声明的范围外内容，防止范围蔓延 |

**goals 行内字段**：

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 目标 id（建议 `GL` 前缀），被 `s4-accept.json` scenarios[].goalRefs 引用 |
| statement | string | 必填 | 目标陈述，使用者视角一句话 |

## 5. s2-status.json —— §2 现状与问题

章节语义见 `references/doc-structure.md` §2（使用者视角现状 + 端到端大流程图 + 失败模式 + 根因 + 前提清单）。四张产物表是条件触发产物（触发条件各自标注，来自 `references/principles.md` 七原则）；**未触发的表写空数组即可，不补空表行**。

### 5.1 顶层字段

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| currentBehaviour | string（长文本） | 必填 | 使用者视角的现状 + 真实例子（系统提示词 / 接口请求响应 / 界面片段），取自代码不编造 |
| flowDiagram | string（长文本） | 必填 | 端到端大流程图（ASCII）。本设计涉及的主链路从源头到终点，使用者看得懂的物理粒度——这是全文坐标系，问题点与决策都用它的环节名锚定 |
| problems | object 数组 | 必填 | 真实失败模式清单，不是想象中的；每条从症状挖到根因 |
| assumptions | object 数组 | 必填 | 前提清单（增强版，全量强制）：设计当作输入而未在本设计中论证的假设逐条列出 |
| assumptionExclusions | object 数组 | 可选（默认空数组） | 否定性断言排除记录（「无 X / 没有任何 Y」形态前提的专项产物，P5 执行步骤 2）：有否定性断言时逐条登记，无则空数组（见 §5.3b） |
| artifactTables | object | 必填 | 四张产物表（见 5.2–5.5），未触发的表为空数组 |

### 5.2 problems 行内字段

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 问题 id（建议 `PR` 前缀） |
| stage | string | 必填 | 流程环节锚定，格式「大流程 → 环节名」——与本文件 flowDiagram 的环节名同一坐标系，禁止脱离流程坐标系的机制名词叙事 |
| symptom | string | 必填 | 现象（当前实际怎么出错，最好附触发条件） |
| rootCause | string | 必填 | 根因（不是「体验差」这类表象） |

### 5.3 assumptions 行内字段

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 前提 id（建议 `AS` 前缀） |
| statement | string | 必填 | 前提陈述 |
| status | string 枚举 | 必填 | `verified`（已核实）/ `pending`（待核实） |
| evidence | string | verified 时必填 | 核实动作：读了什么位置（file:line / 探针 / 排除记录）。否定性断言（「无 X」形态）的核实范围必须覆盖全部写入方与持有方，只查读侧不算核实；statement 含「唯一 / 限于 / 全集」穷举措辞时本行须含检索命令与命中清单（穷举断言可复算；缺失时 check-design-doc.mjs 规则 8 warning + 方向审 must-fix） |
| impactIfFalse | string | 必填 | 该前提不成立时的影响 |

### 5.3b assumptionExclusions 行内字段 —— 否定性断言排除记录

否定性断言（「无 X」「没有任何 Y」形态）的专项排除记录（P5 执行步骤 2：先枚举「谁可能在写、谁可能持有」，再逐个排除留档）。渲染为 §2.4 前提清单下的「否定性断言排除记录」小节（空数组不渲染）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| assertion | string | 必填 | 被排除登记的否定性断言原文（与 assumptions 中对应条目的陈述呼应） |
| candidateWriters | string | 必填 | 候选写者 / 持有者枚举：谁可能写入或持有 X——跨包跨进程、含写者侧，先枚举再排除 |
| exclusionEvidence | string | 必填 | 逐个候选的排除依据（读了哪里、确认什么），全部排除完才允许断言成立；含「唯一 / 限于 / 全集」措辞时须含检索命令（含路径范围）与命中清单（穷举断言可复算；缺失时 check-design-doc.mjs 规则 8 warning + 方向审 must-fix） |

### 5.4 artifactTables.stateCopies —— 状态副本清单

P2 权威唯一原则的产物表（触发条件：设计涉及持久化状态、多进程或多视图共享状态、新增落盘格式）。填表三原则（通用表述，不绑技术栈）：

1. **候选位置从代码检索得出**（修改点、读取点、进程清单），检索方式按项目技术栈自行确定，禁止凭印象列举；
2. **每个候选逐个给「存在副本 / 不存在」结论**——存在副本的行 `excluded=false` 并填 sync；不存在的行 `excluded=true` 并在 exclusionNote 附一句排除依据；
3. **运行时验证条件触发**：仅当代码检索无法确定（如运行时动态生成的写入路径）或设计属高风险迁移时，执行一次代表性操作并比对前后各存储变化——代码检索能确定的不得要求跑程序。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 行 id（建议 `SC` 前缀）。一份数据可占多行——每个候选位置一行 |
| state | string | 必填 | 被枚举的核心运行态数据名 |
| location | string | 必填 | 该副本的持有位置：进程 / 模块 / 文件，具体到代码真实路径 |
| nature | string 枚举 | 必填 | `authority`（权威）/ `projection`（派生视图）/ `cache`（缓存）。每份状态必须恰好一行权威；出现两行权威、或多行互相对齐 = 多份权威，设计未完成。排除行（excluded=true）同样必填枚举值 |
| sync | string | excluded=false 时必填 | 该副本靠什么跟随权威（单读源 / 事件订阅 / 重建）；靠对齐代码维持一致的必须单独标注并给出追查结论 |
| excluded | boolean | 必填 | 该候选位置是否存在副本：false = 存在，true = 不存在（排除记录行） |
| exclusionNote | string | excluded=true 时必填 | 排除依据一句话（覆盖全部写入方的检索结论）；含「唯一 / 限于 / 全集」措辞时须含检索命令与命中清单（穷举断言可复算；缺失时 check-design-doc.mjs 规则 8 warning + 方向审 must-fix） |

### 5.5 artifactTables.signalImplications —— 信号-蕴涵表

P3 蕴涵审讯原则的产物表（触发条件：设计含基于信号变化的失效判定、缓存失效或增量同步机制）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 行 id（建议 `SI` 前缀） |
| signal | string | 必填 | 机制依赖的触发信号：mtime / 事件 / 回调 / 计数 / 超时 |
| assumedImplies | string | 必填 | 设计假设它意味着什么（机制把它当成了什么的证据） |
| actuallyImplies | string | 必填 | 顺写者与读者两侧代码核实后，信号变化实际意味着什么，附核实位置 |
| mismatch | string | 必填 | 错配形态：无 / 假阳性（信号变而目标没变）/ 假阴性（目标变而信号不变）。非「无」的行必须写处置：换信号或收窄判定 |

### 5.6 artifactTables.repairHistory —— 修复史判定表

P4 历史模式原则的产物表（触发条件：问题域有 ≥3 次修复记录，或用户表述「反复出现 / 修过多次」）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 行 id（建议 `RH` 前缀） |
| mechanism | string | 必填 | 被反复修复的问题点，写符号名与位置 |
| fixCount | number | 必填 | 全样本统计的修复次数，取证用 merge 提交的双亲 diff，不信 PR 描述 |
| oscillation | string | 必填 | 收敛后是否回摆：无 / 有（附来回翻转的提交对） |
| verdict | string 枚举 | 必填 | `asset`（资产域不动）/ `faulty`（故障密集域重构）/ `unfixed`（未修到——历次修复都没触及根因）。判定依据必须能从前三列读出；`unfixed` 直接驱动分型判为终态型 |

### 5.7 artifactTables.upstreamDeps —— 上游依赖清单

P7 上游约束原则的产物表（触发条件：设计依赖非本项目代码的运行时行为）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 行 id（建议 `UD` 前缀） |
| dependency | string | 必填 | 依赖了上游的什么行为，一句话 |
| nature | string 枚举 | 必填 | `contract`（契约级，附上游文档出处）/ `observed`（观察级）/ `bet`（押注） |
| exitCondition | string | 必填 | 押注行：失效信号与替代路径；观察级行：填「已转前提清单 #N」；契约级行填「—」 |

## 6. s3-solution.json —— §3 解决方案

章节语义见 `references/doc-structure.md` §3（终态 + 方案对比 + 关键决策与权衡；形态由设计分型决定）。**terminalForm 与 migrationWaves 仅 designType=terminal 时必填；designType=evolution 时必须为空或缺失**。

### 6.1 terminalForm（终态型必填，演进型不得有）

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| axioms | object 数组 | 终态型必填 | 公理清单（P1 产物）：每条 = 不变量陈述，不写实现细节；先立骨再谈形态 |
| targetForm | string（长文本） | 终态型必填 | 终态形态描述：结构 / 不变量 / 职责归属，从理想形态倒推；先写核心价值的最少投入形态终态，增量项随后逐项（各带独立裁决） |
| gapTable | object 数组 | 终态型必填 | 终态-现状差距表：逐域列现状与终态的差距；每条差距必须有归属波次（migrationWaves[].gapRefs） |

**axioms 行内字段**：`id`（必填，建议 `AX` 前缀）、`statement`（必填，不变量陈述 + 推导依据）。

**gapTable 行内字段**：`id`（必填，建议 `G` 前缀）、`domain`（域，必填）、`current`（现状，必填）、`target`（终态，必填）、`note`（差距说明，必填）。

### 6.2 options —— 多方案对比（或迁移路径对比）

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 方案 id（建议 `OPT` 前缀） |
| name | string | 必填 | 方案名。演进型：≥2 个候选方案；终态型：对比对象换成迁移路径，候选至少覆盖「一次到位」与「分波次」两型 |
| longTerm | string | 必填 | 长期架构合理性评估 |
| shortTerm | string | 必填 | 短期实现成本 |
| risk | string | 必填 | 风险 |
| recommended | boolean | 必填 | 是否推荐。必须给明确推荐 + 推荐理由（不是「都可以」）；终态型按差距消除的完备性与不制造新差距判定 |
| costNote | string | 必填 | 成本说明。终态型成本只呈现，不作推荐依据 |

### 6.3 decisions —— 关键决策与权衡

每条决策是固定四件套（采用 / 不采用 / 证据 / 效果），A/B 定级；终态型的决策对象换成差距-波次映射。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 决策 id（建议 `D` 前缀），被 meta.json reviewNav[].decisionId 引用 |
| title | string | 必填 | 决策标题，与 reviewNav 行的 title 一致 |
| stage | string | 必填 | 环节锚定「大流程 → 环节名」，与 s2 flowDiagram 同一坐标系 |
| level | string 枚举 | 必填 | `A`（必须逐条裁决）/ `B`（无异议即过） |
| choice | string | 必填 | 采用：选了什么、怎么工作 |
| rejected | string | 必填 | 不采用：不选什么、为什么不行；用自然句说明「不采用 X 的理由：若用 X，现状例子会变成什么样」 |
| evidence | string | 必填 | 证据：符号名 + 设计时坐标 / 先例 / 探针编号，带核实状态（已核实 / 推断须显式标注，禁止未标注的推断冒充证据） |
| gapRefs | string 数组 | 必填 | 引用本文件 terminalForm.gapTable[].id（见 §9） |
| unitRefs | string 数组 | 必填 | 引用 s5-breakdown.json units[].id（见 §9）——本决策的交付影响对应哪些拆分单元 |
| axiomRefs | string 数组 | 必填 | 引用本文件 terminalForm.axioms[].id（见 §9） |
| impact | object | 必填 | 六维度效果（本决策让哪些目标 / 场景成立），字段与含义：`architecture` 架构、`function` 功能、`complexity` 复杂度、`performance` 性能、`resource` 资源、`redline` 红线；无影响的维度可留空串 |

### 6.4 migrationWaves —— 迁移波次（终态型必填，演进型不得有）

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| id | string | 必填 | 波次 id（建议 `M` 前缀） |
| targetVersion | string | 必填 | 目标交付版本（项目存在版本化交付队列时填；没有则填「—」） |
| scope | string | 必填 | 波次内容：该期完成后系统处于什么形态（中间态边界）、消除哪条差距；每条差距必须有归属波次，每波次至少消除一条差距 |
| gapRefs | string 数组 | 必填 | 引用本文件 terminalForm.gapTable[].id（见 §9） |

## 7. s4-accept.json —— §4 验收

章节语义见 `references/doc-structure.md` §4（真实场景验证，非单测非 mock；设计阶段就定验收）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| scenarios | object 数组 | 必填 | 验证场景：真实依赖、真实数据、真实路径，不用 mock / 桩 / 假数据；按改动大小匹配投入（小改动一句话，大改动多场景）；关键负面行为也要有反向验证场景 |
| assertionRedlights | object 数组 | 条件触发 | 断言-红灯映射表（P6 产物）：设计含运行时行为断言（自清理 / 在 X 之前执行 / 不丢 / 有界）时必填；未触发写空数组 |
| e2eImpact | object | 必填 | e2e 影响面评估：受影响的既有 e2e / 真实进程测试资产清单与开发阶段需跑子集；无受影响项时 items 为空数组且 noneReason 填依据（禁止留空或省略） |

**scenarios 行内字段**：`id`（必填，建议 `V` 前缀）、`scene`（场景：谁、在什么真实上下文、做什么）、`steps`（步骤：写清三要素的操作序列）、`criteria`（通过标准：可证伪的具体结果，不写「功能正常」）、`goalRefs`（必填，引用 s1-context.json goals[].id——每个场景回溯目标；无法回溯的场景是多余的，有目标无对应场景是遗漏）。

**assertionRedlights 行内字段**：`id`（必填，建议 `RL` 前缀）、`assumption`（运行时假设）、`redlight`（假设被破坏时哪个机器检查变红：具体测试名 / CI 步骤 / 探针名）、`buildItem`（无对应检查时的补建项，有对应时填「—」）。

**e2eImpact 内字段**：`items`（数组，行内字段 `name` 受影响测试资产、`action` 需跑子集与命令）、`noneReason`（无受影响项时的依据）。

## 8. s5-breakdown.json —— §5 下一层拆分

章节语义见 `references/doc-structure.md` §5（实施路径 + 拆分清单 + 每个拆分的理由；scope = 当前层 → 紧邻下一层，不跨 2 层）。

| 字段 | 类型 | 必填 | 填写要求 |
|---|---|---|---|
| units | object 数组 | 必填 | 拆分单元清单。终态型：拆分单元 = 迁移波次（对应 6.4 的差距-波次映射），尽量让每个单元可独立验收 |
| fileMap | string（长文本） | 必填 | 文件改动地图：新增 / 改写 / 收敛哪些模块，让实施者有清单可循 |

**units 行内字段**：`id`（必填，建议 `U` 前缀，被 s3 decisions[].unitRefs 引用）、`title`（必填，单元名）、`justification`（必填，为什么这么拆——让拆分可审查）、`files`（string 数组，必填，涉及的文件路径清单；每条的说明括号须配对——全/半角各自配平，不配对的说明括号会使该文件的说明与后续条目粘连，机器检查规则 7 拦截）、`checkpoints`（string 数组，必填，待验证检查点：设计阶段无法确定、留给实施期验证的点，诚实标注）。

## 9. 跨章节引用字段

全部跨章节引用**只能用 id 显式引用**，不用文字描述。机器校验（check-design-doc.mjs 规则 4）逐项核对这些引用指向的 id 存在；修改被引用条目的 id 时，必须同步更新全部引用处。

| 引用字段 | 所在文件 | 引用目标 |
|---|---|---|
| reviewNav[].decisionId | meta.json | s3-solution.json decisions[].id |
| decisions[].gapRefs | s3-solution.json | 同文件 terminalForm.gapTable[].id |
| decisions[].unitRefs | s3-solution.json | s5-breakdown.json units[].id |
| decisions[].axiomRefs | s3-solution.json | 同文件 terminalForm.axioms[].id |
| migrationWaves[].gapRefs | s3-solution.json | 同文件 terminalForm.gapTable[].id |
| scenarios[].goalRefs | s4-accept.json | s1-context.json goals[].id |

id 规则：各数组内 id 不重复，全部 id 数组的 id 全局唯一（不同前缀如 G / U / D 各自独立编号，天然不冲突）。建议前缀见各字段表。

## 10. 渲染产物

`<name>.rendered.md` 是从六章节 JSON 拼装的阅读视图：

- **非权威**：由 `scripts/render-design-doc.mjs` 生成，禁止手改；任何修改回到章节 JSON。
- **生成命令**：`node scripts/render-design-doc.mjs <设计目录>`，输出写回设计目录内（目录 basename + `.rendered.md`）。
- **刷新时机**：每次章节 JSON 修改后、每轮审查修复后各重跑一次渲染脚本；机器校验发现渲染产物缺失或早于任一 json 的修改时间会给出过期提示（不阻塞判定）。
- **渲染幂等**：同一组章节 JSON 输入产出完全相同的渲染产物。

## 11. 存量 md 设计包

校验 / 渲染脚本对 md 文件输入输出同一段指引，原文：

> 本工具只接受分章节 JSON 设计目录（<name>/meta.json … s5-breakdown.json）；md 文件不是有效输入。存量 md 设计包继续处理请用技能 git 历史版本；新设计按 references/design-doc-schema.md 产出。
