---
name: delivery-wf
# 技能版本唯一权威（手动 semver）。workflow 构建器读此值注入产物；改本行后必须重建
version: 0.2.0
description: >-
  Use when 用户说「设计并实现」「按契约开发」「独立验收」「审查这次交付」「高风险功能开发」，
  需要把需求转为有证据支持的代码交付，或只完成其中的设计、候选实现、独立保证。
  适合功能开发、架构改动和需要回归判据的 bug 修复。Not for 纯调研、只讨论方案不落产物、
  无行为判据的文档润色、用户明确要求跳过验证直接写代码、已有 tech-design-wf 设计包的
  落地执行、用户点名 tech-design-wf 与 dev-flow-wf 组合、局部一行小修。
---

# delivery-wf

先按用户意图读对应文件，再执行；不要在主会话凭记忆手写契约、事件或 `verdict.json`。

## 核心边界

1. **产品契约独立于实现方案**：契约定义外部可观察的正确行为，解决方案只定义实现路径。
2. **实现完成不等于接受交付**：`implemented`、`contract-ready`、workflow `completed` 都是过程状态。
3. **唯一交付判定**：只有 `delivery-gate evaluate` 能写 `verdict.json`；自动和手工路径使用同一判据。
4. **独立保证**：由不参与实现的角色核对契约覆盖，并按风险进行探索性审查——主动寻找契约和测试遗漏。
5. **未知不等于通过**：`partial` 不是 `verified`，用户接受风险也不改写成已验证。

## 与 tech-design-wf / dev-flow-wf 的关系

delivery-wf 是契约驱动的完整交付通道：契约设计 → 候选实现 → 独立保证 → 统一交付裁决，产物（contract/events/verdict）自成一册。已有 tech-design-wf 设计包的落地继续走 tech-design-wf → dev-flow-wf，不自动双轨；用户点名该组合时不改道 delivery-wf。同一任务不要混用两条通道的裁决产物。

## 意图路由

| 用户意图 | 先读 | 执行 |
|----------|------|------|
| 设计并实现、修复 bug、开发功能 | `references/risk-routing.md`、`references/operations.md` | 完整主流程 |
| 只做设计、评审需求契约 | `references/contract.md` | `contract-design`；经用户批准后停止 |
| 按已有契约实现 | `references/operations.md` | 校验契约后 `candidate-build` → `independent-assurance` → evaluate |
| 只验收已有实现 | `references/state-and-events.md`、`references/operations.md` | 先形成当前实现记录，再做独立保证，禁止补写旧证据 |
| 用户接受具体残余风险 | `references/state-and-events.md` | 确认用户明确指定风险后 `accept-risk` → evaluate |
| 查看当前能否交付 | `references/state-and-events.md` | 直接 evaluate，不重放旧证据 |
| 修改产品契约或验收判据 | `references/contract.md` | 递增 contractVersion 并重新批准；相关旧证据失效 |

## 主流程

1. 初始化任务目录，读取项目约定，形成原始需求与风险判断。
2. 发起 `contract-design`，得到 `contract-ready`，不是直接批准。
3. 向用户呈现关键目标、非目标、不变量、风险和验收要求；用户明确批准后 `approve-contract`。用户已授权全托管时，用 `standing-authorization`。
4. 发起 `candidate-build`。前置门禁：evaluate state 为 `draft` 时拒绝进入，先完成契约批准。已实现增量按 contractVersion 判定，不因 revision 变化全量重做；仅命中未决发现或当前失败证据的增量进入修复轮。实施增量是契约内部的实施步骤，不是独立交付版本；builder 的测试输出只算原始材料。
5. 发起 `independent-assurance`。前置门禁：state 不是 `draft`/`contract-approved` 且 `missing.incrementIds` 为空。setup 与 finalize 比对 revision，漂移即显式失败。覆盖核对与探索性审查是两种活动，不能互相替代。
6. 跑 `delivery-gate evaluate`，按返回的 `state/missing/nextAction` 决定继续实现、补验证、修改契约、请求用户接受风险或停止。
7. 只有 `accepted` 或 `accepted_with_risk` 才能按对应口径交付；后者必须逐项披露用户接受的风险。

## Workflow 契约

| workflow | 输入 | 允许产出 | 明确不能产出 |
|----------|------|----------|--------------|
| `contract-design` | projectRoot、taskDir、objective | 契约草稿、解决方案、实施增量 | ContractApproved、最终交付结论 |
| `candidate-build` | projectRoot、taskDir、builderKey | 代码、测试、原始输出、ImplementationRecorded | verified 证据、契约修订、最终交付结论 |
| `independent-assurance` | projectRoot、taskDir、assuranceKey | 覆盖结论、探索发现、验证与审查事件 | 产品代码修改、契约修订、风险接受 |

三个 workflow 均接收可选 `taskId/executionId/sampleType` 观测参数。zcode 使用同名 saved workflow；pi 使用本技能上级的 `workflows/pi/<name>.js`。两边都不可用时，主会话可按相同职责手工执行，但事件和最终判定仍必须走 `delivery-gate`。

## 密钥与信任边界

`delivery-gate init` 一次输出三把 Ed25519 私钥（对应公钥登记在 task.json）：`builderKey`（只注入 candidate-build）、`assuranceKey`（只注入 independent-assurance）、`userKey`（仅主会话持有，用于 approve-contract/accept-risk，绝不注入任何子 agent 或 workflow）。角色 workflow 只接收本角色 key，`append --key` 校验私钥角色与事件 actor 一致；密钥只交给 CLI，不写入任何 agent prompt。

本机信任边界：角色私钥能阻止普通 CLI/agent 无凭据伪造事件与跨角色越权，但同一操作系统用户下可运行进程仍可改写 task.json 公钥或 events.jsonl 并重签——本技能不声称对恶意 shell 提供文件系统隔离。workflow args 可能被宿主记录（run 日志、观测数据），因此密钥不得出现在任何 agent prompt；交付前主会话必须重跑 evaluate，核对 `revision` 与 `integrity` 再对外声明结论。

## 角色与写入权限

- designer：写契约草稿与解决方案，不能自我批准。
- builder：改代码和测试、写实现报告，不能改契约、事件文件或 verdict。
- assurance：读代码并运行必要验证、写独立证据与发现，不能改产品代码或契约。
- 主 agent：呈现裁决点、记录用户批准或风险接受、调用裁决器；不能代替用户接受风险。
- 所有子 agent 禁止再派 agent、禁止 git 写，除非项目明确授权主 agent 在收尾提交。

## 强制约束

- [MANDATORY] 一个需求只使用一份契约与一个交付事务；实施可以分增量，证据随增量产生。
- [MANDATORY] 契约变化必须递增 contractVersion 并重新批准；代码、契约、验收资产或宿主变化后重算 revision 并重新取证。
- [MANDATORY] `accepted_with_risk` 只能来自用户对具体风险的明确接受；不能让 agent 代为豁免。
- [MANDATORY] 产品长期价值与语义质量不能被自动化行为验证替代；需要时另做真实样本评估与投产观测。
- [OPTIONAL] 低风险小改可缩短设计与探索环节，但不能省略契约批准、独立保证和统一判定。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 保持交付判定可信所必需的约束 | 必须严格遵守 |
| `[OPTIONAL]` | 按风险调整执行深度的建议 | 可裁剪流程成本，不改变证据语义 |
