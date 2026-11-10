// golden-corpus.test.mjs — 两个真实设计包最小化重放夹具的性质测试（sync-conformance-plane U1/M1）
//
// 覆盖（守护与场景编号属本设计包 sync-conformance-plane，编号裸用）：
//   - V11 / G8 --two-real-packages / RL8：夹具经 fake-agent 模拟器回放（不调真实模型），
//     两条性质落断言——结论单调（事件流只追加时历史 seq 的状态重放不变）与无孤儿证据
//     （每条证据引用的 binding/repo/checker run/changeset 均存在）
//   - V2 精神（thesis-contract）：旧 ledger 同一 F2-1 的两条不同义务映射后地址分离、重放稳定
//   - HEAD 误判场景（opendesign round-3）：证据有效性只绑定工作区内容哈希，HEAD 指针变化不进入证据判定
//
// 运行：node --test scripts/tests/golden-corpus.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CP = join(ROOT, "skills", "self", "dev-workflow", "conformance-plane");
const CORPUS = join(CP, "test-base", "golden-corpus");

const facts = await import(join(CP, "kernel", "facts.mjs"));
const { fold, findOrphanEvidence } = await import(join(CP, "kernel", "state-fold.mjs"));
const { createSimulator } = await import(join(CP, "test-base", "fake-agent-simulator.mjs"));

function loadFixture(name) {
  return JSON.parse(readFileSync(join(CORPUS, name), "utf8"));
}

/** 模拟器按夹具脚本回放出事实序列（命令 → 分配 seq/ts → schema 校验） */
function replay(fix) {
  const sim = createSimulator(fix.script);
  const commands = sim.run().commands;
  const factsList = commands.map((cmd, i) =>
    facts.commandToFact(cmd, { seq: i + 1, ts: `2026-11-09T12:0${i % 10}:00.000Z` }),
  );
  for (const f of factsList) {
    const ok = facts.validateFact(f);
    assert.ok(ok.ok, `夹具 ${fix.packageId} 事实 ${f.type}#${f.seq} 必须过 schema：${JSON.stringify(ok.errors)}`);
  }
  return { sim, factsList };
}

function foldInput(fix, factsList) {
  return { ...fix.input, facts: factsList };
}

function addrKey(address) {
  return `${address.bindingId}|${address.repoId}|${address.violationKind}`;
}

function conclusionsOf(state) {
  const out = {};
  for (const [key, addr] of Object.entries(state.addresses)) out[key] = addr.conclusion;
  return out;
}

// ---------------------------------------------------------------------------
// 夹具契约
// ---------------------------------------------------------------------------

test("manifest 登记两个真实设计包夹具且夹具文件齐全", () => {
  const manifest = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"));
  assert.equal(manifest.packages.length, 2, "V11：golden corpus 必须是两个真实设计包");
  for (const p of manifest.packages) {
    const fix = loadFixture(p.fixture);
    assert.equal(fix.packageId, p.packageId);
    assert.ok(fix.source.runDir.endsWith(".sync"), "来源必须登记 dev-flow 段 runDir 形态");
    assert.ok(fix.input.bindings.length >= 1 && fix.script.length >= 3, "夹具必须含绑定与事件脚本");
  }
});

// ---------------------------------------------------------------------------
// 两性质：结论单调 + 无孤儿证据（V11 / G8 / RL8）
// ---------------------------------------------------------------------------

for (const fixtureName of ["thesis-contract.json", "opendesign-assets-quality.json"]) {
  test(`[${fixtureName}] 结论单调：事件流只追加时历史 seq 的状态重放不变（V11 性质一）`, () => {
    const fix = loadFixture(fixtureName);
    const { factsList } = replay(fix);
    const input = foldInput(fix, factsList);

    // 全量重放确定：两次 fold 逐字节相等
    assert.equal(JSON.stringify(fold({ ...input, facts: factsList })), JSON.stringify(fold({ ...input, facts: [...factsList] })));

    // 结论轨迹：对每个前缀 seq 独立重放，历史结论不因后续追加而漂移
    // （轨迹从 n=1 起：n=0 时无任何事实，地址集为空）
    const trajectory = {}; // addrKey -> [conclusion@1, conclusion@2, ...]
    for (let n = 1; n <= factsList.length; n++) {
      const state = fold({ ...input, facts: factsList.slice(0, n) });
      for (const [key, addr] of Object.entries(state.addresses)) {
        (trajectory[key] ??= [])[n] = addr.conclusion;
      }
    }
    for (const [key, traj] of Object.entries(trajectory)) {
      for (let n = 1; n <= factsList.length; n++) {
        assert.equal(
          traj[n],
          fold({ ...input, facts: factsList.slice(0, n) }).addresses[key]?.conclusion,
          `前缀 ${n} 的 ${key} 结论必须可独立重放复现（结论单调的定义）`,
        );
      }
      // 变化点必须由涉及该地址的事实引起：无新事件时结论不变
      for (let n = 2; n <= factsList.length; n++) {
        if (traj[n] !== traj[n - 1]) {
          const f = factsList[n - 1];
          const touches =
            (f.address && addrKey(f.address) === key) ||
            (!f.address && f.repoId && key.includes(`|${f.repoId}|`)) ||
            f.type === "Unarchived";
          assert.ok(touches, `${key} 在 seq ${n} 的结论变化必须由涉及它的事实引起（实际事实：${f.type}）`);
        }
      }
    }
  });

  test(`[${fixtureName}] 无孤儿证据：每条证据引用的 binding/repo/checker run/changeset 均存在（V11 性质二）`, () => {
    const fix = loadFixture(fixtureName);
    const { factsList } = replay(fix);
    const orphans = findOrphanEvidence(foldInput(fix, factsList));
    assert.deepEqual(orphans, [], `夹具必须零孤儿引用：${JSON.stringify(orphans)}`);
  });

  test(`[${fixtureName}] 终态结论与夹具 expectations 一致且地址分离`, () => {
    const fix = loadFixture(fixtureName);
    const { factsList } = replay(fix);
    const state = fold(foldInput(fix, factsList));
    assert.deepEqual(conclusionsOf(state), fix.expectations.finalConclusions);
    assert.deepEqual(
      Object.keys(state.addresses).sort(),
      [...fix.expectations.distinctAddresses].sort(),
      "派生地址集必须与夹具声明的分离地址集恰等",
    );
  });
}

// ---------------------------------------------------------------------------
// 包特定链路
// ---------------------------------------------------------------------------

test("[thesis-contract] 旧 ledger 同一 F2-1 的两条不同义务：映射后地址分离且互不污染（V2）", () => {
  const fix = loadFixture("thesis-contract.json");
  const { factsList } = replay(fix);
  const state = fold(foldInput(fix, factsList));
  const keys = Object.keys(state.addresses);
  assert.equal(keys.filter((k) => k.startsWith("F2-1")).length, 2, "同一旧 id 的两条义务必须派生两个地址");
  const doc = state.addresses["F2-1|stock-docs|documentation-mismatch"];
  const impl = state.addresses["F2-1-data-as-of|stock-plugins|missing-implementation"];
  assert.equal(doc.conclusion, "pending-integration", "doc 义务已验证、变更集就绪待集成（真实包 stuck 终态）");
  assert.equal(impl.conclusion, "pending-integration");
  // 互不污染：impl 地址的裁决与失败事实不出现在 doc 地址状态里
  assert.equal(doc.awaitingRuling, false);
  assert.equal(doc.lastCheckerFailure, null);
  assert.ok(impl.lastCheckerFailure, "impl 地址必须保留 CheckerFailed 失败事实可查");
});

test("[opendesign] HEAD 误判场景：证据有效性只绑工作区内容哈希，HEAD 指针变化不进入判定", () => {
  const fix = loadFixture("opendesign-assets-quality.json");
  const { factsList } = replay(fix);
  // 证据结构中不存在 HEAD 引用：全部 inputs 的 name 都是工作区文件路径
  for (const f of factsList.filter((x) => x.type === "EvidenceRecorded")) {
    for (const input of f.inputs) {
      assert.ok(!/^(HEAD|head|ref|commit)/i.test(input.name), `证据输入不得绑定 HEAD 指针：${input.name}`);
    }
  }
  // 工作区内容不变时，即使 fold 输入新增/篡改 HEAD 指针哈希，证据仍有效、结论不变
  const input = { ...foldInput(fix, factsList), artifacts: { ...fix.input.artifacts, "HEAD:main": "eeee" } };
  const withHead = fold(input);
  const withoutHead = fold(foldInput(fix, factsList));
  assert.deepEqual(conclusionsOf(withHead), conclusionsOf(withoutHead), "HEAD 指针变化不得影响任何地址结论");
  // 反向：工作区内容被改（同哈希表键值变化）才触发失效回 open
  const changedWorktree = fold({
    ...foldInput(fix, factsList),
    artifacts: { ...fix.input.artifacts, "taiji-host/src/quality-loop.js": "ffff" },
  });
  const f31 = changedWorktree.addresses["F3-1|taiji-host|missing-implementation"];
  assert.equal(f31.conclusion, "open", "工作区内容变化必须让旧证据失效、义务回 open");
  assert.ok(f31.evidence.reasons.length > 0, "失效原因必须可查");
});

test("模拟器按脚本回放且无真实模型调用面：重复回放产出逐字节相同", () => {
  const fix = loadFixture("thesis-contract.json");
  const sim1 = createSimulator(fix.script).run();
  const sim2 = createSimulator(fix.script).run();
  assert.deepEqual(sim1.commands, sim2.commands, "脚本化回放必须确定");
  assert.deepEqual(
    sim1.calls.map((c) => c.role),
    fix.script.map((s) => s.role),
    "调用轨迹必须逐角色对齐脚本",
  );
});
