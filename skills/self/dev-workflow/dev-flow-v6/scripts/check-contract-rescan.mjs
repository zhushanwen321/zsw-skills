#!/usr/bin/env node
// check-contract-rescan.mjs — 外部契约复扫判定（D0 编译门与 D3 候选完成门共用同一实现）
//
// 设计依据：《V6 运行可用性与外部契约守门升级设计》§4.2（候选探测与 D0 复扫规则）/
// §7.3 dev-flow-v6 D0/D3（复扫与 runtime 义务拦截）/ §8.1（evaluate 前复扫同一判定）。
// 定位：只读复扫 + 结构化判定，不写任何产物。判定逻辑单一实现、两侧消费——
//   - D0 编译门：compile-exec-plan.mjs 写盘前 import runContractRescan（stage=d0），
//     拒绝项进语义缺口报告（拒绝编译并回验收修订，错误消息附恢复动作）；
//   - D3 候选完成门：主 agent 在 D3 全绿后、D4 候选完成前跑本 CLI（stage=d3），
//     复扫有未登记 strong 信号 / unresolved 外部访问 / probe 未跑时不得进入候选完成；
//   - evaluate 侧复扫归内核线，经本模块导出函数消费同一判定（不在对侧复刻）。
//
// 输入契约（上游固定，本模块只消费）：
//   - 探测 CLI：node ~/.agents/skills/delivery-v6/scripts/detect-external-contracts.mjs
//     --project-root <R> --intent-file <taskDir>/intent.md → stdout JSON，
//     形态 { candidates: [{id, strength, signals[], suggestedResolver?, suggestedLocator?}],
//            unresolved: [{signal, reason}] }（设计 §4.2 候选快照结构）；
//   - 验收包 acceptance.json 顶层 externalContracts / externalContractReview；
//   - impl-plan acceptancePlan 的 runtime-probe 行由 D0 编译进 exec-plan acceptance.nodes
//     （node.runtimeProbe = {capabilityIds, command, artifact}，字段权威见 check-exec-plan）。
//
// 判定规则（与设计 §4.2 D0 复扫规则逐条对应；D3 与 evaluate 复用同一判定）：
//   1. unresolved 非空 → 停回人工（计算式外部成员访问 / 动态 import 等无法静态归类，
//      不做字面白名单放行）；
//   2. strong 候选必须已有处置（bound / manual）且落到已声明契约——未处置 / not-external /
//      unresolved 处置全部拒绝（not-external 仅 weak 候选可用）；
//   3. strong 候选的调用类信号（call-class:X）及其策略表蕴含观察类必须被该契约某个
//      capability 的 detectionClasses 覆盖——缺一项即拒绝并回验收修订（能力清单低报的主机器门）；
//   4. strong 候选绑定到验收标 optional 的契约 → 强制按 essential 处理（回灌编译门的
//      契约冒烟增量与 DAG 检查，并披露给 evaluate 侧义务派生）；
//   5. stage=d3 追加：essential 契约任务必须已编译 runtime-probe 验收节点且 probe artifact
//      落盘可解析——probe 未跑不得进入候选完成。
// 信号种类口径：manifest / doc / intent 类信号是候选判强依据，不映射 capability；
// 只有 call-class 类信号（+ 蕴含观察类）与 capability.detectionClasses 对账。
//
// 用法（CLI，D3 候选完成门）：
//   node check-contract-rescan.mjs --task-dir <交付任务目录> --project-root <项目根>
//         [--intent-file <taskDir>/intent.md>] [--exec-plan <exec-plan 绝对路径>] --stage d3
// 退出码：0 通过（含升级前旧任务不适用）；1 判定拒绝或复扫输入不可用；2 用法错误。

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 探测 CLI 安装形态（与设计 §4.2 命令逐字一致的家目录锚定——跨技能引用写安装后路径）
const DETECTOR_PATH = join(homedir(), ".agents", "skills", "delivery-v6", "scripts", "detect-external-contracts.mjs");
// 策略包（调用类目录的长期权威）：delivery-v6 policies/external-contract-classes.json 的
// classes[].impliesObservationClasses 是蕴含观察关系的唯一权威源。读取失败时回退到设计
// §4.1 固定的初始关系（register-command 蕴含 dispatch-command）——回退只保初始表，不猜
const POLICY_PATH = join(homedir(), ".agents", "skills", "delivery-v6", "policies", "external-contract-classes.json");
const IMPLIED_CLASSES_FALLBACK = { "register-command": ["dispatch-command"] };
// 调用类信号段：探测线实定形态 = source:<文件>:call-class:<类id>（设计 §4.2 示例的裸
// "call-class:<类id>" 前缀形态一并容忍——两种都解析，取并集）
const CALL_CLASS_RE = /(?:^|:)call-class:([A-Za-z0-9_-]+)/;
const VALID_STAGES = new Set(["d0", "d3"]);

/** 策略包蕴含观察类表（classes[].id → impliesObservationClasses[]）；读不到/损坏回退初始表 */
function loadImpliedClasses() {
  try {
    const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
    const table = {};
    for (const cls of Array.isArray(policy?.classes) ? policy.classes : []) {
      if (typeof cls?.id !== "string" || cls.id === "") continue;
      const implied = Array.isArray(cls.impliesObservationClasses) ? cls.impliesObservationClasses.filter((x) => typeof x === "string" && x.trim() !== "") : [];
      if (implied.length > 0) table[cls.id] = implied;
    }
    return Object.keys(table).length > 0 ? table : IMPLIED_CLASSES_FALLBACK;
  } catch {
    return IMPLIED_CLASSES_FALLBACK;
  }
}

const isRec = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.trim() !== "";
const isStrArr = (x) => Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");

/** 候选信号里的调用类集合：call-class 段形态 + 探测器自带 callClasses 数组取并集 */
function callClassesOf(candidate) {
  const classes = new Set();
  for (const s of Array.isArray(candidate?.signals) ? candidate.signals : []) {
    if (typeof s !== "string") continue;
    const m = s.match(CALL_CLASS_RE);
    if (m) classes.add(m[1]);
  }
  for (const c of Array.isArray(candidate?.callClasses) ? candidate.callClasses : []) {
    if (isStr(c)) classes.add(c.trim());
  }
  return [...classes];
}

/** 调用类 + 策略表蕴含观察类的并集（design §4.1 初始表） */
function observedClassesOf(candidate, impliedTable) {
  const all = new Set(callClassesOf(candidate));
  for (const cls of [...all]) {
    for (const implied of impliedTable[cls] ?? []) all.add(implied);
  }
  for (const c of Array.isArray(candidate?.impliedClasses) ? candidate.impliedClasses : []) {
    if (isStr(c)) all.add(c.trim());
  }
  return [...all];
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * 复扫 + 判定单一实现（D0 / D3 / evaluate 共用）。
 * @param {{taskDir: string, projectRoot: string, intentFile?: string|null,
 *          acceptance?: object|null, stage?: "d0"|"d3", execPlanPath?: string|null}} opts
 * @returns {{ok: boolean, skipped: boolean, errors: {category: string, message: string}[],
 *            notes: string[], effectiveEssential: string[], forcedEssential: string[],
 *            candidateCount: number, strongCount: number, unresolvedCount: number,
 *            probeNodeCount: number}}
 */
export function runContractRescan(opts) {
  const taskDir = opts.taskDir;
  const projectRoot = opts.projectRoot;
  const stage = VALID_STAGES.has(opts.stage) ? opts.stage : "d3";
  const intentFile = isStr(opts.intentFile) ? opts.intentFile : join(taskDir, "intent.md");
  const errors = [];
  const notes = [];
  const empty = {
    ok: true,
    skipped: true,
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
    errors.push({ category: "rescan", message: "复扫输入不完整：--task-dir 与 --project-root 均必填（交付任务目录 + 当前候选源码所在项目根）" });
    return { ...empty, ok: false };
  }

  // 验收包（调用方已解析则复用，避免同一文件两次 IO）
  let acceptance = opts.acceptance ?? null;
  if (acceptance === null) {
    try {
      acceptance = readJsonFile(join(taskDir, "acceptance.json"));
    } catch (e) {
      errors.push({
        category: "rescan",
        message: `无法读取交付任务目录 acceptance.json：${join(taskDir, "acceptance.json")}（${e.message}）——复扫判定缺验收包输入（恢复：核对 --task-dir 指向 delivery-v6 产出的交付任务目录）`,
      });
      return { ...empty, ok: false };
    }
  }
  const contracts = isRec(acceptance) && Array.isArray(acceptance.externalContracts) ? acceptance.externalContracts : null;
  const review = isRec(acceptance) && isRec(acceptance.externalContractReview) ? acceptance.externalContractReview : null;
  if (contracts === null && review === null) {
    // 升级前旧任务（验收包无 externalContracts / externalContractReview）——外部契约复扫门不适用
    notes.push("升级前旧任务（验收包无 externalContracts / externalContractReview）——外部契约复扫门不适用，按无外部契约任务放行");
    return { ...empty };
  }

  // 探测 CLI 在场性（fail-closed：门禁输入不可用时不放行——不可用降级会让强信号绕过对账）
  if (!existsSync(DETECTOR_PATH)) {
    errors.push({
      category: "rescan",
      message: `外部契约探测 CLI 不在安装位置：${DETECTOR_PATH}——复扫无法执行（恢复：确认 delivery-v6 技能已安装（ln -s 到 ~/.agents/skills/delivery-v6）；命令形态 = node ${DETECTOR_PATH} --project-root <项目根> --intent-file <taskDir>/intent.md）`,
    });
    return { ...empty, ok: false };
  }
  if (!existsSync(intentFile)) {
    errors.push({
      category: "rescan",
      message: `复扫输入 intent.md 缺失：${intentFile}——探测需要 intent 语义信号（恢复：确认交付任务目录形态，intent.md 由 delivery-v6 init 产出）`,
    });
    return { ...empty, ok: false };
  }

  const run = spawnSync(process.execPath, [DETECTOR_PATH, "--project-root", projectRoot, "--intent-file", intentFile], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.status !== 0) {
    errors.push({
      category: "rescan",
      message: `外部契约探测 CLI 执行失败（exit ${run.status}）：${String(run.stderr || run.stdout || "").trim()}（恢复：按探测 CLI 输出修复后重跑复扫；探测链路上游问题回 delivery-v6 侧处理）`,
    });
    return { ...empty, ok: false };
  }
  let detection;
  try {
    detection = JSON.parse(String(run.stdout || ""));
  } catch (e) {
    errors.push({
      category: "rescan",
      message: `探测 CLI stdout 不是合法 JSON（${e.message}）——候选快照契约破裂（恢复：核对探测 CLI 版本与输出契约（设计 §4.2 候选快照结构）后重跑）`,
    });
    return { ...empty, ok: false };
  }
  const candidates = Array.isArray(detection?.candidates) ? detection.candidates : [];
  const unresolved = Array.isArray(detection?.unresolved) ? detection.unresolved : [];

  // ① unresolved 外部访问 → 停回（不做字面白名单放行）
  for (const u of unresolved) {
    errors.push({
      category: "rescan",
      message: `未解析外部访问（停回人工）：${isRec(u) ? `${u.signal ?? "未命名信号"}——${u.reason ?? "无理由"}` : String(u)}。计算式外部成员访问 / 动态 import / eval 等运行时代码生成无法静态归类时禁止放行（恢复：人工归类后登记对应 capability 的 detectionClasses，或改写成可静态判定的调用形态）`,
    });
  }

  // 处置表（externalContractReview.dispositions：candidateId → {disposition, contractId?}）
  const dispositions = new Map();
  for (const d of Array.isArray(review?.dispositions) ? review.dispositions : []) {
    if (isRec(d) && isStr(d.candidateId)) dispositions.set(d.candidateId, d);
  }
  if (review === null) {
    errors.push({
      category: "rescan",
      message: "验收包声明了 externalContracts 但缺 externalContractReview——strong 候选无处置表可对账（恢复：回 delivery-v6 补 externalContractReview（可为空处置表，detectionSha256 绑定候选快照）后重新编译）",
    });
  }

  const declaredEssential = new Set(
    (contracts ?? []).filter((c) => isRec(c) && isStr(c.id) && c.essential === true).map((c) => c.id),
  );
  const forcedEssential = new Set();
  const contractById = new Map((contracts ?? []).filter((c) => isRec(c) && isStr(c.id)).map((c) => [c.id, c]));
  const impliedTable = loadImpliedClasses();

  for (const cand of candidates) {
    if (!isRec(cand) || cand.strength !== "strong") continue; // weak 候选由 reviewer 论证，不进机器门
    const candId = isStr(cand.id) ? cand.id : "（无 id 候选）";
    const d = dispositions.get(cand.id);
    if (d === undefined) {
      errors.push({
        category: "rescan",
        message: `strong 候选 ${candId} 未处置（signals：${(Array.isArray(cand.signals) ? cand.signals : []).join("、") || "无"}）——未处置候选阻止编译（恢复：回 delivery-v6 在 externalContractReview.dispositions 补该候选处置；确认不构成外部契约的论证只对 weak 候选有效）`,
      });
      continue;
    }
    const disp = d.disposition;
    if (disp !== "bound" && disp !== "manual") {
      errors.push({
        category: "rescan",
        message: `strong 候选 ${candId} 的处置「${String(disp)}」无效——strong 候选只能 bound 或保持 unresolved 停回，not-external 仅 weak 候选可用（恢复：回 delivery-v6 修订该候选处置；确需按 not-external 放行须先把候选降级为 weak 并给出论证）`,
      });
      continue;
    }
    const contractId = d.contractId;
    const contract = isStr(contractId) ? contractById.get(contractId) : undefined;
    if (contract === undefined) {
      errors.push({
        category: "rescan",
        message: `strong 候选 ${candId} 处置指向的契约「${String(contractId)}」不在验收包 externalContracts 中（恢复：回 delivery-v6 修订 externalContracts 或该候选处置的 contractId）`,
      });
      continue;
    }
    // 调用类（含蕴含观察类）→ capability.detectionClasses 覆盖对账
    const observed = observedClassesOf(cand, impliedTable);
    const declared = new Set();
    for (const cap of Array.isArray(contract.capabilities) ? contract.capabilities : []) {
      for (const cls of Array.isArray(cap?.detectionClasses) ? cap.detectionClasses : []) {
        if (isStr(cls)) declared.add(cls.trim());
      }
    }
    const missing = observed.filter((cls) => !declared.has(cls));
    if (missing.length > 0) {
      errors.push({
        category: "rescan",
        message: `strong 候选 ${candId} 的调用类未登记到契约 ${contractId}：缺 ${missing.join("、")}（源码出现的调用类及其策略表蕴含观察类必须被某个 capability 的 detectionClasses 覆盖——恢复：回 delivery-v6 修订 externalContracts 的 capabilities / detectionClasses 后重新编译）`,
      });
      continue;
    }
    // 实际使用（源码 / manifest 强信号）→ 强制按 essential 处理
    if (contract.essential !== true) {
      forcedEssential.add(contractId);
      notes.push(`契约 ${contractId} 验收标 optional，但复扫发现实际使用信号（候选 ${candId}）——按 essential 处理（契约冒烟增量、spike DAG 与 runtime 义务均按 essential 判定）`);
    }
  }

  // stage=d3：runtime probe 节点与 artifact 落盘核对（probe 未跑不得进入候选完成）
  let probeNodeCount = 0;
  if (stage === "d3" && isStr(opts.execPlanPath)) {
    let execPlan;
    try {
      execPlan = readJsonFile(opts.execPlanPath);
    } catch (e) {
      errors.push({
        category: "probe",
        message: `无法读取 exec-plan：${opts.execPlanPath}（${e.message}）——D3 复扫缺 probe 节点清单（恢复：核对 --exec-plan 路径；D0 acceptance 编译产物）`,
      });
      return finish();
    }
    const accNodes = isRec(execPlan) && execPlan.mode === "acceptance" && isRec(execPlan.acceptance) && Array.isArray(execPlan.acceptance.nodes)
      ? execPlan.acceptance.nodes
      : [];
    for (const n of accNodes) {
      if (!isRec(n) || !isRec(n.runtimeProbe)) continue;
      probeNodeCount += 1;
      // artifact 落点：exec-plan 节点上为绝对路径（编译期按任务目录相对声明解析并做越界
      // 检查）；相对形态（手改 exec-plan 或历史产物）按 taskDir 解析且禁止 .. 逃逸
      const artifactRaw = n.runtimeProbe.artifact;
      let artifact = null;
      if (isStr(artifactRaw)) {
        if (isAbsolute(artifactRaw)) artifact = artifactRaw;
        else {
          const p = resolve(taskDir, artifactRaw);
          if (p === taskDir || p.startsWith(`${taskDir}/`)) artifact = p;
        }
      }
      if (artifact === null) {
        errors.push({
          category: "probe",
          message: `runtime-probe 节点 ${n.id} 的 artifact 缺失或越出交付任务目录（实际：${JSON.stringify(artifactRaw ?? null)}）——probe artifact 落点不可判定（恢复：回 tech-design-v6 T3 修正 acceptancePlan 该行 artifact 后重编译）`,
        });
        continue;
      }
      if (!existsSync(artifact)) {
        errors.push({
          category: "probe",
          message: `runtime probe artifact 未落盘：${artifact}（节点 ${n.id}）——probe 未跑或产物被清理，runtime 义务不得进入候选完成（恢复：重跑 D3 该 verify 节点；节点未编译则回 T3 补 runtime-probe 行）`,
        });
        continue;
      }
      try {
        JSON.parse(readFileSync(artifact, "utf8"));
      } catch (e) {
        errors.push({
          category: "probe",
          message: `runtime probe artifact 不是合法 JSON：${artifact}（${e.message}）——probe 结果不可机器判定（恢复：重跑该 probe 节点；driver 必须向 stdout 输出单一 JSON（日志走 stderr））`,
        });
      }
    }
    const essentialIds = new Set([...declaredEssential, ...forcedEssential]);
    if (essentialIds.size > 0 && probeNodeCount === 0) {
      errors.push({
        category: "probe",
        message: `essential 契约任务未编译任何 runtime-probe 验收节点（essential 契约：${[...essentialIds].join("、")}）——probe 未跑不得进入候选完成（恢复：回 tech-design-v6 T3 在 acceptancePlan 补 runtime-probe 行（type=runtime-probe + capabilityIds + command + artifact）后重跑 acceptance 编译与 D3）`,
      });
    }
  }

  return finish();

  function finish() {
    const effectiveEssential = [...new Set([...declaredEssential, ...forcedEssential])];
    const ok = errors.length === 0;
    return {
      ok,
      skipped: false,
      errors,
      notes,
      effectiveEssential,
      forcedEssential: [...forcedEssential],
      candidateCount: candidates.length,
      strongCount: candidates.filter((c) => isRec(c) && c.strength === "strong").length,
      unresolvedCount: unresolved.length,
      probeNodeCount,
    };
  }
}

// ── CLI（D3 候选完成门；D0 编译门走进程内 import，不经过本入口） ──

function usage() {
  return [
    "用法：node check-contract-rescan.mjs --task-dir <交付任务目录> --project-root <项目根> --stage d0|d3 [--intent-file <路径>] [--exec-plan <路径>]",
    "  --task-dir     交付任务目录（读 acceptance.json 的 externalContracts / externalContractReview）",
    "  --project-root 当前候选源码所在项目根（探测 CLI 的源码扫描输入）",
    "  --stage        d0 = 编译期复扫；d3 = 候选完成门复扫（追加 probe 节点与 artifact 核对，须带 --exec-plan）",
    "  --intent-file  缺省 <task-dir>/intent.md",
    "  --exec-plan    stage=d3 必带：D0 acceptance 编译产物（runtime-probe 节点清单来源）",
    "",
    "退出码：0 通过（含升级前旧任务不适用）；1 判定拒绝或复扫输入不可用；2 用法错误。",
  ].join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { taskDir: null, projectRoot: null, stage: null, intentFile: null, execPlanPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task-dir") opts.taskDir = argv[++i];
    else if (a === "--project-root") opts.projectRoot = argv[++i];
    else if (a === "--stage") opts.stage = argv[++i];
    else if (a === "--intent-file") opts.intentFile = argv[++i];
    else if (a === "--exec-plan") opts.execPlanPath = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      process.stderr.write(`用法错误：未知参数「${a}」\n${usage()}\n`);
      process.exit(2);
    }
  }
  if (!opts.taskDir || !opts.projectRoot || !VALID_STAGES.has(opts.stage)) {
    process.stderr.write(`用法错误：--task-dir / --project-root / --stage（d0|d3）均必填\n${usage()}\n`);
    process.exit(2);
  }
  if (opts.stage === "d3" && !opts.execPlanPath) {
    process.stderr.write(`用法错误：--stage d3 须带 --exec-plan（runtime-probe 节点清单来源）\n${usage()}\n`);
    process.exit(2);
  }
  const result = runContractRescan({
    taskDir: opts.taskDir,
    projectRoot: opts.projectRoot,
    intentFile: opts.intentFile,
    stage: opts.stage,
    execPlanPath: opts.execPlanPath,
  });
  for (const note of result.notes) process.stdout.write(`NOTE ${note}\n`);
  if (!result.ok) {
    for (const e of result.errors) process.stdout.write(`FAIL: ${e.category}: ${e.message}\n`);
    process.stdout.write(
      [
        "",
        `复扫未过（stage=${opts.stage}）：候选 ${result.candidateCount} 个（strong ${result.strongCount} 个）、未解析外部访问 ${result.unresolvedCount} 处。`,
        "恢复动作：按上方 FAIL 逐条处置——未登记调用类 / 候选未处置回 delivery-v6 修订验收包（递增验收版本）后重跑；unresolved 外部访问人工归类或改写调用形态；probe 未跑重跑 D3 对应 verify 节点。",
      ].join("\n") + "\n",
    );
    process.exit(1);
  }
  if (result.skipped) {
    process.stdout.write("PASS 外部契约复扫不适用（升级前旧任务或验收包无外部契约声明）\n");
  } else {
    process.stdout.write(
      `PASS 外部契约复扫通过（stage=${opts.stage}；候选 ${result.candidateCount} 个 / strong ${result.strongCount} 个 / unresolved ${result.unresolvedCount} 处；essential 契约 ${result.effectiveEssential.length} 个${result.forcedEssential.length > 0 ? `，其中强制按 essential 处理 ${result.forcedEssential.length} 个` : ""}；runtime-probe 节点 ${result.probeNodeCount} 个）\n`,
    );
  }
  process.exit(0);
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export { isMainEntry };

if (isMainEntry()) main();
