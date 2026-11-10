// evidence.mjs — 证据结构与哈希有效期（sync-conformance-plane U1/M1）
//
// 语义权威（设计 sync-conformance-plane）：
//   AX4  每条判断证据必须记录被检义务、checker 输入集合及每个输入的内容哈希、
//        checker id 与版本、结果和执行者；任一输入哈希变化即证据失效
//   段三 evidenceValid 当且仅当全部输入哈希、checker 版本与绑定版本仍等值；
//        义务摘要 = 规范化绑定 JSON 的内容哈希
//   D3/G3/V3  证据绑定 artifact 哈希，内容变化自动失效且失效原因可查；
//        状态谓词（verified 等）由证据有效性派生、不存储
//
// 证据只绑定被检输入的**内容哈希**，不绑定 HEAD/ref 指针——round-3「工作区内容正确但 HEAD 旧」
// 的误判模式由此在读侧结构上不可能复发（golden corpus opendesign 夹具固化该性质）。

import { createHash } from "node:crypto";
import { obligationSummaryHash } from "./facts.mjs";

/** 内容哈希原语（sha256 hex；夹具与 wrapper 共用同一口径） */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 构造证据记录负载（EvidenceRecorded 事实去掉 seq/ts 的部分，AX4 五要素齐备）。
 * 返回值可直接与 { type, seq, ts } 组合成完整事实并过 facts.validateFact。
 */
export function computeEvidence({ address, binding, checkerId, checkerVersion, inputs, result = "pass", actor, changesetId }) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    const err = new Error("证据必须携带非空输入集合（AX4：无输入的证据不可判定有效性）");
    err.code = "evidence-inputs-required";
    throw err;
  }
  const record = {
    address: { ...address },
    obligationHash: obligationSummaryHash(binding),
    checkerId,
    checkerVersion,
    bindingVersion: binding.bindingVersion,
    inputs: inputs.map((i) => ({ name: i.name, hash: i.hash })),
    result,
  };
  if (changesetId !== undefined) record.changesetId = changesetId;
  if (actor !== undefined) record.actor = actor;
  return record;
}

/**
 * 证据有效性判定（D3：全部输入、checker 版本与绑定版本仍等值 → 有效）。
 * world = { bindings, checkerRuns, artifacts }——artifacts 是「当前输入名 → 当前内容哈希」表。
 * 返回 { valid, reasons }；reasons 每项 { code, ... }，code 词表：
 *   content-changed        输入内容哈希与当前不等（含 input 名）
 *   artifact-missing       输入在当前 artifact 表中不存在
 *   checker-version-changed checker 当前登记不含该版本
 *   binding-version-changed 绑定版本已升版
 *   obligation-changed     绑定内容漂移而版本未 bump（义务摘要比对，防义务漂移漏洞）
 */
export function evaluateEvidence(evidence, { bindings = [], checkerRuns = [], artifacts = {} }) {
  const reasons = [];
  const binding = bindings.find((b) => b.bindingId === evidence.address.bindingId);
  if (!binding) {
    reasons.push({ code: "binding-missing", bindingId: evidence.address.bindingId });
  } else {
    if (binding.bindingVersion !== evidence.bindingVersion) {
      reasons.push({ code: "binding-version-changed", expected: evidence.bindingVersion, actual: binding.bindingVersion });
    }
    const currentSummary = obligationSummaryHash(binding);
    if (currentSummary !== evidence.obligationHash) {
      reasons.push({ code: "obligation-changed", expected: evidence.obligationHash, actual: currentSummary });
    }
  }
  const checkerAlive = checkerRuns.some((c) => c.checkerId === evidence.checkerId && c.checkerVersion === evidence.checkerVersion);
  if (!checkerAlive) {
    reasons.push({ code: "checker-version-changed", checkerId: evidence.checkerId, checkerVersion: evidence.checkerVersion });
  }
  for (const input of evidence.inputs) {
    const current = artifacts[input.name];
    if (current === undefined) {
      reasons.push({ code: "artifact-missing", input: input.name });
    } else if (current !== input.hash) {
      reasons.push({ code: "content-changed", input: input.name, expected: input.hash, actual: current });
    }
  }
  return { valid: reasons.length === 0, reasons };
}
