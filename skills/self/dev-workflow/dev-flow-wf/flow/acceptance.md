# D3 端到端验收 + D4 收尾交付

> D3 输入：D2 清零 + Gate A 绿。只做机器替代不了的验证。排序三原则：**核心先行、依赖解锁、共享状态互斥并行**。L0/L2 已由 D1/D2 覆盖（编译期标注「已覆盖」，入口门引用 Gate A 证据——HEAD 未前进免重跑，前进过只补增量）。

## D3 入口门 [MANDATORY]

1. status.json 全节点 done（或用户明示豁免单元逐个列名）
2. D2 清零 + Gate A 绿的证据在 status.json events 可查
3. L0 静态守卫全绿——引用 Gate A 时点证据（status.json events 的 gate-a-pass；HEAD 未前进则免重跑）
4. fail 回流重验场景：先声明重验范围——未触及共享接线点只重验影响面，触及则全量重来

## 分层铁律 [MANDATORY]

- L0 未清不进 L2；L2 不绿不派任何端到端；L3 能覆盖的场景不升 L4
- 机器可判定的修复（lint 报错、守卫红灯、悬空引用）在任何 agent 端到端之前清零——把它们留到 L4 才发现是最贵的返工路径
- 五级定义与各级执行者（L0 静态规则 → L1 增量单测 → L2 全量套件 → L3 脚本端到端 → L4 agent 端到端）见 SKILL.md 核心原则；成本不另打分，L 级即承载

## 执行形态

**W2 第二实例化（zcode 默认）**：`CreateWorkflow saved: wave-executor, args: { execPlan }`（mode=acceptance——节点 = verify/inspect，D0 已编译）。核心组 fail → haltOnCoreFail 挂起未派发节点 → 终态 core-failed + 归因；core-failed → 修复走 W2 修复节点形态或主 agent 派 fixer（重验子集 exec-plan），主 agent 只裁决与重发起。

**手工路径**：场景按 DAG 派发——L3 脚本（预编译剧本：操作 + 断言 + 全页截图 + console 抓取，产物落 `<name>.acceptance/<场景id>/`）并行跑；L4 判断型（任务书附确定性产物指针）依赖其前驱；核心组先行（组内依赖拓扑 + 无共享状态并行 ≤5），核心全绿后非核心解锁；混合行已拆行（编译期）。

- **核心短路**：任一核心场景 fail → 非核心挂起不追加，先进修复循环；**修复执行者 = fixer subagent / W2 修复节点形态**（主 agent 零编码，只裁决与重发起）；修复后重发起时 exec-plan 更新为重验子集（只跑受影响场景或所在互斥组）
- **修复独立性三态前置跑**：核心组缺陷出现时逐场景标三态（无已知缺陷=默认 / 独立于缺陷 N=修复窗口期旧实例前置跑，产物按旧实例标记 / 依赖缺陷 N=阻塞）——仅在「已出现核心缺陷 + 修复窗口时长 > 前置场景预估耗时」时启用
- fail → 先 read 项目排障文档（典型 docs/TROUBLESHOOTING.md，路径以 AGENTS.md 索引为准）匹配已知症状再进修复；blocked → 如实报告环境原因，禁 mock 冒充通过
- **一次性 vs 可复用分流**：可复用（核心 UI/主链路/长期维护面）→ 项目 e2e 目录 + 同 commit 登记测试静态文档；一次性 → `<name>.acceptance/` + status.json 记一笔
- **e2e 单测化**：能以 mock/fixture 重放等价覆盖的圈定项随所属单元沉淀 L1/L2 单测——长期方向逐步单测化（与 SKILL e2e 准则同源）

## D4 收尾（主 agent，不 workflow 化）

1. 全绿交付汇总：目标达成对照表 + 合理偏差登记表 + 残留风险 + 覆盖概览 + 剧本分流结果
2. 最终 commit（可复用 e2e spec、文档登记；impl-plan/exec-plan/status 不入 git——`.tmp/` 禁 add）
3. **功能分级登记同步**：新功能/新用例或「挂掉后果」变化 → 同 commit 更新（如 `docs/FEATURE-PRIORITIES.md`）；纯重构不触发；零触发也须汇报注明
4. **文档资产更新检查**：对照项目 AGENTS.md 文档索引按变更内容判定同 commit 更新（产品→PRODUCT / 拓扑→ARCHITECTURE / 术语→CONTEXT / 视觉→DESIGN / 规范→STANDARDS / 测试→TEST-STRATEGY / 排障→TROUBLESHOOTING；采样管道资产同 commit 回写）；零触发注明「文档资产零同步」
5. **ADR 复审**：对照本次交付复审（开发中拍板的重要决策漏登的补登记；既有 ADR 被推翻的修订）；核对来源优先 = 设计文档头部「关联登记面」字段（字段缺失按变更语义扫描兜底）；零触发注明「ADR 零同步」
6. [OPTIONAL] 用户指示时产物清理
7. **自动衔接 D5**：最终 commit 落地后进 `flow/sync.md`（仅用户明示跳过可免，跳过须记录）

## 失败状态的可视边界

任一环节不绿，交付口径 = 「未完成 + 差距清单」，禁止以部分通过宣称整体完成。
