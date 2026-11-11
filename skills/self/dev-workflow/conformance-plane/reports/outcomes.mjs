// outcomes.mjs — 四层结论派生（sync-conformance-plane U5/M5，§3 终态第七段报告迁移层）
//
// 语义权威（设计 sync-conformance-plane §3 终态第七段 / GA9 / AX10 / V8 / V10 / V12）：
//   段七  四层结论报告全派生，取值词表固定：
//           scriptStatus ∈ running / completed / failed
//           engineOutcome ∈ completed / awaiting-ruling / stopped / failed
//           integrationOutcome ∈ not-required / not-started / verified-pending-integration /
//                                integrated / rolled-back / failed（partial 只作事件中的瞬时
//                                逐仓状态，不是终态枚举——本词表不含它，测试固化）
//           deliveryOutcome ∈ pending / resolved / resolved-by-main-agent / blocked
//   AX10  人工裁决与接管只能追加事件；引擎结论、集成结论与交付结论分层呈现，不可互相覆盖——
//         本模块每层有唯一权威源（见 deriveOutcomes 各层注释），一层的后续事实不改写另一层已
//         定型的结论（V12：引擎 stopped 后人工集成 → engineOutcome 仍 stopped、
//         integrationOutcome=integrated、deliveryOutcome=resolved-by-main-agent 四层并存）。
//   AX3   报告是派生视图：本模块为纯函数，不读写盘、不维护可变状态；每次渲染从事件流 fold
//         重建（V10 报告删除后重建的领域核入口）。
//
// 分层权威源（分层呈现的实现形态）：
//   scriptStatus  ← engineReturn.scriptStatus（引擎脚本执行层结论——只有引擎自己知道脚本是否
//                   跑完；事件流无脚本层事实，不重算）。engineReturn 缺省时为 running
//                   （当前视图语义：引擎尚在跑或终态未记录）。
//   engineOutcome ← engineReturn.engineOutcome（引擎终态结论，AX10 不可被后续事件覆盖——
//                   V12 人工接管后引擎结论仍是 stopped）；engineReturn 缺省时由事件流 fold
//                   派生（completed / awaiting-ruling / failed / stopped 推导规则见
//                   foldEngineOutcome——stream 是唯一权威时的降级路径）。
//   integrationOutcome ← 事件流集成事实派生（集成器写的 IntegrationGateChecked /
//                   IntegrationPrecheckFailed 是唯一在案集成事实）；rolled-back 事件流无专属
//                   事实（集成器 ref 移动失败回滚不写事件），从 engineReturn.integrationOutcome
//                   采纳——引擎层在案事实，流内无更晚集成成功时生效。
//   deliveryOutcome ← 主 agent 交付宣告（delivery 参数，resolved 系列）或缺省映射
//                   （引擎 completed → pending，否则 blocked——v2 引擎 finalize 同一映射）。
//                   resolved-by-main-agent 必须有流内人工接管事实（IntegrationGateChecked
//                   failure=false 且 actor=main-agent，集成器 manual 模式产物）背书，缺失即
//                   拒绝（人工接管结论不可凭空宣告——AX10 只能追加事件）。

import { fold } from "../kernel/state-fold.mjs";

// ---------------------------------------------------------------------------
// 词表（§3 终态第七段，逐值一致；测试断言词表与设计值逐一相等）
// ---------------------------------------------------------------------------

export const SCRIPT_STATUSES = Object.freeze(["running", "completed", "failed"]);

export const ENGINE_OUTCOMES = Object.freeze(["completed", "awaiting-ruling", "stopped", "failed"]);

export const INTEGRATION_OUTCOMES = Object.freeze([
  "not-required",
  "not-started",
  "verified-pending-integration",
  "integrated",
  "rolled-back",
  "failed",
]);

export const DELIVERY_OUTCOMES = Object.freeze(["pending", "resolved", "resolved-by-main-agent", "blocked"]);

/** v2 引擎 finalize 的缺省交付映射：引擎只产 pending/blocked（resolved 系列由主 agent 追加） */
export const ENGINE_DELIVERY_DEFAULTS = Object.freeze({ completed: "pending" });
export const ENGINE_DELIVERY_BLOCKED = "blocked";

/** 集成器 manual 模式的唯一合法 actor（integration/integrator.mjs MANUAL_ACTOR 同值；
 *  词表一致性由 tests 断言，本处重复登记是纯函数零依赖的代价） */
export const MANUAL_ACTOR = "main-agent";

// ---------------------------------------------------------------------------
// 事件流派生原语（纯函数）
// ---------------------------------------------------------------------------

/**
 * 义务终态派生（与 v2 引擎 derivedConclusion 同一规则；AX8/段七；D6 完成域 = verified/waived）：
 *   awaiting-ruling（fold 结论）> verified > waived（裁决 waived 且无有效 pass）> open；
 *   pending-integration 原样返回——非终态：证据绑定内容未落正式仓（沙箱变更集），
 *   折算进完成态会重建「工作区已修未提交」失败模式（D6 裁决口径）。
 */
export function derivedConclusion(st) {
  if (st === undefined || st === null) return "open";
  if (st.conclusion === "awaiting-ruling") return "awaiting-ruling";
  if (st.conclusion === "verified" || st.conclusion === "pending-integration") return st.conclusion;
  if (st.lastRuling?.direction === "waived") return "waived";
  return "open";
}

/** 事件流集成事实扫描：最后成功 / 最后失败（seq 时序，AX3 权威顺序） */
function scanIntegrationFacts(facts) {
  let lastSuccess = null;
  let lastFailure = null;
  for (const f of facts) {
    if (f.type === "IntegrationGateChecked") {
      if (f.failure === false) lastSuccess = f;
      else lastFailure = f;
    } else if (f.type === "IntegrationPrecheckFailed") {
      lastFailure = f;
    }
  }
  return { lastSuccess, lastFailure };
}

/**
 * integrationOutcome 事件流派生（优先级：成功在场且不晚于失败 → integrated；最新失败 →
 * failed；fold 有 pending-integration 地址 → verified-pending-integration；有带变更集证据 →
 * not-started；否则 not-required）。rolled-back 不在此派生（事件流无专属事实，见模块头注释）。
 */
export function deriveIntegrationOutcomeFromFacts({ facts, foldState }) {
  const { lastSuccess, lastFailure } = scanIntegrationFacts(facts);
  if (lastSuccess !== null && (lastFailure === null || lastSuccess.seq > lastFailure.seq)) return "integrated";
  if (lastFailure !== null) return "failed";
  const hasPendingIntegration = Object.values(foldState?.addresses ?? {}).some((s) => s.conclusion === "pending-integration");
  if (hasPendingIntegration) return "verified-pending-integration";
  if (facts.some((f) => f.type === "EvidenceRecorded" && typeof f.changesetId === "string")) return "not-started";
  return "not-required";
}

/**
 * engineOutcome 的 fold 降级派生（engineReturn 缺省时启用；v2 引擎 finalize 同一判定序）：
 *   全部义务完成态（verified/waived）→ completed；存在 awaiting → awaiting-ruling；
 *   最新集成事实为失败 → failed；其余（轮次耗尽语义，含 pending-integration——非终态，
 *   D6 完成域 = verified/waived，集成在场后才 verified）→ stopped。
 */
export function foldEngineOutcome({ facts, bindings = [], artifacts = {}, checkerRuns = [] }) {
  const state = fold({ bindings, facts, artifacts, checkerRuns });
  const conclusions = [...Object.values(state.addresses).map((s) => derivedConclusion(s))];
  if (conclusions.length > 0) {
    if (conclusions.every((c) => c === "verified" || c === "waived")) return "completed";
    if (conclusions.some((c) => c === "awaiting-ruling")) return "awaiting-ruling";
  }
  const { lastSuccess, lastFailure } = scanIntegrationFacts(facts);
  if (lastFailure !== null && (lastSuccess === null || lastFailure.seq > lastSuccess.seq)) return "failed";
  return "stopped";
}

// ---------------------------------------------------------------------------
// 四层结论派生主入口（纯函数；全部输入 = 事件流 + 引擎终态返回 + 交付宣告）
// ---------------------------------------------------------------------------

function outcomesError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertInVocabulary(value, vocabulary, name) {
  if (value !== undefined && !vocabulary.includes(value)) {
    throw outcomesError(
      "outcome-vocabulary-violation",
      `${name}「${JSON.stringify(value ?? null)}」不在词表（${vocabulary.join(" / ")}）。` +
        `权威源：reports/outcomes.mjs 词表常量（§3 终态第七段）。恢复动作：修正取值后重发。`,
    );
  }
}

/**
 * 四层结论派生。
 *   facts        状态仓事件流（必填；AX3 权威）
 *   bindings     义务绑定集（fold 输入；覆盖率与终态判定依据）
 *   artifacts    当前输入名 → 内容哈希表（fold 输入；证据有效性判定——AX4/D3）
 *   checkerRuns  checker 登记集（fold 输入；checker 版本存活判定）
 *   engineReturn v2 引擎终态返回值（scriptStatus / engineOutcome / integrationOutcome /
 *                deliveryOutcome 字段可选携带；词表校验后按分层权威源采纳）
 *   delivery     主 agent 交付宣告 { outcome: "resolved"|"resolved-by-main-agent", actor,
 *                changesetId?, commitRefs?, declaredAt?, note? }（resolved 系列唯一入口；
 *                校验规则见函数体内两处拒绝分支）
 * 返回 { scriptStatus, engineOutcome, integrationOutcome, deliveryOutcome, coverage, layers }。
 * layers = 逐层权威源与追溯事实（V8「四层结论报告可追溯」/ V12「人工 actor、变更集与提交
 * 引用可见」）；coverage = 绑定义务覆盖率（AX8 分母只含绑定义务）。
 */
export function deriveOutcomes({ facts, bindings = [], artifacts = {}, checkerRuns = [], engineReturn = null, delivery = null }) {
  if (!Array.isArray(facts)) {
    throw outcomesError("invalid-derive-input", "facts 必须是事件数组（AX3 权威事件流）。恢复动作：传 state-repo.readEvents 产物。");
  }
  const foldState = fold({ bindings, facts, artifacts, checkerRuns });

  // ── 第一层 scriptStatus：引擎脚本执行层（权威源 = engineReturn，不重算）──
  assertInVocabulary(engineReturn?.scriptStatus, SCRIPT_STATUSES, "scriptStatus");
  const scriptStatus = engineReturn?.scriptStatus ?? "running";

  // ── 第二层 engineOutcome：引擎终态结论（AX10：后续事件不覆盖引擎层已定型结论）──
  assertInVocabulary(engineReturn?.engineOutcome, ENGINE_OUTCOMES, "engineOutcome");
  const engineOutcome = engineReturn?.engineOutcome ?? foldEngineOutcome({ facts, bindings, artifacts, checkerRuns });

  // ── 第三层 integrationOutcome：事件流集成事实派生；rolled-back 采纳引擎层在案事实 ──
  assertInVocabulary(engineReturn?.integrationOutcome, INTEGRATION_OUTCOMES, "integrationOutcome");
  const fromStream = deriveIntegrationOutcomeFromFacts({ facts, foldState });
  let integrationOutcome = fromStream;
  if (fromStream !== "integrated" && fromStream !== "failed" && engineReturn?.integrationOutcome === "rolled-back") {
    integrationOutcome = "rolled-back";
  }

  // ── 交付宣告校验（resolved 系列唯一入口；拒绝分支 = 错误契约：事实 + 恢复动作）──
  let declaration = null;
  if (delivery !== null && delivery !== undefined) {
    if (delivery === null || typeof delivery !== "object" || Array.isArray(delivery)) {
      throw outcomesError("invalid-delivery-declaration", "delivery 交付宣告必须是对象。恢复动作：传 { outcome, actor } 形态。");
    }
    assertInVocabulary(delivery.outcome, DELIVERY_OUTCOMES, "deliveryOutcome");
    if (delivery.outcome !== "resolved" && delivery.outcome !== "resolved-by-main-agent") {
      throw outcomesError(
        "invalid-delivery-declaration",
        `交付宣告 outcome 只接受 resolved / resolved-by-main-agent（pending / blocked 是派生缺省值，不可宣告）。恢复动作：引擎 completed 后宣告 resolved，人工接管后宣告 resolved-by-main-agent。`,
      );
    }
    if (typeof delivery.actor !== "string" || delivery.actor.trim() === "") {
      throw outcomesError("invalid-delivery-declaration", "交付宣告必须携带 actor（AX10：人工动作可追溯）。恢复动作：补 actor 后重发。");
    }
    if (delivery.outcome === "resolved-by-main-agent") {
      // 人工接管结论必须有流内接管事实背书（集成器 manual 模式产物：IntegrationGateChecked
      // failure=false 且 actor=main-agent）——缺失即拒绝，防凭空宣告（AX10 只能追加事件）
      const takeoverFact = facts.find(
        (f) => f.type === "IntegrationGateChecked" && f.failure === false && f.actor === MANUAL_ACTOR,
      );
      if (!takeoverFact) {
        throw outcomesError(
          "delivery-takeover-fact-missing",
          `resolved-by-main-agent 宣告被拒绝：事件流无人工接管集成事实（IntegrationGateChecked failure=false 且 actor=${MANUAL_ACTOR}）。` +
            `权威源：状态仓事件流。恢复动作：先以 manual 模式经集成器记录人工集成（同一门径，AX7），再宣告交付。`,
        );
      }
    }
    if (delivery.outcome === "resolved" && engineOutcome !== "completed") {
      throw outcomesError(
        "delivery-resolved-requires-completed",
        `resolved 交付宣告被拒绝：引擎结论为 ${engineOutcome}（resolved 只对引擎已完成的包成立）。` +
          `恢复动作：人工接管场景改宣告 resolved-by-main-agent（先经集成器 manual 门径记录人工集成），或等引擎 completed 后再宣告。`,
      );
    }
    declaration = {
      outcome: delivery.outcome,
      actor: delivery.actor,
      changesetId: delivery.changesetId ?? null,
      commitRefs: delivery.commitRefs ?? [],
      declaredAt: delivery.declaredAt ?? null,
      note: delivery.note ?? null,
    };
  }

  // ── 第四层 deliveryOutcome：宣告在场用宣告，否则引擎缺省映射（completed → pending，否则 blocked）──
  const deliveryOutcome = declaration !== null ? declaration.outcome : engineOutcome === "completed" ? ENGINE_DELIVERY_DEFAULTS.completed : ENGINE_DELIVERY_BLOCKED;

  // ── 覆盖率（AX8：分母只含绑定义务；unbound 叙述不进。完成域 = verified/waived（D6），
  //    pending-integration 非终态单列 pendingIntegration 桶，不折算进 verified）──
  const coverage = { denominator: bindings.length, verified: 0, waived: 0, open: 0, awaitingRuling: 0, pendingIntegration: 0 };
  for (const b of bindings) {
    const st = foldState.addresses[`${b.bindingId}|${b.repoId}|${b.violationKind}`];
    const c = derivedConclusion(st);
    if (c === "verified") coverage.verified += 1;
    else if (c === "waived") coverage.waived += 1;
    else if (c === "awaiting-ruling") coverage.awaitingRuling += 1;
    else if (c === "pending-integration") coverage.pendingIntegration += 1;
    else coverage.open += 1;
  }

  // ── 逐层权威源与追溯（V8 / V12：报告可追溯、人工 actor 与变更集引用可见）──
  const manualGate = facts.find((f) => f.type === "IntegrationGateChecked" && f.failure === false && f.actor === MANUAL_ACTOR);
  const layers = {
    scriptStatus: { source: engineReturn ? "engine-return" : "default-running" },
    engineOutcome: { source: engineReturn ? "engine-return" : "event-stream-fold" },
    integrationOutcome: {
      source: fromStream !== "not-required" ? "event-stream" : (engineReturn?.integrationOutcome ? "engine-return-default" : "event-stream"),
      lastSuccessSeq: scanIntegrationFacts(facts).lastSuccess?.seq ?? null,
    },
    deliveryOutcome: { source: declaration !== null ? "main-agent-declaration" : "engine-default-mapping" },
    manualIntegration: manualGate
      ? { actor: manualGate.actor, seq: manualGate.seq, repoId: manualGate.repoId, summary: manualGate.summary, mode: "manual" }
      : null,
    deliveryDeclaration: declaration,
    archived: foldState.archived,
  };

  return { scriptStatus, engineOutcome, integrationOutcome, deliveryOutcome, coverage, layers };
}
