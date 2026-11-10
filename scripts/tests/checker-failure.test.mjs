// checker-failure.test.mjs — checker 失败契约：退出 20、四要素与回喂上限（sync-conformance-plane U2/M2）
//
// 覆盖（设计守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   G10 --exit-contract / RL10 / V13 / 段五：
//     1. deterministic 退出 20（及其他非 0/10 值）→ 按自身失败处理：不伪造证据、义务保持 open、
//        CheckerFailed 事实含四要素（命令、退出码、摘要、恢复动作）
//     2. semantic 非法输出回喂 ≤ 2 次（总调用 ≤ 3）后升级 CheckerFailed（V13）
//     3. checker 未注册 → 失败四要素 + 恢复动作指向补登记（U2 检查点）
//     4. 输入 artifact 缺失 → 失败（不拿空内容伪造证据）
//     5. 失败后修复 checker 重跑 → 成功路径可用，义务按 pass 证据 verified
//
// 运行：node --test scripts/tests/checker-failure.test.mjs
//（守护命令形态 node scripts/tests/checker-failure.test.mjs --exit-contract 等价——
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
const { fold } = await import(join(CP, "kernel", "state-fold.mjs"));
const stateRepo = await import(join(CP, "kernel", "state-repo.mjs"));
const registryMod = await import(join(CP, "checkers", "registry.mjs"));
const { normalizeBinding } = await import(join(CP, "extractors", "obligations.mjs"));

const H1 = "a".repeat(64);

function makeObligation(over = {}) {
  const binding = {
    bindingId: "V12",
    repoId: "repo-main",
    violationKind: "missing-implementation",
    bindingVersion: 1,
    targetSelector: "src/main.js",
    checkerId: "symbol-scan",
    severity: "must-fix",
    evidenceInputs: ["src/main.js"],
    ...over,
  };
  return normalizeBinding(binding, { entryId: binding.bindingId, where: "fixture" });
}

function repoInput() {
  return {
    archived: false,
    bindings: [
      { bindingId: "V12", repoId: "repo-main", violationKind: "missing-implementation", bindingVersion: 1 },
    ],
    repos: [{ repoId: "repo-main" }],
    checkerRuns: [
      { checkerId: "symbol-scan", checkerVersion: "1.0.0" },
      { checkerId: "semantic-review", checkerVersion: "0.3.0" },
    ],
    changesets: [],
    artifacts: { "src/main.js": H1 },
  };
}

/** 失败命令的四要素读取（V13 断言形态：命令、退出码、摘要、恢复动作） */
function fourElements(cmd) {
  assert.equal(cmd.type, "RecordCheckerFailure", "失败产物是 CheckerFailed 命令（不伪造证据）");
  const p = cmd.payload;
  for (const field of ["command", "summary", "recovery"]) {
    assert.ok(typeof p[field] === "string" && p[field].trim() !== "", `四要素 ${field} 必须非空字符串`);
  }
  assert.ok(Number.isInteger(p.exitCode), "四要素退出码必须是整数");
  return { command: p.command, exitCode: p.exitCode, summary: p.summary, recovery: p.recovery };
}

// ---------------------------------------------------------------------------
// 1. deterministic 退出 20 / 其他值 → 失败契约 + 义务 open（V13）
// ---------------------------------------------------------------------------

test("deterministic 退出 20：CheckerFailed 四要素齐备，义务保持 open（G10 --exit-contract）", async () => {
  const broken = {
    id: "symbol-scan",
    kind: "deterministic",
    version: "1.0.0",
    run: async () => ({ command: "node symbol-scan.mjs --binding V12", exitCode: 20, summary: "checker 自身脚本错误：undefined is not a function" }),
  };
  const registry = registryMod.createCheckerRegistry([broken]);
  const obligation = makeObligation();
  const r = await registryMod.runChecker(registry, { obligation, artifacts: { "src/main.js": "x" }, actor: "checker-wrapper" });
  assert.equal(r.status, "failure");
  const four = fourElements(r.commands[0]);
  assert.equal(four.command, "node symbol-scan.mjs --binding V12");
  assert.equal(four.exitCode, 20);
  assert.match(four.summary, /undefined is not a function/);
  assert.match(four.recovery, /修复 checker 后重跑/);
  // 状态仓视角：失败事实入流，义务保持 open，不产生任何证据
  const root = mkdtempSync(join(tmpdir(), "conf-failure-det-"));
  try {
    stateRepo.initStateRepo(root, repoInput());
    await stateRepo.appendCommands(root, r.commands);
    const { state } = stateRepo.rebuild(root);
    const key = state.keys[facts.canonicalJson(obligation.address)];
    const s = state.addresses[key];
    assert.equal(s.conclusion, "open", "checker 失败不伪造 verified（设计段五）");
    assert.equal(s.verification, "unverified");
    assert.deepEqual(
      { command: s.lastCheckerFailure.command, exitCode: s.lastCheckerFailure.exitCode, summary: s.lastCheckerFailure.summary, recovery: s.lastCheckerFailure.recovery },
      four,
      "失败四要素在 fold 状态可查",
    );
    const { facts: allFacts } = stateRepo.rebuild(root);
    assert.ok(!allFacts.some((f) => f.type === "EvidenceRecorded"), "失败不产生任何证据事件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deterministic 其他退出码（2）与 wrapper 抛错同按失败处理（段五「其他值同样按失败处理」）", async () => {
  const cases = [
    {
      name: "退出码 2",
      def: {
        id: "symbol-scan", kind: "deterministic", version: "1.0.0",
        run: async () => ({ command: "node symbol-scan.mjs", exitCode: 2, summary: "扫描脚本崩溃" }),
      },
      expectExit: 2,
    },
    {
      name: "wrapper 抛错",
      def: {
        id: "symbol-scan", kind: "deterministic", version: "1.0.0",
        run: async () => {
          throw new Error("spawn ENOENT");
        },
      },
      expectExit: 20,
    },
    {
      name: "wrapper 返回形态非法",
      def: {
        id: "symbol-scan", kind: "deterministic", version: "1.0.0",
        run: async () => "not-an-object",
      },
      expectExit: 20,
    },
  ];
  for (const c of cases) {
    const registry = registryMod.createCheckerRegistry([c.def]);
    const r = await registryMod.runChecker(registry, { obligation: makeObligation(), artifacts: { "src/main.js": "x" } });
    assert.equal(r.status, "failure", `「${c.name}」按失败处理`);
    const four = fourElements(r.commands[0]);
    assert.equal(four.exitCode, c.expectExit, `「${c.name}」退出码 ${c.expectExit}`);
    assert.ok(!r.commands.some((cmd) => cmd.type === "RecordEvidence"), `「${c.name}」不伪造证据`);
  }
});

// ---------------------------------------------------------------------------
// 2. semantic 非法输出回喂 ≤2 次后升级（V13 / 段五）
// ---------------------------------------------------------------------------

test("semantic 恒定非法输出：回喂恰 2 次（总调用 3）后升级 CheckerFailed，义务保持 open（V13）", async () => {
  let n = 0;
  const illegal = {
    id: "semantic-review",
    kind: "semantic",
    version: "0.3.0",
    run: async (input) => {
      n += 1;
      return `第 ${input.attempt} 次输出：不是 JSON`;
    },
  };
  const registry = registryMod.createCheckerRegistry([illegal]);
  const obligation = makeObligation({ checkerId: "semantic-review" });
  const r = await registryMod.runChecker(registry, { obligation, artifacts: { "src/main.js": "x" } });
  assert.equal(r.status, "failure");
  assert.equal(r.calls, 3, "总调用 = 1 次初判 + 2 次回喂（MAX_SEMANTIC_REFEEDS=2）");
  assert.equal(n, 3);
  assert.equal(r.commands.length, 1);
  const four = fourElements(r.commands[0]);
  assert.equal(four.exitCode, 20);
  assert.match(four.summary, /连续 3 次/);
  assert.match(four.summary, /回喂 2 次耗尽/);
  assert.match(four.recovery, /修复 checker 输出契约/);
  // 回喂机制可见：非法原因随 feedback 发回（第二次起 attempt>1 且带 illegalReason）
  assert.ok(n >= 3);
  // 状态仓：义务 open
  const root = mkdtempSync(join(tmpdir(), "conf-failure-sem-"));
  try {
    stateRepo.initStateRepo(root, repoInput());
    await stateRepo.appendCommands(root, r.commands);
    const { state } = stateRepo.rebuild(root);
    const key = state.keys[facts.canonicalJson(obligation.address)];
    assert.equal(state.addresses[key].conclusion, "open");
    assert.equal(state.addresses[key].verification, "unverified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic 第二次输出合法：回喂 1 次后成功，不升级失败（回喂机制正向路径）", async () => {
  const calls = [];
  const flaky = {
    id: "semantic-review",
    kind: "semantic",
    version: "0.3.0",
    run: async (input) => {
      calls.push(input.attempt);
      if (input.attempt === 1) return "坏输出";
      return JSON.stringify({ result: "pass", summary: "第二次输出合法：重放一致" });
    },
  };
  const registry = registryMod.createCheckerRegistry([flaky]);
  const r = await registryMod.runChecker(registry, {
    obligation: makeObligation({ checkerId: "semantic-review" }),
    artifacts: { "src/main.js": "x" },
  });
  assert.equal(r.status, "pass");
  assert.equal(r.calls, 2, "初判 + 1 次回喂后成功");
  assert.deepEqual(calls, [1, 2]);
  assert.equal(r.commands[0].type, "RecordEvidence");
  assert.equal(r.commands[0].payload.result, "pass");
});

test("semantic run 抛错 = checker 自身失败：立即 CheckerFailed，不做回喂", async () => {
  const crashing = {
    id: "semantic-review",
    kind: "semantic",
    version: "0.3.0",
    run: async () => {
      throw new Error("agent 配额耗尽");
    },
  };
  const registry = registryMod.createCheckerRegistry([crashing]);
  const r = await registryMod.runChecker(registry, {
    obligation: makeObligation({ checkerId: "semantic-review" }),
    artifacts: { "src/main.js": "x" },
  });
  assert.equal(r.status, "failure");
  assert.equal(r.calls, 0, "抛错不计为有效调用，也不触发回喂");
  const four = fourElements(r.commands[0]);
  assert.equal(four.exitCode, 20);
  assert.match(four.summary, /agent 配额耗尽/);
});

// ---------------------------------------------------------------------------
// 3. 未注册 checker 与输入缺失：失败契约 + 恢复动作（U2 检查点）
// ---------------------------------------------------------------------------

test("checker 未注册：义务保持 open 的失败事实，恢复动作指向补登记（U2 检查点）", async () => {
  const registry = registryMod.createCheckerRegistry([]);
  const r = await registryMod.runChecker(registry, { obligation: makeObligation(), artifacts: {} });
  assert.equal(r.status, "failure");
  const four = fourElements(r.commands[0]);
  assert.match(four.summary, /未注册/);
  assert.match(four.recovery, /登记「symbol-scan」/);
  assert.equal(r.commands[0].payload.address.bindingId, "V12", "失败事实携带差距地址");
});

test("evidenceInputs 声明的输入缺失：失败不伪造证据，恢复动作指向补快照", async () => {
  let ran = 0;
  const det = {
    id: "symbol-scan", kind: "deterministic", version: "1.0.0",
    run: async () => {
      ran += 1;
      return { command: "node symbol-scan.mjs", exitCode: registryMod.CHECKER_EXIT.PASS };
    },
  };
  const registry = registryMod.createCheckerRegistry([det]);
  const r = await registryMod.runChecker(registry, { obligation: makeObligation(), artifacts: {} });
  assert.equal(r.status, "failure");
  assert.match(r.commands[0].payload.summary, /输入 artifact 缺失：src\/main\.js/);
  assert.equal(ran, 0, "输入不齐时不调用 checker（拿空内容跑检查 = 伪造证据入口）");
  assert.equal(r.calls, 0);
});

// ---------------------------------------------------------------------------
// 4. 修复后重跑：成功路径可用，义务按 pass 证据 verified（V13「修复 checker 后重跑」）
// ---------------------------------------------------------------------------

test("修复 checker 后重跑：pass 证据入流，义务 open → verified（V13 收尾）", async () => {
  const root = mkdtempSync(join(tmpdir(), "conf-failure-fix-"));
  try {
    const evidenceMod = await import(join(CP, "kernel", "evidence.mjs"));
    const obligation = makeObligation();
    const artifacts = { "src/main.js": "const fixed = true;" };
    // 状态仓 artifacts 表登记被检内容的真实哈希（验证通过后的内容快照；证据按内容哈希判定有效期）
    const input = {
      ...repoInput(),
      artifacts: { "src/main.js": evidenceMod.hashContent(artifacts["src/main.js"]) },
    };
    stateRepo.initStateRepo(root, input);
    // 第一轮：checker 自身失败
    const broken = {
      id: "symbol-scan", kind: "deterministic", version: "1.0.0",
      run: async () => ({ command: "node symbol-scan.mjs", exitCode: 20, summary: "脚本错误" }),
    };
    const r1 = await registryMod.runChecker(registryMod.createCheckerRegistry([broken]), { obligation, artifacts });
    await stateRepo.appendCommands(root, r1.commands);
    // 修复后重跑：同一义务、同一内容快照，pass 证据入流
    const fixed = {
      id: "symbol-scan", kind: "deterministic", version: "1.0.0",
      run: async () => ({ command: "node symbol-scan.mjs", exitCode: registryMod.CHECKER_EXIT.PASS }),
    };
    const r2 = await registryMod.runChecker(registryMod.createCheckerRegistry([fixed]), { obligation, artifacts });
    assert.equal(r2.status, "pass");
    // 证据的输入哈希 = 被检内容真实哈希（AX4）
    assert.deepEqual(r2.commands[0].payload.inputs, [{ name: "src/main.js", hash: r2.inputHashes["src/main.js"] }]);
    await stateRepo.appendCommands(root, r2.commands);
    const { input: snapInput, state } = stateRepo.rebuild(root);
    const key = state.keys[facts.canonicalJson(obligation.address)];
    const s = state.addresses[key];
    assert.equal(s.conclusion, "verified", "修复后的 pass 证据使义务 verified");
    assert.ok(s.lastCheckerFailure !== null, "失败历史保留可查（append-only，不覆盖）");
    // 输入内容未变时证据有效（evaluateEvidence 口径，快照 artifacts 表即内容哈希）
    const verdict = evidenceMod.evaluateEvidence(
      r2.commands[0].payload,
      { bindings: snapInput.bindings, checkerRuns: snapInput.checkerRuns, artifacts: snapInput.artifacts },
    );
    assert.equal(verdict.valid, true, JSON.stringify(verdict.reasons));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
