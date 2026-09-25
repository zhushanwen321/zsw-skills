# T2 审查循环流程

> 两阶段审查（价值审先行 → 三 reviewer 并行）+ 多轮修复循环。执行体两形态：**zcode 环境优先发起 saved workflow `tech-review-loop`**（契约见 SKILL.md）；workflow 未就绪/发起失败按本文件手工路径执行（语义等价）。审查标准见 `review/rubric-design-doc.md`，agent 定义见 `agents/`。

## 产物路径约定 [MANDATORY]

- 价值审报告落 runDir 根 `<项目根>/.tmp/tech-design/<name>/review-value.md`（价值审在轮次循环外——与 workflow 引擎落点一致）；三审报告落 `round-N/`：`review-<dimension>.md`（dimension = main / impact / simplicity）+ `dispositions.md`（当轮处置表）
- 重发起（value-rejected 修完重来 / escalated 裁决后重跑）时新轮次目录带 attempt 后缀：`round-3.attempt2/`——不覆盖历史
- 终态记录 `<name>/final.json`：`{ terminated, rounds, runDir, designDoc, oneliner, reportFile, mustFixTrajectory, suggestionDispositions, remaining, blocked, message }`——设计包的审查证据（dev-flow-wf 入口判据读它）
- `.tmp/` 是临时产物目录不进 git；用户显式指定路径时以用户为准

## W1 workflow 发起（zcode 环境默认动作）

```
CreateWorkflow saved: tech-review-loop
args: { designDoc: <绝对路径>, projectRoot: <项目根绝对路径>, maxRounds?: 10, reviewers?: <自定义 reviewer 模板绝对路径数组，缺省用本技能 agents/ 默认四件> }
终态: converged / value-rejected / escalated / stuck / max-rounds + setup-failure / review-failure / fix-failure（环境失败族）
```

终态处置（workflow 与手工路径同表）：

| 终态 | 主 agent 动作 |
|------|--------------|
| converged | **T2 确认点**：转述 oneliner + 收敛轨迹 + 处置清单 → 默认等用户确认 → 进 T3（前期授权直接进） |
| value-rejected | 按价值审修复方向回 T1 与用户对话重写问题定义/方案主干，修完重新发起（attempt+1） |
| escalated | 方案性意见需方向裁决——与用户对比新候选后改文档重新发起（语义声明：老版主 agent 可轮内自行重跑方案对比，本版一律停回用户，更保守） |
| stuck / max-rounds | 呈报残余风险矩阵，用户裁决（stuck = 连续 3 轮 must-fix 不降） |
| *-failure（环境/工具） | 读 runDir 日志排障后 resume 或重发起 |

## 手工路径 Step 1：确认审查对象

从用户/上游拿到：待审文档路径、一句话说明（这是什么设计）。报告路径按产物约定解析。

## 手工路径 Step 2：第一阶段——价值评审（先于三 reviewer）

路径解析：本 skill 安装位置 = available_skills 里 `tech-design-wf` 的 `location` 字段。据此拼绝对路径：rubric = `<location>/review/rubric-design-doc.md`；references 按需传 `<location>/references/design-principles.md`、`anti-patterns.md`。

派 `tech-design-value-review`（task 三段式）：

```text
背景：对设计文档 <绝对路径> 做价值评审（先于三 reviewer 的第一道门）。
  该文档是 <一句话说明>。
目标：
  1. read <rubric 绝对路径> 加载价值审判据（P0-V 系列）
  2. read <文档绝对路径>
  3. 目标项目根：<绝对路径>——read 其 AGENTS.md / PRODUCT.md（若存在）提取产品定位
     与约定（「核心价值」以项目产品定义为锚，不凭个人偏好）
  4. 三大方向审查：①一句话复述测试（复述本身是交付物；复述不出/很复杂/含黑话 = 不
     通过）②问题值不值得这么解（现状保留行为逐个论证；伪需求识别；求解量级与破坏面
     匹配）③产品最小形态检查（三层显式作答、是否为方案主干、增量逐项裁决、扩展点
     已发生证据）
  5. 声称「现状行为与代码不符」前必须 read 源码核实；只审方向与量级，机制正确性/
     影响面/过度设计留给三 reviewer（标 INFO 交接）
  6. 报告写到 <runDir>/review-value.md
验收：
  - 返回 structured-output { report_file, must_fix, suggestion, oneliner }
  - 报告含 Summary + 一句话复述 + Findings 表；每个 MUST_FIX 引用 P0-V-N + 文档位置
```

价值审 must_fix > 0 → 停（按终态表 value-rejected 处理）。0 must_fix → Step 3。

**全托管模式附加声明**：task 末尾追加「全托管模式：禁止 AskUserQuestion / ask-user / 任何等待用户输入的操作；遇到决策点自行裁决，决策清单写入报告 INFO 节。」

## 手工路径 Step 3：第二阶段——并行派三个 reviewer

同一条消息并行派三个（subagent 独立加载，task 内路径全部绝对路径）。**不要自己审——审查与写作分离，避免确认偏差，主 agent 不自审**：

```text
agent: tech-design-review
task:
  背景：对设计文档 <绝对路径> 做对抗式审查（已通过价值评审）。
  目标：
    1. read <rubric 绝对路径> 加载 P0/P1 清单与分工（你只判主审条目）
    2. read <文档绝对路径>
    3. 目标项目根：<绝对路径>——read 其 AGENTS.md / ARCHITECTURE.md（若存在）提取
       项目约定；read 源码核实声称时以此为锚
    4. <R1：逐项对抗式审查，找反例和攻击面，声称事实错误前必须 read 源码核实；先审
       问题定义，只报影响决策的事实错误。
       R2+（聚焦复审）：只审三件事——上轮 must-fix 修复是否成立（fixed 须实证：读了
       什么确认了什么）；修复是否引入新问题（只扫修复触及章节）；上轮处置表的登记
       不修项上下文是否被改变（结构化申报复活）。不做全面重扫，不重查已确认项。
       注入材料：上轮处置表全文 + 修订摘要 + 反例重演结果 + 修订方攻击点建议>
    5. 重点审查验收章节（P0-13/14/15/21）：是否真实场景（非单测/mock）、投入是否
       匹配改动大小、宿主表面不变量场景
    6. 报告写到 <runDir>/round-N/review-main.md
  验收：
    - 返回 structured-output { report_file, must_fix, suggestion, reconciliation[] }
    - 每个 MUST_FIX 引用 P0-N 检查项编号 + 文档位置
```

（impact / simplicity 同构，判据分工按 rubric：impact 审 P0-12/19/20 副作用遗漏；simplicity 审 P0-22/23、P1-6 机制必要性——报告名 review-impact.md / review-simplicity.md。**简洁审一律派**——agent 在报告中说明本设计是否纯文案/参数调整类、简洁面零发现即可（无需跳过通道）。）

## 手工路径 Step 4：修复轮（主 agent 亲为）

1. 读三份结构化返回，合并去重（同根因跨维度表述合并）
2. 按 `flow/write.md` Step 7.1/7.2 修复全部 must-fix + suggestion 三选一处置
3. 产出当轮处置表 `<runDir>/round-N/dispositions.md`（每条：id / 来源报告 / 处置（修复|登记不修|归档）/ 修订位置 / 反例重演 / 攻击点建议 / 影响决策 / 影响交付）
4. 终态判定（机械）：三报告 must-fix==0 且上轮处置表无未处置条目即终止（converged，写 final.json）——不要求当轮 suggestion 清零（suggestion 逐条处置完即终止，不为 suggestion 单独驱动确认轮，老实测教训）；R1 全 0 且零 suggestion 直接收敛不派修复者。否则 → 下一轮聚焦复审（Step 3 的 R2+ 形态），轮次 +1
5. 停机线：maxRounds（默认 10）；连续 3 轮 must-fix 不降 → stuck 呈报用户

## 手工路径 Step 5：终态与 T2 确认

按终态处置表（见 W1 发起节）处理；converged 后写 final.json，进入 T2 确认点 → T3（`flow/plan.md`）。
