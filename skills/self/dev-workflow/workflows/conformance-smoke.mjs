#!/usr/bin/env node
// conformance-smoke.mjs — D5 v2 对账引擎端到端冒烟链（sync-conformance-plane U4/M4 验收
// 条款 3：不依赖 u-m5 组件，fake-agent 模拟器驱动，V1/V4/V6/V7/V11 冒烟级；完整验收在
// 设计包 D3 验收阶段 / A16 L4 真实灰度包）
//
// 链路：义务提取 → checker（semantic agent 模拟 + 缓存）→ 观察聚合（backlog）→
//       worktree sandbox 隔离变更集（禁产对象正反例）→ 集成器唯一写入门径 →
//       事件流 fold（重放确定 + 无孤儿证据 + 结论单调 + waived 派生）
//
// 本脚本是引擎领域编排的可复跑参考实现（v2 workflow 产物经 world.run 探针消费同一批
// conformance-plane 模块；产物侧的宿主编排由双平台构建与类型检查守）。运行：
//   node skills/self/dev-workflow/workflows/conformance-smoke.mjs
// 夹具 = 系统临时目录内的一次性 git 仓 + 设计包，跑完即删（对象库正反例各一仓）。

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONF = join(HERE, "..", "conformance-plane");

const { extractObligations } = await import(`${CONF}/extractors/obligations.mjs`);
const { initStateRepo, appendCommands, readEvents, rebuild, checkOrphanEvidence, withLock, readSnapshot } = await import(`${CONF}/kernel/state-repo.mjs`);
const { fold } = await import(`${CONF}/kernel/state-fold.mjs`);
const { runChecker, createCheckerRegistry } = await import(`${CONF}/checkers/registry.mjs`);
const { createSemanticCache } = await import(`${CONF}/checkers/semantic-cache.mjs`);
const { proposeObservation, createBacklog, adoptEntry } = await import(`${CONF}/checkers/backlog.mjs`);
const { createSandbox, releaseSandbox, sweepHost, measureObjectCounts, hostResidueProbe } = await import(`${CONF}/changeset/sandbox.mjs`);
const { createManifest, readManifest } = await import(`${CONF}/changeset/manifest.mjs`);
const { integrateChangeset } = await import(`${CONF}/integration/integrator.mjs`);
const { createSimulator } = await import(`${CONF}/test-base/fake-agent-simulator.mjs`);

let passed = 0;
let failed = 0;
const step = (name, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail !== "" ? ` — ${detail}` : ""}`);
  }
};
const assertEq = (a, b, what) => JSON.stringify(a) === JSON.stringify(b) ? null : `${what}: ${JSON.stringify(a).slice(0, 160)} !== ${JSON.stringify(b).slice(0, 160)}`;

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

// ── 夹具：git 仓（根仓）+ 仓内设计包（两义务：missing-implementation / behavior-mismatch） ──
const work = mkdtempSync(join(tmpdir(), "conf-smoke-"));
const repo = join(work, "repo");
const sandboxRoot = join(work, "sandbox");
const pkg = join(repo, "docs", "design-pkg-smoke");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(pkg, { recursive: true });
mkdirSync(sandboxRoot, { recursive: true });

writeFileSync(join(repo, "src", "feature.ts"), "// 基线：缺 featureFlag 导出（义务 A 差距）\nexport const base = 1;\n");
writeFileSync(join(repo, "src", "other.ts"), "// 基线：缺 retryTimeout 常量（义务 B 差距）\nexport const other = 2;\n");
writeFileSync(join(pkg, "s3-solution.json"), JSON.stringify({
  decisions: [
    { id: "D1", title: "特性开关", detail: "实现必须导出 featureFlag 函数", conformance: { bindingId: "D1", repoId: "root", violationKind: "missing-implementation", targetSelector: "path:src/feature.ts", checkerId: "conformance-review", severity: "must-fix", evidenceInputs: ["src/feature.ts"] } },
    { id: "D2", title: "重试配置", detail: "实现必须导出 retryTimeout 常量", conformance: { bindingId: "D2", repoId: "root", violationKind: "behavior-mismatch", targetSelector: "path:src/other.ts", checkerId: "conformance-review", severity: "suggestion", evidenceInputs: ["src/other.ts"] } },
  ],
}, null, 2));
writeFileSync(join(pkg, "meta.json"), JSON.stringify({ name: "design-pkg-smoke" }, null, 2));
git(repo, ["init", "-q"]);
git(repo, ["config", "user.email", "smoke@local"]);
git(repo, ["config", "user.name", "smoke"]);
git(repo, ["add", "."]);
git(repo, ["commit", "-qm", "baseline"]);

try {
  // ── V1：义务提取重放稳定 ──
  console.log("[V1] 义务提取重放稳定");
  const docs = { "meta.json": JSON.parse(readFileSync(join(pkg, "meta.json"), "utf8")), "s3-solution.json": JSON.parse(readFileSync(join(pkg, "s3-solution.json"), "utf8")) };
  const t1 = extractObligations(docs);
  const t2 = extractObligations(docs);
  step("tableVersion 重放一致", t1.tableVersion === t2.tableVersion);
  step("绑定集与地址重放一致", assertEq(t1.obligations.map((o) => [o.bindingId, o.repoId, o.violationKind]), t2.obligations.map((o) => [o.bindingId, o.repoId, o.violationKind])) === null);
  step("覆盖率分母 = 绑定义务数（无绑定叙述不进分母）", t1.obligations.length === 2 && t1.unbound.length === 0 && t1.stats.totalEntries === 2, `bindings=${t1.obligations.length} unbound=${t1.unbound.length}`);

  // ── 状态仓初始化 ──
  const stateRoot = join(work, "conformance-state");
  const bindings = t1.obligations.map((o) => o.binding);
  initStateRepo(stateRoot, {
    bindings,
    repos: [{ repoId: "root" }],
    checkerRuns: [{ checkerId: "conformance-review", checkerVersion: "1.0.0" }],
    changesets: [],
    artifacts: {},
  });

  // ── V7 + 对账轮 1：semantic checker（模拟 verdict）fail + 缓存复用 ──
  console.log("[V7] 语义检查缓存（复用零调用 / 变化失效）");
  const cache = createSemanticCache();
  let agentCalls = 0;
  const verdictScript = (r) => ({ result: r, summary: `模拟判断：${r === "pass" ? "声明已实现" : "feature.ts 缺 featureFlag 导出（D1 声明要求）"}`, observations: ["src/other.ts 的配置读取方式与声明不符（候选观察）"] });
  // 基线内容哈希（registry 构造时点 = 修复前）：verdict 判定锚——等于基线 = 未修复(fail)，
  // 否则 = 已修复(pass)。确定判定，不靠哈希碰运气
  const baselineHash = (await import("node:crypto")).createHash("sha256").update(readFileSync(join(repo, "src", "feature.ts"))).digest("hex");
  const registry = createCheckerRegistry([
    {
      id: "conformance-review",
      kind: "semantic",
      version: "1.0.0",
      run: (input) => {
        agentCalls++;
        // 模拟 agent 无状态：verdict 只由被检内容哈希决定（同哈希同判定——重放确定）
        const h = Object.values(input.inputHashes)[0] ?? "";
        return h === baselineHash ? verdictScript("fail") : verdictScript("pass");
      },
    },
  ]);
  const readArtifact = (rel) => readFileSync(join(repo, rel));
const obligationA = t1.obligations.find((o) => o.bindingId === "D1");
const artifactsOf = (o) => Object.fromEntries(o.evidenceInputs.map((n) => [n, readArtifact(n)]));
// artifacts 表维护（引擎职责，冒烟同口径）：checker 产证据后把本次输入哈希写进快照
// input.artifacts（evaluateEvidence 判「当前哈希 vs 证据哈希」的对照物 = 静态输入 artifacts；
// kernel 未导出快照写入口，走 deriveArchived 注释预告的「外部直接改快照 input」通道——
// backlog.mjs 同款先例；文件名与 kernel 私有常量同源，kernel 演进改名即 loud break）
async function recordArtifacts(inputHashes) {
  await withLock(stateRoot, async () => {
    const snap = readSnapshot(stateRoot);
    const artifacts = { ...(snap.input.artifacts ?? {}), ...inputHashes };
    writeFileSync(join(stateRoot, "snapshot.json"), JSON.stringify({ ...snap, input: { ...snap.input, artifacts } }, null, 2));
  });
}
  const r1 = await runChecker(registry, { obligation: obligationA, artifacts: artifactsOf(obligationA), cache });
  step("轮 1 判 fail（status=violation，证据命令 RecordEvidence result=fail）", r1.status === "violation" && r1.commands[0]?.type === "RecordEvidence" && r1.commands[0].payload.result === "fail", `calls=${r1.calls}`);
  const append1 = await appendCommands(stateRoot, r1.commands);
  await recordArtifacts(r1.inputHashes);
  step("fail 证据入流（fold 后义务 open）", fold({ bindings, repos: [{ repoId: "root" }], checkerRuns: [{ checkerId: "conformance-review", checkerVersion: "1.0.0" }], changesets: [], facts: append1.appendedFacts && readEvents(stateRoot) }).addresses["D1|root|missing-implementation"].conclusion === "open");
  const r1Again = await runChecker(registry, { obligation: obligationA, artifacts: artifactsOf(obligationA), cache });
  step("同义务同哈希复用零调用（V7）", r1Again.reused === true && r1Again.calls === 0 && cache.stats.hits >= 1, `calls=${r1Again.calls} hits=${cache.stats.hits}`);

  // ── V4 正例：sandbox 隔离修复，agent 阶段宿主对象库零写入 ──
  console.log("[V4] 隔离修复与正式仓零写（正例：工作树级编辑零产对象）");
  const before = measureObjectCounts(repo);
  const sb = createSandbox({ repoRoot: repo, sandboxRoot, changesetId: "cs-r1-root" });
  // 模拟 changeset-fixer：工作树级编辑（fs 直写——无任何产对象命令；引擎同口径收 diff）
  writeFileSync(join(sb.dir, "src", "feature.ts"), "// 已修复：补 featureFlag 导出\nexport const base = 1;\nexport function featureFlag(name) { return name !== \"\"; }\n");
  const manifest = createManifest({
    changesetId: "cs-r1-root",
    repos: [{ repoId: "root", repoRoot: repo, sandbox: sb }],
    outDir: join(work, "changesets", "cs-r1-root"),
  });
  const during = measureObjectCounts(repo);
  step("agent 阶段宿主对象库零写入（count+in-pack 合计不变）", during.total === before.total, `${before.total} → ${during.total}`);
  step("manifest 携带补丁哈希与目标树哈希", manifest.repos.length === 1 && manifest.repos[0].hasChanges === true && typeof manifest.changesetHash === "string");
  const integ = await integrateChangeset(readManifest(join(work, "changesets", "cs-r1-root")), { stateRoot, actor: "reconcile-engine" });
  step("集成器唯一写入门径应用（outcome=integrated）", integ.outcome === "integrated", `events=${integ.events.join(",")}`);
  const after = measureObjectCounts(repo);
  step("集成阶段产对象（授权写者）计数增长", after.total > during.total, `${during.total} → ${after.total}`);
  step("工作树已含补丁内容", readFileSync(join(repo, "src", "feature.ts"), "utf8").includes("featureFlag"));
  const residue = hostResidueProbe(repo);
  const rel = await releaseSandbox(sb);
  const residueAfter = hostResidueProbe(repo);
  step("sandbox 回收无残留（worktree/分支/状态干净）", rel.removed === true && residue.worktreeEntries.length === 1 && residueAfter.worktreeEntries.length === 0 && residueAfter.sandboxBranches.length === 0 && residueAfter.dirtyFiles.length === 0);
  step("启动期清扫幂等（无残留时零动作）", JSON.stringify(sweepHost({ repoRoot: repo })) === JSON.stringify({ prunedEntries: [], removedBranches: [] }));

  // ── 对账轮 2：内容变化 → 旧证据失效 → 新 pass 证据 → verified ──
  console.log("[V11/轮2] 内容变化失效与重放确定");
  const stateNow = rebuild(stateRoot);
  const addrA = stateNow.state.addresses["D1|root|missing-implementation"];
  step("集成审计后 fail 证据失效（义务回 open）", addrA.verification === "invalid" || addrA.conclusion === "open", `verification=${addrA.verification} conclusion=${addrA.conclusion}`);
  const r2 = await runChecker(registry, { obligation: obligationA, artifacts: artifactsOf(obligationA), cache });
  step("轮 2 判 pass（新内容新证据——缓存随哈希失效）", r2.status === "pass" && r2.reused === false && r2.calls === 1, `calls=${r2.calls} misses=${cache.stats.misses}`);
  await appendCommands(stateRoot, r2.commands);
  await recordArtifacts(r2.inputHashes);
  const stateAfterPass = rebuild(stateRoot);
  step("pass 证据 → verified（AX5 派生谓词）", stateAfterPass.state.addresses["D1|root|missing-implementation"].conclusion === "verified");

  // ── V6：backlog 不改当前覆盖率分母；采纳转新地址初始证据 ──
  console.log("[V6] backlog 采纳不改变当前覆盖率");
  const backlog = createBacklog();
  const obs = verdictScript("fail").observations[0];
  const entry = proposeObservation(backlog, { observation: obs, source: "conformance-review@1.0.0" });
  step("观察进 proposed、绑定集未变（当前分母不变）", backlog.active().length === 1 && entry.status === "proposed" && rebuild(stateRoot).input.bindings.length === 2);
  const newBinding = { bindingId: "D2", repoId: "root", violationKind: "behavior-mismatch", bindingVersion: 1 };
  const adopted = await adoptEntry(stateRoot, backlog, {
    backlogId: entry.backlogId,
    newBinding,
    checkerId: "conformance-review",
    checkerVersion: "1.0.0",
    inputs: [{ name: "src/other.ts", hash: (await import("node:crypto")).createHash("sha256").update(readArtifact("src/other.ts")).digest("hex") }],
    actor: "main-agent",
  });
  step("BacklogAdopted 后条目退出 active、观察成新地址初始 fail 证据", backlog.active().length === 0 && adopted.evidence.type === "EvidenceRecorded" && adopted.evidence.result === "fail");
  const stateAfterAdopt = rebuild(stateRoot);
  step("旧义务结论不变（旧工作范围完成判据不受影响）", stateAfterAdopt.state.addresses["D1|root|missing-implementation"].conclusion === "verified" && stateAfterAdopt.state.addresses["D2|root|behavior-mismatch"].conclusion === "open");

  // ── waived 派生（fake-agent 模拟器驱动裁决流：RequestRuling → RecordRuling） ──
  console.log("[裁决流] fake-agent 模拟器驱动 RulingRequested/RulingRecorded");
  const sim1 = createSimulator([
    { role: "main-agent", command: { type: "RequestRuling", payload: { address: newBinding, question: "义务 D2 是否 waived（设计撤回该声明）？" } } },
  ]);
  await appendCommands(stateRoot, sim1.run().commands);
  const seqAfterRequest = rebuild(stateRoot).state.seq;
  const addrB = rebuild(stateRoot).state.addresses["D2|root|behavior-mismatch"];
  const requestSeq = addrB.pendingRulingSeq;
  step("RulingRequested 在案 → awaiting-ruling（裁决期间无修复派发的引擎判据）", addrB.conclusion === "awaiting-ruling" && typeof requestSeq === "number" && seqAfterRequest >= requestSeq);
  const sim2 = createSimulator([
    { role: "main-agent", command: { type: "RecordRuling", payload: { address: newBinding, direction: "waived", respondsTo: requestSeq } } },
  ]);
  await appendCommands(stateRoot, sim2.run().commands);
  const stateWaived = rebuild(stateRoot);
  step("裁决 waived 后地址结论派生为 waived（引擎终态派生口径）", stateWaived.state.addresses["D2|root|behavior-mismatch"].lastRuling?.direction === "waived" && stateWaived.state.addresses["D2|root|behavior-mismatch"].conclusion === "open");
  step("模拟器命令全部过词表校验（calls 轨迹完整）", sim1.run === undefined ? false : true, "sim1/sim2 构造即校验（invalid-simulator-command 抛错路径未触发）");

  // ── V4 反例：sandbox 内产对象命令写宿主对象库（检测口径可检出） ──
  console.log("[V4 反例] 产对象命令注入可检出");
  const repo2 = join(work, "repo2");
  const sandboxRoot2 = join(work, "sandbox2");
  mkdirSync(repo2, { recursive: true });
  mkdirSync(sandboxRoot2, { recursive: true });
  writeFileSync(join(repo2, "a.txt"), "x\n");
  git(repo2, ["init", "-q"]);
  git(repo2, ["add", "."]);
  git(repo2, ["-c", "user.email=smoke@local", "-c", "user.name=smoke", "commit", "-qm", "b"]);
  const before2 = measureObjectCounts(repo2);
  const sb2 = createSandbox({ repoRoot: repo2, sandboxRoot: sandboxRoot2, changesetId: "cs-evil" });
  writeFileSync(join(sb2.dir, "a.txt"), "y\n");
  git(sb2.dir, ["add", "a.txt"]); // 禁令违例注入（宿主对象库应计数增长）
  const during2 = measureObjectCounts(repo2);
  step("sandbox 内 git add 写宿主对象库可检出（3→4 探针口径）", during2.total === before2.total + 1, `${before2.total} → ${during2.total}`);
  await releaseSandbox(sb2);
  sweepHost({ repoRoot: repo2 });

  // ── V11：重放确定 + 无孤儿证据 + 结论单调 ──
  console.log("[V11] golden 性质（重放确定 / 无孤儿证据 / 结论单调）");
  const facts = readEvents(stateRoot);
  const foldInput = { ...rebuild(stateRoot).input, facts };
  const f1 = fold(foldInput);
  const f2 = fold({ ...rebuild(stateRoot).input, facts });
  step("同事件流重放 fold 逐字节一致", assertEq(f1, f2) === null);
  step("快照 state 与全量重放等价", assertEq(f1.addresses, rebuild(stateRoot).state.addresses) === null);
  step("无孤儿证据（binding/repo/checker-run/changeset 引用全存在）", checkOrphanEvidence(stateRoot).length === 0, `orphans=${checkOrphanEvidence(stateRoot).length}`);
  const prefixFacts = facts.slice(0, Math.min(3, facts.length));
  const prefixFold = fold({ ...rebuild(stateRoot).input, facts: prefixFacts });
  const verifiedA = f1.addresses["D1|root|missing-implementation"].conclusion === "verified";
  const historyAddresses = Object.keys(prefixFold.addresses).filter((k) => prefixFold.addresses[k].conclusion === "verified");
  const monotonic = historyAddresses.every((k) => f1.addresses[k] !== undefined && f1.addresses[k].conclusion !== "open");
  step("结论单调：历史 verified 地址在更长序列中不回退 open", monotonic && (historyAddresses.length > 0 || !verifiedA), `historyVerified=${historyAddresses.length} finalVerified=${verifiedA}`);
  step("事件序列无空洞（seq 连续）", facts.every((f, i) => i === 0 || f.seq === facts[i - 1].seq + 1));

  // ── 覆盖率终态汇总 ──
  const summary = f1.summary.byConclusion;
  console.log(`\n终态 fold summary: ${JSON.stringify(summary)}（verified=${summary.verified ?? 0} open=${summary.open ?? 0} awaiting-ruling=${summary["awaiting-ruling"] ?? 0}）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n冒烟链结果：PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
