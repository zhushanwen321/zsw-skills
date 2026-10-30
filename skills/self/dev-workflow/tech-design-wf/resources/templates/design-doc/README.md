# 设计文档模板（六章节 JSON 起步样例）

本目录是设计包起步模板：六个章节 JSON 已含最小合法形态，值均为 `<...>` 占位文本，复制到 `~/.agents/skill-data/tech-design/<project-slug>/<name>/` 后逐字段替换（name 字段与目录名同步改为设计名）。字段权威规格见 `references/design-doc-schema.md`；每次章节 JSON 修改后跑 `node <tech-design-wf 技能根>/scripts/render-design-doc.mjs <设计目录>` 生成 / 刷新 `<name>.rendered.md` 阅读视图（非权威、禁止手改）；交付前 `node <tech-design-wf 技能根>/scripts/check-design-doc.mjs <设计目录>` 必须 exit 0。

本样例 designType = evolution（演进型最小形态）。判终态型时：meta.json 的 designType 改为 terminal 并把 typeRationale 换成触发依据；s3-solution.json 补 `terminalForm`（axioms / targetForm / gapTable 三字段，公理与差距逐条登记）与 `migrationWaves`（差距-波次映射）两字段，decisions 的 gapRefs / axiomRefs 随登记填写——字段表见 schema §6。

meta.json 的 `relatedDocs` 是关联登记清单：本设计触及、修改、推翻的存量权威文档（ADR / 产品定义 / 领域模型等）逐条登记 `{ path, relation }`，供下游终态同步核对回写；无关联时保持空数组即可。
