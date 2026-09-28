---
name: code-arch-review
description: >-
  Use when 存量代码或开发完成代码的架构走查：模块深浅（深模块 / 浅模块）、接缝位置、
  可测试性、依赖方向与圈层归属合规核对；产出摩擦清单与候选卡，只审不改。
  走查方法论本体 = improve-codebase-architecture（经 architecture-improve-loop
  内化提炼出的独立单次审查形态）。触发词：架构走查、审查架构、模块设计审查、深模块、
  接缝、架构摩擦、这段代码架构好不好、模块怎么组织、浅模块。
  Not for 设计期领域建模与圈层归属设计（用 architecture-clean-domain-design）、
  自动循环修复（用 architecture-improve-loop，它挂载走查 reviewer 跑循环）、
  腐化堆积深查（用 architecture-decay-audit）、过度设计深查（用 code-overdesign-audit）、
  diff 行为正确性（用 code-domain-review）。
---

# Code Arch Review（代码架构走查）

对代码**现状形态**做单次架构走查（只审不改），两种视角并行产出问题清单：

| 视角 | 回答的问题 | 判定词汇 |
|------|-----------|---------|
| 设计质量 | 模块设计得好不好：深浅、接缝位置、可测试性 | 深模块体系（见下） |
| 依赖健康 | 依赖方向与耦合有无现实风险（按影响出卡，不按形式定罪） | 依赖健康信号 + 项目架构约定 |

**审查对象是域内现状，不是 diff**：diff 只作「近期热点参考」（哪片最近在动、优先看），判定以现状形态为准。这与 code-domain-review（审 diff 行为）的分工互补。

## 设计质量视角：深模块词汇

| 词汇 | 含义 |
|------|------|
| module | 有 interface 与 implementation 的任何东西——函数、类、包、跨层切片，刻度无关 |
| interface | 调用方正确使用模块必须知道的一切——类型签名之外还包括不变量、顺序约束、错误模式、必要配置 |
| depth（深浅） | interface 处的杠杆：深模块 = 小 interface 背后大量行为；浅模块 = interface 复杂度 ≈ 实现（不是行数比，是杠杆） |
| seam（接缝） | 不改此处就能改变行为的位置——interface 安放处 |
| leverage / locality | 调用方从 depth 得到的（一份实现惠及 N 调用点）/ 维护者从 depth 得到的（改动、排障、验证集中一处） |

判定原则：

- **deletion test**：怀疑浅模块时问「删掉它，复杂度是集中还是只是搬家？」——集中 = 值得深挖；消失 = 它是 pass-through
- **depth 属于 interface，不属于 implementation**：模块内部由多个小部件组成不构成碎片化证据（它们不在 interface 上）
- **一个 adapter = 假想接缝，两个 = 真接缝**：没有真实变化原因穿过时不引入接缝
- **可测试性三原则**：接受依赖而不创建依赖；返回结果而非产生副作用；小表面
- **按变化原因拆分**：一个文件承载多个正交变化原因 = 混合信号

**通用摩擦五问**（每个审查范围过一遍）：① 理解一个概念要在多个小模块间跳转吗？② 哪里有浅模块（deletion test 判定）？③ 哪里纯函数为测试抽出，但真 bug 藏在调用方式里？④ 哪里紧耦合模块互相泄漏内部细节？⑤ 哪些部分难以经现有 interface 测试？

## 结构合规视角：依赖健康核对

存在项目产物时优先消费，缺失时按通用健康信号核对。**判据语义 = 内容判断而非形式判断**：报「这个依赖导致什么风险」（附现实影响），不报「不符六边形形态」——项目不是六边形架构本身不构成问题，项目自己的架构约定（AGENTS.md / 架构文档）优先于任何通用形态标准。

1. **圈层性质映射表**（architecture-clean-domain-design 产出）存在 → 以其「观察」列为输入：普遍性健康风险（业务规则依赖 IO / 框架）按测试与复用影响评估出卡；其余形态偏差按项目约定裁决（约定禁止才出卡）
2. **依赖健康信号**（通用底线，不依赖六边形形态成立）：业务规则模块 import DB / HTTP / 框架类型（规则被基础设施锁死、无法脱离测试）；跨上下文直引对方内部实体（耦合越界）；入口层跳过编排直写数据（多数项目约定不允许，无约定时降 Worth 以下）
3. **领域模型登记**存在时顺带核对：绕过聚合根直改成员的结构性路径（行为面问题通报 code-domain-review）

## 审查流程

1. **圈定审查范围**：用户点名（模块 / 目录 / 痛点）优先；未点名回溯 `git log --oneline` 找热点路径
2. **读项目领域资产**：`CONTEXT.md`（术语以词条称呼模块）与 `docs/adr/`（已裁决决策不重新翻案；候选与既有 ADR 矛盾时只在现实击中证据充分时报，卡上标注警示）
3. **走查**：摩擦五问 + 深模块判定原则逐模块过；合规视角按上述顺序核对
4. **产出候选卡**（每条问题一张）：

```markdown
### 候选：<一句话>
- 档位：Strong（现实击中 + 长期合理）/ Worth（真实但需权衡）/ Speculative（纯未来收益，只备忘不进清单）
- 证据：<file:line + 现实击中的具体场景>
- 修复方向 + 方案形态：<改什么、接缝放哪>
- 行为不变量：<修复必须保持不变的行为>
- 测试处置：<伴随的测试增删>
```

档位纪律：Speculative 不进问题清单（报告末尾备忘留痕即可）；无现实击中证据不出卡。

## 严重度与消费

- Strong 对应必修级（进循环时映射 major / mustFix，清零才收敛）；Worth 随批修；Speculative 不报
- **深查分流**：走查中发现「不修根因靠补偿机制维持」的堆积形态 → architecture-decay-audit 深查；发现「投机抽象 / 过度通用」形态 → code-overdesign-audit 深查（本技能只标记可疑并分流，不做专项深审）

## 执行形态与 reviewer 模板

- **主 agent 单次走查**：直接按本 SKILL 执行（本文件自含方法论）
- **大范围 / 进循环**：派域 reviewer subagent——域 reviewer 模板（service-core / shell-ui / contract-host 三域：长驻服务层、多壳与 UI、跨进程契约与宿主）当前位于 `~/.agents/skills/architecture-improve-loop/agents/`（词汇表与本文件同源、含循环对账协议；灰度期共用不复制，architecture-improve-loop 退役时整体迁入本技能 `agents/`）
- **自动循环修复**：经 architecture-improve-loop（zcode saved workflow `review-fix-loop` 挂载上述域 reviewer；参数与终态处置见该技能）

## 与 architecture-improve-loop 的灰度关系

本技能 = 走查方法论本体（单次审查、独立触发）；architecture-improve-loop = 循环编排（引擎 + 挂载 reviewer 自动修复）。灰度期两者并存：本文件的方法论为独立单次审查形态，稳定后 architecture-improve-loop 收敛为薄壳编排层、域 reviewer 模板迁入本技能。
