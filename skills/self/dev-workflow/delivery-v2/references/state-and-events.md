# 证据、发现与交付状态

`events.jsonl` 是事实事件唯一权威；`verdict.json` 是裁决器根据当前契约、当前 revision 和事件重新计算的派生结果，禁止手改。每条事件带 Ed25519 签名（actor=builder 用 builderKey 签、actor=assurance 用 assuranceKey 签、actor=user 用 userKey 签，跨角色密钥拒绝），evaluate 用 task.json 内公钥验签；verdict 附带 `integrity`（事件数与验签结果）。

## 证据与发现

每个 requirement 按 `evidenceKinds` 分别取证：

| 结论 | 含义 |
|------|------|
| `verified` | 当前契约版本和当前 revision 下证据成立 |
| `partial` | 只覆盖部分行为、路径或环境，不是通过 |
| `failed` | 已有反证 |

没有事件就是 unknown，不需要伪造“未知”事件。builder 的测试输出不自动成为 verified；只有独立保证角色能追加 EvidenceRecorded。

发现（finding）的生命周期按契约版本与 revision 分层：

- FindingRaised 按 contractVersion 持久：登记后跨 revision 默认保持 open，契约不换版就不因代码变化消失。
- FindingResolved 只在 `resolved.revision` 等于当前裁决 revision 时关闭该 finding；代码变化产生新 revision 后，旧 resolution 失效，必须在新 revision 上重新确认并追加新的 FindingResolved。
- 同一 FindingResolved 内容完全相同才幂等；同 findingId 不同内容（尤其新 revision 的重新确认）必须追加新事件，不得静默短路。
- RiskAccepted 只表示用户接受指定风险，不改变证据原结论，也不关闭 finding。

所有证据、发现和风险接受都带 contractVersion 与 revision。契约修订或代码内容变化后，旧事件仍保留，但不参与当前判定。

## 状态定义

| 状态 | 含义与下一步 |
|------|--------------|
| `draft` | 契约未获有效批准；先完成设计与批准 |
| `contract-approved` | 契约已批准，尚无实现记录；进入 candidate-build-v2 |
| `implementing` | 增量未完成，或存在未接受的 failed/open blocker；继续实现或修复 |
| `candidate` | 候选实现已形成，但证据或独立审查尚不完整；进入 independent-assurance-v2 |
| `accepted` | 强制行为全部 verified，所需独立保证和探索审查完成，无 open finding |
| `accepted_with_risk` | 所需独立审查已完成，所有未通过项和 open finding 均有用户明确接受；按带风险口径交付 |

## accepted 的必要条件

1. increments.json 中全部增量都有当前契约版本的 ImplementationRecorded。
2. 每个 required requirement 的每种 evidenceKind 都有当前 revision 的 verified 证据。
3. 有当前版本的 AssuranceCompleted。
4. exploratoryReview=required 时，有覆盖全部 reviewDimensions 的 ExplorationCompleted。
5. 没有 open finding。

## accepted_with_risk 的必要条件

1. 当前 AssuranceCompleted 已存在；要求的 ExplorationCompleted 也已存在。
2. 每个非 verified 的 required requirement 都有当前版本 RiskAccepted。
3. 每个 open finding 都有当前版本 RiskAccepted。
4. 至少存在一项具体风险接受，或并非全部强制证据为 verified。
5. riskAcceptable=false 的 requirement 及其关联 finding 不能走此状态。

## 事件词表

- ContractApproved：user 批准指定哈希的契约。
- ImplementationRecorded：builder 登记一个实现增量。
- EvidenceRecorded：assurance 登记某 requirement 某 evidenceKind 的结论。
- AssuranceCompleted：assurance 完成本轮覆盖核对，不代表结果通过。
- ExplorationCompleted：assurance 完成指定维度的探索性审查。
- FindingRaised / FindingResolved：登记或关闭问题。
- RiskAccepted：user 接受指定 requirement 或 finding 的风险。

相同事件重复追加必须幂等；事件内容不同的同名 id 不得覆盖历史。
