// evidence-invalidation.test.mjs — 证据哈希失效单元测试（sync-conformance-plane U1/M1）
//
// 覆盖（守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   - G3 --hash-change / RL3 / V3：被检内容、checker 版本、绑定版本任一变化即失效，
//     失效原因可查（reason 分类）；全部不变则持续有效
//   - 义务摘要（规范化绑定 JSON 内容哈希，设计段三）键序无关、内容敏感
//   - 证据五要素（AX4）：被检义务、输入集合+逐项哈希、checker id+版本、结果、执行者
//
// 运行：node --test scripts/tests/evidence-invalidation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane", "kernel");

const facts = await import(join(CP, "facts.mjs"));
const evidence = await import(join(CP, "evidence.mjs"));

const BINDING = {
  bindingId: "V12",
  repoId: "repo-a",
  violationKind: "missing-implementation",
  target: "repo-a/src/main.js",
  bindingVersion: 2,
};
const ADDR = { bindingId: "V12", repoId: "repo-a", violationKind: "missing-implementation" };
const CHECKER = { checkerId: "semantic-review", checkerVersion: "0.3.0" };

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

function currentWorld() {
  return {
    bindings: [BINDING],
    checkerRuns: [CHECKER],
    artifacts: { "repo-a/src/main.js": sha("impl-v1"), "repo-a/docs/spec.md": sha("spec-v1") },
  };
}

function recordEvidence() {
  const rec = evidence.computeEvidence({
    address: ADDR,
    binding: BINDING,
    checkerId: CHECKER.checkerId,
    checkerVersion: CHECKER.checkerVersion,
    inputs: [
      { name: "repo-a/src/main.js", hash: sha("impl-v1") },
      { name: "repo-a/docs/spec.md", hash: sha("spec-v1") },
    ],
    actor: "checker-wrapper",
  });
  const ok = facts.validateFact({ type: "EvidenceRecorded", seq: 1, ts: "2026-11-10T10:00:00.000Z", ...rec });
  assert.ok(ok.ok, `computeEvidence 产出必须过事件 schema 校验：${JSON.stringify(ok.errors)}`);
  return rec;
}

test("AX4 五要素齐备：被检义务、输入逐项哈希、checker id+版本、结果、执行者", () => {
  const rec = recordEvidence();
  assert.deepEqual(rec.address, ADDR, "被检义务地址在场");
  assert.equal(rec.obligationHash.length, 64, "义务摘要在场（规范化绑定 JSON 哈希）");
  assert.equal(rec.inputs.length, 2);
  for (const i of rec.inputs) {
    assert.match(i.hash, /^[0-9a-f]{64}$/, `输入 ${i.name} 必须带内容哈希`);
  }
  assert.deepEqual(
    { checkerId: rec.checkerId, checkerVersion: rec.checkerVersion, result: rec.result, actor: rec.actor },
    { checkerId: "semantic-review", checkerVersion: "0.3.0", result: "pass", actor: "checker-wrapper" },
  );
});

test("全部输入不变则证据持续有效（V3 反向）", () => {
  const rec = recordEvidence();
  const r = evidence.evaluateEvidence(rec, currentWorld());
  assert.equal(r.valid, true, `未变输入必须持续有效：${JSON.stringify(r.reasons)}`);
  assert.deepEqual(r.reasons, []);
});

test("被检内容哈希变化即失效，失效原因指向变化输入（G3/V3）", () => {
  const rec = recordEvidence();
  const world = currentWorld();
  world.artifacts["repo-a/src/main.js"] = sha("impl-v2"); // 内容 H → H prime
  const r = evidence.evaluateEvidence(rec, world);
  assert.equal(r.valid, false, "任一输入哈希变化即失效（AX4）");
  const reasons = r.reasons.filter((x) => x.code === "content-changed");
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].input, "repo-a/src/main.js");
  // 其余输入未变化不得误报
  assert.ok(!r.reasons.some((x) => x.input === "repo-a/docs/spec.md"));
});

test("被检输入从 artifact 表中消失即失效（artifact-missing 可判定）", () => {
  const rec = recordEvidence();
  const world = currentWorld();
  delete world.artifacts["repo-a/docs/spec.md"];
  const r = evidence.evaluateEvidence(rec, world);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((x) => x.code === "artifact-missing" && x.input === "repo-a/docs/spec.md"));
});

test("checker 版本变化即失效，原因分类 checker-version-changed", () => {
  const rec = recordEvidence();
  const world = currentWorld();
  world.checkerRuns = [{ checkerId: "semantic-review", checkerVersion: "0.4.0" }];
  const r = evidence.evaluateEvidence(rec, world);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((x) => x.code === "checker-version-changed"), `实际原因：${JSON.stringify(r.reasons)}`);
});

test("绑定版本变化即失效，原因分类 binding-version-changed", () => {
  const rec = recordEvidence();
  const world = currentWorld();
  world.bindings = [{ ...BINDING, bindingVersion: 3 }];
  const r = evidence.evaluateEvidence(rec, world);
  assert.equal(r.valid, false);
  assert.ok(r.reasons.some((x) => x.code === "binding-version-changed"));
});

test("绑定内容被改而版本未 bump 即失效（义务摘要比对，防义务漂移漏洞）", () => {
  const rec = recordEvidence();
  const world = currentWorld();
  world.bindings = [{ ...BINDING, target: "repo-a/src/other.js" }]; // 版本不变、内容漂移
  const r = evidence.evaluateEvidence(rec, world);
  assert.equal(r.valid, false, "绑定内容漂移必须被义务摘要比对抓住");
  assert.ok(r.reasons.some((x) => x.code === "obligation-changed"));
});

test("义务摘要 = 规范化绑定 JSON 内容哈希：键序无关、内容敏感（设计段三）", () => {
  const a = evidence.computeEvidence({
    address: ADDR, binding: BINDING, checkerId: "c", checkerVersion: "1",
    inputs: [{ name: "x", hash: sha("1") }], actor: "w",
  });
  const reordered = {
    bindingVersion: 2, violationKind: "missing-implementation", repoId: "repo-a",
    target: "repo-a/src/main.js", bindingId: "V12",
  };
  const b = evidence.computeEvidence({
    address: ADDR, binding: reordered, checkerId: "c", checkerVersion: "1",
    inputs: [{ name: "x", hash: sha("1") }], actor: "w",
  });
  assert.equal(a.obligationHash, b.obligationHash, "键序不同、内容相同的绑定必须得到同一摘要");
  const changed = evidence.computeEvidence({
    address: ADDR, binding: { ...BINDING, severity: "must-fix" }, checkerId: "c", checkerVersion: "1",
    inputs: [{ name: "x", hash: sha("1") }], actor: "w",
  });
  assert.notEqual(a.obligationHash, changed.obligationHash, "绑定内容变化必须改变摘要");
});

test("canonicalJson 与 hashContent 为确定性原语", () => {
  assert.equal(facts.canonicalJson({ b: 1, a: [2, { z: 3, y: 4 }] }), facts.canonicalJson({ a: [2, { y: 4, z: 3 }], b: 1 }));
  assert.equal(evidence.hashContent("同一内容"), evidence.hashContent("同一内容"));
  assert.notEqual(evidence.hashContent("同一内容"), evidence.hashContent("另一内容"));
});
