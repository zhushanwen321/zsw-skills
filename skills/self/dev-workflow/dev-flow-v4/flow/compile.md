# D0 编译 — 设计包 → 执行数据结构

> 一次性判断性工作（主 agent 亲为），替代此后每单元的重复手工编排。产物：`<name>.exec-plan.json` + `<name>.prompts/*.md` + 初始 `<name>.status.json` + `<name>.runlog/` 目录 + `<name>.ledger.md` 头部初始化，全部落 dev-flow 段（HOME 下天然不入 git）。段内目录按寻址双形态：单仓形态 = `<project-slug>/`（现行平铺，路径不变）；workspace 形态（同仓多个 worktree 同父目录）= `<ws-slug>/<worktreeName>/`（worktree 级隔离，status 与 git 对账、断点恢复绑定该 worktree 的检出状态）。两种 slug 由寻址检测探针按 projectRoot 自动派生，不手算（算法与约定见 `skill-data-addressing.md`——`<zsw-skills 检出根>/skills/self/dev-workflow/references/skill-data-addressing.md`）；设计包落 tech-design 段（workspace 形态为 `<ws-slug>/`，工作区级共享）。项目内 `.tmp/dev-flow/` 未整体废弃——acceptance/plan-mode 脚本族的既有用法不属本流程产物。完成后进 D1。

## 编译清单（按序执行）

### 1. 双格式一致性校验（fail-fast）

读 `.impl-plan.json`，逐项与 `.impl-plan.md` 核对：单元数 / 单元 id 集 / 依赖边数 / 验收项 id 集 / **每个单元的范围声明（territory）清单**（粒度到目录或文件族即可，与 §2 territory 声明条款同口径）。不一致 → 停，回 tech-design-v4 T3 修双格式（不猜测哪边是对的）。

### 2. exec-plan.json 生成

```jsonc
{
  "version": 1,                        // schemaVersion（数据契约版本）——消费方唯一执行裁决依据，保持路由角色不变
  "skillVersion": "<dev-flow-v4 SKILL.md frontmatter version>",   // 产物溯源字段：本 exec-plan 由哪个技能版本编译产出；只读溯源不参与执行裁决（读文件取真实值，不凭记忆写）
  "mode": "dev",                       // dev（D1）| acceptance（D3）
  "projectRoot": "<项目根绝对路径>",      // 引擎缺省 cwd；W2/W3/W4 的节点 git 操作基准（执行位置绑定一次编译）；节点 cwd 为 null 时用
  "workspaceRoot": "<工作区根绝对路径>",  // 可选：工作区形态填（工作区根 = 各 worktree 的父目录），单仓项目省略——additive 字段，缺省不拒执行、不参与执行裁决。寻址与统计按它派生工作区级地址；节点 git 操作仍用 projectRoot
  "planPath": "<tech-design 段>/<slug>/<name>.impl-plan.json",
  "designDocPath": "<tech-design 段>/<slug>/<name>.rendered.md",   // 渲染视图（W3 reviewer / 终态同步的阅读锚点；权威源 = <name>/ 设计目录六章节 JSON——从 impl-plan.designDoc 目录拼 .rendered.md；tech-design-v4 不产出裸 md 主文档）
  "baseline": "<git rev-parse HEAD>",
  "statusPath": "<dev-flow 段>/<slug>[/<worktreeName>]/<name>.status.json",
  "testPlan": {                        // 从 impl-plan.json 的 testPlan 继承（W3 Gate A 消费，缺失即 fail-fast）
    "incremental": "…",                // 可选：修复组核验用的增量测试
    "fullSuite": { "program": "pnpm", "args": ["…"] },  // 必填：项目全量命令（含 lint/typecheck，从项目配置真实读取合成；复杂多命令封装为脚本走 bash）
    // program 白名单（引擎启动 fail-fast）：W2 testCommand = pnpm/npm/node/git/bash；W3 fullSuite/artifacts = pnpm/npm/node/bash
    "artifacts": [{ "id": "build-e2e", "command": { "program": "…", "args": ["…"] } }]   // 可选：产物类条目（Gate A 起始第一波并行预备——命令确定、结果确定、被验证类消费；禁现用现建）
  },
  "commitTemplate": "<type>(<scope>): {unitId} — {summary}",   // 占位符 {unitId}/{summary} 必含（dev 模式引擎校验；acceptance 模式不 commit 可省略）；summary 内容契约 = 任务书要求 dev 返回的 summary 末行含「测试：<命令> 绿」
  "nodes": [
    { "id": "u-foundation", "kind": "dev", "deps": [], "wave": 1,
      "incrementId": "inc-1",           // 交付体系任务必填（从 impl-plan units[].incrementId 逐字转抄 = increments.items[].id；步骤 3 --task-dir 门核对归属全覆盖与 testCommand 一致）；独立设计任务省略本字段
      "cwd": null,                      // null = projectRoot；worktree 单元填 worktree 绝对路径。禁填仓库子目录——引擎启动断言 cwd == git rev-parse --show-toplevel，子目录会被拒绝（porcelain 相对 cwd / territory 相对仓库根，基准错位）
      "designRef": "§3.2",              // 设计章节锚（从 impl-plan 章节映射提取；commit 渲染时前置于 summary——老三要素保真：unit id + 设计章节 + 测试结论）
      "territory": ["packages/shared/src/..."],   // 相对该节点 cwd 所在 git 仓库根（与 files_changed / porcelain 同基准；禁绝对路径——引擎启动校验拒绝）
      "testCommand": { "program": "pnpm", "args": ["-C", "packages/shared", "test"] },
      "promptFile": "<dev-flow 段>/<slug>[/<worktreeName>]/<name>.prompts/u-foundation.md" },
    { "id": "review-u-foundation", "kind": "review", "deps": ["u-foundation"],   // 可选：过程审查节点（渐进式 review），挂在实现节点与后继之间——审查不过后继不解锁
      "mechanism": "dependency-recheck",   // 可选：过程记录机制标记（machine-contract/machine-registry/machine-build/dependency-recheck；缺省 machine-check）
      "script": "<projectRoot 相对>/check-assoc.mjs",   // 可选：机器检查（exit 0 通过 / 1 红灯入失败处理中心 / 2 分析能力不足→派 reviewer）；与 promptFile 至少其一
      "promptFile": "<dev-flow 段>/<slug>[/<worktreeName>]/<name>.prompts/review-u-foundation.md" }   // 可选：过程 reviewer 任务书；无 script = 高风险声明驱动必审
  ],
  "processReviewPath": "<交付任务目录>/process-review.jsonl",   // 可选：过程审查记录落点（交付体系任务指向 taskDir 供 delivery-quality-stats 读取；缺省由 statusPath 推导 <name>.process-review.jsonl）
  "associations": [                     // 可选：三类关联声明（从 impl-plan.json 同名字段逐字转抄；本门对账）
    { "id": "assoc-1", "kind": "contract", "trigger": "<生产方文件，相对仓库根>", "related": ["<消费方文件>"], "action": "co-change" }
  ],
  "acceptance": {                       // D3 实例化时生成（本步先空着）
    "nodes": [],                        // kind=verify（script/artifactsDir）| inspect（promptFile/artifactsRefs/deps）
    "groups": { "core": [], "nonCore": [] }   // core/haltOnCoreFail 已退役被引擎忽略（依赖可达性熔断为唯一判据，设计 §8.7）——字段保留仅为旧 exec-plan 兼容
  },
  "formNotApplicable": [                // 可选：反例场景不适用豁免登记（合并稿 §4.1「允许记录不适用理由」）——验收包里未进 acceptancePlan/D3 节点的场景逐条登记，带非空理由即豁免「进节点」要求；理由须说明为什么构造不出，不是偷懒不建
    { "adversarialFormId": "AF-…", "rationale": "…" }
  ]
}
```

- **路径占位符**：`<tech-design 段>` = `~/.agents/skill-data/tech-design/`，`<dev-flow 段>` = `~/.agents/skill-data/dev-flow/`（两者写入 exec-plan 时展开为绝对路径）；`<slug>` = 单仓形态的 project-slug 或工作区形态的 ws-slug，`<worktreeName>` 只在 workspace 形态出现。取值经寻址检测探针（projectRoot 输入）实得，不手算；算法与双形态约定见 skill-data-addressing.md
- **wave** = 编译期展示分组（拓扑分层编号，人看进度用；**调度只看依赖边，wave 不是边界**）
- **kind=review（过程审查节点，渐进式 review；dev 模式专用，acceptance 模式禁）**：显式审查依赖——审查不过后继保持 pending，未审代码不会先解锁后继。机器检查（script）三态：exit 0 通过（未配 promptFile 时直接 done；配了也不派 reviewer，过程记录 noop）、exit 1 机器红灯（入统一失败处理中心，机器能判的不派 reviewer）、exit 2 分析能力不足（派 reviewer 兜底；未配 promptFile 则 failed——unknown 不得当通过）。reviewer 触发三条件：无 script（高风险声明驱动必审）/ script exit 2 / 上游 dev 节点自报 deviations 非空（计划外改向，任务书自动附偏离原文）。失败处置与 disputed 反证复用统一失败处理中心（过程语义：只写 process-review.jsonl，不写交付 FindingRaised、不计修复轮）；修复 diff 波及已 done dev 节点时引擎机器重验其 testCommand，转红才重置重派（修复失效规则）。reviewer 任务书由主 agent 构造，内容 = 单元目标（designRef 设计章节行号）+ 验收基线（本单元 increments 归属断言与应转绿测试）+ 审查范围（本节点 diff + 直接调用方）+ 排除清单（后继节点才落地的已知中间态，逐条列出）+ 负例说明（什么不算问题）+ 行为证据核对要求（共享状态 / 异步时序 / 外部交互的高风险单元：核对测试实际构造了入口、初始状态、故障与时序，不只核对测试清单）——排除清单缺失是中间态误报的最大来源
- **associations（三类关联声明，可选）**：kind = contract（事件/schema/接口的生产方↔消费方）/ registry（登记源↔第二登记处）/ build-artifact（构建源↔壳与双平台产物）。action=co-change 要求 trigger 与 related 全部落在同一 dev 节点 territory 内（本门 FAIL: assoc——跨文件契约改动必须同节点覆盖，否则另一侧漏改在过程中不可见）；action=exempt 必须带非空 rationale（为什么刻意不同步、由哪个审查通道兜底）。调用/import 关系不在这里声明——由 review 节点 script 调 `check-associations.mjs recheck` 静态分析反查（exit 0 无声明外关联 / 1 有 / 2 分析能力不足，与节点三态一致）；运行期同步核对用 `check-associations.mjs check`（trigger 改了 related 没同步改 → exit 1）
- **processReviewPath（可选）**：过程审查记录 JSONL 落点（append-only：审查结论、机制标记、裁决、disputed、修复波及重验结果；独立于交付 events.jsonl，不进 must-fix 预算与修复轮计数）。缺省由 statusPath 推导（`<name>.process-review.jsonl`）
- **testCommand** = 每节点增量测试命令（T1 形态：program + args 拆开；含管道/&& 的复杂命令落临时脚本走 bash 通道）——从 impl-plan §4 测试计划逐单元提取
- **cwd** = worktree 隔离单元（判据见 references/dag-authoring.md）填 worktree 绝对路径，其余 null。禁填仓库子目录：引擎启动断言 cwd 必须等于其所在 git 仓库根（projectRoot 与 worktree 根都满足），子目录直接拒绝启动
- **territory 声明（2026-09-29 裁决范围声明降级）**：每单元登记允许改动的文件/目录清单——粒度到目录或文件族即可，运行时不再逐文件核验（改动对账由核验对账事件、终态残留核查与 D2 一致性审查承接）。声明仍承载两职责：①启动互斥断言——任意两单元声明重叠且无依赖路径会被拒绝启动（并行写冲突防线，实测曾致同文件双写、归属互污）；②DAG 编排参考。必然连带产物（pnpm-lock.yaml、被改模块的配套测试文件、授权连带修改）建议一并登记供对账归属。声明路径在磁盘不存在的目录级前缀可接受（运行中诞生的文件天然覆盖）

### 3. exec-plan 校验（fail-fast，生成即校验）

```bash
node ~/.agents/skills/dev-flow-v4/scripts/check-exec-plan.mjs <exec-plan 绝对路径>   # 独立设计任务
node ~/.agents/skills/dev-flow-v4/scripts/check-exec-plan.mjs <exec-plan 绝对路径> --task-dir <交付任务目录>   # 交付体系任务（验收任务门通过的必选形态：附加三段核对——①增量契约核对：读交付任务目录 increments.json，逐增量核 dev 节点 incrementId 归属全覆盖、引用存在、testCommand 逐字一致（判据同 tech-design-v4 flow/plan.md「增量契约对齐」节）；②验收绑定核对：读设计包 meta.json（从 exec-plan designDocPath 推导）与交付任务目录 acceptance.json，核 acceptanceBinding 与当前批准一致——acceptanceVersion 相等 + 验收包联合哈希（acceptance.json + increments.json 解析内容规范 JSON 的联合 sha256，与 delivery-gate acceptancePackageSha256 同源）复算比对 + taskDir 同一目录（入口门判据 1 的机器载体；判据同 tech-design-v4 flow/plan.md 入口自检第 4 条）；③质量契约核对：主校验与①②全过后调 delivery-v4 check-quality-contract 并追加传 --design-dir（设计目录，从 designDocPath 推导），覆盖机制对账（s4-accept.json criterionMechanisms）与测试绑定（verificationBindings）一致性——判据同 tech-design-v4 T2 质量契约门）
```

stdout `PASS` 才继续步骤 4（交付体系任务须带 `--task-dir`，缺传即跳过增量、验收绑定与质量契约三段核对 = 入口门判据 1 与 3 未执行）。校验集与 W2 引擎的 validatePlan 及 W3 启动契约（testPlan / 必填字段 / 白名单）同源，错误文案逐字一致，漂移由差分测试机器对账拦截（`node --test scripts/tests/check-exec-plan-parity.test.mjs`，zsw-skills 检出内执行）。FAIL 逐行输出 `FAIL: <分类>: <明细>`（全部报完再退出），按分类路由处置：

- 单字段错误（`territory` 形态 / `ref` 引用名 / `whitelist`、`noop` 命令形态 / `cwd`、`script`、`testPlan` / 路径层级与占位符类 `field`）→ 手修 exec-plan 对应字段后重跑本门；值转抄自 impl-plan 的字段（testCommand / deps / 单元 id）同步修 impl-plan 上游，否则重编译复现
- 结构性缺漏（`schema`、缺数组缺必填的 `field`）→ 回步骤 2 重编译（尚无节点执行过时；已有进度改手修 + ledger 登记，重初始化会重置 status.json / runlog / ledger）
- `cycle` 依赖环 / `overlap` territory 重叠无依赖路径 → 回 tech-design-v4 T3 修 impl-plan 后重走本清单——手修 exec-plan 会确定性复现同类错误
- `increments` 增量契约 / `binding` 验收绑定 → 增量归属与命令转抄问题回 tech-design-v4 T3「增量契约对齐」节修；binding 不一致（验收版本或验收包已变化、设计包绑定陈旧）回 tech-design-v4 T1 入口门（flow/write.md Step 0）重新影响审查并更新 meta.json acceptanceBinding——验收内容变化属技能①职权，不在 exec-plan 侧改
- `quality` 质量契约 → 机制对账（criterionMechanisms）与测试绑定（verificationBindings）缺口回 tech-design-v4 T2 修设计包 s4-accept.json（两者是 T2 产物）
- `assoc` 关联声明（trigger/related 未落任何 dev 节点 territory / 分属不同 dev 节点 / exempt 缺理由 / 枚举与路径形态）→ 回 tech-design-v4 T3 修 impl-plan.json associations（归并同节点 / 补 territory / 补 rationale）后重编译——手修 exec-plan 会在重编译时复现
- `io:`（exec-plan 路径不存在或不可读）/ `json:`（JSON 语法错）自解释类——核对路径 / 修语法后重跑本门

运行时环境断言（cwd == git rev-parse --show-toplevel、promptFile / verify script 盘上存在、projectRoot 存在）仍由 W2 引擎 setup 在派发前 fail-fast——promptFile 本清单下一步才构造，静态门不查存在性，正确计划不会恒红。

### 4. 逐节点 promptFile 构造

每单元一个 `.prompts/<unitId>.md`，内容 = 三段式任务书全文：背景（项目根/计划路径/章节映射坐标/本单元职责·范围声明·验收条款/设计文档对应节摘录/编号域约定——本设计包的编号（场景/单元/裁决/验收项等 id）在文档与注释中裸用，引用其他设计包（历史代次或并行包）的同形编号一律带域前缀标注（形态 `<包域>·<编号>`，存量形态「V1·D6」），防止跨包同号撞号——同形编号并存会让终态同步审查逐条误报/漏判归属/项目 AGENTS.md 与测试策略文档路径）/ 目标（含测试要求：测试 = 仅跑 testCommand 及其触及的测试文件，明写禁止包级全量套件与跨包扫描——全量回归由 D2 Gate A 统一承担，testCommand 覆盖不了改动行为时在 deviations 申报、不自行扩跑，且申报条目必须二选一闭环：更新设计包 s4-accept.json verificationBindings / impl-plan acceptancePlan 的测试绑定，或申报由 D3 独立验收节点承接（写明节点与场景 id）——只申报缺口不闭环视同未完成，D2 入口对账逐条打回；验收条款逐条达成；契约类单元的契约测试含 error envelope 与边界用例）/ 验收（返回契约 JSON：`{status, files_changed:[精确路径], test_evidence, deviations:[], blockers:[], summary?}`——summary = commit message 摘要（末行「测试：<命令> 绿」承载老三要素的测试结论，§2 commitTemplate 契约依赖它），deviations 强制字段无偏离填空数组；宿主无 structured-output 工具时在回复中用 json 代码块返回同构对象，解析失败视同本次汇报无效打回重报）/ 约束（范围声明清单/禁 git 写/临时脚本清理/开工前校验章节映射指向的节实际存在，对不上停工上报/过程记录义务：临时待办·需裁决事项·复盘观察随时 append 到 `<name>.runlog/<unitId>.md`（任务书内写绝对路径；一行一条 `[HH:MM] 类型: 一句话事实`，不替代 JSON 返回契约——SKILL「运行记录」节））。

### 5. 初始 status.json + 运行档案初始化

```jsonc
{ "name": "<name>", "baseline": "<HEAD>", "updated": "<ISO>",
  "skillVersion": "<dev-flow-v4 SKILL.md frontmatter version>",
  "nodes": { "u-foundation": { "status": "pending", "attempts": 0 } },
  "events": [] }
```

初始 `status.json` 的 `skillVersion` 同 exec-plan 口径（产物溯源字段，只读；引擎回写链构造性保留该字段——W3 events 追加探针仅在字段缺失时补写引擎版本，不覆盖已有值）。

运行档案两件（SKILL「运行记录」节——引擎启动幂等重建，D0 初始化覆盖手工路径）：`<name>.runlog/` 空目录（agent 过程记录落点，任务书引用其下 `<unitId>.md`）；`<name>.ledger.md` 写入文件头一行说明（`# <name> 未决事项与裁决处置档案——引擎终态与主 agent 处置记录追加于此`）。

节点字段 = `status` / `attempts`（终态回写附 `commit?` / `evidence?`）；status 合法值 = `pending / in-progress / done / blocked / failed`，终局另写 `suspended`（从未派发的挂起节点——人读恢复时按 pending 对待重跑）。引擎回写保留 name/updated 顶层字段；恢复对账双向：标 done 无 commit → 回 pending（其已 done 的直接/传递后继一并回 pending——后继的验证结论基于已消失的 commit，属陈旧验证）；有 commit 未记 → 引擎按 git log 匹配单元 id 补写 done（status.json 缺失时初始重建后同样反查 git log，不重跑已交付单元）。终局另写一条汇总事件 {node:"-", event:"run-terminal", detail:"terminated=…; done/blocked/skipped 计数"}（人读恢复入口）。

### 6. L0 前置 + 环境准备（D3 前置项此时一并核）

- L0 静态检查基线：lint / typecheck / 项目检查脚本在 baseline 上全绿记录（命令从项目 AGENTS.md / package.json scripts 真实读取，禁凭记忆编）
- 产物类条目编入 testPlan.artifacts（引擎 Gate A 第一波并行预备，见 §2 testPlan 注释；禁只标注不落位）
- 覆盖矩阵骨架：从 impl-plan 范围声明表 × 验收计划表生成「单元声明范围 × 计划用例」骨架表落 dev-flow 段产物根（workspace 形态 `<ws-slug>/<worktreeName>/`，单仓形态 `<project-slug>/`）下的 `<name>.coverage.md`（D4 收尾时回填实际覆盖并处置 uncovered 区——补测试或登记理由）
- 章节映射锚点核对：逐条 read 设计文档核对 §N 实际存在，对不上停回 tech-design-v4 T3（不猜测）
- （进 D3 前）环境 smoke：场景依赖的每个环境面跑无 LLM 探针验证可用；项目 verification skill 提供环境体检脚本（doctor 类启动前体检）时纳入 smoke 探针清单；剧本 dry-run：机械断言先对样本数据跑通；bash 语义歧义点（管道子 shell 的 cwd 隔离、`$()` 剥尾换行、引号嵌套、**管道退出码陷阱**）逐行过一遍——`cmd | tail; echo $?` 取的是管道末段（tail）的退出码，主命令失败会被判绿，验收/测试命令一律无管道形态 `cmd > log 2>&1; echo "EXIT=$?"`，判定读 EXIT 行 + grep 日志，禁止 `| tail`/`| head` 后跟 `$?`/`&&` 判定退出；采样管道复用检查：read 项目采样管道文档，已有脚本直接复用，新做法记录回写（进管道文档），禁现场重写管道；多实例分配：互斥场景组绑独立 dev 实例（装配器端口段派生 + 独立数据目录）
- **verify 剧本每步汇总落盘 [MANDATORY]**：剧本骨架的 step 函数每步结束时向 `<artifactsDir>/summary.jsonl` 追加一行 JSON：`{"step":"<步骤名>","command":"<命令>","exitCode":<n>,"stats":"<vitest/断言统计行，可空>"}`——供 L4 inspect 以汇总文件为准核对（只读 summary、仅异常步骤读全文日志；实测 inspect 逐个全文读 19 份日志耗 259 万 token 占 D3 时长 85.7%，2026-09-29）。step 函数自身拿不到 artifactsDir 时由剧本头部变量注入

本步编入完成后（含产物类条目编入 `testPlan.artifacts`）重跑步骤 3 校验门（`node ~/.agents/skills/dev-flow-v4/scripts/check-exec-plan.mjs <exec-plan 绝对路径>`）确认 PASS 再进步骤 7。

### 7. 验收编译规则（为 D3 预生成 acceptance 面）

验收计划表逐行：**L3 → verify 节点**（script = 剧本路径，artifactsDir）；**L4 → inspect 节点**（promptFile 任务书含「确定性产物已就绪」指针 + 逐节点 `<artifactsDir>/summary.jsonl` 汇总路径——核对以汇总为准、仅异常步骤读全文日志，deps 指向其 verify 前驱；任务书驱动约束：项目有 verification skill 时真机驱动一律经其进行（发现规则同 tech-design-v4 T3：`verify-*` 前缀 + Launch/Drive 节，AGENTS.md 声明优先），禁绕过技能裸驱动）；**L0/L2 不编译成节点**——已由 D1 单元测试与 D2 Gate A 覆盖，行标注「已覆盖」，D3 入口门引用 Gate A 证据（HEAD 未前进则免重跑）。混合行拆行（确定性部分降 L3 先行，判断行依赖它）。分组按「组」列；熔断判据 = 依赖可达性（设计 §8.7；核心短路 haltOnCoreFail 已退役被引擎忽略）。

**verify 节点 script 落实（impl-plan verifyAsset 三态；verifyAsset = "-" 即项目无 verification skill 时不适用本段——script = D0 实装的剧本本体路径，不走 wrapper）**：引擎与剧本进程之间只有 script 路径一个通道（`node <script>` 直跑，无参数、无 per-node env），而项目 verification skill 的场景剧本必须经其 runner 加载——因此 verify 节点的 script = D0 生成的 **wrapper 文件**，不是剧本本体：

- wrapper 落 `<name>.verify/<nodeId>.mjs`（exec-plan 同目录，与 `.prompts/` 同模式），内容 = `spawnSync(process.execPath, [<runner 绝对路径>, <scenario 绝对路径>, '--repo', '<项目根>', '--artifacts-dir', '<节点 artifactsDir>', '--name', 'verify-<nodeId>', '--run-id', '<nodeId>-<时间戳>'], { stdio: 'inherit' })` 后 `process.exit(r.status ?? 1)`——全部参数 D0 已知写死；`--name`/`--run-id` 兜底隔离（runner 默认 runId 是秒级时间戳，同秒并发会共享数据目录）；runner 不认这些 flag 时省略之；生成后 `node --check` 过语法即可
- **同一 verification skill 的 verify 节点串行成链**：D0 编译时在 acceptance.nodes 内为它们加线性依赖边（按「依赖」列拓扑，无依赖的按编号串接）——并行启动有两条实测坑：同秒 runId 共享数据目录、并发 run 争抢项目内共享构建产物（两坑均已由项目侧登记在其 API 契约文档；不同 verification skill 或与其他类型节点并行不受限）
- **锚点对齐契约**：runner 必须把 `verdict.json` 与 `summary.jsonl` 镜像到 `--artifacts-dir` 根（引擎事实锚 `inspectVerdictAnchorOk` 读此根）——采用 wrapper 形态前核对项目 runner 具备该行为；不具备时 wrapper 在 spawn 后自行把这两个文件复制到 artifactsDir 根
- `reuse:` 态：scenario 绝对路径从 verification skill 场景库取（T3 已核 id 真实存在）
- `new` 态：D0 按其能力原语组装剧本 → 实跑 exit 0 → 入其场景库并把覆盖矩阵行改为可执行剧本态（下次交付即可 reuse）→ 同 reuse 生成 wrapper
- `inspect-only` 态：该行编译为 inspect 节点（同 L4 规则）

**剧本实装硬门槛 [MANDATORY]**：verify 节点引用的每个 script 文件必须在 D0 编译完成前已写好并对样本数据跑通过（exit 0）——D0 只填路径不写剧本 = 给 D3 埋启动即炸的雷（引擎启动校验 verify 节点 script 必须存在；曾实测留占位引用 batch-rerun.mjs 未实装，D3 无法按默认形态发起，被迫全程手工）。wrapper 形态下「已写好跑通」= 剧本本体实跑过 exit 0（reuse 态以矩阵登记时的实跑证据为准，new 态 D0 当场实跑）；剧本确实写不出的行，降级为 L4 判断行（promptFile 派 agent 按断言清单执行）并在验收计划表标注——禁止引用未来文件。

补编规则：

- **inspect 任务书返回契约 [MANDATORY]**：inspect 节点 promptFile 末尾的返回契约固定为 `{verdict: "pass"|"fail"|"degraded", test_evidence, deviations:[], blockers:[]}`（验收结论词，与 dev 节点的执行语义 `{status,...}` 契约不同源不同词——引擎按 verdict 分流：fail→failed，pass/degraded→核锚后 done），**禁写 status 字段**；判定书 JSON 必须落 `<artifactsDir>/verdict.json` 且文件内 verdict 与结构化返回一致——引擎以此文件为 done 事实锚（缺失/不一致按失败处理；增量重跑对既有 done 也核此锚，不通过回 pending）。任务书契约写成 PASS|FAIL|DEGRADED 或 status 双承载两义，会使 agent 把「执行完成」报成 done 吞掉 FAIL 结论（2026-10-04 taiji D3 A10 实证）
- **汇总 inspect 节点**：全部 verify 节点产物集中追加一个汇总 inspect 节点（deps=全部 verify 节点）——判 pass/fail + 扫全页截图与 console 兜底（脚本断言盲区由这步补偿）+ 扫各 verify 节点 report 中的未决项/未覆盖登记并汇入交付口径 + fail 归因定位到场景与日志行
- **一次性 vs 可复用分流**：验收脚本按一次性（迁移/特殊环境/本设计特有）vs 可复用（进项目 e2e 资产）分流落位
- **fail 先查排障文档**：验收失败处理写在 verify/inspect 节点 promptFile 约束——先 read 项目排障文档（典型 docs/TROUBLESHOOTING.md）归因，禁不归因重试、禁放宽断言
- **开发期 e2e**：验收计划表「单元 committed 后」时点的项编译为 kind=verify 节点插入 dev 模式 nodes（deps=所属 dev 单元）

**D3 发起门（生成即校验）**：acceptance 节点实例化落位、mode=acceptance 的 exec-plan 定稿后，发起 W2 验证实例化前跑同款校验（`node ~/.agents/skills/dev-flow-v4/scripts/check-exec-plan.mjs <exec-plan 绝对路径>`；acceptance 模式不传 --task-dir——增量契约与验收绑定核对在 D0 dev 模式门已完成（同一设计包同一任务目录），D3 门不重复核对验收节点）必须 PASS 再发起——schema 错误在编译点拦下并按步骤 3 同款路由处置，不留到引擎 setup 才爆。

## worktree 合并排布

DAG 含 worktree 单元（node.cwd ≠ projectRoot）且存在跨 cwd 依赖边时，D0 必须显式排合并——编译合并节点（kind=dev，id 如 `merge-<worktree单元>`，promptFile=合并指令：核对 worktree 单元 commit → 按项目既有合并约定（无约定 git merge --no-ff）合入工作分支，拿不定先停问用户；testCommand=合并冒烟），下游集成单元 deps 指向合并节点；单 worktree 小计划可标注手工段由主 agent 执行并记录。引擎不做合并检测。

合并节点是普通 dev 节点，按 dev 节点全契约编译——合并把被合单元的改动落进工作分支（merge commit 触及被合单元声明范围内的路径，冲突解决可能追加手修），属会产生文件写入的单元，不是纯 git 元操作：

- `territory` 必填：抄录被合 worktree 单元的 territory 清单（合并节点 cwd = projectRoot，territory 相对主仓根；worktree 检出与主仓同一仓库布局，相对路径一致），如 `"territory": ["packages/shared/src/..."]`。缺 territory 会被引擎启动校验拒绝（dev 节点 territory 必须非空），且落步骤 3 路由的 `field` 类——结构性缺漏回本清单重编译仍缺，必须在编译点写对
- `deps` 必须含被合 worktree 单元（如 `"deps": ["u-shared"]`）：合并节点 territory 与被合单元重叠，范围声明互斥断言放行的前提 = 两节点间存在依赖路径；缺 deps 会被 `overlap` 类拒绝
- promptFile 合并指令中写明：合并后核对 `git status` 无未预期残留；files_changed 按合并实际触及路径如实申报（合并自身已成 commit 时引擎核验走幂等分支不重复提交）
- 多个 territory 重叠的 worktree 单元（彼此已用依赖边串行）不得各编一个合并节点——两个合并节点 territory 重叠且无依赖路径同样被 `overlap` 拒；须共用一个合并节点（territory 取并集、deps 列全部被合单元），或在合并节点之间加依赖边

## 完成判据

exec-plan schema 完整（nodes 非空、每节点 promptFile 存在、testCommand 可执行）+ status.json 初始态落盘 + L0 基线绿。呈现编译摘要（单元数/wave 分组/验收节点数）后进 D1（发起 W2 或走 `flow/execute.md` 手工路径）。

**阶段事件观测（SKILL「阶段事件观测」节）**：D0 开始时分配 `task_id`（建议 = 设计包 `<name>`，D1-D6 全段共用）并经 `~/.agents/scripts/workflow-observe.mjs` 记 `--stage D0 --step compile` 的 start，编译完成后记 end；进 D1 时发起 W2 传同一 `taskId` + 新 `executionId`（建议 `D1-<发起时点短时间戳>`）。
