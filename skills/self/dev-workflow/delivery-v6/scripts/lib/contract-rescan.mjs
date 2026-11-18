// contract-rescan.mjs — 外部契约候选复扫判定单源库（V6 运行可用性升级设计 §4.2/§7.3/§8.1）
//
// 为什么有本文件：候选复扫判定（strong 信号 / 蕴含观察类映射 / unresolved 外部访问 /
// 候选处置对账 / 强制 essential）曾在三处各存一份实现——dev-flow 的 check-contract-rescan
// （D0 编译门 + D3 候选完成门）与 delivery-gate 的 externalContractPreflight（evaluate 前
// 置）。两份实现的类提取口径不同（子串匹配 vs call-class 段正则），gate 侧还把
// 「提不到调用类」当拒绝理由，使 manifest 字段型（manifest:pi.extensions）与纯 import 型
// 强候选恒被误拒，恢复动作（补声明对应调用类）不可执行。本库是唯一实现，三处消费：
//   ① dev-flow D0 编译门：compile-exec-plan.mjs import runContractRescan（stage=d0）；
//   ② dev-flow D3 候选完成门：check-contract-rescan.mjs CLI（stage=d3）；
//   ③ delivery-gate evaluate 前置：externalContractPreflight 调用同一函数。
//
// 口径分工：判定（哪些候选/信号触发什么拒绝、顺序、数据）在本库单一实现；错误消息的措辞
// 归各消费方渲染（D0/D3 与 gate 的文案各自被既有测试冻结，renderRescanError* 两个小渲染器
// 只做呈现，不含判定）。探测 CLI 与策略包路径可注入（测试替身 / 策略快照），缺省值保持
// 各消费方现行锚定：探测器取安装形态 ~/.agents/skills/delivery-v6/scripts/，策略包取本库
// 所在技能的 policies/（读不到时蕴含关系回退设计 §4.1 初始表，不猜其余）。
//
// 输入契约（上游固定，本库只消费）：
//   - 探测 CLI：detect-external-contracts.mjs --project-root <R> --intent-file <F>
//     → stdout JSON { candidates: [{id, strength, signals[], callClasses?, impliedClasses?}],
//       unresolved: [{signal, reason}] }（设计 §4.2 候选快照结构）；
//   - 验收包 acceptance.json 顶层 externalContracts / externalContractReview；
//   - 策略包 external-contract-classes.json：classes[].id / staticSignals
//     （{kind:"manifest-field",field} 与 {kind:"regex",pattern,appliesTo} 两种形态，
//      与探测器的编译方式对齐）/ minEnvironment / impliesObservationClasses。
//
// 判定规则（与设计 §4.2 D0 复扫规则逐条对应；D3 与 evaluate 复用同一判定）：
//   1. unresolved 非空 → 停回人工（计算式外部成员访问 / 动态 import 等无法静态归类，
//      不做字面白名单放行）；
//   2. strong 候选的调用类（call-class 段 + manifest-field 映射 + regex 还原，再加策略表
//      蕴含观察类）必须被 capability.detectionClasses 覆盖——处置指向某契约时按该契约的
//      声明集核对，未处置候选按全包声明集核对；
//   3. strong 候选必须已有处置（bound / manual）且落到已声明契约——未处置 / not-external /
//      unresolved 处置 / 契约不存在全部拒绝（not-external 仅 weak 候选可用）；
//   4. strong 候选绑定到验收标 optional 的契约 → 强制按 essential 处理（回灌编译门的
//      契约冒烟增量与 DAG 检查，并披露给 evaluate 侧义务派生）；
//   5. stage=d3 追加：essential 契约任务必须已编译 runtime-probe 验收节点且 probe artifact
//      落盘可解析——probe 未跑不得进入候选完成。
// 调用类提取的三条路径与「无调用类不拒绝」：manifest / 纯 import 型强候选提不到调用类时
// 不因此拒绝（它们由候选处置表兜底——处置对账在声明层与复扫层都在），只有「提得到类但
// 未被覆盖」才拒绝（能力清单低报的主机器门）。

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 探测 CLI 安装形态锚定（与 dev-flow 原 DETECTOR_PATH 一致：测试替身装临时 HOME 的
// ~/.agents/skills/delivery-v6/scripts/ 下；gate 侧显式传入自己的 SKILL_ROOT 锚定路径）
const DEFAULT_DETECTOR_PATH = join(homedir(), ".agents", "skills", "delivery-v6", "scripts", "detect-external-contracts.mjs");
// 策略包（调用类目录的长期权威）：本库随 delivery-v6 技能分发，取同技能 policies/ 下的文件
const DEFAULT_POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policies", "external-contract-classes.json");
// 策略包读不到时的蕴含观察关系回退表（设计 §4.1 初始关系：register-command 蕴含
// dispatch-command）。回退只保初始表，不猜其余——manifest/regex 映射在无策略时整体缺席
export const IMPLIED_CLASSES_FALLBACK = { "register-command": ["dispatch-command"] };
// 调用类信号段：探测器实定形态 = source:<文件>:call-class:<类id>（设计 §4.2 示例的裸
// "call-class:<类id>" 前缀形态一并容忍——两种都解析，取并集）
export const CALL_CLASS_RE = /(?:^|:)call-class:([A-Za-z0-9_-]+)/;
const MANIFEST_SIGNAL_PREFIX = "manifest:";
const VALID_STAGES = new Set(["d0", "d3"]);

const isRec = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.trim() !== "";

/** 策略包 → 判定用表。policyDocument = 解析后的 external-contract-classes.json（null = 缺失）。
 * classes：id → {minEnvironment, implies[]}（gate 的 classFloorTable 同源）；
 * manifestFieldToClass：manifest 字段路径 → 类 id（pi.extensions 本属 extension-entrypoint）；
 * regexSignals：{classId, re, appliesTo}（与探测器同款编译：appliesTo==="test"→"test"，其余 "code"）；
 * implied：id → impliesObservationClasses[]（策略缺席时回退初始表）。 */
export function loadClassTables(policyDocument) {
  const tables = {
    classes: new Map(),
    known: [],
    manifestFieldToClass: new Map(),
    regexSignals: [],
    implied: new Map(),
    policyAvailable: isRec(policyDocument) && Array.isArray(policyDocument.classes) && policyDocument.classes.length > 0,
  };
  if (tables.policyAvailable) {
    for (const entry of policyDocument.classes) {
      if (!isRec(entry) || typeof entry.id !== "string" || entry.id === "") continue;
      const implies = Array.isArray(entry.impliesObservationClasses)
        ? entry.impliesObservationClasses.filter((item) => typeof item === "string" && item !== "")
        : [];
      tables.classes.set(entry.id, {
        minEnvironment: typeof entry.minEnvironment === "string" ? entry.minEnvironment : null,
        implies,
      });
      tables.known.push(entry.id);
      for (const signal of Array.isArray(entry.staticSignals) ? entry.staticSignals : []) {
        if (!isRec(signal)) continue;
        if (signal.kind === "manifest-field" && typeof signal.field === "string" && signal.field !== "") {
          tables.manifestFieldToClass.set(signal.field, entry.id);
        } else if (signal.kind === "regex" && typeof signal.pattern === "string") {
          try {
            tables.regexSignals.push({ classId: entry.id, re: new RegExp(signal.pattern), appliesTo: signal.appliesTo === "test" ? "test" : "code" });
          } catch {
            // 正则无法编译：探测器（上游）此时已直接报错退出，复扫侧到达不了这一支；
            // 防御性跳过，不静默当成「无该信号」
          }
        }
      }
    }
    for (const [id, entry] of tables.classes) tables.implied.set(id, entry.implies);
  } else {
    for (const [id, implied] of Object.entries(IMPLIED_CLASSES_FALLBACK)) tables.implied.set(id, implied);
  }
  return tables;
}

/** 从策略包文件读表（读不到/损坏 → null 表：蕴含回退初始表，manifest/regex 映射缺席）。 */
export function loadClassTablesFromFile(policyPath = DEFAULT_POLICY_PATH) {
  try {
    return loadClassTables(JSON.parse(readFileSync(policyPath, "utf8")));
  } catch {
    return loadClassTables(null);
  }
}

/** 候选信号里的调用类还原（三条路径，均与探测器编译口径对齐）：
 *  ① call-class 段正则：source:<文件>:call-class:<类id> 与裸 call-class:<类id>；
 *  ② manifest-field 映射：manifest:<字段> 信号 → 策略包 staticSignals 的 manifest-field 表
 *     （不读静态信号表就会把 manifest 型候选的 hit 判空，误拒「缺调用类」）；
 *  ③ regex 信号：策略包 staticSignals 的 regex 按探测器同款编译后匹配信号串——regex 类
 *     正常经 ① 的 call-class 段送达（探测器已在源码扫描期应用过），此处是探测器信号形态
 *     变化时的防御性还原。
 * 返回 { classes, hasCallClassSignal }：classes 不含蕴含观察类；hasCallClassSignal 区分
 * 「提不到类」与「候选无调用类信号」——后者（manifest / 纯 import 型强候选）不是拒绝理由。 */
export function candidateCallClasses(candidate, tables) {
  const classes = new Set();
  let hasCallClassSignal = false;
  for (const signal of Array.isArray(candidate?.signals) ? candidate.signals : []) {
    if (typeof signal !== "string") continue;
    const match = signal.match(CALL_CLASS_RE);
    if (match !== null) {
      classes.add(match[1]);
      hasCallClassSignal = true;
    }
    if (signal.startsWith(MANIFEST_SIGNAL_PREFIX)) {
      const classId = tables.manifestFieldToClass.get(signal.slice(MANIFEST_SIGNAL_PREFIX.length));
      if (classId !== undefined) classes.add(classId);
    }
    for (const { classId, re, appliesTo } of tables.regexSignals) {
      if (appliesTo !== "code") continue;
      if (re.test(signal)) classes.add(classId);
    }
  }
  // 探测器自带 callClasses 数组（契约扩展字段）一并取并集
  for (const classId of Array.isArray(candidate?.callClasses) ? candidate.callClasses : []) {
    if (isStr(classId)) {
      classes.add(classId.trim());
      hasCallClassSignal = true;
    }
  }
  return { classes: [...classes], hasCallClassSignal };
}

/** 调用类 + 策略表蕴含观察类的并集（设计 §4.1：源码出现注册调用时必须同时覆盖分发观察）。 */
export function observedClassesOf(candidate, tables) {
  const { classes } = candidateCallClasses(candidate, tables);
  const all = new Set(classes);
  for (const classId of [...all]) {
    for (const implied of tables.implied.get(classId) ?? []) all.add(implied);
  }
  for (const classId of Array.isArray(candidate?.impliedClasses) ? candidate.impliedClasses : []) {
    if (isStr(classId)) all.add(classId.trim());
  }
  return [...all];
}

/** strong 候选信号命中的调用类集合（含蕴含观察类）——forcedEssentialCapabilityIds 的输入。
 * 词表缺席时的退化形态：取信号末段（manifest:pi.extensions → pi.extensions；
 * call-class:register-command → register-command）——无策略环境里能力仍可声明任意
 * detectionClasses，末段还原保证强制 essential 判定不因策略包缺席而失明。 */
export function strongCandidateClasses(candidateSnapshot, tables) {
  const classes = new Set();
  if (candidateSnapshot?.available !== true) return classes;
  const candidates = Array.isArray(candidateSnapshot.document?.candidates) ? candidateSnapshot.document.candidates : [];
  for (const candidate of candidates) {
    if (!isRec(candidate) || candidate.strength !== "strong") continue;
    for (const classId of observedClassesOf(candidate, tables)) classes.add(classId);
    if (tables.known.length === 0) {
      for (const signal of Array.isArray(candidate.signals) ? candidate.signals : []) {
        if (typeof signal !== "string") continue;
        const tail = signal.split(":").filter(Boolean).at(-1);
        if (tail !== undefined) classes.add(tail);
      }
    }
  }
  return classes;
}

/** 候选在某契约（contractId 非空）或全包（contractId 为 null）声明集下未覆盖的调用类。 */
function unmappedClassesOf(observed, declaredByContract, declaredAll) {
  const declared = declaredByContract ?? declaredAll;
  return observed.filter((classId) => !declared.has(classId));
}

/**
 * 复扫 + 判定单一实现（D0 / D3 / evaluate 共用）。
 * @param {{taskDir: string, projectRoot: string, intentFile?: string|null,
 *          acceptance?: object|null, stage?: "d0"|"d3", execPlanPath?: string|null,
 *          detectorPath?: string|null, policyDocument?: object|null,
 *          detection?: {ok: boolean, parsed?: object, reason?: string}|null}} opts
 *   detectorPath   探测 CLI 路径（缺省 = 安装形态 ~/.agents/skills/delivery-v6/scripts/…）；
 *                  gate 侧传入自己锚定的路径（支持 DELIVERY_EXTERNAL_CONTRACT_DETECTOR 覆盖）
 *   policyDocument 策略包文档（缺省 = 读本库同技能 policies/ 下的文件；读不到 → 回退初始蕴含表）
 *   detection      调用方已执行的探测输出（{ok, parsed, reason}）——传入时本库不再自行 spawn，
 *                  供同一命令内的多处复扫共享一次探测（evaluate 前置 + runtimeObligationsOf）
 * @returns {{ok: boolean, skipped: boolean, detectorAvailable: boolean,
 *            errors: {category: string, code: string, message params…}[],
 *            notes: string[], effectiveEssential: string[], forcedEssential: string[],
 *            candidateCount: number, strongCount: number, unresolvedCount: number,
 *            probeNodeCount: number}}
 *   errors[].category："input" = 复扫输入不可用（探测器缺失/执行失败/intent 缺失/验收包
 *   不可读——消费方按 fail-closed 披露，不当成「无信号」）；"rescan" = 判定拒绝；
 *   "probe" = stage=d3 的 probe 节点/artifact 缺口。message 由消费方渲染（本库只给数据）。
 */
export function runContractRescan(opts) {
  const taskDir = opts.taskDir;
  const projectRoot = opts.projectRoot;
  const stage = VALID_STAGES.has(opts.stage) ? opts.stage : "d3";
  const intentFile = isStr(opts.intentFile) ? opts.intentFile : join(taskDir, "intent.md");
  const detectorPath = isStr(opts.detectorPath) ? opts.detectorPath : DEFAULT_DETECTOR_PATH;
  const tables = opts.policyDocument !== undefined ? loadClassTables(opts.policyDocument) : loadClassTablesFromFile();
  const errors = [];
  const notes = [];
  const empty = {
    ok: true,
    skipped: true,
    detectorAvailable: true,
    errors,
    notes,
    effectiveEssential: [],
    forcedEssential: [],
    candidateCount: 0,
    strongCount: 0,
    unresolvedCount: 0,
    probeNodeCount: 0,
  };
  if (!isStr(taskDir) || !isStr(projectRoot)) {
    errors.push({ category: "input", code: "task-dir-project-root-missing", message: null });
    return { ...empty, ok: false, detectorAvailable: false };
  }

  // 验收包（调用方已解析则复用，避免同一文件两次 IO）
  let acceptance = opts.acceptance ?? null;
  if (acceptance === null) {
    try {
      acceptance = JSON.parse(readFileSync(join(taskDir, "acceptance.json"), "utf8"));
    } catch (error) {
      errors.push({ category: "input", code: "acceptance-unreadable", path: join(taskDir, "acceptance.json"), message: error.message });
      return { ...empty, ok: false, detectorAvailable: false };
    }
  }
  const contracts = isRec(acceptance) && Array.isArray(acceptance.externalContracts) ? acceptance.externalContracts : null;
  const review = isRec(acceptance) && isRec(acceptance.externalContractReview) ? acceptance.externalContractReview : null;
  if (contracts === null && review === null) {
    // 升级前旧任务（验收包无 externalContracts / externalContractReview）——外部契约复扫门不适用
    notes.push("升级前旧任务（验收包无 externalContracts / externalContractReview）——外部契约复扫门不适用，按无外部契约任务放行");
    return { ...empty };
  }

  // 探测输出：调用方已执行探测时直接消费（evaluate 前置与 runtimeObligationsOf 的复扫共享
  // 一次探测器 spawn——同一输入跑两遍既慢又可能给出两个结论）；否则本库自行执行
  let detection;
  if (opts.detection !== undefined && opts.detection !== null) {
    if (opts.detection.ok !== true) {
      errors.push({
        category: "input",
        code: "detector-failed",
        status: opts.detection.status ?? null,
        output: opts.detection.reason ?? "未说明",
        message: null,
      });
      return { ...empty, ok: false, detectorAvailable: false };
    }
    detection = opts.detection.parsed;
  } else {
    // 探测 CLI 在场性（fail-closed：门禁输入不可用时不放行——不可用降级会让强信号绕过对账）
    if (!existsSync(detectorPath)) {
      errors.push({ category: "input", code: "detector-missing", path: detectorPath, message: null });
      return { ...empty, ok: false, detectorAvailable: false };
    }
    if (!existsSync(intentFile)) {
      errors.push({ category: "input", code: "intent-missing", path: intentFile, message: null });
      return { ...empty, ok: false, detectorAvailable: false };
    }
    const run = spawnSync(process.execPath, [detectorPath, "--project-root", projectRoot, "--intent-file", intentFile], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (run.status !== 0) {
      errors.push({
        category: "input",
        code: "detector-failed",
        status: run.status,
        output: String(run.stderr || run.stdout || "").trim(),
        message: null,
      });
      return { ...empty, ok: false, detectorAvailable: false };
    }
    try {
      detection = JSON.parse(String(run.stdout || ""));
    } catch (error) {
      errors.push({ category: "input", code: "detector-output-invalid", message: error.message });
      return { ...empty, ok: false, detectorAvailable: false };
    }
  }
  const candidates = Array.isArray(detection?.candidates) ? detection.candidates : [];
  const unresolved = Array.isArray(detection?.unresolved) ? detection.unresolved : [];

  // ① unresolved 外部访问 → 停回（不做字面白名单放行）
  for (const item of unresolved) {
    errors.push({
      category: "rescan",
      code: "unresolved-external-access",
      signal: isRec(item) ? item.signal ?? "未命名信号" : String(item),
      reason: isRec(item) ? item.reason ?? "无理由" : "无理由",
      message: null,
    });
  }

  // 处置表（externalContractReview.dispositions：candidateId → {disposition, contractId?}）
  const dispositions = new Map();
  for (const item of Array.isArray(review?.dispositions) ? review.dispositions : []) {
    if (isRec(item) && isStr(item.candidateId)) dispositions.set(item.candidateId, item);
  }
  if (review === null) {
    errors.push({ category: "rescan", code: "review-missing", message: null });
  }

  const declaredEssential = new Set(
    (contracts ?? []).filter((item) => isRec(item) && isStr(item.id) && item.essential === true).map((item) => item.id),
  );
  const forcedEssential = new Set();
  const contractById = new Map((contracts ?? []).filter((item) => isRec(item) && isStr(item.id)).map((item) => [item.id, item]));
  // 全包声明集：未处置候选的调用类按全包核对（处置指向某契约的候选按该契约核对——
  // 设计 §4.2「必须被该契约某个 capability 的 detectionClasses 覆盖」）
  const declaredAll = new Set();
  for (const contract of contractById.values()) {
    for (const capability of Array.isArray(contract.capabilities) ? contract.capabilities : []) {
      for (const classId of Array.isArray(capability?.detectionClasses) ? capability.detectionClasses : []) {
        if (isStr(classId)) declaredAll.add(classId.trim());
      }
    }
  }

  for (const candidate of candidates) {
    if (!isRec(candidate) || candidate.strength !== "strong") continue; // weak 候选由 reviewer 论证，不进机器门
    const candidateId = isStr(candidate.id) ? candidate.id : "（无 id 候选）";
    const disposition = dispositions.get(candidate.id);
    const contract = disposition !== undefined && isStr(disposition.contractId) ? contractById.get(disposition.contractId) : undefined;
    const boundContractId = contract !== undefined ? contract.id : null;
    const declaredByContract = contract === undefined
      ? null
      : new Set(
        (Array.isArray(contract.capabilities) ? contract.capabilities : []).flatMap((capability) =>
          (Array.isArray(capability?.detectionClasses) ? capability.detectionClasses : []).filter(isStr).map((classId) => classId.trim()),
        ),
      );
    // ② 调用类（含蕴含观察类）→ capability.detectionClasses 覆盖对账。
    // 提不到调用类的强候选（manifest 字段型 / 纯 import 型）不因此拒绝——由处置表兜底
    const observed = observedClassesOf(candidate, tables);
    const missing = unmappedClassesOf(observed, declaredByContract, declaredAll);
    if (missing.length > 0) {
      errors.push({
        category: "rescan",
        code: "candidate-classes-unmapped",
        candidateId,
        contractId: boundContractId,
        missing,
        message: null,
      });
      continue;
    }
    // ③ 处置对账：strong 候选只能 bound 或保持 unresolved 停回，not-external 仅 weak 可用
    if (disposition === undefined) {
      errors.push({
        category: "rescan",
        code: "candidate-undisposed",
        candidateId,
        signals: (Array.isArray(candidate.signals) ? candidate.signals : []).filter((signal) => typeof signal === "string"),
        message: null,
      });
      continue;
    }
    if (disposition.disposition !== "bound" && disposition.disposition !== "manual") {
      errors.push({
        category: "rescan",
        code: "candidate-disposition-invalid",
        candidateId,
        disposition: String(disposition.disposition),
        message: null,
      });
      continue;
    }
    if (contract === undefined) {
      errors.push({
        category: "rescan",
        code: "candidate-contract-unknown",
        candidateId,
        contractId: disposition.contractId === undefined ? null : String(disposition.contractId),
        message: null,
      });
      continue;
    }
    // 实际使用（源码 / manifest 强信号）→ 强制按 essential 处理
    if (contract.essential !== true) {
      forcedEssential.add(contract.id);
      notes.push(`契约 ${contract.id} 验收标 optional，但复扫发现实际使用信号（候选 ${candidateId}）——按 essential 处理（契约冒烟增量、spike DAG 与 runtime 义务均按 essential 判定）`);
    }
  }

  // stage=d3：runtime probe 节点与 artifact 落盘核对（probe 未跑不得进入候选完成）
  let probeNodeCount = 0;
  if (stage === "d3" && isStr(opts.execPlanPath)) {
    let execPlan;
    try {
      execPlan = JSON.parse(readFileSync(opts.execPlanPath, "utf8"));
    } catch (error) {
      errors.push({ category: "probe", code: "exec-plan-unreadable", path: opts.execPlanPath, message: error.message });
      return finish();
    }
    const accNodes = isRec(execPlan) && execPlan.mode === "acceptance" && isRec(execPlan.acceptance) && Array.isArray(execPlan.acceptance.nodes)
      ? execPlan.acceptance.nodes
      : [];
    for (const node of accNodes) {
      if (!isRec(node) || !isRec(node.runtimeProbe)) continue;
      probeNodeCount += 1;
      // artifact 落点：exec-plan 节点上为绝对路径（编译期按任务目录相对声明解析并做越界
      // 检查）；相对形态（手改 exec-plan 或历史产物）按 taskDir 解析且禁止 .. 逃逸
      const artifactRaw = node.runtimeProbe.artifact;
      let artifact = null;
      if (isStr(artifactRaw)) {
        if (isAbsolute(artifactRaw)) artifact = artifactRaw;
        else {
          const candidatePath = resolve(taskDir, artifactRaw);
          if (candidatePath === taskDir || candidatePath.startsWith(`${taskDir}/`)) artifact = candidatePath;
        }
      }
      if (artifact === null) {
        errors.push({ category: "probe", code: "probe-artifact-unresolvable", nodeId: node.id, artifactRaw: artifactRaw ?? null, message: null });
        continue;
      }
      if (!existsSync(artifact)) {
        errors.push({ category: "probe", code: "probe-artifact-missing", nodeId: node.id, artifact, message: null });
        continue;
      }
      try {
        JSON.parse(readFileSync(artifact, "utf8"));
      } catch (error) {
        errors.push({ category: "probe", code: "probe-artifact-invalid-json", nodeId: node.id, artifact, message: error.message });
      }
    }
    const essentialIds = new Set([...declaredEssential, ...forcedEssential]);
    if (essentialIds.size > 0 && probeNodeCount === 0) {
      errors.push({ category: "probe", code: "probe-nodes-missing", essentialIds: [...essentialIds], message: null });
    }
  }

  return finish();

  function finish() {
    const effectiveEssential = [...new Set([...declaredEssential, ...forcedEssential])];
    const ok = errors.length === 0;
    return {
      ok,
      skipped: false,
      detectorAvailable: true,
      errors,
      notes,
      effectiveEssential,
      forcedEssential: [...forcedEssential],
      candidateCount: candidates.length,
      strongCount: candidates.filter((candidate) => isRec(candidate) && candidate.strength === "strong").length,
      unresolvedCount: unresolved.length,
      probeNodeCount,
    };
  }
}

// ── 消息渲染：判定数据（errors[].code + 参数字段）→ 各消费方既有措辞 ──
// 两个渲染器只做呈现、不含判定；措辞分别被 dev-flow（D0/D3 门）与 delivery-gate
// （evaluate 前置）的既有测试冻结，改措辞须同步对应测试。

const RESCAN_DECLARATION_RECOVERY = "回 delivery-v6 修订 externalContracts 的 capabilities / detectionClasses 后重新编译";

/** dev-flow 侧渲染（D0 编译门缺口报告 + D3 CLI 输出）。 */
export function renderRescanErrorDevFlow(error) {
  switch (error.code) {
    case "task-dir-project-root-missing":
      return "复扫输入不完整：--task-dir 与 --project-root 均必填（交付任务目录 + 当前候选源码所在项目根）";
    case "acceptance-unreadable":
      return `无法读取交付任务目录 acceptance.json：${error.path}（${error.message}）——复扫判定缺验收包输入（恢复：核对 --task-dir 指向 delivery-v6 产出的交付任务目录）`;
    case "detector-missing":
      return `外部契约探测 CLI 不在安装位置：${error.path}——复扫无法执行（恢复：确认 delivery-v6 技能已安装（ln -s 到 ~/.agents/skills/delivery-v6）；命令形态 = node ${error.path} --project-root <项目根> --intent-file <taskDir>/intent.md）`;
    case "intent-missing":
      return `复扫输入 intent.md 缺失：${error.path}——探测需要 intent 语义信号（恢复：确认交付任务目录形态，intent.md 由 delivery-v6 init 产出）`;
    case "detector-failed":
      return `外部契约探测 CLI 执行失败（exit ${error.status}）：${error.output}（恢复：按探测 CLI 输出修复后重跑复扫；探测链路上游问题回 delivery-v6 侧处理）`;
    case "detector-output-invalid":
      return `探测 CLI stdout 不是合法 JSON（${error.message}）——候选快照契约破裂（恢复：核对探测 CLI 版本与输出契约（设计 §4.2 候选快照结构）后重跑）`;
    case "review-missing":
      return "验收包声明了 externalContracts 但缺 externalContractReview——strong 候选无处置表可对账（恢复：回 delivery-v6 补 externalContractReview（可为空处置表，detectionSha256 绑定候选快照）后重新编译）";
    case "unresolved-external-access":
      return `未解析外部访问（停回人工）：${error.signal}——${error.reason}。计算式外部成员访问 / 动态 import / eval 等运行时代码生成无法静态归类时禁止放行（恢复：人工归类后登记对应 capability 的 detectionClasses，或改写成可静态判定的调用形态）`;
    case "candidate-undisposed":
      return `strong 候选 ${error.candidateId} 未处置（signals：${error.signals.join("、") || "无"}）——未处置候选阻止编译（恢复：回 delivery-v6 在 externalContractReview.dispositions 补该候选处置；确认不构成外部契约的论证只对 weak 候选有效）`;
    case "candidate-disposition-invalid":
      return `strong 候选 ${error.candidateId} 的处置「${error.disposition}」无效——strong 候选只能 bound 或保持 unresolved 停回，not-external 仅 weak 候选可用（恢复：回 delivery-v6 修订该候选处置；确需按 not-external 放行须先把候选降级为 weak 并给出论证）`;
    case "candidate-contract-unknown":
      return `strong 候选 ${error.candidateId} 处置指向的契约「${error.contractId ?? "未填"}」不在验收包 externalContracts 中（恢复：回 delivery-v6 修订 externalContracts 或该候选处置的 contractId）`;
    case "candidate-classes-unmapped":
      return error.contractId === null
        ? `strong 候选 ${error.candidateId} 的调用类未被任何已声明契约的 capability 覆盖：缺 ${error.missing.join("、")}（源码出现的调用类及其策略表蕴含观察类必须被某个 capability 的 detectionClasses 覆盖——恢复：${RESCAN_DECLARATION_RECOVERY}）`
        : `strong 候选 ${error.candidateId} 的调用类未登记到契约 ${error.contractId}：缺 ${error.missing.join("、")}（源码出现的调用类及其策略表蕴含观察类必须被某个 capability 的 detectionClasses 覆盖——恢复：${RESCAN_DECLARATION_RECOVERY}）`;
    case "exec-plan-unreadable":
      return `无法读取 exec-plan：${error.path}（${error.message}）——D3 复扫缺 probe 节点清单（恢复：核对 --exec-plan 路径；D0 acceptance 编译产物）`;
    case "probe-artifact-unresolvable":
      return `runtime-probe 节点 ${error.nodeId} 的 artifact 缺失或越出交付任务目录（实际：${JSON.stringify(error.artifactRaw ?? null)}）——probe artifact 落点不可判定（恢复：回 tech-design-v6 T3 修正 acceptancePlan 该行 artifact 后重编译）`;
    case "probe-artifact-missing":
      return `runtime probe artifact 未落盘：${error.artifact}（节点 ${error.nodeId}）——probe 未跑或产物被清理，runtime 义务不得进入候选完成（恢复：重跑 D3 该 verify 节点；节点未编译则回 T3 补 runtime-probe 行）`;
    case "probe-artifact-invalid-json":
      return `runtime probe artifact 不是合法 JSON：${error.artifact}（${error.message}）——probe 结果不可机器判定（恢复：重跑该 probe 节点；driver 必须向 stdout 输出单一 JSON（日志走 stderr））`;
    case "probe-nodes-missing":
      return `essential 契约任务未编译任何 runtime-probe 验收节点（essential 契约：${error.essentialIds.join("、")}）——probe 未跑不得进入候选完成（恢复：回 tech-design-v6 T3 在 acceptancePlan 补 runtime-probe 行（type=runtime-probe + capabilityIds + command + artifact）后重跑 acceptance 编译与 D3）`;
    default:
      return `复扫判定拒绝（未登记 code ${String(error.code)}）`;
  }
}

/** delivery-gate evaluate 前置渲染（措辞与升级前 gate 自建复扫一致）。 */
export function renderRescanErrorGate(error) {
  switch (error.code) {
    case "unresolved-external-access":
      return `外部契约候选复扫发现未解外部访问：${error.signal}——${error.reason}。`;
    case "candidate-classes-unmapped":
      return `外部契约候选复扫发现未登记 strong 信号：${error.candidateId}（缺调用类 ${error.missing.join(", ")}）。`;
    case "candidate-undisposed":
      return `外部契约候选复扫发现未处置 strong 候选：${error.candidateId}（signals：${error.signals.join("、") || "无"}）。`;
    case "candidate-disposition-invalid":
      return `外部契约候选复扫发现无效处置的 strong 候选：${error.candidateId}（处置「${error.disposition}」）。`;
    case "candidate-contract-unknown":
      return `外部契约候选复扫发现处置指向不存在契约的 strong 候选：${error.candidateId}（契约「${error.contractId ?? "未填"}」）。`;
    case "review-missing":
      return "验收包声明了 externalContracts 但缺 externalContractReview——候选复扫无处置表可对账。";
    default:
      return renderRescanErrorDevFlow(error);
  }
}

/** gate 前置拒绝时的恢复动作（按拒绝原因给可执行下一步）。 */
export function rescanRecoveryGate(error) {
  switch (error.code) {
    case "unresolved-external-access":
      return "计算式外部成员访问、动态 import、eval/Function/vm 等运行时代码生成无法静态归类时停回人工裁决：要么改写为可静态归类的显式调用，要么由用户裁决该外部访问的契约归属后重试；不做字面白名单放行。";
    case "candidate-classes-unmapped":
      return "能力清单低报的主机器门：在 acceptance.externalContracts 补声明对应调用类的 capability（含 minEnvironment/detectionClasses/surfaceRefs），递增 acceptanceVersion 重新审查批准后重试；确不构成外部契约时由用户裁决并修订验收。";
    default:
      return "回 delivery-v6 修订验收包：补该 strong 候选的 externalContractReview 处置（bound / manual）或修正处置指向，递增 acceptanceVersion 重新审查批准后重试；确认不构成外部契约的论证只对 weak 候选有效。";
  }
}
