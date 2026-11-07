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

## 边界

- 不改 tech-design-wf 侧协议（词表协议现行即可用）。
- 手工路径在适配落地前保持合法（dev-flow-wf SKILL 各 flow 文件的手工降级条款）。
