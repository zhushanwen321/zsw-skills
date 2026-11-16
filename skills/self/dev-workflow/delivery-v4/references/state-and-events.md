# 事件、状态与失效范围

`events.jsonl` 是事实事件唯一权威；`verdict.json` 是裁决器根据当前验收、当前 revision 与事件重新计算的派生结果，禁止手改。每条事件带 Ed25519 签名（凭据文件中的角色私钥签出，公钥在 task.json）；evaluate 逐条验签。

## 事件词表（19 类）

| 事件 | 签署角色 | 含义与关键绑定 |
|------|----------|----------------|
| AcceptanceReviewed | assurance | 验收独立审查完成；绑 acceptanceVersion + 验收包哈希 + intentSha256 + 策略快照哈希 + 结论（pass/reject） |
| AcceptanceApproved | user | 某版验收被批准；四元组同上 + reviewEventId（指向通过的审查） |
| DesignApproved | user | 方案包确认；绑包文件哈希清单（packageFiles）与决策参照 |
| ImplementationRecorded | builder | 增量在某指纹下实现完成；附合并回执（起始指纹、合并后指纹、补丁哈希） |
| EvidenceRecorded | assurance | 某需求或断言某证据类型的结论；schema 2 附 assertionIds/adversarialFormIds；绑 artifact 内容哈希（禁止覆盖写） |
| FindingRaised | builder/assurance | 登记发现；category=defect/boundary、severity、关联需求（可空）；非 blocker 附 consequenceRefutation；重开附 reopenOf；可附来源阶段与回归测试 |
| FindingResolved | assurance | 发现解决（当前指纹有效）；boundary 的确认也走此事件，附对照论证 |
| ResolutionReaffirmed | assurance | 原解决事件在当前 revision 的逐项重认领；必须有原解决事件与复核依据，不允许只凭全量测试绿 |
| ExplorationCompleted | assurance | 探索审查完成；绑覆盖维度 + 冻结清单哈希 |
| AssuranceCompleted | assurance | 独立保证完成；mode=full/recheck；绑本轮证据事件 id 集 + 探索事件 id + 逐增量测试回执 + 干净构建记录（按策略） |
| AssuranceRevisionDrift | assurance | 保证期间指纹漂移；setup/finalize 指纹与序号，按链计数 |
| RepairRoundRecorded | builder | 一次实现性修复开始；绑轮次、触发 finding、受影响断言与修复报告；第 4 轮触发 process-failed |
| RiskAccepted | user | 接受具体缺口；绑 gapId（missing 派生 / 证据事件 id / findingId）与当时证据状态 |
| RiskPreauthorized | user | 预授权指定类别 non-blocker finding 的风险接受范围与名额；blocker 与 requirement 目标不可预授权 |
| PolicyUpgraded | user | 策略升级；绑旧/新快照哈希与逐事件失效范围声明 |
| RevisionBaselineConfirmed | user | 人工确认新基线；漂移计数此后归零重计 |
| IndependentTaskDeclared | user | 独立任务声明；绑 intent 哈希与当时全部未替换任务清单 |
| TaskSuperseded | user | 任务替换 prepare/committed 两段；predecessor 绑 task.json/verdict/openFindings 哈希与继承发现 |
| TaskSupersedeCancelled | user | 恢复型取消；绑被取消 prepare 的事件 id 与被取消任务身份 |

相同事件重复追加幂等；角色权限由策略包 roles.json 约束（加载信任边界：技能安装目录 + 用户级，项目仓库不可覆盖）。

## 失效范围（逐事件）

| 事件 | 有效范围 |
|------|----------|
| AcceptanceReviewed / AcceptanceApproved | 当前 acceptanceVersion + 验收包哈希 + intentSha256 + 策略快照哈希；同组合后发 reject 使旧通过失效 |
| DesignApproved | 当前 acceptanceVersion（方案包变化经哈希清单声明，技能③入口核对） |
| ImplementationRecorded | 按 acceptanceVersion 有效，跨 revision 保留；当前行为仍含增量由 AssuranceCompleted 回执兜底 |
| EvidenceRecorded | 当前版本 + 当前 revision；schema 1 同需求×同类型取最后一条，schema 2 同断言×同类型取最后一条 |
| FindingRaised | 按版本持久（继承发现同语义且跨版本持久） |
| FindingResolved | 当前版本 + 当前 revision；新 revision 自动重开 |
| AssuranceCompleted / ExplorationCompleted | full 必须绑定当前 revision 探索；recheck 可引用同验收版本历史探索，但必须有当前 revision 的定向覆盖报告与全量确定性测试回执 |
| RiskAccepted | 当前版本 + 当前 revision 且 gapId 与当前缺口一致；缺口内容变化即失效 |
| AssuranceRevisionDrift / RevisionBaselineConfirmed / IndependentTaskDeclared / TaskSuperseded / TaskSupersedeCancelled / PolicyUpgraded | 持久事实 |

## 判定式（两个终态）

- **accepted** = 批准有效（四元组一致 + 审查未被 reject 击穿）＋ 全部增量实现 ＋ 每条必需断言的**每类证据** verified（schema 1 仍为每条必需需求）＋ 当前指纹的保证完成（回执覆盖全部增量、退出码 0、绑定事件可追溯、按策略附干净构建）＋ 探索完成（如要求）＋ 无未决 defect ＋ 无未确认 boundary ＋ 未进入 process-failed。
- **accepted_with_risk** = 上述条件中，逐缺口豁免：每个未 verified 的「需求×证据类型」都有绑定该缺口 gapId 的有效接受（且需求 riskAcceptable=true），每个未决 defect 有有效接受；boundary 不可接受风险；至少存在一项具体接受。两类证据缺口各自需独立接受。

缺口 gapId：完全缺失 = (acceptanceVersion, requirementId, evidenceKind, revision, "missing") 确定性派生；partial/failed = 对应证据事件 id；finding = findingId。

## 状态与 nextAction（优先级路由）

| 优先级 | 条件 | state |
|--------|------|-------|
| 0 | task.json 有 supersededBy 标记 | superseded |
| 0.5 | task.json 有 supersedeCancelled 标记 | supersede-cancelled（不可交付终态） |
| 1 | 本任务流有 prepare 无 committed | supersede-pending（禁止批准与交付） |
| 2 | 无有效批准 | draft |
| 3 | 已批准、完整路径、无 DesignApproved（非只核验） | design |
| 4 | 漂移链超上限 | revision-unstable |
| 4.5 | 需要第 4 轮实现性修复，或累计不同 must-fix 达到第 11 条 | process-failed（停止正常修复，不得交付） |
| 5 | 必需需求存在未接受 failed 证据 | implementing |
| 6 | 存在未接受 blocker defect（无关联需求者触发全量增量修复） | implementing |
| 7 | 已批准且零实现 | acceptance-approved |
| 8 | 增量未齐 | implementing |
| 9 | 未接受 non-blocker defect | candidate |
| 10 | 未确认 boundary | candidate |
| 11 | partial/missing 缺口未全部接受 | candidate |
| 12 | 缺保证或探索 | candidate |
| 13 | accepted 完整公式满足 | accepted |
| 14 | accepted_with_risk 公式满足 | accepted_with_risk |

非必需需求出现 failed 不阻终态，但 verdict.nonRequiredFailures 必须披露。

## 漂移链计数

连续漂移链 = 前一条 finalize 等于后一条 setup、且最新一条 finalize 等于当前 revision 的漂移序列长度；只统计最近一次 RevisionBaselineConfirmed（或任务起点）之后、最近一次成功 AssuranceCompleted 之后的漂移。**预期修复豁免**：当前 revision 等于最新实现事件合并回执的 toRevision 时（builder 合并后的稳定状态）不计漂移；当前 revision 超出实现指纹且无衔接链时计一次失败保证（按 (实现事件, revision) 去重）。链超策略 maxDriftChain（默认 2）进 revision-unstable。

## 信任边界（如实声明）

凭据机制防：无凭据伪造、跨角色误写、审查省略、无独立证据却拿 accepted。不防：同一操作系统用户下的恶意进程（可读凭据、改公钥、回滚事件流重签）。用户防线 = A 档重算复跑 + B 档独立抽查产品行为；verdict 哈希由用户在任务目录外保存参照。
