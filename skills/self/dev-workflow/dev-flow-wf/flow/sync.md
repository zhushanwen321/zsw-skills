# D5 终态同步 — W4 design-code-sync-loop 契约与手工路径

> 把「代码实现 vs 设计文档」差距收敛到 0 must-fix 的**双向**校准循环。审查对象 = **当前 HEAD 终态全量**（不是 diff 区间——交付后的修复 commit 不在任何流水线记录里，只有全量对照能抓到）。报告落 `~/.agents/skill-data/dev-flow/<project-slug>/<name>.sync/round-N/`。

## W4 workflow 契约（zcode 环境默认动作）

```
CreateWorkflow saved: design-code-sync-loop
args: { designDoc, implPlan, projectRoot, maxRounds?, statusPath?, watchlist, rulings?, attempt?, taskId?, executionId?, sampleType? }
// statusPath = status.json 绝对路径——planner 职责②进度核对数据源；未传时降级单侧核对并在 frameworkFindings 的 note 注明
// watchlist = 符号词表绝对路径（<basename>.symbol-watchlist.json，tech-design-wf T3 产出）——机械信号步唯一扫描词源，必传：
//   缺失或 sourceFingerprints 与源文档当前内容指纹不等（词表过期/文档已改词表未重生成）= setup-failure 拒启，不允许无词表/过期词表开审
//   （不回退文档反引号抓取——该路径依赖「反引号 = 本项目符号」隐式约定，已废除）
// 发起前自验 [MANDATORY]：发起 CreateWorkflow 前先跑
//   node ~/.agents/skills/tech-design-wf/scripts/extract-backticks.mjs --check <watchlist 绝对路径>
//   stdout 必须 PASS 才发起——FAIL 时按输出分类处置后重验，PASS 才发起：
//   指纹键不可读 / 指纹不等 / 缺 sourceFingerprints = 回 T3 用绝对路径参数重产词表
//   （tech-design-wf flow/plan.md「符号词表」节——缺 sourceFingerprints 与脚本自报恢复动作一致）；
//   词表不可读或非 JSON = 先核对传入路径（文件不存在 = 回 T3 重产），JSON 结构错才手修词表结构；
//   其余结构类（缺 scan/skip 数组 / skip 元素畸形）= 修词表结构
//   （该自验与 setup 词表指纹校验同源，提前拦截免整次派发 setup-failure 空跑）
// rulings = 已裁决记录 json 绝对路径（可选）：顶层数组，元素 {id, direction: "doc-right"|"code-right", anchor, quote, source, commit?}
//   ——设计决策与开发期裁决的机器可读清单，注入 planner 与全部模块 reviewer（已答问题不得标 contested）；
//   读失败/格式畸形 = setup-failure 拒启（fail-closed：出错即拒启而非降级继续，防静默丢裁决）；未传不阻断（存量设计可后补）
// attempt = 轮次目录后缀序号（可选）：显式传 ≤ runDir 已有最大序号 = setup-failure 拒启（防覆盖历史轮次产物）；
//   省略时引擎自动取已有最大序号+1
// taskId + executionId 同时传即启用阶段事件观测（SKILL「阶段事件观测」节）：taskId = D0 分配的任务标识（全段共用），
//   executionId 建议 "D5-<发起时点短时间戳>"；不传业务照常。sampleType 可选（production 缺省 / selftest 测试执行）
终态: converged / contested / stuck + setup/planner/review/fix/retire/io-failure
```

**阶段事件观测步骤边界**（stage=D5，引擎写入；SKILL「阶段事件观测」节）：setup = 环境校验 / 三道前置硬校验（attempt 防覆盖 / 词表指纹 / 裁决记录装载）/ 矩阵初始化 / 框架对照规划（planner 失败随 setup 窗口补终态）；review = 机械信号扫描 + 并行模块审查（R1）或机械/清理对账 + 聚焦复审（R2+），round = 轮次；fix = 并行修复与组级 commit；retire = 退役判定（转清理条目回下轮修复时自然结束，converged / retire-failure 的 end 随终态统一补记）；finalize 仅在轮次耗尽兜底路径出现。

**setup 三道前置硬校验**（任一不过 = setup-failure，派发任何 reviewer 之前拒启）：① attempt 防覆盖——显式 attempt ≤ runDir 已有最大序号即拒启（防覆盖历史轮次产物）；② 词表指纹校验（watchlist 的 sourceFingerprints 与「设计文档 + impl-plan.md」当前内容 sha256 一致才放行——文档任何改动都会使指纹不等，语义强于旧反引号词集比对）——watchlist 缺失、缺指纹字段（旧版生成器产物）或指纹不等即拒启，预检结果缓存供 R1 机械步立项消费；③ 裁决记录装载——传入 rulings 时读失败或格式畸形（非顶层数组 / 元素缺 id+direction / 有效元素为 0）即拒启（fail-closed：静默丢裁决 = 已裁项被重判为争议的直接通道）。

引擎语义（两级审查拓扑 + 轮次收敛）：

```
phase 1  framework-scan（planner，1 agent）：
   输入 = 设计文档(§3 机制/§5 拆分) × 代码目录结构 × HEAD 终态 × impl-plan × 关联登记清单
   职责 = ① 框架级对照（架构/分层/数据流与设计的差异——架构漂移直接进矩阵顶层行）
          ② 模块分解 ModulePlan[]（结构化，驱动 phase 2 fan-out）
phase 2  module fan-out：modules.map(m => agent(`module-${m.id}`))——并行
   模块 reviewer：矩阵行填充 + 越权三问 + 注释口径 + findings
   （prompt 注入 impl-plan 路径——其 notes 含历轮裁决处置记录，判方向前先查——与已裁决记录块；
   planner prompt 同样注入已裁决记录块）
phase 3+ 修复循环：双向修复 → 聚焦复审 →（轮）→ 退役判定 → 终态
```

**流程排序**：机器信号（符号词表 grep 脚本步，词源 = T3 词表 watchlist）紧跟 planner 框架扫描执行立项（确定性信号先行），修复随第一轮修复组进行，语义判级归 reviewer 复核。机械条目被 fixer 核实为不该扫描的词（上游符号等）时走 exempt 豁免申报——条目转豁免终态、落 `runDir/exempted.json` 登记并随终态 exemptList 呈报主 agent 终审，不要求删改文档。

**修复分组确定性校验（reconcileGroups）**：`modules[].files` 是 LLM 自报字段，并行 fixer 组间文件相交 = 冲突——组间 files 相交传递闭包合并 + 无效组过滤 + 覆盖兜底（脚本，不信任 planner 自觉）。

## 方向语义（权威定义，勿反向）

| direction | 含义 | 修复动作 |
|-----------|------|---------|
| **doc-right** | 文档更合理（默认——设计文档过对抗审，是意图 SSOT；实现偏离默认视为漂移） | **修代码**（跑增量测试必须绿） |
| **code-right** | 代码更合理（实现期发现的文档盲区/错误，实现行为有证据确认更合理） | **修文档**（过联动自检五处：正文/数据流图/错误规格/拆分清单/验收场景） |
| **contested** | 两边有实质道理且影响公开 API / 行为语义 / 数据格式 | must-fix 级须先过升级三要件与争议仲裁（见「争议仲裁与 contested 分流」节），真开放才冻结停回用户；suggestion 级不构成争议——引擎一律强制改判 doc-right（打 contestedDefaulted 标，随终态 contestedDefaultedList 呈报） |

**must-fix 级 contested 升级三要件**（引擎机器校验，缺一 = 返回判无效回喂重派——结构化校验失败后把错误清单发回 reviewer 重派重试）：`consultedAnchors`（判争议前实际查过的锚点——本文锚点 = 原文位置引用：设计文档章节号 / 代码 file:line / 裁决记录条目 id）、`whyInsufficient`（已查锚点为何不构成答案）、`misleadScenario`（裁错方向会误导什么交付判断）。配套注入硬规则：凡设计文档或已裁决记录已明确回答的问题不得标 contested，按已裁方向给 direction，rationale 必须引用对应锚点（清单 id 或设计章节号）。

**selfCheck 口径**（2026-11-04 结构化）：selfCheck = 结构化申报 `{kind: machine-check|existence-check, command, expected, actual}`——引擎按 command 复跑做输出等值比对（前置 exit 0；失败/不等值只 WARN 不强判，聚焦复审按 WARN 线索聚焦核验），「grep 断言」式自由文本不再接受；复跑不过或无证据 = 条目回流重修，测试清单缺失如实呈现不虚构。

## 三向功能对照矩阵（审查报告主体，findings 是单元格展开）

```markdown
| # | 设计声明（§N 锚点） | 代码实现（file:line 锚点） | 判向 | 说明 |
|---|--------------------|---------------------------|------|------|
| 1 | 步骤可见性合并视图 | projection.ts:88 | 一致 | 语义核对通过 |
| 2 | §3.2 水位终态计数 | （未找到实现） | 漏实现 | design 有 code 无 |
| 3 | （设计未声明） | throttle.ts:12 节流器 | 越权实现 | → 见三问评估 |
```

**越权实现三问**（code 有 design 无时逐个过）：

1. **核心价值锚定**：该实现服务本次设计的哪条目标（回溯 §1）？说不出服务对象 = 第一疑点
2. **最小功能骨架**：摘掉它，设计目标是否仍完整达成？是 → 不在最小骨架内
3. **扩展集证据**：为未来预留且无已发生证据（第二个使用方/已发生的变化原因）？SDK/宿主已有等价面而自造一层（SDK 影子层判定）？

三档裁决（裁决权在人，agent 只报告）——机器落点：**合理** → reviewer 立一条 code-right finding（回写文档登记）进正常修复循环；**过度/存疑** → 只进矩阵行 + 候选卡，引擎拦截不进修复组（框架行入账即转；模块行 fixer 可申报 defer 拒删码）——随终态 overdesignCandidates 呈报，用户裁决后才可能产生删码动作。越权行必须附调用方证据（防幻觉）；「主 agent 抽验 ≥1 调用点」在交付汇报时对候选卡执行。

## 审查关系五条（全量保留，落点）

a. 代码 ↔ 设计文档（主对照）→ framework-scan + 模块 reviewer；b. 现实 ↔ impl-plan（进度/残留风险/变更历史反映当前）→ planner；c. impl-plan 内部一致性 → planner；d. 注释口径（测试文件头/生产文件注释 vs 当前实现）→ 模块 reviewer；e. 关联登记清单 × 存量文档同步 → planner 末项。**机械信号**：R1 内置 world.run 机械步（引擎自动提取反引号标识符批量 git grep，悬空立项 owner=mechanical；R2+ 引擎重跑机械步对账）——reviewer 模板的反引号职责是复核机械条目与补漏，不是唯一防线；行号坐标漂移不立项（符号可定位语义成立 = 无影响——核实目标是交付一致性）。

## 修复纪律（每轮）

- 所有等级（must-fix/suggestion/info）当轮修完不留尾巴；修复前重演 fix-hint，建议站不住换更稳方案并说明
- **波及扫描**：每修一处 grep 同模式实例（同类注释/测试文件头/其他文档引用点）——组内实例一并修（漂移从来不是单点）；组外文件里的同模式实例不改（并行冲突），在条目 description 标注「组外波及：<位置>」留给聚焦复审立项（下轮经组外波及标注通道回流）
- 修复组按模块分组并行（范围声明互斥 ≤5）；每组核验过即 commit（组级一笔）；subagent 禁 git 写
- **聚焦复审**（R2+）：只审上轮修复成立 + 是否引入新差距，不重查已确认项

## 争议仲裁与 contested 分流

**争议仲裁**（R1 聚合后、contested 分流前执行）：对每条 must-fix 级 contested 条目派只读仲裁 agent（不修任何文件），消解「设计已答却被误报为争议」的伪争议。返回 `{verdict, quote, quoteLocation: {source, lineStart, lineEnd}, anchorRef, reasoning}`：verdict ∈ `settled-doc-right`（文档对→修代码）/ `settled-code-right`（代码对→修文档）/ `genuinely-open`（真开放，保留争议）。默认答案 = genuinely-open（宁停勿错）：只有逐字引用设计文档/impl-plan 人读版原文（给 quoteLocation 文件与 1-based 行段）、并给出「引文说了什么→为何据此判向」完整推理链才允许 settled；settled 必须附 ≥12 字原文逐字引文（禁止转述/拼接；裁决记录只作推理依据不作引文来源），引擎按 quoteLocation 行段读原文与引文做归一化空白后的等值校验（位置错或内容不等 = 校验不过），校验不过按 genuinely-open 保留争议。仲裁返回结构化校验重试仍不合规时同样按 genuinely-open 保留（仲裁步不得成为新故障点）。改判条目打 arbiter 标随终态 `arbiterSettledList` 呈报——先修后审：改判即进修复轮，交付汇报列出供用户抽查翻案；R2+ 聚焦复审对含 arbiter 标条目复跑引文断言，引文不再逐字存在或推理链不成立 → 该条 reconciliation 填 regressed，并新立项 contested（rationale 注明 arbiter-revert 与断点位置）。

**contested 分流**（仲裁后仍真开放的 must-fix 争议）：争议条目冻结（status=frozen，待用户裁决），冻结波及范围按文件划定——与其同文件的待修条目一并冻结（status=frozen-blocked，连坐清单随终态 `contestedBlockedList` 呈报，每条 blockedBy 指向冻结它的争议条目 id）。冻结条目退出活跃集，其余条目照常进修复轮——一条争议不阻断整轮。全清（非争议条目全部修复收敛）后若仍有冻结争议，终态仍为 contested 停回用户。

## 终态处置

| 终态 | 主 agent 动作 |
|------|--------------|
| converged | 交付汇报：矩阵 + 收敛轨迹（各轮三等级计数）+ direction 分布 + contested 记录 + overdesignCandidates + 争议处置清单（arbiterSettledList / contestedDefaultedList / contestedBlockedList，空清单显式说无）+ 退役判定 |
| contested | must-fix 级方向争议逐条呈报用户裁决（此时非争议条目已全部修复收敛；连坐冻结清单 contestedBlockedList 一并呈报，裁决后随争议条目处置）。恢复动作：用户逐条裁决后把结论写入裁决记录 json（rulings：元素 {id, direction, anchor, quote, source}），携 rulings 与 resumeFrom=<上轮 runDir> 重新发起（attempt 省略由引擎自动递增，不覆盖历史）——断点续跑校验终态文档指纹（run.json docFingerprints，比对 designDoc/implPlan 内容 sha256）：一致即载入上轮 final.json 全量条目清单、按裁决把 frozen 条目重绑定方向、同文件连坐条目随争议源解除冻结，直接进修复轮（跳过 R1 全量重审，条目 id 沿用上轮不重排；上轮修复经 R2 聚焦复审判 fixed 的不再重开）；指纹不一致（设计/计划在终态后变更）= WARN 并回落常规全量模式。未携 resumeFrom 的普通重发起仍为 planner 全量重审 |
| stuck | must-fix ≥3 轮不收敛或单条 must-fix 超 2 轮 → 呈报残余差距矩阵（2026-09-26 用户裁决三 loop 统一 3 轮） |
| `*-failure`（setup/planner/review/fix/retire/io） | 按 message 恢复动作：ResumeWorkflowRun 或重新发起（attempt 省略由引擎自动递增——显式传 ≤ 已有最大序号会被拒启）。fix-failure 的 commit 被钩子拒场景已先轮内修过（门禁合规修复 fixer + 原 message 重试 ≤2 轮）——仍终态 = 修不动（真代码问题转人工）或结构化不合规，接管前先 git status 盘点已 staged 内容 |

**处置记录义务**：终态处置表任一行的处置动作与结果（含用户对 contested / overdesignCandidates 的裁决），append 一笔到 `<name>.ledger.md`——引擎终态已写入未决清单（见下方终态清单字段），主 agent 处置一项即追加记录一项；W4 终态全量另在 `runDir/final.json`（attempt 不覆盖）。

**终态清单字段**（final.json）：`contestedList`（contested 条目，待用户裁决）/ `contestedBlockedList`（连坐冻结条目，元素 {id, location, blockedBy: [争议条目 id]}，随争议一并处置）/ `arbiterSettledList`（仲裁改判条目，元素 {id, direction, quote, quoteLocation?: {source, lineStart, lineEnd}, anchorRef, reasoning}，供用户抽查翻案——quoteLocation 是引文行段锚，复审按它核对引文仍成立）/ `contestedDefaultedList`（suggestion 级 contested 被引擎强制改判 doc-right 的条目，元素 {id, location}）/ `exemptList`（符号豁免待终审）/ `delegatedList`（职责域外待重派）/ `overdesignCandidates`（过度/存疑候选卡待裁决）/ `remaining`（open 残余条目）。

**衔接**：W4 修复触及验收场景表覆盖行为时，主 agent 重跑受影响场景（局部重验，不重开整门）。

## 伴生产物退役判定（converged 时）

本设计相关产物去留：已在 `~/.agents/skill-data/` 的（设计文档/impl-plan/审查报告）合规无需处理；残留在 docs/ 的伴生产物（旧惯例 `.review*` / probe）→ 移入项目内 `.tmp/design-doc-retirement/`（引用验证：按文件名词干全仓检索，命中 = 存在引用，先产清理条目修掉引用、清零后才移动——2026-09-27 裁决后的现行为，不再有「命中即不退役」门禁；移动后反向复验悬空链接）；被整体取代的旧设计文档零外部引用 → 同目录退役。退役移动结果与依据记入 final.json 的 retirement 字段；退役目录同时写 README.md 索引（文件名/日期/依据/找回方式）。判定结果进交付汇报（退役 N / 保留 N 含依据 / 无可退役显式说）。

## 手工降级路径

workflow 未就绪时：主 agent 按「两级拓扑」手工执行——先派 1 个 planner（task = framework-scan 职责，模板 `agents/sync-planner.md`，输出模块计划文件），按计划并行派模块 reviewer（模板 `agents/sync-reviewer.md`），聚合判定矩阵，修复循环按上节纪律，全程本文件语义。差距小（设计只动一模块）时 planner 返回单模块 = 自动单 reviewer。
