# impl-plan 字段无损映射（md 节 ↔ JSON 字段路径）

> 本表是实施计划产物「哪个 Markdown 元素由哪个 JSON 字段渲染」的终态对照。权威规则：**`.impl-plan.json` 是唯一计划权威，`.impl-plan.md` 是渲染器生成的阅读视图（禁手改）**；渲染器 = `scripts/render-impl-plan.mjs`（同目录），一致性判据 = 重新渲染逐字节一致（`--check`）。T3 初产、D2 合理偏差回流、D4 档案分流、D5 终态同步一律改 JSON 后重跑渲染器。字段语义判据（拆分粒度、验收完整性等）见 `flow/plan.md`，本表只管字段落点与渲染规则。

## 1. 字段总表

必填性分两档：**必填** = 缺失时渲染器报语义缺口（列出缺失字段路径，不猜测渲染）；**可省略** = 缺省按空形态渲染（空表 / —）。类型列中 `string|{program,args}` 的两种形态都接受，渲染为展示命令串。

### 1.1 现行字段（原有 schema，不变）

| JSON 字段路径 | 类型 | 必填性 | 渲染落点 |
|---|---|---|---|
| `name` | string | 必填 | 头部标题 |
| `designDoc` | string | 必填 | 头部「来源设计」 |
| `baseline` | string | 必填 | 头部「基线」 |
| `skillVersion` | string | 必填 | 头部「版本」 |
| `sectionMap` | object，必含 `goal` / `mechanism` / `acceptance` / `breakdown` 四键 | 必填（四键逐键必填） | §0 表前四行；扩展键（如「决策分级来源」「验收契约」）按 JSON 键序逐行追加 |
| `units[]` | array | 必填（数组本身） | §2 单元表 |
| `units[].id` / `.responsibility` / `.territory[]` / `.deps[]` / `.isolation` / `.acceptance[]` / `.decisionTier` | — | 必填（逐单元） | §2 各列 |
| `units[].incrementId` | string | 可省略（独立设计任务省略） | §2「增量归属」列；缺省渲染「—（不归属增量）」 |
| `testPlan` | object | 必填（对象本身） | §4 |
| `testPlan.fullSuite` | string\|{program,args} | 必填 | §4.2 全量命令 |
| `testPlan.incremental` | string | 可省略 | §4.1 文字段（无 incrementalCommands 表时是该节唯一内容） |
| `testPlan.artifacts[]` | array（`{id, command}`，command 形态同 fullSuite） | 可省略（字段存在时逐条 `id` / `command` 必填） | §4.2 产物类条目列表（`fullSuiteChecks[]` 缺场时的兜底渲染；Gate A / exec-plan 消费的产物类子集，其消费方与消费内容不变） |
| `testPlan.artifacts[].id` / `.command` | — | 逐条目必填（字段存在时） | 同上 |
| `acceptancePlan[]` | array | 必填（数组本身） | §4.3 验收计划表 |
| `acceptancePlan[].id` / `.item` / `.level` / `.group` / `.deps[]` / `.optimization` | — | 必填（逐条） | §4.3 各列 |
| `acceptancePlan[].verifyAsset` | string（`reuse:<id>` / `new` / `inspect-only` / `-`） | 可省略（缺省 `-`） | §4.3「验证资产」列 |
| `acceptancePlan[].adversarialFormRefs[]` | string[]（adversarialForm id） | 可省略 | **JSON-only，不进渲染视图**（V5 反例场景认领：D3 节点携带同一引用、delivery-v6 check-quality-contract 判定认领完整性；视图侧对账陈述走 §1.2 `adversarialClaim`） |
| `associations[]` | array | 可省略 | **JSON-only，不进渲染视图**（D0 编译逐字转抄进 exec-plan） |
| `notes[]` | string | 可省略 | **JSON-only，不进渲染视图**（历轮裁决处置记录，sync-reviewer / D5 消费） |

### 1.2 additive 可选字段（Markdown 独有内容的 JSON 权威落点）

全部可省略；写计划时建议 T3 初产即建（空登记写空数组，保持结构显式）。命名沿用盘上既有惯例（`reasonableDeviations` 已在存量 impl-plan.json 使用）。

| JSON 字段路径 | 类型 | 渲染落点 |
|---|---|---|
| `date` | string（YYYY-MM-DD） | 头部「日期」；缺省渲染「—」 |
| `headerNote[]` | string[] | 头部说明引文的计划特有行（基线 / 版本含义的固定说明由渲染器固定输出，不占本字段） |
| `goalSnapshot` | object `{problem, goals[], outOfScope}`（goals 逐字摘录自设计文档，禁止改写） | §1 目标快照三个小节 |
| `unitsNotes[]` | string[] | §2 表后附注段（波次覆盖对账、决策覆盖对账等自检陈述） |
| `units[].depReasons` | object（键 = 依赖单元 id，值 = 依赖理由） | §2「依赖」列括注：`<依赖id>（<理由>）`。盘上既有 impl-plan.json 数据先例，本次首次写入 flow/plan.md 模板与本表（此前只在个别盘上数据中出现、未入模板） |
| `units[].kind` | string（唯一登记值 `contract-spike`） | §2 单元表「Unit」列后缀标注：`<id>（契约 spike）`；缺省无标注。契约 spike 单元 = 外部契约任务（验收含 externalContracts）必有、DAG 唯一根、全部业务单元经 deps 依赖它——撰写要求与 DAG 判据见 `flow/plan.md`「外部契约任务」节；D0 编译侧对该字段的拓扑复算归 dev-flow-v6 `flow/compile.md`（本表只登记 impl-plan 侧字段与渲染落点，不复列编译侧语义） |
| `units[].cwd` | string（绝对路径，仅 `isolation=worktree` 单元） | **不进渲染视图的列**（§2 八列不含 cwd），登记为渲染期弱校验输入：headerNote 点名绝对路径根的 cwd 声明须与各单元 cwd 的包含关系一致（不一致 = 渲染器语义缺口）。**路径基准判据**：cwd = 该单元执行所在 git 检出根的绝对路径；`territory` 条目相对**该 cwd 所在仓库根**（不是固定相对 projectRoot）；跨仓 worktree 的 cwd 指向另一仓库根是合法值（引擎启动断言只要求 cwd 是该检出的仓库根）。plain 单元不接受 cwd（固定在工作仓库根运行；D0 编译器对 plain 携带非 projectRoot cwd 报缺口），确需跨仓/隔离执行时把 isolation 改为 worktree 并保留 cwd |
| `dagNote` | object `{nodeLabels{<unitId>:<label>}, criticalPath, parallelWindows[], edgeReasons[{edge, reason}]}` | §3：mermaid 本体从 `units`（节点）+ `deps`（边）确定性推导，`nodeLabels` 覆盖默认节点标注；`criticalPath` 渲染为一段；`parallelWindows` 渲染为列表；`edgeReasons` 渲染为边因表 |
| `testPlan.incrementalCommands[]` | array（`{incrementId, unitIds[], command, timeoutMs?}`） | §4.1 增量测试命令表 |
| `testPlan.fullSuiteChecks[]` | array（`{id, command, kind, note?}`，kind = 产物类\|验证类） | §4.2 逐条检查清单（渲染权威）：在场时该节按它逐条渲染（`- [<kind>] <id>：<command>（<note>）`），恢复 md 逐条标注产物类/验证类形态；与 `testPlan.artifacts[]` 的关系——artifacts 是 Gate A / exec-plan 消费的产物类子集（结构化承载，其消费方与消费内容不变），fullSuiteChecks 是 §4.2 视图权威；fullSuiteChecks 在场时 artifacts 不重复渲染，缺场时 artifacts 兜底渲染产物类条目 |
| `testPlan.fullSuiteNote[]` | string[] | §4.2 全量段范围说明列表 |
| `acceptancePlanIntro` | string | §4.3 表前说明段（验证资产来源判定结论等） |
| `adversarialClaim` | string | §4.3 表后 adversarialForm 认领对账陈述 |
| `e2eImpactScreening[]` | string[] | §4.4 e2e 影响面圈定结论 |
| `speedupNote[]` | string[] | §4.5 提速结论（内容完备性是 T3 [MANDATORY] 自检判据，渲染器不拦——见 §3 语义缺口判据） |
| `reasonableDeviations[]` | array（`{id, title, content, impact, disposition}`） | §5 合理偏差登记表（四列 = id+标题 / 内容与理由 / 影响面 / 处置） |
| `residualRisks[]` | array（`{id, title, trigger, impact, disposition, reexamine}`） | §6 残留风险表（五列 = id+标题 / 触发条件 / 影响 / 处置 / 重审触发条件） |
| `changeHistory[]` | array（`{id, note, summary}`） | §6 变更历史列表：`- <id>（<note>）：<summary>` |

## 2. md 节 ↔ JSON 对照（渲染器输出节序固定 0—6）

### 头部

| md 元素 | JSON 权威落点 | 说明 |
|---|---|---|
| `# <名称> 实施计划` | `name` | |
| `基线: … \| 来源设计: … \| 日期: … \| 版本: …` | `baseline` / `designDoc` / `date` / `skillVersion` | 日期缺省「—」 |
| 基线 / 版本含义说明引文 | 渲染器固定文案 | 视图格式的一部分，不占字段 |
| 计划特有说明行（修订指针等） | `headerNote[]` | 每条一行引文 |
| 首行生成器元数据注释（生成器版本 + 输入 sha256 + 重新生成命令） | 渲染器自动写 | 观测性元数据，`--check` 比较时剔除、不参与内容等价 |

### 0 章节映射 → §0 表

`sectionMap` 四键渲染为固定四行（背景 / 目标、终态 / 机制、验收场景表、下一层拆分）；扩展键按 JSON 键序逐行追加——键名即「内容类」列，值即「设计文档实际节」列。坐标语义（渲染视图固定节号）判据见 `flow/plan.md` 入口自检。

### 1 目标快照 → `goalSnapshot`

`problem` 渲染为「问题一句话」段；`goals[]` 逐条渲染为列表（逐字摘录）；`outOfScope` 渲染为「范围外」段。字段可省略，缺省各渲染「—」。

### 2 单元列表 → `units[]`

八列固定：Unit / 职责 / 范围声明（精确文件路径）/ 依赖 / 隔离 / 验收条款 / 决策分级 / 增量归属。依赖列 = `deps` 逐个渲染，`depReasons` 有登记时括注理由；范围声明列 = `territory` 顿号连接（territory 条目相对**该单元 cwd 所在仓库根**——worktree 单元的 cwd 是其 worktree 检出根，跨仓 worktree 指向另一仓库根合法；见 §1.2 `units[].cwd` 行）；验收条款列 = `acceptance` 顿号连接。Unit 列 = `id`，`kind=contract-spike` 的单元渲染为 `<id>（契约 spike）` 后缀标注（契约 spike 单元的撰写要求与 DAG 判据见 `flow/plan.md`「外部契约任务」节）。表后 `unitsNotes[]` 逐条一段。列语义判据（隔离形态、决策分级来源）见 `flow/plan.md`，渲染器不校验取值。

### 3 DAG 图 → `units[]` 派生 + `dagNote`

mermaid 本体确定性推导：节点 = `units[].id`（默认标注 = id；`incrementId` 存在时第二行标注增量 id；`dagNote.nodeLabels` 有登记时整条覆盖），边 = `deps`。手写 mermaid 的自定义别名与自由排版不做等价保留——拓扑事实全部来自 JSON。其后依次渲染 `dagNote.criticalPath`（一段）、`dagNote.parallelWindows`（列表）、`dagNote.edgeReasons`（边因表：边 / 理由）。`dagNote` 整体可省略。

### 4 测试与验收计划 → `testPlan` + `acceptancePlan`

| 子节 | JSON 权威落点 | 渲染规则 |
|---|---|---|
| 4.1 增量测试命令 | `testPlan.incrementalCommands[]` + `testPlan.incremental` | 有 `incrementalCommands` 渲染四列表（增量 / 归属单元 / testCommand 逐字 / 超时）；否则 `incremental` 渲染为文字段；两者皆缺渲染「—」 |
| 4.2 全量套件 | `testPlan.fullSuite` + `testPlan.fullSuiteChecks[]`（缺场兜底 `testPlan.artifacts[]`）+ `testPlan.fullSuiteNote[]` | 命令渲染为展示串（`{program,args}` 展平；转抄仍以 JSON 字段为准，展示串不是转抄源）；`fullSuiteChecks` 在场逐条渲染（产物类/验证类标注 + note），缺场时 `artifacts` 兜底渲染产物类条目；说明列表逐条渲染 |
| 4.3 验收计划表 | `acceptancePlanIntro` + `acceptancePlan[]` + `adversarialClaim` | 七列固定：# / 验收项（场景表行）/ 方式 / 组 / 依赖 / 优化判定 / 验证资产；`verifyAsset` 缺省「-」；表前后说明段可省略 |
| 4.4 e2e 影响面圈定 | `e2eImpactScreening[]` | 逐条列表；缺省「—」 |
| 4.5 提速结论 | `speedupNote[]` | 逐条列表；缺省「—」。内容完备性归 T3 计划自检（[MANDATORY]），渲染器不拦 |

### 5 合理偏差登记表 → `reasonableDeviations[]`

四列固定：偏差（`<id>. <title>`）/ 内容与理由（`content`）/ 影响面（`impact`）/ 处置（`disposition`）。空缺省渲染「（暂无登记）」。写入方：T3 初产、D2 一致性审查 reasonable 项回流、D4 档案分流。

### 6 残留风险与变更历史 → `residualRisks[]` + `changeHistory[]`

残留风险五列固定：残留风险（`<id>. <title>`）/ 触发条件 / 影响 / 处置 / 重审触发条件；其后「变更历史：」列表逐条渲染。两个数组分别可省略，空缺省渲染「（暂无登记）」。写入方：D4 档案分流（ledger 残留风险与决策处置）、D5 终态同步、D6 交付后审查结论回写。

## 3. 语义缺口判据

渲染器拦截（exit 1，错误消息 = 哪个输入不合法 → 权威源 → 恢复命令）：

1. **字段缺口**：§1.1 必填清单中任一路径缺失（含逐单元 / 逐条目必填列）——错误消息列出全部缺失路径；不猜测渲染。
2. **JSON 不合法**：文件不存在、解析失败。
3. **渲染不一致**（`--check`）：盘上 `.impl-plan.md` 与重新渲染结果不一致（剔除头部元数据注释后逐字节比较）——md 被手改，或 JSON 修改后未重渲染；恢复动作 = 重跑无 `--check` 的渲染命令。
4. **渲染视图缺失**（`--check`）：`.impl-plan.md` 不存在；恢复动作同上。
5. **cwd 声明弱一致性**：`headerNote[]` 中含 cwd / 工作树 / 检出根字样且点名绝对路径根的注记，与 `units[].cwd` 的包含关系矛盾（或声明了路径根但无任何单元声明 cwd）——错误消息列出冲突单元与路径根；恢复 = 以权威事实改 JSON 一侧后重渲染。只覆盖点名路径的声明，未点名路径的注记不解读自然语言语义（弱校验，不是完整 cwd 语义门）。

渲染器不拦（语义判据归专门门，避免一台机器两套判据）：提速结论与验收计划表的内容完备性（T3 计划自检）、验收条款 / adversarialForm 认领完整性（T3 自检 + delivery-v6 check-quality-contract）、territory 互斥 / 增量契约 / DAG 环（dev-flow-v6 D0 `check-exec-plan.mjs` 门）、单元 id 与设计包对应关系（D0 章节映射核对：sectionMap 指向的设计文档节实际存在）。

## 4. 写入纪律

| 写入方 | 动作 |
|---|---|
| T3 初产 / 修订 | 写 `.impl-plan.json` 全部字段 → 跑渲染器生成 `.impl-plan.md` → `--check` 自证绿 |
| D2 一致性审查 reasonable 项回流 | 写 `reasonableDeviations[]`（必要时 `notes[]`）→ 重跑渲染器 |
| D1 单元偏离申报的测试绑定落实（acceptancePlan 测试绑定） | 改 `acceptancePlan[]` / 设计包 s4-accept.json → 重跑渲染器（impl-plan 侧） |
| D4 档案分流 | 写 `reasonableDeviations[]` / `residualRisks[]` / `changeHistory[]` → 重跑渲染器 |
| D5 终态同步 / D6 交付后审查回写 | 写 `residualRisks[]` / `changeHistory[]` / `reasonableDeviations[]` → 重跑渲染器 |
| 任何执行方 | 禁止手改 `.impl-plan.md`——发现不一致按 §3 第 3 条恢复，禁止反向手改 md 迁就现状 |

## 编译消费的 additive 字段（指针）

impl-plan 被 D0 编译器消费的 additive 可选字段（testPlan.incrementalCommands / units[].designRef / units[].cwd / processReviews[] / acceptancePlan[].script·runner·scenario·unit·artifactsDir 等，含缺失后果）唯一权威登记处 = dev-flow-v6 `flow/compile.md`「impl-plan 编译消费字段」表与 compile-exec-plan.mjs 头注——本表不复列（防双源漂移）。
