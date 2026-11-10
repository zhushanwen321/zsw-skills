// cutover.mjs — 按设计包灰度切换与归档包复活（sync-conformance-plane U5/M5，D8/GA10/V9/RL11）
//
// 语义权威（设计 sync-conformance-plane §3 终态第七段 + M5 波次 + D8）：
//   D8    按设计包灰度切换，旧引擎只读。cutover 标记由旧 W4 setup 与 flow/sync.md 手工入口
//         第一步拒启检查（design-code-sync-loop.shared.ts cutoverGuardBlock，u-m4 已落地）；
//         旧引擎不写 v2 状态、不接适配层。退役清理能力显式裁决不迁移 v2（retirement /
//         retireCleanup 随 final.legacy.json 归档、不入导入源——legacy-import.mjs IMPORT_EXCLUSIONS）。
//   段七  标记写入 skill-data tech-design 段 `<name>/cutover.json`（不写正式仓、不违反 AX7
//         唯一写入门径）；旧拒启探针按 `<slug>/<docName>/cutover.json` 探测且 docName 可含
//         .rendered 后缀（真实包历史发起全为 rendered 形态——论点契约包仅有 .rendered.sync
//         旧 final 即其证），故标记按两变体键双写同内容（权威位置 = `<name>/cutover.json`，
//         变体键登记见 skill-data-addressing.md §2）；cutover 时按 worktree 扫描该包全部旧
//         final，扫描与 tombstone 断言的
//         枚举键 = dev-flow 段内 `<name>.sync/final.json` 与 `<name>.rendered.sync/final.json`
//         两个变体，按两变体精确枚举匹配、禁止裸前缀 glob（裸前缀会误伤他包目录——设计段七
//         实测记录：thesis* 误伤 thesis-contract-2.sync）；逐一改名归档为 final.legacy.json 并
//         在原地址留 tombstone 指针（JSON，标记 deprecated 并指向 conformance-state 权威与
//         归档件）。tombstone 不作用于 tech-design 段 `<name>/final.json`（T2 审查终态，
//         写入者 W1 tech-review-loop——cutover 不得触碰，本模块以字节级前后比对固化该禁令）。
//         归档包复活通道：同包重开对账范围时 cutover 标记保留（旧引擎仍拒启，复活只走 v2）、
//         状态仓从只读转活动并追加 Unarchived（退出归档）事件解档、旧事件流与 tombstone 指向
//         不变、v2 报告根沿用 `<name>/v2/`。
//   M5    切换前置：为切入包补 conformance 绑定并生成义务表（V1 流程；已终态包可降级为只读
//         归档、不建覆盖率分母）——绑定补录前置检查（切入包分母非空或显式只读归档分支）。
//   D2    归档是逻辑标记而非物理只读：归档态 = 快照 input.archived（cutover 归档标记输入）
//         且事件流无 Unarchived 的派生谓词（kernel/state-repo.mjs deriveArchived）；Unarchived
//         是归档期唯一放行的命令（state-store-archived 拒写其余命令）。
//
// 寻址登记：skill-data-addressing.md §2「conformance-plane 段（M5 报告与切换）」——本文件
// CUTOVER_MARKER_NAME / STATE_DIRNAME / LEGACY_ARCHIVE_NAME / 变体枚举键常量即该登记的代码侧
// 单一来源（任务书验收条款 3：路径单一来源，常量定义处注释指向登记行）。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { extractObligations } from "../extractors/obligations.mjs";
import { readSnapshot, appendCommands } from "../kernel/state-repo.mjs";

// ---------------------------------------------------------------------------
// 寻址常量（代码侧单一来源；登记行 = skill-data-addressing.md §2 conformance-plane 段）
// ---------------------------------------------------------------------------

/** cutover 标记文件名：tech-design 段 `<name>/cutover.json`（权威落盘位置；旧引擎拒启探针
 *  按 `<slug>/<docName>/cutover.json` 探测，docName 可含 .rendered 后缀——见 cutoverMarkerPaths） */
export const CUTOVER_MARKER_NAME = "cutover.json";

/** docName 后缀变体（与 LEGACY_SYNC_VARIANTS 同源的两形态：`<name>` / `<name>.rendered`） */
const RENDERED_SUFFIX = ".rendered";

/** 状态仓目录名：tech-design 段 `<name>/conformance-state/`（v2 引擎 stateRoot 缺省同值） */
export const STATE_DIRNAME = "conformance-state";

/** 旧档归档件名（legacy-import.mjs 同值；改名归档产物，原地址留 tombstone） */
export const LEGACY_ARCHIVE_NAME = "final.legacy.json";

/** tombstone 指针文件名 = 原地址 final.json（外部读者按原寻址读到 deprecated 指针而非终态） */
export const TOMBSTONE_NAME = "final.json";

/** cutover 扫描枚举键（段七两变体；禁止裸前缀 glob）——dev-flow 段 `<docName>.sync/final.json`：
 *  docName 变体 = `<name>` 与 `<name>.rendered`（设计文档 basename 可含 .rendered 后缀，
 *  同包历史运行可产生两种前缀变体，实存 Stock-df390a8b 段两形态并存） */
export const LEGACY_SYNC_VARIANTS = Object.freeze([
  { variant: "plain", docName: (name) => name },
  { variant: "rendered", docName: (name) => `${name}.rendered` },
]);

/** v2 引擎消费的六章节文件名（义务表提取的输入集；与 design-code-sync-v2.shared.ts
 *  PROBE_EXTRACT 同一文件清单） */
const CHAPTER_FILES = ["meta.json", "s1-context.json", "s2-status.json", "s3-solution.json", "s4-accept.json", "s5-breakdown.json"];

function cutoverError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * cutover 标记的两变体地址（`<name>/cutover.json` 权威位置 + docName 变体键）。
 * 旧 W4 setup / flow 手工入口的拒启探针按 `tech-design/<slug>/<docName>/cutover.json` 探测
 * （docName = 发起时设计文档 basename 去扩展名，可含 .rendered 后缀——真实包实存：论点契约
 * 包仅有 .rendered.sync 形态旧 final，即其历史发起全为 rendered 形态）。只写权威位置时
 * rendered 形态发起的旧入口探针落空、V9「已切换包旧入口拒启」对该形态失效——故 cutover 在
 * 两变体键各写一份同内容标记（权威位置为主份；变体键 = 探针命中键，同段登记见
 * skill-data-addressing.md §2 conformance-plane 附加寻址）。
 */
export function cutoverMarkerPaths(designPkg) {
  const base = basename(designPkg);
  const variantBase = base.endsWith(RENDERED_SUFFIX)
    ? base.slice(0, -RENDERED_SUFFIX.length)
    : `${base}${RENDERED_SUFFIX}`;
  return [join(designPkg, CUTOVER_MARKER_NAME), join(join(designPkg, ".."), variantBase, CUTOVER_MARKER_NAME)];
}

// ---------------------------------------------------------------------------
// 旧 final 扫描（两变体精确枚举；按 worktree 扫描全部份）
// ---------------------------------------------------------------------------

/** dev-flow 段扫描范围：单仓形态 = `<devFlowRoot>/`；工作区形态 = `<devFlowRoot>/<worktreeName>/`
 *  逐 worktree（段七「按 worktree 扫描该包全部旧 final」）。devFlowRoot = dev-flow/<slug>/ */
export function legacyScanScopes({ devFlowRoot, form = "single", worktreeName = null }) {
  if (form === "workspace") {
    if (!existsSync(devFlowRoot)) return [];
    // 每个 worktree 子目录一个扫描范围（worktreeName 缺省 = 全部子目录逐个扫描）
    const subs = readdirSync(devFlowRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    const wanted = worktreeName ? subs.filter((d) => d.name === worktreeName) : subs;
    return wanted.map((d) => join(devFlowRoot, d.name));
  }
  return existsSync(devFlowRoot) ? [devFlowRoot] : [];
}

/**
 * 按两变体枚举键精确扫描一个包的全部旧 final（每范围 = 单仓根或一个 worktree 目录）。
 * 返回 [{ scopeDir, variant, docName, finalPath }]——仅枚举键精确命中，裸前缀不命中
 * （`<name>-other.sync` 等他包目录不是本包旧档）。
 */
export function scanLegacyFinals({ devFlowRoot, pkgName, form = "single", worktreeName = null }) {
  const found = [];
  for (const scopeDir of legacyScanScopes({ devFlowRoot, form, worktreeName })) {
    for (const v of LEGACY_SYNC_VARIANTS) {
      const docName = v.docName(pkgName);
      const finalPath = join(scopeDir, `${docName}.sync`, TOMBSTONE_NAME);
      if (existsSync(finalPath)) found.push({ scopeDir, variant: v.variant, docName, finalPath });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 归档 + tombstone（读侧落地：旧寻址读到 deprecated 指针而非可当作当前终态的内容）
// ---------------------------------------------------------------------------

/** 归档单份旧 final：final.json → final.legacy.json（改名归档），原地址留 tombstone 指针。
 *  幂等：final.json 已不在而归档件在场 = 已归档，跳过（返回 archived=false）。 */
export function archiveLegacyFinal({ finalPath, tombstone, cutOverAt }) {
  const archivePath = join(join(finalPath, ".."), LEGACY_ARCHIVE_NAME);
  if (!existsSync(finalPath)) {
    if (existsSync(archivePath)) return { archived: false, archivePath, tombstonePath: null, alreadyArchived: true };
    throw cutoverError("legacy-final-missing", `扫描键命中的旧档在读后消失（${finalPath}）。恢复动作：重跑扫描后重发。`);
  }
  renameSync(finalPath, archivePath);
  writeFileSync(finalPath, JSON.stringify(tombstone, null, 2) + "\n");
  return { archived: true, archivePath, tombstonePath: finalPath, alreadyArchived: false };
}

// ---------------------------------------------------------------------------
// cutover 主入口（前置检查 → 扫描归档 → 状态仓归档标记 → 写切换标记 → T2 终态字节校验）
// ---------------------------------------------------------------------------

/**
 * 绑定补录前置检查（M5 波次：切入包分母非空或显式只读归档分支）。
 * mode = "migrate"（缺省）：从设计包六章节 JSON 提取义务表，分母必须非空；
 * mode = "readonly-archive"：已终态包只读归档分支，不要求分母。
 * 返回 { mode, denominator, tableVersion }。
 */
export function precheckCutoverDenominator({ designPkg, mode = "migrate" }) {
  if (mode !== "migrate" && mode !== "readonly-archive") {
    throw cutoverError("invalid-cutover-mode", `mode「${String(mode)}」不在词表（migrate / readonly-archive）。恢复动作：活跃包用 migrate，已终态包显式走 readonly-archive。`);
  }
  if (mode === "readonly-archive") {
    return { mode, denominator: null, tableVersion: null };
  }
  const docs = {};
  for (const f of CHAPTER_FILES) {
    const p = join(designPkg, f);
    if (existsSync(p)) docs[f] = JSON.parse(readFileSync(p, "utf8"));
  }
  const table = extractObligations(docs);
  if (table.obligations.length === 0) {
    throw cutoverError(
      "cutover-denominator-empty",
      `绑定补录前置检查失败：设计包 ${designPkg} 无任何 conformance 绑定义务（覆盖率分母为空，切入后对账无对象）。` +
        `恢复动作：先按 design-doc-schema.md §9b 为章节条目补 conformance 绑定并生成义务表（V1 流程）后重发；` +
        `已终态包显式改走 mode=readonly-archive（不建覆盖率分母）。`,
    );
  }
  return { mode, denominator: table.obligations.length, tableVersion: table.tableVersion };
}

/** tombstone 指针内容（字段契约：deprecated 标记 / 权威地址 / 归档件地址——段七） */
function tombstoneContent({ pkgName, docName, variant, stateRoot, reportRoot, archivePath, cutOverAt, reason }) {
  return {
    deprecated: true,
    package: pkgName,
    docName,
    variant,
    message:
      "此地址的旧 D5 final 已随包切换 v2 一致性控制平面被改名归档——本文件是指针，不再是可当作当前终态的内容（段七 SI5 读侧落地）。" +
      "当前权威见 authority；归档原文见 archivedTo。旧引擎入口对该包已拒启（D8/G11）。",
    authority: { stateRoot, reportRoot },
    archivedTo: archivePath,
    cutOverAt,
    reason,
  };
}

/** 快照文件名 = kernel/state-repo.mjs 私有常量（"snapshot.json"）——直写通道注释同
 *  checkers/backlog.mjs：kernel deriveArchived 注释明文预告「外部直接改快照 input（如 M5
 *  cutover 命令）」；kernel 文件名演进时 readSnapshot 返回 null 即 loud break */
const SNAPSHOT_FILE = "snapshot.json";

/**
 * 按设计包灰度切换（唯一入口；幂等保护：已带标记即拒绝）。
 *   designPkg      tech-design 段 <name>/ 目录（标记与 v2 报告根的寻址键）
 *   devFlowRoot    dev-flow 段 <slug>/ 根（旧 final 扫描起点；工作区形态逐 worktree）
 *   pkgName        <name>（= designPkg 目录 basename）
 *   stateRoot      状态仓根（tombstone 权威地址指向；归档标记写入处；无状态仓时只登记地址）
 *   form/worktreeName  dev-flow 段寻址形态（workspace 时逐 worktree 或指定 worktree）
 *   mode           "migrate"（缺省，分母前置检查）| "readonly-archive"（已终态包）
 *   reason         切换理由（审计字段）
 * 返回 { markerPath, precheck, archived: [...], tombstones: [...], techDesignFinalUntouched }。
 */
export function cutoverPackage({
  designPkg,
  devFlowRoot,
  pkgName,
  stateRoot = join(designPkg, STATE_DIRNAME),
  form = "single",
  worktreeName = null,
  mode = "migrate",
  reason = "按设计包灰度切换到 v2 一致性控制平面（D8：旧引擎只读）",
  cutOverAt = null,
}) {
  if (typeof designPkg !== "string" || designPkg.trim() === "" || typeof pkgName !== "string" || pkgName.trim() === "") {
    throw cutoverError("invalid-cutover-input", "designPkg 与 pkgName 必填（tech-design 段寻址键）。恢复动作：传设计包目录与其 basename 后重发。");
  }
  const markerPaths = cutoverMarkerPaths(designPkg);
  const markerPath = markerPaths[0];
  const alreadyMarked = markerPaths.find((p) => existsSync(p));
  if (alreadyMarked) {
    throw cutoverError(
      "cutover-already-marked",
      `设计包已带 cutover 标记（${alreadyMarked}），不重复切换。恢复动作：该包已归 v2 管辖；重开对账范围走复活通道（unarchivePackage），旧引擎入口保持拒启。`,
    );
  }

  // ── 前置检查（分母非空或显式只读归档分支；先于一切落盘动作）──
  const precheck = precheckCutoverDenominator({ designPkg, mode });

  // ── T2 审查终态禁触碰的字节基线（段七：tech-design 段 <name>/final.json 不在处置范围）──
  const techDesignFinal = join(designPkg, TOMBSTONE_NAME);
  const t2Baseline = existsSync(techDesignFinal) ? readFileSync(techDesignFinal) : null;

  // ── 扫描（两变体精确枚举）+ 逐一改名归档 + tombstone ──
  const stamp = cutOverAt ?? new Date().toISOString();
  const scan = scanLegacyFinals({ devFlowRoot, pkgName, form, worktreeName });
  const archived = [];
  const tombstones = [];
  for (const hit of scan) {
    const t = tombstoneContent({
      pkgName,
      docName: hit.docName,
      variant: hit.variant,
      stateRoot,
      reportRoot: join(designPkg, "v2"),
      archivePath: join(join(hit.finalPath, ".."), LEGACY_ARCHIVE_NAME),
      cutOverAt: stamp,
      reason,
    });
    const r = archiveLegacyFinal({ finalPath: hit.finalPath, tombstone: t, cutOverAt: stamp });
    if (r.archived) archived.push({ ...hit, archivePath: r.archivePath });
    tombstones.push({ variant: hit.variant, docName: hit.docName, tombstonePath: hit.finalPath, alreadyArchived: r.alreadyArchived });
  }

  // ── 状态仓归档标记（逻辑归档，非物理只读——input.archived 派生谓词输入；
  //    直写快照通道同 checkers/backlog.mjs 先例，kernel 锁内执行）──
  if (stateRoot !== null && existsSync(stateRoot)) {
    // withLock 是 async——本函数同步语义下以内联原子段写（cutover 是一次性运维命令，
    // 不与引擎并发；与 backlog 先例的差异在此显式登记：读-改-写单段完成）
    const snap = readSnapshot(stateRoot);
    if (snap) {
      if (snap.input?.archived === true) {
        throw cutoverError(
          "state-store-already-archived",
          `状态仓已处归档态（input.archived=true）但 cutover 标记缺失——状态与标记不一致。` +
            `恢复动作：先补写标记（排查标记丢失原因），或走复活通道确认该包是否应重开。`,
        );
      }
      writeFileSync(join(stateRoot, SNAPSHOT_FILE), JSON.stringify({ ...snap, input: { ...snap.input, archived: true } }, null, 2));
    }
  }

  // ── 写切换标记（最后落盘——拒启探针只认标记在场，标记在场 = 全部处置已完成；
  //    两变体键各写一份同内容标记，保证 plain / rendered 两种发起形态的旧入口都命中拒启）──
  mkdirSync(designPkg, { recursive: true });
  mkdirSync(join(markerPaths[1], ".."), { recursive: true });
  const marker = {
    cutover: true,
    engine: "v2",
    package: pkgName,
    mode: precheck.mode,
    denominator: precheck.denominator,
    tableVersion: precheck.tableVersion,
    stateRoot,
    reportRoot: join(designPkg, "v2"),
    legacyArchived: archived.map((a) => a.archivePath),
    cutOverAt: stamp,
    reason,
  };
  for (const p of markerPaths) writeFileSync(p, JSON.stringify(marker, null, 2) + "\n");

  // ── T2 终态字节级校验（禁触碰禁令的事后固化；被触碰即抛错暴露）──
  const t2After = existsSync(techDesignFinal) ? readFileSync(techDesignFinal) : null;
  const t2BeforeExists = t2Baseline !== null;
  const t2AfterExists = t2After !== null;
  if (t2BeforeExists !== t2AfterExists || (t2Baseline !== null && !t2Baseline.equals(t2After))) {
    throw cutoverError("tech-design-final-touched", `tech-design 段 <name>/final.json（T2 审查终态）在切换过程中被改动——段七禁令被违反。恢复动作：从 Git 恢复该文件后排查。`);
  }

  return { markerPath, marker, precheck, archived, tombstones, scan, techDesignFinalUntouched: true };
}

// ---------------------------------------------------------------------------
// 复活通道（Unarchived 解档 + 标记保留 + 恢复追加）
// ---------------------------------------------------------------------------

/**
 * 归档包复活（同包重开对账范围；段七复活通道 / V9）：
 *   ① cutover 标记必须在场且保留（复活只走 v2——旧引擎仍拒启）；
 *   ② 状态仓追加 UnarchivePackage 命令（Unarchived 事件解档——归档期唯一放行命令，
 *      kernel/state-repo.mjs archived 拒写分支保证其余命令全部拒绝）；
 *   ③ 旧事件流与 tombstone 指向不变（本函数零删除零改写）。
 * 返回 { unarchived: true, markerPath, markerRetained: true, event }。
 */
export async function unarchivePackage({ stateRoot, designPkg, reason, actor = "main-agent" }) {
  const markerPaths = cutoverMarkerPaths(designPkg);
  const markerPath = markerPaths.find((p) => existsSync(p)) ?? markerPaths[0];
  if (!existsSync(markerPath)) {
    throw cutoverError(
      "cutover-marker-missing",
      `复活被拒绝：该包无 cutover 标记（${markerPath}）——复活通道只对已切换包成立。恢复动作：未切换包直接发起 v2 对账，无需复活。`,
    );
  }
  const snap = readSnapshot(stateRoot);
  if (!snap) {
    throw cutoverError("state-store-missing", `状态仓未初始化（${stateRoot}）。恢复动作：只读归档分支的包重开时先走 v1 绑定补录并初始化状态仓。`);
  }
  if (snap.input?.archived !== true) {
    throw cutoverError(
      "state-store-not-archived",
      `复活被拒绝：状态仓未处归档态（input.archived 非 true）。恢复动作：活动包直接续跑对账，无需 Unarchived。`,
    );
  }
  const r = await appendCommands(stateRoot, [{ type: "UnarchivePackage", actor, payload: { reason: reason ?? "同包重开对账范围（复活通道，段七）" } }]);
  return {
    unarchived: true,
    markerPath,
    markerRetained: existsSync(markerPath),
    event: r.appendedFacts[0],
    appended: r.appended,
  };
}

/** cutover 标记读取（测试与运维探针；旧引擎走自己的 NODE_CUTOVER_EXISTS 探针，不经过本模块）。
 *  返回权威位置标记内容；两变体键内容一致（cutoverPackage 同内容双写）。 */
export function readCutoverMarker(designPkg) {
  const p = cutoverMarkerPaths(designPkg)[0];
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** dev-flow 段根寻址（与 v2 引擎 sandboxRoot 缺省同一形态；登记行见 skill-data-addressing §2） */
export function devFlowRootFor({ skillDataHome, slug, form = "single", worktreeName = null }) {
  return form === "workspace" && worktreeName ? join(skillDataHome, "dev-flow", slug, worktreeName) : join(skillDataHome, "dev-flow", slug);
}
