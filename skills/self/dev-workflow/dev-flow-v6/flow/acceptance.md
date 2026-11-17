# D3 端到端验收 + D4 收尾交付

> 前置与合法转移由 delivery-core next 裁决（转移表唯一权威，见 delivery-v6 SKILL「交付事务内核」节）。D3 只做机器替代不了的验证。排序三原则：**核心先行、依赖解锁、共享状态互斥并行**。L0/L2 已由 D1/D2 覆盖（编译期标注「已覆盖」，入口门引用 Gate A 证据——HEAD 未前进免重跑，前进过只补增量）。

## D3 入口门 [MANDATORY]

入口前置与合法性由 delivery-core next 裁决（转移表唯一权威）——status.json 全节点 done（或用户明示豁免单元逐个列名）、D2 清零与 Gate A 绿证据、L0 静态检查全绿的逐项判定以 next 返回的 machineChecks 为准，不通过按其恢复动作处置，不在本文复述顺序。证据引用机制：L0 引用 Gate A 时点证据（status.json events 的 gate-a-pass；HEAD 未前进则免重跑）。fail 回流重验场景：先声明重验范围——未触及共享接线点只重验影响面，触及则全量重来。

## 分层铁律 [MANDATORY]

- L0 未清不进 L2；L2 不绿不派任何端到端；L3 能覆盖的场景不升 L4
- 机器可判定的修复（lint 报错、检查红灯、悬空引用）在任何 agent 端到端之前清零——把它们留到 L4 才发现是最贵的返工路径
- 五级定义与各级执行者（L0 静态规则 → L1 增量单测 → L2 全量套件 → L3 脚本端到端 → L4 agent 端到端）见 SKILL.md 核心原则；成本不另打分，L 级即承载

## 执行形态

**W2 第二实例化（zcode 默认）**：`CreateWorkflow saved: wave-executor-v6, args: { execPlan, taskId, executionId }`（mode=acceptance——节点 = verify/inspect，D0 已编译；观测参数同 D1，executionId 建议用 `D3-<发起时点短时间戳>` 区分两实例化，SKILL「阶段事件观测」节）。verify 节点 fail → **run 内自愈循环**（设计 §8.7，主 agent 零介入）：归因（spec-bug / product-bug / environment）→ spec-bug 由 fixer 修复验收资产后重跑该节点；product-bug **不修**，按依赖可达性判定——fail 节点的 DAG 后继闭包非空（卡住后续验收）→ 立即停止派发熔断上报，闭包为空（不卡）→ 记录跳过、其余节点跑完统一上报；environment 重试一次。自愈不收敛（maxRounds=10）同闭包判定。主 agent 只裁决与重发起；workflow 内任何 agent 禁止向用户提问（T9）。

**手工路径**：场景按 DAG 派发——L3 脚本（预编译剧本：操作 + 断言 + 全页截图 + console 抓取，产物落 `<name>.acceptance/<场景id>/`；项目有 verification skill 时剧本 = 其场景库资产，跑其 wrapper（D0 生成，见 compile.md「wrapper 生成与 runner 契约」节）或 runner 直跑；剧本按 compile.md「每步汇总落盘」规范向 `<artifactsDir>/summary.jsonl` 追加逐步结果）并行跑；L4 判断型（任务书附确定性产物指针 + 逐节点 summary.jsonl 汇总路径——核对以汇总为准、仅异常步骤读全文日志）依赖其前驱；核心组先行（组内依赖拓扑 + 无共享状态并行 ≤5），核心全绿后非核心解锁；混合行已拆行（编译期）。

- **失败处置（依赖可达性判据，2026-09-26 裁决）**：任一场景 fail 先进 run 内自愈循环（归因 → spec-bug 修复重验 / product-bug 不修 / environment 重试一次）；自愈不收敛或 product-bug 时计算 fail 场景的 DAG 后继闭包——非空（卡住后续验收）→ 立即停止派发、熔断上报；为空（不卡）→ 记录跳过、其余场景全部跑完统一上报。通用原则：处理不了的问题，不影响后续执行就先记录并跳过（记录落 `<name>.ledger.md`——手工路径主 agent 落笔，workflow 路径引擎终态笔已含）；影响后续执行则停止。主 agent 零编码，只裁决与重发起；重发起按 status.json 断点续跑
- **修复独立性三态前置跑**：核心组缺陷出现时逐场景标三态（无已知缺陷=默认 / 独立于缺陷 N=修复窗口期旧实例前置跑，产物按旧实例标记 / 依赖缺陷 N=阻塞）——仅在「已出现核心缺陷 + 修复窗口时长 > 前置场景预估耗时」时启用
- fail → 先 read 项目排障文档（典型 docs/TROUBLESHOOTING.md，路径以 AGENTS.md 索引为准）匹配已知症状再进修复；blocked → 如实报告环境原因，禁 mock 冒充通过
- **一次性 vs 可复用分流**：可复用（核心 UI/主链路/长期维护面）→ 项目 e2e 目录 + 同 commit 登记测试静态文档；一次性 → `<name>.acceptance/` + status.json 记一笔。项目维护 e2e 资产登记表（如 `docs/testing/e2e-map.json`）时，新增/变更用例同 commit 更新登记表并跑其校验脚本（以项目登记纪律为准）
- **e2e 单测化**：能以 mock/fixture 重放等价覆盖的圈定项随所属单元转化为 L1/L2 单测——长期方向逐步单测化（与 SKILL e2e 准则同源）
- **证据内容索引（节点执行后生成，禁手改）**：为 verify/inspect 节点的 artifacts 目录生成 evidence-bundle.json（原始记录与附属 artifact 的 path+sha256 清单）：

  ```bash
  node ~/.agents/skills/dev-flow-v6/scripts/gen-evidence-bundle.mjs --artifacts-dir <artifactsDir> --summary <summary.jsonl 路径> --verdict <verdict.json 路径>
  ```

  summary/inspect verdict 缺失的场景按实际存在登记（不报错）；纯命令场景（无汇总记录的普通命令）不传 --summary/--verdict，bundle 登记目录内 receipt.jsonl 为原始回执，不另生成第二份同语义回执。`--check` 核对全部引用文件存在与哈希可重算。L4 与独立保证核对优先读索引与 summary.jsonl 汇总（异常步骤统计 pass/fail/skipped 分开计数），仅语义判断需要时读完整日志或图像；索引不含 revision/断言绑定（归事件流），原始步骤结果不自动升格为 verified——登记 EvidenceRecorded 与交付判定仍走既有事件与 gate

## 候选反例审查（explore-only）[MANDATORY]

schema 2 交付任务的候选反例审查运行 `independent-assurance-v6`（args 增加 `mode: "explore-only"`；触发时点与进入合法性由 delivery-core next 裁决——转移表唯一权威）。该阶段由未参与设计和实现的探索审查者攻击完整候选实现，登记 ExplorationCompleted 与新发现，但不写 AssuranceCompleted。

- 机制与判据冲突回 tech-design-v6；反例场景或测试绑定缺失回 T3；实现缺陷回 D1/D2；判据遗漏回 delivery-v6 递增验收版本。
- 每条 must-fix 必须有回归测试和受影响一致性复核；修复后重跑受影响场景与全量确定性测试，并在新 revision 重新 explore-only。
- 非 must-fix 必须附 consequenceRefutation，不能只按判据字面合规降级。
- D4 实现登记的合法性判定（当前 revision 探索可用性、must-fix open 集）为内核判定单源，见 kernel-judgments（经 delivery-core CLI 消费），不在本文复述。
- schema 1 老任务不触发本阶段；schema 2 全部任务（与 exploratoryReview 风险字段无关）无条件触发，没有 not-required 豁免分支。

## D4 收尾（主 agent，不 workflow 化）

1. 全绿交付汇总：目标达成对照表 + 合理偏差登记表 + 残留风险 + 覆盖概览 + 剧本分流结果
2. 最终 commit（可复用 e2e spec、文档登记；impl-plan/exec-plan/status 落 `~/.agents/skill-data/`，HOME 下天然不入 git）
3. **增量实现登记（交付体系任务 [MANDATORY]；独立设计任务跳过本步）**：把候选实现按增量经意图命令 `record-implementation` 登记进交付任务事件流——裁决器与独立保证（independent-assurance-v6）都消费 ImplementationRecorded（缺登记时任务无法向交付终态推进，转移合法性由交付事务内核裁决）。与 candidate-build-v6 通道的分工：两通道最终落到同一事件流——candidate-build-v6 是无设计包的直建通道（引擎逐增量登记），本技能按设计包执行后由主 agent 在本步逐增量登记，命令与回执口径与其一致。逐增量（increments.json items[].id，增量归属单元以 D0 核对的 nodes[].incrementId 为准）执行；事件信封（type/actor/acceptanceVersion/revision）由 gate 构造，调用方只提交语义内容，不手工拼事件 JSON：

   ```bash
   node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs record-implementation \
     --task-dir <交付任务目录> \
     --increment-id <increments.items[].id> \
     --summary "<增量实现摘要：归属单元清单 + 测试结论一行>" \
     --artifact <交付任务目录>/evidence/implementation-<incrementId>.md \
     --merge-receipt '{"fromRevision":"<增量首个归属单元开工前的 revision（D0 基线或前一增量 toRevision）>","toRevision":"<增量全部归属单元 commit 后的 HEAD>","patchSha256":"<git diff --binary --full-index <fromRevision>..<toRevision> | shasum -a 256 的哈希>"}' \
     --credential <builder credentialId>
   ```

   - **凭据来源** = delivery-v6 `init` 输出的 builder credentialId（私钥在 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/builder.key`，只传凭据 id、不碰私钥本体）；actor 恒 builder——CLI 强制凭据角色与事件 actor 一致
   - **前置**：该增量全部归属单元 done 且增量 testCommand（D0 门已核对与 increments.json 逐字一致）重跑绿、工作树 clean（全部改动已 commit）——增量粒度汇总一笔，不逐单元登记；当前 revision 必须已有候选探索（explore-only 先行）且 must-fix 清零（登记门禁由 gate 与转移表裁决）
   - **实现报告** artifact 写 `<交付任务目录>/evidence/implementation-<incrementId>.md`（归属单元清单、commit 清单、测试输出摘要）
   - **合并回执**（`--merge-receipt`，JSON 对象字面量重传）：fromRevision = 增量首个归属单元开工前的 revision（D0 基线或前一增量 toRevision）、toRevision = 增量全部归属单元 commit 后的 HEAD、patchSha256 = `git diff --binary --full-index <fromRevision>..<toRevision> | shasum -a 256` 的哈希
   - **登记失败** → 停回处置：按 stderr 恢复动作处理（凭据失效走 delivery-v6 任务替换通道）；禁止跳过登记静默推进后续阶段
   - **发现桥接（D2/D3 终态未决项，SKILL「关键约束」发现桥接条）随候选交付同通道登记**：主会话经 `record-finding` 以 builder 凭据登记 FindingRaised——

     ```bash
     node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs record-finding \
       --task-dir <交付任务目录> --summary "<发现摘要>" \
       --category defect --severity blocker|non-blocker \
       --requirement-ids '["<关联需求 id>", ...]' \
       --artifact <发现报告路径> --credential <builder credentialId>
     ```

     （category=boundary 用于实现有意的边界申报，须附对照论证 `--consequence-refutation`；findingId 缺省由 gate 自动分配）
4. **功能分级登记同步**：新功能/新用例或「挂掉后果」变化 → 同 commit 更新（如 `docs/FEATURE-PRIORITIES.md`）；纯重构不触发；零触发也须汇报注明
5. **文档资产更新检查**：对照项目 AGENTS.md 文档索引按变更内容判定同 commit 更新（产品→PRODUCT / 拓扑→ARCHITECTURE / 术语→CONTEXT / 视觉→DESIGN / 规范→STANDARDS / 测试→TEST-STRATEGY / 排障→TROUBLESHOOTING；采样管道资产同 commit 回写）；verification skill 触达时转第 6 步专用流程，不在本步泛化处理；零触发注明「文档资产零同步」
6. **verification skill 同步检查（项目存在 verification skill 时执行，零触发注明「verification skill 零同步」）**：发现规则同 tech-design-v6 T3（项目 AGENTS.md 显式声明为唯一来源；2026-11-04 起废除 verify-* 前缀与 SKILL.md 内容特征探测）。触发 = 本次交付改动文件触达其覆盖矩阵登记的功能行：
   - 触达行增量回写：行为变化 → 改对应能力文档的断言/坑登记；新功能面 → 补条目；场景剧本与覆盖矩阵行状态同步——全部随最终 commit 同笔
   - 影响面实跑：只重跑本次被修改过的场景剧本（经其 runner 直跑，verdict 落新 run 目录）；未修改的剧本引用 D3 verdict 证据路径，零重跑——全量覆盖是维护 pass 的职责，D4 不做
   - 系统性漂移（多处能力文档与实现不符 / 本次大重构跨多域）→ 不在 D4 内修，登记 ledger 并在交付汇总建议单独跑项目维护技能全量 pass（如 `/maintain-verification-skill`，其目标发现规则与本条同源）；产品缺陷走 D3 的 product-bug 熔断语义，不混入 skill 同步
7. **ADR 复审**：对照本次交付复审（开发中拍板的重要决策漏登的补登记；既有 ADR 被推翻的修订）；核对来源优先 = 设计文档头部「关联登记清单」字段（历史文档同义旧字段名等同——凡头部以「关联登记」开头的字段即认作该字段；字段缺失按变更语义扫描兜底）；零触发注明「ADR 零同步」
8. **运行档案分流（SKILL「运行记录」节）**：read `<name>.runlog/` 全部文件与 `<name>.ledger.md`——ledger 未清项逐条分流到既有登记处（合理偏差 → 写 `.impl-plan.json` 的 `reasonableDeviations`、残留风险 → 写 `residualRisks`——两处均为映射表 JSON 字段落点，写后重跑渲染命令刷新 `.impl-plan.md` 视图（禁手改 `.impl-plan.md`）；决策 → ADR）或标注处置完成/记录丢弃理由，禁止档案与登记处双登记并存；runlog 有价值的过程发现（踩坑根因/方案取舍）择要进交付汇总作复盘素材；零未清项注明「档案已清」
9. [OPTIONAL] 用户指示时产物清理（运行档案默认保留）
10. **交付后衔接**：最终 commit 落地后，后续阶段推进由 delivery-core next 裁决（转移表唯一权威；终态同步见 `flow/sync.md`）——仅用户明示跳过可免，跳过须记录
11. **阶段事件观测终态记录（SKILL「阶段事件观测」节）**：D4 开始时经 `~/.agents/scripts/workflow-observe.mjs` 记 `--stage D4 --step finalize` 的 start，本步收尾后记 end；随后记 `step=execution` 的 start/end 对结束本次执行（end 带 `--outcome <终态词>`）。D0/D6 同理（stage=D0 / D6）；W2/W3/W4 的 D1/D2/D5 已内建观测，步骤边界由引擎写入

## 失败状态的可视边界

任一环节不绿，交付口径 = 「未完成 + 差距清单」，禁止以部分通过宣称整体完成。
