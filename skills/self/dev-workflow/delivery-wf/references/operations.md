# 主 agent 操作序列

所有路径参数用绝对路径；不要把本机路径写进项目仓库。命令中的 `<...>` 是占位符。

## 1. 初始化

```bash
node ~/.agents/skills/delivery-wf/scripts/delivery-gate.mjs init \
  --project-root <项目根> --task-id <任务id>
```

stdout 是 JSON：`taskDir` 与三把 Ed25519 角色私钥（`builderKey`／`assuranceKey`／`userKey`）及对应公钥。私钥只在 init 时输出一次，task.json 只落公钥——丢失后无法补发，只能开新任务 id 重新发起。初始化幂等；已有目录时先检查 contract/events，禁止清空历史。

密钥持有与传递：

| 密钥 | 持有者 | 用途 | 传递边界 |
|------|--------|------|----------|
| `builderKey` | 主会话 | 以 builder 角色签名追加实现类事件（`append --key`） | 只作为 `candidate-build` 的 `builderKey` 参数注入该 workflow |
| `assuranceKey` | 主会话 | 以 assurance 角色签名追加证据与发现类事件（`append --key`） | 只作为 `independent-assurance` 的 `assuranceKey` 参数注入该 workflow |
| `userKey` | 仅主会话 | 用户批准（`approve-contract --user-key`）与风险接受（`accept-risk --user-key`） | 绝不注入任何子 agent 或 workflow，不写入任务目录 |

`append --key` 校验私钥角色与事件 actor 一致：actor=builder 必须 builderKey、actor=assurance 必须 assuranceKey、actor=user 必须 userKey，跨角色密钥一律拒绝。本机信任边界：三把私钥能阻止无凭据伪造与跨角色越权，但同一操作系统用户下的进程仍可改写 task.json 公钥与 events.jsonl 后重签——本技能不声称对恶意 shell 提供文件系统隔离；密钥只交给 CLI，不写入任何 agent prompt。

## 2. 设计并批准契约

zcode：

```text
CreateWorkflow saved: contract-design
args: { projectRoot, taskDir, objective, maxRounds, taskId?, executionId?, sampleType? }
```

pi：运行技能上级 `workflows/pi/contract-design.js`，传同名参数。

`contract-ready` 后向用户呈现关键决策。批准后执行：

```bash
node ~/.agents/skills/delivery-wf/scripts/delivery-gate.mjs approve-contract \
  --task-dir <taskDir> --user-key <userKey> --confirmation user-explicit \
  --summary "用户批准契约第 N 版及验收要求"
```

已有全托管授权时 confirmation 可改为 `standing-authorization`（只适用于 approve-contract），摘要写明授权来源。只做设计的任务到此停止，不得写成代码已交付。

## 3. 形成候选实现

```text
CreateWorkflow saved: candidate-build
args: { projectRoot, taskDir, builderKey, taskId?, executionId?, sampleType? }
```

前置门禁：evaluate state 为 `draft` 时 workflow 拒绝进入。builder 只写代码、测试和原始输出，每增量一次任务内完成实现与实现报告；workflow 完成后运行 evaluate；若不是 accepted，不得把 implemented 当成交付。

## 4. 独立保证

```text
CreateWorkflow saved: independent-assurance
args: { projectRoot, taskDir, assuranceKey, taskId?, executionId?, sampleType? }
```

前置门禁：state 不是 `draft`/`contract-approved` 且 `missing.incrementIds` 为空；setup 与 finalize 比对 revision，assurance 期间项目内容变化即显式失败。coverage reviewer 负责逐项证据判定；explorer 负责契约外反例。后者只在契约要求时执行，未执行时不得补写 ExplorationCompleted。

## 5. 统一判定

```bash
node ~/.agents/skills/delivery-wf/scripts/delivery-gate.mjs evaluate --task-dir <taskDir>
```

revision 判定口径：git 项目 evaluate 自动计算当前工作树 revision，代码、契约、验收资产或宿主变化后须重新取证；非 git 项目不支持自动 revision，必须显式传 `--revision <值>`（或走第 7 节手工路径）——candidate-build/independent-assurance 的自动 revision 同样依赖 git，非 git 项目不要声称全自动通用。

按 `nextAction` 处理：

- 实现缺陷：回 candidate-build（命中未决发现或失败证据的增量自动进入修复轮），并在任务书提供 open findings。
- 契约遗漏：回 contract-design，递增 contractVersion 后重新批准。
- 证据不足：回 independent-assurance，禁止只凭旧日志补 verified。
- 具体风险由用户决定：先展示风险、后果和恢复路径，再记录决定。

## 6. 用户接受风险

```bash
node ~/.agents/skills/delivery-wf/scripts/delivery-gate.mjs accept-risk \
  --task-dir <taskDir> --user-key <userKey> --target-type requirement \
  --target-id R1 --confirmation user-explicit \
  --summary "用户接受 <具体风险、影响范围、恢复方式>"
```

accept-risk 只接受 `confirmation=user-explicit`；全托管授权（standing-authorization）不能替代具体风险接受。finding 使用 `--target-type finding --target-id <findingId>`。接受后重新 evaluate；状态应为 accepted_with_risk，不得改写成 accepted。

## 7. 手工与恢复

workflow 不可用时，主 agent 可按同一角色权限手工完成动作，但仍须用 CLI 的 append 记录事件：builder/assurance 事件带 `--key <对应角色私钥>`，user 事件（批准、风险接受）优先走 approve-contract/accept-risk 高层命令。每次恢复先 evaluate，不根据聊天记忆补状态；先核对当前 revision，再决定哪些旧证据仍有效。
