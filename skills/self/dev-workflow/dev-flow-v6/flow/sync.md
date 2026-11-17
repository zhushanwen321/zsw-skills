# D5 终态同步 — 一致性对账引擎（v2）契约

> 把「代码实现 vs 设计文档」差距收敛为**固定义务覆盖率**的对账循环（sync-conformance-plane 一致性控制平面）：设计义务表（章节 JSON conformance 绑定）→ checker 派发（机械优先 / 语义缓存）→ 差距地址聚合 → 隔离变更集 → 集成器唯一写入门径 → 四层结论。**状态唯一权威 = conformance-state 状态仓事件流**（AX3）：agent 无状态、禁自报身份与终态——差距地址 = `(bindingId, repoId, violationKind)` 由义务绑定派生（AX2），结论由事件流 fold 派生（AX5），重放稳定、续跑从事件流恢复，不存在撞号与报告覆盖。

## 前置条件

1. 设计包章节 JSON 已带 conformance 绑定（`design-doc-schema.md` §9b；覆盖率分母 = 全部绑定义务，无绑定叙述不进分母）。未绑定 legacy 包走「legacy 只读期收尾」节（下方）。
2. 该包未切换：带 cutover 标记的包由 v2 管辖（标记是旧引擎的拒启信号，v2 正常运行）。
3. 交付体系任务：D4 收尾的增量实现登记已完成（逐增量 ImplementationRecorded 落交付任务事件流，`flow/acceptance.md` 收尾节第 3 步）——终态同步不替代实现登记，两者独立成环；前置与合法转移由 delivery-core next 裁决（转移表唯一权威），缺登记按其恢复动作回 D4 补。

## cutover 拒启检查（workflow 与手工路径共用，[MANDATORY]）

设计包切换标记由 cutover 命令写入 skill-data tech-design 段 `<name>/cutover.json`（寻址 = `~/.agents/skill-data/tech-design/<project-slug|ws-slug>/<name>/cutover.json`，工作区级共享、无 worktree 段）。**旧引擎入口（design-code-sync-loop workflow 与手工路径）在启动第一步按此寻址检查标记，命中即拒启**：不改旧状态、不写旧 final、不派任何 agent，指向 v2（design-code-sync-v2）与 v2 复活通道（Unarchived 解档）。拒启 message 含恢复动作。

v2 发起不检查该标记（标记只拦旧引擎）；v2 续跑 = 同 stateRoot 重发，事件流续跑。

## v2 workflow 契约（zcode 环境默认动作）

```
CreateWorkflow saved: design-code-sync-v2
args: { designPkg, projectRoot, declaredRepos, confirmedRepoIds?, sandboxRoot?, stateRoot?, confRoot?, reviewerTemplate?, fixerTemplate?, maxRounds?, rulingsFile?, taskId?, executionId?, sampleType? }
// designPkg = 设计包目录绝对路径（tech-design 段 <name>/，含六章节 JSON）——义务提取数据源
// projectRoot = 目标项目根绝对路径（workspace 清单扫描基准 + evidenceInputs 相对路径基准）
// declaredRepos = workspace 登记清单 JSON（数组 [{repoId, path, editableRoot?}]）——传参即主 agent
//   确认（M4 形态）；义务绑定 repoId 必须全部在确认清单内（AX9 未登记仓库拒启）
// stateRoot = conformance-state 状态仓根（缺省 tech-design 段 <name>/conformance-state）；续跑 = 同根重发
// rulingsFile = 用户裁决记录 json（续跑通道；元素 {address, direction: code-right|doc-right|waived, respondsTo}
//   ——respondsTo 取上次终态 message 的在案锚点；发起时装载入流解除 awaiting-ruling）
终态（四层结论，词表见「四层结论」节）: engineOutcome = completed / awaiting-ruling / stopped / failed
```

## 引擎语义（对账主循环）

```
setup   义务表提取（重放稳定）→ workspace 清单提案+确认（真实路径，AX9）→ 状态仓初始化/续跑识别
        → 裁决装载 → 启动期宿主清扫（prunable 残留 + 孤儿临时分支）+ 对象库基线
round   open 义务逐个 checker：机械内建（builtin.file-existence，targetSelector "path:" 前缀）
        优先 → semantic agent（conformance-reviewer，最小义务包 + 目标快照；按义务摘要+输入哈希+
        checker 版本缓存，命中零调用）→ pass 证据 verified；fail → 文档侧 / 代码侧分流：
          documentation-mismatch → 结构化提案 + RulingRequested → awaiting-ruling 停回；
          裁决 doc-right 续跑后引擎以 manual 门径应用提案、义务表升版（BacklogAdopted 语义）
          代码侧 → worktree sandbox 内 changeset-fixer 产隔离补丁（禁产对象命令）→ 多仓
          manifest → 集成器唯一写入门径（预检/挂钩拒绝全量不应用，两失败分支事件可区分）
        未映射观察 → backlog 提案（proposed，不改当前覆盖率分母——AX8）
finalize 四层结论 + 覆盖率汇总 + 残余 open 清单 + 收尾对象库逐仓对账（G4 防线②）
```

- **agent 无状态**：输入 = 最小义务包 + 目标快照，输出结构化观察/补丁；语义输出非法回喂 ≤2 次，耗尽写 CheckerFailed、义务保持 open（失败不伪造 verified）。
- **sandbox 隔离纪律**：修复 agent 在 sandbox 内禁止 git add / git commit / git stash / git hash-object——只用工作树级 diff 产补丁（共享对象库第④类写入点为禁止项）；引擎收尾逐仓 count-objects 对账，计数变化红灯呈报不自动清理。
- **裁决停回**（V8/V14）：awaiting-ruling 期间无修复派发；续跑携 rulingsFile，裁决必须回应在案请求（respondsTo 锚点在停回 message）。

## 四层结论（监控与交付判读口径，词表固定）

| 层 | 取值 | 主 agent 动作 |
|----|------|--------------|
| scriptStatus | completed / failed | failed 按 message 恢复动作处置 |
| engineOutcome | completed / awaiting-ruling / stopped / failed | awaiting-ruling → 携 rulingsFile 重发；stopped（轮次耗尽）→ 按 remaining 处置后重发；failed → 按 regenerateTasks/remaining 处置 |
| integrationOutcome | not-required / not-started / verified-pending-integration / integrated / rolled-back / failed | failed/rolled-back 按 regenerateTasks 重新生成变更集 |
| deliveryOutcome | pending / blocked | pending = 引擎收敛；裁决器 verdict 为 accepted/accepted_with_risk 后主 agent 方可追记为 resolved（人工接管走集成器 manual 模式，actor=main-agent）；blocked = 待裁决/待修复 |

监控不得把 scriptStatus=completed 当业务成功——engineOutcome 才是引擎结论层（六层结论并存见 V12，人工接管不覆盖引擎事实）。

## legacy 只读期收尾（未绑定 legacy 包，旧引擎只读并存）

legacy 包（章节 JSON 无 conformance 绑定、未 cutover）暂由旧引擎 design-code-sync-loop 收尾（issue 循环形态，契约见其 frontmatter 与 git 历史版本的本文件）；其入口第一步执行「cutover 拒启检查」——已切换包旧引擎拒启。legacy 包切 v2 的路径（M5）：补 conformance 绑定 → v2 首跑建覆盖率分母 → cutover 标记 + 旧 final 归档（按 worktree 扫描 `<name>.sync/` 与 `<name>.rendered.sync/` 两变体，改名 final.legacy.json + tombstone 指针）→ 复活通道 = v2 Unarchived 解档（cutover 标记保留，旧引擎恒拒启）。

## 手工降级路径

workflow 未就绪时手工执行 v2 语义（不推荐——状态仓与集成器门径无法手工等价复现）：**第一步执行 cutover 检查**（读 `~/.agents/skill-data/tech-design/<slug>/<name>/cutover.json`，命中即停回并指向 design-code-sync-v2，不写任何旧产物）；随后按义务表逐条跑 checker（机械命中判定 + 语义派发）、fail 义务按分流走 sandbox 补丁或文档提案，事件与证据形态参照 conformance-plane/README.md——手工路径产出的证据必须经 kernel appendCommands 入流才算数（绕过事件流的结论不进覆盖率）。

**处置记录义务**：终态处置与用户裁决 append 到 `<name>.ledger.md`；v2 派生报告落 `<designPkg>/v2/`（u-m5 渲染器接管，引擎只产四层结论返回值）。
