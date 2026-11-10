// backlog.mjs — 未映射观察与 triage 队列（sync-conformance-plane U2/M2）
//
// 语义权威（设计 sync-conformance-plane D6 / AX8 / 段七 / V6 / G6）：
//   backlog 条目状态 = proposed / adopted / rejected / superseded；新发现映射不到当前义务
//   时进入 proposed，不改变当前覆盖率分母（AX8：分母只含 conformance 绑定义务）。
//   BacklogAdopted：新绑定版本创建时写该事件，引用被采纳条目与新 bindingId（bindingRef：
//   含 bindingVersion）；条目退出 active backlog（proposed），其观察转成新地址初始证据
//   （result=fail 的 EvidenceRecorded，落在 (newBindingId, repoId, violationKind) 地址上）。
//   未被采纳条目保留 proposed / rejected / superseded 历史；旧工作范围完成判据不变。
//
// 状态机（显式转移表，表外转移 fail-fast）：
//   proposed → adopted    （AdoptBacklogEntry，须带新绑定）
//   proposed → rejected   （须带理由）
//   proposed → superseded （须带 supersededBy）
//   adopted / rejected / superseded → 终态，不得再转移
//
// 经 kernel 写状态仓（AX3/AX10：引擎与 agent 都只经 kernel 唯一写入口追加事件）：采纳 = ①
// 快照 input.bindings 登记新绑定（fold 的 BacklogAdopted 分支要求新绑定先在绑定集——绑定集
// 是静态输入不是事件，登记形态对齐 kernel/state-repo.mjs deriveArchived 注释预告的「外部
// 直接改快照 input」先例，M5 cutover 同通道）→ ② appendCommands 追加 AdoptBacklogEntry +
// RecordEvidence。两步各自持 kernel 单写者锁（锁不可重入，串行两段；M4 引擎在同一会话内
// 连续执行，不存在第三方写者窗口）。

import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { validateCommand, deriveAddress, obligationSummaryHash } from "../kernel/facts.mjs";
import { computeEvidence } from "../kernel/evidence.mjs";
import { readSnapshot, appendCommands, withLock } from "../kernel/state-repo.mjs";

// 快照文件名 = kernel/state-repo.mjs 私有常量 SNAPSHOT_FILE（"snapshot.json"）。kernel 未导出
// 快照写入口，但 deriveArchived 的注释明文预告「外部直接改快照 input（如 M5 cutover 命令）」
// 是预期通道（M5 cutover 同模式）——本模块按该通道登记新绑定；文件名若在 kernel 演进中变更，
// 本写入会因 readSnapshot 返回 null 立即报错（loud break，不静默错写）。
const SNAPSHOT_FILE = "snapshot.json";

/** 锁内更新快照 input（外部直接改快照 input 的 kernel 预告通道；调用方须持有 kernel 锁） */
function writeSnapshotInput(root, snapshot) {
  writeFileSync(join(root, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
}

export const BACKLOG_STATUSES = Object.freeze(["proposed", "adopted", "rejected", "superseded"]);

const TERMINAL_STATUSES = Object.freeze(["adopted", "rejected", "superseded"]);

function backlogError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 创建 triage 队列（内存工作集；采纳史以事件流为权威，本表只承载在途 triage 状态） */
export function createBacklog() {
  const entries = new Map(); // backlogId -> entry
  return {
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    /** active backlog = 仍处 proposed 的条目（adopted/rejected/superseded 退出） */
    active: () => [...entries.values()].filter((e) => e.status === "proposed"),
    _entries: entries,
  };
}

/**
 * 未映射观察进入队列（proposed）。backlogId 缺省 = 观察内容哈希短摘要（确定性派生，
 * 同观察重放同 id——AX1 身份不由运行轮次生成）；重复 id 幂等拒绝（backlog-entry-exists）。
 */
export function proposeObservation(backlog, { backlogId, observation, source }) {
  const id = backlogId ?? `bl-${createHash("sha256").update(String(observation)).digest("hex").slice(0, 12)}`;
  if (typeof observation !== "string" || observation.trim() === "") {
    throw backlogError("invalid-observation", "观察内容必须是非空字符串（未映射观察的一句话描述）。恢复动作：补观察描述后重新提案。");
  }
  if (backlog.get(id)) {
    throw backlogError("backlog-entry-exists", `backlog 条目「${id}」已存在（${backlog.get(id).status}）。恢复动作：同一观察不重复提案；新观察用新 id。`);
  }
  const entry = { backlogId: id, observation, status: "proposed", source: source ?? null };
  backlog._entries.set(id, entry);
  return entry;
}

/** 转移合法性（显式状态机，表外转移 fail-fast） */
export function triageEntry(backlog, { backlogId, decision, reason, supersededBy }) {
  const entry = backlog.get(backlogId);
  if (!entry) {
    throw backlogError("backlog-entry-missing", `backlog 条目「${backlogId}」不存在。恢复动作：先 proposeObservation 提案，或核对 id。`);
  }
  if (!["adopted", "rejected", "superseded"].includes(decision)) {
    throw backlogError("invalid-backlog-decision", `triage 决定「${String(decision ?? "缺失")}」不在词表（adopted / rejected / superseded）。`);
  }
  if (entry.status !== "proposed") {
    throw backlogError(
      "backlog-transition-illegal",
      `条目「${backlogId}」已处 ${entry.status} 终态，不得再转移（状态机：proposed → adopted/rejected/superseded，表外转移拒绝）。`,
    );
  }
  if (decision === "superseded" && (typeof supersededBy !== "string" || supersededBy.trim() === "")) {
    throw backlogError("invalid-backlog-triage", `superseded 必须携带 supersededBy（替代条目 id）。恢复动作：补替代条目后重新 triage。`);
  }
  if (decision === "rejected" && (typeof reason !== "string" || reason.trim() === "")) {
    throw backlogError("invalid-backlog-triage", "rejected 必须携带理由（reason）。恢复动作：补不采纳理由后重新 triage。");
  }
  entry.status = decision;
  entry.triaged = { decision, reason: reason ?? null, supersededBy: supersededBy ?? null };
  return entry;
}

/**
 * 装配采纳命令序列（纯函数，不写盘）：
 *   ① AdoptBacklogEntry { backlogId, newBinding }（bindingRef：含 bindingVersion）
 *   ② RecordEvidence  观察转新地址初始证据（result=fail，AX4 五要素齐备）
 * 命令先过 kernel validateCommand（fail-fast 在写盘前）。
 * inputs = [{ name, hash }]（观察引用的 artifact 输入，证据有效期的绑定物）。
 */
export function adoptionCommands({ backlogId, newBinding, checkerId, checkerVersion, inputs, actor, changesetId }) {
  const adoptCmd = { type: "AdoptBacklogEntry", actor, payload: { backlogId, newBinding } };
  const evidencePayload = computeEvidence({
    address: deriveAddress(newBinding),
    binding: newBinding,
    checkerId,
    checkerVersion,
    inputs,
    result: "fail",
  });
  const evidenceCmd = { type: "RecordEvidence", actor, payload: evidencePayload };
  for (const cmd of [adoptCmd, evidenceCmd]) {
    const check = validateCommand(cmd);
    if (!check.ok) {
      throw backlogError("invalid-adoption-command", `采纳命令未过 kernel schema 校验：${check.errors.join("；")}。恢复动作：核对新绑定（bindingRef）与证据输入形态。`);
    }
  }
  return [adoptCmd, evidenceCmd];
}

/**
 * 采纳闭环（经 kernel 写状态仓）：
 *   ① 锁内改快照 input.bindings 登记新绑定（同 id+版本幂等；同 id 不同内容报错）
 *   ② appendCommands 追加 AdoptBacklogEntry + RecordEvidence（观察 → 新地址初始证据）
 *   ③ 内存队列条目转 adopted（退出 active backlog）
 * 返回 { commands, appended }。
 */
export async function adoptEntry(root, backlog, { backlogId, newBinding, checkerId, checkerVersion, inputs, actor, opts }) {
  const entry = backlog.get(backlogId);
  if (!entry) {
    throw backlogError("backlog-entry-missing", `backlog 条目「${backlogId}」不存在。恢复动作：先 proposeObservation 提案。`);
  }
  if (entry.status !== "proposed") {
    throw backlogError("backlog-transition-illegal", `条目「${backlogId}」已处 ${entry.status}，不得采纳（状态机表外转移拒绝）。`);
  }
  const commands = adoptionCommands({ backlogId, newBinding, checkerId, checkerVersion, inputs, actor });
  // ① 登记新绑定进快照 input（fold 的 BacklogAdopted 分支要求新绑定先在绑定集；
  //    写法对齐 kernel deriveArchived 注释预告的「外部直接改快照 input」先例）
  await withLock(root, async () => {
    const snap = readSnapshot(root);
    if (!snap) {
      throw backlogError("state-store-missing", `状态仓未初始化（${root}）。恢复动作：先 kernel.initStateRepo 登记绑定集。`);
    }
    const bindings = [...(snap.input.bindings ?? [])];
    const existing = bindings.find((b) => b.bindingId === newBinding.bindingId);
    if (existing) {
      const same = JSON.stringify(existing) === JSON.stringify(newBinding);
      if (!same) {
        throw backlogError("binding-conflict", `绑定「${newBinding.bindingId}」已登记且内容不同（${JSON.stringify(existing)} vs ${JSON.stringify(newBinding)}）。恢复动作：绑定内容修订走 bindingVersion 升版，不复用旧 id。`);
      }
    } else {
      bindings.push({ ...newBinding });
    }
    writeSnapshotInput(root, { ...snap, input: { ...snap.input, bindings } });
  }, opts);
  // ② 追加事件（appendCommands 内部自取锁；①已释放，无重入）
  const appended = await appendCommands(root, commands, opts);
  // ③ 内存队列转终态
  entry.status = "adopted";
  entry.triaged = { decision: "adopted", reason: null, supersededBy: null };
  entry.address = deriveAddress(newBinding);
  entry.evidence = appended.appendedFacts.find((f) => f.type === "EvidenceRecorded");
  return { commands, appended: appended.appended, evidence: entry.evidence };
}

// 义务摘要派生重导出（新绑定初始证据的 obligationHash 与 fold/证据层同口径）
export { deriveAddress, obligationSummaryHash };
