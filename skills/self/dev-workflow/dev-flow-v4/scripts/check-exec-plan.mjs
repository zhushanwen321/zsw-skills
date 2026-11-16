#!/usr/bin/env node
// check-exec-plan.mjs — exec-plan 内容校验（D0 编译「生成即校验」门，flow/compile.md 步骤 3）
//
// 同源声明 [防漂移]：schema 主段与 W2 wave-executor-v4 引擎的 validatePlan 同源
// （workflows/src/wave-executor-v4.shared.ts「exec-plan schema 校验」段），错误文案逐字一致；
// 必填字段与 testPlan 段与 W3 dev-consistency-loop-v4 引擎的 NODE_PREP 启动校验同源
// （workflows/src/dev-consistency-loop-v4.shared.ts；testPlan 白名单 = pnpm/npm/node/bash，
// W2 节点 testCommand 白名单 = pnpm/npm/node/git/bash）。任一侧改动必须同步另一侧，
// 漂移由差分测试机器对账拦截：
//   node --test scripts/tests/check-exec-plan-parity.test.mjs
// （从构建产物 workflows/pi/wave-executor-v4.js 零转抄提取 validatePlan 实跑，逐 fixture
//   断言两侧 ok 与错误文案一致；本脚本独有的附加检查单独断言。产物与源的一致性由
//   build-workflows --check 与 parity 检查另有门把守，此处只对账两侧语义。）
//
// 校验范围 = 计划内容的静态可判部分（无 fs / git 依赖，纯确定性）：
//   - W2 validatePlan 全部错误类别（顶层结构 / 节点字段 / territory 形态与互斥断言 /
//     依赖环 / 引用存在性 / commitTemplate / acceptance 分组）
//   - W3 启动契约：planPath / designDocPath / baseline 必填、baseline git hash 形态、
//     testPlan.fullSuite 必填与 artifacts / incremental 形态白名单恒绿检测
//   - 附加静态项：verify script 扩展名（W2 setup 启动校验同款，前移到编译点）、
//     cwd 形态（null/省略 = projectRoot；填值必须为绝对路径——相对路径会被引擎按
//     projectRoot 拼成仓库子目录，正是「禁仓库子目录」条款的成因）
//   运行时环境断言（cwd == git rev-parse --show-toplevel、promptFile / verify script
//   盘上存在、projectRoot 存在）仍在 W2 引擎 setup 派发前 fail-fast，不进本静态门——
//   promptFile 在编译清单下一步才构造，静态门若查存在性会在正确计划上恒红。
//
// 用法：node check-exec-plan.mjs <exec-plan.json 绝对路径> [--task-dir <交付任务目录>]
// 输出契约（--check 风格）：全部通过 → stdout `PASS`，exit 0；失败 → 每条错误一行
//   `FAIL: <分类>: <明细>`（全部报完再退出），exit 1；用法错误 exit 2（含恢复动作）。
// --task-dir（交付体系任务必传，独立设计任务不传）：附加执行三段核对——①增量契约核对：
//   读交付任务目录 increments.json，核 exec-plan dev 节点的增量归属与测试命令（判据见下方
//   checkIncrementContract 段）；②验收绑定核对：读设计包 meta.json（路径从 exec-plan
//   designDocPath 推导）与交付任务目录 acceptance.json，核 acceptanceBinding 与当前批准
//   一致（判据见下方 checkAcceptanceBinding 段）；③质量契约核对：主校验与①②全过后调
//   delivery-v4 check-quality-contract（--task-dir + --exec-plan；designDocPath 可解析时
//   追加 --design-dir 设计目录——机制对账 criterionMechanisms 与测试绑定 verificationBindings
//   只在该分支核对，缺传则漏检）。不传时三段跳过，主校验行为不变。
//
// 分类 → 处置路由（与 W2 启动校验失败的恢复指引同语义）：
//   field/territory/ref/whitelist/noop/cwd/script/testPlan → 单字段手修 exec-plan 后
//     重跑本门（值转抄自 impl-plan 的字段须同步修上游，否则重编译复现）；结构性缺漏
//     （schema、缺数组类 field）→ 回编译清单重编译；cycle/overlap（依赖环、territory
//     重叠无依赖路径）→ 回 tech-design-v4 T3 修 impl-plan，手修 exec-plan 确定性复现；
//   increments（增量契约）→ 回 tech-design-v4 T3「增量契约对齐」节（flow/plan.md）——
//     增量的增删改属技能①职权，须回 delivery-v4 递增验收版本重批，不在 impl-plan 侧改；
//   binding（验收绑定）→ 回 tech-design-v4 T1 入口门（flow/write.md Step 0）重新影响审查
//     并更新 meta.json acceptanceBinding——验收版本/验收包内容变化属交付体系变更（技能①
//     裁决域），不在 exec-plan 侧改；
//   quality（质量契约）→ check-quality-contract 的机制对账/测试绑定缺口，回 tech-design-v4
//     T2 修设计包 s4-accept.json（criterionMechanisms / verificationBindings 是 T2 产物）。
//
// 验收绑定段的 canonicalJson / acceptancePackageSha256 与 delivery-v4 裁决器 delivery-gate.mjs
// 逐字同源（该脚本是直跑 CLI、无 export，故此处复刻）——改任一侧必须同步另一侧；哈希口径
// 变化会使全部已登记 binding 失效，属数据契约变更（MAJOR）。

import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 常量（与两引擎逐字一致；改任一侧须同步并跑差分测试） ──

const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"]; // W2 节点 testCommand
const TEST_PLAN_WHITELIST = ["pnpm", "npm", "node", "bash"]; // W3 testPlan（无 git——全量门无 git 用例）
const VERIFY_SCRIPT_EXTS = new Set([".sh", ".mjs", ".js", ".cjs"]);
// 恒绿形态三式与 W2 NOOP_CMD_* / W3 STUB_RE/NOOP_RE/STUB_HEAD_RE 逐字一致（三处同步）
const NOOP_CMD_STUB_RE = /^\s*(true|false|:)\s*$/;
const NOOP_CMD_ECHO_RE = /^\s*(echo|printf)\b/;
const NOOP_CMD_STUB_HEAD_RE = /^\s*(true|false|:|exit)(\s|$)/;
const SHELL_SAFE_ARG_RE = /^[A-Za-z0-9_/:.,@%^+=-]+$/;

// ── 纯工具（与 W2 同名函数逐字一致） ──

function isRec(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isStr(x) {
  return typeof x === "string" && x.trim() !== "";
}
function isStrArr(x) {
  return Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");
}
/** 相对路径挂在 projectRoot 下；绝对路径原样返回 */
function joinPath(base, rel) {
  if (rel.startsWith("/")) return rel;
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${rel}`;
}
function shellQuoteArg(s) {
  return SHELL_SAFE_ARG_RE.test(s) ? s : "'" + s.split("'").join("'\\''") + "'";
}
/** 恒绿形态判定：命中返回拒收文案（含恢复动作），未命中返回 null */
function noopCommandError(label, program, args) {
  const full = [program, ...args].map(shellQuoteArg).join(" ");
  const cands = [full, ...args];
  if (program === "bash" || program === "sh") {
    const flagIdx = args.findIndex((a) => /^-[a-z]*c/i.test(a));
    if (flagIdx >= 0) {
      const raw = args[flagIdx + 1];
      if (typeof raw === "string" && raw.length > 0) {
        let cmd = raw;
        if (cmd.length > 1 && (cmd.charCodeAt(0) === 39 || cmd.charCodeAt(0) === 34) && cmd.charCodeAt(cmd.length - 1) === cmd.charCodeAt(0)) {
          cmd = cmd.slice(1, -1);
        }
        cands.push(cmd, ...cmd.split(/;|&&/));
      }
    }
  }
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (NOOP_CMD_STUB_RE.test(c) || (i > args.length && NOOP_CMD_STUB_HEAD_RE.test(c)) || NOOP_CMD_ECHO_RE.test(c)) {
      return `${label} 是恒绿形态命令（${full}）——不构成真实测试证据（恢复：检查 testPlan.fullSuite / testPlan.artifacts[n].command / testPlan.incremental / 节点 testCommand 是否为真实测试命令）`;
    }
  }
  return null;
}
/** territory 条目形态契约：条目 = 相对该节点 cwd 所在 git 仓库根的纯路径（文件或目录前缀）。
 *  绝对路径与空格/括号注释混合形态在 pathInTerritory 匹配上恒失败——错误就地暴露，
 *  不做归一化宽容吸收（引擎猜作者意图比静默失效更危险） */
function territoryFormatErrors(id, entries) {
  const errs = [];
  const abs = entries.filter((t) => t.startsWith("/"));
  if (abs.length > 0) {
    errs.push(`dev 节点 ${id} 的 territory 含绝对路径（${abs.join("、")}）——须为相对该节点 cwd 所在 git 仓库根的相对路径`);
  }
  const mixed = entries.filter((t) => /\s/.test(t) || /[()（）]/.test(t));
  if (mixed.length > 0) {
    errs.push(`dev 节点 ${id} 的 territory 含混合形态条目（空格/括号注释）：${mixed.join("、")}——territory 是启动互斥断言的机器输入，条目须为纯路径`);
  }
  return errs;
}
/** 依赖环检测：DFS 三色标记，命中回边返回环上节点 id，无环返回 null */
function detectCycle(ids, depsOf) {
  const color = new Map(); // 0=未访 1=在当前路径 2=完成
  for (const id of ids) color.set(id, 0);
  let hit = null;
  const visit = (id) => {
    if (hit !== null) return;
    const c = color.get(id) ?? 0;
    if (c === 1) {
      hit = id;
      return;
    }
    if (c === 2) return;
    color.set(id, 1);
    for (const d of depsOf.get(id) ?? []) visit(d);
    color.set(id, 2);
  };
  for (const id of ids) {
    visit(id);
    if (hit !== null) break;
  }
  return hit;
}

// ── schema 主段（W2 validatePlan 同源移植：错误文案与分段早退逐字一致——
//    早退位置也属契约，决定哪些类别同批可报） ──

/**
 * @param {unknown} raw
 * @returns {{ ok: boolean, errors: {category: string, message: string}[], rawNodes: unknown[] | null }}
 *   rawNodes = 节点集收集阶段的原始条目（null = schema 在收集前早退，附加契约无从核）
 */
function validatePlanSchema(raw) {
  const errors = [];
  const add = (category, message) => errors.push({ category, message });
  if (!isRec(raw)) {
    return { ok: false, errors: [{ category: "schema", message: "exec-plan 根必须是 JSON 对象" }], rawNodes: null };
  }
  // version 不符时整体 schema 形态不可信，单独 return（与 W2 同判据：吞掉节点级错误
  // 比少报更危险的反向——早退位置即契约）
  if (raw.version !== 1) {
    return {
      ok: false,
      errors: [{ category: "schema", message: `version 必须为 1，实际：${JSON.stringify(raw.version)}` }],
      rawNodes: null,
    };
  }
  const mode = raw.mode === "dev" || raw.mode === "acceptance" ? raw.mode : null;
  if (mode === null) {
    add("schema", `mode 必须是 "dev" 或 "acceptance"，实际：${JSON.stringify(raw.mode)}`);
    return { ok: false, errors, rawNodes: null };
  }
  const projectRoot = isStr(raw.projectRoot) ? raw.projectRoot : null;
  if (projectRoot === null) {
    add("field", "projectRoot 必须是非空字符串（git/测试/commit 的缺省 cwd——引擎不从进程 cwd 推导）");
  }
  const statusPathRel = isStr(raw.statusPath) ? raw.statusPath : null;
  if (statusPathRel === null) {
    add("field", "statusPath 必须是非空字符串");
  }
  const workspaceRoot = raw.workspaceRoot === undefined ? null : isStr(raw.workspaceRoot) ? raw.workspaceRoot : null;
  if (raw.workspaceRoot !== undefined && workspaceRoot === null) {
    add("field", "workspaceRoot 若提供必须是非空字符串（工作区根绝对路径）");
  } else if (workspaceRoot !== null && !workspaceRoot.startsWith("/")) {
    add("field", `workspaceRoot 必须是绝对路径（实际：${workspaceRoot}）`);
  }
  // projectRoot/statusPath 是路径基准，缺失时节点级校验无从进行——两者错误收集齐后即返回
  if (projectRoot === null || statusPathRel === null) return { ok: false, errors, rawNodes: null };

  // 节集：dev 模式=顶层 nodes；acceptance 模式=acceptance.nodes
  const rawNodes = [];
  let accRec = null;
  if (mode === "dev") {
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
      add("field", "mode=dev 时顶层 nodes 必须是非空数组");
    } else {
      rawNodes.push(...raw.nodes);
    }
  } else {
    if (!isRec(raw.acceptance)) {
      add("field", "mode=acceptance 时必须提供 acceptance 对象（nodes/groups；core/haltOnCoreFail 已退役被忽略）");
    } else {
      accRec = raw.acceptance;
      if (!Array.isArray(accRec.nodes) || accRec.nodes.length === 0) {
        add("field", "acceptance.nodes 必须是非空数组");
      } else {
        rawNodes.push(...accRec.nodes);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, rawNodes: null };

  const nodes = [];
  const idSet = new Set();
  for (let i = 0; i < rawNodes.length; i += 1) {
    const rn = rawNodes[i];
    if (!isRec(rn)) {
      add("field", `nodes[${i}] 必须是对象`);
      continue;
    }
    if (!isStr(rn.id)) {
      add("field", `nodes[${i}] 缺少非空 id`);
      continue;
    }
    const id = rn.id;
    if (idSet.has(id)) add("field", `节点 id 重复：${id}`);
    idSet.add(id);
    const kind = rn.kind;
    if (kind !== "dev" && kind !== "verify" && kind !== "inspect") {
      add("field", `节点 ${id} 的 kind 必须是 dev/verify/inspect，实际：${JSON.stringify(kind)}`);
      continue;
    }
    if (mode === "dev" && kind === "inspect") {
      add("field", `mode=dev 但节点 ${id} kind=inspect（inspect 任务书属验收语义；dev 模式仅允许 dev 节点与开发期 e2e 的 verify 节点）`);
    }
    if (mode === "acceptance" && kind === "dev") {
      add("field", `mode=acceptance 但节点 ${id} kind=dev（dev 节点属 D1 实例化）`);
    }
    if (!isStrArr(rn.deps)) {
      add("field", `节点 ${id} 的 deps 必须是字符串数组`);
      continue;
    }
    const node = {
      id,
      kind,
      deps: rn.deps,
      designRef: isStr(rn.designRef) ? rn.designRef : "",
      territory: [],
      testCommand: null,
      promptFile: "",
      script: "",
      artifactsDir: "",
      artifactsRefs: [],
      cwd: isStr(rn.cwd) ? joinPath(projectRoot, rn.cwd) : projectRoot,
    };
    if (kind === "dev") {
      if (!isStrArr(rn.territory) || rn.territory.length === 0) {
        add("field", `dev 节点 ${id} 的 territory 必须是非空字符串数组（范围声明）`);
      } else {
        const terrErrs = territoryFormatErrors(id, rn.territory);
        if (terrErrs.length === 0) node.territory = rn.territory;
        else for (const m of terrErrs) add("territory", m);
      }
      if (!isStr(rn.promptFile)) {
        add("field", `dev 节点 ${id} 缺少 promptFile`);
      } else {
        node.promptFile = joinPath(projectRoot, rn.promptFile);
      }
      const tc = rn.testCommand;
      if (!isRec(tc) || !isStr(tc.program) || !isStrArr(tc.args)) {
        add("field", `dev 节点 ${id} 的 testCommand 必须是 {program, args} 形态（program 字符串 + args 字符串数组）`);
      } else {
        if (!TEST_WHITELIST.includes(tc.program)) {
          add("whitelist", `dev 节点 ${id} 的 testCommand.program "${tc.program}" 不在白名单（${TEST_WHITELIST.join("/")}）`);
        }
        const noopErr = noopCommandError(`dev 节点 ${id} 的 testCommand`, tc.program, tc.args);
        if (noopErr !== null) add("noop", noopErr);
        node.testCommand = { program: tc.program, args: tc.args };
      }
    } else if (kind === "verify") {
      if (!isStr(rn.script)) {
        add("field", `verify 节点 ${id} 缺少 script（L3 剧本路径）`);
      } else {
        node.script = joinPath(projectRoot, rn.script);
      }
      if (!isStr(rn.artifactsDir)) {
        add("field", `verify 节点 ${id} 缺少 artifactsDir`);
      } else {
        node.artifactsDir = joinPath(projectRoot, rn.artifactsDir);
      }
    } else {
      if (!isStr(rn.promptFile)) {
        add("field", `inspect 节点 ${id} 缺少 promptFile（L4 任务书）`);
      } else {
        node.promptFile = joinPath(projectRoot, rn.promptFile);
      }
      if (rn.artifactsRefs !== undefined) {
        if (!isStrArr(rn.artifactsRefs)) {
          add("field", `inspect 节点 ${id} 的 artifactsRefs 必须是字符串数组`);
        } else {
          node.artifactsRefs = rn.artifactsRefs;
        }
      }
    }
    nodes.push(node);
  }
  if (errors.length > 0) return { ok: false, errors, rawNodes };

  // deps / artifactsRefs 引用存在性
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!idSet.has(d)) add("ref", `节点 ${n.id} 的 deps 引用了不存在的节点：${d}`);
    }
    for (const r of n.artifactsRefs) {
      if (!idSet.has(r)) add("ref", `节点 ${n.id} 的 artifactsRefs 引用了不存在的节点：${r}`);
    }
  }
  // 依赖环检测
  const depsOf = new Map(nodes.map((n) => [n.id, n.deps]));
  const cycleHit = detectCycle(nodes.map((n) => n.id), depsOf);
  if (cycleHit !== null) add("cycle", `依赖图存在环，环上节点：${cycleHit}`);

  // 范围声明互斥启动断言：重叠条目必须有依赖路径（任一方向可达）
  const terrOwners = new Map();
  for (const n of nodes) {
    if (n.kind !== "dev" || n.territory.length === 0) continue;
    for (const t of n.territory) {
      const owners = terrOwners.get(t) ?? [];
      owners.push(n.id);
      terrOwners.set(t, owners);
    }
  }
  if (terrOwners.size > 0) {
    const reaches = (from, to) => {
      const stack = [...(depsOf.get(from) ?? [])];
      const visited = new Set();
      while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === to) return true;
        if (visited.has(cur)) continue;
        visited.add(cur);
        stack.push(...(depsOf.get(cur) ?? []));
      }
      return false;
    };
    for (const [t, owners] of terrOwners) {
      for (let i = 0; i < owners.length; i += 1) {
        for (let j = i + 1; j < owners.length; j += 1) {
          const a = owners[i];
          const b = owners[j];
          if (!reaches(a, b) && !reaches(b, a)) {
            add(
              "overlap",
              `节点 ${a} 与 ${b} 范围声明重叠（${t}）且两方向均无依赖路径——两者会同时就绪并行派发（同文件写冲突、声明核验互污）。共同文件改动须合并为同一单元或以依赖边串行后重发 exec-plan`,
            );
          }
        }
      }
    }
  }

  // acceptance 分组：groups 字段保留宽容解析（旧 exec-plan 不报错、直接忽略退役语义）
  if (mode === "acceptance" && accRec !== null) {
    const groups = accRec.groups;
    if (!isRec(groups)) {
      add("field", "acceptance.groups 必须是对象 {core, nonCore}（core/haltOnCoreFail 已退役，保留字段被忽略）");
    }
  }

  const commitTemplate = isStr(raw.commitTemplate) ? raw.commitTemplate : null;
  if (mode === "dev" && commitTemplate === null) {
    add("field", "mode=dev 时 commitTemplate 必须是非空字符串");
  } else if (mode === "dev" && commitTemplate !== null) {
    if (!commitTemplate.includes("{unitId}") || !commitTemplate.includes("{summary}")) {
      add("field", `commitTemplate 须同时含 {unitId} 与 {summary} 占位符（当前：${commitTemplate}）`);
    }
  }
  if (errors.length > 0) return { ok: false, errors, rawNodes };
  return { ok: true, errors, rawNodes };
}

// ── 附加契约段（W3 NODE_PREP 同源 + 附加静态项；W2 validatePlan 无此段——差分测试
//    对本段单独断言，不参与逐字对账） ──

/**
 * @param {unknown} raw
 * @param {unknown[] | null} rawNodes validatePlanSchema 的节点集（null = 附加契约跳过）
 * @returns {{category: string, message: string}[]}
 */
function contractExtras(raw, rawNodes) {
  const errors = [];
  if (rawNodes === null) return errors; // schema 致命早退——不叠加附加错误噪声
  // 顶层必填（W3 NODE_PREP：baseline/planPath/designDocPath；projectRoot/statusPath 已在 schema 主段）
  for (const k of ["planPath", "designDocPath", "baseline"]) {
    if (!isStr(raw[k])) errors.push({ category: "field", message: `exec-plan 缺字段 ${k}（恢复：核对 D0 编译产物）` });
  }
  // testPlan（W3 Gate A 消费；缺失即 fail-fast）
  const tp = raw.testPlan;
  if (!tp || typeof tp.fullSuite !== "object" || tp.fullSuite === null) {
    errors.push({ category: "testPlan", message: "exec-plan 缺 testPlan.fullSuite（Gate A 全量测试命令；恢复：D0 编译时补全）" });
  } else {
    const fsuite = tp.fullSuite;
    if (typeof fsuite.program !== "string" || !Array.isArray(fsuite.args)) {
      errors.push({ category: "testPlan", message: "testPlan.fullSuite 形态无效（需 {program, args[]}）" });
    } else {
      if (!TEST_PLAN_WHITELIST.includes(fsuite.program)) {
        errors.push({ category: "whitelist", message: `testPlan.fullSuite.program 不在白名单 ${TEST_PLAN_WHITELIST.join("/")}: ${fsuite.program}` });
      }
      const noopFs = noopCommandError("testPlan.fullSuite", fsuite.program, fsuite.args);
      if (noopFs !== null) errors.push({ category: "noop", message: noopFs });
    }
    if (tp.artifacts !== undefined && tp.artifacts !== null) {
      if (!Array.isArray(tp.artifacts)) {
        errors.push({ category: "testPlan", message: "testPlan.artifacts 必须是数组（产物类条目 {id, command{program,args}}，§6.1 条目 3）" });
      } else {
        for (let ai = 0; ai < tp.artifacts.length; ai++) {
          const at = tp.artifacts[ai];
          if (!at || typeof at.id !== "string" || !at.id.trim() || !at.command || typeof at.command.program !== "string" || !Array.isArray(at.command.args)) {
            errors.push({ category: "testPlan", message: `testPlan.artifacts[${ai}] 形态无效（需 {id, command: {program, args[]}}）` });
            continue;
          }
          if (!TEST_PLAN_WHITELIST.includes(at.command.program)) {
            errors.push({ category: "whitelist", message: `testPlan.artifacts[${ai}].command.program 不在白名单: ${at.command.program}` });
          }
          const noopAt = noopCommandError(`testPlan.artifacts[${ai}].command`, at.command.program, at.command.args);
          if (noopAt !== null) errors.push({ category: "noop", message: noopAt });
        }
      }
    }
    // incremental：引擎宽容（形态不齐时静默忽略），此处镜像宽容——只核「形态齐且给出」的情形
    if (tp.incremental && typeof tp.incremental.program === "string" && Array.isArray(tp.incremental.args)) {
      if (!TEST_PLAN_WHITELIST.includes(tp.incremental.program)) {
        errors.push({ category: "whitelist", message: `testPlan.incremental.program 不在白名单: ${tp.incremental.program}` });
      }
      const noopIn = noopCommandError("testPlan.incremental", tp.incremental.program, tp.incremental.args);
      if (noopIn !== null) errors.push({ category: "noop", message: noopIn });
    }
  }
  // baseline git hash 形态（W3 NODE_PREP；D0 写 git rev-parse HEAD，AI 抄写笔误在此拦）
  if (isStr(raw.baseline) && !/^[0-9a-f]{7,40}$/i.test(raw.baseline.trim())) {
    errors.push({ category: "field", message: `baseline 非 git hash 形态: ${raw.baseline.trim()}` });
  }
  // 附加静态项：逐节点 script 扩展名 / cwd 形态（rawNodes 条目可能是非对象/缺 id 的病形态，
  // schema 主段已报，这里跳过避免重复报错噪声）
  for (let i = 0; i < rawNodes.length; i++) {
    const rn = rawNodes[i];
    if (!isRec(rn) || !isStr(rn.id)) continue;
    if (rn.kind === "verify" && isStr(rn.script)) {
      const ext = rn.script.slice(rn.script.lastIndexOf("."));
      if (!VERIFY_SCRIPT_EXTS.has(ext)) {
        errors.push({
          category: "script",
          message: `verify 节点 ${rn.id} 的 script 扩展名不受支持：${rn.script}（合法：${[...VERIFY_SCRIPT_EXTS].join(" / ")}；解释器分派 = .sh→bash、其余→node）`,
        });
      }
    }
    if (isStr(rn.cwd) && !rn.cwd.startsWith("/")) {
      errors.push({
        category: "cwd",
        message: `节点 ${rn.id} 的 cwd 须为 null/省略（= projectRoot）或仓库根绝对路径，实际：「${rn.cwd}」——相对路径会被引擎按 projectRoot 拼成仓库子目录，启动断言 cwd == git rev-parse --show-toplevel 将拒绝启动（恢复：cwd 改为 null 或 worktree 绝对路径后重跑本门）`,
      });
    }
  }
  return errors;
}

/** 全量校验入口：schema 主段（W2 同源）+ 附加契约段（W3 同源 + 静态附加项） */
function checkPlan(raw) {
  const schema = validatePlanSchema(raw);
  const errors = [...schema.errors, ...contractExtras(raw, schema.rawNodes)];
  return { ok: errors.length === 0, errors };
}

// ── 增量契约核对段（--task-dir <交付任务目录> 时附加执行；纯确定性数据比对）──
// 数据源 = 交付任务目录 increments.json（delivery-v4 acceptance-design 产出、随验收包批准
// 冻结：{ schemaVersion, acceptanceVersion, items: [{ id, title, requirementIds, testCommand? }] }）。
// 判据与 tech-design-v4 flow/plan.md「增量契约对齐」节同源（SKILL 入口门判据 3 的执行载体）：
//   ①归属全覆盖——每个增量至少被一个 dev 节点 incrementId 归属（防 impl-plan 删/漏增量）；
//   ②引用存在——节点 incrementId 必须指向真实增量 id（防编造 / 改名）；
//   ③测试命令逐字一致——归属节点 testCommand 与增量 testCommand 的 program/args 相等
//     （增量未声明 testCommand 时不比对命令——其必填性由 delivery-gate validate-acceptance 管）。
// mode=acceptance 时整段跳过：dev 单元归属已在 D0 dev 模式门核对，D3 门不重复核对验收节点。
function checkIncrementContract(raw, increments) {
  const errors = [];
  if (!isRec(raw) || raw.mode !== "dev" || !Array.isArray(raw.nodes)) return errors;
  const incIds = new Set();
  const incTest = new Map();
  for (const item of Array.isArray(increments?.items) ? increments.items : []) {
    if (!isRec(item) || !isStr(item.id)) continue;
    incIds.add(item.id);
    incTest.set(item.id, isRec(item.testCommand) ? item.testCommand : null);
  }
  if (incIds.size === 0) {
    errors.push({
      category: "increments",
      message: "increments.json items 为空或无合法 id——核对 --task-dir 指向的交付任务目录与 increments.json 形态（delivery-v4 validate-acceptance 产物）",
    });
    return errors;
  }
  const owned = new Set();
  for (const rn of raw.nodes) {
    if (!isRec(rn) || !isStr(rn.id) || rn.kind !== "dev") continue;
    const incId = rn.incrementId;
    if (incId === undefined) continue;
    if (!isStr(incId)) {
      errors.push({
        category: "increments",
        message: `dev 节点 ${rn.id} 的 incrementId 须为非空字符串（= increments.items[].id；不归属增量的单元删除该字段）`,
      });
      continue;
    }
    if (!incIds.has(incId)) {
      errors.push({
        category: "increments",
        message: `dev 节点 ${rn.id} 的 incrementId「${incId}」不在 increments.json items 中（现有增量：${[...incIds].join("、")}）——增量 id 以 increments.json 为准；增删改增量回 delivery-v4 递增验收版本重批（恢复：修 T3 units[].incrementId 后重编译）`,
      });
      continue;
    }
    owned.add(incId);
    const incCmd = incTest.get(incId);
    if (incCmd === null) continue;
    const nodeCmd = isRec(rn.testCommand) ? rn.testCommand : null;
    const nodeArgs = nodeCmd !== null && Array.isArray(nodeCmd.args) ? nodeCmd.args : null;
    const same =
      nodeCmd !== null &&
      nodeCmd.program === incCmd.program &&
      nodeArgs !== null &&
      JSON.stringify(nodeArgs) === JSON.stringify(Array.isArray(incCmd.args) ? incCmd.args : []);
    if (!same) {
      errors.push({
        category: "increments",
        message: `dev 节点 ${rn.id} 的 testCommand 与增量 ${incId} 的 testCommand 不一致——增量契约的测试命令照抄不改编（恢复：按 increments.json 该增量 testCommand 逐字转抄 T3 units 与 exec-plan 后重跑本门）`,
      });
    }
  }
  const missing = [...incIds].filter((id) => !owned.has(id));
  if (missing.length > 0) {
    errors.push({
      category: "increments",
      message: `增量无单元归属：${missing.join("、")}——每个增量至少被一个 dev 节点 incrementId 归属（恢复：回 tech-design-v4 T3「增量契约对齐」节补齐归属单元；增量不该存在则回 delivery-v4 递增验收版本重批）`,
    });
  }
  return errors;
}

// ── 验收包联合哈希（delivery-gate.mjs 同源复刻，改任一侧须同步——见头部同源声明）──
// 语义 = 对 acceptance.json 与 increments.json **解析后**的规范 JSON（键排序、无空白）做
// 联合 sha256：绑定的不是文件字节而是解析内容，手工重排 JSON 键序/空白不改变哈希。

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function acceptancePackageSha256(acceptanceParsed, incrementsParsed) {
  return sha256Text(
    canonicalJson({
      "acceptance.json": canonicalJson(acceptanceParsed),
      "increments.json": canonicalJson(incrementsParsed),
    }),
  );
}

// ── 验收绑定一致性核对段（--task-dir 时与增量契约同批附加执行；纯确定性数据比对）──
// 判据与两处 SKILL 入口门声明同源（tech-design-v4 SKILL「设计包」表 acceptanceBinding 行、
// dev-flow-v4 SKILL「验收任务门」判据 1 括注）：设计包 meta.json 的 acceptanceBinding 必须
// 与交付任务目录当前批准一致——①acceptanceVersion 相等（拦重批后 binding 陈旧）；②验收包
// 联合哈希相等（拦同版本号下验收包内容变化）；③taskDir 指向同一交付任务目录（拦拿错包）。
// 任一不符 → 验收版本或验收包已变化，旧设计包绑定失效，须回 tech-design-v4 flow/write.md
// Step 0 重新影响审查并更新 binding 后再进下游——不在 exec-plan 侧改。
function checkAcceptanceBinding(raw, meta, acceptance, increments, taskDir) {
  const errors = [];
  if (!isRec(raw)) return errors; // schema 致命早退已报，不叠加噪声
  const ab = isRec(meta) && isRec(meta.acceptanceBinding) ? meta.acceptanceBinding : null;
  if (ab === null) {
    errors.push({
      category: "binding",
      message: "设计包 meta.json 无 acceptanceBinding——交付体系任务（--task-dir 给定）的设计包必须在 T1 入口门写入 { acceptanceVersion, acceptancePackageSha256, taskDir }（tech-design-v4 flow/write.md Step 0；独立设计任务不传 --task-dir）",
    });
    return errors;
  }
  const curVer = isRec(acceptance) ? acceptance.acceptanceVersion : undefined;
  if (ab.acceptanceVersion !== curVer) {
    errors.push({
      category: "binding",
      message: `设计包 meta.json acceptanceBinding.acceptanceVersion=${JSON.stringify(ab.acceptanceVersion)} 与交付任务目录当前验收版本 ${JSON.stringify(curVer)} 不一致——验收版本已变化（重批），旧设计包绑定失效（恢复：回 tech-design-v4 flow/write.md Step 0 影响审查——对照新版本 acceptance.json 与 increments.json 逐条比对设计包覆盖，需改动回 T1 修订并按所处阶段重走 T2/T3，完成后更新 meta.json acceptanceBinding 再重编译）`,
    });
  }
  const computed = acceptancePackageSha256(acceptance, increments);
  if (ab.acceptancePackageSha256 !== computed) {
    errors.push({
      category: "binding",
      message: `设计包 meta.json acceptanceBinding.acceptancePackageSha256（${String(ab.acceptancePackageSha256)}）与交付任务目录当前验收包实算哈希（${computed}）不一致——验收包内容已变化，旧绑定失效（恢复：回 tech-design-v4 flow/write.md Step 0 影响审查后更新 meta.json acceptanceBinding 再重编译；实算口径 = acceptance.json + increments.json 解析内容规范 JSON 的联合 sha256，与 delivery-gate acceptancePackageSha256 同源）`,
    });
  }
  const trimSlash = (p) => (typeof p === "string" ? p.replace(/\/+$/, "") : p);
  if (trimSlash(ab.taskDir) !== trimSlash(taskDir)) {
    errors.push({
      category: "binding",
      message: `设计包 meta.json acceptanceBinding.taskDir（${String(ab.taskDir)}）与 --task-dir（${taskDir}）不是同一交付任务目录（恢复：核对 --task-dir 与 meta.json acceptanceBinding.taskDir；拿错设计包则改用其绑定任务目录下的交付任务）`,
    });
  }
  return errors;
}

/** exec-plan.designDocPath（渲染视图 <name>.rendered.md 或设计目录本身）→ 设计目录路径 */
function designDirFromDocPath(designDocPath) {
  if (designDocPath.endsWith(".rendered.md")) {
    return join(dirname(designDocPath), basename(designDocPath, ".rendered.md"));
  }
  return designDocPath;
}

function designMetaPath(designDocPath) {
  return join(designDirFromDocPath(designDocPath), "meta.json");
}

/** realpath 归一（symlink 形态统一，如 macOS /var 与 /private/var），失败回退原串参与比对 */
function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// 差分测试（scripts/tests/check-exec-plan-parity.test.mjs）消费：validatePlanSchema =
// 与 W2 validatePlan 逐字对账的移植侧；checkPlan = 整门判定（schema + 附加契约段）；
// checkIncrementContract / checkAcceptanceBinding = --task-dir 附加段（差分测试不覆盖，
// 由 CLI 行为承载）
export { validatePlanSchema, checkPlan, checkIncrementContract, checkAcceptanceBinding };

// ── CLI（被差分测试 import 时跳过） ──

/** --task-dir 附加段第二环：读设计包 meta.json 与交付任务目录 acceptance.json，调
 *  checkAcceptanceBinding 做验收绑定一致性核对（读盘失败按 FAIL 行报并 exit 1） */
function checkBindingFromDisk(raw, taskDir, incRaw) {
  // designDocPath 缺失/非字符串已由 contractExtras 报 field 错误，此处不叠加重复报
  if (!isRec(raw) || !isStr(raw.designDocPath)) return [];
  const metaPath = designMetaPath(raw.designDocPath);
  let metaRaw;
  try {
    metaRaw = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    console.log(`FAIL: binding: 无法读取设计包 ${metaPath}（${e.message}）——exec-plan designDocPath 须指向渲染视图（<name>.rendered.md，meta.json 在同级 <name>/ 目录）或设计目录本身，核对路径后重跑本门`);
    process.exit(1);
  }
  let accRaw;
  try {
    accRaw = JSON.parse(readFileSync(join(taskDir, "acceptance.json"), "utf8"));
  } catch (e) {
    console.log(`FAIL: binding: 无法读取 ${join(taskDir, "acceptance.json")}（${e.message}）——核对 --task-dir 指向的交付任务目录（delivery-v4 验收设计产出）`);
    process.exit(1);
  }
  // taskDir 判据两侧同口径 realpath 归一（--task-dir 侧在 main 已归一）：binding.taskDir
  // 指向不存在的目录时 realpathSafe 回退原串，与现存任务目录比对自然不等、照常报错
  const metaNorm =
    isRec(metaRaw) && isRec(metaRaw.acceptanceBinding) && isStr(metaRaw.acceptanceBinding.taskDir)
      ? { ...metaRaw, acceptanceBinding: { ...metaRaw.acceptanceBinding, taskDir: realpathSafe(metaRaw.acceptanceBinding.taskDir) } }
      : metaRaw;
  return checkAcceptanceBinding(raw, metaNorm, accRaw, incRaw, taskDir);
}

function main() {
  const argv = process.argv.slice(2);
  // 参数形态：<exec-plan.json 绝对路径> [--task-dir <交付任务目录>]
  let planPath = null;
  let taskDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-dir") {
      taskDir = argv[i + 1];
      if (!taskDir || taskDir.startsWith("--")) {
        console.error("用法错误：--task-dir 须带交付任务目录参数（读其下 increments.json 做增量契约核对）");
        console.error("用法：node check-exec-plan.mjs <exec-plan.json 绝对路径> [--task-dir <交付任务目录>]（D0 编译「生成即校验」门；交付体系任务必传 --task-dir；PASS exit 0 / FAIL 逐行分类明细 exit 1）");
        process.exit(2);
      }
      i++;
    } else if (planPath === null) {
      planPath = argv[i];
    } else {
      console.error(`用法错误：未知参数 ${argv[i]}`);
      console.error("用法：node check-exec-plan.mjs <exec-plan.json 绝对路径> [--task-dir <交付任务目录>]（D0 编译「生成即校验」门；交付体系任务必传 --task-dir；PASS exit 0 / FAIL 逐行分类明细 exit 1）");
      process.exit(2);
    }
  }
  if (!planPath || planPath === "-h" || planPath === "--help") {
    console.error("用法：node check-exec-plan.mjs <exec-plan.json 绝对路径> [--task-dir <交付任务目录>]（D0 编译「生成即校验」门；交付体系任务必传 --task-dir；PASS exit 0 / FAIL 逐行分类明细 exit 1）");
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(planPath, "utf8");
  } catch {
    console.log(`FAIL: io: exec-plan 文件不存在或不可读：${planPath}`);
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.log(`FAIL: json: exec-plan 不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  const result = checkPlan(raw);
  const incErrors = [];
  if (taskDir !== null) {
    // realpath 归一（symlink / 尾斜杠形态统一，供 binding.taskDir 两侧同口径比对）；
    // 目录不存在时 increments.json 读取已按 FAIL 行报，realpathSafe 回退原串参与错误消息
    taskDir = realpathSafe(taskDir);
    let incRaw;
    try {
      incRaw = JSON.parse(readFileSync(join(taskDir, "increments.json"), "utf8"));
    } catch (e) {
      console.log(`FAIL: increments: 无法读取 ${taskDir}/increments.json（${e.message}）——核对 --task-dir 指向的交付任务目录（delivery-v4 init / approve-acceptance 产出）`);
      process.exit(1);
    }
    incErrors.push(...checkIncrementContract(raw, incRaw));
    incErrors.push(...checkBindingFromDisk(raw, taskDir, incRaw));
  }
  if (result.ok && incErrors.length === 0 && taskDir !== null) {
    const checker = join(dirname(fileURLToPath(import.meta.url)), "../../delivery-v4/scripts/check-quality-contract.mjs");
    // 追加 --design-dir：机制对账/测试绑定核对只在带该参的分支执行，缺传则 D0 漏检
    const checkerArgs = [checker, "--task-dir", taskDir, "--exec-plan", planPath];
    if (isStr(raw.designDocPath)) checkerArgs.push("--design-dir", designDirFromDocPath(raw.designDocPath));
    const checked = spawnSync(process.execPath, checkerArgs, { encoding: "utf8" });
    if (checked.status !== 0) {
      incErrors.push({ category: "quality", message: String(checked.stdout || checked.stderr).trim() });
    }
  }
  if (result.ok && incErrors.length === 0) {
    console.log("PASS");
    process.exit(0);
  }
  for (const e of result.errors) console.log(`FAIL: ${e.category}: ${e.message}`);
  for (const e of incErrors) console.log(`FAIL: ${e.category}: ${e.message}`);
  process.exit(1);
}

// 直跑入口判定按 realpath 比对：技能经 symlink 安装（~/.agents/skills/dev-flow-v4）时
// argv[1] 是 symlink 路径，而 ESM 的 import.meta.url 是解析后的真实路径——直比会失配、
// CLI 静默不执行（冒烟实测）。realpath 归一后两侧恒等
function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main();
}
