# conformance-plane — 设计义务一致性控制平面

设计来源：`tech-design` 段 `sync-conformance-plane` 设计包（渲染视图 §3 终态七层；本目录实现其中的领域核、义务提取与检查分层、执行层（隔离变更集与集成器）与报告迁移层）。编号纪律：本目录注释中的 GL/PR/AX/D/GA/V/RL/U/G/M/SC/UD/AS/SI/RH 裸用 = 该设计包；引用其他设计包编号须带域前缀（如 `thesis-contract·V3`）。

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
| `workspace/inventory.mjs` | workspace 真实路径仓库清单提案与确认命令：root/subdir/symlink 三来源扫描、gitignore 命中过滤、未登记仓库/符号链接逃逸/Git 根不一致拒启 | M3 |
| `changeset/sandbox.mjs` | 隔离 worktree sandbox 创建与回收：检出目录落仓外断言（realpath 包含关系）、宿主写入点四类登记（第四类共享对象库禁产对象命令）、remove+prune 回收、启动期清扫与残留探针 | M3 |
| `changeset/manifest.mjs` | 多仓补丁 manifest：每仓补丁 + 基准快照（baseCommit + tree id）+ 目标树哈希（工作树级内容哈希，全部 git 调用零对象写入） | M3 |
| `integration/integrator.mjs` | 集成器——正式仓唯一写入门径：apply 预检 + 逐仓宿主 pre-commit 挂钩、两阶段提交（先建全部 commit 对象再逐仓移 ref）、回滚计划、manual 模式 | M3 |
| `integration/doc-proposals.mjs` | 设计文档结构化变更提案通道：提案 → RulingRequested/RulingRecorded 裁决采纳 → 经集成器应用到章节 JSON → 绑定升版 + BacklogAdopted 转新地址初始证据 | M3 |
| `migration/cutover.mjs` | 按设计包灰度切换与归档包复活：cutover 标记双写（`<name>/cutover.json` 权威位置 + docName 变体键）、旧 final 两变体精确枚举改名归档 + tombstone 指针、Unarchived 解档 | M5 |
| `migration/legacy-import.mjs` | 旧 final 导入：alias 计算、四项结构校验（引文/绑定存在性/违例类别合法域/同地址冲突）、幂等重放、IMPORT_EXCLUSIONS 排除源 | M5 |
| `reports/outcomes.mjs` | 四层结论派生：scriptStatus / engineOutcome / integrationOutcome / deliveryOutcome 词表与分层不可互覆盖 | M5 |
| `reports/render.mjs` | 派生报告五视图（current/final/matrix/trajectory/ledger）渲染，落盘 tech-design 段 `<name>/v2/` | M5 |

M3 执行层与 M5 报告迁移层已交付于本目录对应子目录；M4 的 D5 v2 对账引擎与 agent 模板（design-code-sync-v2.shared.ts、conformance-reviewer/changeset-fixer、flow/sync.md）落 `workflows/src/` 与 `dev-flow-v5/`，不在本目录模块地图内。

## 核心契约

### 身份与义务表（extractors/obligations.mjs）

- 差距地址 = `(bindingId, repoId, violationKind)`（AX2）；bindingId 锚定章节条目（= 条目 id 或条目 id + `-` + 后缀）。
- 义务摘要 = 规范化身份四元组 `{ bindingId, repoId, violationKind, bindingVersion }` 的内容哈希（`facts.obligationSummaryHash`；golden corpus 夹具 `obligationHash` 同此口径）。
- 覆盖率分母只含带 conformance 绑定的条目（AX8）；未绑定条目列入 `unbound` 清单，不进分母。
- 义务表版本 `tableVersion` = 规范化义务集字段子集（身份四元组 + 检查契约字段）的 sha256（含 `CONFORMANCE_SCHEMA_VERSION`）；绑定集或契约字段变化即升版。
- conformance 字段规格：`tech-design-v5/references/design-doc-schema.md` §9b（conformance schemaVersion 2；violationKind 六值词表与 severity 三值词表扩充必须升 schema 版本）。violationKind 词表唯一权威 = `kernel/facts.mjs`；`check-design-doc.mjs` 持同步副本，`scripts/tests/obligation-identity.test.mjs` 断言三处一致。

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

### 隔离变更集与集成器（changeset/ + integration/）

- sandbox 机制固定为 git worktree，检出目录统一落 skill-data 段 sandbox 子段（目标仓外固定段）。宿主仓写入点穷举四类登记于 `HOST_WRITE_POINTS`：① `.git/worktrees/<name>/` 管理区元数据、② worktree 临时分支、③ 管理区锁文件——三类为机制生命周期内豁免项，受 `releaseSandbox`（remove+prune）与 `sweepHost`（启动期清扫）约束；④ 共享对象库 `.git/objects` 裁决为禁止：sandbox 内禁产对象命令（`FORBIDDEN_OBJECT_COMMANDS` = add / commit / stash / hash-object），agent 只用工作树级 diff 产补丁，产对象只发生在集成器阶段。
- 对象库失守检测口径：agent 阶段前后宿主 `git count-objects -v` 的松散 + in-pack 合计不变（`measureObjectCounts`；合计口径对 gc 打包稳定），多仓 manifest 下对 manifest 内全部仓库逐仓执行。
- 集成器 `integrateChangeset` 是正式仓唯一写入门径（AX7）：先对全部仓库 apply 预检并逐仓执行宿主 pre-commit 挂钩（按该仓 core.hooksPath 挂载点作用于 staged 变更）；预检失败写 IntegrationPrecheckFailed、挂钩拒绝写 IntegrationGateChecked（两事件字段契约 = 四要素：逐仓命令、退出码、摘要与恢复动作；两分支可区分、同终值 failed、全量不应用）。两阶段提交先创建全部 commit 对象、再逐仓移动 ref——ref 移动不隐式触发挂钩，以预检已执行同一挂钩为前提，同样写 IntegrationGateChecked 审计事件；ref 移动失败按已记录回滚计划恢复，终值 rolled-back。人工接管以 `MANUAL_ACTOR`（main-agent）manual 模式走同一门径。
- 补丁冲突不自动变基：apply 冲突拒绝该变更集并生成重生成任务（基于新基线重新生成，恢复动作随事件给出）。
- 版本纪律：触及技能自有文件或共享源的补丁必须携带 SKILL.md frontmatter version bump（`checkVersionDiscipline`），缺失即预检红灯。

### 设计文档提案通道（integration/doc-proposals.mjs）

- 四步闭环（`runDocProposalCycle` 编排）：① `createDocProposal` 结构化提案（章节文件 + JSON 指针 + 提议值 + 期望现值），零写入；② `submitDocProposal` / `recordDocRuling` 走 RulingRequested / RulingRecorded 裁决（direction 非 doc-right = 不采纳，不应用不升版）；③ `applyDocProposal` 由集成器以 manual 同门径应用到章节 JSON；④ `bumpBindingVersion` 升绑定版本 + `adoptProposalAsEvidence` 按 BacklogAdopted 语义把提案转为新地址初始 fail 证据，义务表随之升版。

### cutover 与旧档迁移（migration/）

- cutover 标记写入 tech-design 段 `<name>/cutover.json`（`CUTOVER_MARKER_NAME`；不写正式仓、不违反唯一写入门径），并按 docName 变体键双写同内容——旧引擎拒启探针按 `<slug>/<docName>/cutover.json` 探测，docName 可含 `.rendered` 后缀。
- 切换扫描枚举键 = `LEGACY_SYNC_VARIANTS` 两变体（`<name>.sync/final.json` 与 `<name>.rendered.sync/final.json`）精确匹配，禁止裸前缀 glob；命中逐一改名归档为 `final.legacy.json`（`LEGACY_ARCHIVE_NAME`）并在原地址留 tombstone 指针；tech-design 段 `<name>/final.json`（T2 审查终态）不触碰。
- 归档包复活：`unarchivePackage` 追加 Unarchived（退出归档）事件解档并恢复状态仓追加；cutover 标记保留（旧引擎仍拒启，复活只走 v2）、走 V1 流程重建覆盖率分母。
- 旧档导入 `importLegacyFinal`：旧 F id 只作 alias（`computeAlias`），永不参与新身份计算；映射裁决须过四项结构校验——旧记录引文（`matchRecordByQuote`：一条引文恰好匹配一条记录）、绑定存在性、违例类别合法域（与绑定声明一致）、同地址冲突人工确认；幂等重放；round 目录 planner/module/fixer 产物作派发史证据（`collectRoundEvidence`）。
- 不入导入源（`IMPORT_EXCLUSIONS`）：exempted.json（与 final.json exemptList 字段同构的双落点）、retirement/retireCleanup 字段（退役清理能力显式裁决不迁移 v2）——两记录随 final.legacy.json 归档保留、可人读找回。

### 四层结论与派生报告（reports/）

- 四层结论词表（常量即权威）：`SCRIPT_STATUSES` ∈ running / completed / failed；`ENGINE_OUTCOMES` ∈ completed / awaiting-ruling / stopped / failed；`INTEGRATION_OUTCOMES` ∈ not-required / not-started / verified-pending-integration / integrated / rolled-back / failed（partial 只作事件中的瞬时逐仓状态，不入终态词表）；`DELIVERY_OUTCOMES` ∈ pending / resolved / resolved-by-main-agent / blocked。
- 分层不可互覆盖（AX10）：每层有唯一权威源独立派生（`deriveOutcomes`），一层的后续事实不改写另一层已定结论；人工接管 deliveryOutcome=resolved-by-main-agent 是流内 manual 接管事实背书，不覆盖引擎/集成层结论。
- 派生报告五视图（`render.mjs`）：current / final / matrix / trajectory / ledger 每次从 `rebuild(stateRoot)` 全量重建，不在报告层维护可变状态（删除全部报告后重渲染逐字节等价）；落盘根 = tech-design 段 `<name>/v2/`（`REPORT_DIRNAME`），不与旧 D5 final（dev-flow 段 `<docName>.sync/final.json`）同址冲突。

## 命令

```
# 单元测试（u-foundation 四文件 + u-m2 四文件）
node --test scripts/tests/state-fold.test.mjs scripts/tests/evidence-invalidation.test.mjs \
  scripts/tests/golden-corpus.test.mjs scripts/tests/state-lock.test.mjs
node --test scripts/tests/obligation-identity.test.mjs scripts/tests/obligation-coverage.test.mjs \
  scripts/tests/checker-cache.test.mjs scripts/tests/checker-failure.test.mjs

# u-m3 隔离变更集与清单 + u-m4 cutover 拒启 + u-m5 四层结论观测
node --test scripts/tests/changeset-isolation.test.mjs scripts/tests/workspace-inventory.test.mjs \
  scripts/tests/cutover-guard.test.mjs scripts/tests/workflow-observability.test.mjs

# conformance 绑定校验（设计包写作期机器检查；无绑定文档零失败零警告）
node skills/self/dev-workflow/tech-design-v5/scripts/check-design-doc.mjs <设计包目录>

# 义务提取（repl 示意）
import { extractObligations } from ".../conformance-plane/extractors/obligations.mjs";
const table = extractObligations({ "meta.json": …, "s1-context.json": …, … /* 六章节 */ });
table.stats  // { totalEntries, boundEntries, bindings, unboundEntries, machineCheckableRatio }
```

测试文件接受守护登记别名 flag（如 `--replay-stable` / `--backlog-excluded` / `--hash-stable` / `--exit-contract`）：flag 只是设计文档守护登记的别名（登记于各守护项说明），文件不解析 flag、恒跑全部用例。

## 事件词表消费

本目录全部事件写入走 `kernel/facts.mjs` 词表（RulingRequested / RulingRecorded / BacklogAdopted / CheckerFailed / IntegrationGateChecked / IntegrationPrecheckFailed / Unarchived / EvidenceRecorded），M2 直接消费 BacklogAdopted、CheckerFailed、EvidenceRecorded；M3 集成器写 IntegrationPrecheckFailed / IntegrationGateChecked，M5 cutover 写 Unarchived；新增事件名必须同步登记 kernel schema（AX4 授权路径，防词表分裂）。
