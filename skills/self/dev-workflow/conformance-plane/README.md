# conformance-plane — 设计义务一致性控制平面

设计来源：`tech-design` 段 `sync-conformance-plane` 设计包（渲染视图 §3 终态七层；本目录实现其中的领域核、义务提取与检查分层）。编号纪律：本目录注释中的 GL/PR/AX/D/GA/V/RL/U/G/M/SC/UD/AS/SI/RH 裸用 = 该设计包；引用其他设计包编号须带域前缀（如 `thesis-contract·V3`）。

## 模块地图

| 目录/文件 | 职责 | 波次 |
|---|---|---|
| `kernel/facts.mjs` | 命令/事实 schema（全文事件词表唯一权威登记处）、差距地址派生、义务摘要哈希、红灯阈值 | M1 |
| `kernel/state-fold.mjs` | 确定性 fold：事件序列 → 状态（结论谓词派生不存储）、孤儿证据检测 | M1 |
| `kernel/state-repo.mjs` | 状态仓 IO：append-only JSONL + 快照 + 单写者锁（1s 轮询 / 30s 超时 / 死亡清理） | M1 |
| `kernel/evidence.mjs` | 证据结构、内容哈希、有效期判定（任一输入哈希 / checker 版本 / 绑定版本变化即失效） | M1 |
| `extractors/obligations.mjs` | 义务提取器：章节 JSON（或绑定集）→ 义务表（版本化；无绑定叙述不进分母） | M2 |
| `checkers/registry.mjs` | checker 登记处 + 退出契约（0=通过 / 10=违例成立 / 20=自身失败，其他值按失败）+ 失败四要素命令装配 + semantic 回喂 | M2 |
| `checkers/semantic-cache.mjs` | 语义检查缓存：键 = 义务摘要 + 输入哈希集 + checker 版本；命中零 agent 调用 | M2 |
| `checkers/backlog.mjs` | 未映射观察 triage 队列（proposed/adopted/rejected/superseded）+ BacklogAdopted 采纳闭环 | M2 |
| `test-base/` | fake-agent 模拟器与 golden corpus 夹具（两个真实设计包脱敏重放样本） | M1 |

后续波次（M3 workspace/changeset/integration、M4 引擎、M5 reports/migration）落在本目录新子目录，逐波交付。

## 核心契约

### 身份与义务表（extractors/obligations.mjs）

- 差距地址 = `(bindingId, repoId, violationKind)`（AX2）；bindingId 锚定章节条目（= 条目 id 或条目 id + `-` + 后缀）。
- 义务摘要 = 规范化身份四元组 `{ bindingId, repoId, violationKind, bindingVersion }` 的内容哈希（`facts.obligationSummaryHash`；golden corpus 夹具 `obligationHash` 同此口径）。
- 覆盖率分母只含带 conformance 绑定的条目（AX8）；未绑定条目列入 `unbound` 清单，不进分母。
- 义务表版本 `tableVersion` = 规范化义务集字段子集（身份四元组 + 检查契约字段）的 sha256（含 `CONFORMANCE_SCHEMA_VERSION`）；绑定集或契约字段变化即升版。
- conformance 字段规格：`tech-design-wf/references/design-doc-schema.md` §9b（conformance schemaVersion 2；violationKind 六值词表与 severity 三值词表扩充必须升 schema 版本）。violationKind 词表唯一权威 = `kernel/facts.mjs`；`check-design-doc.mjs` 持同步副本，`scripts/tests/obligation-identity.test.mjs` 断言三处一致。

### checker 退出契约（checkers/registry.mjs）

- 退出码：`0` = 检查完成且无违例（证据 result=pass）；`10` = 检查完成且发现违例（证据 result=fail）；`20` = checker 自身失败；其他值同样按失败处理。
- 失败不伪造证据：失败只装配 `RecordCheckerFailure` 命令，四要素必填——命令、退出码、摘要、恢复动作；义务保持 open。
- semantic 非法输出回喂重试最多 2 次（`MAX_SEMANTIC_REFEEDS = 2`，总调用 ≤ 3），耗尽升级 CheckerFailed；run 抛错属自身失败，不回喂。
- semantic 合法输出 = `{ result: "pass"|"fail", summary: 非空字符串 }`；最小输入包 = 规范化义务绑定 + 目标输入哈希（禁携带完整会话历史）。
- checker 未注册：按失败处理（义务保持 open），恢复动作指向补登记——显式绑定但 checker 未注册不阻塞对账。
- deterministic checker 不走语义缓存（机械检查廉价，每轮真实执行）。

### 语义缓存（checkers/semantic-cache.mjs）

- 键 = 义务摘要哈希 + 输入哈希集（name:hash 规范序）+ checker 版本（`buildCacheKey`）；任一成分变化 → 新键 → 旧缓存天然失效。
- 命中复用零 run 调用（`stats.hits` 供断言）；失败判定不入缓存。
- 本模块只固化键语义与命中/失效行为（内存表）；持久化形态属 M4 引擎期实施细节。

### backlog 与采纳闭环（checkers/backlog.mjs）

- 条目状态机：`proposed → adopted | rejected | superseded`，终态不得再转移（表外转移 fail-fast）；backlogId 缺省 = 观察内容哈希短摘要（确定性派生）。
- 采纳闭环（经 kernel 写状态仓）：① 锁内把新绑定登记进快照 `input.bindings`（同 id+版本幂等、内容漂移拒绝）→ ② `appendCommands` 追加 `AdoptBacklogEntry`（bindingRef 含 bindingVersion）+ `RecordEvidence`（观察转新地址初始证据，result=fail）→ ③ 条目退出 active backlog。
- 采纳不改变旧工作范围完成判据（D6/G6）：新绑定不在旧义务表分母内；覆盖率分母只随义务表升版变化。
- 快照 input 直写是 kernel/state-repo.mjs `deriveArchived` 注释预告的通道（M5 cutover 同模式）；kernel 不导出快照写入口，本模块按同一文件名直写并在 kernel 锁内执行，kernel 文件名演进时会 loud break（`readSnapshot` 返回 null 即报错，不静默错写）。

## 命令

```
# 单元测试（u-foundation 四文件 + u-m2 四文件）
node --test scripts/tests/state-fold.test.mjs scripts/tests/evidence-invalidation.test.mjs \
  scripts/tests/golden-corpus.test.mjs scripts/tests/state-lock.test.mjs
node --test scripts/tests/obligation-identity.test.mjs scripts/tests/obligation-coverage.test.mjs \
  scripts/tests/checker-cache.test.mjs scripts/tests/checker-failure.test.mjs

# conformance 绑定校验（设计包写作期机器检查；无绑定文档零失败零警告）
node skills/self/dev-workflow/tech-design-wf/scripts/check-design-doc.mjs <设计包目录>

# 义务提取（repl 示意）
import { extractObligations } from ".../conformance-plane/extractors/obligations.mjs";
const table = extractObligations({ "meta.json": …, "s1-context.json": …, … /* 六章节 */ });
table.stats  // { totalEntries, boundEntries, bindings, unboundEntries, machineCheckableRatio }
```

测试文件支持守护登记形态的 flag（如 `--replay-stable` / `--backlog-excluded` / `--hash-stable` / `--exit-contract`）：flag 为设计文档守护登记形态，文件恒跑全部用例。

## 事件词表消费

本目录全部事件写入走 `kernel/facts.mjs` 词表（RulingRequested / RulingRecorded / BacklogAdopted / CheckerFailed / IntegrationGateChecked / IntegrationPrecheckFailed / Unarchived / EvidenceRecorded），M2 直接消费 BacklogAdopted、CheckerFailed、EvidenceRecorded；新增事件名必须同步登记 kernel schema（AX4 授权路径，防词表分裂）。
