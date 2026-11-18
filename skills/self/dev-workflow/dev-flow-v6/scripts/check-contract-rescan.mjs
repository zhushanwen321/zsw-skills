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
// 单源落点：判定实现在 delivery-v6 技能（外部契约域的权威：策略包 / 探测器 / resolver 都在
// 该技能）的 scripts/lib/contract-rescan.mjs；本文件经安装形态的相对路径 import 它——
// 仓库内 `<repo>/skills/self/dev-workflow/dev-flow-v6/scripts/` 与安装形态
// `~/.agents/skills/dev-flow-v6/scripts/`（目录软链）下，`../../delivery-v6/...` 都解析到
// 同一份实现。消息措辞（renderRescanErrorDevFlow）随判定数据一起由该库提供，保持 D0/D3
// 两侧既有文案。
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
//   2. strong 候选的调用类（call-class 段 + manifest-field 映射 + regex 还原，再加策略表
//      蕴含观察类）必须被该契约某个 capability 的 detectionClasses 覆盖——缺一项即拒绝并
//      回验收修订（能力清单低报的主机器门）；manifest / 纯 import 型强候选提不到调用类时
//      不因此拒绝，由处置表兜底；
//   3. strong 候选必须已有处置（bound / manual）且落到已声明契约——未处置 / not-external /
//      unresolved 处置全部拒绝（not-external 仅 weak 候选可用）；
//   4. strong 候选绑定到验收标 optional 的契约 → 强制按 essential 处理（回灌编译门的
//      契约冒烟增量与 DAG 检查，并披露给 evaluate 侧义务派生）；
//   5. stage=d3 追加：essential 契约任务必须已编译 runtime-probe 验收节点且 probe artifact
//      落盘可解析——probe 未跑不得进入候选完成。
//
// 用法（CLI，D3 候选完成门）：
//   node check-contract-rescan.mjs --task-dir <交付任务目录> --project-root <项目根>
//         [--intent-file <taskDir>/intent.md>] [--exec-plan <exec-plan 绝对路径>] --stage d3
// 退出码：0 通过（含升级前旧任务不适用）；1 判定拒绝或复扫输入不可用；2 用法错误。

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 判定单源（delivery-v6 技能的复扫库）：仓库布局与安装布局（目录软链）下都解析到同一份
import { runContractRescan, renderRescanErrorDevFlow } from "../../delivery-v6/scripts/lib/contract-rescan.mjs";

export { runContractRescan, renderRescanErrorDevFlow };

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
  if (!opts.taskDir || !opts.projectRoot || !["d0", "d3"].includes(opts.stage)) {
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
    for (const e of result.errors) process.stdout.write(`FAIL: ${e.category}: ${renderRescanErrorDevFlow(e)}\n`);
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
