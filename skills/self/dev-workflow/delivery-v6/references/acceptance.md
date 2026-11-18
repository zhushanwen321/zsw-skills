# 目标与验收文件（acceptance.json / increments.json）

acceptance.json 回答「这个任务要做到什么、做到什么样算做对」；它独立于「怎么做」——方案可以换，验收不跟着方案改。increments.json 是验收包的组成部分（增量×需求×测试命令），与 acceptance.json 一起被验收包哈希联合绑定：改任一文件的规范内容，包哈希即变，既有审查与批准全部失效。

## 写作要求

- `objective` 一句话说清任务目标（用户可观察的结果，不是实现方式）。
- 每条 requirement 的 `statement` 必须外部可观察、可证伪：「关闭后零写入」可以设计实验证伪；「架构优雅」不允许。
- `required=false` 的需求不阻终态，但 failed 会在 verdict 中披露。
- `riskAcceptable=false` 表示该条不满足时不允许「用户接受风险后照样交付」——只能修复或递增版本改验收。
- `evidenceKinds` 声明该条需要哪几类证据（command / scenario / inspection；词表可经策略包扩展）。每类证据独立判定，全部 verified 才算通过。
- schema 2 的每个 requirement 必须有 assertions[]：每条断言写 id/statement/qualifiers/given/when/then/adversarialFormRefs/testAssetRefs，只描述一个可观察行为；可选 qualifierNotApplicable[]（每条 { qualifier, rationale }）为无法构造反例的限定条件登记不适用理由，带理由的限定条件豁免「每个限定条件有反例场景」要求；可选 dependsOn（{ incrementIds, mechanismRefs, testAssetRefs }）声明该断言依赖的实现增量与机制条款，供修复轮机器推导受影响断言；可选 requiredEnvironment（{ kind: "official-runner" | "real-host", capability? }）声明宿主环境要求——`official-runner` 用于证明官方命令解析、注册与事件语义，需要完整用户交互或进程行为的断言要求 `real-host`，缺省不限制。环境要求属验收契约：变更递增 acceptanceVersion。gate 对宿主类断言核对证据 artifact 的 environment 元数据（kind/name/version/source/sourceHash/driver），证据环境不满足要求时最多 partial/unknown、不得 verified；模拟环境不能独立证明宿主契约。顶层 adversarialForms[] 逐条写 assertionId/qualifier/entryPoint/initialState/operation/timing/expected/testAssetRefs/rationale。每个限定条件有反例场景或不适用理由，断言与场景双向引用一致；全局不变量覆盖全部相关写入入口和等待点（允许记录不适用理由）。schema 1 存量任务保持需求级判定。
- `nonGoals` 与需求同等重要：防止验收范围被悄悄扩大或缩小。
- 高风险（riskLevel=high）必须标注探索性审查（exploratoryReview=required）且至少一个 reviewDimensions。该字段是披露要求而非探索门控：schema 2 的候选反例审查与 full 开放式探索对全部任务可达——full 探索按「缺少候选探索证据、验收或关键设计变化」触发，中低风险任务不因此跳过探索路径。
- 修订已有验收必须递增 acceptanceVersion 并重新审查与批准；旧版本上的批准与证据自动失效（保留审计）。

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

每个增量关联至少一条需求、可带一条测试命令（program + args + 可选 timeoutMs）。测试命令在验收包批准时被哈希锁定——批准后替换测试命令即验收包变化、批准失效。增量是验收内部的实施步骤，不是独立交付版本。

## 机器校验

`delivery-gate validate-acceptance --task-dir <taskDir>` 校验 schema、词表、需求引用、id 唯一性与项目一致性。审查与批准事件由 CLI 自动绑定验收包哈希，不需要手工计算。
