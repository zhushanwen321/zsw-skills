# D5 终态同步 — W4 design-code-sync-loop 契约与手工路径

> 把「代码实现 vs 设计文档」差距收敛到 0 must-fix 的**双向**校准循环。审查对象 = **当前 HEAD 终态全量**（不是 diff 区间——交付后的修复 commit 不在任何流水线记录里，只有全量对照能抓到）。报告落 `<项目根>/.tmp/dev-flow/<name>.sync/round-N/`。

## W4 workflow 契约（zcode 环境默认动作）

```
CreateWorkflow saved: design-code-sync-loop
args: { designDoc, implPlan, projectRoot, maxRounds?, statusPath? }   // statusPath = status.json 绝对路径——planner 职责②进度核对数据源；未传时降级单侧核对并在 frameworkFindings 的 note 注明
终态: converged / contested / stuck + setup/planner/review/fix/retire/io-failure
```

引擎语义（两级审查拓扑 + 轮次收敛）：

```
phase 1  framework-scan（planner，1 agent）：
   输入 = 设计文档(§3 机制/§5 拆分) × 代码目录结构 × HEAD 终态 × impl-plan × 关联登记面清单
   职责 = ① 框架级对照（架构/分层/数据流与设计的差异——架构漂移直接进矩阵顶层行）
          ② 模块分解 ModulePlan[]（结构化，驱动 phase 2 fan-out）
phase 2  module fan-out：modules.map(m => agent(`module-${m.id}`))——并行
   模块 reviewer：矩阵行填充 + 越权三问 + 注释口径 + findings
phase 3+ 修复循环：双向修复 → 聚焦复审 →（轮）→ 退役判定 → 终态
```

**流程排序**：机器信号（反引号 grep 脚本步）在模块语义审查（fan-out）之前清零——确定性信号先行（紧跟 planner 框架扫描），语义判级归 reviewer 复核。

**修复分组确定性校验（reconcileGroups）**：`modules[].files` 是 LLM 自报字段，并行 fixer 组间文件相交 = 冲突——组间 files 相交传递闭包合并 + 无效组过滤 + 覆盖兜底（脚本，不信任 planner 自觉）。

## 方向语义（权威定义，勿反向）

| direction | 含义 | 修复动作 |
|-----------|------|---------|
| **doc-right** | 文档更合理（默认——设计文档过对抗审，是意图 SSOT；实现偏离默认视为漂移） | **修代码**（跑增量测试必须绿） |
| **code-right** | 代码更合理（实现期发现的文档盲区/错误，实现行为有证据确认更合理） | **修文档**（过联动自检五处：正文/数据流图/错误规格/拆分清单/验收场景） |
| **contested** | 两边有实质道理且影响公开 API / 行为语义 / 数据格式 | must-fix 级**停回用户**；suggestion 级默认 doc-right 并汇报列出 |

**selfCheck 口径**：selfCheck 由聚焦复审消费（reviewer 复跑命令/核对预期），非引擎执行——复跑不过或无证据 = 条目回流重修；无测试套件的仓库可用 grep 断言，测试面缺失如实呈现不虚构。

## 三向功能对照矩阵（审查报告主体，findings 是单元格展开）

```markdown
| # | 设计声明（§N 锚点） | 代码实现（file:line 锚点） | 判向 | 说明 |
|---|--------------------|---------------------------|------|------|
| 1 | 步骤可见性合并投影 | projection.ts:88 | 一致 | 语义核对通过 |
| 2 | §3.2 水位终态计数 | （未找到实现） | 漏实现 | design 有 code 无 |
| 3 | （设计未声明） | throttle.ts:12 节流器 | 越权实现 | → 见三问评估 |
```

**越权实现三问**（code 有 design 无时逐个过）：

1. **核心价值锚定**：该实现服务本次设计的哪条目标（回溯 §1）？说不出服务对象 = 第一疑点
2. **最小功能骨架**：摘掉它，设计目标是否仍完整达成？是 → 不在最小骨架内
3. **扩展集证据**：为未来预留且无已发生证据（第二个使用方/已发生的变化原因）？SDK/宿主已有等价面而自造一层（SDK 影子层判定）？

三档裁决（裁决权在人，agent 只报告）——机器落点：**合理** → reviewer 立一条 code-right finding（回写文档登记）进正常修复循环；**过度/存疑** → 只进矩阵行 + 候选卡，引擎拦截不进修复组（框架行入账即转；模块行 fixer 可申报 defer 拒删码）——随终态 overdesignCandidates 呈报，用户裁决后才可能产生删码动作。越权行必须附调用方证据（防幻觉）；「主 agent 抽验 ≥1 调用点」在交付汇报时对候选卡执行。

## 审查关系五条（全量保留，落点）

a. 代码 ↔ 设计文档（主对照）→ framework-scan + 模块 reviewer；b. 现实 ↔ impl-plan（进度/残留风险/变更历史反映当前）→ planner；c. impl-plan 内部一致性 → planner；d. 注释口径（测试文件头/生产文件注释 vs 当前实现）→ 模块 reviewer；e. 关联登记面 × 存量文档同步 → planner 末项。**机械信号**：R1 内置 world.run 机械步（引擎自动提取反引号标识符批量 git grep，悬空立项 owner=mechanical；R2+ 引擎重跑机械步对账）——reviewer 模板的反引号职责是复核机械条目与补漏，不是唯一防线；行号坐标漂移不立项（符号可定位语义成立 = 无影响——核实目标是交付一致性）。

## 修复纪律（每轮）

- 所有等级（must-fix/suggestion/info）当轮修完不留尾巴；修复前重演 fix-hint，建议站不住换更稳方案并说明
- **波及扫描**：每修一处 grep 同模式实例（同类注释/测试文件头/其他文档引用点）——组内实例一并修（漂移从来不是单点）；组外文件里的同模式实例不改（并行冲突），在条目 description 标注「组外波及：<位置>」留给聚焦复审立项（下轮经组外波及标注通道回流）
- 修复组按模块分组并行（领地互斥 ≤5）；每组核验过即 commit（组级一笔）；subagent 禁 git 写
- **聚焦复审**（R2+）：只审上轮修复成立 + 是否引入新差距，不重查已确认项

## 终态处置

| 终态 | 主 agent 动作 |
|------|--------------|
| converged | 交付汇报：矩阵 + 收敛轨迹（各轮三等级计数）+ direction 分布 + contested 记录 + overdesignCandidates + 退役判定 |
| contested | must-fix 级方向争议逐条呈报用户裁决；裁决后重新发起（runDir 自动 attempt 后缀不覆盖历史；重发起首轮 = planner 全量重审，上轮修复在重审对账中确认——无跨 run 台账延续） |
| stuck | must-fix ≥4 轮不收敛或单条 must-fix 超 2 轮 → 呈报残余差距矩阵 |
| `*-failure`（setup/planner/review/fix/retire/io） | 按 message 恢复动作：ResumeWorkflowRun 或 attempt 递增重发 |

**衔接**：W4 修复触及验收场景表覆盖行为时，主 agent 重跑受影响场景（局部重验，不重开整门）。

## 伴生产物退役判定（converged 时）

本设计相关产物去留：已在 `.tmp/` 的（设计文档/impl-plan/审查报告）合规无需处理；残留在 docs/ 的伴生产物（旧惯例 `.review*` / probe）→ 移入 `.tmp/design-doc-retirement/`（引用验证：按完整文件名全仓 grep，任一命中不退役；移动后反向复验悬空链接）；被整体取代的旧设计文档零外部引用 → 同目录退役。退役移动结果与依据记入 final.json 的 retirement 字段；退役目录同时写 README.md 索引（文件名/日期/依据/找回方式）。判定结果进交付汇报（退役 N / 保留 N 含依据 / 无可退役显式说）。

## 手工降级路径

workflow 未就绪时：主 agent 按「两级拓扑」手工执行——先派 1 个 planner（task = framework-scan 职责，输出模块计划文件），按计划并行派模块 reviewer（模板 `agents/sync-reviewer.md`），聚合判定矩阵，修复循环按上节纪律，全程本文件语义。差距面小（设计只动一模块）时 planner 返回单模块 = 自动单 reviewer。
