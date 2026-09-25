# D2 一致性审查、修复循环与 Gate A — W3 契约与手工路径

> 审查对象 = `git diff <基线>..HEAD` 与设计文档章节对照。轮次唯一形态：**R1 = 全面分区审；R2+ = 定向复审**（只审上批修复的影响面，不全面重审）。收敛方向两个：实现回归文档，或文档经确认后演进（进登记表）。

## W3 workflow 契约（zcode 环境默认动作）

```
CreateWorkflow saved: dev-consistency-loop
args: { execPlan: "<path>.exec-plan.json" }
终态: converged（unreasonable 清零 + Gate A 绿）/ stuck
```

引擎语义（无 LLM 聚合层——分区互斥契约下聚合退化为脚本操作）：

- **分区**：`git diff --name-only <基线>..HEAD` 文件清单的不相交划分（按顶层模块归组；共享文件归入首个引用它的分区并标注）——**脚本生成，文件集不相交是硬校验**
- **R1**：分区 reviewer 并行（模板 `agents/consistency-reviewer.md`），三分类结构化返回
- **脚本聚合**：分类计数 / 修复分组（= 分区边界）/ doc_errors·reasonable 收集回流——不派 LLM 聚合；跨区双报的 finding 文件锚点唯一归属一个分区，去重放弃（双修无害）
- **修复组并行**：组间领地互斥（≤5），每组 fixer；组内核验过即 commit（组级一笔）
- **R2+**：定向复审（只审上批修复影响面：修复成立？/引入新问题？/新 diff 暴露新偏差？）→ 回修复或清零
- **停机线**：累计 ≥3 轮不收敛或不减反增 → stuck；**单条 unreasonable 修复超 2 轮 → 升级用户**
- **Gate A**（清零后）：world.run 全量测试（范围 = exec-plan testPlan 全量段，产物类条目第一波并行预备），输出落 `<name>.gate-a.log`
- doc_errors（文档错了）与 reasonable（合理演化）**不进修复循环**，随终态回流主 agent：doc_errors 主 agent 亲修设计文档（持审查全景，非编码）；reasonable 写入 impl-plan 合理偏差登记表（`.impl-plan.md` §5 + json notes）

## 手工降级路径

1. **规模判定**：diff ≤500 行或单元 ≤2 → 单 reviewer 全审（且任务书附带跑全量测试 + lint/typecheck + 覆盖矩阵，Gate A 不再单列）；否则分区并行（分区规则同上，主 agent 手工划分 + 核对文件集不相交）
2. **R1 派发**：每区一个 reviewer（general-purpose + task 内嵌 `agents/consistency-reviewer.md` 全文），后台异步、先到先读、聚合去重待全齐；reviewer 相互独立禁止引用彼此结论
3. **结论处理**：unreasonable 按领地分组并行修（组内串行组间并行 ≤5；每组三段式 task 附全组条目 + file:line 证据；组完成先到先核验先 commit）；`影响决策 = 是` 的条目优先（先评估是否须改设计文档再修代码）；`影响交付 = 验收` 的条目修复后重核对应验收场景可检验性；doc_errors/reasonable 按上表处理
4. **微修复合并**：单条小修（<5min）攒入下一修复批次，仅当它是 Gate 通过唯一阻塞项才单独派发并即刻重验
5. **R2+ 定向复审**：每组修完即派只审该组影响面的复审，不攒轮；未清零回 3
6. **Gate A**：主 agent 直跑全量段（命令从项目配置真实读取；输出落 gate-a.log）——**零容忍绕过**（任何 SKIP_*/test.skip/跳过的 lint 规则发现即失败项）；有 failures 派归因 subagent 读落盘输出逐条归因（回 D1 补修 / 用户签认转残留风险登记）；**覆盖矩阵**：单元领地 × 实际用例列无人认领改动区（补测试或登记理由）；**产物类前置**：产物构建/fixture 生成第一波并行启动，禁现用现建
7. Gate A 绿 → status.json 记一笔（命令 + 关键输出行，不产生 commit）→ 进 `flow/acceptance.md`
