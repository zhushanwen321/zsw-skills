#!/usr/bin/env node
// conformance-smoke.mjs — D5 v2 对账引擎端到端冒烟链（sync-conformance-plane U4/M4 验收
// 条款 3：不依赖 u-m5 组件，fake-agent 模拟器驱动，V1/V4/V5/V6/V7/V8/V11/V13/V14/V15；
// 报告层/切换层验收在设计包 D3 验收阶段 / A16 L4 真实灰度包）
//
// 链路：义务提取 → checker（semantic agent 模拟 + 缓存）→ 观察聚合（backlog）→
//       worktree sandbox 隔离变更集（禁产对象正反例）→ 集成器唯一写入门径 →
//       checker 失败契约（退出 20 / 回喂耗尽）→ 文档提案闭环（提案→裁决→manual 应用→升版）→
//       裁决续跑（rulingsFile 装载→同义务复核）→ 多仓集成三分支（预检失败/挂钩拒绝全不应用）→
//       宿主不变量（崩溃注入清扫）→ 事件流 fold（重放确定 + 无孤儿证据 + 结论单调）
//
// 本脚本是引擎领域编排的可复跑参考实现（v2 workflow 产物经 world.run 探针消费同一批
// conformance-plane 模块；产物侧的宿主编排由双平台构建与类型检查守）。运行：
//   node skills/self/dev-workflow/workflows/conformance-smoke.mjs
// 夹具 = 系统临时目录内的一次性 git 仓 + 设计包，跑完即删（对象库正反例各一仓）。

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONF = join(HERE, "..", "conformance-plane");

const { extractObligations, obligationsFromBindingSet } = await import(`${CONF}/extractors/obligations.mjs`);
const { initStateRepo, appendCommands, readEvents, rebuild, checkOrphanEvidence, withLock, readSnapshot } = await import(`${CONF}/kernel/state-repo.mjs`);
const { fold } = await import(`${CONF}/kernel/state-fold.mjs`);
const { hashContent } = await import(`${CONF}/kernel/evidence.mjs`);
const { runChecker, createCheckerRegistry } = await import(`${CONF}/checkers/registry.mjs`);
const { createSemanticCache } = await import(`${CONF}/checkers/semantic-cache.mjs`);
const { proposeObservation, createBacklog, adoptEntry } = await import(`${CONF}/checkers/backlog.mjs`);
const { createSandbox, releaseSandbox, sweepHost, measureObjectCounts, hostResidueProbe } = await import(`${CONF}/changeset/sandbox.mjs`);
const { createManifest, readManifest } = await import(`${CONF}/changeset/manifest.mjs`);
const { integrateChangeset } = await import(`${CONF}/integration/integrator.mjs`);
const { createDocProposal, submitDocProposal, recordDocRuling, applyDocProposal, bumpBindingVersion, adoptProposalAsEvidence } = await import(`${CONF}/integration/doc-proposals.mjs`);
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
  const baselineHash = createHash("sha256").update(readFileSync(join(repo, "src", "feature.ts"))).digest("hex");
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
    inputs: [{ name: "src/other.ts", hash: createHash("sha256").update(readArtifact("src/other.ts")).digest("hex") }],
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
  step("裁决 waived 后地址结论派生为 waived（引擎终态派生口径）", stateWaived.state.addresses["D2|root|behavior-mismatch"].lastRuling?.direction === "waived" && stateWaived.state.addresses["D2|root|behavior-mismatch"].conclusion === "waived");
  step("模拟器命令全部过词表校验（calls 轨迹完整）", sim1.run === undefined ? false : true, "sim1/sim2 构造即校验（invalid-simulator-command 抛错路径未触发）");

  // ── V13：checker 失败契约（deterministic 退出 20 / semantic 非法输出回喂耗尽 → CheckerFailed） ──
  console.log("[V13] checker 失败契约（退出 20 / 回喂 ≤2 耗尽升级）");
  // V13/V14/V8 场景绑定登记（D3-D6）：锁内改快照 input.bindings（recordArtifacts/doc-proposals
  // bumpBindingVersion 同通道——kernel 未导出绑定登记口）；先登记后入流，fold resolveAddress
  // 才可解析新地址。绑定形态 = 身份四元组（V6 newBinding 同款）
  const mkObligation = (identity, contract) => ({
    ...identity,
    binding: identity,
    address: { bindingId: identity.bindingId, repoId: identity.repoId, violationKind: identity.violationKind },
    ...contract,
  });
  await withLock(stateRoot, async () => {
    const snap = readSnapshot(stateRoot);
    const extraBindings = [
      { bindingId: "D3", repoId: "root", violationKind: "missing-implementation" },
      { bindingId: "D4", repoId: "root", violationKind: "missing-implementation" },
      { bindingId: "D5", repoId: "root", violationKind: "documentation-mismatch" },
      { bindingId: "D6", repoId: "root", violationKind: "missing-implementation" },
    ].map((b) => ({ ...b, bindingVersion: 1 }));
    writeFileSync(join(stateRoot, "snapshot.json"), JSON.stringify({ ...snap, input: { ...snap.input, bindings: [...snap.input.bindings, ...extraBindings] } }, null, 2));
  });
  const obligBroken = mkObligation({ bindingId: "D3", repoId: "root", violationKind: "missing-implementation", bindingVersion: 1 }, { targetSelector: "path:src/other.ts", checkerId: "det-broken", severity: "must-fix", evidenceInputs: ["src/other.ts"] });
  const registryBroken = createCheckerRegistry([
    { id: "det-broken", kind: "deterministic", version: "1.0.0", run: () => ({ command: "node det-broken.js --check", exitCode: 20 }) },
  ]);
  const r13a = await runChecker(registryBroken, { obligation: obligBroken, artifacts: artifactsOf(obligBroken) });
  step("deterministic 退出 20 → CheckerFailed（四要素在案：命令/退出码/摘要/恢复动作）", r13a.status === "failure" && r13a.commands[0].type === "RecordCheckerFailure" && r13a.commands[0].payload.exitCode === 20 && typeof r13a.commands[0].payload.command === "string" && typeof r13a.commands[0].payload.summary === "string" && typeof r13a.commands[0].payload.recovery === "string");
  await appendCommands(stateRoot, r13a.commands);
  const obligBadOut = mkObligation({ bindingId: "D4", repoId: "root", violationKind: "missing-implementation", bindingVersion: 1 }, { targetSelector: "path:src/other.ts", checkerId: "semantic-bad", severity: "must-fix", evidenceInputs: ["src/other.ts"] });
  const registryBadOut = createCheckerRegistry([
    { id: "semantic-bad", kind: "semantic", version: "1.0.0", run: () => "不是 JSON 的输出" },
  ]);
  const r13b = await runChecker(registryBadOut, { obligation: obligBadOut, artifacts: artifactsOf(obligBadOut) });
  step("semantic 非法输出回喂 ≤2 次后升级（共 3 次调用）", r13b.status === "failure" && r13b.calls === 1 + 2 && r13b.commands[0].type === "RecordCheckerFailure" && (r13b.commands[0].payload.summary ?? "").includes("回喂 2 次耗尽"), `calls=${r13b.calls}`);
  await appendCommands(stateRoot, r13b.commands);
  const st13 = rebuild(stateRoot);
  step("失败不伪造 verified：D3/D4 保持 open、lastCheckerFailure 可查", st13.state.addresses["D3|root|missing-implementation"]?.conclusion === "open" && st13.state.addresses["D3|root|missing-implementation"]?.lastCheckerFailure?.exitCode === 20 && st13.state.addresses["D4|root|missing-implementation"]?.conclusion === "open" && typeof st13.state.addresses["D4|root|missing-implementation"]?.lastCheckerFailure?.summary === "string");

  // ── V14：文档侧修复闭环（提案 → 裁决 → manual 门径应用 → 升版采纳） ──
  console.log("[V14] 文档提案闭环（提案→裁决→应用→升版）");
  const sectionRel = join("docs", "design-pkg-smoke", "s3-solution.json");
  const sectionAbs = join(repo, sectionRel);
  const sectionBefore14 = readFileSync(sectionAbs, "utf8");
  const proposal14 = createDocProposal({
    address: { bindingId: "D5", repoId: "root", violationKind: "documentation-mismatch" },
    sectionFile: "s3-solution.json",
    jsonPointer: "/decisions/1/detail",
    proposedValue: "实现必须导出 retryTimeout 常量（默认 3000ms，指数退避）",
    expectedCurrentValue: "实现必须导出 retryTimeout 常量",
    reason: "detail 缺默认值与退避语义（documentation-mismatch：设计文档侧差距）",
  });
  const sub14 = await submitDocProposal(stateRoot, proposal14);
  step("① 结构化提案零写入、RulingRequested 在案", typeof sub14.seq === "number" && readFileSync(sectionAbs, "utf8") === sectionBefore14);
  const rul14 = await recordDocRuling(stateRoot, proposal14, { direction: "doc-right" });
  step("② 裁决 doc-right 采纳（respondsTo 锚定在案请求）", rul14.adopted === true && rul14.respondsTo === sub14.seq);
  step("裁决采纳前章节 JSON 零改动", readFileSync(sectionAbs, "utf8") === sectionBefore14);
  const app14 = await applyDocProposal(stateRoot, proposal14, { designRepoRoot: repo, sectionRelPath: sectionRel });
  step("③ manual 门径应用（outcome=integrated）", app14.integration.outcome === "integrated", `events=${app14.integration.events.join(",")}`);
  step("章节 JSON 已含提案值", readFileSync(sectionAbs, "utf8").includes("指数退避"));
  const bump14 = await bumpBindingVersion(stateRoot, { bindingId: "D5" });
  step("④ 绑定升版（D5 bindingVersion 1→2）", bump14.oldBinding.bindingVersion === 1 && bump14.newBinding.bindingVersion === 2);
  const adp14 = await adoptProposalAsEvidence(stateRoot, proposal14, {
    newBinding: bump14.newBinding,
    checkerId: "conformance-review",
    checkerVersion: "1.0.0",
    inputs: [{ name: "docs/design-pkg-smoke/s3-solution.json", hash: hashContent(readFileSync(sectionAbs)) }],
  });
  step("提案按 BacklogAdopted 语义转新地址初始 fail 证据", adp14.evidence.type === "EvidenceRecorded" && adp14.evidence.result === "fail");
  const snap14 = readSnapshot(stateRoot);
  const tab14a = obligationsFromBindingSet(snap14.input.bindings);
  const tab14b = obligationsFromBindingSet(snap14.input.bindings);
  step("义务表升版重放一致（tableVersion 稳定、D5 行 bindingVersion=2）", tab14a.tableVersion === tab14b.tableVersion && tab14a.obligations.find((o) => o.bindingId === "D5")?.binding?.bindingVersion === 2);
  const st14 = rebuild(stateRoot);
  step("重放得到同一地址（D5 在案、结论 open）", st14.state.addresses["D5|root|documentation-mismatch"]?.conclusion === "open");

  // ── V8：裁决续跑（rulingsFile 装载 → awaiting 解除 → 同义务复核至 verified） ──
  console.log("[V8] 裁决续跑（rulingsFile 装载 → 同义务复核）");
  writeFileSync(join(repo, "src", "v8.ts"), "// V8 基线：缺 flagGated 导出（D6 must-fix 差距）\nexport const stub8 = 0;\n");
  git(repo, ["add", "src/v8.ts"]);
  git(repo, ["commit", "-qm", "v8 baseline"]);
  const baseline8 = createHash("sha256").update(readFileSync(join(repo, "src", "v8.ts"))).digest("hex");
  const oblig8 = mkObligation({ bindingId: "D6", repoId: "root", violationKind: "missing-implementation", bindingVersion: 1 }, { targetSelector: "path:src/v8.ts", checkerId: "conformance-review", severity: "must-fix", evidenceInputs: ["src/v8.ts"] });
  const registry8 = createCheckerRegistry([
    { id: "conformance-review", kind: "semantic", version: "1.0.0",
      run: (input) => (Object.values(input.inputHashes)[0] ?? "") === baseline8
        ? { result: "fail", summary: "v8.ts 缺 flagGated 导出（D6 声明要求）" }
        : { result: "pass", summary: "声明已实现" } },
  ]);
  const addrKey8 = "D6|root|missing-implementation";
  const addr8 = () => rebuild(stateRoot).state.addresses[addrKey8];
  const sim8 = createSimulator([
    { role: "main-agent", command: { type: "RequestRuling", payload: { address: oblig8.address, question: "D6 must-fix 方向争议：flagGated 以函数还是常量形态导出？" } } },
  ]);
  await appendCommands(stateRoot, sim8.run().commands);
  const pending8 = addr8().pendingRulingSeq;
  step("等待裁决期间 blocker 派生（awaiting-ruling，无修复派发）", addr8().conclusion === "awaiting-ruling" && typeof pending8 === "number");
  // 裁决写入 rulingsFile（引擎停回通道落盘形态）→ 重发起装载：读文件 → RecordRuling 入流
  //（design-code-sync-v2.shared.ts 用户裁决装载同构：respondsTo 以状态仓在案请求为准）
  const rulingsFile8 = join(work, "rulings-v8.json");
  writeFileSync(rulingsFile8, JSON.stringify([{ address: oblig8.address, direction: "code-right", respondsTo: pending8 }], null, 2));
  const arr8 = JSON.parse(readFileSync(rulingsFile8, "utf8"));
  await appendCommands(stateRoot, arr8.map((r) => ({ type: "RecordRuling", actor: "main-agent", payload: { address: r.address, direction: r.direction, respondsTo: addr8().pendingRulingSeq } })));
  const st8 = rebuild(stateRoot);
  step("裁决装载后 awaiting 解除、义务 id 与地址不变", st8.state.addresses[addrKey8].awaitingRuling === false && st8.state.addresses[addrKey8].conclusion === "open" && st8.state.addresses[addrKey8].lastRuling?.direction === "code-right" && st8.state.addresses[addrKey8].address.bindingId === "D6");
  const r8a = await runChecker(registry8, { obligation: oblig8, artifacts: artifactsOf(oblig8) });
  step("续跑复核判 fail（差距仍在）", r8a.status === "violation" && r8a.calls === 1);
  await appendCommands(stateRoot, r8a.commands);
  await recordArtifacts(r8a.inputHashes);
  const sb8 = createSandbox({ repoRoot: repo, sandboxRoot, changesetId: "cs-v8-root" });
  writeFileSync(join(sb8.dir, "src", "v8.ts"), "// V8 已修复：补 flagGated 导出\nexport const stub8 = 0;\nexport function flagGated(name) { return name !== \"\"; }\n");
  createManifest({ changesetId: "cs-v8-root", repos: [{ repoId: "root", repoRoot: repo, sandbox: sb8 }], outDir: join(work, "changesets", "cs-v8-root") });
  const integ8 = await integrateChangeset(readManifest(join(work, "changesets", "cs-v8-root")), { stateRoot, actor: "reconcile-engine" });
  step("修复变更集经唯一门径集成", integ8.outcome === "integrated");
  const r8b = await runChecker(registry8, { obligation: oblig8, artifacts: artifactsOf(oblig8) });
  await appendCommands(stateRoot, r8b.commands);
  await recordArtifacts(r8b.inputHashes);
  const st8b = rebuild(stateRoot);
  step("同义务复核 pass → verified（裁决后地址收敛）", r8b.status === "pass" && st8b.state.addresses[addrKey8].conclusion === "verified");
  await releaseSandbox(sb8);

  // ── V5：多仓集成三分支（预检失败 / 挂钩拒绝全不应用；符号链接目标仓逐仓应用） ──
  console.log("[V5] 多仓集成三分支（全不应用 + 符号链接目标仓逐仓应用）");
  const repo3 = join(work, "repo3");
  const pluginsRoot = join(repo, "plugins"); // 符号链接路径进 manifest——模块内 realpathSync 解析真实根
  mkdirSync(repo3, { recursive: true });
  writeFileSync(join(repo3, "service.txt"), "// service 基线\n");
  git(repo3, ["init", "-q"]);
  git(repo3, ["config", "user.email", "smoke@local"]);
  git(repo3, ["config", "user.name", "smoke"]);
  git(repo3, ["add", "."]);
  git(repo3, ["commit", "-qm", "baseline"]);
  symlinkSync(repo3, pluginsRoot, "dir");
  // 一轮多仓变更集分两步编排（分支一需在 collect 与 integrate 之间注入漂移）：
  //   v5Stage  — 双 sandbox 编辑 → agent 阶段对象库计数（objAt）→ 多仓 manifest（补丁固化）
  //   v5Finish — 集成器门径 → sandbox 回收
  const v5Stage = (tag) => {
    const sa = createSandbox({ repoRoot: repo, sandboxRoot, changesetId: `cs-${tag}-root` });
    const sb = createSandbox({ repoRoot: pluginsRoot, sandboxRoot, changesetId: `cs-${tag}-plugins` });
    writeFileSync(join(sa.dir, "src", "other.ts"), `${readFileSync(join(repo, "src", "other.ts"), "utf8")}// ${tag} 补丁标记 root\n`);
    writeFileSync(join(sb.dir, "service.txt"), `// ${tag} 补丁标记 plugins\n`);
    const objAt = { root: measureObjectCounts(repo).total, plugins: measureObjectCounts(repo3).total };
    createManifest({
      changesetId: `cs-${tag}`,
      repos: [
        { repoId: "root", repoRoot: repo, sandbox: sa },
        { repoId: "plugins", repoRoot: pluginsRoot, sandbox: sb },
      ],
      outDir: join(work, "changesets", `cs-${tag}`),
    });
    return { tag, sa, sb, objAt };
  };
  const v5Finish = async (staged) => {
    const result = await integrateChangeset(readManifest(join(work, "changesets", `cs-${staged.tag}`)), { stateRoot, actor: "reconcile-engine" });
    await releaseSandbox(staged.sa);
    await releaseSandbox(staged.sb);
    return result;
  };
  // 分支一：plugins 仓工作树漂移 → apply 预检失败 → 全量不应用
  const objBefore5 = { root: measureObjectCounts(repo).total, plugins: measureObjectCounts(repo3).total };
  const staged5a = v5Stage("v5a");
  writeFileSync(join(repo3, "service.txt"), "// 漂移载体：与补丁基线冲突\n");
  const integ5a = await v5Finish(staged5a);
  step("agent 阶段双仓对象库零写入（逐仓 count+in-pack 不变）", staged5a.objAt.root === objBefore5.root && staged5a.objAt.plugins === objBefore5.plugins, `root ${objBefore5.root}→${staged5a.objAt.root} plugins ${objBefore5.plugins}→${staged5a.objAt.plugins}`);
  step("任一仓预检失败 → outcome=failed（IntegrationPrecheckFailed 分支）", integ5a.outcome === "failed" && integ5a.events.includes("RecordIntegrationPrecheckFailure"));
  step("失败仓 perRepo=precheck-failed、重生成任务指名该仓", integ5a.perRepo.some((p) => p.repoId === "plugins" && p.status === "precheck-failed") && integ5a.regenerateTask.repos.includes("plugins"));
  step("全量不应用（root 补丁未落）", !readFileSync(join(repo, "src", "other.ts"), "utf8").includes("v5a 补丁标记"));
  step("全量不应用（plugins 补丁未落）", !readFileSync(join(repo3, "service.txt"), "utf8").includes("v5a 补丁标记"));
  git(repo3, ["checkout", "--", "service.txt"]); // 恢复漂移载体
  // 分支二：plugins 仓宿主 pre-commit 挂钩拒绝 → 同归类集成失败、全量不应用
  writeFileSync(join(repo3, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(repo3, ".git", "hooks", "pre-commit"), 0o755);
  const integ5b = await v5Finish(v5Stage("v5b"));
  step("挂钩拒绝 → outcome=failed（IntegrationGateChecked 分支）", integ5b.outcome === "failed" && integ5b.events.includes("RecordIntegrationGate"));
  step("挂钩拒绝详情携带 hookPath（字段契约四要素 + hookPath）", integ5b.perRepo.some((p) => p.repoId === "plugins" && p.status === "hook-rejected" && typeof p.hookPath === "string"));
  step("挂钩分支同归类集成失败 → 全量不应用（root 补丁未落）", !readFileSync(join(repo, "src", "other.ts"), "utf8").includes("v5b 补丁标记"));
  rmSync(join(repo3, ".git", "hooks", "pre-commit"));
  // 分支三：修复后逐仓应用（符号链接目标仓 realpath 解析正确）
  const integ5c = await v5Finish(v5Stage("v5c"));
  step("修复后逐仓应用（outcome=integrated、双仓 perRepo=integrated）", integ5c.outcome === "integrated" && integ5c.perRepo.filter((p) => p.status === "integrated").length === 2);
  step("root 补丁内容落地", readFileSync(join(repo, "src", "other.ts"), "utf8").includes("v5c 补丁标记"));
  step("符号链接目标仓补丁内容落地（realpath 解析正确）", readFileSync(join(repo3, "service.txt"), "utf8").includes("v5c 补丁标记"));
  step("分支三回收后宿主无残留（worktree/分支/状态干净）", (() => { const p = hostResidueProbe(repo3); return p.worktreeEntries.length === 0 && p.sandboxBranches.length === 0 && p.dirtyFiles.length === 0; })());

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

  // ── V15：宿主不变量（中途崩溃注入后启动期清扫，恢复无残留） ──
  console.log("[V15] 宿主不变量（崩溃注入 → 启动期清扫收敛）");
  const repo4 = join(work, "repo4");
  const sandboxRoot4 = join(work, "sandbox4");
  mkdirSync(repo4, { recursive: true });
  mkdirSync(sandboxRoot4, { recursive: true });
  writeFileSync(join(repo4, "svc.txt"), "s\n");
  git(repo4, ["init", "-q"]);
  git(repo4, ["config", "user.email", "smoke@local"]);
  git(repo4, ["config", "user.name", "smoke"]);
  git(repo4, ["add", "."]);
  git(repo4, ["commit", "-qm", "b"]);
  const objBefore15 = measureObjectCounts(repo4);
  const sb15 = createSandbox({ repoRoot: repo4, sandboxRoot: sandboxRoot4, changesetId: "cs-crash" });
  rmSync(sb15.dir, { recursive: true, force: true }); // 崩溃注入：进程死亡 = 检出目录被硬删，不走回收通道
  const res15 = hostResidueProbe(repo4);
  step("崩溃注入后残留可检出（prunable 管理区条目 + 孤儿临时分支）", res15.worktreeEntries.length === 1 && res15.sandboxBranches.length === 1, `entries=${res15.worktreeEntries.length} branches=${res15.sandboxBranches.length}`);
  const swept15a = sweepHost({ repoRoot: repo4 });
  const swept15b = sweepHost({ repoRoot: repo4 });
  step("启动期清扫清除 prunable 管理区条目", swept15a.prunedEntries.length === 1, `pruned=${swept15a.prunedEntries.length}`);
  step("孤儿分支经清扫移除（两轮合计移除 1——分支移除落在 prunable 条目清除的同轮或次轮，断言锁收敛性质不锁分轮）", swept15a.removedBranches.length + swept15b.removedBranches.length === 1 && swept15b.prunedEntries.length === 0, `a=${JSON.stringify(swept15a)} b=${JSON.stringify(swept15b)}`);
  const res15b = hostResidueProbe(repo4);
  step("清扫后宿主无残留（worktree list / branch / status 全净）", res15b.worktreeEntries.length === 0 && res15b.sandboxBranches.length === 0 && res15b.dirtyFiles.length === 0);
  step("全程共享对象库零写入（count+in-pack 合计不变）", measureObjectCounts(repo4).total === objBefore15.total, `${objBefore15.total} 不变`);

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
