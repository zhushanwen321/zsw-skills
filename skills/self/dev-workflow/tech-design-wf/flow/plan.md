# T3 实施计划流程（审查收敛后）

> 输入：T2 converged 的设计文档（final.json 存在且 terminated == "converged"）。产出：**双格式 impl-plan**（`.impl-plan.md` 人读 + `.impl-plan.json` 机器）+ 并行度复审（门槛触发时）。全程不停等用户确认（阶段内动作），完成即 T3 确认点。

> **产物路径 [MANDATORY]**：`<项目根>/.tmp/tech-design/<basename>.impl-plan.md` 与 `.impl-plan.json`（与设计文档同目录——设计包整体在 `.tmp/tech-design/`）。`.tmp/` 不入 git，禁止 `git add`（含 -f）。基线 = 计划文件落盘，不依赖 git 跟踪。

## 入口自检（老 dev-flow 预检门的承接）

1. **T2 证据**：`<name>/final.json` 存在且 terminated == "converged"——本 skill 产出的设计天然满足；**外部文档入口**（用户直接给一份未经本流程的设计文档）→ 先补 T2（按 `flow/review.md` 手工路径全量审查，价值审起），补审不通过停止；禁止拿未审查文档直接拆计划
2. **结构完整性**：写 impl-plan 时逐项引用四类内容的实际节——背景/目标、终态/机制、验收场景表、下一层拆分。引用填不出 = 结构缺失，停下告知用户回 T1 补文档
3. 章节映射落计划文件「0 章节映射」节（下方模板）——后续所有 subagent/编译从这拿坐标，禁止自猜编号（两代结构并存：完整版 11 节 vs 五段制，一律按实质特征定位）

## 产出模板（.impl-plan.md）

```markdown
# <名称> 实施计划
基线: <流水线起点前 HEAD hash> | 来源设计: <路径> | 日期: <date>
<!-- 基线 = 开始实施前的代码 HEAD，供一致性审查的 git diff <基线>..HEAD -->
## 0 章节映射     # 四类内容 + 待验证检查点在本文档的实际位置（坐标唯一来源）
## 1 目标快照     # 摘录设计背景/目标 + Out-of-scope，逐字摘录禁止改写
## 2 单元列表
| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离(plain/worktree) | 验收条款 |
# u-foundation 固定为共享契约根节点，初始即就绪的 DAG 根
## 3 DAG 图       # mermaid
## 4 测试与验收计划  # 测试命令从项目 AGENTS.md / package.json scripts / 项目测试策略文档（若存在，典型 docs/TEST-STRATEGY.md）真实读取；增量与全量分开列
                    # 全量段 = 改动面 + 依赖闭包（防跨单元叠加回归），逐条标注 产物类/验证类
## 5 合理偏差登记表  # 初始空；| 偏差 | 内容与理由 | 影响面 | 处置 |
                    # 影响面 = 误导了什么/造成什么返工，写不出影响的不入表；处置 = 已接受 / 待回写设计文档 / 移交 D5 终态同步
## 6 残留风险与变更历史  # 残留风险四要素：触发条件/影响/处置/重审触发条件
```

（状态表不再内嵌——执行态事实源是 dev-flow-wf 的 `<name>.status.json`，由 D0 编译生成。）

### 验收计划表（§4 内，6 列）

```markdown
| # | 验收项（场景表行） | 方式(L0-L4) | 组 | 依赖 | 优化判定 |
|---|--------------------|-------------|----|------|----------|
| A1 | 计数口径与渲染 | L3 脚本 | 核心 | - | 可脚本化（testid 已有）；转化为 e2e 用例 |
| A2 | 体验流畅性 | L4 agent | 非核心 | A1 | 机器判不了 = 视觉形态（声明拆行条件） |
```

- **方式**：L0 静态规则 / L1 增量单测 / L2 全量套件 / L3 脚本端到端 / L4 agent 端到端（分层定义与铁律见 dev-flow-wf `flow/acceptance.md`——L0 未清不进 L2；L2 不绿不派任何端到端；L3 能覆盖的场景不升 L4；成本不另打分，L 级即承载）
- **组**：核心（主链路，走不通则其余验收无意义）/ 非核心
- **依赖**：默认 = 对应开发单元已提交（唯一无需说明的真实前提）；填其他依赖（另一验收项 id）必须附一句理由——功能先后或共享不可重置状态；编号顺序/顺手连跑不构成依赖
- **优化判定**：可降级（L4→L3）/ 可合并 / 可脚本化 / L0 可消化；L4 行必须声明「机器判不了的部分是什么」，声明不出 = 拆行或降级
- **e2e 影响面圈定 [MANDATORY]**：从设计文档「e2e 影响面评估」继承落清单，逐项「跑（执行时点 = 单元 committed 后 / 阶段 5，空载串行；该项由 dev-flow-wf D0 编译为 verify 节点（deps=所属 dev 单元）在 D1 内执行）/ 不跑（理由）」；有 `docs/testing/e2e-map.json` 登记表的项目与 `node scripts/select-affected-e2e.mjs --base <基线>` 输出双向对账（差异逐条披露；脚本看不见设计语义，最终清单以人工裁决为准）

**提速结论 [MANDATORY]**：表后附一段——可降级 N 项 / 可合并 N 项 / 可脚本化 N 项 / L0 静态守卫清单（项目既有守卫脚本逐个列出），预计节省的派发轮次。随计划一并呈现给用户备查（陈述性展示，不构成等待点）。

## 双格式产出 [MANDATORY]

`.impl-plan.json`（机器格式，dev-flow-wf D0 编译的直接输入）：

```jsonc
{
  "name": "<name>",
  "designDoc": ".tmp/tech-design/<name>.md",
  "baseline": "<git rev-parse HEAD>",
  "sectionMap": { "goal": "§N", "mechanism": "§N", "acceptance": "§N", "breakdown": "§N" },
  "units": [
    { "id": "u-foundation", "responsibility": "…", "territory": ["…"],
      "deps": [], "isolation": "plain", "acceptance": ["条款…"] }
  ],
  "testPlan": { "incremental": "…", "fullSuite": "…" },
  "acceptancePlan": [
    { "id": "A1", "item": "…", "level": "L3", "group": "core", "deps": [], "optimization": "…" }
  ],
  "notes": []
}
```

**一致性校验（写完即跑，D0 也会复跑）**：单元数 / 单元 id 集 / 依赖边数 / 验收项 id 集——markdown 与 json 两边一致，不一致 fail-fast 当场修（双格式漂移零容忍）。

## 计划自检 [MANDATORY]

对着 DAG 与单元表自检，通过即落盘，不停等用户：

1. 切分粒度：无跨领地耦合、无空转单元、依赖方向与 DAG 一致；依赖只写「编译依赖 / 运行时读对方产物」，其他理由（测试可跑、想先验一把）删掉或写真实理由
2. worktree 标记符合判据（见 dev-flow-wf `references/dag-authoring.md` 隔离决策表）
3. 验收条款无遗漏：每单元至少一条可机械核验条款；设计验收场景表每行落到某单元验收条款**且出现在验收计划表**
4. 验收计划表自洽：核心组覆盖主链路；依赖列无环，非默认依赖带理由
5. e2e 影响面圈定无悬空：设计「e2e 影响面评估」每项落到验收计划表或「不跑（理由）」

仅当出现无法机械判定的歧义（领地必须重叠 / 设计自相矛盾）才停下问用户。

## 并行度复审（门槛触发，落盘前）

触发门槛：实现链关键路径深度 ≥3 或单元数 ≥4（门槛内小计划不派——零收益）。派 `~/.agents/skills/dev-flow-wf/agents/parallelism-reviewer.md`（zcode 环境按 subagent_type 派发；无注册机制环境用 general-purpose + 内嵌 agent 文件全文）；task 附 impl-plan 双格式 + 设计文档 + 项目根三绝对路径；报告落 `.tmp/tech-design/<name>.plan-review.md`。reviewer 只报告——主 agent 逐条裁决（采纳即改计划并重跑自检；不采纳记理由），裁决记入 json 的 notes。头两个使用并行度复审的项目交付后回看其产出：连续零 finding 则降级为自检清单条目、砍掉派发（流程环节要能证明收益）。

## 落盘与 T3 确认

Write 双格式文件 + 一致性校验通过 = 落盘完成（不 commit）。呈现 DAG/单元表/验收计划表 + 自检与复审结论，**默认等用户确认拆分与验收计划** → 授权后设计包交付，进入 dev-flow-wf（D0 编译）。
