# 目标与验收文件（acceptance.json / increments.json）

acceptance.json 回答「这个任务要做到什么、做到什么样算做对」；它独立于「怎么做」——方案可以换，验收不跟着方案改。increments.json 是验收包的组成部分（增量×需求×测试命令），与 acceptance.json 一起被验收包哈希联合绑定：改任一文件的规范内容，包哈希即变，既有审查与批准全部失效。

## 写作要求

- `objective` 一句话说清任务目标（用户可观察的结果，不是实现方式）。
- 每条 requirement 的 `statement` 必须外部可观察、可证伪：「关闭后零写入」可以设计实验证伪；「架构优雅」不允许。
- `required=false` 的需求不阻终态，但 failed 会在 verdict 中披露。
- `riskAcceptable=false` 表示该条不满足时不允许「用户接受风险后照样交付」——只能修复或递增版本改验收。
- `evidenceKinds` 声明该条 requirement 需要哪几类证据（command / scenario / inspection；词表可经策略包扩展）——它是 requirement 级字段，禁止写入 assertion（assertion 的 exact-keys 校验会拒该键）。每类证据独立判定，全部 verified 才算通过。
- schema 2 的每个 requirement 必须有 assertions[]：每条断言写 id/statement/qualifiers/given/when/then/adversarialFormRefs/testAssetRefs，只描述一个可观察行为；可选 qualifierNotApplicable[]（每条 { qualifier, rationale }）为无法构造反例的限定条件登记不适用理由，带理由的限定条件豁免「每个限定条件有反例场景」要求；可选 dependsOn（{ incrementIds, mechanismRefs, testAssetRefs }）声明该断言依赖的实现增量与机制条款，供修复轮机器推导受影响断言；可选 requiredEnvironment（{ kind: "official-runner" | "real-host", capability? }）声明宿主环境要求——`official-runner` 用于证明官方命令解析、注册与事件语义，需要完整用户交互或进程行为的断言要求 `real-host`，缺省不限制。环境要求属验收契约：变更递增 acceptanceVersion。gate 对宿主类断言核对证据 artifact 的 environment 元数据（gate 核对 kind、capability 与 source；name/version/sourceHash/driver 登记不核，见 state-and-events.md），证据环境不满足要求时最多 partial/unknown、不得 verified；模拟环境不能独立证明宿主契约。顶层 adversarialForms[] 逐条写 assertionId/qualifier/entryPoint/initialState/operation/timing/expected/testAssetRefs/rationale。每个限定条件有反例场景或不适用理由，断言与场景双向引用一致；全局不变量覆盖全部相关写入入口和等待点（允许记录不适用理由）。schema 1 存量任务保持需求级判定。
- `nonGoals` 与需求同等重要：防止验收范围被悄悄扩大或缩小。acceptance.json 必填顶层字段：objective、nonGoals（字符串数组）、riskLevel（low|medium|high）、exploratoryReview（not-required|required）、reviewDimensions（required 时至少一项非空且去重）、requirements；缺任一字段 validate-acceptance 直接拒绝。
- 检测与分流类功能（detector / router / classifier / 检索 / 分流）的断言必须包含正、负信号场景且行为不同：恒 true、恒 false 或空变量集只能登记为未实现或残余风险，不能按差异化行为已经实现处理。机器层只做词面初筛（validate-acceptance 对含检测/分流关键词的需求组无否定性场景标记时记 warning，不拒写入——词面有误伤率），硬判定由验收审查者语义裁决：要求补正负场景对照，或书面论证不适用。
- 自动后台、检索、长期驻留类功能的验收设计必须把产品自身运行成本纳入判据：空内容回合是否调模型 / 重复事件是否重复调用 / 每回合调用次数与等待上界 / 注入条数与无关内容占比 / 长期存储增长及整理触发条件。产品运行成本必须通过产品自身的调用计数与行为证据测量，不能用开发会话 token 推断。没有预算或成本要求时，把该取舍呈报用户确认，「默认遗漏」不允许。
- 高风险目标鼓励实际构造反例输入（推荐档判别力验证）：验收设计时为高风险目标在 testAssetRefs 指向的验证资产中登记反例输入构造要求，后续 builder 实现与 assurance 取证按资产实际构造反例输入、证明判据会拒绝错误实现，产物进各自 artifact 目录。轻量档（审查者书面列出反例）是底线要求，推荐档是鼓励项不强制。推荐档当前落点的取舍依据：实际构造反例需要成熟的验证资产支撑，轻量档先行、验证资产成熟后升级推荐档（设计 §5.2 取舍）。风险最小场景集（宿主集成 / 检索与注入 / 自动后台 / 检测与分流 / 持久状态 / 项目隔离六类）当前落点为 golden 任务层（`scripts/tests/delivery-golden-v6.test.mjs`），验收入口接入待实跑校准（设计 §5.3 取舍）。
- 高风险（riskLevel=high）必须标注探索性审查（exploratoryReview=required）且至少一个 reviewDimensions。该字段是披露要求而非探索门控：schema 2 的候选反例审查与 full 开放式探索对全部任务可达——full 探索按「缺少候选探索证据、验收或关键设计变化」触发，中低风险任务不因此跳过探索路径。任务分级为 a（deliveryProfile=a）且验收含外部契约时，reviewDimensions 收窄为契约与故障两类。
- 修订已有验收必须递增 acceptanceVersion 并重新审查与批准；旧版本上的批准与证据自动失效（保留审计）。
- 交付物依赖外部系统（真实宿主 / 官方运行器 / 外部 SDK）时，验收包另登记顶层 `externalContracts` 与 `externalContractReview`（结构、字段语义与对账规则见「外部契约登记」节）；宿主类断言与外部契约能力证据的判定见 `state-and-events.md`。

## 外部契约登记（schema 2 additive 顶层字段）

验收包出现 `externalContracts` 键即触发外部契约全链（登记、候选处置、权威解析、essential 绑定、契约冒烟、runtime 义务）；未声明该键的验收包与本升级前的任务零新约束（迁移边界见文末）。

### externalContracts

结构：

```jsonc
[
  {
    "id": "EC-pi-extension-api",
    "essential": true,
    "authorityRequest": { "resolverKind": "installed-npm-package", "locator": "@earendil-works/pi-coding-agent" },
    "capabilities": [
      {
        "id": "load-extension",
        "minEnvironment": "official-runner",
        "observable": "官方 loader 装载扩展并得到注册清单",
        "surfaceRefs": ["dist/core/extensions/loader.js"],
        "detectionClasses": ["extension-entrypoint"]
      }
    ]
  }
]
```

字段规则：

- `essential` 分自报与机器强制两层。自报 `essential=true`：权威不可解析、runtime 义务未满足时不得批准验收，也不得 accepted。机器强制：候选探测的 strong 信号命中该能力的 `detectionClasses`，或该能力已被某条断言的 `requiredEnvironment.capability` 引用——强制判定不看契约自报值，也不看需求自报的 `required` / `riskAcceptable`。`essential=false` 仅限尚未进入任何验收断言、且完整复扫（intent、项目清单与源码）未检出其调用类的未使用可选集成。
- `capabilities` 是机器可对账的最小能力清单，不穷尽外部系统全部 API。
- capability 与断言的绑定唯一权威 = `assertion.requiredEnvironment.capability`，不另设映射表；每个 essential capability id 必须至少被一条断言引用，且该断言的 `requiredEnvironment.kind` 不低于能力的 `minEnvironment`（真实环境是官方运行器的超集：real-host 证据可满足 official-runner 要求）。
- `detectionClasses` 必须取自策略包 `policies/external-contract-classes.json` 已登记的调用类（新调用类走 `upgrade-policy` 登记，不得自造）；`minEnvironment` 不得低于该能力各调用类（及其蕴含观察类）在策略包中的环境底线，`fake-host` 不是合法档位。
- `surfaceRefs` 指向权威工件内的文件或类型符号（`文件路径` 或 `文件路径#符号`），probe 观察与审查抽查至少要能回溯到这些 surface；不穷尽整个 SDK，但不得遗漏该能力实际消费的注册、分发、返回值或生命周期入口。

### externalContractReview

```jsonc
{
  "detectionSha256": "<候选快照文件内容 sha256>",
  "dispositions": [
    { "candidateId": "candidate-pi-extension-api", "disposition": "bound", "contractId": "EC-pi-extension-api" },
    { "candidateId": "candidate-manual-runtime", "disposition": "manual", "contractId": "EC-browser-host", "rationale": "intent 明示浏览器宿主，但项目尚无源码与 manifest 信号" },
    { "candidateId": "candidate-logging-lib", "disposition": "not-external", "rationale": "纯进程内库，无宿主生命周期与外部注册入口" }
  ]
}
```

候选快照由 `detect-external-contracts.mjs` 生成，路径 `taskDir/evidence/acceptance-v<N>/external-contract-candidates.json`（按验收版本隔离）。对账规则：

- `detectionSha256` 必须与候选快照文件内容 sha256 一致；探测输入（intent / manifest / 源码）变化后必须重新探测并同步更新，不一致即拒绝。
- `dispositions` 逐候选一条处置：`bound`（绑定契约，contractId 必须指向已声明 externalContracts id）/ `manual`（reviewer 依 intent 语义补充，contractId 与 rationale 均必填）/ `not-external`（仅 weak 候选可用，rationale 必填）/ `unresolved`（无法判定，停回用户裁决）。
- strong 候选（外部系统 manifest、真实 SDK import、外部注册 / 分发 / 生命周期调用类）只能 `bound` 或 `unresolved`，不接受一句自由文本「不构成外部契约」放行。
- 每个 externalContracts id 必须有 `bound` 或带 rationale 的 `manual` 处置可回溯。
- 无候选时也生成空候选快照：`detectionSha256` 照填、`dispositions` 为空数组。

essential 契约的权威解析要求：`essential=true`（含被机器强制判 essential）的契约必须在权威解析输出中 status=resolved 且带 aggregateHash；`declared-unavailable` 不能伪造 resolved——权威确实不可得时停回用户裁决「目标环境不可满足」，或把该契约改为非 essential 并走普通风险接受。

### capability 回溯与 mock-only 判据

- 验收中出现的每个 `requiredEnvironment.capability` 必须能回溯到 externalContracts 的能力清单（契约内裸 id 或「契约id:能力id」限定形式）；回溯失败即拒绝。
- 能力绑定断言的 `given` / `when` 不得把 mock / fake / 自写 harness 作为唯一装载或分发环境：mock 可作补充场景，不能是该 capability 的唯一声明来源；只写 mock 装载、不写真实环境观察点的断言在批准前被拒。

## 静态能力快照（验收起草前置）

验收起草前先对项目跑一次只读探测，生成静态能力快照（project-capabilities.json：测试命令候选、验证资产、unknown 清单的派生缓存，schemaVersion 1）：

```bash
node ~/.agents/skills/delivery-v6/scripts/detect-project-capabilities.mjs --project-root <projectRoot>
```

- 快照缺省落 skill-data 寻址段 dev-flow 段 `<slug>/[<worktreeName>/]project-capabilities.json`（工作区形态带 worktreeName 层）；`--check` 重探测比对盘上快照（输入哈希变化报「输入已变化」，值漂移报「不一致」）——快照问题一律重跑探测重建，禁止手改；探测源 = package.json scripts、测试配置文件存在性、项目 AGENTS.md 声明的 verification skill 场景清单。
- 测试命令与验证资产从快照候选中选择；选择结果仍由 increments.json 批准冻结——快照只提供候选，不成为第二验收权威。快照未覆盖的来源（项目测试策略文档等）仍按现行判据补充读取。
- 探测定位不到的能力进快照 `unknowns`：由验收设计者选择补建、降级验证或报用户裁决，禁止自动编命令，也不得把 unknown 条目当可用能力引用。
- 验收审查输入的「断言 × 证据类型 × 验证资产」表由 acceptance 的 evidenceKinds/testAssetRefs 与快照直接生成（逐断言列证据类型，经 testAssetRefs 绑定快照中的命令与资产，空绑定逐条显式披露），不依赖 exec-plan 或验证索引；tech-design-v6 T3 与 dev-flow-v6 D0 读同一份快照，能力口径三阶段同源。

## increments.json

每个增量关联至少一条需求、**必须声明一条测试命令**（program + args + 可选 timeoutMs）。测试命令在验收包批准时被哈希锁定——批准后替换测试命令即验收包变化、批准失效。增量是验收内部的实施步骤，不是独立交付版本。

字段判据（validate-acceptance 机器校验）：增量 id 以字母或数字开头、仅含字母数字/下划线/连字符且长度 ≤64（非 ASCII id 一律拒绝，建议 `INC-0-contract-smoke` 式命名）；`testCommand.timeoutMs` 须为 1000..3600000 的整数（缺省 300000）；全部增量都声明测试命令是独立保证回执的前提——缺一条即 validate-acceptance 拒绝。

**契约冒烟增量**：验收含（有效）essential 外部契约时，`increments.items` 必须有一条 `kind=contract-smoke` 增量（建议 id `INC-0-contract-smoke`）：`testCommand` 指向真实环境契约冒烟探针，让 API 形态、签名与回执通道在业务实现前先被真实环境揭示；反例引用的 negative case 用错误契约形态调用真实环境并断言真实环境拒绝。分两阶段——spike 阶段用最小可装载实现确认契约形态，final 阶段在当前完整候选 revision 重跑满足 runtime 义务；只过 spike 不满足 accepted。能力绑定不写在增量里，唯一来源仍是断言 `requiredEnvironment.capability`。

## 机器校验

`delivery-gate validate-acceptance --task-dir <taskDir>` 校验 schema、词表、需求引用、id 唯一性与项目一致性；输出 `warnings` 数组承载词面初筛提示（当前为检测/分流类判据判别力初筛，不拒写入）。验收包声明 `externalContracts` 时增跑外部契约静态检查（结构合法、候选处置与 detectionSha256 对账、essential 契约权威解析、能力结构与调用类环境底线、断言绑定与能力回溯、mock-only 判据、契约冒烟增量、策略环境词表）。审查与批准事件由 CLI 自动绑定验收包哈希，不需要手工计算。

## 迁移边界

- 升级前任务（task.json 无 deliveryProfile 元数据）与未声明 `externalContracts` 的验收包零新约束：外部契约检查、runtime 义务与契约冒烟增量要求整体不生效；宿主类证据的 sourceHash 按「只登记不核」的原口径执行。
- 验收包一经声明 `externalContracts`，外部契约全链即生效；删除该键表示本任务无外部契约依赖。
- `deliveryProfile`（a / b / c）由 init `--delivery-profile` 或 user 凭据命令 `set-delivery-profile` 写入，缺省 b；降档只减审查席与分区，不减必做机器门。
