# D0 编译 — 设计包 → 执行数据结构（编译器驱动）

> 一次性判断性工作（主 agent 亲为）：运行编译器把 impl-plan.json（唯一计划权威）确定性编译为执行产物，替代逐字段手工拼装。产物：`<name>.exec-plan.json` + `<name>.prompts/*.md` + 初始 `<name>.status.json` + `<name>.runlog/` 目录 + `<name>.ledger.md` 头部初始化（dev 模式）；acceptance 模式在同一份 exec-plan 上填 `acceptance.nodes` 与 verify wrapper（执行进度产物 status.json / runlog / ledger 不重写）。全部落 dev-flow 段（HOME 下天然不入 git）。段内目录按寻址双形态：单仓形态 = `<project-slug>/`（现行平铺，路径不变）；workspace 形态（同仓多个 worktree 同父目录）= `<ws-slug>/<worktreeName>/`（worktree 级隔离，status 与 git 对账、断点恢复绑定该 worktree 的检出状态）。两种 slug 由编译器内嵌寻址探针按 projectRoot 自动派生，不手算（算法与约定见 `skill-data-addressing.md`——`<zsw-skills 检出根>/skills/self/dev-workflow/references/skill-data-addressing.md`；算法唯一权威源 = `workflows/src/skill-data.shared.ts` NODE_PROJECT_ADDRESS）；设计包落 tech-design 段（workspace 形态为 `<ws-slug>/`，工作区级共享）。项目内 `.tmp/dev-flow/` 未整体废弃——acceptance/plan-mode 脚本族的既有用法不属本流程产物。交付体系任务的阶段推进由 delivery-core next 裁决（转移表唯一权威）。

## 编译清单（编译器驱动，按序执行）

### 1. 跑编译器（dev 模式）

```bash
# 独立设计任务（在项目根运行——编译器从 cwd 的 git 仓库根取 projectRoot，从同一 git 取 baseline HEAD）
node ~/.agents/skills/dev-flow-v6/scripts/compile-exec-plan.mjs --impl-plan <tech-design 段>/<slug>/<name>.impl-plan.json
# 交付体系任务（--task-dir 附加增量归属断言入任务书 + 校验三段核对透传）
node ~/.agents/skills/dev-flow-v6/scripts/compile-exec-plan.mjs --impl-plan <tech-design 段>/<slug>/<name>.impl-plan.json --task-dir <交付任务目录>
```

编译器一次完成（顺序即依赖）：①渲染一致性前置门（spawn `tech-design-v6/scripts/render-impl-plan.mjs <plan> --check`——渲染视图与 JSON 不同源即中止，FAIL 形态按渲染器错误消息路由）；②寻址探测派生产物根；③读 dev-flow-v6 SKILL.md frontmatter version 实值作 `skillVersion`、`git rev-parse HEAD` 作 `baseline`；④units → dev 节点（testCommand 从 `testPlan.incrementalCommands[]` 提取归一 `{program,args}`、wave 拓扑分层）+ `processReviews[]` 声明 → review 节点（无声明不生成）；⑤逐单元任务书与过程 reviewer 任务书生成；⑥初始 status.json / runlog / ledger 初始化；⑦`--task-dir` 的增量契约与验收绑定核对在写盘前执行（归属不全 / 绑定陈旧 = 语义缺口，不落盘任何产物）；⑧写盘前按 check-exec-plan 同口径预检 + 写盘后 spawn 真校验器（`--task-dir` 透传 quality 段核对），PASS 后自动重建 verification-index.json（exec-plan 同目录，禁手改——设计 §5.2「每次 exec-plan 生成后重建」；索引构建失败按语义缺口上报）并输出编译摘要 exit 0。exec-plan 带 `generatedBy`（生成器版本 + 输入哈希 + 生成命令），任务书头部带重新生成命令——生成物禁手改。

**dev 重编译判据**：盘上 status.json 含非 pending 节点（已有执行进度）时编译器缺省拒绝（重初始化会清零 status/runlog/ledger 的执行记录），确认放弃进度才带 `--reinit`；保留进度的修订走手修 exec-plan 对应字段 + ledger 登记（手工段同理：已有进度不能回重编译，按校验门路由手修后重跑校验门）。

### 2. 处理语义缺口（编译器 exit 1 时）

编译器全部缺口收集齐一次报完（三段式：哪个输入不合法 → 权威源 → 恢复动作），**全体不生成**。处置纪律：语义修订回上游（impl-plan / 设计包 / 交付任务目录）改完重新编译，**不手修生成物**；手修会在下次重编译时被覆盖或被 `--check` 判不一致。常见缺口与去向：

| 缺口类别 | 去向 |
|---|---|
| 渲染视图与 JSON 不同源 / 渲染必填字段缺失（错误列缺失路径） | 按渲染器错误消息恢复（重跑无 `--check` 渲染命令 / 回 tech-design-v6 T3 对照 `tech-design-v6/references/impl-plan-mapping.md` 补字段）后重新编译 |
| 单元无 testCommand 来源（`testPlan.incrementalCommands[]` 无覆盖条目） | 回 tech-design-v6 T3 把该单元测试命令写成 incrementalCommands 条目 |
| `isolation=worktree` 单元未声明 `units[].cwd` | 回 T3 补 worktree 绝对路径，或改回 plain |
| `processReviews[]` unitId 不在 units[] | 回 T3 修正或删除声明 |
| verifyAsset="new" 的实装单元未完成 | 等 D1 该单元 done 后重跑 acceptance 编译（资产就绪判据，不猜完成态） |
| wrapper 调用契约不完整（runner/scenario 未声明、flags 超界） | 回 T3 对照项目 verification skill API 契约文档登记后重编译；契约不明的行改判 inspect-only |
| 依赖环 / territory 重叠无依赖路径 / 增量归属与命令不一致（校验器 cycle / overlap / increments 类） | 回 tech-design-v6 T3 修 impl-plan；增量增删改回 delivery-v6 递增验收版本重批 |
| 验收绑定不一致（binding 类） | 回 tech-design-v6 T1 入口门（flow/write.md Step 0）重新影响审查并更新 meta.json acceptanceBinding |
| 关联声明未落 territory / 分属不同 dev 节点 / exempt 缺理由（assoc 类） | 回 tech-design-v6 T3 修 impl-plan.json associations（归并同节点 / 补 territory / 补 rationale）后重编译——手修 exec-plan 会在重编译时复现 |
| 单字段形态错（territory 形态 / ref 引用 / 白名单 / noop 命令 / cwd / script / testPlan / 路径占位符，field 类） | 无执行进度 → 手修 exec-plan 对应字段后重跑校验门（值转抄自 impl-plan 的须同步修上游，否则重编译复现）；已有执行进度 → 不能回重编译（重初始化清零执行记录），手修 + ledger 登记；结构性缺漏（schema、缺数组类 field）→ 回编译器重编译 |
| 质量契约缺口（quality 类） | 回 tech-design-v6 T2 修设计包 s4-accept.json（criterionMechanisms / verificationBindings） |

### 3. 机器校验（编译器内联 PASS 后的独立复跑入口）

编译器已内联「生成即校验」（写盘前同口径预检 + 写盘后 spawn 真校验器）。需要独立复跑（如手工改上游后核对、D3 发起门）时：

```bash
node ~/.agents/skills/dev-flow-v6/scripts/check-exec-plan.mjs <exec-plan 绝对路径> [--task-dir <交付任务目录>]
```

stdout `PASS` 才继续（交付体系任务须带 `--task-dir`，缺传即跳过增量契约、验收绑定与质量契约三段核对）。校验集与 W2 引擎 validatePlan 及 W3 启动契约同源，漂移由差分测试机器对账拦截（`node --test scripts/tests/check-exec-plan-parity.test.mjs`，zsw-skills 检出内执行）。FAIL 逐行 `FAIL: <分类>: <明细>`，按上表路由；值转抄自 impl-plan 的字段（testCommand / deps / 单元 id / territory）一律同步修上游，否则重编译复现。

### 4. L0 前置 + 环境准备（D3 前置项此时一并核；编译器不替代的执行期操作）

- L0 静态检查基线：lint / typecheck / 项目检查脚本在 baseline 上全绿记录（命令从项目 AGENTS.md / package.json scripts 真实读取，禁凭记忆编）
- 产物类条目编入 impl-plan `testPlan.artifacts`（引擎 Gate A 第一波并行预备；禁只标注不落位）——改完重跑渲染器 + 重新编译
- 覆盖矩阵骨架：从 impl-plan 范围声明表 × 验收计划表生成「单元声明范围 × 计划用例」骨架表落 dev-flow 段产物根下 `<name>.coverage.md`（D4 收尾时回填实际覆盖并处置 uncovered 区——补测试或登记理由）
- 章节映射锚点核对：逐条 read 设计文档核对 sectionMap 指向的 §N 实际存在，对不上停回 tech-design-v6 T3（不猜测）；单元任务书内的 designRef 锚点由执行 agent 开工前再核一次
- （进 D3 前）环境 smoke：场景依赖的每个环境面跑无 LLM 探针验证可用；项目 verification skill 提供环境体检脚本（doctor 类启动前体检）时纳入 smoke 探针清单；剧本 dry-run：机械断言先对样本数据跑通；bash 语义歧义点（管道子 shell 的 cwd 隔离、`$()` 剥尾换行、引号嵌套、**管道退出码陷阱**）逐行过一遍——验收/测试命令一律无管道形态 `cmd > log 2>&1; echo "EXIT=$?"`，判定读 EXIT 行 + grep 日志，禁止 `| tail`/`| head` 后跟 `$?`/`&&` 判定退出；采样管道复用检查：read 项目采样管道文档，已有脚本直接复用，新做法记录回写；多实例分配：互斥场景组绑独立 dev 实例（装配器端口段派生 + 独立数据目录）
- **verify 剧本每步汇总落盘 [MANDATORY]**：剧本骨架的 step 函数每步结束时向 `<artifactsDir>/summary.jsonl` 追加一行 JSON：`{"step":"<步骤名>","command":"<命令>","exitCode":<n>,"stats":"<vitest/断言统计行，可空>"}`——供 L4 inspect 以汇总文件为准核对（只读 summary、仅异常步骤读全文日志；实测 inspect 逐个全文读 19 份日志耗 259 万 token 占 D3 时长 85.7%，2026-09-29）。step 函数自身拿不到 artifactsDir 时由剧本头部变量注入

### 5. 验收资产就绪后跑编译器（acceptance 模式）

前置判据（全部满足才跑）：①dev 模式编译已完成（初始 status.json 在场）；②每个 L3 行的验证资产已实装并对样本数据实跑 exit 0（见「剧本实装硬门槛 [MANDATORY]」）；③`verifyAsset="new"` 行的实装单元已 done（status.json 判定，编译器自核）。然后：

```bash
node ~/.agents/skills/dev-flow-v6/scripts/compile-exec-plan.mjs --impl-plan <tech-design 段>/<slug>/<name>.impl-plan.json --mode acceptance [--task-dir <交付任务目录>]
```

编译器在同一份 exec-plan 上把 `mode` 改为 acceptance 并填 `acceptance.nodes`：L3 行 → verify 节点（verifyAsset="-" 时 script = impl-plan 登记的剧本本体；reuse:/new 且 runner/scenario 契约齐备时 spawn `gen-acceptance-wrapper.mjs` 生成 wrapper——清单由编译器组装落 `<name>.verify-assets.json`，wrapper 落 `<name>.verify/<nodeId>.mjs`）；L4 / inspect-only 行 → inspect 节点（任务书 + artifactsRefs + deps + verdict.json 判定书落点）；全部 verify 节点后自动追加汇总 inspect 节点（deps=全部 verify，判 pass/fail + 截图与 console 兜底 + 未决项汇入）；status.json / runlog / ledger 不重写。编译成功后自动重建 verification-index.json（exec-plan 同目录，禁手改——acceptance 节点此时才填实，索引由部分转完整）。验收分组、熔断判据、inspect 返回契约等语义判据见下节。**D3 发起门**：acceptance 编译 PASS 后、发起 W2 验证实例化前跑校验门（`check-exec-plan.mjs <exec-plan 绝对路径>`；不传 `--task-dir`——增量契约与验收绑定核对在 dev 模式门已完成）必须 PASS 再发起。

## 语义判据（编译器承载结构事实，判断归人与上游）

### impl-plan 编译消费字段（D0 消费的 additive 可选字段登记处）

渲染字段权威 = `tech-design-v6/references/impl-plan-mapping.md`；下表是 D0 编译消费的最小可选字段（设计 §6.2 第 6 条：只把 D0 无法推导且必须人工决定的字段补入 impl-plan），权威登记 = 编译器脚本头注同名节：

| 字段 | 用途 |
|---|---|
| `units[].designRef` | 设计章节锚（任务书「单元目标」段；缺省空串，编译摘要警告） |
| `units[].cwd` | isolation=worktree 单元的 worktree 绝对路径（plain 单元恒 null） |
| `processReviews[]` | 过程审查声明 `[{unitId, script?, promptFile?, mechanism?}]`——review 节点唯一来源，无声明不生成 |
| `commitTemplate` | 缺省 `<type>(<scope>): {unitId} — {summary}`（占位符 {unitId}/{summary} 必含） |
| `formNotApplicable[]` | 反例场景不适用豁免登记 `[{adversarialFormId, rationale}]` 逐字转抄（理由须说明为什么构造不出，不是偷懒不建） |
| `acceptancePlan[].script` | verifyAsset="-" 行的剧本本体绝对路径（此时必填，引擎 node 直跑） |
| `acceptancePlan[].runner` / `.scenario` | wrapper 调用契约 `{path, flags}` / `{path}`——flags 显式声明逐字为准（仅 `--repo/--artifacts-dir/--name/--run-id` 之内），未声明或超界即缺口不生成（禁止猜参数） |
| `acceptancePlan[].artifactsDir` | 产物目录绝对路径；缺省推导 `<产物根>/<name>.artifacts/<行id>` |
| `acceptancePlan[].unit` | verifyAsset="new" 行的实装单元 id（此时必填；status.json 该单元 done 判资产就绪） |
| `testPlan.incrementalCommands[]` | dev 节点 testCommand 唯一提取权威（`{incrementId, unitIds[], command}`）；`testPlan.incremental` 文字段是阅读视图不作提取源 |

### 过程审查（kind=review）三态与触发判据

**kind=review（过程审查节点，渐进式 review；dev 模式专用，acceptance 模式禁）**：显式审查依赖——审查不过后继保持 pending，未审代码不会先解锁后继。机器检查（script）三态：exit 0 通过（未配 promptFile 时直接 done；配了也不派 reviewer，过程记录 noop）、exit 1 机器红灯（入统一失败处理中心，机器能判的不派 reviewer）、exit 2 分析能力不足（派 reviewer 兜底；未配 promptFile 则 failed——unknown 不得当通过）。reviewer 触发三条件：无 script（高风险声明驱动必审）/ script exit 2 / 上游 dev 节点自报 deviations 非空（计划外改向，任务书自动附偏离原文）。失败处置与 disputed 反证复用统一失败处理中心（过程语义：只写 process-review.jsonl，不写交付 FindingRaised、不计修复轮）；修复 diff 波及已 done dev 节点时引擎机器重验其 testCommand，转红才重置重派（修复失效规则）。reviewer 任务书由编译器按声明生成（声明缺 promptFile 时按「任务书要素基准」模板；声明了 promptFile 则逐字转抄外部文件）——排除清单缺失是中间态误报的最大来源。

### territory 互斥口径

每单元 territory = 允许改动的文件/目录清单（相对该节点 cwd 所在 git 仓库根，禁绝对路径与空格/括号混合形态）。粒度到目录或文件族即可，运行时不逐文件核验（改动对账由核验对账事件、终态残留核查与 D2 一致性审查承接）。两职责：①启动互斥断言——任意两单元声明重叠且无依赖路径会被拒绝启动（并行写冲突防线，实测曾致同文件双写、归属互污）；②DAG 编排参考。必然连带产物（pnpm-lock.yaml、配套测试文件、授权连带修改）建议一并登记供对账归属；声明路径在磁盘不存在的目录级前缀可接受（运行中诞生的文件天然覆盖）。

### 增量契约（交付体系任务）

dev 节点 `incrementId` 从 units 逐字转抄；归属全覆盖、引用存在、testCommand 逐字一致三判据由校验器 `--task-dir` 门核对（判据同 tech-design-v6 flow/plan.md「增量契约对齐」节）。增量归属与命令转抄问题回 T3 修；增量的增删改属技能①职权，回 delivery-v6 递增验收版本重批。

### 验收分组规则

- 验收计划表逐行：**L3 → verify 节点**（script = 剧本或 wrapper + artifactsDir）；**L4 / inspect-only → inspect 节点**（任务书 + artifactsRefs + deps；项目有 verification skill 时真机驱动一律经其进行，禁绕过技能裸驱动）；**L0/L1/L2 不编译成节点**——已由 D1 单元测试与 D2 Gate A 覆盖，D3 入口门引用 Gate A 证据（HEAD 未前进则免重跑）。混合行拆行（确定性部分降 L3 先行，判断行依赖它）在上游 T3 拆好，编译器按行 level 直接编译
- 分组按「组」列呈现；熔断判据 = 依赖可达性（设计 §8.7；核心短路 haltOnCoreFail 已退役被引擎忽略，`groups` 字段保留仅为旧 exec-plan 兼容）
- **inspect 任务书返回契约 [MANDATORY]**（编译器生成模板已内置）：`{verdict: "pass"|"fail"|"degraded", test_evidence, deviations:[], blockers:[]}`，**禁写 status 字段**——引擎按 verdict 分流（fail→failed；pass/degraded→核锚后 done）；判定书 JSON 必须落 `<artifactsDir>/verdict.json` 且文件内 verdict 与结构化返回一致（引擎以此文件为 done 事实锚，增量重跑对既有 done 也核此锚）。写成 status 双承载两义会使 agent 把「执行完成」报成 done 吞掉 FAIL 结论（2026-10-04 taiji D3 A10 实证）
- **fail 先查排障文档**（inspect 任务书已内置）：验收失败先 read 项目排障文档（典型 docs/TROUBLESHOOTING.md）归因，禁不归因重试、禁放宽断言
- **开发期 e2e**：验收计划表「单元 committed 后」时点的项，当前编译器不自动补编——此类项在 impl-plan 把命令登记进该单元的 incrementalCommands（随单元执行）或按手工降级路径补编为 dev 模式 verify 节点
- **一次性 vs 可复用分流**：验收脚本按一次性（迁移/特殊环境/本设计特有）vs 可复用（进项目 e2e 资产）分流落位

### 剧本实装硬门槛 [MANDATORY]

verify 节点引用的每个 script 文件必须在 acceptance 编译完成前已写好并对样本数据跑通过（exit 0）——编译器只核文件存在与契约形态，不替跑剧本；留占位引用 = 给 D3 埋启动即炸的雷（引擎启动校验 verify 节点 script 必须存在；曾实测留占位引用 batch-rerun.mjs 未实装，D3 无法按默认形态发起，被迫全程手工）。wrapper 形态下「已写好跑通」= 剧本本体实跑过 exit 0（reuse 态以场景库登记时的实跑证据为准，new 态在实装单元内实跑）；剧本确实写不出的行，回 impl-plan 改判 L4 判断行并标注——禁止引用未来文件。

### wrapper 生成与 runner 契约（gen-acceptance-wrapper.mjs）

引擎与剧本进程之间只有 script 路径一个通道（`node <script>` 直跑，无参数、无 per-node env），项目 verification skill 的场景剧本必须经其 runner 加载——verify 节点 script = wrapper 文件（生成产物，头部带输入哈希防手改，禁手改）。编译器 acceptance 模式组装清单并 spawn `gen-acceptance-wrapper.mjs`（模板、防手改 `--check`、契约校验全部由该生成器承担，`--help` 为清单 schema 权威）。边界：只建模四旗（`--repo/--artifacts-dir/--name/--run-id`），runner 支持的 flags 须在 impl-plan 逐字显式声明，未声明/超界即缺口全体不生成（禁止猜参数，不建通用 runner 描述语言）；runner 必须是 node 脚本（.mjs/.js/.cjs）。**锚点对齐契约**：runner 必须把 `verdict.json` 与 `summary.jsonl` 镜像到 `--artifacts-dir` 根（引擎事实锚 `inspectVerdictAnchorOk` 读此根）——不具备镜像行为的 runner 不在 wrapper 范围，该行回 impl-plan 改判 inspect-only 或走手工 wrapper 并登记原因。**同一 verification skill 的 verify 节点串行成链**：编译器按 acceptancePlan deps 拓扑生成依赖边；无依赖声明的同 skill 节点并行启动有两条实测坑（同秒 runId 共享数据目录、并发争抢项目内共享构建产物——均由项目侧登记在其 API 契约文档），需要串行时在 impl-plan deps 里显式声明依赖边。wrapper 仅用于 verify 节点（勿配作 review 节点 machine-check——exit 2 会被引擎当「分析能力不足」语义）。

### 任务书要素基准（审查编译产物质量时对照）

dev 任务书（编译器生成模板）= 背景（项目根/计划路径/设计视图/designRef 锚/编号域约定——引用其他设计包同形编号一律带域前缀 `<包域>·<编号>`，防跨包撞号）+ 单元目标（职责/designRef/验收条款）+ 范围声明 + 验收基线（增量归属断言——`--task-dir` 时读交付任务目录 increments.json 的需求锚与应转绿命令/测试要求：仅跑 testCommand 及其触及测试、禁全量、覆盖不了在 deviations 申报且必须二选一闭环；契约类单元的契约测试含 error envelope 与边界用例）+ 返回契约（`{status, files_changed, test_evidence, deviations, blockers, summary}`；summary 末行「测试：<命令> 绿」承载 commitTemplate 的测试结论；强制字段无偏离填空数组）+ 约束（禁 git 写/范围声明/临时脚本清理/锚点开工核验/runlog 义务）。过程 reviewer 任务书 = 单元目标 + 验收基线 + 审查范围（本节点 diff + 直接调用方）+ 排除清单（后继节点 territory 事实）+ 负例说明 + 行为证据核对要求 + 返回契约 `{summary, problems[]}`——排除清单缺失是中间态误报的最大来源。

### worktree 合并排布（编译器不自动生成，语义判断保留）

DAG 含 worktree 单元（node.cwd ≠ projectRoot）且存在跨 cwd 依赖边时，必须显式排合并——编译合并节点（kind=dev，id 如 `merge-<worktree单元>`，promptFile=合并指令：核对 worktree 单元 commit → 按项目既有合并约定（无约定 git merge --no-ff）合入工作分支，拿不定先停问用户；testCommand=合并冒烟），下游集成单元 deps 指向合并节点；单 worktree 小计划可标注手工段由主 agent 执行并记录。引擎不做合并检测。合并节点是普通 dev 节点：`territory` 必填（抄录被合单元 territory；合并节点 cwd=projectRoot）、`deps` 必须含被合单元（territory 重叠放行前提 = 存在依赖路径）、合并指令写明核对 `git status` 无未预期残留、files_changed 按合并实际触及路径如实申报。多个 territory 重叠的 worktree 单元不得各编一个合并节点（两个合并节点 territory 重叠且无依赖路径同样被拒）——共用一个合并节点（territory 取并集、deps 列全部被合单元）或在合并节点之间加依赖边。当前编译器不生成合并节点：含 worktree 单元的 DAG 由主 agent 在编译后按上述判据手工补编（补编后跑步骤 3 校验门），或回 T3 调整拆分避免跨 cwd 依赖。

## 完成判据

dev 编译：exec-plan schema 完整（nodes 非空、每节点 promptFile 落盘、testCommand 可执行、真校验器 PASS）+ status.json 初始态落盘 + L0 基线绿。acceptance 编译：acceptance.nodes 填实（每个 L3/L4 行编译为节点或显式登记不编译理由）+ verify script 盘上存在 + D3 发起门 PASS。呈现编译摘要（单元数/wave 分组/验收节点数/wrapper 数）；后续推进由 delivery-core next 裁决（转移表唯一权威），D1 发起形态见 `flow/execute.md`。

**阶段事件观测（SKILL「阶段事件观测」节）**：D0 开始时分配 `task_id`（建议 = 设计包 `<name>`，D1-D6 全段共用）并经 `~/.agents/scripts/workflow-observe.mjs` 记 `--stage D0 --step compile` 的 start，编译完成后记 end；进 D1 时发起 W2 传同一 `taskId` + 新 `executionId`（建议 `D1-<发起时点短时间戳>`）。

## 历史重放与防手改核对

- `--check`：按当前 impl-plan 重生成并与盘上产物比对（exec-plan 深比较、任务书逐字节；status.json 是执行态载体不适用，显式跳过；wrapper 检查委托 gen-acceptance-wrapper `--check`；verification-index.json 的防手改由索引工具自身 `check` 子命令承担，不在编译器 `--check` 范围）。不一致报差异 + 重新生成命令——手修生成物的发现入口
- `--replay-compare <旧 exec-plan 路径>`：历史只读重放（设计 §7.7）——按旧文件 mode 用当前输入重新生成（不写盘）并逐字段比对报告差异；不推断旧执行行为，对照旧流程实际执行须另行输入旧 status.json、事件、summary.jsonl 等执行记录。baseline / generatedBy 差异属输入快照与溯源字段的自然演进，不是手改信号

## 手工降级路径（编译器不可用时；语义等价）

编译器不可用（脚本故障/环境受限）时按原手工序列，语义判据全部沿用上文：

1. 渲染一致性校验：`node ~/.agents/skills/tech-design-v6/scripts/render-impl-plan.mjs <plan.json> --check` PASS 才继续
2. 手拼 exec-plan（schema：version=1 / skillVersion 读 SKILL.md frontmatter 实值 / mode / projectRoot（绝对路径）/ workspaceRoot（工作区形态才填）/ planPath / designDocPath（从 impl-plan.designDoc 目录拼 `.rendered.md`）/ baseline=git rev-parse HEAD / statusPath / testPlan（fullSuite 必填 {program,args} + artifacts 产物类条目）/ commitTemplate（含 {unitId}/{summary}）/ nodes（dev：id/kind/deps/wave 拓扑分层/incrementId 转抄/cwd=null（worktree 单元填绝对路径，禁仓库子目录）/designRef/territory/testCommand/promptFile；review：script 与 promptFile 至少其一）/ processReviewPath（交付体系任务指向 `<taskDir>/process-review.jsonl`）/ associations 逐字转抄 / acceptance 空壳 `{nodes:[],groups:{core:[],nonCore:[]}}` / formNotApplicable）——路径占位符：`<tech-design 段>` = `~/.agents/skill-data/tech-design/`、`<dev-flow 段>` = `~/.agents/skill-data/dev-flow/`（写入时展开为绝对路径）；slug 经寻址探针实得不手算
3. 逐节点任务书：按「任务书要素基准」手写每单元 `<unitId>.md` 与 reviewer 任务书（dev 节点三段式全文：背景/目标/验收（返回契约 JSON）/约束）
4. 初始 status.json：`{name, baseline, updated:<ISO>, skillVersion, nodes:{<unitId>:{status:"pending",attempts:0}}, events:[]}`（含 review 节点）；runlog 目录与 ledger 头部初始化
5. 校验门 + L0 前置 + 环境准备 + 验收编译：跑步骤 3 校验门 PASS；按「验收分组规则」把 L3/L4 行手工编译为 acceptance.nodes（wrapper 按本节第 2 步清单形态手拼后跑 `gen-acceptance-wrapper.mjs --assets <清单> --out <exec-plan 同目录>/<name>.verify`，生成后同命令加 `--check` 防手改）；完成后重跑校验门
