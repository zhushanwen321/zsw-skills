# 审查设计文档流程

> 引导**两阶段审查**——第一阶段 `tech-design-value-review`（价值评审：一句话复述测试 / 问题值不值得这么解 / 产品最小形态检查，方向级守门），通过后第二阶段**并行派三个 subagent** 深审——`tech-design-review`（主审：问题定义/方案/事实/验收）+ `tech-design-impact-review`（影响面审：副作用/遗漏/宿主投影面/代价量化）+ `tech-design-simplicity-review`（简洁审：投机通用性/概念数净增/机制必要性）——并处理全部结果。审查标准见 `review/rubric-design-doc.md`（含归口分工表），agent 定义见 `agents/`。

## 产物路径约定 [MANDATORY]

审查报告统一落**项目维度 `.tmp/` 目录**：

- **项目根** = `git rev-parse --show-toplevel` 解析结果（worktree 解析为各 worktree 根，天然项目维度）；解析失败（目标不是 git 仓库）→ 落全局临时目录 `/tmp/tech-design/`
- 报告路径前缀：`<项目根>/.tmp/tech-design/design-review-<时间戳>`（与主文档同目录，靠此前缀区分、不覆盖主文档），各份报告分别为 `<前缀>-value.md`（价值审）、`<前缀>.md`（主审）、`<前缀>-impact.md`（影响面审）、`<前缀>-simplicity.md`（简洁审）
- `.tmp/` 是临时产物目录，应在项目 `.gitignore` 中（全局 ignore 模板已含 `/.tmp/`）；报告不进 git
- 用户显式指定报告路径时以用户为准

## Step 1：确认审查对象

从用户处拿到：
- 待审文档路径（单个 .md）
- 报告 output 路径前缀（缺省按上方产物路径约定解析）

## Step 2：第一阶段——派价值评审（先于三 reviewer）

**路径解析（主 agent 做）**：本 skill 的安装位置 = available_skills 里 `tech-design` 的 `location` 字段（通常 `~/.agents/skills/tech-design`）。据此拼出绝对路径：
- rubric：`<location>/review/rubric-design-doc.md`
- references（按需传给 subagent）：`<location>/references/design-principles.md`、`<location>/references/anti-patterns.md`

**先派 `tech-design-value-review`**（方向级守门——不对方向存疑的设计做精致化审查）：

```text
agent: tech-design-value-review
task:
  背景：对设计文档 <文档绝对路径> 做价值评审（先于三 reviewer 的第一道门）。该文档是 <一句话说明这是什么设计>。
  目标：
    1. read <rubric 绝对路径> 加载价值审判据（P0-V 系列）
    2. read <文档绝对路径>
    3. 目标项目根：<项目根绝对路径>——read 其 AGENTS.md / PRODUCT.md（若存在）提取产品定位与约定（「核心价值」以项目产品定义为锚，不凭个人偏好）
    4. 三大方向审查：①一句话复述测试（用自己的话复述设计——复述本身是交付物；复述不出/很复杂/含黑话 = 不通过）②问题值不值得这么解（现状被保留行为是否逐个论证过「为什么需要」；伪需求识别——从产品核心价值描述功能，现状复杂度里天然不包含的部分；求解量级与问题破坏面匹配）③产品最小形态检查（最小形态三层是否显式作答、是否为方案主干、增量是否逐项裁决、扩展点是否有已发生证据）
    5. 声称「现状行为与代码不符」前必须 read 源码核实；只审方向与量级，机制正确性/影响面/过度设计留给三 reviewer（标 INFO 交接）
    6. 报告写到 <output 绝对路径>-value.md
  验收：
    - 返回 structured-output { report_file, must_fix, suggestion, oneliner }
    - 报告含 Summary + 一句话复述 + Findings 表
    - 每个 MUST_FIX 引用 P0-V-N 检查项编号 + 文档位置
```

**价值审 must_fix > 0 → 停**：按其修复方向重写问题定义或方案主干，修完重过价值审（不派三 reviewer）。**价值审 0 must_fix → 进 Step 3。**

## Step 3：第二阶段——并行派三个 reviewer subagent

**同一条消息里并行派三个 agent**（subagent 独立加载、不在 skill 上下文，task 里所有路径必须用绝对路径）。task 用三段式：

```text
agent: tech-design-review
task:
  背景：对设计文档 <文档绝对路径> 做对抗式审查（已通过价值评审）。该文档是 <一句话说明这是什么设计>。
  目标：
    1. read <rubric 绝对路径> 加载 P0/P1 清单与归口分工（你只判主审条目，跳过 P0-V 系列、P0-12/19/20 与 P0-22/23、P1-6）
    2. read <文档绝对路径>
    3. 目标项目根：<项目根绝对路径>——read 其 AGENTS.md / ARCHITECTURE.md（若存在）提取项目特定约定；read 项目源码核实相关声称时以此为锚
    4. 逐项审查，找反例和攻击面（对抗式），声称事实错误前必须 read 源码核实；先审问题定义（§1 定义的问题是否忠于真实问题、有无识别隐藏根本问题），只报影响决策的事实错误，编号/序号/行号等与决策无关的机械性细节不报
    5. **重点审查验收章节**（rubric P0-13/14/15/21）：是否存在、是否真实场景（非单测/mock）、验收投入是否匹配改动大小、触达外部共享系统时是否含宿主表面不变量场景
    6. 报告写到 <output 绝对路径>.md
  验收：
    - 返回 structured-output { report_file, must_fix, suggestion }
    - report_file 指向的文件存在且含 Summary + Findings 表
    - 每个 MUST_FIX 引用了 P0-N 检查项编号 + 文档位置
```

```text
agent: tech-design-impact-review
task:
  背景：对设计文档 <文档绝对路径> 做影响面审查（副作用/遗漏专审，已通过价值评审）。该文档是 <一句话说明这是什么设计>。
  目标：
    1. read <rubric 绝对路径> 加载归口分工与你的判据（P0-12/19/20）
    2. read <文档绝对路径>
    3. 目标项目根：<项目根绝对路径>——read 其 AGENTS.md / ARCHITECTURE.md（若存在）提取项目特定约定；read 项目源码核实相关声称时以此为锚
    4. 枚举改动辐射的所有面（代码面/数据面/宿主外部系统面/用户工作流面），先找文档未声明的面，再逐条核已声明代价的四要素（量级/恢复路径/重审条件/显式判定）；涉及外部共享状态写入时 read 对方源码核实消费方/过滤规则/清理通道
    5. 报告写到 <output 绝对路径>-impact.md
  验收：
    - 返回 structured-output { report_file, must_fix, suggestion }
    - report_file 指向的文件存在且含 Summary + Findings 表
    - 每个 MUST_FIX 引用了 P0-N 检查项编号 + 文档位置
```

```text
agent: tech-design-simplicity-review
task:
  背景：对设计文档 <文档绝对路径> 做过度设计审查（简洁性专审，已通过价值评审）。该文档是 <一句话说明这是什么设计>。
  目标：
    1. read <rubric 绝对路径> 加载归口分工与你的判据（P0-22/23、P1-6）
    2. read <文档绝对路径>
    3. 目标项目根：<项目根绝对路径>——read 其 AGENTS.md / ARCHITECTURE.md（若存在）提取项目特定约定；read 项目源码核实相关声称时以此为锚
    4. 抽出 §3 引入的全部机制清单（新抽象层/组件/配置项/扩展点/保证机制），逐机制跑四问 + 反模式核对——四问①③的「已发生证据」必须引用 §1/§2 原文位置，找不到 = 投机成立；「方案已有同样能力」类声称先 read 核实
    5. 每个「砍/简化」finding 必须三段论证齐全（小取舍/大简化/核心无损锚），缺核心无损锚不得进 MUST_FIX；四问通过的复杂机制进「已核实非过度」节
    6. 报告写到 <output 绝对路径>-simplicity.md
  验收：
    - 返回 structured-output { report_file, must_fix, suggestion }
    - report_file 指向的文件存在且含 Summary + Findings 表 + 「已核实非过度」节（0 findings 时该节为主体，明说 0 候选）
    - 每个 MUST_FIX 引用了 P0-N 检查项编号 + 文档位置 + 三段论证
```

**不要自己审**——审查与写作分离，避免确认偏差。派给独立的对抗式 agent。

**全托管模式附加声明**：用户宣布全托管/夜间托管时，在所有 task 末尾统一追加——`全托管模式：禁止 AskUserQuestion / ask-user / 任何等待用户输入的操作；遇到决策点自行裁决，决策清单写入报告 INFO 节。`（全局 AGENTS.md subagent 约束 7 的传播要求）

**可跳过简洁审的唯一情形**：文档不引入任何新机制/抽象/扩展点（如纯文案修订、参数值调整的设计记录）。跳过须在汇报中说明理由；不确定是否引入新机制时一律派。

## Step 4：接收结果

读四个 subagent 返回的 structured-output（价值审 + 三 reviewer）。must_fix 计数**合并**看待（四份报告地位平等，价值审与影响面审/简洁审的 must-fix 同样阻塞实施）；suggestion 不阻塞实施，汇总进处置清单按 `flow/write.md` Step 7.1 三选一处置。

## Step 5：处理

- **任一份 must_fix > 0**：进入审查-修复循环——按 `flow/write.md` Step 7 修复（**每轮全修全部报告的 must-fix**；suggestion 逐条处置——修 / 登记不修 / 归档，判定线见该节 7.1），修订后按其 7.3 送回聚焦复审。**本 flow 不自动改文档**——修改由主 agent（或用户）按 `flow/write.md` Step 7 执行
- **四份均 must_fix == 0 且 suggestion 全部处置**：审查通过，设计就绪（循环终止条件；不为 suggestion 派确认轮）

## 衔接

复审不走本 flow 的 Step 2/3 全面重审——用 write.md Step 7.3 的聚焦复审提示词（修订摘要 + 反例重演 + 攻击点建议 + 不重查已确认项）送回**各自的** agent：价值审的 findings 送价值审，主审的 findings 送主审，影响面审的 findings 送影响面审，简洁审的 findings 送简洁审（修订若重写了问题定义/方案主干/最小形态 → 价值审必送；新增/改变了外部接触面，或增删了机制/抽象，对应维度的报告都送）。对抗式审查可能多轮才收敛——真实案例经 4 轮（2 → 3 → 2 → 0 must-fix，问题逐轮收窄：机制级 → 规则级 → 计数语义级），这是正常收敛信号；同级或变宽说明修复方向有问题，回 write.md Step 7 开头的预警处理。
