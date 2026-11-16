# 目标与验收文件（acceptance.json / increments.json）

acceptance.json 回答「这个任务要做到什么、做到什么样算做对」；它独立于「怎么做」——方案可以换，验收不跟着方案改。increments.json 是验收包的组成部分（增量×需求×测试命令），与 acceptance.json 一起被验收包哈希联合绑定：改任一文件的规范内容，包哈希即变，既有审查与批准全部失效。

## 写作要求

- `objective` 一句话说清任务目标（用户可观察的结果，不是实现方式）。
- 每条 requirement 的 `statement` 必须外部可观察、可证伪：「关闭后零写入」可以设计实验证伪；「架构优雅」不允许。
- `required=false` 的需求不阻终态，但 failed 会在 verdict 中披露。
- `riskAcceptable=false` 表示该条不满足时不允许「用户接受风险后照样交付」——只能修复或递增版本改验收。
- `evidenceKinds` 声明该条需要哪几类证据（command / scenario / inspection；词表可经策略包扩展）。每类证据独立判定，全部 verified 才算通过。
- schema 2 的每个 requirement 必须有 assertions[]：每条断言写 id/statement/qualifiers/given/when/then/adversarialFormRefs/testAssetRefs，只描述一个可观察行为。顶层 adversarialForms[] 逐条写 assertionId/qualifier/entryPoint/initialState/operation/timing/expected/testAssetRefs/rationale。每个限定条件至少一个可实际构造的反例场景，断言与场景双向引用一致；全局不变量覆盖全部相关写入入口和等待点。schema 1 存量任务保持需求级判定。
- `nonGoals` 与需求同等重要：防止验收范围被悄悄扩大或缩小。
- 高风险（riskLevel=high）必须要求探索性审查（exploratoryReview=required）且至少一个 reviewDimensions。
- 修订已有验收必须递增 acceptanceVersion 并重新审查与批准；旧版本上的批准与证据自动失效（保留审计）。

## increments.json

每个增量关联至少一条需求、可带一条测试命令（program + args + 可选 timeoutMs）。测试命令在验收包批准时被哈希锁定——批准后替换测试命令即验收包变化、批准失效。增量是验收内部的实施步骤，不是独立交付版本。

## 机器校验

`delivery-gate validate-acceptance --task-dir <taskDir>` 校验 schema、词表、需求引用、id 唯一性与项目一致性。审查与批准事件由 CLI 自动绑定验收包哈希，不需要手工计算。
