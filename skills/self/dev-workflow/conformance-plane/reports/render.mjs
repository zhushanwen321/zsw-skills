// render.mjs — 派生报告渲染：current / final / matrix / trajectory / ledger 五视图
// （sync-conformance-plane U5/M5，§3 终态第七段报告迁移层）
//
// 语义权威（设计 sync-conformance-plane §3 终态第七段 / AX3 / V10 / GA9）：
//   段七  v2 派生报告（current/final/matrix/trajectory/ledger）落盘根为 skill-data tech-design
//         段 `<name>/v2/` 子目录（与 cutover 标记 `<name>/cutover.json` 同段），不与旧 D5 final
//         （dev-flow 段 `<docName>.sync/final.json`）同址同名冲突。
//         寻址登记：skill-data-addressing.md §2「conformance-plane 段（M5 报告与切换）」；
//         本文件常量 REPORT_DIRNAME 即该登记行（路径单一来源约定见任务书验收条款 3）。
//   AX3   唯一权威是状态仓事件流与快照；报告是派生视图——每次渲染从 rebuild(stateRoot) 全量
//         重建，不在报告层维护任何可变状态（V10：报告文件全部删除后重渲染，逐字节等价）。
//   V10   报告与当前状态可完整重建；事件序列无空洞（fold 的 seq 连续性校验即权威探针——
//         rebuild 内部 fold 抛 fact-seq-gap 即报告不可重建，fail-fast 不静默）。
//
// 确定性纪律：五视图内容不含渲染时刻墙钟（generatedAt 一类字段）——同输入重渲染逐字节等价，
// V10「比对重建前后」才有可判定判据；时间溯源用事件流自身 ts（trajectory 视图携带）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rebuild } from "../kernel/state-repo.mjs";
import { deriveOutcomes, derivedConclusion } from "./outcomes.mjs";

/** 报告落盘根目录名：tech-design 段 <name>/v2/（寻址登记行见模块头注释；勿在此改名——
 *  改名须同步 skill-data-addressing.md §2 登记行与本常量注释指向） */
export const REPORT_DIRNAME = "v2";

/** 五视图文件名（V10 删除重建的对象全集；kind 与文件名一一对应） */
export const REPORT_VIEW_FILES = Object.freeze({
  current: "current.json",
  final: "final.json",
  matrix: "matrix.md",
  trajectory: "trajectory.md",
  ledger: "ledger.md",
});

/** 报告根：<designPkg>/v2/（designPkg = tech-design 段 <name>/ 目录绝对路径） */
export function reportRootFor(designPkg) {
  if (typeof designPkg !== "string" || designPkg.trim() === "") {
    const err = new Error("designPkg 缺失（tech-design 段 <name>/ 目录绝对路径）。恢复动作：传设计包目录后重发。");
    err.code = "invalid-design-pkg";
    throw err;
  }
  return join(designPkg, REPORT_DIRNAME);
}

// ---------------------------------------------------------------------------
// 视图构造（纯函数；输入 = rebuild 产物 + 派生结论）
// ---------------------------------------------------------------------------

/** 地址展示键（AX2 差距地址三元组） */
function addrKeyOf(address) {
  return `${address.bindingId}|${address.repoId}|${address.violationKind}`;
}

/** 地址级状态摘要（fold 地址状态 → 报告行；结论谓词 = outcomes.derivedConclusion 同一规则） */
function addressRows(foldState) {
  return Object.values(foldState.addresses).map((s) => ({
    address: s.address,
    key: s.key,
    conclusion: derivedConclusion(s),
    foldConclusion: s.conclusion,
    evidence: { status: s.evidence.status, reasons: s.evidence.reasons ?? [], evidenceSeq: s.evidence.evidenceSeq ?? null },
    lastCheckerFailure: s.lastCheckerFailure,
    lastRuling: s.lastRuling ?? null,
  }));
}

function buildCurrentView({ pkgName, stateRoot, derived, foldState, seq }) {
  return {
    kind: "current",
    package: pkgName,
    stateRoot,
    seq,
    archived: foldState.archived,
    outcomes: {
      scriptStatus: derived.scriptStatus,
      engineOutcome: derived.engineOutcome,
      integrationOutcome: derived.integrationOutcome,
      deliveryOutcome: derived.deliveryOutcome,
    },
    coverage: derived.coverage,
    addresses: addressRows(foldState),
    layers: derived.layers,
  };
}

function buildFinalView({ pkgName, stateRoot, derived, foldState, seq }) {
  // 终态视图 = 同一派生的终态形态（kind 区分消费语义；内容与 current 同源同权威——AX3 派生）
  return {
    kind: "final",
    package: pkgName,
    stateRoot,
    seq,
    archived: foldState.archived,
    outcomes: {
      scriptStatus: derived.scriptStatus,
      engineOutcome: derived.engineOutcome,
      integrationOutcome: derived.integrationOutcome,
      deliveryOutcome: derived.deliveryOutcome,
    },
    coverage: derived.coverage,
    delivery: derived.layers.deliveryDeclaration,
    manualIntegration: derived.layers.manualIntegration,
    addresses: addressRows(foldState),
  };
}

function buildMatrixView({ pkgName, derived, foldState }) {
  const rows = addressRows(foldState);
  const head = "| bindingId | repoId | violationKind | 结论 | 证据 | 失败在案 | 裁决 |";
  const sep = "|---|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const evidence = r.evidence.status === "valid" ? `valid(seq=${r.evidence.evidenceSeq})` : r.evidence.status;
    const failure = r.lastCheckerFailure ? `exit ${r.lastCheckerFailure.exitCode}` : "-";
    const ruling = r.lastRuling?.direction ?? "-";
    return `| ${r.address.bindingId} | ${r.address.repoId} | ${r.address.violationKind} | ${r.conclusion} | ${evidence} | ${failure} | ${ruling} |`;
  });
  const c = derived.coverage;
  return [
    `# 义务矩阵 — ${pkgName}`,
    "",
    `四层结论：scriptStatus=${derived.scriptStatus} / engineOutcome=${derived.engineOutcome} / integrationOutcome=${derived.integrationOutcome} / deliveryOutcome=${derived.deliveryOutcome}`,
    "",
    `覆盖率（AX8 分母只含绑定义务）：verified ${c.verified} / waived ${c.waived} / open ${c.open} / awaiting-ruling ${c.awaitingRuling}，分母 ${c.denominator}`,
    "",
    head,
    sep,
    ...body,
    "",
  ].join("\n");
}

function buildTrajectoryView({ pkgName, facts }) {
  const lines = [`# 轨迹 — ${pkgName}`, "", "| seq | ts | 事件 | actor | 摘要 |", "|---|---|---|---|---|"];
  for (const f of facts) {
    const target = f.address ? `${f.address.bindingId}|${f.address.repoId}|${f.address.violationKind}` : (f.repoId ?? f.backlogId ?? f.reason ?? "");
    const summary = f.summary ?? f.question ?? f.command ?? "";
    lines.push(`| ${f.seq} | ${f.ts} | ${f.type} | ${f.actor} | ${String(target + " " + summary).replace(/\|/g, "\\|").trim()} |`);
  }
  lines.push("", `事件总数 ${facts.length}（seq 连续性由 fold 在重建时强校验——空洞即拒绝渲染）`, "");
  return lines.join("\n");
}

function buildLedgerView({ pkgName, derived, foldState, stateRoot }) {
  const lines = [
    `# 地址清单 — ${pkgName}`,
    "",
    `权威源：${stateRoot}（事件流 + 快照；本视图为派生索引，删除后可由 rebuild 完整重建——AX3）`,
    "",
  ];
  const rows = addressRows(foldState);
  if (rows.length === 0) {
    lines.push("（无地址记录——事件流尚无任何地址事件）", "");
  }
  for (const r of rows) {
    lines.push(
      `## ${r.key}`,
      "",
      `- 结论：${r.conclusion}（fold：${r.foldConclusion}）`,
      `- 证据：${r.evidence.status}${r.evidence.evidenceSeq !== null ? `（seq=${r.evidence.evidenceSeq}）` : ""}${
        r.evidence.reasons.length > 0 ? `；失效原因：${r.evidence.reasons.map((x) => x.code).join("、")}` : ""
      }`,
      r.lastCheckerFailure ? `- checker 失败在案：seq=${r.lastCheckerFailure.seq}，exit=${r.lastCheckerFailure.exitCode}，恢复=${r.lastCheckerFailure.recovery}` : null,
      r.lastRuling ? `- 裁决：${r.lastRuling.direction ?? "在案未决"}${r.lastRuling.resolvedAt !== undefined ? `（seq=${r.lastRuling.resolvedAt}）` : ""}` : null,
      "",
    );
  }
  const c = derived.coverage;
  lines.push(
    "---",
    "",
    `汇总：verified ${c.verified} / waived ${c.waived} / open ${c.open} / awaiting-ruling ${c.awaitingRuling}（分母 ${c.denominator}）`,
    "",
  );
  return lines.filter((l) => l !== null).join("\n");
}

// ---------------------------------------------------------------------------
// 渲染入口（写盘；幂等——同输入逐字节等价，V10 重建等价性的实现载体）
// ---------------------------------------------------------------------------

/**
 * 渲染五视图并落盘 `<designPkg>/v2/`。
 *   designPkg    tech-design 段 <name>/ 目录（报告根 = <designPkg>/v2/，段七寻址）
 *   stateRoot    状态仓根（唯一权威；rebuild 从这里取事件流与快照）
 *   engineReturn v2 引擎终态返回值（可选；四层结论的引擎层权威源，见 outcomes.mjs）
 *   delivery     主 agent 交付宣告（可选；resolved 系列唯一入口，见 outcomes.mjs）
 *   bindings     覆盖率分母（缺省读快照 input.bindings——v2 引擎 initStateRepo 登记形态）
 * 返回 { root, files, outcomes, coverage }；write=false 只构建不落盘（渲染探针）。
 */
export function renderReports({ designPkg, stateRoot, engineReturn = null, delivery = null, bindings = null, write = true }) {
  if (typeof stateRoot !== "string" || stateRoot.trim() === "") {
    const err = new Error("stateRoot 缺失（状态仓根）。恢复动作：传 v2 引擎返回的 stateRoot 后重发。");
    err.code = "invalid-state-root";
    throw err;
  }
  // 全量重建（AX3）：事件流 + 快照静态输入 → fold。seq 空洞在此 fail-fast（V10 权威探针）
  const { input, facts, state } = rebuild(stateRoot);
  const derived = deriveOutcomes({
    facts,
    bindings: bindings ?? input.bindings ?? [],
    artifacts: input.artifacts ?? {},
    checkerRuns: input.checkerRuns ?? [],
    engineReturn,
    delivery,
  });
  const pkgName = String(designPkg ?? "").split("/").filter(Boolean).pop() ?? "design";
  const views = {
    current: buildCurrentView({ pkgName, stateRoot, derived, foldState: state, seq: state.seq }),
    final: buildFinalView({ pkgName, stateRoot, derived, foldState: state, seq: state.seq }),
    matrix: buildMatrixView({ pkgName, derived, foldState: state }),
    trajectory: buildTrajectoryView({ pkgName, facts }),
    ledger: buildLedgerView({ pkgName, derived, foldState: state, stateRoot }),
  };
  const root = reportRootFor(designPkg);
  const files = {};
  if (write) {
    mkdirSync(root, { recursive: true });
    for (const [kind, content] of Object.entries(views)) {
      const path = join(root, REPORT_VIEW_FILES[kind]);
      const text = kind === "current" || kind === "final" ? JSON.stringify(content, null, 2) + "\n" : content;
      writeFileSync(path, text);
      files[kind] = path;
    }
  }
  return { root, files, views, outcomes: derived, coverage: derived.coverage };
}

/**
 * 报告重建探针（V10 删除重建等价性的断言入口）：write=false 构建五视图内容并返回，
 * 调用方与落盘文件逐字节比对（索引可丢弃——报告层无任何不可重建的本地状态）。
 */
export function buildReportViews(options) {
  return renderReports({ ...options, write: false }).views;
}
