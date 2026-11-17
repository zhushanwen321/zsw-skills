# T3 实施计划流程（审查收敛后）

> 输入：T2 converged 的设计文档（final.json 存在且 terminated == "converged"）。产出：**双格式 impl-plan**（`.impl-plan.md` 人读 + `.impl-plan.json` 机器）+ 并行度复审（门槛触发时）。全程不停等用户确认（阶段内动作），完成即 T3 确认点。

> **产物路径 [MANDATORY]**：`~/.agents/skill-data/tech-design/<project-slug>/<name>.impl-plan.md` 与 `.impl-plan.json`（与设计目录同级——设计文档是 `<name>/` 目录（六章节 JSON，权威源）+ `<name>.rendered.md` 渲染视图，不是单 md 文件；设计包整体在该目录，slug 与双形态寻址规则见 `skill-data-addressing.md`（`<zsw-skills 检出根>/skills/self/dev-workflow/references/skill-data-addressing.md`））。产物在 HOME 下天然不入 git。基线 = 计划文件落盘，不依赖 git 跟踪。

## 入口自检（老 dev-flow 预检门的承接）

1. **T2 证据**：`<name>/final.json` 存在且 terminated == "converged"——本 skill 产出的设计天然满足；**外部文档入口**（用户直接给一份未经本流程的设计文档）→ 先补 T2（按 `flow/review.md` 手工路径全量审查，方向审起），补审不通过停止；禁止拿未审查文档直接拆计划
2. **结构完整性**：写 impl-plan 时逐项引用四类内容的实际节——背景/目标、终态/机制、验收场景表、下一层拆分。引用填不出 = 结构缺失，停下告知用户回 T1 补文档
3. 章节映射落计划文件「0 章节映射」节（下方模板）——后续所有 subagent/编译从这拿坐标，禁止自猜编号（两代结构并存：完整版 11 节 vs 五段制，一律按实质特征定位；节号坐标 = 渲染视图 `<name>.rendered.md` 的固定编号，渲染脚本保证节号稳定）
4. **验收绑定现行性（交付体系任务 [MANDATORY]）**：设计包 meta.json `acceptanceBinding` 须仍与交付任务目录当前批准一致——跑 `node ~/.agents/skills/delivery-dev/scripts/delivery-gate.mjs evaluate --task-dir <taskDir>`，把输出（verdict.json）的 `acceptanceVersion` 与 `acceptancePackageSha256` 和 meta.json acceptanceBinding 同名字段逐项比对，任一不一致 = 验收版本或验收包已变化（重批），旧设计包绑定失效 → 停止拆计划，回 `flow/write.md` Step 0 重新影响审查（对照新版本 acceptance.json 与 increments.json 逐条比对设计包覆盖，需改动回 T1 修订并按所处阶段重走 T2/T3），更新 binding 后重进本步；binding.taskDir 与 <taskDir> 不一致 = 拿错设计包，改用其绑定任务目录下的交付任务。独立设计任务（无交付任务目录）本条不适用。下游双保险：dev-flow-dev D0 编译门（`check-exec-plan.mjs --task-dir`）对同一判据机器复算（验收包联合哈希 + 版本比对），本条在拆计划前提前拦

## 增量契约对齐（交付体系任务 [MANDATORY]）

方案包不得变更 increments.json 的增量契约（SKILL 约束段）——T3 的自由度只有「细化实施步骤与调度」。拆单元前先读交付任务目录的 `<taskDir>/increments.json`（随验收包批准冻结：items[].id / requirementIds / testCommand），逐增量核对落位：

1. **逐增量声明单元归属**：impl-plan 每单元带 `incrementId` 字段（= increments.items[].id），声明该单元实现哪个增量；同一增量可拆多单元（细化调度），每个增量至少被一个单元归属——增量被漏拆或删除会在 D0 编译门红灯（回本节补齐；确需增删增量走交付体系版本递增重批，不在本技能内改）
2. **测试命令照抄不改编**：归属单元的 testCommand 从该增量 testCommand 逐字转抄（program / args 不改写、不换「等价」命令）——执行与独立保证两侧按同一命令跑增量测试，改写即契约变更
3. **只细化调度不增删改增量**：增量条目的增删、requirementIds 调整属技能①（delivery-dev acceptance-design）职权——确需变更回 delivery-dev 递增 acceptanceVersion 重批，不在本技能顺手改
4. **机器核对**：D0 编译门对交付体系任务必跑 `node ~/.agents/skills/dev-flow-dev/scripts/check-exec-plan.mjs <exec-plan> --task-dir <taskDir>`（增量归属全覆盖、incrementId 引用存在、测试命令逐字一致，任一不符 fail-fast 回 T3 本节——见 dev-flow-dev `flow/compile.md` 步骤 3）

交付体系外的独立设计任务（无交付任务目录）本节不适用，单元不带 incrementId。

## 终态型设计：波次单元与跨版本交付

设计分型为终态型（meta.json designType=terminal，Step D 判定，见 `flow/write.md`）时，单元拆分遵循：

- **单元 = 迁移波次**：拆分单元来自设计文档终态-现状差距表经差距-波次映射的产物（每条差距必须有归属波次，每波次至少消除一条差距），不按模块另行自创拆分
- **波次标注目标交付版本**：项目存在版本化交付队列（按版本排队交付的开发管理机制）时，每波次标注其目标交付版本，形成跨版本交付队列；项目无此机制时不标注，波次按依赖顺序执行
- **跨版本四约定**：一份设计文档对应一份 impl-plan（波次跨版本不拆成多份设计、不重走设计流程）；各期共用同一设计文档与同一审查终态（final.json 只落一次，不按版本重开）；分期映射在 T3 确认点一次批准，后续版本按波次执行不逐版重过设计确认；每个版本收尾对照终态-现状差距表核对剩余项，全部清零才算设计交付完毕

## 产出模板（.impl-plan.md）

```markdown
# <名称> 实施计划
基线: <流水线起点前 HEAD hash> | 来源设计: <路径> | 日期: <date> | 版本: <tech-design-dev SKILL.md frontmatter version>
<!-- 基线 = 开始实施前的代码 HEAD，供一致性审查的 git diff <基线>..HEAD；版本 = 产出本计划的技能版本（产物溯源字段，读文件取真实值，不凭记忆写），与 .impl-plan.json 的 skillVersion 同源同值 -->
## 0 章节映射     # 四类内容 + 待验证检查点在本文档的实际位置（坐标唯一来源）
## 1 目标快照     # 摘录设计背景/目标 + Out-of-scope，逐字摘录禁止改写
## 2 单元列表
| Unit | 职责 | 范围声明（精确文件路径） | 依赖 | 隔离(plain/worktree) | 验收条款 | 决策分级 | 增量归属 |
# u-foundation 固定为共享契约根节点，初始即就绪的 DAG 根
# 增量归属 = increments.items[].id（交付体系任务逐单元必填，见「增量契约对齐」节；独立设计任务该列填「-」）
# 终态型设计：单元 = 迁移波次（来自设计文档差距-波次映射，见「终态型设计」节）
# 决策分级 = 该单元实现的设计决策中的最高审核级别（A/B，来源 = meta.json reviewNav 人工审核导航，渲染视图呈现为导航表）；无决策覆盖的单元标 B
## 3 DAG 图       # mermaid
## 4 测试与验收计划  # 测试命令从项目 AGENTS.md / package.json scripts / 项目测试策略文档（若存在，典型 docs/TEST-STRATEGY.md）真实读取；增量与全量分开列
                    # 全量段 = 改动范围 + 依赖闭包（防跨单元叠加回归），逐条标注 产物类/验证类
## 5 合理偏差登记表  # 初始空；| 偏差 | 内容与理由 | 影响面 | 处置 |
                    # 影响面 = 误导了什么/造成什么返工，写不出影响的不入表；处置 = 已接受 / 待回写设计文档 / 移交 D5 终态同步
## 6 残留风险与变更历史  # 残留风险四要素：触发条件/影响/处置/重审触发条件
```

（执行态事实源是 dev-flow-dev 的 `<name>.status.json`，由 D0 编译生成；本文件不内嵌状态表。）

### 验收计划表（§4 内，7 列）

```markdown
| # | 验收项（场景表行） | 方式(L0-L4) | 组 | 依赖 | 优化判定 | 验证资产 |
|---|--------------------|-------------|----|------|----------|----------|
| A1 | 计数口径与渲染 | L3 脚本 | 核心 | - | 可脚本化（testid 已有）；转化为 e2e 用例 | reuse: p0-counter-render |
| A2 | 体验流畅性 | L4 agent | 非核心 | A1 | 机器判不了 = 视觉形态（声明拆行条件） | - |
```

- **方式**：L0 静态规则 / L1 增量单测 / L2 全量套件 / L3 脚本端到端 / L4 agent 端到端（分层定义与铁律见 dev-flow-dev `flow/acceptance.md`——L0 未清不进 L2；L2 不绿不派任何端到端；L3 能覆盖的场景不升 L4；成本不另打分，L 级即承载）
- **组**：核心（主链路，走不通则其余验收无意义）/ 非核心
- **依赖**：默认 = 对应开发单元已提交（唯一无需说明的真实前提）；填其他依赖（另一验收项 id）必须附一句理由——功能先后或共享不可重置状态；编号顺序/顺手连跑不构成依赖
- **优化判定**：可降级（L4→L3）/ 可合并 / 可脚本化 / L0 可消化；L4 行必须声明「机器判不了的部分是什么」，声明不出 = 拆行或降级
- **e2e 影响面圈定 [MANDATORY]**：先按标题逐字检索渲染视图 `<name>.rendered.md` 的「e2e 影响面评估」子节（标题由渲染脚本固定输出，章节 JSON 对应字段 = s4-accept.json e2eImpact）——**子节不存在 → 停下来交回补文档（按 write.md Step 4 补写后重进本步），禁止按空集继承**（空集会让下游静默生成零个验证节点，全链无报错）；子节存在但清单为空且无「无受影响项（依据）」显式声明 → 同样交回。继承落清单后逐项「跑（执行时点 = 单元 committed 后 / 阶段 5，空载串行；该项由 dev-flow-dev D0 编译为 verify 节点（deps=所属 dev 单元）在 D1 内执行）/ 不跑（理由）」；有 `docs/testing/e2e-map.json` 登记表的项目与 `node scripts/select-affected-e2e.mjs --base <基线>` 输出双向对账（差异逐条披露；脚本看不见设计语义，最终清单以人工裁决为准）
- **验证资产来源判定（仅 L3 行；项目无 verification skill 时本列统一填「-」，流程零变化）**：项目 verification skill 以**项目 AGENTS.md 的显式声明为唯一来源**（SSOT 清单——项目 AGENTS.md 写明哪些技能属 verification skill）；AGENTS.md 未声明 = 该项目没有，本列填「-」并在计划备注提示项目补一行声明（**禁止**按技能目录前缀或 SKILL.md 内容特征现场探测——前缀与驱动节措辞跨项目常见，误认率最高，2026-11-04 起废除特征探测改声明制）。命中后读其覆盖矩阵（能力/场景对账表，入口见其 SKILL.md），逐 L3 行标三态：
  - `reuse: <场景 id>` —— 矩阵该功能行已是可执行剧本态，验收项语义被现成剧本覆盖；场景 id 必须真实存在于其场景清单（编造的 id 在自检第 4 条被拦）
  - `new: <一句功能定位>` —— 矩阵该行为能力条目态或无覆盖：D0 按其能力原语组装新剧本（写好跑通后入其场景库，下次交付即可 reuse）
  - `inspect-only` —— 机器判不了、写不出确定性剧本：该行改判 L4（与「方式」列联动改）
  - L4 行本列恒填「-」（inspect 语义自带）；L3 行在矩阵中查不到对应功能行 → 按 `new` 处理

**提速结论 [MANDATORY]**：表后附一段——可降级 N 项 / 可合并 N 项 / 可脚本化 N 项 / L0 静态检查清单（项目既有检查脚本逐个列出），预计节省的派发轮次。随计划一并呈现给用户备查（陈述性展示，不构成等待点）。

## 双格式产出 [MANDATORY]

`.impl-plan.json`（机器格式，dev-flow-dev D0 编译的直接输入）：

```jsonc
{
  "name": "<name>",
  "designDoc": "~/.agents/skill-data/tech-design/<project-slug>/<name>",
  "baseline": "<git rev-parse HEAD>",
  "skillVersion": "<tech-design-dev SKILL.md frontmatter version>",
  "sectionMap": { "goal": "§N", "mechanism": "§N", "acceptance": "§N", "breakdown": "§N" },
  "units": [
    { "id": "u-foundation", "responsibility": "…", "territory": ["…"],
      "deps": [], "isolation": "plain", "acceptance": ["条款…"], "decisionTier": "A",
      "incrementId": "<increments.items[].id——交付体系任务必填（D0 编译门核对归属与测试命令一致），独立设计任务省略>" }
  ],
  "testPlan": { "incremental": "…", "fullSuite": "…" },
  "acceptancePlan": [
    { "id": "A1", "item": "…", "level": "L3", "group": "core", "deps": [], "optimization": "…", "verifyAsset": "reuse:p0-counter-render" }
    // verifyAsset 与表格「验证资产」列同源：reuse:<场景id> / new / inspect-only（表格列值落 json 时冒号后去空格，如「reuse: p0-x」→「reuse:p0-x」）；项目无 verification skill 时缺省 "-"（可省略字段）
  ],
  "notes": []
}
```

**一致性校验（写完即跑，D0 也会复跑）**：单元数 / 单元 id 集 / 依赖边数 / 验收项 id 集——markdown 与 json 两边一致，不一致 fail-fast 当场修（双格式漂移零容忍）。

## 符号词表 [MANDATORY]

设计文档（含 impl-plan.md）会被下游 design-code-sync 的机械扫描消费：扫描器**只读本节产出的词表**、不自行抓取反引号词——哪些词该扫由本节的语义分析裁决，扫描器与文档作者之间无隐式形态约定。下游 design-code-sync-v2 引擎已直接消费设计目录与渲染视图（六章节设计包直接发起 D5，无需转换）。本节按现行词表协议产出不变。

1. **抓草稿**：cd 到设计包目录（`~/.agents/skill-data/tech-design/<project-slug>/`）后 `node ~/.agents/skills/symbol-watchlist/scripts/extract-backticks.mjs <name>/<name>.rendered.md <name>.impl-plan.md`（脚本属 symbol-watchlist skill；传参形态不限——相对 / `~/` / 绝对均归一为绝对路径键，推荐 cd 后相对传参调用串短。stdout = JSON 对象：`sourceFingerprints`（各输入文件的 sha256 指纹，键 = 入参归一后的绝对路径——传参形态不限，`~/` 与相对路径入参均被脚本归一，键形态以脚本输出为准）/ `words`（提取词数组）/ `dropped`（被过滤词与剔除规则，漏报可审计）；提取规则与扫描器逐字同源，勿手抄手补。输入取渲染视图而非章节 JSON：渲染视图格式由渲染脚本固定生成，反引号提取稳定；章节 JSON 的一堆字段名 / 枚举值不是「文档里反引号包裹的符号」语义，进入词表只会制造 skip 噪音）
2. **语义甄别**：对照设计文档逐词判定——`scan` = 本项目代码里可定位、悬空时应被揪出的符号；`skip` = 其余一切（外部/上游包符号、shell 命令、协议词、JSON 字段名、纯排版标注……），每个 skip 词必须带一句理由（典型：「上游包符号，非本项目代码」「命令行示例」）。拿不准的词归 skip——漏扫的代价由下游 LLM 语义审查兜底，误扫的代价是下游误报死循环
3. **落盘**：`~/.agents/skill-data/tech-design/<project-slug>/<name>.symbol-watchlist.json`（与设计目录同级），格式：

```jsonc
{
  "designDoc": "~/.agents/skill-data/tech-design/<project-slug>/<name>",
  "sourceFingerprints": {
    "<HOME 展开的绝对路径>/.agents/skill-data/tech-design/<project-slug>/<name>/<name>.rendered.md": "<sha256，抄自草稿输出>",
    "<HOME 展开的绝对路径>/.agents/skill-data/tech-design/<project-slug>/<name>.impl-plan.md": "<sha256>"
  },
  "scan": ["exitPlanMode", "u-foundation"],
  "skip": [{ "word": "executeToolCallsSequential", "reason": "上游包符号，非本项目代码" }]
}
```

键形态以脚本输出为准（已归一为绝对路径），勿手写或改动键——下游 setup 引擎对键做直读，相对或 `~/` 形态的键会 ENOENT。

**一致性（指纹制）**：词表的 `sourceFingerprints` 必须与两份输入文档的当前内容指纹一致——design-code-sync 发起时机器复验（文档任何改动都会使指纹不等，比旧「反引号词集等集」更严），不等即拒启并呈报「源文档已改而词表未重生成，回 T3 重产」。文档在本节之后有改动 → 重跑本节（脚本 + 甄别合计分钟级）。

## 计划自检 [MANDATORY]

对着 DAG 与单元表自检，通过即落盘，不停等用户：

1. 切分粒度：无跨范围声明耦合、无空转单元、依赖方向与 DAG 一致；依赖只写「编译依赖 / 运行时读对方产物」，其他理由（测试可跑、想先验一把）删掉或写真实理由
2. worktree 标记符合判据（见 dev-flow-dev `references/dag-authoring.md` 隔离决策表）
3. 验收条款无遗漏：每单元至少一条可机械核验条款；设计验收场景表每行落到某单元验收条款**且出现在验收计划表**
4. 验收计划表自洽：核心组覆盖主链路；依赖列无环，非默认依赖带理由；verifyAsset = `reuse:` 的场景 id 在项目 verification skill 的场景清单中实际存在（读清单核对，防编造 id 把雷埋到 D3 启动）
5. e2e 影响面圈定无悬空：设计「e2e 影响面评估」子节存在且非空（或含显式「无受影响项（依据）」）——缺节/空集须已交回 T1 补写，禁止空集通过自检；每项落到验收计划表或「不跑（理由）」
6. 决策分级列无遗漏：每单元已标注其实现决策的最高审核级别（来源 = meta.json reviewNav 人工审核导航），A 级决策至少被一个单元覆盖
7. 终态型波次覆盖（终态型设计必查）：终态-现状差距表每条差距有归属波次单元；标注目标交付版本的波次版本齐全；波次间中间态边界（s3-solution.json migrationWaves 波次内容 scope 声明的进入/退出形态）在依赖列或单元职责中可见

仅当出现无法机械判定的歧义（范围声明必须重叠 / 设计自相矛盾）才停下问用户。

## 并行度复审（门槛触发，落盘前）

触发门槛：实现链关键路径深度 ≥3 或单元数 ≥4（门槛内小计划不派——零收益）。派 `~/.agents/skills/dev-flow-dev/agents/parallelism-reviewer.md`（zcode 环境按 subagent_type 派发；无注册机制环境用 general-purpose + 内嵌 agent 文件全文）；task 附 impl-plan 双格式 + 设计文档 + 项目根三绝对路径；报告落 `~/.agents/skill-data/tech-design/<project-slug>/<name>.plan-review.md`。reviewer 只报告——主 agent 逐条裁决（采纳即改计划并重跑自检；不采纳记理由），裁决记入 json 的 notes。头两个使用并行度复审的项目交付后回看其产出：连续零 finding 则降级为自检清单条目、砍掉派发（流程环节要能证明收益）。

## 落盘与 T3 确认

Write 双格式文件 + 一致性校验通过 = 落盘完成（不 commit）。呈现 DAG/单元表/验收计划表 + 自检与复审结论——**单元表按决策分级分组呈现（A 级单元在前列出，B 级紧随其后一行一条）**，默认等用户确认拆分与验收计划 → 授权后设计包交付，进入 dev-flow-dev（D0 编译）。
