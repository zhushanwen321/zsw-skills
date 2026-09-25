# D0 编译 — 设计包 → 执行数据结构

> 一次性判断性工作（主 agent 亲为），替代此后每单元的重复手工编排。产物：`<name>.exec-plan.json` + `<name>.prompts/*.md` + 初始 `<name>.status.json`，全部落 `<项目根>/.tmp/dev-flow/`（不入 git）。完成后进 D1。

## 编译清单（按序执行）

### 1. 双格式一致性校验（fail-fast）

读 `.impl-plan.json`，逐项与 `.impl-plan.md` 核对：单元数 / 单元 id 集 / 依赖边数 / 验收项 id 集。不一致 → 停，回 tech-design-wf T3 修双格式（不猜测哪边是对的）。

### 2. exec-plan.json 生成

```jsonc
{
  "version": 1,
  "mode": "dev",                       // dev（D1）| acceptance（D3）
  "projectRoot": "<项目根绝对路径>",      // 引擎缺省 cwd（W2/W3 消费；节点 cwd 为 null 时用）
  "planPath": ".tmp/tech-design/<name>.impl-plan.json",
  "designDocPath": ".tmp/tech-design/<name>.md",
  "baseline": "<git rev-parse HEAD>",
  "statusPath": ".tmp/dev-flow/<name>.status.json",
  "testPlan": {                        // 从 impl-plan.json 的 testPlan 继承（W3 Gate A 消费，缺失即 fail-fast）
    "incremental": "…",                // 可选：修复组核验用的增量测试
    "fullSuite": { "program": "pnpm", "args": ["…"] },  // 必填：项目全量命令（含 lint/typecheck，从项目配置真实读取合成；复杂多命令封装为脚本走 bash）
    "artifacts": [{ "id": "build-e2e", "command": { "program": "…", "args": ["…"] } }]   // 可选：产物类条目（Gate A 起始第一波并行预备——命令确定、结果确定、被验证类消费；禁现用现建）
  },
  "commitTemplate": "<type>(<scope>): {unitId} — {summary}",   // 占位符 {unitId}/{summary} 必含（引擎校验）；summary 内容契约 = 任务书要求 dev 返回的 summary 末行含「测试：<命令> 绿」
  "nodes": [
    { "id": "u-foundation", "kind": "dev", "deps": [], "wave": 1,
      "cwd": null,                      // null = projectRoot；worktree 单元填 worktree 绝对路径
      "designRef": "§3.2",              // 设计章节锚（从 impl-plan 章节映射提取；commit 渲染时前置于 summary——老三要素保真：unit id + 设计章节 + 测试结论）
      "territory": ["packages/shared/src/..."],
      "testCommand": { "program": "pnpm", "args": ["-C", "packages/shared", "test"] },
      "promptFile": ".tmp/dev-flow/<name>.prompts/u-foundation.md" }
  ],
  "acceptance": {                       // D3 实例化时生成（本步先空着）
    "nodes": [],                        // kind=verify（script/artifactsDir）| inspect（promptFile/artifactsRefs/deps）
    "groups": { "core": [], "nonCore": [] },
    "haltOnCoreFail": true
  }
}
```

- **wave** = 编译期展示分组（拓扑分层编号，人看进度用；**调度只看依赖边，wave 不是边界**）
- **testCommand** = 每节点增量测试命令（T1 形态：program + args 拆开；含管道/&& 的复杂命令落临时脚本走 bash 通道）——从 impl-plan §4 测试计划逐单元提取
- **cwd** = worktree 隔离单元（判据见 references/dag-authoring.md）填 worktree 绝对路径，其余 null

### 3. 逐节点 promptFile 构造

每单元一个 `.prompts/<unitId>.md`，内容 = 三段式任务书全文：背景（项目根/计划路径/章节映射坐标/本单元职责·领地·验收条款/设计文档对应节摘录/项目 AGENTS.md 与测试策略文档路径）/ 目标（含测试要求：增量测试按 testCommand；验收条款逐条达成；契约类单元的契约测试含 error envelope 与边界用例）/ 验收（返回契约 JSON：`{status, files_changed:[精确路径], test_evidence, deviations:[], blockers:[]}`，deviations 强制字段无偏离填空数组）/ 约束（领地白名单/禁 git 写/临时脚本清理/开工前校验章节映射指向的节实际存在，对不上停工上报）。

### 4. 初始 status.json

```jsonc
{ "name": "<name>", "baseline": "<HEAD>", "updated": "<ISO>",
  "nodes": { "u-foundation": { "status": "pending", "attempts": 0 } },
  "events": [] }
```

节点字段 = `status` / `attempts`（终态回写附 `commit?` / `evidence?`）。引擎回写保留 name/updated 顶层字段；恢复对账双向：标 done 无 commit → 回 pending；有 commit 未记 → 引擎按 git log 匹配单元 id 补写 done。

### 5. L0 前置 + 环境准备（D3 前置项此时一并核）

- L0 静态守卫基线：lint / typecheck / 项目守卫脚本在 baseline 上全绿记录（命令从项目 AGENTS.md / package.json scripts 真实读取，禁凭记忆编）
- 产物类条目编入 testPlan.artifacts（引擎 Gate A 第一波并行预备，见 §2 testPlan 注释；禁只标注不落位）
- 覆盖矩阵骨架：从 impl-plan 领地表 × 验收计划表生成「单元领地 × 计划用例」骨架表落 `.tmp/dev-flow/<name>.coverage.md`（D4 收尾时回填实际覆盖并处置 uncovered 区——补测试或登记理由）
- 章节映射锚点核对：逐条 read 设计文档核对 §N 实际存在，对不上停回 tech-design-wf T3（不猜测）
- （进 D3 前）环境 smoke：场景依赖的每个环境面跑无 LLM 探针验证可用；剧本 dry-run：机械断言先对样本数据跑通；采样管道复用检查：read 项目采样管道文档，已有脚本直接复用，新姿势沉淀回写，禁现场重写管道；多实例分配：互斥场景组绑独立 dev 实例（装配器端口段派生 + 独立数据目录）

### 6. 验收编译规则（为 D3 预生成 acceptance 面）

验收计划表逐行：**L3 → verify 节点**（script = 剧本路径，artifactsDir）；**L4 → inspect 节点**（promptFile 任务书含「确定性产物已就绪」指针，deps 指向其 verify 前驱）；**L0/L2 不编译成节点**——已由 D1 单元测试与 D2 Gate A 覆盖，行标注「已覆盖」，D3 入口门引用 Gate A 证据（HEAD 未前进则免重跑）。混合行拆行（确定性部分降 L3 先行，判断行依赖它）。分组按「组」列；核心短路 haltOnCoreFail = true。

补编规则：

- **汇总 inspect 节点**：全部 verify 节点产物集中追加一个汇总 inspect 节点（deps=全部 verify 节点）——判 pass/fail + 扫全页截图与 console 兜底（脚本断言盲区由这步补偿）+ fail 归因定位到场景与日志行
- **一次性 vs 可复用分流**：验收脚本按一次性（迁移/特殊环境/本设计特有）vs 可复用（进项目 e2e 资产）分流落位
- **fail 先查排障文档**：验收失败处理写在 verify/inspect 节点 promptFile 约束——先 read 项目排障文档（典型 docs/TROUBLESHOOTING.md）归因，禁不归因重试、禁放宽断言
- **开发期 e2e**：验收计划表「单元 committed 后」时点的项编译为 kind=verify 节点插入 dev 模式 nodes（deps=所属 dev 单元）

## worktree 合并排布

DAG 含 worktree 单元（node.cwd ≠ projectRoot）且存在跨 cwd 依赖边时，D0 必须显式排合并——编译合并节点（kind=dev，id 如 `merge-<worktree单元>`，promptFile=合并指令：核对 worktree 单元 commit → 按项目既有合并约定（无约定 git merge --no-ff）合入工作分支，拿不定先停问用户；testCommand=合并冒烟），下游集成单元 deps 指向合并节点；单 worktree 小计划可标注手工段由主 agent 执行并记录。引擎不做合并检测。

## 完成判据

exec-plan schema 完整（nodes 非空、每节点 promptFile 存在、testCommand 可执行）+ status.json 初始态落盘 + L0 基线绿。呈现编译摘要（单元数/wave 分组/验收节点数）后进 D1（发起 W2 或走 `flow/execute.md` 手工路径）。
