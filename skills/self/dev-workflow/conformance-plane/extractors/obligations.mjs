// obligations.mjs — 义务提取器：章节 JSON → 义务表（sync-conformance-plane U2/M2）
//
// 语义权威（设计 sync-conformance-plane）：
//   AX1  义务 id 来自章节 JSON 的人工稳定 id 与版本，不由 agent / 运行轮次生成
//   AX2  差距地址 = (bindingId, repoId, violationKind)，bindingId 指向章节 JSON 内带
//        conformance 绑定的稳定条目（= 条目 id，或条目 id + "-" + 后缀——同条目多绑定）
//   AX8  覆盖率分母只包含带 conformance 绑定的义务；无绑定叙述不进分母，只列未绑定清单
//   段一 conformance 字段规格 = tech-design-v2/references/design-doc-schema.md §9b
//        （conformance schemaVersion 2；扩词表必须升 schema 版本）
//   段三 义务摘要 = 规范化绑定 JSON 的内容哈希（facts.obligationSummaryHash）
//
// 提取器是确定性计算层：同输入两次提取产出逐字节相同的义务表（G1 --replay-stable / V1）；
// 非法绑定 fail-fast 抛错（带 err.code 与恢复动作），不静默跳过——设计包机器契约的合法性
// 由 check-design-doc.mjs 规则 4 扩展段在写作期拦截，本提取器按同一规格再校验（双端同规）。

import { createHash } from "node:crypto";
import { VIOLATION_KINDS, deriveAddress, obligationSummaryHash } from "../kernel/facts.mjs";

/** conformance 字段规格版本（权威登记：design-doc-schema.md §9b；扩词表/扩字段必须升版本） */
export const CONFORMANCE_SCHEMA_VERSION = 2;

/** violationKind 词表重导出（唯一权威 = kernel/facts.mjs；防消费方各自拷贝词表分裂） */
export { VIOLATION_KINDS };

/** severity 初始词表（§9b；与现行审查等级词表同源；扩词表必须升 schema 版本） */
export const SEVERITY_KINDS = Object.freeze(["must-fix", "suggestion", "info"]);

// 条目数组清单：与 check-design-doc.mjs 规则 2 的 ID_ARRAYS 同一张表（file, 标注路径, 取值函数）
// ——绑定只可能出现在有稳定 id 的条目上，无 id 数组（如 assumptionExclusions）不进提取范围
const OBLIGATION_ENTRY_ARRAYS = [
  ["s1-context.json", "goals", (d) => d.goals],
  ["s2-status.json", "problems", (d) => d.problems],
  ["s2-status.json", "assumptions", (d) => d.assumptions],
  ["s2-status.json", "artifactTables.stateCopies", (d) => d.artifactTables?.stateCopies],
  ["s2-status.json", "artifactTables.signalImplications", (d) => d.artifactTables?.signalImplications],
  ["s2-status.json", "artifactTables.repairHistory", (d) => d.artifactTables?.repairHistory],
  ["s2-status.json", "artifactTables.upstreamDeps", (d) => d.artifactTables?.upstreamDeps],
  ["s3-solution.json", "terminalForm.axioms", (d) => d.terminalForm?.axioms],
  ["s3-solution.json", "terminalForm.gapTable", (d) => d.terminalForm?.gapTable],
  ["s3-solution.json", "options", (d) => d.options],
  ["s3-solution.json", "decisions", (d) => d.decisions],
  ["s3-solution.json", "migrationWaves", (d) => d.migrationWaves],
  ["s4-accept.json", "scenarios", (d) => d.scenarios],
  ["s4-accept.json", "assertionRedlights", (d) => d.assertionRedlights],
  ["s5-breakdown.json", "units", (d) => d.units],
];

function extractionError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertNonEmptyString(value, code, label, where) {
  if (typeof value !== "string" || value.trim() === "") {
    throw extractionError(code, `${where} ${label} 缺失或为空。恢复动作：按 design-doc-schema.md §9b 补齐后重跑提取。`);
  }
  return value;
}

/**
 * 归一化绑定身份四元组 → 义务表行基座（两条提取通道共用：章节 JSON 绑定与状态仓绑定集）。
 * raw = { bindingId, repoId, violationKind, bindingVersion? }；bindingVersion 缺省 1。
 * 非法输入抛错（err.code）：
 *   invalid-binding-shape    绑定不是对象
 *   invalid-binding-id       bindingId 缺失、为空或未锚定宿主条目（anchorEntryId 给定时检查）
 *   invalid-binding-field    repoId 缺失或为空
 *   invalid-violation-kind   violationKind 不在词表
 *   invalid-binding-version  bindingVersion 非 ≥1 整数
 */
export function normalizeBindingIdentity(raw, { where, anchorEntryId } = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw extractionError("invalid-binding-shape", `${where ?? "binding"} 绑定须为对象。恢复动作：按 design-doc-schema.md §9b 修正形态。`);
  }
  const bindingId = raw.bindingId ?? anchorEntryId;
  assertNonEmptyString(bindingId, "invalid-binding-id", "bindingId", where ?? "binding");
  if (anchorEntryId !== undefined && bindingId !== anchorEntryId && !bindingId.startsWith(`${anchorEntryId}-`)) {
    throw extractionError(
      "invalid-binding-id",
      `${where} bindingId「${bindingId}」未锚定宿主条目「${anchorEntryId}」（须 = 条目 id 或条目 id + "-" + 后缀）。恢复动作：改绑定 id 或核对宿主条目。`,
    );
  }
  const repoId = assertNonEmptyString(raw.repoId, "invalid-binding-field", "repoId", where ?? "binding");
  if (!VIOLATION_KINDS.includes(raw.violationKind)) {
    throw extractionError(
      "invalid-violation-kind",
      `${where ?? "binding"} violationKind「${String(raw.violationKind ?? "缺失")}」不在词表（${VIOLATION_KINDS.join(" / ")}）。恢复动作：改用词表内值；扩词表须升 conformance schema 版本。`,
    );
  }
  const bindingVersion = raw.bindingVersion ?? 1;
  if (typeof bindingVersion !== "number" || !Number.isInteger(bindingVersion) || bindingVersion < 1) {
    throw extractionError("invalid-binding-version", `${where ?? "binding"} bindingVersion 须为 ≥1 整数（缺省 1）。恢复动作：修正版本号。`);
  }
  // 身份四元组：义务摘要哈希与差距地址的唯一输入（golden corpus 夹具 obligationHash 同此口径，
  // 2026-11-10 实测 obligationSummaryHash 吻合）
  const identity = { bindingId, repoId, violationKind: raw.violationKind, bindingVersion };
  return {
    bindingId,
    repoId,
    violationKind: raw.violationKind,
    bindingVersion,
    binding: identity,
    address: deriveAddress(identity),
    summaryHash: obligationSummaryHash(identity),
  };
}

/**
 * 归一化单条章节 JSON 绑定 → 义务表行（身份四元组 + 检查契约字段）。
 * 检查契约字段（targetSelector / checkerId / severity / evidenceInputs）变化不改变地址与
 * 义务摘要——证据有效期由输入哈希 + checker 版本 + 绑定版本判定（AX4/D3）。
 * 在 normalizeBindingIdentity 的错误码之上增加：
 *   invalid-contract-field   targetSelector / checkerId 缺失或为空
 *   invalid-severity         severity 不在词表
 *   invalid-evidence-inputs  evidenceInputs 缺失 / 为空 / 元素非法 / 组内重复
 */
export function normalizeBinding(binding, { entryId, where }) {
  const base = normalizeBindingIdentity(binding, { where, anchorEntryId: entryId });
  const targetSelector = assertNonEmptyString(binding.targetSelector, "invalid-contract-field", "targetSelector", where);
  const checkerId = assertNonEmptyString(binding.checkerId, "invalid-contract-field", "checkerId", where);
  if (!SEVERITY_KINDS.includes(binding.severity)) {
    throw extractionError(
      "invalid-severity",
      `${where} severity「${String(binding.severity ?? "缺失")}」不在词表（${SEVERITY_KINDS.join(" / ")}）。恢复动作：改用词表内值；扩词表须升 conformance schema 版本。`,
    );
  }
  const inputs = binding.evidenceInputs;
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw extractionError("invalid-evidence-inputs", `${where} evidenceInputs 缺失或为空（须非空字符串数组）。恢复动作：登记检查依赖输入清单。`);
  }
  const seenInputs = new Set();
  for (const input of inputs) {
    assertNonEmptyString(input, "invalid-evidence-inputs", `evidenceInputs 元素「${String(input)}」`, where);
    if (seenInputs.has(input)) {
      throw extractionError("invalid-evidence-inputs", `${where} evidenceInputs 组内重复：「${input}」。恢复动作：去重后重跑。`);
    }
    seenInputs.add(input);
  }
  return { ...base, targetSelector, checkerId, severity: binding.severity, evidenceInputs: [...inputs] };
}

function tableVersionOf(obligations, projection) {
  // 义务表版本：规范化义务集字段子集的确定性内容哈希（同输入重放逐字节一致；绑定集或契约
  // 字段变化即升版）。含 CONFORMANCE_SCHEMA_VERSION：词表/字段规格升版使旧表版本自然失效。
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: CONFORMANCE_SCHEMA_VERSION, obligations: obligations.map(projection) }))
    .digest("hex");
}

/**
 * 六章节 JSON → 义务表。docs = { "meta.json": …, "s1-context.json": …, … }（章节缺失按空处理）。
 * 返回 { tableVersion, obligations, unbound, stats }：
 *   obligations — 绑定条目展开的义务行（每绑定一条），按 bindingId 排序（重放形态稳定）；
 *                 行含 entry 溯源 { file, path, id }
 *   unbound     — 未绑定声明清单 [{ file, path, id }]（AX8：不进覆盖率分母，只列清单）
 *   stats       — { totalEntries, boundEntries, bindings, unboundEntries, machineCheckableRatio }
 *                 可机械检查比例 = 带绑定条目数 / 条目总数（绑定是机器契约，无绑定叙述只能语义审查）
 *   tableVersion — 义务表版本（身份四元组 + 检查契约字段的字段子集哈希）
 * 抛错（err.code）：
 *   duplicate-binding-id  bindingId 包内重复（地址身份键须唯一）
 *   normalizeBindingIdentity / normalizeBinding 的全部 err.code
 */
export function extractObligations(docs) {
  const obligations = [];
  const unbound = [];
  const bindingLocations = new Map(); // bindingId -> 首次登记位置
  const entryIdLocations = new Map(); // 章节条目 id -> 登记位置（bindingId 撞名检查的对照集）
  let totalEntries = 0;
  let boundEntries = 0;
  for (const [file, path, getItems] of OBLIGATION_ENTRY_ARRAYS) {
    const doc = docs?.[file];
    if (doc === undefined || doc === null) continue;
    const items = getItems(doc);
    if (!Array.isArray(items)) continue;
    items.forEach((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return;
      totalEntries += 1;
      if (typeof entry.id === "string" && entry.id.trim() !== "" && !entryIdLocations.has(entry.id)) {
        entryIdLocations.set(entry.id, `${file} ${path}[${i}]`);
      }
      if (entry.conformance === undefined) {
        if (typeof entry.id === "string" && entry.id.trim() !== "") {
          unbound.push({ file, path: `${path}[${i}]`, id: entry.id });
        }
        return;
      }
      if (typeof entry.id !== "string" || entry.id.trim() === "") {
        throw extractionError("invalid-binding-id", `${file} ${path}[${i}] 条目缺稳定 id，不得声明 conformance。恢复动作：补条目 id 或移除绑定。`);
      }
      boundEntries += 1;
      const isMulti = Array.isArray(entry.conformance);
      if (isMulti && entry.conformance.length === 0) {
        throw extractionError("invalid-binding-shape", `${file} ${path}[${i}]（${entry.id}）conformance 为空数组——声明绑定至少登记一条绑定对象；无绑定时删除该字段。恢复动作：补绑定或移除字段。`);
      }
      const bindings = isMulti ? entry.conformance : [entry.conformance];
      bindings.forEach((binding, k) => {
        const where = `${file} ${path}[${i}]（${entry.id}）.conformance${isMulti ? `[${k}]` : ""}`;
        const obligation = normalizeBinding(binding, { entryId: entry.id, where });
        if (bindingLocations.has(obligation.bindingId)) {
          throw extractionError(
            "duplicate-binding-id",
            `bindingId「${obligation.bindingId}」重复定义于 ${bindingLocations.get(obligation.bindingId)} 与 ${where}。恢复动作：绑定 id 包内唯一（同条目多绑定用「条目 id-后缀」形态）。`,
          );
        }
        bindingLocations.set(obligation.bindingId, where);
        obligations.push({ ...obligation, entry: { file, path: `${path}[${i}]`, id: entry.id } });
      });
    });
  }
  obligations.sort((a, b) => (a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0));
  // bindingId 与章节条目 id 撞名检查（宿主自身 id 之外占用任何全局条目 id = 状态仓绑定集撞身份；
  // 与 check-design-doc.mjs 规则 4 扩展段的 globalIdLocations 检查同规）
  for (const o of obligations) {
    const loc = `${o.entry.file} ${o.entry.path}`;
    if (o.bindingId !== o.entry.id && entryIdLocations.has(o.bindingId)) {
      throw extractionError(
        "duplicate-binding-id",
        `bindingId「${o.bindingId}」与章节条目 id 撞名（已定义于 ${entryIdLocations.get(o.bindingId)}）。恢复动作：绑定 id 改用「${o.entry.id}-后缀」形态。`,
      );
    }
  }
  return {
    tableVersion: tableVersionOf(obligations, (o) => ({
      binding: o.binding,
      targetSelector: o.targetSelector,
      checkerId: o.checkerId,
      severity: o.severity,
      evidenceInputs: o.evidenceInputs,
    })),
    obligations,
    unbound,
    stats: {
      totalEntries,
      boundEntries,
      bindings: obligations.length,
      unboundEntries: unbound.length,
      machineCheckableRatio: totalEntries === 0 ? null : boundEntries / totalEntries,
    },
  };
}

/**
 * 绑定集 → 义务表行（状态仓 input.bindings 形态的消费入口：golden corpus 夹具与
 * BacklogAdopted 新绑定走同一归一化，不经章节 JSON）。bindings 元素 = 身份四元组
 * { bindingId, repoId, violationKind, bindingVersion? }；无检查契约字段（夹具形态只有身份），
 * tableVersion 只取身份四元组字段子集。duplicate-binding-id 抛错。
 */
export function obligationsFromBindingSet(bindings, { where = "binding-set" } = {}) {
  if (!Array.isArray(bindings)) {
    throw extractionError("invalid-binding-shape", `${where} 须为绑定数组。恢复动作：传状态仓 input.bindings 形态的数组。`);
  }
  const seen = new Map();
  const obligations = bindings.map((binding, i) => {
    const o = normalizeBindingIdentity(binding, { where: `${where}[${i}]` });
    if (seen.has(o.bindingId)) {
      throw extractionError("duplicate-binding-id", `bindingId「${o.bindingId}」重复定义于 ${seen.get(o.bindingId)} 与 ${where}[${i}]。恢复动作：绑定 id 唯一。`);
    }
    seen.set(o.bindingId, `${where}[${i}]`);
    return o;
  });
  obligations.sort((a, b) => (a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0));
  return { tableVersion: tableVersionOf(obligations, (o) => ({ binding: o.binding })), obligations };
}
