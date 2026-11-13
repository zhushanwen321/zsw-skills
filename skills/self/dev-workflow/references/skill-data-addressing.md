# skill-data 寻址与版本约定（dev-workflow 家族）

> 本文件是 dev-workflow 家族通用的 skill-data 约定：产物落盘目录的确定（寻址）与版本协议。其他技能并入 skill-data 约定时以本文件为入口。
>
> 本文件只写行为契约，不复制实现——**算法权威源 = `skills/self/dev-workflow/workflows/src/skill-data.shared.ts`**（下称单源）。算法变更只改单源并重跑构建，本文件不承载实现副本。
>
> 路径一律占位形态：`<workspace>` = 工作区目录（各 worktree 的共同父目录）、`<worktree>` = worktree 目录名、`<zsw-skills 检出根>` = 本仓检出根。

## 1. 双形态检测算法（行为契约）

**输入** = projectRoot（项目根或 worktree 根的绝对路径）。**输出** = JSON `{ form, slug, workspaceRoot?, worktreeName? }`，`form` 取 `workspace` 或 `single`。消费出口 = 单源里的探针常量 `NODE_PROJECT_ADDRESS`（`node -e <常量> <projectRoot>`，stdout 为该 JSON）。

判定按以下顺序：

1. 对 projectRoot 取 realpath；路径不存在 = 第一步即失败（报错形态与恢复动作见 §5）。
2. 单仓形态（缺省）：`slug = basename(realpath(projectRoot)) + '-' + sha256(realpath(projectRoot))[:8]`（下称 project-slug），输出 `{ form: 'single', slug }`。
3. 工作区检测（兄弟计数）：令 P = projectRoot 的父目录。取本仓全部 worktree（`git worktree list --porcelain`），只统计同时满足两条的项——路径是 P 的直接子目录；该 worktree 的 common-dir（`git rev-parse --git-common-dir`，相对路径按该 worktree 自身路径规范化，realpath 后比较）与本仓相同。projectRoot 自身与 `.bare` 主 worktree 计入。
4. 统计数 ≥ 2 → 工作区形态：`workspaceRoot = P`、`worktreeName = basename(projectRoot)`、`slug = basename(realpath(P)) + '-' + sha256(realpath(P))[:8]`（下称 ws-slug），输出 `{ form: 'workspace', slug, workspaceRoot, worktreeName }`。
5. 统计数 < 2，或任一步 git 调用失败（非 git 目录 / git 不可用）→ 单仓形态（第 2 步结果）。

固定的边界行为：

- 同一逻辑仓库的任一 worktree 得到同一 ws-slug：寻址按逻辑仓库归属，不按检出位置。
- 游离 worktree（路径不在 P 下）不参与 P 的计数；若多个同仓游离 worktree 同父目录（例如都挂在系统临时目录），该临时目录整体被判为工作区——行为确定，寻址在该目录内稳定。
- 单仓形态的输出与平铺布局的既有输出一致，存量路径不变。
- 检测只读磁盘与 git 事实，不依赖人工标记文件。

相关机器检查：算法固定向量与四类 fixture 在 `scripts/tests/skill-data.test.mjs`；产物内探针串与单源逐字节一致由 `scripts/check-workflow-parity.mjs` 的注入不变量守（见 §4）。

## 2. 两级布局与路径形态

布局分两级，写看点由 projectRoot 的检测形态决定：

| 段 | 工作区形态 | 单仓形态 |
|---|---|---|
| tech-design（设计包） | `~/.agents/skill-data/tech-design/<ws-slug>/` | `~/.agents/skill-data/tech-design/<project-slug>/` |
| dev-flow（执行态） | `~/.agents/skill-data/dev-flow/<ws-slug>/<worktreeName>/` | `~/.agents/skill-data/dev-flow/<project-slug>/` |
| 观测事件（不随寻址变化） | `~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl` | 同左 |
| conformance-state（v2 状态仓，tech-design 段内） | `~/.agents/skill-data/tech-design/<ws-slug>/<name>/conformance-state/` | `~/.agents/skill-data/tech-design/<project-slug>/<name>/conformance-state/` |
| sandbox（worktree 检出段，dev-flow 段内） | `~/.agents/skill-data/dev-flow/<ws-slug>/<worktreeName>/sandbox/` | `~/.agents/skill-data/dev-flow/<project-slug>/sandbox/` |

- **tech-design 段 = 工作区级共享、无 worktree 段**：设计包是仓库级资产，任何 worktree 的入口门都发现同一份设计包。`<ws-slug>/` 内部排布与平铺目录一致：`<name>/`（六章节 JSON 权威源）、`<name>.rendered.md`、`<name>.impl-plan.md` / `.impl-plan.json`、`<name>.symbol-watchlist.json`、`<name>.plan-review.md` 平铺其下；T2 审查产物在 `<name>/round-N/` 与 `<name>/final.json`、`<name>/run.json`。
- **dev-flow 段 = worktree 级隔离**：执行态与 git 实物对账、中断后恢复都绑定该 worktree 的检出状态，所以 worktreeName 单独成段。段内文件：`<name>.exec-plan.json`、`<name>.status.json`、`<name>.run.json`、`<name>.ledger.md`、`<name>.coverage.md`、`<name>.runlog/`、`<name>.prompts/`、`<name>.verify/`、`<name>.sync/round-N/`。
- **不随寻址变化的段**：观测事件按 task-id 直读、不携带 projectRoot；skill-data 下其他技能段各按自己的约定，不在本约定范围。
- **conformance-plane v2 附加寻址（M5 报告与切换；代码侧常量单一来源 = `skills/self/dev-workflow/conformance-plane/migration/cutover.mjs` 与 `reports/render.mjs` 的登记注释）**：
  - **conformance-state 状态仓段**：tech-design 段 `<name>/conformance-state/`——事件 JSONL 与快照唯一权威（v2 对账引擎 `stateRoot` 缺省同值；粒度每包一仓，见 dev-workflow conformance-plane README）。
  - **sandbox 段**：dev-flow 段下 `sandbox/` 子目录（单仓 `<project-slug>/sandbox/`、工作区 `<ws-slug>/<worktreeName>/sandbox/`）——隔离 worktree 检出目录固定段（目标仓外固定段；worktree sandbox 机制寻址）。
  - **cutover 标记**：tech-design 段 `<name>/cutover.json`（工作区级共享、无 worktree 段；权威落盘位置）及 docName 变体键 `<name>.rendered/cutover.json`（cutover 双写同内容标记）——按包灰度切换标记；旧 W4 setup 与 flow/sync.md 手工入口第一步按 `<slug>/<docName>/cutover.json` 探测（docName = 发起时设计文档 basename 去扩展名，可含 `.rendered` 后缀），命中即拒启并指向 v2（design-code-sync-loop.shared.ts `cutoverGuardBlock`）；两变体键齐写保证 plain / rendered 两种发起形态都命中。
  - **v2 报告根**：tech-design 段 `<name>/v2/`（五视图 current/final/matrix/trajectory/ledger；与 cutover 标记同段，不与旧 D5 final 同址同名冲突）。
  - **旧 final 归档件与 tombstone 寻址**：原地址 = dev-flow 段 `<project-slug|ws-slug>/[<worktreeName>/]<docName>.sync/final.json`；cutover 逐一改名归档为同目录 `final.legacy.json`，并在原地址回写 tombstone 指针（deprecated 标记 + conformance-state 权威地址 + 归档件地址）——旧寻址外部读者按原地址读到的是指针，不再是可当作当前终态的内容。
  - **cutover 扫描 docName 两变体枚举键**：`<name>.sync/final.json` 与 `<name>.rendered.sync/final.json` 两个变体精确匹配（`<name>` 与 dev-flow 段 docName 同源于设计文档 basename，docName 可含 `.rendered` 后缀；同包历史运行可产生两种前缀变体）；禁止裸前缀 glob（裸前缀会误伤他包目录）；tech-design 段 `<name>/final.json` 属 T2 审查终态（写入者 W1 tech-review-loop），不在 cutover 处置范围。
  - **归档态与复活**：归档是快照 input 的逻辑标记（`input.archived`，派生谓词），非物理只读；复活通道追加 Unarchived（退出归档）事件解档并恢复追加，cutover 标记保留（旧引擎仍拒启，复活只走 v2）。

路径取值一律经寻址探针实得（工作流入参 projectRoot），主 agent 与文档不手算 slug。

## 3. 版本分层与 bump 语义

### 3.1 两层版本

| 层 | 字段 | 回答什么 | 权威源 | 参与执行裁决 |
|---|---|---|---|---|
| 数据契约版本（schemaVersion） | exec-plan 的 `version`（当前 `1`） | 产物数据格式是哪一代 | 引擎 schema 校验（`validateExecPlan`） | 是——唯一裁决依据 |
| 技能版本（skillVersion） | 产物 `skillVersion` / 观测事件 `skill_version` | 由哪个技能版本产出 / 由哪个技能版本执行 | 各技能 SKILL.md frontmatter `version`（手动 semver） | 否——只读溯源与统计分组 |

路由规则：schemaVersion 不符 → 消费方拒绝执行并指明恢复动作；skillVersion 取任何值都执行（不设跨 MAJOR 拒执行）。字段语义变更必须升 schemaVersion，纯行为优化不升；技能版本不参与路由。

### 3.2 技能版本的承载文件与写入者

| 承载文件 | 写入者 | 说明 |
|---|---|---|
| `meta.json` 的 `skillVersion` | tech-design-wf T1 主 agent | 可选字段，规格见 `tech-design-wf/references/design-doc-schema.md`；机器检查有则查 semver、无则放行 |
| impl-plan 双格式的版本行 / `skillVersion` | tech-design-wf T3 主 agent | `.impl-plan.md` 头部版本行与 `.impl-plan.json` 的 `skillVersion` 同源同值 |
| `final.json` / `run.json`（tech-design 段） | W1 tech-review-loop | 终态记录与运行清单 |
| `exec-plan.json` / 初始 `status.json` | dev-flow-wf D0 主 agent | D0 编译时写入 |
| `status.json` 的事件回写 | W2 / W3 | W3 追加事件时仅在字段缺失时补写引擎当前版本，不覆盖已有值 |
| `run.json`（dev-flow 段） | W2 / W3 / W4 | W2/W3 落 dev-flow 段产物根，W4 落 `<name>.sync/` |
| `ledger` 追加笔 | W4 | 每笔正文首行 `skillVersion: <值>` |
| 观测事件 `skill_version` | 各 workflow 的内建观测 + `workflow-observe.mjs` | 可选字段；恒记执行引擎当前版本（回答「谁在执行」；产物字段回答「谁产出」） |

约定：技能自有文件（SKILL.md / flow / agents / references / 技能 scripts）任何进入本次提交的改动都必须 bump 对应 frontmatter version；共享构建源 `workflows/src/` 按产物逐字节 diff 判定——产物未变（纯注释）豁免，产物变则全部技能联动 bump。

### 3.3 bump 语义（semver）

| 位 | 条件 |
|---|---|
| MAJOR | 数据契约变更（必须同时升 schemaVersion 并重建产物） |
| MINOR | 行为新增（新参数、新阶段） |
| PATCH | 修复与措辞 |

版本号唯一对应一段代码状态：bump 由 pre-commit 机器强制（见 §4），不靠人工记忆。构建器读 frontmatter 注入 `const SKILL_VERSION = "<值>";` 到全部 workflow 产物，产物内该常量不手改。

## 4. 检查器清单

| 检查 | 触发 / 命令 | 断言 | 红灯恢复动作 |
|---|---|---|---|
| 版本纪律（pre-commit 段 3） | staged 含技能自有文件 / 共享构建源 / 产物时执行 `node scripts/check-version-discipline.mjs` | 规则 1：技能自有文件有 staged 改动 → 对应 frontmatter version 必须 bump；规则 2：共享源改动按产物逐字节 diff 判定，产物变 → 全部技能联动 bump；规则 3：产物内嵌 SKILL_VERSION = 对应 frontmatter 当前值 | 按输出 bump 对应 SKILL.md 的 version，重跑 `node scripts/build-workflows.mjs` 重建产物后重新 git add |
| 构建一致性 + 版本戳比对 | `node scripts/build-workflows.mjs --check`（pre-commit 段 1 亦调用） | 产物与源重生成结果一致；产物内嵌 SKILL_VERSION 等于 frontmatter 当前值 | `node scripts/build-workflows.mjs` 重建 |
| 双平台对账 + 探针注入不变量 | `node scripts/check-workflow-parity.mjs`（pre-commit 段 1 亦调用） | zcode/pi 各对产物的 phase 名集合、agent 名序列、业务串差集 ⊆ 白名单、SCHEMA↔interface 字段名与 required 集；寻址探针串与单源逐字节一致且在每个产物内恰好声明一处 | 改 `workflows/src/` 单源后重新 build，不手改产物 |

## 5. 失败路径与恢复

### 5.1 projectRoot 路径不存在

探针第一步 realpath 即失败，四个 skill-data 消费 workflow 按启动期失败处理：

- W1 tech-review-loop：终态 `setup-failure`，message = `projectRoot 无法解析为 skill-data 寻址（检测探针失败，exit N）：<stderr>。恢复动作：确认 projectRoot 目录存在后重新发起`。
- W2 wave-executor：启动校验失败返回，message = `projectRoot 无法解析为 skill-data 寻址（检测探针失败，exit N）：<stderr>——恢复动作：确认 exec-plan 的 projectRoot 目录存在且为 git 仓库内路径后重新发起`。
- W3 dev-consistency-loop：启动期抛错，message = `projectRoot 无法解析为 skill-data 寻址（检测探针失败，exit N）：<stderr>——恢复动作：确认 exec-plan 的 projectRoot 目录存在后重新发起`。
- W4 design-code-sync-loop：终态 `setup-failure`，message = `projectRoot 无法解析为 skill-data 寻址（检测探针失败，exit N）：<stderr>。恢复动作：确认 projectRoot 目录存在后重新发起`。

恢复动作：核对路径拼写与 worktree 是否已被删除；路径已迁移时按 D0 重新编译（exec-plan 内的 projectRoot 是绝对路径，执行位置绑定一次编译）。错误信息必须同时给出检测失败事实、权威源（入参 projectRoot / exec-plan 的 `projectRoot` 字段）与恢复动作。

### 5.2 目标 worktree 不在检测集合内

projectRoot 不是工作区内已 `git worktree add` 的路径（或误传仓库外路径）时：检测退单仓形态，寻址本身成功但落到 `tech-design/<project-slug>/`，入口门在 `tech-design/<ws-slug>/` 下找不到设计包。入口门报错必须包含：

- 检测到的形态与寻址根：`form`、`slug`，工作区形态另给 `workspaceRoot` / `worktreeName`；
- 缺失清单（入口门逐行核对缺哪个文件）与回到 tech-design-wf 哪一阶段补；
- 恢复动作：确认 projectRoot 是工作区内已登记的 worktree 路径后重发；worktree 尚未创建时先 `git worktree add` 再发起。

### 5.3 projectRoot 是非 git 目录

不是错误：git 不可用 → 单仓形态兜底，寻址成功，产物落平铺布局。需要工作区共享语义时，确认该路径确实位于工作区内。

## 并入约定

skill-data 下其他技能按各自节奏并入：并入 = 引用本文件 + 在产物寻址处接入单源探针（构建期注入，或显式 import 单源导出的纯函数），不复制算法副本。出现第二个使用方时再扩展本文件的形态与字段说明。
