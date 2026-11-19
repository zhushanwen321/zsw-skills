/* @pi-meta
name: assurance-repair-loop-v6
description: >-
  delivery-v6 技能 ASSURE 段受控修复循环：独立聚合给出来源阶段、受影响断言和
  回归测试，builder 修复产品代码与测试，独立 reviewer 做受影响一致性复核，最后以
  recheck 重跑确定性测试并生成当前版本证据。RepairRoundRecorded 记录实现性修复，
  第 4 轮或第 11 条不同 must-fix 进入 process-failed；不默认重新开放探索
when: >-
  最终保证出现实现缺陷时使用；必传 projectRoot / taskDir / assuranceCredentialId /
  builderCredentialId / allowCommit。候选开放探索用 independent-assurance-v6；
  验收修订与用户风险接受留在主会话
notFor: >-
  验收设计（acceptance-design-v6）、候选开放探索（independent-assurance-v6）、
  用户风险接受（主会话 delivery-gate accept-risk）
phases: ['修复、受影响复核与最终取证']
parameters:
  type: object
  properties:
    projectRoot:
      type: string
      description: "项目根绝对路径（coverage/explorer 读代码与运行验证命令的工作目录）"
    taskDir:
      type: string
      description: "任务目录绝对路径（delivery-gate init 创建；读契约/事件/verdict，写覆盖报告、探索报告、证据与保证总结）"
    assuranceCredentialId:
      type: string
      description: "assurance 角色凭据 id（init 输出，形态 <分组>/<任务id>/assurance）——复核、证据与解决事件只能由 assurance 签署，私钥本体不进参数与 prompt"
    builderCredentialId:
      type: string
      description: "builder 角色凭据 id（init 输出，形态 <分组>/<任务id>/builder）——实现性修复与 RepairRoundRecorded 只能由 builder 签署"
    allowCommit:
      type: boolean
      description: "是否允许 workflow 按 builder 申报的精确文件路径提交修复笔；必须由主会话确认 worktree 后显式传 true"
    fixSuggestions:
      type: boolean
      description: "must-fix 清零后是否再统一修一批 suggestion；缺省 false"
    runId:
      type: string
      description: "可选写事务租约 run id（acquire/heartbeat/release 全程配对）"
    taskId:
      type: string
      description: "观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测）"
    executionId:
      type: string
      description: "本次执行标识（可选；观测 JSONL 文件名主干，命名规则同 taskId）"
    sampleType:
      type: string
      description: "观测样本类型（可选）——production = 真实执行（缺省）/ selftest = 测试执行"
  required: [projectRoot, taskDir, assuranceCredentialId, builderCredentialId, allowCommit]
*/

// ===== zcode→pi 兼容 shim（两版差异区之一：另含 @pi-meta 头/schema 常量/TS 剥离/agent 调用层）=====
const { spawnSync } = require("node:child_process");
const $WS = typeof $WORKSPACE === "string" ? $WORKSPACE : process.cwd();
// world.run：zcode facade 的命令执行（cwd=workspace、非零退出码为返回值非异常）
const world = {
  run: async (cmd, a, opts) => {
    const r = spawnSync(cmd, a ?? [], {
      cwd: $WS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      timeout: opts && opts.timeoutMs ? opts.timeoutMs : 300000,
    });
    // 执行器故障/超时 throw 对齐 zcode reject 语义（非零退出码仍是返回值不是异常）
    if (r.error) throw r.error;
    return { exitCode: r.status === null ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
};
// args：pi 的 $ARGS（--args k=v）由宿主以 `const args = $ARGS` 注入——产物重声明
// args 会炸 SyntaxError，故就地归一化 $ARGS（宿主别名同指此对象）。
// objective 除外：用户原始意图文本可能是纯数字形态的合法输入，数字归一化会把它
// 变成 number，违反 shared 的「objective 须为字符串」校验。匹配用正则字面量而非
// 字符串字面量——双平台对账的业务串差集不含正则字面量内的文本
for (const [k, v] of Object.entries(typeof $ARGS === "object" && $ARGS !== null ? $ARGS : {})) {
  if (/^objective$/.test(k)) continue;
  if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    $ARGS[k] = Number(v);
  }
}
// report / artifact：zcode 专有通道，pi 无对应面，降级为 no-op（结果仍经 return 交付）
const report = () => {};
const artifact = { chart: () => {}, board: () => {}, markdown: async () => {}, file: async () => {} };

// ── 结果 schema 常量（ask 结构化返回契约；与 shared 的 interface 顶层字段/required 对齐——
//    check-workflow-parity 维度 4 按字段名核对） ──

// FindingDraft（三档分级发现申报）——复核/覆盖结论里 findings 条目的字段契约。
// findings.items 一律复用本常量，不内联副本（内联副本会与 FindingDraft 契约分叉漏字段）
//（repair 循环不产出 ExplorationOutcome：recheck 不重新开放探索）
const SCHEMA_FindingDraft = {
  type: "object",
  properties: {
    summary: { type: "string", description: "缺陷现象与影响" },
    requirementIds: { type: "array", items: { type: "string" }, description: "关联契约条目 id；契约外发现为空数组" },
    tier: { type: "string", enum: ["must-fix", "suggestion", "info"], description: "V6 代三档分级：must-fix=违反验收判据（立即修复档）；suggestion=建议改进但不违反判据（攒批档）；info=信息登记（不修，披露即可；事件侧按 defect/non-blocker 登记）。拿不准 must-fix 还是 suggestion 按 must-fix" },
    category: { type: "string", enum: ["defect", "boundary"], description: "可选显式分类覆盖（缺省按 tier 映射 defect）：仅 non-must-fix 档可设 boundary，用于无断言覆盖的真实边界申报；关联需求已有断言级判据明文覆盖的行为不得设 boundary，空关联时必附 emptyScopeRefutation" },
    consequenceRefutation: { type: "string", description: "非 must-fix 必填：否定其用户可观察后果的依据；禁止只按字面合规降级" },
    consequenceRefutationType: { type: "string", enum: ["will-not-occur", "not-observable", "accepted-by-acceptance"], description: "非 must-fix 必填：论证类型三择一（will-not-occur=不会发生 / not-observable=用户不可观察 / accepted-by-acceptance=验收明确允许），先标类型再给依据" },
    emptyScopeRefutation: { type: "string", description: "空关联 boundary 的不影响任何需求论证（空关联不得绕过定级护栏）" },
    contractCapabilityIds: { type: "array", items: { type: "string" }, description: "认领的外部契约能力 id（「契约id:能力id」限定形式；裸 id 仅在当前任务能力全表中唯一命中时可用，多契约包或裸 id 歧义必须用限定形式）；结构命中外部契约时 authority 组必填（外部行为反驳必须引用权威工件）" },
    authorityBacked: { type: "boolean", description: "外部行为反驳已引用权威工件（须同时给 authorityHash 与 authorityObservationRef）" },
    authorityHash: { type: "string", description: "权威工件内容哈希（authorityBacked=true 时必填）" },
    authorityObservationRef: { type: "string", description: "权威工件观察记录引用（权威来源文件路径或记录 id；authorityBacked=true 时必填）" },
    reopenOf: { type: "string", description: "重开申报：指向此前被关闭（非 open）的 findingId，且关闭后判据环境须已变化（验收版本或代码 revision）；不确定是否同题时不填" },
    origin: { type: "string", enum: ["acceptance", "design", "planning", "implementation", "testing", "evidence", "environment"], description: "来源阶段（must-fix 建议填写）" },
    firstDetectedStage: { type: "string", description: "实际发现该问题的阶段（must-fix 建议填写）" },
    expectedStage: { type: "string", description: "该问题本应在哪个阶段被拦截（must-fix 建议填写）" },
    regressionTestRef: { type: "string", description: "回归测试标识（must-fix 建议填写）" },
  },
  required: ["summary", "requirementIds", "tier"],
};

// coverage reviewer（coverage-reviewer.md 角色）结构化返回：逐项覆盖结论——每
// requirement×evidenceKind 恰一项，artifact 须为 evidence/ 内原始文件
const SCHEMA_CoverageOutcome = {
  type: "object",
  properties: {
    summary: { type: "string", description: "覆盖核对范围与依据摘要（对照了什么、亲自跑了什么）" },
    evidence: {
      type: "array",
      description: "逐项覆盖结论（必须精确覆盖每 requirement × evidenceKinds 一次，不重不漏）",
      items: {
        type: "object",
        properties: {
          requirementId: { type: "string", description: "契约条目 id" },
          kind: { type: "string", enum: ["command", "scenario", "inspection"], description: "证据类型（须属于该 requirement 声明的 evidenceKinds）" },
          result: { type: "string", enum: ["verified", "partial", "failed"], description: "独立核对结论——builder 的测试输出未经独立核对不得记 verified" },
          assertionIds: { type: "array", items: { type: "string" }, description: "schema 2 证据明确覆盖的断言 id" },
          adversarialFormIds: { type: "array", items: { type: "string" }, description: "证据实际构造的反例场景 id" },
          contractCapabilityIds: { type: "array", items: { type: "string" }, description: "该证据覆盖的外部契约能力 id（「契约id:能力id」限定形式；裸 id 仅在当前任务能力全表中唯一命中时可用）——runtime 义务的认领通道，漏标会让对应义务保持 open" },
          runtimeProbe: { type: "boolean", description: "真实 runner/宿主驱动的 IA 亲自执行 probe 证据（runtime 义务唯一可满足形态）；builder 自报回执不标" },
          artifact: { type: "string", description: "任务目录 evidence/ 内已存在的原始证据文件绝对路径" },
        },
        required: ["requirementId", "kind", "result", "artifact"],
      },
    },
    findings: {
      type: "array",
      description: "新发现清单（无则空数组；findingId 由引擎统一分配，不在此申报）",
      items: SCHEMA_FindingDraft,
    },
    resolvedFindingIds: {
      type: "array",
      items: { type: "string" },
      description: "亲自复核确认已修复的旧 findingId（仅限本轮开始前仍 open 的发现；未确认不报）",
    },
    unresolvedFindingIds: {
      type: "array",
      items: { type: "string" },
      description: "V6 代：亲自核对后确认仍未修复的既有 open finding（排除自动重认领；与 resolvedFindingIds 不得重叠）",
    },
  },
  required: ["summary", "evidence", "findings", "resolvedFindingIds", "unresolvedFindingIds"],
};

const SCHEMA_RepairPlan = {
  type: "object",
  properties: {
    summary: { type: "string" },
    affectedAssertionIds: { type: "array", items: { type: "string" } },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          guidance: { type: "string" },
          origin: { type: "string", enum: ["acceptance", "design", "planning", "implementation", "testing", "evidence", "environment"] },
          expectedStage: { type: "string" },
          regressionTestRef: { type: "string" },
        },
        required: ["findingId", "guidance", "origin", "expectedStage", "regressionTestRef"],
      },
    },
  },
  required: ["summary", "affectedAssertionIds", "items"],
};
const SCHEMA_RepairBuilderOutcome = {
  type: "object",
  properties: {
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    testEvidence: { type: "string" },
    affectedAssertionIds: { type: "array", items: { type: "string" } },
    // 高风险修复的最小同族组合分析（设计《V5 交付完整性与语义可信性改造》§9.1：
    // 复用修复报告，不新建事件流——报告结构，gate 判定不依赖）。可选字段：blocker 轮
    // 缺失经一次修正重问仍缺 → 报告降级（defectFamilyIncomplete），不阻塞修复本身
    defectFamily: {
      type: ["object", "null"],
      description: "按根因改变输入数量/故障位置/时序/路径形态选出的最小有区分度组合（不做笛卡尔积全展开）",
      properties: {
        rootCause: { type: "string", description: "根因一句话（如：关闭检查只在条目循环前执行一次）" },
        dimensions: {
          type: "array",
          description: "会随缺陷形态变化的关键维度清单",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "维度名（输入数量/故障位置/时序/路径形态等）" },
              values: { type: "array", items: { type: "string" }, description: "该维度上有区分度的取值样本" },
            },
          },
        },
        selectedCases: { type: "array", items: { type: "string" }, description: "最小组合的用例名；对应测试必须真实存在" },
        redBeforeFix: { type: "array", items: { type: "string" }, description: "缺陷版本失败证据文件路径（复现原始缺陷的测试在修复前的失败记录留档）" },
        greenAfterFix: { type: "array", items: { type: "string" }, description: "修复版本通过证据：selectedCases 对应测试的文件路径+用例名" },
        mutationRefs: { type: "array", items: { type: "string" }, description: "撤销修复再失败证据文件路径（在临时副本上把修复改动改回缺陷版本、跑测试见红、再恢复副本——文件级副本操作，禁止 Git 写；引擎在 builder 返回后才提交，revert 修复 commit 在时序上不可实现）；blocker 级必填，无豁免通道" },
      },
    },
  },
  required: ["summary", "filesChanged", "testEvidence", "affectedAssertionIds"],
};
const SCHEMA_RepairReviewOutcome = {
  type: "object",
  properties: {
    summary: { type: "string" },
    testEvidence: { type: "string" },
    resolvedFindingIds: { type: "array", items: { type: "string" } },
    unresolvedFindingIds: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: SCHEMA_FindingDraft },
  },
  required: ["summary", "testEvidence", "resolvedFindingIds", "unresolvedFindingIds", "findings"],
};

// wfAgent：公共体的 agent(name, persona).ask<T>(prompt) 的 pi 等价。构建管线把公共体
// 调用点改写为 wfAgent(、泛型参数转为首个字符串参数（typeKey），这里查 SCHEMA_BY_KEY。
// persona 拼 prompt 头（pi agent() 无 system 通道）；每次调用都是新 agent（pi 无续聊）。
const SCHEMA_BY_KEY = {
  CoverageOutcome: SCHEMA_CoverageOutcome,
  FindingDraft: SCHEMA_FindingDraft,
  RepairPlan: SCHEMA_RepairPlan,
  RepairBuilderOutcome: SCHEMA_RepairBuilderOutcome,
  RepairReviewOutcome: SCHEMA_RepairReviewOutcome,
};
function wfAgent(name, persona) {
  return {
    ask: async (typeKey, instructions) => {
      const schema = SCHEMA_BY_KEY[typeKey];
      if (!schema) throw new Error(`未知 ask 类型键 ${typeKey}（SCHEMA_BY_KEY 未登记）`);
      // desc 直取 name 原文（不做后缀剥离）：pi 实例名须与静态第一实参一致——
      // workflow DAG 静态派生模板按调用点第一实参提取，剥离会让带轮次后缀的名字
      // 匹配不上实例；且 zcode 侧同名即续聊，后缀是轮次新 agent 的身份语义，
      // 两平台显示名本就应当对齐。
      const desc = String(name);
      const prompt = persona ? persona + "\n\n=====\n\n" + instructions : instructions;
      const raw = await agent({ prompt, schema, description: desc });
      if (raw === null || raw === undefined) throw new Error("agent() 无返回");
      if (typeof raw === "object" && raw !== null && typeof raw.error === "string" && raw.error) throw new Error(raw.error);
      return raw;
    },
  };
}

// ── O 区观测平台钩子：写通道 = world.run（shim 内 spawnSync；无 journal 重放语义，每次 run 实写）。
// shared 观测层调用 obsNow/obsAppend；换平台只换钩子实现，事件契约在 shared ──
const OBS_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
const OBS_APPEND_LINE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});" +
  "require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')";
async function obsNow() {
  try {
    const r = await world.run("node", ["-e", OBS_PROBE_NOW]);
    const t = r.exitCode === 0 ? r.stdout.trim() : "";
    return t !== "" ? t : null;
  } catch (e) {
    // 执行器故障（spawn 失败/超时）：观测降级为不记录该事件，业务不受影响
    return null;
  }
}
async function obsAppend(filePath, line) {
  try {
    const r = await world.run("node", ["-e", OBS_APPEND_LINE, filePath, line]);
    return r.exitCode === 0 ? null : `exit ${r.exitCode}：${r.stderr.trim() || r.stdout.trim()}`;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

@@STITCH@@
