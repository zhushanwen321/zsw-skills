---
name: workflow-authoring
description: >-
  Use when 新建或修改本仓 dev-workflow 的双平台 workflow（zcode .dwf.ts + pi .js，
  单源构建产物），或需要核对 workflow 的阶段事件观测接入、观测数据落盘与统计归集。
  触发词：「写 workflow」「新建双平台 workflow」「改 workflow 脚本」「观测接入」
  「观测 JSONL」「构建器报错」。Not for 发起/运行已有 workflow（用 CreateWorkflow 与
  dev-flow-wf / tech-design-wf 的流程文档）、查询某次执行的观测数据（直接读落盘
  JSONL 或跑统计脚本，见第 6 节）。
---

# workflow-authoring — 双平台 workflow 撰写与观测接入

本仓 `skills/self/dev-workflow/workflows/` 下每对双平台 workflow 脚本由三份源码经构建器
生成，阶段事件观测层在构建时拼进产物。本文是撰写与接入的操作规范：新建 workflow 从第 2 节
搭结构，接入观测走第 4 节五步，提交前过第 5 节门禁。

## 1. 适用范围

- 本仓 dev-workflow 双平台 workflow：源在 `skills/self/dev-workflow/workflows/src/`，
  构建器是 `scripts/build-workflows.mjs`（本文所有仓库相对路径均相对本仓检出根）。
- 其他仓库自建构建器时按同一套规范实施：公共观测层经安装 symlink 复用，不拷贝副本。
  实装先例：taiji 工作区仓把构建器放在 `<仓>/.agents/workflows/scripts/build-workflows.mjs`，
  其观测层路径指向 `~/.agents/scripts/workflow-observability.shared.ts`——这是本仓
  `skills/self/dev-workflow/workflows/src/observability.shared.ts` 的安装 symlink
  （symlink 安装命令见 dev-flow-wf SKILL.md「阶段事件观测」节的安装说明）。

## 2. 单源构建结构

三份源、两份壳、一个构建器：

| 文件（`workflows/src/` 下） | 角色 |
|---|---|
| `<name>.shared.ts` | 单源公共体：业务逻辑全文，TS 写法，无 import |
| `<name>.zcode.tpl.ts` | zcode 壳：`/* zcode-workflow */` frontmatter + 平台钩子 + `@@STITCH@@` 标记行 |
| `<name>.pi.tpl.js` | pi 壳：`/* @pi-meta */` 头 + JS shim + `SCHEMA_*` 常量 + `wfAgent` 适配 + `@@STITCH@@` 标记行 |

构建与产物（构建器 `node scripts/build-workflows.mjs`，默认全部 workflow）：

```
workflows/<name>.dwf.ts          zcode 产物 = 壳 + 观测层 + shared 原文（零转换）
workflows/pi/<name>.js           pi 产物 = 壳 + 改写管线处理后的 shared
~/.zcode/workflows/<name>.dwf.ts zcode saved 副本（CreateWorkflow 的 saved 发现目录，
                                 与仓内产物同内容，由构建器一并写入）
```

- **拼接**：壳里恰好一个 `@@STITCH@@` 标记行，构建器把它替换为观测层与 shared 全文
  （保持标记行缩进）。已接入观测的 workflow（shared 正文含 `initObservation` 调用点），
  观测层全文拼在业务正文之前——`obsCtx` 是 `let` 声明，业务顶层的赋值依赖声明在前。
- **pi 改写管线**（zcode 产物零转换，pi 产物过三步）：
  1. 词法安全改写：代码区的 `agent(` 全部改写为 `wfAgent(`（字符串、模板串、注释、
     正则字面量内不动）。原因：pi worker 以同作用域 `function` 声明注入平台 `agent`，
     壳里若有同名声明会静默覆盖它，壳内调用变成递归——改写后壳的 `wfAgent` 体内才能
     安全调用平台原生 `agent`。
  2. `.ask<T>(` 改写为 `.ask("T", `：TS 泛型参数转 typeKey 字符串，pi 壳据此查
     `SCHEMA_BY_KEY` 拿结构化返回的 JSON Schema。
  3. `typescript.transpileModule` 剥 TS（interface、类型标注、`as`、非空 `!`、泛型函数）。
- **产物禁止手改**：产物入 git 但属生成物，直接改产物会在 pre-commit 的
  `build --check` 被拦截（产物与重生成结果不一致）。改源后跑
  `node scripts/build-workflows.mjs` 重新生成。
- **saved 副本滞后 = 执行旧版**：zcode 的 CreateWorkflow 从 `~/.zcode/workflows/`
  发现 saved workflow，它滞后于仓内产物时实际执行的是旧脚本——构建器因此一并同步，
  `--check` 一并校验。

## 3. zcode GUI 硬约束

- **字面 `agent(` 调用点不得被包装函数遮蔽**。zcode GUI 泳道（GUI 里展示本次执行各
  subagent 的通道）按编译期静态分析预建，只认字面 `agent(name, persona)` 调用点：
  包一层函数再调用会让泳道失明，变量开头的 agent 名（如 `` `${t.label}-r${round}` ``）
  会让整条泳道显示「未命名子代理」。`agent(` 只在创建处调用、引用向下传；prompt 构造
  可以共享函数（tech-review-loop 与 wave-executor 的 shared 均如此实装）。构建器有
  对应断言：公共体未发现 `agent(` 调用点直接报错。
- **agent 名前缀互斥**：同一 workflow 内各 agent 名「第一个 `${` 插值之前的字面前缀」
  必须互不相同——GUI 泳道按该前缀渲染标签，两个角色共享前缀会渲染成同一个无法区分的
  短标签。实装形态 = 静态角色前缀 + 轮次/节点插值（如 `` `主审-r${round}` ``、
  `` `node-${node.id}` ``、`` `接替-${node.id}` ``）；推荐英文 kebab-case 的
  `<role>-<ctx>-<round>` 结构，role 词根在全 workflow 内唯一。
- 双平台产物对账（`scripts/check-workflow-parity.mjs`）把「agent 名模板静态文本序列
  按出现顺序两侧相等」列为零容忍强信号——agent 名在两侧产物必须逐点一致。

## 4. 观测接入五步

阶段事件观测回答「一次执行各阶段何时开始、何时结束、归哪个任务」。事件层公共实现在
`workflows/src/observability.shared.ts`（单一构建输入，业务 shared 禁止拷贝其副本），
构建时按第 2 节拼进产物。未接入观测的 workflow 会被构建器门禁报错（见第 5 节）。

**步 1：shared 源调观测 API**。按执行顺序：

1. `obsCtx = initObservation(skill, stage, attempt)` —— 签名
   `(skill: string, stage: string, attempt: number | null): ObsCtx | null`。
   `args.taskId` 与 `args.executionId` 同时提供才启用观测（都不传 = 关闭、业务照常；
   只传其一 = 告警并关闭）。`skill` 写所属技能的 canonical 名（`OBS_SKILLS` 词表：
   `tech-design-wf` / `dev-flow-wf`），不是 workflow 脚本名——统计入口按技能名过滤，
   写成 workflow 名会归不上类。`stage` 是流程阶段编号（`OBS_STAGES` 词表，允许字面量
   三元，如 wave-executor 按 exec-plan 的 mode 分叉 `"D1" / "D3"`）。`attempt` 未知时传
   `null`，检测确定后回填 `obsCtx.attempt`。调用点放在业务参数窄化之前——参数校验失败
   早退的执行也有 execution 边界。
2. home 探针成功后装配落盘路径：`obsAttachHome(homeDir)`（homeDir 由
   `world.run("node", ["-e", <homedir 探针>])` 取得；探针失败路径先
   `await obsCloseExecution("setup-failure")` 再返回业务错误）。
3. 执行级开始：`await obsEmit("execution", null, "start", null)`，随后
   `await obsBegin("setup", null)` 开第一个阶段。
4. 阶段配对：串行阶段用 `await obsBegin(step, round)` / `await obsEnd(step, round)`
   手工配对，或用 `await withStage(step, round, fn)` 包装器（begin → fn → end，
   fn 抛异常时自动补 `outcome=script-error` 的 end）。`step` 取自 `OBS_STEPS` 词表
   （`execution / setup / review / aggregate / fix / execute / finalize / gate-a / retire`，
   新步骤名先登记词表）；`round` 是循环轮次，无轮次传 `null`。
5. **穷举所有早退路径**：每条提前 `return` 的路径在 return 之前
   `await obsCloseExecution(<终态词>)`。`obsCloseExecution` 会给打开中的 step 补记
   end（outcome = 传入的终态词），再写 `execution` 的 end——所以打开中的阶段不需要
   也不能先手工 `obsEnd`。主流程正常出口在收尾段（finish / 最终 return 前一处）
   统一调用，终态词与业务返回的 `terminated` 字段一致（如 `converged / blocked /
   setup-failure`）。

**步 2：壳模板复制 O 区**。从现有 workflow 的壳复制观测平台钩子并按需调整：

- zcode 壳：`OBS_PROBE_NOW` / `OBS_APPEND_LINE` 两条 node -e 探针 +
  `obsNow()` / `obsAppend(filePath, line)` 两个钩子，经 `world.run` 执行。zcode 的
  `world.run` 是 journal 重放语义（resume 恢复执行时回放首次记录值、不重新执行），
  时间戳与事件序列跨 resume 稳定——观测依赖这个语义保证 resume 后 JSONL 不重复追加。
- pi 壳：同名 `obsNow` / `obsAppend`，但 pi shim 里的 `world.run` 是 `spawnSync`
  实写（无 journal 重放语义，每次调用真实执行）。平台执行语义差异留在壳里，
  事件契约在 shared——这是观测层只此一份、钩子按平台各写一份的原因。
- 两壳的参数声明各补三参：zcode frontmatter `args:` 与 pi `@pi-meta parameters:` 下
  声明 `taskId`（string）、`executionId`（string）、`sampleType`（string，
  production 真实执行缺省 / selftest 测试执行），描述写明命名规则（taskId 同时是
  观测落盘目录名、executionId 是 JSONL 文件名主干：字母数字开头，只含字母、数字、
  点、连字符、下划线，≤128 字符，禁「..」）。

**步 3：参数白名单补三参**。shared 的 `VALID_ARG_KEYS`（未知参数 fail-fast 校验，`_` 前缀宿主私有键除外）必须加入 `taskId / executionId / sampleType`，否则发起方传
观测参数会被「未知参数」检查直接拒绝。现有四个 workflow 的白名单里都有同一行注释（按这行注释定位要补三参的位置）：`// 观测（O 区，可选）：taskId+executionId 同时提供才启用（sampleType 默认 production）`。

**步 4：构建器与统计侧登记**。新 workflow 名、新 stage、新 step、新 skill 都要登记词表：

| 登记处 | 常量 | 内容 |
|---|---|---|
| `scripts/build-workflows.mjs` | `NAMES` | workflow 名（构建循环与 `--only` 的合法值） |
| 同上 | `OBS_STAGES` / `OBS_STEPS` / `OBS_SKILLS` | 阶段编号 / 步骤名 / canonical 技能名词表 |
| `scripts/workflow-observe.mjs` | `OBS_EVENT_FIELDS` 等 | workflow 外步骤手工记录命令的同一套契约（三源同步义务：改事件字段或词表必须三处同改——observability.shared.ts、build-workflows.mjs、workflow-observe.mjs） |
| `scripts/skill-usage-stats.mjs` | `SKILL_ALIASES` | workflow 名 → 所属技能名映射；漏登记则该 workflow 的观测事件在统计里归不上技能 |

**步 5：构建与测试**。依次：

```bash
node scripts/build-workflows.mjs                      # 生成三份产物（含 saved 副本）
node scripts/build-workflows.mjs --check              # 产物一致性 + 观测契约门禁
node scripts/check-workflow-parity.mjs                # 双平台产物对账（phase 名 / agent 名 / schema 字段强信号）
node scripts/check-workflow-types.mjs                 # zcode 产物按真实平台 facade 跑 tsc strict
node --test scripts/tests/workflow-observability.test.mjs   # 观测机制测试
```

`scripts/tests/workflow-observability.test.mjs` 须为新 workflow 补双平台真实产物执行
用例（transpile 后 vm 执行 zcode 产物、vm + require 注入执行 pi 产物），至少覆盖：
正常事件配对（start/end 成对、自然 end 无 outcome）、早退补终态（obsCloseExecution
的 outcome 正确）、不传观测参数静默关闭（业务照常、无 JSONL）、pi 与 zcode 事件序列
一致（除 timestamp）。

## 5. 检查门禁

`node scripts/build-workflows.mjs --check` 的观测契约检查（构建时逐 workflow 执行）：

- **已接入**（shared 有 `initObservation("...")` 调用点）：stage / step 实参过词表
  （允许字面量三元，非 stage 字面量在 `OBS_STAGE_LITERALS_IGNORE` 显式登记）；skill
  实参过 `OBS_SKILLS` canonical 词表；execution 级边界事件在场（`obsEmit("execution", ...)`）；
  `obsCloseExecution` 终态统一补记出口在场；`OBS_EVENT_FIELDS` 十字段在观测层在场
  （对照单一观测层）；zcode 与 pi 产物的 obsBegin/withStage 调用点集合与 shared 一致
  （pi 改写管线不应丢失观测调用点）。
- **未接入**：不在豁免名单 → 报错（计入 errors，`--check` exit 非 0，pre-commit 拦截）；
  在 `OBS_EXEMPT`（build-workflows.mjs 内紧邻 `NAMES` 的显式豁免名单，登记须附理由）→
  打印一行说明后跳过观测检查。豁免是显式决定，没有默认沉默的未接入状态。
- **pre-commit 自动触发**：staged 变更含 `skills/self/dev-workflow/workflows/` 下任何
  文件，或 `scripts/build-workflows.mjs` / `check-workflow-types.mjs` /
  `check-commit-contract.mjs` / `wf-facade.d.ts` 时，依次跑 `build --check`、
  parity、types（wave-executor 相关变更另跑提交契约往返测试）。hook 启用前提：
  `git config core.hooksPath .githooks`。

## 6. 数据落盘与读取

- **事件 JSONL**：每次执行一个文件
  `~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl`，
  逐行追加，并发执行互不干扰。字段全集（构建器按 `OBS_EVENT_FIELDS` 机器核对三源同步）：

  | 字段 | 含义 |
  |---|---|
  | `execution_id` / `task_id` | 单次执行标识 / 任务标识（文件名主干 / 目录名） |
  | `skill` / `stage` / `step` | canonical 技能名 / 阶段编号 / 阶段内步骤（`execution` = 执行级边界） |
  | `round` / `attempt` | 循环轮次 / 重发起序号（无则 null；启动早期自动检测未完成时 attempt 为 null） |
  | `event` / `timestamp` / `sample_type` | start 或 end / ISO8601 / production（缺省）或 selftest |
  | `outcome`（可选） | 只出现在终态统一补记或异常补记的 end 上，值 = 本次执行终态词或 abandoned / script-error |

- **平台 token 用量**：zcode 存 workflow 运行库、pi 存会话记录，两处存储经
  `agent-session-reader usage` CLI 统一读取（zcode `--zcode`、pi `--pi=<目录>`，
  用法见 `~/.agents/skills/agent-session-reader/SKILL.md`）。
- **聚合报告**：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs` 汇总四技能
  （tech-design-wf / dev-flow-wf / dev-merge / pr-cr-fix）的耗时与 token——观测事件
  直读观测根 JSONL，token 用量经 agent-session-reader 采集。`sample_type=production`
  缺省计入、`selftest` 默认排除（`--include-selftest` 显式计入）；统计按事件 `skill`
  字段过滤，新 workflow 记得步 4 的 `SKILL_ALIASES` 登记。

## 7. 参照实装索引

四个已接入观测的 workflow，按「想抄什么」选参照（各 shared 的 initObservation 调用点
与 obsBegin/withStage 分布可直接搜函数名定位）：

| workflow（所属技能 / stage） | step 词表 | 适合当什么参照 |
|---|---|---|
| tech-review-loop（tech-design-wf / T2） | setup / review / aggregate / fix / finalize | 多角色并行审查 + 聚合裁决循环；同名 agent 续聊做聚焦复审 |
| wave-executor（dev-flow-wf / D1 或 D3，按 exec-plan 的 mode 三元分叉） | setup / execute / finalize | DAG 节点并发调度 + 同名续聊打回；stage 按入参 mode 标注的写法 |
| dev-consistency-loop（dev-flow-wf / D2） | review / aggregate / fix / gate-a | attempt 由参数外置的循环；gate-a 终局门；无 setup/finalize 的紧凑 stage 结构 |
| design-code-sync-loop（dev-flow-wf / D5） | setup / review / fix / retire / finalize | 无 LLM 聚合层的矩阵环（矩阵行 = 脚本 concat）；伴生产物退役判定步 |
