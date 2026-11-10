// doc-proposals.mjs — 设计文档结构化变更提案通道（sync-conformance-plane U3/M3）
//
// 语义权威（设计 sync-conformance-plane targetForm 第六段 doc-proposals 闭环 / 段一 / 段七 / V14）：
//   documentation-mismatch 类义务或裁决为文档侧的差距，修复 agent 产出结构化文档变更提案
//   （不直接改章节 JSON）；提案复用 RulingRequested/RulingRecorded 事件形态经裁决采纳后，
//   由集成器以 manual 同门径应用到章节 JSON，触发新绑定版本并按 BacklogAdopted 语义把提案
//   转化为新地址初始证据，义务表随之升版。
//
// 四步闭环（每步独立函数 + runDocProposalCycle 编排）：
//   ① 提案     createDocProposal —— 结构化提案对象（章节文件 + JSON 指针 + 提议值），零写入
//   ② 裁决     submitDocProposal / recordDocRuling —— RulingRequested / RulingRecorded(doc-right)
//              （direction 非 doc-right = 不采纳，不应用不升版）
//   ③ 应用     applyDocProposal —— 本地生成补丁（正式仓零写入）→ integrateChangeset(manual 门径，
//              actor=main-agent)：apply 预检 / 挂钩 / 两阶段提交同一门径
//   ④ 升版采纳 bumpBindingVersion + adoptProposalAsEvidence —— 绑定集 bindingVersion+1（锁内改
//              快照 input.bindings，backlog.mjs 同通道）→ AdoptBacklogEntry + RecordEvidence(fail)
//              （观察转新地址初始证据，段七 BacklogAdopted 语义）
//
// jsonPointer：RFC 6901 子集（/a/b/c，数组下标数字）；expectedCurrentValue 对账不符 = 文档已漂移，
// 拒绝应用（冲突补丁不自动变基语义的文档侧对应，恢复动作 = 重新提案）。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname as pathDirname } from "node:path";
import { realpathSync } from "node:fs";
import { deriveAddress, canonicalJson } from "../kernel/facts.mjs";
import { hashContent, computeEvidence } from "../kernel/evidence.mjs";
import { obligationsFromBindingSet } from "../extractors/obligations.mjs";
import { readSnapshot, readEvents, appendCommands, withLock } from "../kernel/state-repo.mjs";
import { buildRepoEntry, buildManifestObject } from "../changeset/manifest.mjs";
import { integrateChangeset, MANUAL_ACTOR } from "./integrator.mjs";

// 快照文件名 = kernel/state-repo.mjs 私有常量（backlog.mjs 同款 loud-break 注释：kernel 未导出
// 快照写入口，deriveArchived 注释预告「外部直接改快照 input」是预期通道——M5 cutover 同模式）
const SNAPSHOT_FILE = "snapshot.json";

function proposalError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** RFC 6901 子集求值：按指针取当前值（指针不存在返回 undefined，不抛错——对账用） */
function jsonPointerGet(doc, pointer) {
  if (pointer === "") return doc;
  const tokens = pointer.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const t of tokens) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(t)] : cur[t];
  }
  return cur;
}

/** RFC 6901 子集写入：按指针设置值；中间节点缺失抛错（提案必须指向已存在结构） */
function jsonPointerSet(doc, pointer, value) {
  const tokens = pointer.split("/").slice(1).map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = Array.isArray(cur) ? cur[Number(t)] : cur[t];
    if (next === undefined || next === null || typeof next !== "object") {
      throw proposalError("json-pointer-missing", `JSON 指针中间节点缺失：/${tokens.slice(0, i + 1).join("/")}。恢复动作：提案指向已存在的章节结构，或分两级提案。`);
    }
    cur = next;
  }
  const last = tokens[tokens.length - 1];
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
      throw proposalError("json-pointer-missing", `JSON 指针数组下标非法：${pointer}。恢复动作：核对章节结构后重新提案。`);
    }
    cur[idx] = value;
  } else {
    cur[last] = value;
  }
  return doc;
}

/**
 * ① 创建结构化文档变更提案（纯对象，零写入——修复 agent 产物的机器形态）。
 *   address   差距地址（documentation-mismatch 类义务，或裁决为文档侧的差距）
 *   sectionFile 章节文件名（s1-context.json 等）
 *   jsonPointer 条目内指针（RFC 6901 子集）
 *   proposedValue  提议的新值（结构化值，非文本补丁）
 *   reason    提案理由（裁决 question 载体）
 * proposalId 缺省 = 内容哈希短摘要（确定性派生，同提案重放同 id——AX1 同构）。
 */
export function createDocProposal({ proposalId, address, sectionFile, jsonPointer, proposedValue, reason, expectedCurrentValue }) {
  if (address === null || typeof address !== "object" || !address.bindingId || !address.repoId || !address.violationKind) {
    throw proposalError("invalid-proposal-address", "提案必须携带差距地址 { bindingId, repoId, violationKind }。恢复动作：挂到 documentation-mismatch 类义务地址后重新提案。");
  }
  if (typeof sectionFile !== "string" || sectionFile.trim() === "") {
    throw proposalError("invalid-proposal-section", "提案必须携带章节文件名（sectionFile）。");
  }
  if (typeof jsonPointer !== "string" || !jsonPointer.startsWith("/")) {
    throw proposalError("invalid-proposal-pointer", `JSON 指针非法：「${String(jsonPointer)}」（须以 / 起始的 RFC 6901 形态）。`);
  }
  if (proposedValue === undefined) {
    throw proposalError("invalid-proposal-value", "提案必须携带 proposedValue（结构化新值）。");
  }
  const content = { address, sectionFile, jsonPointer, proposedValue, expectedCurrentValue: expectedCurrentValue ?? null };
  const id = proposalId ?? `dp-${createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 12)}`;
  return { proposalId: id, ...content, reason: reason ?? "", createdAt: new Date().toISOString() };
}

/**
 * ②-a 提交裁决请求：RulingRequested 入流（address + question）。
 * 返回 { seq }（RulingRequested 的流内 seq，裁决回执 respondsTo 锚点）。
 */
export async function submitDocProposal(stateRoot, proposal, { actor = "main-agent" } = {}) {
  const question = `文档侧变更提案 ${proposal.proposalId}：${proposal.sectionFile}${proposal.jsonPointer} —— ${proposal.reason}`;
  const appended = await appendCommands(stateRoot, [
    { type: "RequestRuling", actor, payload: { address: proposal.address, question } },
  ]);
  const requested = appended.appendedFacts[0];
  return { seq: requested.seq, question };
}

/** 最近一条未应答的该地址 RulingRequested seq（裁决必须回应在案请求，AX10） */
function pendingRulingSeq(stateRoot, address) {
  const events = readEvents(stateRoot);
  let pending = null;
  const answered = new Set(events.filter((e) => e.type === "RulingRecorded").map((e) => e.respondsTo));
  for (const e of events) {
    if (e.type !== "RulingRequested") continue;
    if (JSON.stringify(e.address) !== JSON.stringify(address)) continue;
    if (answered.has(e.seq)) continue;
    pending = e.seq;
  }
  if (pending === null) {
    throw proposalError("ruling-request-missing", `该地址无未应答的 RulingRequested（${address.bindingId}）。恢复动作：先 submitDocProposal。`);
  }
  return pending;
}

/**
 * ②-b 记录裁决：RulingRecorded { address, direction, respondsTo } 入流。
 * direction = "doc-right"（文档侧采纳）→ 后续应用；"code-right"/"waived" → 提案不采纳（返回 adopted=false）。
 */
export async function recordDocRuling(stateRoot, proposal, { direction, actor = "main-agent" } = {}) {
  if (!["code-right", "doc-right", "waived"].includes(direction)) {
    throw proposalError("invalid-ruling-direction", `裁决方向「${String(direction)}」不在词表（code-right / doc-right / waived）。`);
  }
  const respondsTo = pendingRulingSeq(stateRoot, proposal.address);
  const appended = await appendCommands(stateRoot, [
    { type: "RecordRuling", actor, payload: { address: proposal.address, direction, respondsTo } },
  ]);
  return { seq: appended.appendedFacts[0].seq, direction, respondsTo, adopted: direction === "doc-right" };
}

/**
 * ③ 应用提案（集成器 manual 同门径）：本地生成章节 JSON 补丁（正式仓零写入）→
 * integrateChangeset({ mode: "manual", actor: MANUAL_ACTOR })。
 *   designRepoRoot 设计文档所在仓根（章节文件相对该根）
 *   sectionRelPath 章节文件相对路径（如 docs/<pkg>/s3-solution.json）
 * expectedCurrentValue 提案携带时先与工作树当前值对账（不符 = 文档漂移，拒绝应用）。
 */
export async function applyDocProposal(stateRoot, proposal, { designRepoRoot, sectionRelPath, actor = MANUAL_ACTOR, targetBranches = {}, versionDiscipline } = {}) {
  const realRepo = realpathSync(designRepoRoot);
  const sectionAbs = join(realRepo, sectionRelPath);
  let doc;
  let originalText;
  try {
    originalText = readFileSync(sectionAbs, "utf8");
    doc = JSON.parse(originalText);
  } catch (e) {
    throw proposalError("section-unreadable", `章节文件不可读/非 JSON：${sectionAbs}（${e.message}）。恢复动作：核对 sectionRelPath。`);
  }
  // 对账（expectedCurrentValue 对齐 → 漂移拒绝）
  if (proposal.expectedCurrentValue !== null && proposal.expectedCurrentValue !== undefined) {
    const current = jsonPointerGet(doc, proposal.jsonPointer);
    if (JSON.stringify(current) !== JSON.stringify(proposal.expectedCurrentValue)) {
      throw proposalError(
        "proposal-conflict",
        `章节已漂移：${proposal.jsonPointer} 当前值与提案基线不符（${JSON.stringify(current)} ≠ ${JSON.stringify(proposal.expectedCurrentValue)}）。` +
          `恢复动作：基于当前章节内容重新提案（冲突不自动变基语义的文档侧对应）。`,
      );
    }
  }
  const newDoc = jsonPointerSet(structuredClone(doc), proposal.jsonPointer, proposal.proposedValue);
  const newText = `${JSON.stringify(newDoc, null, 2)}\n`;

  // 本地生成补丁（一次性临时仓标准 git diff——产出单层 a/<rel> b/<rel> 头，git apply -p1 直接可应用。
  // 不用 git diff --no-index：其头把目录名并进前缀（a/a/<rel>），apply -p1 剥不净。临时仓在系统
  // 临时目录一次性创建销毁，与目标仓无关，不涉及第④类禁令（该禁令约束 sandbox 内 agent））
  const tmp = mkdtempSync(join(tmpdir(), "conf-docprop-"));
  let patch;
  try {
    const relPosix = sectionRelPath.split("\\").join("/");
    const fileInGen = join(tmp, relPosix);
    mkdirSync(pathDirname(fileInGen), { recursive: true });
    // diff 退出码 1 = 有差异属正常；其余非零失败
    const run = (args) => {
      const r = spawnSync("git", ["-C", tmp, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0 && !(args[0] === "diff" && r.status === 1)) {
        throw proposalError("doc-diff-failed", `章节补丁生成失败（git ${args.join(" ")}）：${(r.stderr || "").trim()}`);
      }
      return r;
    };
    run(["init", "-q"]);
    run(["config", "user.email", "doc-proposals@local"]);
    run(["config", "user.name", "doc-proposals"]);
    writeFileSync(fileInGen, originalText);
    run(["add", relPosix]);
    run(["commit", "-qm", "baseline"]);
    writeFileSync(fileInGen, newText);
    patch = run(["diff", "--", relPosix]).stdout;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (patch.trim() === "") {
    throw proposalError("no-op-proposal", "提案值与当前值相同（空补丁）。恢复动作：核对 proposedValue。");
  }

  const head = spawnSync("git", ["-C", realRepo, "rev-parse", "HEAD"], { encoding: "utf8" });
  const branch = spawnSync("git", ["-C", realRepo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0 || branch.status !== 0) {
    throw proposalError("design-repo-invalid", `设计仓不可用（${realRepo}）。恢复动作：核对 designRepoRoot 为 Git 仓根。`);
  }
  const baseCommit = head.stdout.trim();
  // 目标树哈希按 manifest 同一口径：{ relPath → 内容哈希 } 规范化 JSON 哈希
  const sectionPosix = sectionRelPath.split("\\").join("/");
  const targetTreeHash = createHash("sha256")
    .update(canonicalJson({ [sectionPosix]: hashContent(Buffer.from(newText, "utf8")) }))
    .digest("hex");
  const entry = buildRepoEntry({
    repoId: "design-docs",
    repoRoot: realRepo,
    baseRef: branch.stdout.trim(),
    baseCommit,
    patch,
    changedFiles: [sectionPosix],
    targetTreeHash,
  });
  const manifest = buildManifestObject({ changesetId: `docprop-${proposal.proposalId}`, entries: [entry] });
  const result = await integrateChangeset(
    { manifest, patches: { [entry.repoId]: patch } },
    { stateRoot, actor: MANUAL_ACTOR, mode: "manual", targetBranches, ...(versionDiscipline ? { versionDiscipline } : {}) },
  );
  return { proposalId: proposal.proposalId, sectionRelPath, integration: result };
}

/**
 * ④-a 绑定升版（锁内改快照 input.bindings：同 id 条目 bindingVersion+1——义务表随之升版）。
 * 绑定不存在抛错；返回升版后的新绑定。
 */
export async function bumpBindingVersion(stateRoot, { bindingId, actor = "main-agent" } = {}) {
  return withLock(stateRoot, async () => {
    const snap = readSnapshot(stateRoot);
    if (!snap) throw proposalError("state-store-missing", `状态仓未初始化（${stateRoot}）。恢复动作：先 kernel.initStateRepo。`);
    const bindings = [...(snap.input.bindings ?? [])];
    const idx = bindings.findIndex((b) => b.bindingId === bindingId);
    if (idx === -1) {
      throw proposalError("binding-missing", `绑定「${bindingId}」不在绑定集。恢复动作：核对绑定登记（提案例外：新绑定走 backlog 通道）。`);
    }
    const old = bindings[idx];
    const newBinding = { ...old, bindingVersion: (old.bindingVersion ?? 1) + 1 };
    bindings[idx] = newBinding;
    writeFileSync(join(stateRoot, SNAPSHOT_FILE), JSON.stringify({ ...snap, input: { ...snap.input, bindings } }, null, 2));
    void actor;
    return { oldBinding: old, newBinding };
  });
}

/**
 * ④-b BacklogAdopted 语义采纳：AdoptBacklogEntry { backlogId: proposalId, newBinding } +
 * RecordEvidence（result=fail，新地址初始证据——观察转证据，段七）。
 * 前置：bumpBindingVersion 已登记升版绑定（fold 的 BacklogAdopted 分支要求新绑定先在绑定集）。
 * inputs = [{ name, hash }]（提案观察引用的输入，AX4 证据五要素）。
 */
export async function adoptProposalAsEvidence(stateRoot, proposal, { newBinding, checkerId, checkerVersion, inputs, actor = "main-agent" } = {}) {
  const bindingRef = {
    bindingId: newBinding.bindingId,
    repoId: newBinding.repoId,
    violationKind: newBinding.violationKind,
    bindingVersion: newBinding.bindingVersion,
  };
  const evidence = computeEvidence({
    address: deriveAddress(bindingRef),
    binding: bindingRef,
    checkerId,
    checkerVersion,
    inputs,
    result: "fail",
  });
  const commands = [
    { type: "AdoptBacklogEntry", actor, payload: { backlogId: proposal.proposalId, newBinding: bindingRef } },
    { type: "RecordEvidence", actor, payload: evidence },
  ];
  const appended = await appendCommands(stateRoot, commands);
  return { appended: appended.appended, evidence: appended.appendedFacts[1] };
}

/**
 * 四步闭环编排（V14）：提案 → 裁决(doc-right 才继续) → manual 门径应用 → 升版 + BacklogAdopted 采纳。
 * 返回各步产物；裁决非 doc-right 时中止（不应用不升版，adopted=false）。
 */
export async function runDocProposalCycle({ stateRoot, proposal, designRepoRoot, sectionRelPath, rulingDirection = "doc-right", actor = "main-agent", checkerId = "doc-proposal", checkerVersion = "1.0.0", evidenceInputs, targetBranches = {}, versionDiscipline } = {}) {
  const submitted = await submitDocProposal(stateRoot, proposal, { actor });
  const ruling = await recordDocRuling(stateRoot, proposal, { direction: rulingDirection, actor });
  if (!ruling.adopted) {
    return { submitted, ruling, adopted: false, applied: null, bumped: null, evidence: null };
  }
  const applied = await applyDocProposal(stateRoot, proposal, { designRepoRoot, sectionRelPath, actor, targetBranches, versionDiscipline });
  const bumped = await bumpBindingVersion(stateRoot, { bindingId: proposal.address.bindingId, actor });
  const adopted = await adoptProposalAsEvidence(stateRoot, proposal, { newBinding: bumped.newBinding, checkerId, checkerVersion, inputs: evidenceInputs, actor });
  // 义务表升版证明：绑定集（含升版绑定）重算 tableVersion 与义务行
  const snap = readSnapshot(stateRoot);
  const table = obligationsFromBindingSet(snap.input.bindings ?? []);
  return { submitted, ruling, adopted: true, applied, bumped, evidence: adopted.evidence, obligationsTable: table };
}
