# 设计文档模板（六章节 JSON 起步样例）

本目录是设计包起步模板：六个章节 JSON 已含最小合法形态，值均为 `<...>` 占位文本，复制到 `~/.agents/skill-data/tech-design/<project-slug>/<name>/` 后逐字段替换（name 字段与目录名同步改为设计名）。字段权威规格见 `references/design-doc-schema.md`；每次章节 JSON 修改后跑 `node <tech-design-v2 技能根>/scripts/render-design-doc.mjs <设计目录>` 生成 / 刷新 `<name>.rendered.md` 阅读视图（非权威、禁止手改）；交付前 `node <tech-design-v2 技能根>/scripts/check-design-doc.mjs <设计目录>` 必须 exit 0。

本样例 designType = evolution（演进型最小形态）。判终态型时：meta.json 的 designType 改为 terminal 并把 typeRationale 换成触发依据；s3-solution.json 补 `terminalForm`（axioms / targetForm / gapTable 三字段，公理与差距逐条登记）与 `migrationWaves`（差距-波次映射）两字段，decisions 的 gapRefs / axiomRefs 随登记填写——字段表见 schema §6。

meta.json 的 `relatedDocs` 是关联登记清单：本设计触及、修改、推翻的存量权威文档（ADR / 产品定义 / 领域模型等）逐条登记 `{ path, relation }`，供下游终态同步核对回写；无关联时保持空数组即可。

交付体系任务（三技能交付体系，delivery-v2 已批准验收）另须在 T1 入口门给 meta.json 加 `acceptanceBinding` 字段（模板最小形态不含它——独立设计任务省略）。示例形态：

```json
"acceptanceBinding": {
  "acceptanceVersion": 1,
  "acceptancePackageSha256": "<64 位 sha256：绑定的验收包哈希>",
  "taskDir": "~/.agents/skill-data/delivery/<分组 slug>/<任务 id>"
}
```

写入义务与判据见 `flow/write.md` Step 0 交付体系入口门（验收批准检查通过后写入）；子字段规格见 schema §3；渲染视图头部呈现为「验收绑定」行。

决策含守护 / 命令 / 正则类可执行内容时，登记在该决策的 `guards` 字段（id / text / note，单一登记），其他章节的文本字段内联完整标记 `{{G1}}` 引用——渲染自动展开为登记全文（字段规格见 schema §6.3，引用语法见 §9）。
