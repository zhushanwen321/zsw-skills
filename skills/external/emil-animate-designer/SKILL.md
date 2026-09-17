---
name: emil-animate-designer
description: "emilkowalski/skills 的 9 个子 skill 路由入口（Emil Kowalski 出品，前 Vercel/Linear）。命中后先读本 skill 正文的路由表，按本 skill 目录下的相对路径只读匹配的子 skill SKILL.md——禁止一次读全部。覆盖：动画创建、动画审查、全库动画审计、动画机会发现、动效术语查询、Apple 设计原理、UI 设计哲学、UI 库选择、多版本原型。触发词：动画、动效、转场、transition、UI 打磨、品味、选库、原型对比、Apple 手势/弹簧设计、查动效名称。非 UI/动效的后端任务不要加载。"
---

# emil-animate-designer — emilkowalski/skills 路由入口

本 skill 是 [emilkowalski/skills](https://github.com/emilkowalski/skills) 9 个子 skill 的**路由入口**。

**不要用本表内容当执行指令**。读完下面的路由判断后，`read` 匹配的那个子 skill 的 SKILL.md（相对路径见下），按其正文执行。一次只读 1–2 个，**不要全读 9 个**。

所有子 skill 根目录：`<skill_dir>/sub-skills/`

---

## 路由表

### 一、动画 / 动效类（4 个，最容易混）

按三轴区分：**运动是否已存在 × 单点还是全库 × 是否写代码**

- **要新建并写出一段动画的实现代码**（运动尚不存在，单元素）
  → `read` `<skill_dir>/sub-skills/animate/SKILL.md`
  触发：「给这个加动画/动效/转场」「让它有进入/退出效果」「make it animate / feel alive」并要代码

- **要审查已有动画，给 Block/Approve 裁决**（运动已存在，单段或 diff，只读）
  → `read` `<skill_dir>/sub-skills/review-animations/SKILL.md`
  触发：「审查/检查这段动画」「这个动效好不好」「review this motion / is this animation good」

- **要审计整个代码库的动画，出优先级路线图 + 可执行计划**（运动已存在，全库，只读源码）
  → `read` `<skill_dir>/sub-skills/improve-animations/SKILL.md`
  触发：「改进/审计整个 app 的动画」「animation roadmap」「make this app feel better」全库层面

- **要发现哪里该加动画**（求补集，只读，给精确配方 + 拒绝清单）
  → `read` `<skill_dir>/sub-skills/find-animation-opportunities/SKILL.md`
  触发：「哪里能加动画」「还缺什么动效」「what could be animated here」

**歧义消解**——「让它感觉更生动 / make it feel alive」：
- 想知道**该在哪加** → find-animation-opportunities
- 已有动画想**整体改进** → improve-animations
- 针对**单个元素**立刻实现 → animate

这四个可串成流水线：**发现(find) → 规划(improve) → 实现(animate 或 improve 的 execute) → 验收(review)**。

### 二、UI 库选择
- **选 toast / 命令菜单 / 拖拽 / 虚拟化 / 图表 / 状态 / 样式该用哪个库**
  → `read` `<skill_dir>/sub-skills/pick-ui-library/SKILL.md`
  触发：「这个该用什么库」「which library for toasts / dnd / virtualization」

### 三、多版本原型探索
- **做几个有差异的版本对比、探索设计方向**
  → `read` `<skill_dir>/sub-skills/prototype/SKILL.md`
  触发：「做几个版本让我挑」「explore options」「build a few variants」

### 四、动画 / 效果术语查询
- **查某个动效 / 效果叫什么名字**（纯命名，不设计、不实现）
  → `read` `<skill_dir>/sub-skills/animation-vocabulary/SKILL.md`
  触发：「那个效果叫什么」「what's it called when...」「the bouncy popover thing」

### 五、Apple 风格深度
- **Apple 流体界面 / 手势 / 弹簧 / 材质原理与精确参数**
  → `read` `<skill_dir>/sub-skills/apple-design/SKILL.md`
  触发：「Apple 怎么做手势 / 弹簧」「WWDC fluid interfaces」「rubber-band / momentum」

### 六、通用设计哲学 / 推理
- **通用 UI 打磨哲学、组件设计原则、决策推理**（非 Apple 专属）
  → `read` `<skill_dir>/sub-skills/emil-design-eng/SKILL.md`
  触发：「这个决策该怎么想」「为什么这个界面感觉对」「design engineering / taste」

---

## 路由时的关键约束（影响判断，必读）

1. **三个子 skill 不会自动触发**（其 frontmatter 设了 `disable-model-invocation: true`）：`review-animations`、`pick-ui-library`、`prototype`。用户表达对应意图时，**主动 `read` 指向它们**，别等它们自己加载。

2. **`animate` 与 `find-animation-opportunities` 可能合法地「零输出」**：`animate` 第一步是频率闸门，可能判定「不该动画」而零行输出；`find-animation-opportunities` 基于 *You Don't Need Animations* 会拒绝大多数候选并给出拒绝清单。**什么都不做可能是正确结果**，别当成失败。

3. **`improve-animations` 不只是规划**：还有 `execute <plan>`（编排执行 + 用 review-animations 标准复审）、`reconcile`（同步计划与当前代码）、`plan <desc>`（跳过审计直接出单个计划）、`quick`/`deep` 工作量档位。需要「落地修复」时走它的 execute 变体，而非手动改。

4. **知识层三重叠**（三者都含 easing / spring 数值表，最容易误路由）：`emil-design-eng` = 通用哲学 + 推理；`apple-design` = Apple 手势 / 物理 / 材质深度；`animate` = 写代码动作。按动词分：「怎么想」→ emil-design-eng；「Apple 怎么做」→ apple-design；「写出来」→ animate。

5. **`emil-design-eng` 空调用只回固定 intro**：用户没有具体问题时别加载它——它只会回一句指向 animations.dev 的介绍。

6. **`animate` 遇到「需要真实组件」（toast / drawer / menu / dropdown）会转交 `pick-ui-library`**，而非手搓。若用户要的是「一个能用的 toast 组件」而非「给现有元素加动效」，直接路由到 pick-ui-library。

---

## 执行步骤

1. 判断用户意图属于上面六类中的哪一类（动词 + 对象）。
2. `read` 该类对应子 skill 的 SKILL.md 相对路径（横跨多类时最多读 2 个）。
3. 按所读子 skill 的正文指引执行。
4. **不要**把本路由表的内容当作执行逻辑——真正的执行逻辑、数值标准、输出格式都在子 skill 里。
