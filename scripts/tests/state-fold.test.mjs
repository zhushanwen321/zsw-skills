// state-fold.test.mjs — 领域核与确定性 fold 单元测试（sync-conformance-plane U1/M1）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   1. 事件词表与 facts.mjs schema 逐名一致：设计具名 7 事件
//      （RulingRequested/RulingRecorded/BacklogAdopted/CheckerFailed/IntegrationGateChecked/
//       IntegrationPrecheckFailed/Unarchived）+ 领域核登记的 EvidenceRecorded（AX4 证据落流载体）
//      逐一可用合法样本过 validateFact、缺必填字段样本被拒（U1 检查点「逐名一致，防词表分裂」）
//   2. 重放稳定（G2 --replay-equivalence / RL2）：同事件序 → 同状态，两次 fold 逐字节相等；
//      快照 input + 增量 fold 必须等价全量 fold
//   3. 状态谓词派生不存储（AX5 / D3）：awaiting-ruling / verified / pending-integration /
//      archived 全部由 fold 派生——事实对象与快照 input 中不存在谓词字段；
//      CheckerFailed 不伪造 verified、义务保持 open 且失败四要素可查
//   4. 事件量红灯阈值常量（D2）：50 MB / 10 万条为可判定探针
//
// 运行：node --test scripts/tests/state-fold.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane", "kernel");

const facts = await import(join(CP, "facts.mjs"));
const { fold, findOrphanEvidence, CONCLUSIONS } = await import(join(CP, "state-fold.mjs"));

/** 设计具名词表（权威源：sync-conformance-plane rendered §3 终态段四/五/六/七 + M5 复活通道） */
const DESIGN_NAMED_EVENTS = [
  "RulingRequested",
  "RulingRecorded",
  "BacklogAdopted",
  "CheckerFailed",
  "IntegrationGateChecked",
  "IntegrationPrecheckFailed",
  "Unarchived",
];

const ADDR_DOC = { bindingId: "GL1", repoId: "repo-a", violationKind: "documentation-mismatch" };
const ADDR_IMPL = { bindingId: "V12", repoId: "repo-a", violationKind: "missing-implementation" };

function baseInput() {
  return {
    archived: false,
    bindings: [
      { bindingId: "GL1", repoId: "repo-a", violationKind: "documentation-mismatch", bindingVersion: 1 },
      { bindingId: "V12", repoId: "repo-a", violationKind: "missing-implementation", bindingVersion: 2 },
    ],
    repos: [{ repoId: "repo-a" }],
    checkerRuns: [
      { checkerId: "symbol-scan", checkerVersion: "1.0.0" },
      { checkerId: "semantic-review", checkerVersion: "0.3.0" },
    ],
    changesets: [{ changesetId: "cs-1" }],
    artifacts: { "repo-a/docs/design.md": "a".repeat(64), "repo-a/src/main.js": "b".repeat(64) },
  };
}

/** 构造带合法 seq/ts/actor 的事实 */
function fact(type, seq, payload, actor = "engine") {
  return { type, seq, ts: "2026-11-10T10:00:00.000Z", actor, ...payload };
}

// ---------------------------------------------------------------------------
// 1. 事件词表与 schema 逐名一致
// ---------------------------------------------------------------------------

test("词表包含设计具名 7 事件与领域核登记的 EvidenceRecorded，且无未知成员", () => {
  for (const name of DESIGN_NAMED_EVENTS) {
    assert.ok(facts.EVENT_TYPES.includes(name), `设计具名事件 ${name} 必须登记于 EVENT_TYPES`);
  }
  assert.ok(facts.EVENT_TYPES.includes("EvidenceRecorded"), "AX4 证据落流载体 EvidenceRecorded 必须登记");
  assert.equal(
    facts.EVENT_TYPES.length,
    new Set(facts.EVENT_TYPES).size,
    "EVENT_TYPES 不得有重复成员（词表分裂即重复登记的红灯）",
  );
  assert.deepEqual(
    facts.EVENT_TYPES.filter((t) => DESIGN_NAMED_EVENTS.includes(t)),
    DESIGN_NAMED_EVENTS,
    "具名 7 事件的词表内次序无关，但成员集必须恰等",
  );
});

test("每个词表事件都有 payload schema 且合法样本逐一通过 validateFact", () => {
  assert.deepEqual(
    [...Object.keys(facts.EVENT_PAYLOAD_SCHEMAS)].sort(),
    [...facts.EVENT_TYPES].sort(),
    "EVENT_PAYLOAD_SCHEMAS 键集必须与 EVENT_TYPES 完全一致（逐名一致的 schema 形态）",
  );
  const samples = {
    RulingRequested: { address: ADDR_DOC, question: "该差距修复方向是代码侧还是文档侧？" },
    RulingRecorded: { address: ADDR_DOC, direction: "doc-right", respondsTo: 1 },
    BacklogAdopted: {
      backlogId: "BL-1",
      newBinding: { bindingId: "GL1.r2", repoId: "repo-a", violationKind: "documentation-mismatch", bindingVersion: 1 },
    },
    CheckerFailed: {
      address: ADDR_IMPL,
      command: "node check.js",
      exitCode: 20,
      summary: "semantic checker 连续两次输出非法 JSON",
      recovery: "修复 checker 后重跑；义务保持 open",
    },
    IntegrationGateChecked: {
      repoId: "repo-a",
      command: "git -C repo-a pre-commit",
      exitCode: 0,
      summary: "两阶段提交 ref 移动不隐式触发挂钩，预检已执行同一挂钩",
      recovery: "非失败记录，无需恢复",
      failure: false,
    },
    IntegrationPrecheckFailed: {
      repoId: "repo-a",
      command: "git apply --check",
      exitCode: 1,
      summary: "补丁与目标树冲突",
      recovery: "重新生成变更集后再次集成",
    },
    Unarchived: { reason: "同包重开对账范围，v2 复活通道解档" },
    EvidenceRecorded: {
      address: ADDR_IMPL,
      obligationHash: "c".repeat(64),
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      bindingVersion: 2,
      inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
      result: "pass",
    },
  };
  assert.deepEqual(
    Object.keys(samples).sort(),
    [...facts.EVENT_TYPES].sort(),
    "样本表必须覆盖全部词表事件（新增事件名未配样本 = 词表与 schema 不一致）",
  );
  let seq = 1;
  for (const type of facts.EVENT_TYPES) {
    const ok = facts.validateFact(fact(type, seq++, samples[type]));
    assert.ok(ok.ok, `${type} 合法样本应通过校验：${JSON.stringify(ok.errors)}`);
  }
});

test("缺必填字段 / 词表外 type / 非法地址形态逐一被 validateFact 拒绝", () => {
  const bad = [
    fact("RulingRequested", 1, { address: ADDR_DOC }), // 缺 question
    fact("RulingRequested", 2, { question: "缺地址" }),
    fact("NoSuchEvent", 3, {}), // 词表外
    fact("CheckerFailed", 4, { address: ADDR_IMPL, command: "c", exitCode: 20, summary: "缺恢复动作" }),
    fact("RulingRecorded", 5, { address: ADDR_DOC, direction: "随便写", respondsTo: 1 }), // direction 词表外
    fact("EvidenceRecorded", 6, {
      address: { bindingId: "GL1", repoId: "repo-a", violationKind: "词表外语义" },
      obligationHash: "c".repeat(64),
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      bindingVersion: 1,
      inputs: [{ name: "x", hash: "b".repeat(64) }],
      result: "pass",
    }), // violationKind 词表外
    fact("EvidenceRecorded", 7, {
      address: ADDR_IMPL,
      obligationHash: "短哈希",
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      bindingVersion: 2,
      inputs: [{ name: "x", hash: "b".repeat(64) }],
      result: "pass",
    }), // 哈希形态非法
  ];
  for (const f of bad) {
    const ok = facts.validateFact(f);
    assert.ok(!ok.ok, `非法事实应被拒绝：${JSON.stringify(f)}`);
  }
});

test("命令词表与事件词表一一对应，commandToFact 产出可过 validateFact 的事实", () => {
  assert.equal(facts.COMMAND_TYPES.length, facts.EVENT_TYPES.length, "命令与事件一一对应");
  assert.deepEqual(
    facts.COMMAND_TYPES.map((c) => facts.COMMAND_TO_EVENT[c]).sort(),
    [...facts.EVENT_TYPES].sort(),
    "COMMAND_TO_EVENT 必须覆盖全部事件名且无多余映射",
  );
  const cmd = { type: "RequestRuling", actor: "main-agent", payload: { address: ADDR_DOC, question: "方向？" } };
  const check = facts.validateCommand(cmd);
  assert.ok(check.ok, `合法命令应通过校验：${JSON.stringify(check.errors)}`);
  const f = facts.commandToFact(cmd, { seq: 1, ts: "2026-11-10T10:00:00.000Z" });
  assert.equal(f.type, "RulingRequested");
  assert.ok(facts.validateFact(f).ok, "commandToFact 产出必须过 validateFact");
  const badCheck = facts.validateCommand({ type: "NoSuchCommand", actor: "x", payload: {} });
  assert.ok(!badCheck.ok, "词表外命令必须被拒");
});

// ---------------------------------------------------------------------------
// 2. 重放稳定与快照等价（G2 / RL2）
// ---------------------------------------------------------------------------

function sampleFacts() {
  return [
    fact("EvidenceRecorded", 1, {
      address: ADDR_IMPL,
      obligationHash: "c".repeat(64),
      checkerId: "symbol-scan",
      checkerVersion: "1.0.0",
      bindingVersion: 2,
      inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
      result: "pass",
    }),
    fact("RulingRequested", 2, { address: ADDR_DOC, question: "方向争议" }),
    fact("RulingRecorded", 3, { address: ADDR_DOC, direction: "doc-right", respondsTo: 2 }),
  ];
}

test("重放稳定：同事件序两次 fold 状态逐字节相等（含结论轨迹）", () => {
  const input = baseInput();
  const factsList = sampleFacts();
  const s1 = fold({ ...input, facts: factsList });
  const s2 = fold({ ...input, facts: [...factsList] });
  assert.equal(JSON.stringify(s1), JSON.stringify(s2), "同序事件两次 fold 必须逐字节相等");
  // 乱序事件不是合法事件流：权威只接受 seq 连续序列（同序重放是唯一合法重放）
  assert.throws(
    () => fold({ ...input, facts: [factsList[1], factsList[0], factsList[2]] }),
    /seq/,
    "乱序事件必须被 seq 连续性校验拒绝（不存在乱序等价问题）",
  );
});

test("快照 + 增量 fold 必须等价全量 fold（RL2）", () => {
  const input = baseInput();
  const factsList = sampleFacts();
  const full = fold({ ...input, facts: factsList });
  // 模拟续跑：快照保存已 fold 到 seq=2 的状态，增量只 fold seq=3 的事件（respondsTo 依赖快照先验）
  const snapshotState = fold({ ...input, facts: factsList.slice(0, 2) });
  const incremental = fold({ ...input, facts: factsList.slice(2), initialState: snapshotState });
  assert.equal(JSON.stringify(incremental), JSON.stringify(full), "快照+增量产物必须与全量 fold 逐字节等价");
  assert.equal(incremental.seq, full.seq);
});

test("快照 + 增量等价跨集成审计事件：集成审计在场后新 pass 证据不得重回 pending-integration（RL2 回归）", () => {
  const input = baseInput();
  const ev = (seq) => fact("EvidenceRecorded", seq, {
    address: ADDR_IMPL,
    obligationHash: facts.obligationSummaryHash(input.bindings[1]),
    checkerId: "symbol-scan",
    checkerVersion: "1.0.0",
    bindingVersion: 2,
    inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
    result: "pass",
    changesetId: "cs-1",
  });
  const gate = (seq) => fact("IntegrationGateChecked", seq, {
    repoId: "repo-a",
    command: "git apply --check",
    exitCode: 0,
    summary: "预检通过",
    recovery: "非失败记录，无需恢复",
    failure: false,
  });
  const factsList = [ev(1), gate(2), ev(3)];
  const full = fold({ ...input, facts: factsList });
  // 快照切在集成审计之后、新 pass 证据之前——集成审计在场标记必须随快照携带
  const snapshotState = fold({ ...input, facts: factsList.slice(0, 2) });
  const incremental = fold({ ...input, facts: factsList.slice(2), initialState: snapshotState });
  assert.equal(
    JSON.stringify(incremental),
    JSON.stringify(full),
    "集成审计事件跨快照续 fold 必须与全量 fold 逐字节等价（integrationSeen 随快照携带）",
  );
  const impl = full.addresses[full.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(impl.conclusion, "verified", "集成审计在场后新 pass 证据的终态是 verified（V12 分层）");
  assert.equal(impl.pendingIntegration, false);
});

test("repo 级集成审计聚合：审计先于地址首现 → pass 证据仍 verified（结论与入场顺序无关，bl-7）", () => {
  const input = baseInput();
  const ev = (seq) => fact("EvidenceRecorded", seq, {
    address: ADDR_IMPL,
    obligationHash: facts.obligationSummaryHash(input.bindings[1]),
    checkerId: "symbol-scan",
    checkerVersion: "1.0.0",
    bindingVersion: 2,
    inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
    result: "pass",
    changesetId: "cs-1",
  });
  const gateOk = (seq) => fact("IntegrationGateChecked", seq, {
    repoId: "repo-a",
    command: "git apply --check",
    exitCode: 0,
    summary: "预检通过",
    recovery: "非失败记录，无需恢复",
    failure: false,
  });
  // 审计 seq=1 在前、地址首现（pass 证据）seq=2 在后：修复前该形态错误返回 pending-integration
  const auditFirst = fold({ ...input, facts: [gateOk(1), ev(2)] });
  const implA = auditFirst.addresses[auditFirst.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(implA.conclusion, "verified", "集成审计 seq 在前、地址 pass 证据在后 → verified（repo 级聚合不丢先至事件）");
  assert.equal(implA.integrationSeen, true, "首现前的集成成功审计必须进地址聚合标记");
  assert.equal(implA.pendingIntegration, false);
  // 与反序（地址先入场）等价：两序结论一致
  const auditLast = fold({ ...input, facts: [ev(1), gateOk(2)] });
  const implB = auditLast.addresses[auditLast.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(implB.conclusion, "verified", "地址先入场、审计后入场 → 同判 verified");
  assert.equal(JSON.stringify(implA.conclusion) + JSON.stringify(implA.pendingIntegration), JSON.stringify(implB.conclusion) + JSON.stringify(implB.pendingIntegration), "两种入场顺序结论等价");
  // 挂钩拒绝形态（failure=true）先于首现：blocked 在场，pending-integration 同样退场
  const gateFail = (seq) => fact("IntegrationGateChecked", seq, {
    repoId: "repo-a",
    command: "git -C repo-a pre-commit",
    exitCode: 1,
    summary: "挂钩拒绝",
    recovery: "重新生成变更集",
    failure: true,
  });
  const blockedFirst = fold({ ...input, facts: [gateFail(1), ev(2)] });
  const implC = blockedFirst.addresses[blockedFirst.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(implC.conclusion, "verified", "挂钩拒绝审计先于首现 → pending-integration 退场");
  assert.equal(implC.integrationBlocked, true);
  // IntegrationPrecheckFailed 先于首现同理
  const precheckFirst = fold({
    ...input,
    facts: [
      fact("IntegrationPrecheckFailed", 1, {
        repoId: "repo-a",
        command: "git apply --check",
        exitCode: 1,
        summary: "补丁冲突",
        recovery: "重新生成变更集",
      }),
      ev(2),
    ],
  });
  const implD = precheckFirst.addresses[precheckFirst.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(implD.conclusion, "verified", "预检失败审计先于首现 → pending-integration 退场");
  assert.equal(implD.integrationBlocked, true);
  // 跨快照续 fold 等价：审计在上一批、地址首现在增量批
  const snapshotState = fold({ ...input, facts: [gateOk(1)] });
  const incremental = fold({ ...input, facts: [ev(2)], initialState: snapshotState });
  assert.equal(
    JSON.stringify(incremental),
    JSON.stringify(auditFirst),
    "审计先于首现的跨快照续 fold 与全量 fold 逐字节等价（RL2）",
  );
});

test("旧格式 initialState（缺 repo 级聚合字段）显式拒绝，错误含恢复动作；新格式正常续 fold（RL2 前提）", () => {
  const input = baseInput();
  const factsList = sampleFacts();
  // 旧格式快照：手工剥掉 repo 级聚合字段（bl-7 引入该字段之前的快照形态）——
  // 增量 fold 会把已发生的集成审计当空集、pending-integration 派生静默失真，必须显式拒绝
  const legacy = fold({ ...input, facts: factsList.slice(0, 2) });
  const legacyStripped = JSON.parse(
    JSON.stringify({ ...legacy, integrationSeenRepos: undefined, integrationBlockedRepos: undefined }),
  );
  assert.throws(
    () => fold({ ...input, facts: factsList.slice(2), initialState: legacyStripped }),
    (err) => err.code === "snapshot-legacy-format" && /旧格式/.test(err.message) && /rebuild/.test(err.message) && /恢复动作/.test(err.message),
    "缺任一聚合字段的 initialState 必须抛 snapshot-legacy-format，错误指向 rebuild/全量 fold 重建入口",
  );
  // 只缺一个字段同样拒绝（任一缺失都破坏 RL2 等价性前提）
  const halfStripped = JSON.parse(JSON.stringify({ ...legacy, integrationBlockedRepos: undefined }));
  assert.throws(
    () => fold({ ...input, facts: factsList.slice(2), initialState: halfStripped }),
    (err) => err.code === "snapshot-legacy-format",
  );
  // 新格式快照（fold 产物自带两字段）正常续 fold 且与全量等价（既有 RL2 行为不回归）
  const incremental = fold({ ...input, facts: factsList.slice(2), initialState: legacy });
  const full = fold({ ...input, facts: factsList });
  assert.equal(JSON.stringify(incremental), JSON.stringify(full), "含聚合字段的快照续 fold 保持 RL2 等价");
});

test("seq 不连续或非正的事实序列被 fold 拒绝（事件序列无空洞）", () => {
  const input = baseInput();
  assert.throws(() => fold({ ...input, facts: [sampleFacts()[0], sampleFacts()[2]] }), /seq/);
  assert.throws(() => fold({ ...input, facts: [{ ...sampleFacts()[0], seq: 0 }] }), /seq/);
});

// ---------------------------------------------------------------------------
// 3. 状态谓词派生不存储（AX5 / D3）
// ---------------------------------------------------------------------------

test("谓词不落存储：事实对象与快照 input 均不含谓词字段，谓词只存在于 fold 产物", () => {
  const input = baseInput();
  const factsList = sampleFacts();
  const state = fold({ ...input, facts: factsList });
  // 输入侧（持久权威）不含任何谓词/结论字段
  for (const f of factsList) {
    for (const forbidden of ["conclusion", "verified", "awaitingRuling", "pendingIntegration", "status"]) {
      assert.ok(!(forbidden in f), `事实对象不得携带持久状态字段 ${forbidden}（AX5）`);
    }
  }
  assert.ok(!("conclusion" in input), "快照 input 不得携带结论字段（AX5）");
  // 产物侧谓词在场（派生谓词是 fold 的输出，不是存储）
  const docKey = state.keys[JSON.stringify(ADDR_DOC)] ?? state.keys[facts.canonicalJson(ADDR_DOC)];
  assert.ok(state.addresses[docKey], "fold 产物必须含地址键索引");
  assert.ok(typeof state.addresses[docKey].conclusion === "string");
});

test("awaiting-ruling 由未应答 RulingRequested 派生，RulingRecorded 后解除", () => {
  const input = baseInput();
  const req = fact("RulingRequested", 1, { address: ADDR_DOC, question: "方向？" });
  const only = fold({ ...input, facts: [req] });
  const docOnly = only.addresses[only.keys[facts.canonicalJson(ADDR_DOC)]];
  assert.equal(docOnly.conclusion, "awaiting-ruling");
  assert.equal(docOnly.awaitingRuling, true);
  const answered = fold({
    ...input,
    facts: [req, fact("RulingRecorded", 2, { address: ADDR_DOC, direction: "doc-right", respondsTo: 1 })],
  });
  const docAnswered = answered.addresses[answered.keys[facts.canonicalJson(ADDR_DOC)]];
  assert.equal(docAnswered.awaitingRuling, false);
  assert.equal(docAnswered.conclusion, "open");
});

test("RulingRecorded(direction=waived) 后地址终态派生为 waived；重放稳定；verified 优先与最新裁决覆盖（bl-1）", () => {
  const input = baseInput();
  const req = fact("RulingRequested", 1, { address: ADDR_DOC, question: "该义务是否豁免（设计撤回声明）？" });
  const rec = fact("RulingRecorded", 2, { address: ADDR_DOC, direction: "waived", respondsTo: 1 });
  const state = fold({ ...input, facts: [req, rec] });
  const doc = state.addresses[state.keys[facts.canonicalJson(ADDR_DOC)]];
  assert.equal(doc.awaitingRuling, false);
  assert.equal(doc.lastRuling.direction, "waived");
  assert.equal(doc.conclusion, "waived", "waived 裁决后 fold 层终态为 waived（权威源不分裂，workflow 层自然贯通）");
  // 同序重放稳定
  const replay = fold({ ...input, facts: [{ ...req }, { ...rec }] });
  assert.equal(JSON.stringify(state), JSON.stringify(replay), "同序重放逐字节相等");
  // 有效 pass 证据优先级高于 waived（与 workflow 层终态派生同序：awaiting-ruling > verified > waived）
  const ev = fact("EvidenceRecorded", 3, {
    address: ADDR_DOC,
    obligationHash: facts.obligationSummaryHash(input.bindings[0]),
    checkerId: "symbol-scan",
    checkerVersion: "1.0.0",
    bindingVersion: 1,
    inputs: [{ name: "repo-a/docs/design.md", hash: "a".repeat(64) }],
    result: "pass",
  });
  const afterPass = fold({ ...input, facts: [req, rec, ev] });
  assert.equal(
    afterPass.addresses[afterPass.keys[facts.canonicalJson(ADDR_DOC)]].conclusion,
    "verified",
    "有效 pass 证据在场时 verified 优先于 waived（与 workflow 层终态派生同序）",
  );
  // 最新裁决方向决定 waived 终态去留：waived 后重新裁决 code-right → 回 open
  const req2 = fact("RulingRequested", 3, { address: ADDR_DOC, question: "重新裁决方向" });
  const rec2 = fact("RulingRecorded", 4, { address: ADDR_DOC, direction: "code-right", respondsTo: 3 });
  const reRuled = fold({ ...input, facts: [req, rec, req2, rec2] });
  assert.equal(
    reRuled.addresses[reRuled.keys[facts.canonicalJson(ADDR_DOC)]].conclusion,
    "open",
    "最新裁决 direction 非 waived 时 waived 终态解除（direction 随 lastRuling 覆盖）",
  );
});

test("conclusion 词表常量 CONCLUSIONS：五值齐备、冻结、无重复（收敛循环产出域唯一权威登记）", () => {
  assert.deepEqual(
    [...CONCLUSIONS].sort(),
    ["awaiting-ruling", "open", "pending-integration", "verified", "waived"],
    "结论词表必须与收敛循环产出域一致（waived 与 verified/open 并列登记）",
  );
  assert.ok(Object.isFrozen(CONCLUSIONS), "词表常量必须冻结");
  assert.equal(CONCLUSIONS.length, new Set(CONCLUSIONS).size, "词表不得有重复成员");
  // 派生出的 conclusion 全部落在词表内：waived 流 + pending-integration 流混合断言
  const input = baseInput();
  const waivedStream = fold({
    ...input,
    facts: [
      fact("RulingRequested", 1, { address: ADDR_DOC, question: "豁免？" }),
      fact("RulingRecorded", 2, { address: ADDR_DOC, direction: "waived", respondsTo: 1 }),
    ],
  });
  const pendingStream = fold({
    ...input,
    facts: [
      fact("EvidenceRecorded", 1, {
        address: ADDR_IMPL,
        obligationHash: facts.obligationSummaryHash(input.bindings[1]),
        checkerId: "symbol-scan",
        checkerVersion: "1.0.0",
        bindingVersion: 2,
        inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
        result: "pass",
        changesetId: "cs-1",
      }),
    ],
  });
  for (const s of [...Object.values(waivedStream.addresses), ...Object.values(pendingStream.addresses)]) {
    assert.ok(CONCLUSIONS.includes(s.conclusion), `结论 ${s.conclusion} 必须落在 CONCLUSIONS 词表内`);
  }
  assert.equal(waivedStream.addresses[waivedStream.keys[facts.canonicalJson(ADDR_DOC)]].conclusion, "waived");
  assert.equal(pendingStream.addresses[pendingStream.keys[facts.canonicalJson(ADDR_IMPL)]].conclusion, "pending-integration");
});

test("verified / pending-integration 由有效 pass 证据派生；证据是唯一 verified 来源", () => {
  const input = baseInput();
  const ev = fact("EvidenceRecorded", 1, {
    address: ADDR_IMPL,
    obligationHash: facts.obligationSummaryHash(input.bindings[1]),
    checkerId: "symbol-scan",
    checkerVersion: "1.0.0",
    bindingVersion: 2,
    inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
    result: "pass",
  });
  const verifiedState = fold({ ...input, facts: [ev] });
  const impl = verifiedState.addresses[verifiedState.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(impl.conclusion, "verified");
  assert.equal(impl.verification, "verified");
  assert.equal(impl.pendingIntegration, false);
  // 无任何集成事实时 verified 不等于 pending-integration；出现集成审计事实后离开 pending-integration
  const withGate = fold({
    ...input,
    facts: [
      ev,
      fact("IntegrationGateChecked", 2, {
        repoId: "repo-a",
        command: "git apply --check",
        exitCode: 0,
        summary: "预检通过",
        recovery: "非失败记录，无需恢复",
        failure: false,
      }),
    ],
  });
  const impl2 = withGate.addresses[withGate.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(impl2.pendingIntegration, false, "集成审计事实在场时不得停留 pending-integration");
});

test("CheckerFailed 不伪造 verified：义务保持 open，失败四要素（命令/退出码/摘要/恢复动作）可查", () => {
  const input = baseInput();
  const f = fact("CheckerFailed", 1, {
    address: ADDR_IMPL,
    command: "node semantic-check.mjs",
    exitCode: 20,
    summary: "checker 自身失败",
    recovery: "修复 checker 后重跑",
  });
  const state = fold({ ...input, facts: [f] });
  const impl = state.addresses[state.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(impl.conclusion, "open", "checker 失败必须保持义务 open（设计段五）");
  assert.equal(impl.verification, "unverified");
  assert.deepEqual(
    { command: impl.lastCheckerFailure.command, exitCode: impl.lastCheckerFailure.exitCode,
      summary: impl.lastCheckerFailure.summary, recovery: impl.lastCheckerFailure.recovery },
    { command: "node semantic-check.mjs", exitCode: 20, summary: "checker 自身失败", recovery: "修复 checker 后重跑" },
  );
});

test("归档态是派生谓词：archived 输入 + Unarchived 事件解档，无归档存储字段被事件改写", () => {
  const input = baseInput();
  assert.equal(fold({ ...input, archived: true, facts: [] }).archived, true, "归档输入直接派生归档态");
  const un = fold({ ...input, archived: true, facts: [fact("Unarchived", 1, { reason: "复活通道解档" })] });
  assert.equal(un.archived, false, "Unarchived 事件必须解档（M5 复活通道）");
  // 解档后可继续派生新事实状态
  const after = fold({
    ...input,
    archived: true,
    facts: [
      fact("Unarchived", 1, { reason: "复活通道解档" }),
      fact("EvidenceRecorded", 2, {
        address: ADDR_IMPL,
        obligationHash: facts.obligationSummaryHash(input.bindings[1]),
        checkerId: "symbol-scan",
        checkerVersion: "1.0.0",
        bindingVersion: 2,
        inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
        result: "pass",
      }),
    ],
  });
  const impl = after.addresses[after.keys[facts.canonicalJson(ADDR_IMPL)]];
  assert.equal(impl.conclusion, "verified", "解档后事件继续参与 fold");
});

test("地址不可解析（bindingId 不在绑定集）在 fold 中报错，身份一致性可判定（AX2）", () => {
  const input = baseInput();
  const orphan = fact("RulingRequested", 1, {
    address: { bindingId: "NOPE", repoId: "repo-a", violationKind: "documentation-mismatch" },
    question: "?",
  });
  assert.throws(() => fold({ ...input, facts: [orphan] }), /bindingId|绑定/);
  // repoId / violationKind 与绑定声明不一致同样拒绝
  const mismatched = fact("RulingRequested", 1, {
    address: { bindingId: "GL1", repoId: "repo-b", violationKind: "documentation-mismatch" },
    question: "?",
  });
  assert.throws(() => fold({ ...input, facts: [mismatched] }), /repoId/);
});

test("无孤儿证据检测器：binding/repo/checker run/changeset 引用缺失逐一可检出", () => {
  const input = baseInput();
  const ev = (seq, changesetId) => fact("EvidenceRecorded", seq, {
    address: ADDR_IMPL,
    obligationHash: facts.obligationSummaryHash(input.bindings[1]),
    checkerId: "symbol-scan",
    checkerVersion: "1.0.0",
    bindingVersion: 2,
    inputs: [{ name: "repo-a/src/main.js", hash: "b".repeat(64) }],
    result: "pass",
    ...(changesetId ? { changesetId } : {}),
  });
  assert.deepEqual(findOrphanEvidence({ ...input, facts: [ev(1, "cs-1")] }), [], "全存在引用无孤儿");
  const orphans = findOrphanEvidence({
    ...input,
    repos: [],
    checkerRuns: [],
    changesets: [{ changesetId: "cs-1" }],
    facts: [ev(1, "cs-ghost")],
  });
  assert.equal(orphans.length, 3, "repo/checkerRun/changeset 三类孤儿引用各报一条");
  assert.ok(orphans.some((o) => o.kind === "repo"));
  assert.ok(orphans.some((o) => o.kind === "checker-run"));
  assert.ok(orphans.some((o) => o.kind === "changeset" && o.ref === "cs-ghost"));
});

// ---------------------------------------------------------------------------
// 4. 事件量红灯阈值（D2）
// ---------------------------------------------------------------------------

test("红灯探针常量：50 MB / 10 万条，超限与未超限可判定（D2 登记阈值）", () => {
  assert.equal(facts.RED_LINE_THRESHOLDS.maxEventJsonlBytes, 50 * 1024 * 1024);
  assert.equal(facts.RED_LINE_THRESHOLDS.maxEventCount, 100000);
  const ok = facts.checkRedLineThresholds({ bytes: 1024, count: 10 });
  assert.equal(ok.exceeded, false);
  const red = facts.checkRedLineThresholds({
    bytes: facts.RED_LINE_THRESHOLDS.maxEventJsonlBytes + 1,
    count: 5,
  });
  assert.equal(red.exceeded, true);
  assert.ok(red.violations.some((v) => v.kind === "bytes"));
  const redCount = facts.checkRedLineThresholds({ bytes: 1, count: facts.RED_LINE_THRESHOLDS.maxEventCount + 1 });
  assert.equal(redCount.exceeded, true);
  assert.ok(redCount.violations.some((v) => v.kind === "count"));
});
