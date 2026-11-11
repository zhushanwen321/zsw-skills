// obligation-coverage.test.mjs — 固定义务覆盖率与 backlog 隔离（sync-conformance-plane U2/M2）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   G6 --backlog-excluded / RL6 / V6 / D6 / AX8：
//     1. 覆盖率分母 = 当前设计包版本中全部 conformance 绑定义务；无绑定叙述不进分母
//     2. backlog 观察增长不改变分母与覆盖率（未映射观察进 backlog，不阻塞当前完成判据）
//     3. BacklogAdopted 闭环：新绑定版本登记 → 事件引用 proposed 条目（bindingRef）→
//        观察转新地址初始证据（result=fail EvidenceRecorded，经 kernel 写状态仓）→
//        条目退出 active backlog；旧工作范围完成判据不变
//     4. backlog 状态机：proposed → adopted/rejected/superseded，表外转移 fail-fast
//
// 运行：node --test scripts/tests/obligation-coverage.test.mjs
//（守护命令形态 node scripts/tests/obligation-coverage.test.mjs --backlog-excluded 等价——
//  flag 为守护登记形态，文件恒跑全部用例）

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");

const facts = await import(join(CP, "kernel", "facts.mjs"));
const { fold, addressKey } = await import(join(CP, "kernel", "state-fold.mjs"));
const stateRepo = await import(join(CP, "kernel", "state-repo.mjs"));
const obligations = await import(join(CP, "extractors", "obligations.mjs"));
const backlog = await import(join(CP, "checkers", "backlog.mjs"));

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

/** 章节夹具：5 条目、2 条带绑定（分母 = 2）；义务表 = 提取器产物 */
function legalDocs() {
  return {
    "meta.json": {
      name: "fixture-design",
      designType: "evolution",
      typeRationale: "改动局部、无终态结构诉求——不需要终态视角",
      priority: "P2",
      riskScore: 3,
      riskRationale: "单模块内改动，风险低",
      reviewNav: [{ decisionId: "D1", anchor: "§3.3", level: "A", title: "决策一标题", criteria: "判据示意", impact: "影响示意" }],
      relatedDocs: [],
    },
    "s1-context.json": {
      background: "背景示意。",
      goals: [
        { id: "GL1", statement: "叙述性目标（无绑定，不进分母）" },
        {
          id: "GL2",
          statement: "义务甲",
          conformance: {
            bindingId: "GL2",
            repoId: "repo-main",
            targetSelector: "src/a.mjs",
            violationKind: "missing-implementation",
            checkerId: "symbol-scan",
            severity: "must-fix",
            evidenceInputs: ["src/a.mjs"],
          },
        },
      ],
      outOfScope: "范围外示意",
    },
    "s2-status.json": {
      currentBehaviour: "现状行为示意。",
      flowDiagram: "主流程 → 环节示意",
      problems: [
        {
          id: "PR1",
          stage: "主流程 → 环节示意",
          symptom: "现象示意",
          rootCause: "根因示意",
          conformance: {
            bindingId: "PR1",
            repoId: "repo-main",
            targetSelector: "src/b.mjs",
            violationKind: "overimplementation",
            checkerId: "symbol-scan",
            severity: "suggestion",
            evidenceInputs: ["src/b.mjs"],
          },
        },
      ],
      assumptions: [{ id: "AS1", statement: "前提示意", status: "pending", evidence: "", impactIfFalse: "影响示意" }],
      artifactTables: { stateCopies: [], signalImplications: [], repairHistory: [], upstreamDeps: [] },
    },
    "s3-solution.json": {
      options: [
        { id: "OPT1", name: "方案一", longTerm: "长期评估示意", shortTerm: "短期成本示意", risk: "风险示意", recommended: true, costNote: "成本示意" },
        { id: "OPT2", name: "方案二", longTerm: "长期评估示意", shortTerm: "短期成本示意", risk: "风险示意", recommended: false, costNote: "成本示意" },
      ],
      decisions: [
        {
          id: "D1",
          title: "决策一标题",
          stage: "主流程 → 环节示意",
          level: "A",
          choice: "采用方案示意。",
          rejected: "不采用其余方案的理由示意。",
          evidence: "证据示意（已核实）",
          gapRefs: [],
          unitRefs: ["U1"],
          axiomRefs: [],
          impact: { architecture: "", function: "", complexity: "", performance: "", resource: "", redline: "" },
        },
      ],
    },
    "s4-accept.json": {
      scenarios: [{ id: "V1", scene: "场景示意", steps: "步骤示意", criteria: "标准示意", goalRefs: ["GL1"] }],
      assertionRedlights: [],
      e2eImpact: { items: [], noneReason: "无受影响项依据示意" },
    },
    "s5-breakdown.json": {
      units: [{ id: "U1", title: "单元示意", justification: "拆分理由示意", files: ["src/example.py"], checkpoints: ["待验证点示意"] }],
      fileMap: "文件改动地图示意。",
    },
  };
}

/** 状态仓静态输入（绑定集 = 义务表身份四元组；checkerRuns 登记 symbol-scan） */
function repoInput(table) {
  return {
    archived: false,
    bindings: table.obligations.map((o) => ({ ...o.binding })),
    repos: [{ repoId: "repo-main" }],
    checkerRuns: [
      { checkerId: "symbol-scan", checkerVersion: "1.0.0" },
      { checkerId: "semantic-review", checkerVersion: "0.3.0" },
    ],
    changesets: [],
    artifacts: { "src/a.mjs": H1, "src/b.mjs": H2 },
  };
}

/**
 * 覆盖率（对账判据）：分母 = 绑定义务集；分子只计终态结论（verified/waived——停止判据词表）；
 * pending-integration 不是完成态（变更集就绪但集成未发生），单列计数不进分子。
 * 完备性口径：satisfied + pendingIntegration + open = 分母（每义务地址恰一结论桶）。
 */
function coverage(state, table) {
  const denominator = table.obligations.length;
  const keys = new Set(table.obligations.map((o) => state.keys[facts.canonicalJson(o.address)]).filter(Boolean));
  const conclusions = [...keys].map((k) => state.addresses[k]?.conclusion ?? "open");
  const satisfied = conclusions.filter((c) => c === "verified" || c === "waived").length;
  const pendingIntegration = conclusions.filter((c) => c === "pending-integration").length;
  const open = conclusions.filter((c) => c === "open").length;
  return { denominator, satisfied, pendingIntegration, open, ratio: denominator === 0 ? null : satisfied / denominator };
}

// ---------------------------------------------------------------------------
// 1. 分母 = 绑定义务集；无绑定叙述不进分母（AX8）
// ---------------------------------------------------------------------------

test("覆盖率分母 = 绑定义务集：9 条目 2 绑定 → 分母 2，未绑定叙述只列清单（G6）", () => {
  const table = obligations.extractObligations(legalDocs());
  assert.equal(table.stats.totalEntries, 9);
  assert.equal(table.stats.boundEntries, 2);
  assert.equal(table.stats.unboundEntries, 7);
  assert.equal(table.stats.machineCheckableRatio, 2 / 9);
  const input = repoInput(table);
  const state = fold({ ...input, facts: [] });
  const cov = coverage(state, table);
  assert.equal(cov.denominator, 2, "分母只含绑定义务（未绑定 GL1/AS1/D1/OPT*/V1/U1 不进分母）");
  assert.equal(cov.satisfied, 0);
});

test("coverage 口径对齐停止判据词表：waived 计分子、pending-integration 单列不进分子、三桶合计 = 分母（bl-2）", () => {
  const mkFact = (type, seq, payload) => ({ type, seq, ts: "2026-11-11T00:00:00.000Z", actor: "engine", ...payload });
  const addrV = { bindingId: "GL2", repoId: "repo-main", violationKind: "missing-implementation" };
  const addrW = { bindingId: "PR1", repoId: "repo-main", violationKind: "overimplementation" };
  const addrP = { bindingId: "PX", repoId: "repo-main", violationKind: "missing-implementation" };
  const bindings = [
    { ...addrV, bindingVersion: 1 },
    { ...addrW, bindingVersion: 1 },
    { ...addrP, bindingVersion: 1 },
  ];
  const input = {
    archived: false,
    bindings,
    repos: [{ repoId: "repo-main" }],
    checkerRuns: [{ checkerId: "symbol-scan", checkerVersion: "1.0.0" }],
    changesets: [{ changesetId: "cs-new" }],
    artifacts: { "src/a.mjs": H1, "src/b.mjs": H2 },
  };
  const factsList = [
    // GL2：有效 pass 证据（无变更集引用）→ verified（终态，计分子）
    mkFact("EvidenceRecorded", 1, {
      address: addrV,
      obligationHash: facts.obligationSummaryHash(bindings[0]),
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      bindingVersion: 1,
      inputs: [{ name: "src/a.mjs", hash: H1 }],
      result: "pass",
    }),
    // PR1：waived 裁决 → waived（终态，计分子）
    mkFact("RulingRequested", 2, { address: addrW, question: "是否豁免？" }),
    mkFact("RulingRecorded", 3, { address: addrW, direction: "waived", respondsTo: 2 }),
    // PX：变更集就绪待集成（无集成审计事实）→ pending-integration（非完成态，不进分子）
    mkFact("EvidenceRecorded", 4, {
      address: addrP,
      obligationHash: facts.obligationSummaryHash(bindings[2]),
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      bindingVersion: 1,
      inputs: [{ name: "src/a.mjs", hash: H1 }],
      result: "pass",
      changesetId: "cs-new",
    }),
  ];
  const state = fold({ ...input, facts: factsList });
  const table = { obligations: [addrV, addrW, addrP].map((address) => ({ address })) };
  const cov = coverage(state, table);
  assert.equal(cov.denominator, 3);
  assert.equal(cov.satisfied, 2, "分子只计终态：verified 1 + waived 1");
  assert.equal(cov.pendingIntegration, 1, "pending-integration 单列计数，不进分子（停止判据不含它）");
  assert.equal(cov.open, 0);
  assert.equal(cov.ratio, 2 / 3, "覆盖率 = 终态数 / 分母（pending-integration 不折算为完成）");
  assert.equal(
    cov.satisfied + cov.pendingIntegration + cov.open,
    cov.denominator,
    "完备性口径：verified + waived + pending-integration + open = 分母（每义务地址恰一结论桶）",
  );
});

// ---------------------------------------------------------------------------
// 2. backlog 增长不改变分母与覆盖率（G6 / RL6 / V6 前半）
// ---------------------------------------------------------------------------

test("backlog 观察增长：分母、义务表版本与覆盖率都不变（未映射观察不阻塞当前完成判据）", async () => {
  const table = obligations.extractObligations(legalDocs());
  const q = backlog.createBacklog();
  backlog.proposeObservation(q, { observation: "编号清理缺自动化扫描，映射不到任何绑定义务" });
  backlog.proposeObservation(q, { observation: "serve→client 波及建议（范围外历史卫生）" });
  assert.equal(q.active().length, 2);
  // 分母与表版本不因 backlog 增长变化：义务表只由章节 JSON 绑定派生
  const tableAgain = obligations.extractObligations(legalDocs());
  assert.equal(table.tableVersion, tableAgain.tableVersion, "义务表版本与 backlog 无关");
  const input = repoInput(table);
  const state = fold({ ...input, facts: [] });
  const cov = coverage(state, table);
  assert.equal(cov.denominator, 2, "backlog 条目不进分母");
  assert.equal(cov.ratio, 0);
  // 状态仓视角：proposed 观察未产生任何事件，事件流与 fold 状态不含 backlog 地址
  const root = mkdtempSync(join(tmpdir(), "conf-coverage-"));
  try {
    stateRepo.initStateRepo(root, input);
    const before = stateRepo.rebuild(root);
    assert.equal(before.facts.length, 0, "proposed 观察不产生事件");
    const r = await stateRepo.appendCommands(root, [
      {
        type: "RecordEvidence",
        actor: "symbol-scan",
        payload: {
          address: table.obligations[0].address,
          obligationHash: table.obligations[0].summaryHash,
          checkerId: "symbol-scan",
          checkerVersion: "1.0.0",
          bindingVersion: 1,
          inputs: [{ name: "src/a.mjs", hash: H1 }],
          result: "pass",
        },
      },
    ]);
    const after = stateRepo.rebuild(root);
    const covAfter = coverage(after.state, table);
    assert.equal(covAfter.denominator, 2, "义务通过后分母仍为 2");
    assert.equal(covAfter.satisfied, 1);
    assert.equal(covAfter.ratio, 0.5, "覆盖率 = 1/2（backlog 2 条观察不影响）");
    assert.equal(r.appended, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. BacklogAdopted 闭环：新地址初始证据 + 退出 active backlog + 旧判据不变（V6 后半）
// ---------------------------------------------------------------------------

test("BacklogAdopted：proposed 条目采纳 → 新绑定登记 + 观察转新地址初始证据（经 kernel 写状态仓）+ 旧分母不变", async () => {
  const table = obligations.extractObligations(legalDocs());
  const input = repoInput(table);
  const root = mkdtempSync(join(tmpdir(), "conf-coverage-adopt-"));
  try {
    stateRepo.initStateRepo(root, input);
    const q = backlog.createBacklog();
    const entry = backlog.proposeObservation(q, { observation: "replay 入口缺 data_as_of 透传（未映射生产逻辑缺口）" });
    const newBinding = {
      bindingId: "GL2-data-as-of",
      repoId: "repo-main",
      violationKind: "missing-implementation",
      bindingVersion: 1,
    };
    const result = await backlog.adoptEntry(root, q, {
      backlogId: entry.backlogId,
      newBinding,
      checkerId: "semantic-review",
      checkerVersion: "0.3.0",
      inputs: [{ name: "src/a.mjs", hash: H1 }],
      actor: "main-agent",
    });
    // ① 事件流：BacklogAdopted（backlogId + bindingRef 含 bindingVersion）+ EvidenceRecorded（fail）
    const { facts: allFacts, state } = stateRepo.rebuild(root);
    const adopted = allFacts.find((f) => f.type === "BacklogAdopted");
    assert.ok(adopted, "事件流含 BacklogAdopted");
    assert.equal(adopted.backlogId, entry.backlogId, "事件引用 proposed 条目 id");
    assert.deepEqual(adopted.newBinding, newBinding);
    const evidence = allFacts.find((f) => f.type === "EvidenceRecorded" && f.address.bindingId === newBinding.bindingId);
    assert.ok(evidence, "观察转新地址初始证据事件");
    assert.equal(evidence.result, "fail", "初始证据 = 违例成立的 fail 证据");
    assert.equal(evidence.obligationHash, facts.obligationSummaryHash(newBinding));
    // ② fold：新地址在案、保持 open（fail 证据不伪造 verified）
    const newKey = state.keys[facts.canonicalJson(facts.deriveAddress(newBinding))];
    assert.ok(newKey && state.addresses[newKey], "新地址进入 fold 状态");
    assert.equal(state.addresses[newKey].conclusion, "open");
    // ③ 快照 input.bindings 已登记新绑定（fold 的 BacklogAdopted 绑定集要求）
    const snap = stateRepo.readSnapshot(root);
    assert.ok(snap.input.bindings.some((b) => b.bindingId === newBinding.bindingId), "新绑定登记进绑定集");
    // ④ 内存队列：条目退出 active backlog
    assert.equal(q.active().length, 0, "adopted 条目退出 active backlog");
    assert.equal(q.get(entry.backlogId).status, "adopted");
    // ⑤ 旧工作范围完成判据不变：旧义务表分母与已通过义务的结论不受采纳影响
    const oldTable = obligations.extractObligations(legalDocs());
    const cov = coverage(state, oldTable);
    assert.equal(cov.denominator, 2, "旧范围分母 = 2（新绑定不在旧义务表分母内）");
    assert.equal(cov.satisfied, 0, "旧范围未通过数不变（新地址证据不算旧范围分子）");
    // ⑥ 采纳产物返回初始证据事实
    assert.equal(result.evidence.type, "EvidenceRecorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adoptEntry 幂等登记：同绑定重复采纳同一新绑定不报错，内容漂移拒绝（binding-conflict）", async () => {
  const table = obligations.extractObligations(legalDocs());
  const input = repoInput(table);
  const root = mkdtempSync(join(tmpdir(), "conf-coverage-idem-"));
  try {
    stateRepo.initStateRepo(root, input);
    const newBinding = { bindingId: "PR1-extra", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 };
    // 直接向快照登记同一绑定（模拟第二次采纳前绑定已在集内的形态）
    await stateRepo.withLock(root, async () => {
      const snap = stateRepo.readSnapshot(root);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(root, "snapshot.json"),
        JSON.stringify({ ...snap, input: { ...snap.input, bindings: [...snap.input.bindings, { ...newBinding }] } }, null, 2),
      );
    });
    // 同内容幂等（事件照常追加）；不同内容拒绝
    const q1 = backlog.createBacklog();
    const e1 = backlog.proposeObservation(q1, { observation: "观察 A" });
    const ok = await backlog.adoptEntry(root, q1, {
      backlogId: e1.backlogId,
      newBinding: { ...newBinding },
      checkerId: "semantic-review",
      checkerVersion: "0.3.0",
      inputs: [{ name: "src/a.mjs", hash: H1 }],
      actor: "main-agent",
    });
    assert.equal(ok.appended, 2);
    const q2 = backlog.createBacklog();
    const e2 = backlog.proposeObservation(q2, { observation: "观察 B" });
    await assert.rejects(
      () =>
        backlog.adoptEntry(root, q2, {
          backlogId: e2.backlogId,
          newBinding: { ...newBinding, bindingVersion: 2 },
          checkerId: "semantic-review",
          checkerVersion: "0.3.0",
          inputs: [{ name: "src/a.mjs", hash: H1 }],
          actor: "main-agent",
        }),
      (e) => e.code === "binding-conflict",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. backlog 状态机：表外转移 fail-fast（D6 triage）
// ---------------------------------------------------------------------------

test("backlog 状态机：proposed → rejected/superseded 可判定；终态再转移 / 采纳缺件 fail-fast", async () => {
  const q = backlog.createBacklog();
  const a = backlog.proposeObservation(q, { observation: "观察甲", backlogId: "bl-a" });
  const b = backlog.proposeObservation(q, { observation: "观察乙", backlogId: "bl-b" });
  const c = backlog.proposeObservation(q, { observation: "观察丙", backlogId: "bl-c" });
  // 确定性派生 id：不传 backlogId 时同观察同 id
  const d1 = backlog.proposeObservation(backlog.createBacklog(), { observation: "观察甲" });
  assert.match(d1.backlogId, /^bl-[0-9a-f]{12}$/);
  // rejected / superseded
  backlog.triageEntry(q, { backlogId: "bl-b", decision: "rejected", reason: "范围外历史卫生，不立项" });
  backlog.triageEntry(q, { backlogId: "bl-c", decision: "superseded", supersededBy: "bl-a" });
  assert.deepEqual(q.active().map((e) => e.backlogId), ["bl-a"], "只有 proposed 在 active");
  assert.throws(() => backlog.triageEntry(q, { backlogId: "bl-b", decision: "adopted" }), (e) => e.code === "backlog-transition-illegal", "终态再转移拒绝");
  assert.throws(() => backlog.triageEntry(q, { backlogId: "bl-a", decision: "rejected" }), (e) => e.code === "invalid-backlog-triage", "rejected 缺理由拒绝");
  assert.throws(() => backlog.triageEntry(q, { backlogId: "bl-a", decision: "superseded" }), (e) => e.code === "invalid-backlog-triage", "superseded 缺替代条目拒绝");
  assert.throws(() => backlog.triageEntry(q, { backlogId: "ghost", decision: "rejected", reason: "x" }), (e) => e.code === "backlog-entry-missing");
  assert.throws(() => backlog.triageEntry(q, { backlogId: "bl-a", decision: "maybe" }), (e) => e.code === "invalid-backlog-decision", "决定词表外拒绝");
  // 采纳缺件：adoptionCommands 命令未过 kernel schema（bindingRef 缺 bindingVersion）fail-fast
  assert.throws(
    () =>
      backlog.adoptionCommands({
        backlogId: a.backlogId,
        newBinding: { bindingId: "X", repoId: "repo-main", violationKind: "missing-implementation" },
        checkerId: "semantic-review",
        checkerVersion: "0.3.0",
        inputs: [{ name: "src/a.mjs", hash: H1 }],
        actor: "main-agent",
      }),
    (e) => e.code === "invalid-adoption-command",
    "bindingRef 缺 bindingVersion 的采纳命令在写盘前被拒",
  );
});
