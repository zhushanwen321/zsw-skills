# T2 审查循环流程

> 四席并行审查（方向审席 + 主审 / 影响面审 / 简洁审）+ 多轮修复循环（方向审 rewrite 档击穿时整循环终止回 T1）。执行体两形态：**zcode 环境优先发起 saved workflow `tech-review-loop`**（契约见 SKILL.md）；workflow 未就绪/发起失败按本文件手工路径执行（语义等价）。审查标准见 `review/rubric-design-doc.md`，agent 定义见 `agents/`。

## 产物路径约定 [MANDATORY]

- runDir 即设计包目录 `~/.agents/skill-data/tech-design/<project-slug>/<name>/`（六个章节 JSON 权威源与渲染产物 `<name>.rendered.md` 所在；审查者读渲染视图，需核对结构化字段时读章节 JSON）
- 四席报告同落当轮 `round-N[.attemptM]/`：`review-direction.md`（方向审）+ `review-<dimension>.md`（dimension = main / impact / simplicity）+ `dispositions.md`（当轮处置表）
- 重发起（direction-rejected 修完重来 / escalated 裁决后重跑）时新轮次目录带 attempt 后缀：`round-3.attempt2/`——不覆盖历史
- 终态记录 `<name>/final.json`：`{ terminated, rounds, runDir, designDoc, oneliner, reportFile, mustFixTrajectory, remaining, blocked, message }`——oneliner = 方向审席一句话判定（取末轮）；reportFile = 末轮 `round-N/review-direction.md` 路径；designDoc = 设计目录绝对路径；设计包的审查证据（dev-flow-wf 入口判据读它）
- 产物根 `~/.agents/skill-data/` 在 HOME 下天然不入 git；用户显式指定路径时以用户为准

## T2 进场门槛 [MANDATORY]

进 T2 派审前，设计文档机器项必须全绿：`node <skill 安装位置>/scripts/check-design-doc.mjs <设计目录绝对路径>`（T1 `flow/write.md` Step 6 机器自检跑同一脚本）。脚本按八条规则判定：六文件完整与枚举合法 / id 全局唯一 / 导航对齐 / 跨章节引用存在（引用字段指向的 id 必须在被引用数组中）/ 分型一致 / 产物表触发完备 / 内容形态合法（分型理由不重复前缀、文件条目括号配对）（渲染产物过期只告警不阻塞）。exit 非 0 = 未全绿——**不派审**，先回 T1 按 stdout 校验报告修对应章节 JSON、重跑脚本至 exit 0 再进 T2。输入是 md 单文件时脚本 exit 1 并输出指引（全文见 `references/design-doc-schema.md` §11），按指引处理后另行发起。骨架完整性、引用对账、导航对齐这类机器可查问题在 T1 拦截，T2 各 reviewer 不报它们。

## W1 workflow 发起（zcode 环境默认动作）

```
CreateWorkflow saved: tech-review-loop
args: { designDoc: <设计目录绝对路径（或其渲染 md 路径——workflow 内部归一为设计目录）>, projectRoot: <项目根绝对路径>, maxRounds?: 10, reviewers?: <自定义 reviewer 模板绝对路径数组，缺省用本技能 agents/ 默认四件> }
终态: converged / direction-rejected / escalated / stuck / max-rounds + setup-failure / review-failure / fix-failure（环境失败族）
```

终态处置（workflow 与手工路径同表）：

| 终态 | 主 agent 动作 |
|------|--------------|
| converged | **T2 确认点**：转述 oneliner（方向审一句话判定）+ 收敛轨迹 + 处置清单 → 默认等用户确认 → 进 T3（前期授权直接进） |
| direction-rejected | 只在方向审席判 rewrite 档（问题定义/方案主干/分型被击穿）时到达：回 T1 与用户对话重写（含 Step D 诊断期重做）；修完重新发起（attempt+1，重过四席）。patch 档发现不触发本终态——进当轮问题清单由修复者处置，循环继续 |
| escalated | 方案性意见需方向裁决——与用户对比新候选后改文档重新发起（一律停回用户裁决，不在轮内自行重跑方案对比） |
| stuck / max-rounds | 呈报残余风险矩阵，用户裁决（stuck = 连续 3 轮 must-fix 不降） |
| *-failure（环境/工具） | 读 runDir 日志排障后 resume 或重发起 |

## 手工路径 Step 1：确认审查对象

从用户/上游拿到：设计目录路径（给出的是渲染 md 路径时取其所在目录）、一句话说明（这是什么设计）。报告路径按产物约定解析；进场门槛（机器项全绿）未过先回 T1。

## 手工路径 Step 2：并行派四席 reviewer（方向审席 + 三审）

路径解析：本 skill 安装位置 = available_skills 里 `tech-design-wf` 的 `location` 字段。据此拼绝对路径：rubric = `<location>/review/rubric-design-doc.md`；原则层 = `<location>/references/principles.md`（七原则与产物表规格）。

派 `tech-design-direction-review`（task 三段式）：

```text
背景：对设计 <一句话说明> 做方向审（四席之一，与三 reviewer 同轮并行；设计包在 <设计目录绝对路径>）。
目标：
  1. read <rubric 绝对路径> 加载方向审判据（D 系列）+ <principles 绝对路径>
     加载原则层（产物表规格与触发条件——D2 攻击前提清单、D4 对账产物表都要用）
  2. read <设计目录>/<name>.rendered.md（渲染视图——审查读它；需核对产物表等
     结构化字段原文时读 <设计目录>/ 内章节 JSON，如 s2-status.json 的 artifactTables）
  3. 目标项目根：<绝对路径>——read 其 AGENTS.md（若存在）提取项目约定与架构
     事实；攻击「状态副本清单 / 上游依赖」以项目自己的架构事实为依据，不凭偏好
  4. 五大方向逐项攻击（判据 D1-D5，每项先找反例，找不到反例才判通过）：
     ① 分型：终态型有无触发依据（用户显式要求 / 修复史判定表「未修到」/
        架构级设计对象）；演进型的「为什么不需要终态视角」辩护是否被修复史
        判定表支撑
     ② 前提清单（增强版）：否定性断言逐条攻击——先枚举「谁可能在写、谁可能
        在持有」再找写者侧反例；穷举断言（「唯一 / 限于 / 全集」措辞）优先核对
        同行检索命令与命中清单——登记了的重跑对账，未登记的直接 must-fix；
        ✅ 条目抽样复核实（亲自 read 它声称的核实位置，验证核实动作真实发生）；
        ⏳ 待裁决项逐条判「是否影响方向」
     ③ 终态层（终态型）：公理逐条判「真不变量还是实现细节」（假设推翻重建，
        该陈述还必须成立吗）；差距表逐维对照现状查漏项；迁移波次查是否制造
        新差距
     ④ 产物表：触发的产物表存在且无漏行 + 行级真实性抽样（随机挑行 read
        源码验证行内容与代码一致）
     ⑤ 问题定义：§1 是现象还是根因、有无未识别的深层问题；探明手段（加
        日志/探针/先收集数据）不占设计主体；问题定义不被现状实现污染
  5. 声称「击穿 / 填表不实」前必须 read 源码取证；机制正确性/影响面/机制必要
     性留给三 reviewer（标 INFO 交接）
  6. 报告写到 <runDir>/<round-N>/review-direction.md（当轮产物目录，与三审报告同目录；R2+ 另按聚焦复审对上轮处置逐条对账并重跑穷举断言登记的检索命令）
验收：
  - 返回 structured-output { mustFix, fixScope, problems[], reconciliation[], oneliner }——fixScope = patch（全部发现属前提层/产物表/措辞级，问题定义与方案主干不动，发现进当轮问题清单由修复者处置）/ rewrite（问题定义/方案主干/分型被击穿，整循环终止）；reconciliation 与三审同契约（R1 空数组）——
    problems = 逐条问题清单，每条 { ref, title }（ref 即报告 Findings 行锚点
    review-direction#<序>；条目无 level 字段——唯一报告级别是 must-fix；条数
    须等于 mustFix）
  - 报告含 Summary + 方向判定（一句话）+ Findings 表（每行带锚点编号）；每个
    must-fix 引用 D 系列编号 + 文档位置
```

方向审席与三审同轮返回：problems 清单计数以清单为准、自报数字只做交叉校验。fixScope = rewrite（问题定义/方案主干/分型被击穿）→ 整循环终止，按终态表 direction-rejected 处理；patch 档与清单空 → 发现并入当轮问题清单，走 Step 4 修复循环（「修复方向」列是修复者的操作清单）。

**全托管模式附加声明**：task 末尾追加「全托管模式：禁止 AskUserQuestion / ask-user / 任何等待用户输入的操作；遇到决策点自行裁决，决策清单写入报告 INFO 节。」

三审（主审 / 影响面审 / 简洁审）与方向审席同一条消息并行派出（subagent 独立加载，task 内路径全部绝对路径；方向审 task 按 Step 2 模板）。**不要自己审——审查与写作分离，避免确认偏差，主 agent 不自审**。四席同轮并行、同一对账契约：方向审 patch 档发现与三审发现合并进当轮问题清单，由修复者一并处置（Step 4）；rewrite 档（问题定义/方案主干/分型被击穿）整循环终止按终态表 direction-rejected 处理。R2+ 四席均按聚焦复审（上轮处置对账 + 只审触及章节——方向审席另重跑穷举断言已登记的检索命令对账）。

```text
agent: tech-design-review
task:
  背景：对设计 <一句话说明> 做对抗式审查（已通过方向审；设计包在 <设计目录绝对路径>）。
  目标：
    1. read <rubric 绝对路径> 加载 P0 清单与分工（你只判主审条目：方案对比
       P0-7/8/9、对抗三问 P0-10/11/12、断言-红灯映射表核对 P0-27——P0-27 的
       产物规格见 <principles 绝对路径> P6）
    2. read <设计目录>/<name>.rendered.md（渲染视图——审查读它；需核对断言-红灯
       表等结构化字段原文时读 <设计目录>/ 内章节 JSON，如 s4-accept.json 的
       assertionRedlights）
    3. 目标项目根：<绝对路径>——read 其 AGENTS.md / ARCHITECTURE.md（若存在）提取
       项目约定；read 源码核实声称时以此为锚
    4. <R1：逐项对抗式审查，找反例和攻击点，声称事实错误前必须 read 源码核实；
       只报影响决策的事实错误。
       R2+（聚焦复审）：只审三件事——上轮 must-fix 修复是否成立（fixed 须实证：读了
       什么确认了什么）；修复是否引入新问题（只扫修复触及章节）；上轮处置表的登记
       不修项上下文是否被改变（结构化申报复活）。不做全面重扫，不重查已确认项。
       注入材料：上轮处置表全文 + 修订摘要 + 反例重演结果 + 修订方攻击点建议>
    5. 报告写到 <runDir>/round-N/review-main.md
  验收：
    - 返回 structured-output { report_file, must_fix, problems[], reconciliation[] }——
      problems = 逐条问题清单，每条 { ref, title }（ref 即报告小节锚点
      review-main#<序>，报告每条问题的小节标题带此锚点；条目无 level 字段——
      唯一报告级别是 must-fix；条数合计须等于 must_fix）；reconciliation = 对
      上轮处置表的逐条复核（每条 { prevId, status: fixed|not-fixed|regressed|
      escalate, evidence }，R1 返回空数组）
    - 每个 must-fix 引用 P0-N 检查项编号 + 文档位置
```

（impact / simplicity 同构，判据分工按 rubric：impact 审 P0-19/20/21（写入点穷举 / 代价量化 / 宿主不变量）；simplicity 审 P0-22/23、P1-6 机制必要性——报告名 review-impact.md / review-simplicity.md，锚点前缀随报告名（review-impact#N / review-simplicity#N）。**简洁审一律派**——agent 在报告中说明本设计是否纯文案/参数调整类、简洁审范围内零发现即可（无需跳过通道）。）

## 手工路径 Step 4：修复轮（主 agent 亲为）

1. 读三份结构化返回，合并去重（同根因跨维度表述合并）；三审 problems 清单合并落 `<runDir>/round-N/problems.json`（`{ round, problems: [...] }`，条目 `{ ref, title }`——无 level 字段）
2. 按 `flow/write.md` Step 8.1/8.2 修复全部 must-fix，不留尾巴。修复 = 编辑设计目录内章节 JSON（长文本是字段值；跨章节引用字段 gapRefs / unitRefs / axiomRefs / goalRefs / reviewNav.decisionId 与被引用数组的 id 同步更新），每轮修复后重跑 `node <skill 安装位置>/scripts/render-design-doc.mjs <设计目录>` 刷新渲染视图。每条问题处置三选一：**修复（fixed）** / **登记不修（deferred，记一句话理由）** / **归档（archived，记入章节 JSON 相应内容的待办或残留风险）**——判定存疑按修复处理（滑坡防护）
3. 产出当轮处置表 `<runDir>/round-N/dispositions.md`（每条九字段：id（D-<轮>-<序>）/ title（一句话标题）/ source（数组，逐条引用 problems.json 的 ref）/ action（fixed|deferred|archived）/ location（修订位置）/ reenactment（反例重演）/ attackHints（攻击点建议）/ affectsDecision（影响决策）/ affectsDelivery（影响交付）），并同步落 `<runDir>/round-N/dispositions.json`（结构：`{ dispositions: [...] }`，字段同 workflow 路径）
4. 处置表机器校验（与 workflow 路径同一校验器——双轨语义等价由此保证）：`node ~/.agents/skills/tech-design-wf/scripts/check-dispositions.mjs <runDir>/round-N/dispositions.json --problems <runDir>/round-N/problems.json`；exit 1 时按 stdout 校验报告（缺失 ref 清单）补正处置表后重跑，至 exit 0
5. 终态判定（机械）：三报告 must-fix==0 且上轮处置全部经复核确认（reconciliation 无 not-fixed / regressed / escalate）即终止（converged，写 final.json）；R1 三报告全 0 直接收敛，不派修复者。否则 → 下一轮聚焦复审（Step 3 的 R2+ 形态），轮次 +1
6. 停机线：maxRounds（默认 10）；连续 3 轮 must-fix 不降 → stuck 呈报用户

## 手工路径 Step 5：终态与 T2 确认

按终态处置表（见 W1 发起节）处理；converged 后写 final.json（字段见产物路径约定），进入 T2 确认点 → T3（`flow/plan.md`）。
