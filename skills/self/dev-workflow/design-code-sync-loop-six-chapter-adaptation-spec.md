# design-code-sync-loop 六章节设计包适配规格（已立项 · 待实现）

> 2026-11-07 用户裁决立项；实现排专门会话。现状 interim = 六章节设计包的 D5 走 dev-flow-wf SKILL 手工路径（实测形态：anchor-production-layer / advice-quality-loop 两包，2026-11-07）。

## 问题

`design-code-sync-loop` 的 setup 探针把 designDoc 限定为常规文件（statSync 目录即拒收，2026-11-04 加固），而 tech-design-wf 现行权威源 = 六章节 JSON 设计目录（`<name>/` + `<name>.rendered.md` 渲染视图）。六章节设计包发起 W4 即 `setup-failure`。T3 符号词表节早已登记「下游输入适配为待办」。

## 适配方案要点（骨架）

1. **入口双形态归一**：designDoc 为目录时，审查面归一为 `<dir>/<name>.rendered.md`（渲染视图，格式由渲染脚本固定生成）；为单文件 .md 时维持现行为。setup 探针改两分支：目录形态验 `check-design-doc.mjs exit 0` + 渲染视图存在，单文件形态维持 statSync 常规文件校验。
2. **审查/修复双轨穿透**：designDoc 在源内 25+ 处消费点按语义分两轨——
   - 审查面（reviewer 引文来源、机械扫描、指纹、resumeFrom 比对）= rendered.md；
   - 修复面（doc_errors / code-right 的文档修复组指令）= 章节 JSON（`s1-context.json` … `s5-breakdown.json` / `meta.json`）+ 修复后经 `tech-design-wf/scripts/render-design-doc.mjs <设计目录绝对路径>` 重渲染；
   - 引文校验（「引文只允许出自两份人读版」）对目录形态改读 rendered.md；
   - 指纹（docFingerprints / resumeFrom 前置）对目录形态 = 六章节 JSON 聚合指纹 + rendered.md 指纹（渲染产物可再生成，指纹以章节 JSON 为准、rendered 指纹仅作对账）。
3. **修复组指令注记**：目录形态的文档修复任务书显式写「权威源 = 章节 JSON，禁止直接改 rendered.md（渲染产物，改动不回流）」，并附渲染命令。
4. **词表等集校验对齐**：T3 词表 sourceFingerprints 已按「rendered.md + impl-plan.md」双指纹登记——setup 等集校验对目录形态直接复用该指纹对（与现行协议一致，无额外工作）。

## 验收

- 六章节设计包（真实包，如 anchor-production-layer）发起 W4 走完 setup → R1 → 修复 → 收敛终态，且文档修复笔落在章节 JSON、rendered.md 由渲染器再生（非手改）。
- 单文件 .md 旧形态回归不破（现行为逐字节保持）。
- `node scripts/build-workflows.mjs --check` 绿；两平台产物重建。

## 范围扩展：发起输入收敛与词表生命周期（2026-11-07 用户裁决追加）

源自 2026-11-06/07 两任务 9 次可避免 setup-failure 的根因分析（止血修复见 zsw-skills commit 173b067：词表键归一 / 报错拆根因 / --check 自验 / exec-plan 校验前移）。四类错误生成器中的两类属结构性——「手拼可推导参数」与「词表生命周期过长」——本 spec 是 D5 输入形态的现行定义载体，扩展范围一并解决，避免适配落地后二次重构。

### 扩展点 1：W4 发起参数推导化（args 契约变更）

- 现状：`{ designDoc, implPlan, projectRoot, statusPath?, watchlist, … }` 多个绝对路径由主 agent 手拼——布局推导逻辑（skill-data-addressing：slug 按 projectRoot 检测拼接）已存在且入口门在用，args 未复用；每次发起重复推导，形态错一次即 setup-failure（实证：implPlan 层级错、watchlist 缺传/形态错共 3 次）。
- 目标：必填参数收敛为 `{ projectRoot, taskName }`（designDoc 目录按布局推导：`tech-design/<slug>/<taskName>/`）；implPlan / statusPath / watchlist 全部按 skill-data-addressing 布局推导。显式传参可覆盖推导值（逃生舱）；setup 对实际生效来源（推导/显式）逐参数披露一行；推导落空时报错列出推导路径与目录实况。
- 验收判据：六章节设计包发起 W4 必填 args ≤2；主 agent 不再手拼任何路径参数。

### 扩展点 2：词表生命周期缩短（协议变更——取代下方原「不改 tech-design-wf 侧协议」边界）

- 现状：T3 产完整词表（含 sourceFingerprints 指纹）落盘 → D5 setup 指纹校验。词表生命周期跨越 T3 确认与 D0-D4 全程，期间任何文档改动都使指纹过期——D5 修复轮自身改文档后，续跑必挂「源文档已改而词表未重生成」（2026-11-07 实证），主 agent 需手工重产再续跑。
- 目标形态：跨阶段只保存**语义甄别结果**（scan/skip 判定与理由，新文件形态 `<name>.symbol-scan.json`）；机械部分（提取 + 指纹）移入 W4 setup 现场重建——setup 内以相对传参调用 `~/.agents/skills/symbol-watchlist/scripts/extract-backticks.mjs`（键归一绝对）对当前文档现提词集 → 与语义甄别文件对账（词集差集沿用 wordsDrift 软监测语义）→ 覆盖完整即开审。
- 收益：「词表过期」状态消失（没有跨阶段指纹就没有过期），键形态 / 指纹不等 / 重产指引整族故障随协议变更消灭；symbol-watchlist skill 的 --check 自验门改为对「语义文件 + 当前文档」做同构校验。
- T3 词表节相应调整：甄别后只落语义文件；完整词表（含指纹）不再作为交付产物。

### 扩展点 3：rendered 锚定归并（原文第 16 行既有，确认适用）

- docFingerprints 以章节 JSON 聚合指纹为准、rendered.md 指纹仅对账（原文既有）；扩展点 2 的机械步跑在 rendered.md 上、漂移判定锚章节 JSON——rendered 可再生，章节 JSON 是唯一权威锚。

### 验收增补

- 六章节设计包 T3 确认后改章节 JSON → 直接发起/续跑 D5，不再出现「词表指纹不等」类 setup-failure（机械步现场重建）。
- 旧完整词表（含 sourceFingerprints）的兼容读取或一次性迁移路径明确（存量两包：chat-flow-process-aggregate / provider-aggregation）。

## 边界

- 词表协议变更随本 spec 实施（扩展点 2 取代早先「词表协议现行即可用」的过渡判断）；tech-design-wf 侧其余协议不动。
- 手工路径在适配落地前保持合法（dev-flow-wf SKILL 各 flow 文件的手工降级条款）。
