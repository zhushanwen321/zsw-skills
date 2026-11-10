// checker-cache.test.mjs — 语义检查缓存：零调用复用与输入变化失效（sync-conformance-plane U2/M2）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   G7 --hash-stable / RL7 / V7 / D7：
//     1. 同义务 + 同 artifact 哈希 + 同 checker 版本 → 第二轮零 run 调用、复用缓存判定（V7 第二步）
//     2. artifact 变化 → 缓存键变化 → 重新调用；旧证据按 content-changed 失效（V7 第三步 / AX4）
//     3. checker 版本变化 → 全量失效（键含版本）
//     4. 义务摘要变化（绑定升版）→ 缓存键变化
//     5. deterministic 不走缓存（D7 只缓存 semantic）
//     6. 失败判定不入缓存：失败后重跑必须真实调用
//
// 运行：node --test scripts/tests/checker-cache.test.mjs
//（守护命令形态 node scripts/tests/checker-cache.test.mjs --hash-stable 等价——
//  flag 为守护登记形态，文件恒跑全部用例）

import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");

const evidence = await import(join(CP, "kernel", "evidence.mjs"));
const registryMod = await import(join(CP, "checkers", "registry.mjs"));
const { createSemanticCache, buildCacheKey } = await import(join(CP, "checkers", "semantic-cache.mjs"));
const { normalizeBinding } = await import(join(CP, "extractors", "obligations.mjs"));

const H1 = "a".repeat(64);

/** 义务行（章节 JSON 绑定完整形态 → 提取器归一化，含 checkerId 等检查契约字段） */
function makeObligation(over = {}) {
  const binding = {
    bindingId: "GL2",
    repoId: "repo-main",
    violationKind: "behavior-mismatch",
    bindingVersion: 1,
    targetSelector: "src/a.mjs",
    checkerId: "semantic-review",
    severity: "must-fix",
    evidenceInputs: ["src/a.mjs"],
    ...over,
  };
  return normalizeBinding(binding, { entryId: binding.bindingId, where: "fixture" });
}

/** 带调用计数的 semantic checker（replay 模拟 agent 判定） */
function countingSemanticChecker({ verdict = { result: "pass", summary: "重放一致" }, raw = null } = {}) {
  const calls = [];
  return {
    def: {
      id: "semantic-review",
      kind: "semantic",
      version: "0.3.0",
      run: async (input) => {
        calls.push({ attempt: input.attempt, feedback: input.feedback, inputHashes: input.inputHashes });
        return raw ?? JSON.stringify(verdict);
      },
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 1. 同义务同哈希 → 零调用复用（G7 / V7 第二步）
// ---------------------------------------------------------------------------

test("同义务同哈希第二轮：零 run 调用、复用缓存判定、证据命令一致（G7 --hash-stable）", async () => {
  const { def, calls } = countingSemanticChecker();
  const registry = registryMod.createCheckerRegistry([def]);
  const cache = createSemanticCache();
  const obligation = makeObligation();
  const artifacts = { "src/a.mjs": "const x = 1;" };
  const r1 = await registryMod.runChecker(registry, { obligation, artifacts, cache, actor: "checker-wrapper" });
  assert.equal(r1.status, "pass");
  assert.equal(r1.calls, 1);
  assert.equal(r1.reused, false);
  assert.equal(calls.length, 1);
  const r2 = await registryMod.runChecker(registry, { obligation, artifacts, cache, actor: "checker-wrapper" });
  assert.equal(r2.status, "pass");
  assert.equal(r2.calls, 0, "第二轮零调用（V7：复用证据）");
  assert.equal(r2.reused, true);
  assert.equal(calls.length, 1, "agent 判定只发生一次");
  assert.deepEqual(r2.commands, r1.commands, "复用轮的 RecordEvidence 命令与首轮一致");
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
  assert.equal(cache.stats.sets, 1);
});

// ---------------------------------------------------------------------------
// 2. artifact 变化 → 失效重判（V7 第三步 / AX4）
// ---------------------------------------------------------------------------

test("artifact 变化：缓存键变化、重新调用；旧证据按 content-changed 失效（G7）", async () => {
  const { def, calls } = countingSemanticChecker();
  const registry = registryMod.createCheckerRegistry([def]);
  const cache = createSemanticCache();
  const obligation = makeObligation();
  const before = { "src/a.mjs": "const x = 1;" };
  const after = { "src/a.mjs": "const x = 2; // 内容变化" };
  const r1 = await registryMod.runChecker(registry, { obligation, artifacts: before, cache });
  const hashBefore = r1.inputHashes["src/a.mjs"];
  const r2 = await registryMod.runChecker(registry, { obligation, artifacts: after, cache });
  assert.equal(r2.calls, 1, "内容变化后重新调用（不命中旧缓存）");
  assert.equal(r2.reused, false);
  assert.notEqual(r2.inputHashes["src/a.mjs"], hashBefore);
  assert.equal(calls.length, 2);
  // 旧证据在新内容上失效（AX4/D3）：content-changed 原因可查
  const oldEvidence = r1.commands[0].payload;
  const currentArtifacts = { "src/a.mjs": evidence.hashContent(after["src/a.mjs"]) };
  const verdict = evidence.evaluateEvidence(oldEvidence, { bindings: [obligation.binding], checkerRuns: [{ checkerId: def.id, checkerVersion: def.version }], artifacts: currentArtifacts });
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.some((x) => x.code === "content-changed" && x.input === "src/a.mjs"));
  // 同一输入再次对账又命中缓存（变化后的判定被缓存）
  const r3 = await registryMod.runChecker(registry, { obligation, artifacts: after, cache });
  assert.equal(r3.calls, 0);
  assert.equal(r3.reused, true);
});

test("checker 版本升版与义务摘要变化都使缓存失效（键成分逐项可判定）", async () => {
  const { def, calls } = countingSemanticChecker();
  const registry = registryMod.createCheckerRegistry([def]);
  const cache = createSemanticCache();
  const obligation = makeObligation();
  const artifacts = { "src/a.mjs": "const x = 1;" };
  await registryMod.runChecker(registry, { obligation, artifacts, cache });
  assert.equal(calls.length, 1);
  // checker 升版：登记新版本 → 键含版本 → miss
  const v2 = { ...def, version: "0.4.0" };
  const registry2 = registryMod.createCheckerRegistry([v2]);
  const r2 = await registryMod.runChecker(registry2, { obligation, artifacts, cache });
  assert.equal(r2.calls, 1, "checker 版本变化必须重新判定");
  assert.notEqual(
    buildCacheKey({ obligation, inputHashes: r2.inputHashes, checkerVersion: "0.4.0" }),
    buildCacheKey({ obligation, inputHashes: r2.inputHashes, checkerVersion: "0.3.0" }),
  );
  // 义务升版：summaryHash 变化 → miss
  const obligationV2 = makeObligation({ bindingVersion: 2 });
  const r3 = await registryMod.runChecker(registry, { obligation: obligationV2, artifacts, cache });
  assert.equal(r3.calls, 1, "义务摘要变化必须重新判定");
  assert.notEqual(obligationV2.summaryHash, obligation.summaryHash);
  assert.equal(calls.length, 3);
});

// ---------------------------------------------------------------------------
// 3. 分层纪律：deterministic 不缓存；失败判定不入缓存
// ---------------------------------------------------------------------------

test("deterministic checker 不走语义缓存（D7 只缓存 semantic）；失败判定不入缓存（失败后重跑真实调用）", async () => {
  const cache = createSemanticCache();
  let detCalls = 0;
  const det = {
    id: "symbol-scan",
    kind: "deterministic",
    version: "1.0.0",
    run: async () => {
      detCalls += 1;
      return { command: "node symbol-scan.mjs", exitCode: registryMod.CHECKER_EXIT.PASS };
    },
  };
  const registry = registryMod.createCheckerRegistry([det]);
  const obligation = makeObligation({ checkerId: "symbol-scan" });
  const artifacts = { "src/a.mjs": "const x = 1;" };
  await registryMod.runChecker(registry, { obligation, artifacts, cache });
  await registryMod.runChecker(registry, { obligation, artifacts, cache });
  assert.equal(detCalls, 2, "deterministic 每轮真实执行（机械检查廉价，不缓存）");
  assert.equal(cache.size(), 0, "语义缓存不收录 deterministic 结果");
  // 失败不入缓存：非法输出耗尽后，修复 checker 重跑必须真实调用（V13「修复 checker 后重跑」）
  const semanticObligation = makeObligation({ checkerId: "semantic-review" });
  const failing = countingSemanticChecker({ raw: "这不是 JSON" });
  const failingRegistry = registryMod.createCheckerRegistry([failing.def]);
  const failingCache = createSemanticCache();
  const rf = await registryMod.runChecker(failingRegistry, { obligation: semanticObligation, artifacts, cache: failingCache });
  assert.equal(rf.status, "failure");
  assert.equal(failingCache.size(), 0, "失败判定不得进入缓存");
  const fixed = countingSemanticChecker({ verdict: { result: "fail", summary: "修复后判定：违例成立" } });
  const fixedRegistry = registryMod.createCheckerRegistry([fixed.def]);
  const rr = await registryMod.runChecker(fixedRegistry, { obligation: semanticObligation, artifacts, cache: failingCache });
  assert.equal(rr.status, "violation");
  assert.equal(rr.calls, 1, "修复后的重跑是真实调用（复用失败缓存 = 伪造）");
  assert.equal(failingCache.size(), 1, "合法判定才入缓存");
});
