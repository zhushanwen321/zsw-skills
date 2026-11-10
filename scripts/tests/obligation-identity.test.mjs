// obligation-identity.test.mjs — 义务身份与提取重放稳定（sync-conformance-plane U2/M2）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   G1 --replay-stable / RL1 / V1-V2：
//     1. 同一设计包版本重放提取 → 同一义务表（逐字节相等）与同一地址集
//     2. 同章节条目多绑定（conformance 数组）→ 多个绑定 id、地址互异（AX2）
//     3. 跨章节条目地址分离；bindingId 包内撞名被拒
//     4. 重复报告同地址：golden corpus 论点契约两个真实 F2-1 分离为两个地址；同一地址的
//        重复报告得到同一地址键（V2 夹具回归）
//     5. 词表与版本纪律：violationKind 词表三处一致（kernel facts 唯一权威 / 提取器重导出 /
//        check-design-doc.mjs 副本），conformance schemaVersion 两处一致
//     6. AX8：无绑定叙述不进义务表，只列未绑定清单
//
// 运行：node --test scripts/tests/obligation-identity.test.mjs
//（守护命令形态 node scripts/tests/obligation-identity.test.mjs --replay-stable 等价——
//  与 state-fold.test.mjs 同款：flag 为守护登记形态，文件恒跑全部用例）

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");
const CHECK_SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "tech-design-wf", "scripts", "check-design-doc.mjs");

const facts = await import(join(CP, "kernel", "facts.mjs"));
const { fold, addressKey } = await import(join(CP, "kernel", "state-fold.mjs"));
const obligations = await import(join(CP, "extractors", "obligations.mjs"));

// ── 夹具：最小章节 JSON（同 check-design-doc.test.mjs 的 legalDesign 骨架 + conformance 绑定）──

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
        { id: "GL1", statement: "使用者能做到示意事项" },
        {
          id: "GL2",
          statement: "重放对账得到同一批差距地址",
          conformance: {
            bindingId: "GL2",
            repoId: "repo-main",
            targetSelector: "src/replay.mjs",
            violationKind: "missing-implementation",
            checkerId: "symbol-scan",
            severity: "must-fix",
            evidenceInputs: ["src/replay.mjs"],
          },
        },
      ],
      outOfScope: "范围外示意",
    },
    "s2-status.json": {
      currentBehaviour: "现状行为示意。",
      flowDiagram: "主流程 → 环节示意",
      problems: [{ id: "PR1", stage: "主流程 → 环节示意", symptom: "现象示意", rootCause: "根因示意" }],
      assumptions: [{ id: "AS1", statement: "前提示意", status: "pending", evidence: "", impactIfFalse: "影响示意" }],
      artifactTables: {
        stateCopies: [
          {
            id: "SC1",
            state: "状态示意",
            location: "模块示意",
            nature: "authority",
            sync: "同步机制示意",
            excluded: false,
            exclusionNote: "",
            // 同一条目多绑定：叙述声明 + 机器契约（代码侧与文档侧各一）
            conformance: [
              {
                bindingId: "SC1-src",
                repoId: "repo-main",
                targetSelector: "src/state.mjs",
                violationKind: "missing-implementation",
                checkerId: "symbol-scan",
                severity: "must-fix",
                evidenceInputs: ["src/state.mjs"],
              },
              {
                bindingId: "SC1-docs",
                repoId: "repo-docs",
                targetSelector: "docs/state.md",
                violationKind: "documentation-mismatch",
                checkerId: "doc-sync-check",
                severity: "suggestion",
                evidenceInputs: ["docs/state.md", "src/state.mjs"],
              },
            ],
          },
        ],
        signalImplications: [],
        repairHistory: [],
        upstreamDeps: [],
      },
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
      scenarios: [
        {
          id: "V1",
          scene: "场景示意",
          steps: "步骤示意",
          criteria: "标准示意",
          goalRefs: ["GL1"],
          conformance: {
            repoId: "repo-main",
            targetSelector: "src/replay.mjs",
            violationKind: "test-evidence-missing",
            checkerId: "symbol-scan",
            severity: "must-fix",
            evidenceInputs: ["src/replay.test.mjs"],
            // bindingId 缺省 = 条目 id（V1）；bindingVersion 缺省 1
          },
        },
      ],
      assertionRedlights: [],
      e2eImpact: { items: [], noneReason: "无受影响项依据示意" },
    },
    "s5-breakdown.json": {
      units: [{ id: "U1", title: "单元示意", justification: "拆分理由示意", files: ["src/example.py"], checkpoints: ["待验证点示意"] }],
      fileMap: "文件改动地图示意。",
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 重放稳定（G1 / RL1 / V1）
// ---------------------------------------------------------------------------

test("重放稳定：同一设计包两次提取义务表逐字节相等、地址集一致（G1 --replay-stable）", () => {
  const docs = legalDocs();
  const r1 = obligations.extractObligations(docs);
  const r2 = obligations.extractObligations(structuredClone(docs));
  assert.equal(r1.tableVersion, r2.tableVersion, "义务表版本（内容哈希）重放一致");
  assert.equal(JSON.stringify(r1.obligations), JSON.stringify(r2.obligations), "义务行重放逐字节相等");
  const keys1 = r1.obligations.map((o) => addressKey(o.address)).sort();
  const keys2 = r2.obligations.map((o) => addressKey(o.address)).sort();
  assert.deepEqual(keys1, keys2, "地址集重放一致");
  // 绑定内容修订（含契约字段）→ 表版本变化（版本化语义）
  const mutated = structuredClone(docs);
  mutated["s2-status.json"].artifactTables.stateCopies[0].conformance[0].checkerId = "symbol-scan-v2";
  const r3 = obligations.extractObligations(mutated);
  assert.notEqual(r1.tableVersion, r3.tableVersion, "检查契约字段变化必须使义务表版本升版");
  const mutatedIdentity = structuredClone(docs);
  mutatedIdentity["s2-status.json"].artifactTables.stateCopies[0].conformance[0].bindingVersion = 2;
  const r4 = obligations.extractObligations(mutatedIdentity);
  assert.notEqual(r1.tableVersion, r4.tableVersion, "绑定版本变化必须使义务表版本升版");
  assert.notEqual(
    JSON.stringify(r1.obligations.map((o) => o.summaryHash).sort()),
    JSON.stringify(r4.obligations.map((o) => o.summaryHash).sort()),
    "绑定版本升版改变义务摘要哈希（旧证据按 obligation-changed 失效）",
  );
});

// ---------------------------------------------------------------------------
// 2. 同章节条目多绑定 / 跨章节地址分离（AX2）
// ---------------------------------------------------------------------------

test("同章节条目多绑定：一条目两只绑定得到两个 bindingId 与两个互异地址", () => {
  const r = obligations.extractObligations(legalDocs());
  const sc1 = r.obligations.filter((o) => o.entry.id === "SC1");
  assert.equal(sc1.length, 2, "SC1 条目展开为两条义务（代码侧 + 文档侧）");
  const keys = sc1.map((o) => addressKey(o.address));
  assert.notEqual(keys[0], keys[1], "同条目多绑定地址互异");
  assert.deepEqual(
    keys.map((k) => k.split("|")[0]).sort(),
    ["SC1-docs", "SC1-src"],
    "bindingId 分别锚定宿主条目（条目 id + 后缀形态）",
  );
});

test("跨章节条目地址分离：不同章节的绑定各得独立地址；bindingId 包内撞名被拒", () => {
  const r = obligations.extractObligations(legalDocs());
  const byId = new Map(r.obligations.map((o) => [o.bindingId, o]));
  // GL2（s1 goals）与 V1（s4 scenarios，bindingId 缺省 = 条目 id）跨章节共存
  assert.ok(byId.has("GL2") && byId.has("V1"), "跨章节绑定全部提取");
  assert.notEqual(addressKey(byId.get("GL2").address), addressKey(byId.get("V1").address), "跨章节地址分离");
  assert.equal(byId.get("V1").entry.file, "s4-accept.json", "义务行携带章节溯源");
  // 撞名：绑定 id 锚定合法但与其他章节条目 id 相同 → duplicate-binding-id（宿主条目外占用全局 id）
  const colliding = legalDocs();
  colliding["s5-breakdown.json"].units[0].id = "SC1-U1"; // 另一条目占用该 id
  colliding["s2-status.json"].artifactTables.stateCopies[0].conformance[0].bindingId = "SC1-U1"; // 锚定合法（SC1- 前缀）但撞名
  assert.throws(
    () => obligations.extractObligations(colliding),
    (e) => e.code === "duplicate-binding-id" && /撞名/.test(e.message) && /SC1-U1/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// 3. 重复报告同地址 + golden corpus 两个真实 F2-1 分离（G1 / V2）
// ---------------------------------------------------------------------------

test("golden corpus 论点契约两个真实 F2-1 分离为两个地址，摘要哈希与夹具一致；重复报告同地址同键（V2）", async () => {
  const fixture = JSON.parse(readFileSync(join(CP, "test-base", "golden-corpus", "thesis-contract.json"), "utf8"));
  const r = obligations.obligationsFromBindingSet(fixture.input.bindings);
  const keys = r.obligations.map((o) => addressKey(o.address)).sort();
  assert.deepEqual(keys, [...fixture.expectations.distinctAddresses].sort(), "两个真实 F2-1 派生地址与夹具登记一致（不合并）");
  // 摘要哈希口径：夹具 obligationHash == facts.obligationSummaryHash（u-foundation 实测口径）
  for (const o of r.obligations) {
    const fact = fixture.script.find((s) => s.command.payload.address.bindingId === o.bindingId);
    assert.equal(o.summaryHash, fact.command.payload.obligationHash, `义务摘要 ${o.bindingId} 与 golden corpus 夹具一致`);
  }
  // 重复报告：同一绑定的两次报告派生同一地址键（只追加证据、不产生第二身份，AX2）
  const report1 = obligations.obligationsFromBindingSet([fixture.input.bindings[1]]).obligations[0];
  const report2 = obligations.obligationsFromBindingSet([{ ...fixture.input.bindings[1] }]).obligations[0];
  assert.equal(addressKey(report1.address), addressKey(report2.address), "重复报告同地址");
  assert.equal(report1.summaryHash, report2.summaryHash, "重复报告义务摘要一致");
  // fold 视角：同一地址的两条失败证据事件收敛到同一地址状态，不产生新身份
  const baseInput = { ...fixture.input };
  const ev = (seq) => ({
    type: "EvidenceRecorded",
    seq,
    ts: "2026-11-10T10:00:00.000Z",
    actor: "checker-wrapper",
    ...JSON.parse(JSON.stringify(fixture.script.find((s) => s.command.payload.address.bindingId === "F2-1-data-as-of").command.payload)),
  });
  const state = fold({ ...baseInput, facts: [ev(1), ev(2)] });
  const docKeys = Object.values(state.addresses).filter((s) => s.address.bindingId === "F2-1-data-as-of");
  assert.equal(docKeys.length, 1, "重复报告在 fold 中收敛为同一地址状态");
});

// ---------------------------------------------------------------------------
// 4. 词表与版本纪律（kernel facts 唯一权威 ↔ 提取器重导出 ↔ 校验器副本）
// ---------------------------------------------------------------------------

test("violationKind 词表三处一致；conformance schemaVersion 两处一致（扩词表必须升版本）", () => {
  // 提取器重导出 == kernel 权威
  assert.deepEqual([...obligations.VIOLATION_KINDS], [...facts.VIOLATION_KINDS], "提取器词表必须与 kernel facts 一致（唯一权威）");
  // 校验器副本 == kernel 权威（正则提取脚本内的数组字面量——逐行单值形态，格式漂移即测试红）
  const src = readFileSync(CHECK_SCRIPT, "utf8");
  const m = src.match(/const CONFORMANCE_VIOLATION_KINDS = \[([\s\S]*?)\];/);
  assert.ok(m, "check-design-doc.mjs 必须声明 CONFORMANCE_VIOLATION_KINDS 数组");
  const validatorKinds = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  assert.deepEqual(validatorKinds, [...facts.VIOLATION_KINDS], "校验器词表副本必须与 kernel facts 同步（改词表两处同步 + 升版本）");
  // 初始词表六值（设计 targetForm 段一）
  assert.deepEqual([...facts.VIOLATION_KINDS], [
    "missing-implementation",
    "behavior-mismatch",
    "contract-mismatch",
    "documentation-mismatch",
    "test-evidence-missing",
    "overimplementation",
  ]);
  // schemaVersion 一致
  const vm = src.match(/const CONFORMANCE_SCHEMA_VERSION = (\d+);/);
  assert.ok(vm, "check-design-doc.mjs 必须声明 CONFORMANCE_SCHEMA_VERSION");
  assert.equal(Number(vm[1]), obligations.CONFORMANCE_SCHEMA_VERSION, "校验器与提取器的 conformance schemaVersion 必须一致");
  assert.equal(obligations.CONFORMANCE_SCHEMA_VERSION, 2, "当前 conformance schemaVersion = 2（design-doc-schema.md §9b 登记）");
});

test("词表外 violationKind / severity 与非法绑定形态在提取器 fail-fast（err.code 可判定）", () => {
  const bad = (mutate) => {
    const docs = legalDocs();
    mutate(docs["s2-status.json"].artifactTables.stateCopies[0].conformance[0]);
    return docs;
  };
  const cases = [
    [(b) => (b.violationKind = "not-a-kind"), "invalid-violation-kind"],
    [(b) => (b.severity = "mega-fix"), "invalid-severity"],
    [(b) => (b.repoId = ""), "invalid-binding-field"],
    [(b) => (b.checkerId = undefined), "invalid-contract-field"],
    [(b) => (b.evidenceInputs = []), "invalid-evidence-inputs"],
    [(b) => (b.evidenceInputs = ["a.js", "a.js"]), "invalid-evidence-inputs"],
    [(b) => (b.bindingVersion = 0), "invalid-binding-version"],
    [(b) => (b.bindingId = "OTHER-anchor"), "invalid-binding-id"],
  ];
  for (const [mutate, code] of cases) {
    assert.throws(() => obligations.extractObligations(bad(mutate)), (e) => e.code === code, `预期 err.code=${code}`);
  }
  // 无绑定叙述不进义务表、只列未绑定清单（AX8）
  const r = obligations.extractObligations(legalDocs());
  const unboundIds = r.unbound.map((u) => u.id);
  assert.ok(unboundIds.includes("GL1") && unboundIds.includes("D1"), "无绑定条目列入未绑定清单");
  assert.ok(!r.obligations.some((o) => o.bindingId === "GL1"), "未绑定条目不产生义务行");
});

// ---------------------------------------------------------------------------
// 5. 提取器 ↔ 校验器同规（对同一绑定集判定一致：校验器红 ⇔ 提取器抛错）
// ---------------------------------------------------------------------------

test("非法绑定的设计包：校验器 exit 1 与提取器抛错对同一案例一致（双端同规）", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { basename } = await import("node:path");
  const caseMutate = (docs) => {
    docs["s2-status.json"].artifactTables.stateCopies[0].conformance[0].violationKind = "not-a-kind";
  };
  const dir = mkdtempSync(join(tmpdir(), "conf-identity-"));
  try {
    const docs = legalDocs();
    caseMutate(docs);
    for (const [file, value] of Object.entries(docs)) {
      writeFileSync(join(dir, file), JSON.stringify(value, null, 2) + "\n");
    }
    writeFileSync(join(dir, `${basename(dir)}.rendered.md`), "# rendered\n");
    const r = spawnSync(process.execPath, [CHECK_SCRIPT, dir], { encoding: "utf8" });
    assert.equal(r.status, 1, "校验器对词表外 violationKind 应 exit 1");
    assert.match(r.stdout, /violationKind 值「not-a-kind」不在词表/);
    assert.throws(() => obligations.extractObligations(docs), (e) => e.code === "invalid-violation-kind", "提取器对同一案例抛同码错误");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
