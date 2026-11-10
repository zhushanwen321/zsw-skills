// legacy-import.mjs — 旧 final 导入：alias 计算、人工映射裁决、四项结构校验、幂等重放
// （sync-conformance-plane U5/M5，§3 终态第七段 + M5 波次 + V2 + D8/SC11/SC13/SC14）
//
// 语义权威（设计 sync-conformance-plane）：
//   段二  旧 F id 导入后只作 alias——旧 F id 永不参与新身份计算（新身份 = 派生差距地址
//         (bindingId, repoId, violationKind)，AX2；V9「旧 F id 永不参与新身份计算」）。
//   U5    检查点：旧档歧义裁决无法映射时保持待裁决；映射必须通过四项结构校验——
//         ① 旧记录引文（映射条目必须引用旧 final 中真实存在的记录原文，且一条引文恰好
//            匹配一条记录——引文命中多条 = 结构非法）
//         ② 绑定存在性（bindingId 必须在当前义务绑定集内）
//         ③ 违例类别合法域（violationKind ∈ kernel VIOLATION_KINDS，且与绑定声明一致——
//            地址派生 (bindingId, repoId, violationKind) 的 repoId/violationKind 不允许与
//            绑定集登记漂移，对齐 kernel/state-fold resolveAddress 的地址一致性校验）
//         ④ 同地址冲突人工确认（多条旧记录映射同一地址且未人工确认即拒绝导入——只有显式
//            confirm 标记的人工映射裁决才能把两条旧记录落到同一新地址）
//   V2    已知 F2-1 夹具回归：论点契约两个真实 F2-1（两个不同义务同旧 id）必须分离为两个
//         差距地址、均保留为证据；只有显式 merge/supersede 事件才能合并语义近似项——本模块
//         永不合并（每条映射独立成证据，同地址无确认即拒绝）。
//   寻址  本模块消费的旧档寻址（dev-flow 段 <docName>.sync/final.json 与归档件
//         final.legacy.json）登记于 skill-data-addressing.md §2「conformance-plane v2 附加
//         寻址」（旧 final 归档件与 tombstone 寻址 + 两变体枚举键行）；常量 LEGACY_ARCHIVE_NAME
//         与 migration/cutover.mjs 同值，以该登记行为路径单一来源。
//   SC11  round 目录 planner/module/fixer 产物作派发史证据：导入时收集 round-N 目录清单作
//         派发史证据随导入结果返回（只读收集，不改写、不复制内容）。
//   SC13/SC14 + D8  显式裁决不入导入源的两类内容（见 IMPORT_EXCLUSIONS 注释登记）：
//         exempted.json（与 final.json exemptList 字段同一数组的双落点，final.json 已完整
//         承载豁免史）与 retirement / retireCleanup 字段（退役清理能力不迁移 v2，两字段随
//         final.legacy.json 归档保留、可人读找回）。
//
// 幂等重放：同输入（同一旧档 + 同一映射文件）重跑导入得到同一终态——待追加事实与事件流中
// 已有事实逐字段相等时跳过（不重复追加）；导入证据 facts 本身由确定性输入（记录内容哈希 +
// 绑定摘要）派生，重放稳定（V2「重放导入……重放稳定」）。幂等键无法落事件字段（kernel
// schema 词表纪律禁 schema 外字段），以「事实全等即已导入」为判定——对齐 AX3 派生一致性。

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { VIOLATION_KINDS, canonicalJson, obligationSummaryHash } from "../kernel/facts.mjs";
import { computeEvidence, hashContent } from "../kernel/evidence.mjs";
import { readEvents, readSnapshot, appendCommands, withLock } from "../kernel/state-repo.mjs";

// ---------------------------------------------------------------------------
// 常量与显式裁决登记
// ---------------------------------------------------------------------------

/** 导入证据的 checker 登记（legacy 差距导入不是 checker run——以专用 checkerId 入流，
 *  使 AX4 五要素齐备且孤儿证据检测（state-fold.findOrphanEvidence 的 checker-run 维度）
 *  在 state 仓 checkerRuns 登记本条目后通过） */
export const LEGACY_IMPORT_CHECKER_ID = "legacy-import";
export const LEGACY_IMPORT_CHECKER_VERSION = "1.0.0";

/** 旧档归档件名（cutover.mjs 同值——改名归档产物；词表一致性由 tests 断言） */
export const LEGACY_ARCHIVE_NAME = "final.legacy.json";

/** 不入导入源的两类内容（显式裁决登记——设计 SC13/SC14 + D8；恢复通道 = 归档件人读）：
 *  1. exempted.json 文件：fixer 豁免申报原文，与 final.json 的 exemptList 字段完全同构
 *     （同一数组的双落点，SC13），final.json 已完整承载豁免史（id/word/reason 三元组），
 *     迁移后豁免史仅剩 final.json 终态字段，v2 的 waived 终态由它导入——本模块永不读取
 *     exempted.json（只打开 final.json / final.legacy.json 单一文档）。
 *  2. retirement / retireCleanup 字段：退役移动史与待清理状态——退役清理能力不迁移 v2
 *     （D8 不采用栏 + SC14 逐写点去向），两字段随 final.legacy.json 归档保留；导入时从
 *     记录与文档根剥除，证据事实只承载差距语义。
 */
export const IMPORT_EXCLUSIONS = Object.freeze({
  neverReadFiles: Object.freeze(["exempted.json"]),
  strippedRecordFields: Object.freeze(["retirement", "retireCleanup"]),
});

/** 映射条目引文匹配的记录字段缺省扫描集（引文 = 记录原文的逐字摘录；命中判定 =
 *  记录序列化文本包含引文，且命中必须恰好一条记录——多条命中即结构非法） */
const QUOTE_SCAN_FIELDS = ["gap", "issue", "summary", "description", "note", "evidence"];

function importError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function stripExcludedFields(value) {
  if (Array.isArray(value)) return value.map(stripExcludedFields);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (IMPORT_EXCLUSIONS.strippedRecordFields.includes(k)) continue;
      out[k] = stripExcludedFields(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 旧档读取与记录抽取
// ---------------------------------------------------------------------------

/**
 * 读旧 final 并抽取旧记录数组。recordsPath 缺省 "records"；文档根与记录先剥除
 * IMPORT_EXCLUSIONS.strippedRecordFields（SC13/SC14 显式裁决——不入导入源）。
 * exempted.json 在读取前即拒绝（neverReadFiles：只打开单一旧档文档）。
 */
export function readLegacyFinal(legacyFinalPath, { recordsPath = "records" } = {}) {
  const base = basename(legacyFinalPath);
  if (IMPORT_EXCLUSIONS.neverReadFiles.includes(base)) {
    throw importError(
      "exempted-file-not-importable",
      `${base} 不入导入源（SC13 显式裁决：与 final.json exemptList 字段同构的双落点，豁免史由 final.json 承载）。` +
        `恢复动作：对 final.json（或归档件 ${LEGACY_ARCHIVE_NAME}）发起导入。`,
    );
  }
  if (!existsSync(legacyFinalPath)) {
    throw importError("legacy-final-missing", `旧档不存在：${legacyFinalPath}。恢复动作：核对 dev-flow 段寻址（<docName>.sync/final.json，已切换包为 ${LEGACY_ARCHIVE_NAME}）后重发。`);
  }
  const raw = readFileSync(legacyFinalPath, "utf8");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw importError("legacy-final-invalid-json", `旧档不是合法 JSON（${legacyFinalPath}）：${e.message}。恢复动作：核对文件完整性后重发。`);
  }
  const cleaned = stripExcludedFields(doc);
  let records = cleaned;
  for (const seg of recordsPath.split(".")) {
    records = records?.[seg];
  }
  if (!Array.isArray(records)) {
    throw importError(
      "legacy-records-missing",
      `旧档未在 "${recordsPath}" 找到记录数组（recordsPath 可按旧档形态传入）。恢复动作：确认旧档记录路径后重发。`,
    );
  }
  return { doc: cleaned, records };
}

/** 单条旧记录的引文源文本（记录序列化；排除字段已剥除——引文不可引用不入导入源的内容） */
function recordText(record) {
  return JSON.stringify(record);
}

/**
 * 引文 → 记录匹配（四项校验①的实现原语）。返回匹配记录数组；length !== 1 = 引文校验失败。
 * 引文扫描优先 QUOTE_SCAN_FIELDS 逐字段精确包含，任一字段包含引文即命中该记录；
 * 字段扫描无命中时退回整记录序列化包含（引文允许跨字段摘录）。
 */
export function matchRecordByQuote(records, quote) {
  const q = String(quote ?? "").trim();
  if (q === "") return [];
  const fieldHits = records.filter((r) =>
    QUOTE_SCAN_FIELDS.some((f) => typeof r?.[f] === "string" && r[f].includes(q)),
  );
  if (fieldHits.length > 0) return fieldHits;
  return records.filter((r) => recordText(r).includes(q));
}

// ---------------------------------------------------------------------------
// 人工映射裁决接口（rulings-map 解析 + 四项结构校验）
// ---------------------------------------------------------------------------

/**
 * 解析并校验映射文件（人工映射裁决接口；不写盘）。
 * 映射文件形态：{ package?, mappings: [{ legacyId, recordQuote, bindingId, repoId,
 * violationKind, reason, confirm? }] }——V2：「每条含旧记录引文、bindingId、repoId、
 * violationKind 与理由」。
 * bindings = 当前义务绑定集（[{ bindingId, repoId, violationKind, bindingVersion? }]）。
 * 返回 { ok, errors, mappings }；mappings 每条补全 { record, address, alias }。
 * ok=false 时 mappings 仅含通过校验的条目（调用方不得用部分结果写盘）。
 */
export function parseRulingsMap(raw, { legacyRecords, bindings, recordsPathLabel = "records" }) {
  let map;
  try {
    map = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, errors: [{ code: "map-invalid-json", detail: `映射文件不是合法 JSON：${e.message}。恢复动作：修正 JSON 后重发。` }], mappings: [] };
  }
  if (map === null || typeof map !== "object" || Array.isArray(map) || !Array.isArray(map.mappings)) {
    return { ok: false, errors: [{ code: "map-shape", detail: "映射文件必须是 { mappings: [...] } 对象。恢复动作：按四字段映射条目形态重写。" }], mappings: [] };
  }
  const errors = [];
  const bindingsById = new Map(bindings.map((b) => [b.bindingId, b]));
  const addressCount = new Map();

  const validated = [];
  map.mappings.forEach((m, i) => {
    const label = `mappings[${i}]`;
    const entry = { ...m };
    // ① 旧记录引文：引文必须恰好命中一条旧记录
    const hits = matchRecordByQuote(legacyRecords, m.recordQuote);
    if (hits.length !== 1) {
      errors.push({
        code: "quote-unresolvable",
        detail:
          `${label} 引文校验失败（四项校验①）：引文命中 ${hits.length} 条记录（要求恰好 1 条）。` +
          `恢复动作：从旧档 ${recordsPathLabel} 记录原文中摘录唯一可定位的引文后重发。`,
      });
      return;
    }
    const record = hits[0];
    // ② 绑定存在性
    const binding = bindingsById.get(m.bindingId);
    if (!binding) {
      errors.push({
        code: "binding-missing",
        detail:
          `${label} 绑定存在性校验失败（四项校验②）：bindingId「${String(m.bindingId ?? "缺失")}」不在当前义务绑定集。` +
          `恢复动作：先为切入包补 conformance 绑定并生成义务表（V1 流程），或修正 bindingId。`,
      });
      return;
    }
    // ③ 违例类别合法域 + 与绑定声明一致
    if (!VIOLATION_KINDS.includes(m.violationKind)) {
      errors.push({
        code: "violation-kind-illegal",
        detail:
          `${label} 违例类别校验失败（四项校验③）：「${String(m.violationKind ?? "缺失")}」不在词表（${VIOLATION_KINDS.join(" / ")}）。` +
          `权威源：kernel/facts.mjs VIOLATION_KINDS。恢复动作：改用词表内类别后重发。`,
      });
      return;
    }
    if (binding.repoId !== m.repoId || binding.violationKind !== m.violationKind) {
      errors.push({
        code: "address-binding-mismatch",
        detail:
          `${label} 地址一致性校验失败（四项校验③的绑定对账）：bindingId「${m.bindingId}」在绑定集声明 (${binding.repoId}, ${binding.violationKind})，` +
          `映射条目携带 (${m.repoId}, ${m.violationKind})。恢复动作：repoId/violationKind 与绑定集登记一致后重发（AX2 地址派生）。`,
      });
      return;
    }
    // ④ 同地址冲突人工确认（先计数，统一下判——确认标记逐条检查）
    const address = { bindingId: binding.bindingId, repoId: binding.repoId, violationKind: binding.violationKind };
    const key = canonicalJson(address);
    addressCount.set(key, [...(addressCount.get(key) ?? []), { index: i, entry, record }]);
    validated.push({ index: i, entry: { ...m }, record, address, binding });
  });

  // ④ 同地址冲突：多条映射同一地址且未逐条人工确认（confirm: true）→ 整批拒绝
  for (const [key, group] of addressCount) {
    if (group.length > 1) {
      const missing = group.filter((g) => g.entry.confirm !== true);
      if (missing.length > 0) {
        errors.push({
          code: "address-conflict-unconfirmed",
          detail:
            `同地址冲突校验失败（四项校验④）：地址 ${key} 被 ${group.length} 条映射共享（mappings 序号 ${group.map((g) => g.index).join("、")}），` +
            `其中 ${missing.map((g) => g.index).join("、")} 未携带 confirm: true 人工确认。` +
            `恢复动作：语义近似项须分流到不同绑定义务（F2-1 模式），或对确属同一差距的重复记录逐条补 confirm: true 后重发。`,
        });
      }
    }
  }

  // 通过校验的条目补全 alias 与记录定位（alias = 旧 id 的索引化别名，永不参与新身份）
  const ok = errors.length === 0;
  const mappings = ok
    ? validated.map((v, order) => {
        const occurrence = validated
          .slice(0, order + 1)
          .filter((x) => x.entry.legacyId === v.entry.legacyId).length;
        return {
          ...v.entry,
          record: v.record,
          address: v.address,
          binding: v.binding,
          alias: computeAlias(v.entry.legacyId, occurrence),
        };
      })
    : [];
  return { ok, errors, mappings };
}

/** alias 计算：`legacy:<旧id>#<同 id 第几次出现>`——旧 F id 只作别名（段二），永不参与新身份 */
export function computeAlias(legacyId, occurrence = 1) {
  return `legacy:${String(legacyId ?? "unknown")}#${occurrence}`;
}

// ---------------------------------------------------------------------------
// 派发史证据收集（SC11：round 目录 planner/module/fixer 产物）
// ---------------------------------------------------------------------------

/**
 * 收集旧档同目录 round-N 目录的派发史证据（只读；planner/module/fixer 产物文件名清单）。
 * 返回 [{ round, dir, artifacts }]；目录不存在返回空数组（旧档无 round 产物是合法形态）。
 */
export function collectRoundEvidence(syncDir) {
  if (!existsSync(syncDir) ) return [];
  const rounds = readdirSync(syncDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^round-\d+$/.test(d.name))
    .sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)));
  return rounds.map((d) => {
    const dir = join(syncDir, d.name);
    return { round: Number(d.name.slice(6)), dir, artifacts: readdirSync(dir).sort() };
  });
}

// ---------------------------------------------------------------------------
// 导入主入口（幂等重放）
// ---------------------------------------------------------------------------

/**
 * 导入事实的幂等键（语义内容，不含 seq/ts/actor 墙钟项）：同输入重放生成同键——
 * 键已在流内 = 已导入，跳过。判等取确定性子集（地址 + 义务摘要 + checker + 输入哈希集 +
 * 结果），ts/actor 不参与（重放时刻与执行者不影响导入语义）。
 */
function importSemanticKey(payload) {
  return canonicalJson({
    type: "EvidenceRecorded",
    address: payload.address,
    obligationHash: payload.obligationHash,
    checkerId: payload.checkerId,
    checkerVersion: payload.checkerVersion,
    bindingVersion: payload.bindingVersion,
    inputs: payload.inputs,
    result: payload.result,
  });
}

function buildImportCommands({ mappings, legacyFinalPath, actor }) {
  const archiveLabel = basename(legacyFinalPath);
  return mappings.map((m) => {
    // 导入证据 = 该旧记录在新地址上的初始 fail 证据（对齐 BacklogAdopted「观察转新地址
    // 初始证据」语义）；输入绑定记录内容哈希（AX4：证据绑定被检内容——记录原文即被检物）。
    // 写通道 = RecordEvidence 命令（kernel appendCommands：命令校验 → seq/ts 分配 → 入流，
    // 与集成器/backlog 采纳同一命令层通道；seq/ts 由仓库统一分配，导入方不自编）
    const recordHash = hashContent(recordText(m.record));
    const payload = computeEvidence({
      address: m.address,
      binding: m.binding,
      checkerId: LEGACY_IMPORT_CHECKER_ID,
      checkerVersion: LEGACY_IMPORT_CHECKER_VERSION,
      inputs: [{ name: `legacy:${archiveLabel}#${mappings.indexOf(m)}`, hash: recordHash }],
      result: "fail",
    });
    return { type: "RecordEvidence", actor, payload };
  });
}

/**
 * 旧 final 导入（幂等重放；唯一写路径 = kernel appendCommands 命令层，AX3/AX10——与集成器、
 * backlog 采纳同一通道，seq/ts 由仓库在锁内统一分配，导入方不自编）。
 *   legacyFinalPath  旧档路径（final.json 或归档件 final.legacy.json）
 *   mapRaw           映射文件原文（字符串或对象；人工映射裁决产物）
 *   bindings         当前义务绑定集
 *   stateRoot        状态仓根（导入证据落流的唯一权威地）
 *   actor            导入执行者（审计字段）
 * 返回 { imported, skipped, aliases, addresses, facts, roundEvidence }；
 * 幂等：待追加事实与流内已有事实逐字段相等 → 跳过（skipped 计数），重放后终态不变。
 */
export async function importLegacyFinal({ legacyFinalPath, mapRaw, bindings, stateRoot, actor = "main-agent" }) {
  if (!existsSync(stateRoot)) {
    throw importError("state-store-missing", `状态仓不存在：${stateRoot}。恢复动作：先为切入包初始化状态仓（v2 引擎首跑或 kernel.initStateRepo）。`);
  }
  const { doc, records } = readLegacyFinal(legacyFinalPath);
  const verdict = parseRulingsMap(mapRaw, { legacyRecords: records, bindings });
  if (!verdict.ok) {
    // 结构校验失败整批拒绝（不部分导入）——错误带四项校验编号与恢复动作（错误契约）
    const err = importError(
      "legacy-map-invalid",
      `映射文件未通过结构校验（${verdict.errors.length} 处），整批拒绝导入：\n${verdict.errors.map((e) => `- [${e.code}] ${e.detail}`).join("\n")}`,
    );
    err.errors = verdict.errors;
    throw err;
  }

  const syncDir = dirnameOf(legacyFinalPath);
  const roundEvidence = collectRoundEvidence(syncDir);

  // legacy-import checker 登记（孤儿证据检测的 checker-run 维度要求登记在案；对齐 backlog
  // 采纳的「锁内直改快照 input」先例——kernel deriveArchived 注释预告通道）
  await withLock(stateRoot, async () => {
    const snap = readSnapshot(stateRoot);
    if (!snap) {
      throw importError("state-store-missing", `状态仓未初始化（缺 snapshot.json）：${stateRoot}。恢复动作：先 initStateRepo。`);
    }
    const checkerRuns = [...(snap.input.checkerRuns ?? [])];
    const has = checkerRuns.some((c) => c.checkerId === LEGACY_IMPORT_CHECKER_ID && c.checkerVersion === LEGACY_IMPORT_CHECKER_VERSION);
    if (!has) {
      checkerRuns.push({ checkerId: LEGACY_IMPORT_CHECKER_ID, checkerVersion: LEGACY_IMPORT_CHECKER_VERSION });
      writeFileSync(join(stateRoot, "snapshot.json"), JSON.stringify({ ...snap, input: { ...snap.input, checkerRuns } }, null, 2));
    }
  });

  const existing = readEvents(stateRoot);
  const candidateCommands = buildImportCommands({ mappings: verdict.mappings, legacyFinalPath, actor });
  const existingKeys = new Set(existing.filter((f) => f.type === "EvidenceRecorded").map((f) => importSemanticKey(f)));
  const freshCommands = candidateCommands.filter((c) => !existingKeys.has(importSemanticKey(c.payload)));
  const skipped = candidateCommands.length - freshCommands.length;

  let appendedFacts = [];
  if (freshCommands.length > 0) {
    const appended = await appendCommands(stateRoot, freshCommands);
    appendedFacts = appended.appendedFacts;
  }

  return {
    imported: appendedFacts.length,
    skipped,
    aliases: verdict.mappings.map((m) => ({ legacyId: m.legacyId, alias: m.alias, address: m.address })),
    addresses: verdict.mappings.map((m) => m.address),
    facts: appendedFacts,
    roundEvidence,
    obligationHashes: verdict.mappings.map((m) => obligationSummaryHash(m.binding)),
    docRootKeys: Object.keys(doc),
  };
}

function dirnameOf(p) {
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : ".";
}
