#!/usr/bin/env node
// compile-exec-plan.mjs — D0 编译器：impl-plan.json（唯一计划权威）→ exec-plan.json +
// 逐节点 promptFile + 初始 status.json（dev 模式）/ acceptance.nodes + verify wrapper（acceptance 模式）。
//
// 设计依据：《V5 三技能结构化交付优化》第三步「D0 编译器分阶段接管生成」（§3 总体结构 /
// §4 产物权威 / §6.3 dev-flow 分阶段编译 / §7.3 已知答案样例 / §7.4 生成物防手改 /
// §7.7 历史只读重放 / §8 迁移第三步）。核心边界：
//   - 只生成确定性内容：同一语义输入重复生成结果一致；时间戳、run id 等运行时值不进
//     生成文本（status.json 的 updated 除外——执行态载体，不参与重生成比对）。
//   - 语义排除与设计判断回上游：编译器不推断任何 impl-plan 未声明的事实；无法推导且
//     必须人工决定的字段以最小可选字段补入 impl-plan（本文件头「impl-plan 编译消费字段」节），
//     缺失即语义缺口——三段式输出（哪个输入不合法 → 权威源 → 恢复动作），全体不生成。
//   - 生成即校验：写盘前 import check-exec-plan.mjs 的 checkPlan 同口径预检（零漂移），
//     写盘后 spawn 真校验器（--task-dir 透传）PASS 才算编译完成。
//   - 主 agent 只处理编译器报告的语义缺口；处理后回 impl-plan / 设计包修改并重新生成，
//     不手修生成物（生成文件头/字段带输入哈希与生成命令，--check 发现手改给出重新生成命令）。
//
// 外部契约守门（设计《V6 运行可用性与外部契约守门升级》§7.1 / §7.3 / §13；--task-dir 交付
// 体系任务才适用，升级前旧任务——验收包无 externalContracts / externalContractReview——整门
// 跳过，历史任务不受影响）：
//   - D0 契约门（写盘前，与其余语义缺口同通道全体不生成）：缺权威环境快照 / 验收含
//     essential 契约却缺 kind=contract-smoke 增量 / 业务单元 DAG 未依赖契约 spike 单元 /
//     D0 复扫发现未登记 strong 信号或 unresolved 外部访问 → 拒绝编译并回验收修订；
//   - D0 复扫：spawn 探测 CLI 对当前源码 + intent 重跑完整候选探测（判定单一实现 =
//     check-contract-rescan.mjs 的 runContractRescan，D3 候选完成门与 evaluate 侧共用）；
//   - runtime-probe 验收行（impl-plan acceptancePlan additive 行类型）编译为 verify 节点，
//     script = gen-runtime-probe-wrapper.mjs 生成的 probe wrapper（产物进 taskDir evidence）；
//   - deliveryProfile（task.json，a/b/c）登记进 exec-plan——a 级 D2 一致性审查分区降档的
//     消费输入（降档实现见 W3 dev-consistency-loop-v6 与 flow/consistency-review.md）。
//
// 用法：
//   node compile-exec-plan.mjs --impl-plan <path>.impl-plan.json [--mode dev|acceptance]
//        [--task-dir <交付任务目录>] [--check] [--replay-compare <旧 exec-plan 路径>] [--reinit]
//
//   --reinit：dev 重编译显式确认重置——盘上 status.json 含非 pending 节点（已有执行进度）时
//   缺省拒绝编译（重初始化会清零 status/runlog/ledger 的执行记录）；带本参数才允许覆盖重置。
//   已有进度的正常修订路径 = 手修 exec-plan 对应字段 + ledger 登记（flow/compile.md 校验门路由）。
//
// 模式：
//   dev（缺省）        → <name>.exec-plan.json（mode=dev，acceptance 空壳）+ <name>.prompts/*.md
//                        （dev 任务书 + 过程 reviewer 任务书）+ 初始 <name>.status.json
//                        + <name>.runlog/ 与 <name>.ledger.md 头部初始化
//   acceptance         → 同一份 exec-plan 重编译为 mode=acceptance：acceptance.nodes 填实
//                        （L3→verify / L4→inspect / 汇总 inspect 节点）+ inspect 与汇总任务书 +
//                        runner 契约齐备的 verify 行 spawn gen-acceptance-wrapper.mjs 生成 wrapper。
//                        不重写 status.json / runlog / ledger（执行进度不可重置）。前置：dev 编译
//                        已完成（status.json 在场）；verifyAsset=new 的实装单元须已 done。
//   --check            → 只读：按当前输入重生成并与盘上产物比对（exec-plan 深比较、promptFile
//                        逐字节；status.json 执行态载体不适用本检查，跳过；wrapper 检查委托
//                        gen-acceptance-wrapper --check）。不一致 → 差异报告 + 重新生成命令。
//   --replay-compare   → 只读历史重放（§7.7）：读旧 exec-plan，按其 mode 用当前输入重新生成
//                        （内存，不写盘），与旧文件逐字段比对报告差异。不推断旧执行行为——
//                        对照旧流程实际执行须另行输入旧 status.json 等执行记录。
//
// 退出码：0 成功 / --check PASS / 重放完成（差异计数照报）；1 语义缺口或校验 FAIL（全体不生成）；
//         2 用法错误。
//
// projectRoot 推导：编译器从进程 cwd 的 git 仓库根（git rev-parse --show-toplevel）取得——
// D0 编译由主 agent 在项目内执行，与 baseline 取 HEAD 同一操作语境；不在 git 仓内运行即报缺口。
//
// impl-plan 编译消费字段（映射权威 = tech-design-v6/references/impl-plan-mapping.md 的
// 渲染字段 + 本节登记的 D0 消费可选字段——设计 §6.2 第 6 条「只把 D0 无法推导且必须人工
// 决定的字段，以最小可选字段补入 impl-plan」。mapping 表归 tech-design-v6 侧维护，
// 本表是 D0 消费口径的唯一登记处）：
//   units[].designRef          string 可选——设计章节锚（任务书「单元目标」段；缺省空串，
//                              编译摘要按警告列出未登记单元，不拦）
//   units[].cwd                string 可选——isolation=worktree 单元的 worktree 绝对路径
//                              （必填缺口；plain 单元恒 null，不接受声明）
//   units[].kind               string 可选——单元角色 additive 标记；现只登记
//                              "contract-spike"（契约冒烟 spike 单元，外部契约任务的 DAG
//                              首个可执行节点）。声明其他值 = 上游契约含糊，报缺口不静默
//                              放过（映射表登记归 tech-design-v6；D0 只消费该标记）
//   processReviews[]           array 可选——过程审查声明 [{unitId, script?, promptFile?,
//                              mechanism?}]：有则生成 review 节点（script/promptFile 逐字转抄，
//                              promptFile 缺省按任务书要素模板生成），无则不生成
//   commitTemplate             string 可选——缺省 "<type>(<scope>): {unitId} — {summary}"
//   formNotApplicable[]        array 可选——[{adversarialFormId, rationale}] 逐字转抄
//   acceptancePlan[].script    string 可选——verifyAsset="-"（项目无 verification skill）行的
//                              verify 剧本本体绝对路径（此时必填，引擎 node 直跑）
//   acceptancePlan[].runner    object 可选——wrapper 调用契约 {path, flags}（flags 显式声明、
//                              逐字为准；reuse:/new 行走 wrapper 的必填输入）
//   acceptancePlan[].scenario  object 可选——{path} 剧本场景绝对路径（wrapper 输入）
//   acceptancePlan[].artifactsDir string 可选——产物目录绝对路径；缺省推导
//                              <产物根>/<name>.artifacts/<行id>
//   acceptancePlan[].unit      string 可选——verifyAsset="new" 行的实装单元 id（此时必填；
//                              编译器以 status.json 该单元 done 判定资产就绪）
//   acceptancePlan[].type      string 可选——验收行 additive 类型标记；现只登记
//                              "runtime-probe"（runtime 探针行：level 必须 L3，command /
//                              artifact / capabilityIds 必填，编译为 verify 节点且 script =
//                              gen-runtime-probe-wrapper 生成的 probe wrapper）。无 type 字段
//                              的行按既有 level 规则编译（向后兼容）
//   acceptancePlan[].command   object 可选——type="runtime-probe" 行的 driver 启动命令
//                              {program, args}（program 受测试命令白名单约束，禁恒绿形态）
//   acceptancePlan[].artifact  string 可选——type="runtime-probe" 行的 probe artifact 落点
//                              （相对交付任务目录的 evidence 路径，禁越出任务目录）
//   acceptancePlan[].capabilityIds array 可选——type="runtime-probe" 行观察的契约能力 id
//                              （裸能力 id 或 <contractId>:<capabilityId>；必须存在于验收包
//                              externalContracts 的 capabilities）
//   testPlan.incrementalCommands[]  既有字段——dev 节点 testCommand 的提取权威
//                              （{incrementId, unitIds[], command}；单元无覆盖条目即缺口；
//                              testPlan.incremental 文字段是阅读视图，不作提取源）

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { checkPlan, checkIncrementContract, checkAcceptanceBinding, checkRuntimeProbeRows, checkRuntimeProbeNodes } from "./check-exec-plan.mjs";
import { runContractRescan, renderRescanErrorDevFlow } from "./check-contract-rescan.mjs";

const GENERATOR_VERSION = 1;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const CHECK_EXEC_PLAN = join(SCRIPT_DIR, "check-exec-plan.mjs");
const GEN_WRAPPER = join(SCRIPT_DIR, "gen-acceptance-wrapper.mjs");
const GEN_PROBE_WRAPPER = join(SCRIPT_DIR, "gen-runtime-probe-wrapper.mjs");
const VERIFY_INDEX_SCRIPT = join(SCRIPT_DIR, "verification-index.mjs");
// wrapper 可建模的 runner flags 四旗（compile.md 验收分组规则点名的旗组）——与
// gen-acceptance-wrapper.mjs 的 KNOWN_FLAGS 同源；范围校验前移到编译器缺口收集阶段，
// 超界在写盘前即报（不产生 verify-assets.json 等半截产物），模板与防手改仍由生成器承担
const KNOWN_FLAGS = ["--repo", "--artifacts-dir", "--name", "--run-id"];
const RENDER_IMPL_PLAN = join(SCRIPT_DIR, "..", "..", "tech-design-v6", "scripts", "render-impl-plan.mjs");
const SKILL_MD = join(SCRIPT_DIR, "..", "SKILL.md");
// skill-data 寻址权威：算法唯一权威源 = skills/self/dev-workflow/workflows/src/skill-data.shared.ts
// 的 NODE_PROJECT_ADDRESS 探针（行为契约见 skills/self/dev-workflow/references/skill-data-addressing.md）。
// 本脚本是独立 CLI（非 workflow 构建产物），按该文件「并入约定」以探针常量接入——下方字符串
// 与单源逐字节一致，副本漂移由 scripts/tests/compile-exec-plan-v6.test.mjs 的寻址对账用例拦截；
// 改算法只改单源并同步本副本，禁止在此单改。
const NODE_PROJECT_ADDRESS_PROBE = "const fs=require('fs'),cp=require('child_process'),cr=require('crypto'),pt=require('path');const root=fs.realpathSync(process.argv[1]);const slugOf=x=>x.split('/').filter(Boolean).pop()+'-'+cr.createHash('sha256').update(x).digest('hex').slice(0,8);const norm=(x,b)=>{const a=pt.isAbsolute(x)?x:pt.join(b,x);try{return fs.realpathSync(a)}catch(e){return a}};const single=()=>JSON.stringify({form:'single',slug:slugOf(root)});const detect=()=>{const g=cp.spawnSync('git',['rev-parse','--git-common-dir'],{cwd:root,encoding:'utf8'});if(g.status!==0||!String(g.stdout||'').trim())return single();const cd=norm(String(g.stdout).trim(),root);const w=cp.spawnSync('git',['worktree','list','--porcelain'],{cwd:root,encoding:'utf8'});if(w.status!==0)return single();const parent=pt.dirname(root);const sibs=[];for(const line of String(w.stdout||'').split(String.fromCharCode(10))){if(line.indexOf('worktree ')!==0)continue;const wt=norm(line.slice(9),root);const gw=cp.spawnSync('git',['-C',wt,'rev-parse','--git-common-dir'],{encoding:'utf8'});if(gw.status!==0||norm(String(gw.stdout||'').trim(),wt)!==cd)continue;if(pt.dirname(wt)===parent)sibs.push(wt)}if(sibs.length>=2)return JSON.stringify({form:'workspace',slug:slugOf(norm(parent,parent)),workspaceRoot:parent,worktreeName:root.split('/').filter(Boolean).pop()});return single()};process.stdout.write(detect())";
// W2 节点 testCommand / W3 testPlan 的 program 白名单（与 check-exec-plan.mjs 同源；归一决策用）
const TEST_WHITELIST = ["pnpm", "npm", "node", "git", "bash"];
const TEST_PLAN_WHITELIST = ["pnpm", "npm", "node", "bash"];
const COMMIT_TEMPLATE_DEFAULT = "<type>(<scope>): {unitId} — {summary}";
// 含 shell 元字符的命令串不能安全按空格拆分——整体走 bash -c 通道（compile.md 现行约定：
// 复杂多命令封装走 bash）
const SHELL_META_RE = /[|&;()<>$`"'\n]/;

// ── 纯工具 ──

const isStr = (x) => typeof x === "string" && x.trim() !== "";
const isStrArr = (x) => Array.isArray(x) && x.every((i) => typeof i === "string" && i.trim() !== "");
const isRec = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const sha256Text = (t) => createHash("sha256").update(t, "utf8").digest("hex");
/** 展开前导 ~ 为 home（impl-plan 内路径惯用 ~ 形态；exec-plan 内一律绝对路径） */
function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
const abs = (p) => resolve(expandHome(p));
/** 命令归一：string 形态按白名单拆分或整体 bash -c；{program,args} 形态克隆。
 *  拆分决策依据 program 白名单（W2/W3 同源）——首 token 在白名单内才直接作 program，
 *  否则整串交 bash，避免白名单外程序（make 等）被引擎启动校验拒绝。 */
function normalizeCommand(cmd, whitelist) {
  if (isRec(cmd) && isStr(cmd.program) && isStrArr(cmd.args)) {
    return { program: cmd.program, args: [...cmd.args] };
  }
  if (typeof cmd !== "string" || cmd.trim() === "") return null;
  const s = cmd.trim();
  if (!SHELL_META_RE.test(s)) {
    const parts = s.split(/\s+/);
    if (whitelist.includes(parts[0])) return { program: parts[0], args: parts.slice(1) };
  }
  return { program: "bash", args: ["-c", s] };
}
/** 值显示（diff 报告用）：截断到单行 120 字符 */
function showVal(v) {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

// ── 语义缺口（三段式：哪个输入不合法 → 权威源 → 恢复动作；收集齐一次报完，全体不生成） ──

const gaps = [];
function gap(input, authority, recovery) {
  gaps.push({ input, authority, recovery });
}
function printGaps() {
  const out = [`语义缺口报告：编译中止，未写任何文件（共 ${gaps.length} 条）——语义修订回上游 impl-plan / 设计包，不手修生成物`];
  gaps.forEach((g, i) => {
    out.push("", `缺口 ${i + 1}`, `  不合法输入：${g.input}`, `  权威源：${g.authority}`, `  恢复动作：${g.recovery}`);
  });
  process.stderr.write(out.join("\n") + "\n");
}
function failUsage(msg) {
  process.stderr.write(
    `用法错误：${msg}\n用法：node compile-exec-plan.mjs --impl-plan <path>.impl-plan.json [--mode dev|acceptance] [--task-dir <交付任务目录>] [--check] [--replay-compare <旧 exec-plan 路径>] [--reinit]\n` +
      "模式：dev 生成 exec-plan + 任务书 + 初始 status.json；acceptance 在其上填验收节点与 wrapper；--check 防手改比对；--replay-compare 历史只读重放；--reinit 显式确认重置已有执行进度。\n",
  );
  process.exit(2);
}

// ── 寻址与外部输入 ──

function gitToplevel() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const root = String(r.stdout || "").trim();
  if (r.status !== 0 || !root) {
    gap(
      `编译器运行目录（${process.cwd()}）不在 git 仓库内，无法推导 projectRoot`,
      "projectRoot = 编译时所在 git 仓库根（与 baseline 取 git rev-parse HEAD 同一操作语境）",
      "cd 到项目根（或项目内任意路径）后重新运行编译命令",
    );
    return null;
  }
  return root;
}

function detectAddress(projectRoot) {
  const r = spawnSync(process.execPath, ["-e", NODE_PROJECT_ADDRESS_PROBE, projectRoot], { encoding: "utf8" });
  if (r.status !== 0 || !String(r.stdout || "").trim()) {
    gap(
      `skill-data 寻址探针失败（exit ${r.status}）：${String(r.stderr || "").trim()}`,
      "寻址算法唯一权威源 = skills/self/dev-workflow/workflows/src/skill-data.shared.ts NODE_PROJECT_ADDRESS（行为契约见 skill-data-addressing.md）",
      "确认 projectRoot 目录存在后重跑；仍失败按 skill-data-addressing.md §5 排障",
    );
    return null;
  }
  return JSON.parse(r.stdout);
}

function readSkillVersion() {
  let text;
  try {
    text = readFileSync(SKILL_MD, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/^version:\s*([^\s#]+)/m);
  return m ? m[1] : null;
}

// ── impl-plan 读取与前置门 ──

function loadImplPlan(planArg) {
  const planPath = abs(planArg);
  if (!basename(planPath).endsWith(".impl-plan.json")) {
    failUsage(`--impl-plan 须指向 .impl-plan.json 文件，收到：${planArg}`);
  }
  let raw;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch {
    gap(
      `impl-plan.json 不存在或不可读：${planPath}`,
      "impl-plan.json 由 tech-design-v6 T3 产出（唯一计划权威；渲染字段权威 = tech-design-v6/references/impl-plan-mapping.md）",
      "核对 --impl-plan 路径（设计包与计划 JSON 同目录）；路径无误则回 tech-design-v6 T3 产出后重试",
    );
    return { planPath: null, plan: null, rawText: null };
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    gap(
      `impl-plan.json JSON 解析失败：${e.message}`,
      `${planPath} 是唯一计划权威`,
      `修复 JSON 语法后重新运行：node ${SCRIPT_PATH} --impl-plan ${planPath}`,
    );
    return { planPath, plan: null, rawText: null };
  }
  return { planPath, plan, rawText: raw };
}

/** 编译前置门：渲染一致性校验（compile.md 现行步骤 1 的机器承接——impl-plan.md 视图必须
 *  与 JSON 重新渲染一致，防止在陈旧视图上编译）。FAIL 转发渲染器的三段式错误输出。 */
function runRenderCheck(planPath) {
  const r = spawnSync(process.execPath, [RENDER_IMPL_PLAN, planPath, "--check"], { encoding: "utf8" });
  if (r.status === 0) return;
  process.stderr.write(
    [
      "编译前置门未过：impl-plan 渲染一致性校验失败（渲染视图与 JSON 不同源）。",
      "以下为渲染器（tech-design-v6 render-impl-plan.mjs --check）原始输出，按其恢复动作处理后重新编译：",
      "",
      String(r.stderr || r.stdout || "").trim(),
    ].join("\n") + "\n",
  );
  process.exit(1);
}

// ── dev 部分编译（units → dev 节点 + review 节点 + 任务书） ──

/** 拓扑分层：wave = 1 + max(wave(deps))。依赖环/引用缺失不在本函数拦截（checkPlan 预检
 *  与写盘后 spawn 校验器按 cycle/ref 分类拦）；此处对未定值依赖回退 1，保证函数总终止。 */
function computeWaves(units) {
  const waveOf = new Map();
  const byId = new Map(units.map((u) => [u.id, u]));
  const visit = (id, path) => {
    if (waveOf.has(id)) return waveOf.get(id);
    if (path.has(id)) return 1; // 环——交校验器拦
    path.add(id);
    const u = byId.get(id);
    const deps = isStrArr(u?.deps) ? u.deps : [];
    let w = 1;
    for (const d of deps) {
      if (byId.has(d)) w = Math.max(w, visit(d, path) + 1);
    }
    path.delete(id);
    waveOf.set(id, w);
    return w;
  };
  for (const u of units) visit(u.id, new Set());
  return waveOf;
}

/** dev 单元 testCommand 提取：唯一权威 = testPlan.incrementalCommands[]（unitIds 含该单元）。
 *  多条命中取第一条（同单元多命令 = 上游契约含糊，编译摘要警告）；无命中 = 语义缺口。 */
function extractTestCommand(unit, incrementalCommands, whitelist, planPath) {
  const hits = (incrementalCommands ?? []).filter(
    (c) => isRec(c) && isStrArr(c.unitIds) && c.unitIds.includes(unit.id),
  );
  if (hits.length === 0) {
    gap(
      `单元 ${unit.id} 无 testCommand 来源：testPlan.incrementalCommands 中没有 unitIds 含「${unit.id}」的条目`,
      `dev 节点 testCommand 的唯一提取权威 = ${planPath} 的 testPlan.incrementalCommands[]（testPlan.incremental 文字段是阅读视图，不作提取源）`,
      `回 tech-design-v6 T3 把该单元的测试命令写成 incrementalCommands 条目（{incrementId, unitIds, command}）后重新渲染、重新编译`,
    );
    return null;
  }
  if (hits.length > 1) {
    console.error(`警告：单元 ${unit.id} 命中 ${hits.length} 条 incrementalCommands 条目，取第一条（${hits[0].incrementId ?? "无 incrementId"}）——同单元多命令属上游契约含糊，建议回 T3 归并`);
  }
  const norm = normalizeCommand(hits[0].command, whitelist);
  if (norm === null) {
    gap(
      `单元 ${unit.id} 的 incrementalCommands 条目 command 形态非法（实际：${showVal(hits[0].command)}）`,
      `command 须为 string 或 {program, args} 形态（权威 = ${planPath} testPlan.incrementalCommands[]）`,
      `回 tech-design-v6 T3 修正该条目 command 形态后重新编译`,
    );
    return null;
  }
  return norm;
}

function buildDevNodes(ctx) {
  const { plan, planPath, increments } = ctx;
  const nodes = [];
  const prompts = new Map(); // promptFile 绝对路径 → 文本
  const incrementalCommands = Array.isArray(plan.testPlan?.incrementalCommands) ? plan.testPlan.incrementalCommands : [];
  const waveOf = computeWaves(plan.units);
  const unitIds = new Set(plan.units.map((u) => u.id));
  const noDesignRefUnits = [];

  for (const unit of plan.units) {
    const testCommand = extractTestCommand(unit, incrementalCommands, TEST_WHITELIST, planPath);
    if (testCommand === null) continue;
    if (!isStr(unit.designRef)) noDesignRefUnits.push(unit.id);

    // 单元角色 additive 标记（units[].kind）：现只登记 contract-spike（契约冒烟 spike 单元）。
    // 声明其他值 = 上游契约含糊——报缺口不静默忽略（静默丢弃会让 DAG 契约门失去判据）
    let unitKind = null;
    if (unit.kind !== undefined && unit.kind !== null) {
      if (unit.kind === "contract-spike") unitKind = "contract-spike";
      else {
        gap(
          `单元 ${unit.id} 的 kind 值不在已登记枚举（实际：${showVal(unit.kind)}）`,
          `units[].kind 权威 = ${planPath}（现只登记 "contract-spike"——契约冒烟 spike 单元；新增角色属 impl-plan 契约扩展，由 tech-design-v6 映射表登记后本编译器才消费）`,
          `回 tech-design-v6 T3 把该单元 kind 改为 "contract-spike" 或删除该字段后重新编译`,
        );
        continue;
      }
    }

    // cwd 契约：plain（含缺省）= null；worktree = units[].cwd 显式声明（不猜 worktree 路径）
    let cwd = null;
    if (unit.isolation === "worktree") {
      if (!isStr(unit.cwd) || !isAbsolute(expandHome(unit.cwd))) {
        gap(
          `单元 ${unit.id} isolation=worktree 但未声明 units[].cwd（worktree 检出绝对路径）`,
          `worktree 单元 cwd 的权威 = ${planPath} units[].cwd（编译器不推导 worktree 路径——判据见 dev-flow-v6 references/dag-authoring.md）`,
          `回 tech-design-v6 T3 补 units[${unit.id}].cwd 为 worktree 绝对路径后重新编译；不走 worktree 隔离则把 isolation 改回 plain`,
        );
        continue;
      }
      cwd = abs(unit.cwd);
    }

    const promptRel = join(ctx.promptsDir, `${unit.id}.md`);
    const runlogPath = join(ctx.runlogDir, `${unit.id}.md`);
    const incRows = buildIncrementAssertions(unit, increments);
    prompts.set(
      promptRel,
      devTaskBook({ unit, testCommand, runlogPath, ctx, incRows }),
    );
    nodes.push({
      id: unit.id,
      kind: "dev",
      deps: isStrArr(unit.deps) ? [...unit.deps] : [],
      wave: waveOf.get(unit.id) ?? 1,
      ...(isStr(unit.incrementId) ? { incrementId: unit.incrementId } : {}),
      ...(unitKind !== null ? { unitKind } : {}),
      cwd,
      designRef: isStr(unit.designRef) ? unit.designRef : "",
      territory: isStrArr(unit.territory) ? [...unit.territory] : [],
      testCommand,
      promptFile: promptRel,
    });
  }

  // 过程审查节点：impl-plan processReviews[] 声明驱动，无声明（undefined）不生成；
  // 声明存在但非数组 = 上游契约形态错误，报缺口不静默当空（静默会把该登记的审查吞掉）
  if (plan.processReviews !== undefined && !Array.isArray(plan.processReviews)) {
    gap(
      `processReviews 存在但不是数组（实际：${showVal(plan.processReviews)}）`,
      `过程审查声明的权威 = ${planPath} processReviews[]（{unitId, script?, promptFile?, mechanism?}；不声明过程审查时删除该字段或写空数组）`,
      `回 tech-design-v6 T3 修正 processReviews 为数组形态后重新编译`,
    );
  }
  const reviews = Array.isArray(plan.processReviews) ? plan.processReviews : [];
  for (const decl of reviews) {
    if (!isRec(decl) || !isStr(decl.unitId)) {
      gap(
        `processReviews 条目缺 unitId（实际：${showVal(decl)}）`,
        `过程审查声明的权威 = ${planPath} processReviews[]（{unitId, script?, promptFile?, mechanism?}）`,
        `回 tech-design-v6 T3 补该条目 unitId（指向 units[].id）后重新编译`,
      );
      continue;
    }
    if (!unitIds.has(decl.unitId)) {
      gap(
        `processReviews 条目 unitId「${decl.unitId}」不在 units[] 中`,
        `过程审查节点挂在实现单元上（deps = 被审单元）；单元清单权威 = ${planPath} units[]`,
        `回 tech-design-v6 T3 修正 unitId 或删除该声明后重新编译`,
      );
      continue;
    }
    const nodeId = `review-${decl.unitId}`;
    const hasScript = isStr(decl.script);
    const declPrompt = isStr(decl.promptFile) ? abs(decl.promptFile) : null;
    if (!hasScript && declPrompt === null) {
      // 无机器检查 = 高风险声明驱动必审：promptFile 由编译器按任务书要素模板生成
      const promptRel = join(ctx.promptsDir, `${nodeId}.md`);
      const unit = plan.units.find((u) => u.id === decl.unitId);
      prompts.set(promptRel, reviewTaskBook({ nodeId, unit, ctx, increments }));
      nodes.push({
        id: nodeId,
        kind: "review",
        deps: [decl.unitId],
        ...(isStr(decl.mechanism) ? { mechanism: decl.mechanism } : {}),
        promptFile: promptRel,
      });
    } else {
      nodes.push({
        id: nodeId,
        kind: "review",
        deps: [decl.unitId],
        ...(hasScript ? { script: abs(decl.script) } : {}),
        ...(declPrompt !== null ? { promptFile: declPrompt } : {}),
        ...(isStr(decl.mechanism) ? { mechanism: decl.mechanism } : {}),
      });
    }
  }

  return { nodes, prompts, noDesignRefUnits };
}

/** 增量归属断言行（任务书「验收基线」段）：--task-dir 编译时已读交付任务目录 increments.json，
 *  按单元 incrementId 取增量条目的需求锚与应转绿命令；独立设计任务（无 increments / 无归属）给固定说明。 */
function buildIncrementAssertions(unit, increments) {
  if (!isStr(unit.incrementId)) return null;
  const item = (increments?.items ?? []).find((it) => isRec(it) && it.id === unit.incrementId);
  if (!item) {
    return `- 增量 ${unit.incrementId}：--task-dir 交付任务目录的 increments.json 中未找到该增量（D0 编译门 --task-dir 核对会拦归属缺失；先行确认目录正确）`;
  }
  const reqs = isStrArr(item.requirementIds) ? item.requirementIds.join("、") : "未登记需求锚";
  const cmd = isRec(item.testCommand) ? `${item.testCommand.program} ${(item.testCommand.args ?? []).join(" ")}` : "增量未声明 testCommand";
  return `- 增量 ${unit.incrementId}（${item.title ?? "无标题"}）：需求锚 ${reqs}；应转绿命令 \`${cmd}\`（来源：交付任务目录 increments.json）`;
}

// ── 任务书模板（只填确定性事实；语义摘录以锚点 + 指令回上游，不代读设计正文） ──

const NUMBERING_NOTE =
  "编号域约定：本设计包的编号（场景/单元/裁决/验收项等 id）在文档与注释中裸用；引用其他设计包（历史代次或并行包）的同形编号一律带域前缀标注（形态 `<包域>·<编号>`），防止跨包同号撞号导致终态同步审查误报/漏判归属。";

function devTaskBook({ unit, testCommand, runlogPath, ctx, incRows }) {
  const cmdText = `${testCommand.program} ${testCommand.args.join(" ")}`;
  const territory = (isStrArr(unit.territory) ? unit.territory : []).map((t) => `- ${t}`).join("\n") || "-（未声明——编译前必填缺口，不应出现此形态）";
  const acceptance = (isStrArr(unit.acceptance) ? unit.acceptance : []).map((a) => `- ${a}`).join("\n") || "-（未登记验收条款）";
  const incSection = isStr(unit.incrementId)
    ? `- 增量归属：${unit.incrementId}\n${incRows ? `- 归属断言：\n${incRows}` : "- 归属断言：--task-dir 未提供，交付增量核对不在本次编译范围"}`
    : "- 增量归属：不归属增量（独立设计任务）";
  return `# ${unit.id} 开发任务书

> 本任务书由 dev-flow-v6 compile-exec-plan.mjs 从实施计划生成（禁手改；语义修订回 impl-plan 后重新编译：node ${SCRIPT_PATH} --impl-plan ${ctx.planPath}）。

## 背景
- 项目根：${ctx.projectRoot}
- 实施计划：${ctx.planPath}（唯一计划权威）
- 设计文档：${ctx.designDocPath}（本单元设计章节锚：${unit.designRef || "未登记 units[].designRef——开工前先向主 agent 索要锚点"}；权威源 = 设计目录六章节 JSON）
${NUMBERING_NOTE}

## 单元目标
- 职责：${unit.responsibility ?? "未登记"}
- 设计章节：${unit.designRef || "（未登记）"}——开工前 read 渲染视图该锚点对应节，核对实际存在；对不上停工上报，不猜测
- 验收条款：
${acceptance}

## 范围声明（territory，相对仓库根）
${territory}

## 验收基线与测试要求
${incSection}
- 增量测试命令：\`${cmdText}\`
- 测试 = 仅跑上述命令及其触及的测试文件，禁止包级全量套件与跨包扫描（全量回归由 D2 Gate A 统一承担）。testCommand 覆盖不了改动行为时在 deviations 申报、不自行扩跑；申报条目必须二选一闭环：更新 impl-plan acceptancePlan 的测试绑定（改后重跑渲染器），或申报由 D3 独立验收节点承接（写明节点与场景 id）——只申报缺口不闭环视同未完成。

## 返回契约（固定）
执行完成后返回 JSON：
\`\`\`json
{"status": "done|blocked", "files_changed": ["精确路径"], "test_evidence": "测试输出要点", "deviations": [], "blockers": [], "summary": "commit message 摘要"}
\`\`\`
- summary 末行必须是「测试：${cmdText} 绿」（commitTemplate 渲染依赖它承载测试结论）。
- deviations 为强制字段，无偏离填空数组；files_changed 逐条精确路径。
- 宿主无 structured-output 工具时在回复中用 json 代码块返回同构对象，解析失败视同本次汇报无效打回重报。

## 约束
- 禁止一切 git 写操作（commit 由引擎 / 主 agent 执行）。
- 只改范围声明内的文件；范围外的必要改动直接做并在 deviations 如实申报；并行单元互不触碰对方声明内的文件。
- 临时脚本用完清理，不残留。
- 开工前校验任务：先完成「单元目标」节的锚点核对，再动代码。
- 过程记录义务：临时待办、需裁决事项、复盘观察随时 append 到 ${runlogPath}（一行一条 \`[HH:MM] 类型: 一句话事实\`；不替代上方 JSON 返回契约）。
`;
}

function reviewTaskBook({ nodeId, unit, ctx, increments }) {
  const territory = (isStrArr(unit?.territory) ? unit.territory : []).map((t) => `- ${t}`).join("\n") || "-（未声明）";
  const acceptance = (isStrArr(unit?.acceptance) ? unit.acceptance : []).map((a) => `- ${a}`).join("\n") || "-（未登记）";
  // 排除清单：后继节点（deps 含本单元的单元）的 territory 是确定性事实——中间态误报的最大
  // 来源是「不知道哪些不完整是预期的」，此段把该事实机械列出；哪些算已知中间态的语义判断归 reviewer。
  const successors = (ctx.plan?.units ?? []).filter((u) => isStrArr(u.deps) && u.deps.includes(unit?.id));
  const exclusions = successors.length
    ? successors.flatMap((s) => [`- 后继单元 ${s.id}（范围：${(s.territory ?? []).join("、") || "未声明"}）——该单元尚未执行，其范围内的当前中间态不完整是预期事实`]).join("\n")
    : "- 无后继单元，无排除项。";
  const inc = unit && isStr(unit.incrementId) ? `- 增量归属：${unit.incrementId}（${(buildIncrementAssertions(unit, increments) ?? "").trim()}）` : "- 不归属交付增量。";
  return `# ${nodeId} 过程审查任务书

> 本任务书由 dev-flow-v6 compile-exec-plan.mjs 生成（禁手改；语义修订回 impl-plan processReviews 后重新编译：node ${SCRIPT_PATH} --impl-plan ${ctx.planPath}）。

## 审查对象
- 被审单元：${unit?.id ?? "?"}（设计章节 ${unit?.designRef || "未登记"}；职责：${unit?.responsibility ?? "未登记"}）
- 审查范围：本节点 diff（被审单元的改动）+ 直接调用方。
${NUMBERING_NOTE}

## 单元目标（审查基准）
- 验收条款：
${acceptance}
- 范围声明（territory）：
${territory}
${inc}

## 排除清单（后继节点才落地的已知中间态）
${exclusions}

## 负例说明（什么不算问题）
- 落在排除清单文件内的暂时性类型报错 / 测试红（后继单元完成前属预期中间态）不算问题。
- 风格与个人偏好差异不构成问题；判定基准 = 设计章节语义与上方验收条款。
- 上游自报 deviations 的条目按其申报核对闭环去向，不重复开问题。

## 行为证据核对要求
共享状态 / 异步时序 / 外部交互相关改动：核对测试实际构造了入口、初始状态、故障与时序，不只核对测试清单是否存在。

## 返回契约（固定）
返回 JSON：\`{ "summary": string, "problems": [{ "target": string, "summary": string, "detail": string }] }\`——无问题也须返回空 problems 数组；问题条目须给出可操作的修复指向。
`;
}

function inspectTaskBook({ node, row, ctx, verifyDeps }) {
  const depLines = verifyDeps.length
    ? verifyDeps.map((d) => `- ${d}：\`${join(ctx.productRoot, `${ctx.name}.artifacts`, d, "summary.jsonl")}\``).join("\n")
    : "- 无脚本前驱；按断言清单直接执行。";
  const adversarial = isStrArr(row.adversarialFormRefs) && row.adversarialFormRefs.length
    ? `\n- 反例场景引用：${row.adversarialFormRefs.join("、")}`
    : "";
  const artifactsDir = join(ctx.productRoot, `${ctx.name}.artifacts`, node.id);
  return `# ${node.id} 验收审查任务书（L4 inspect）

> 本任务书由 dev-flow-v6 compile-exec-plan.mjs 生成（禁手改；语义修订回 impl-plan acceptancePlan 后重新编译：node ${SCRIPT_PATH} --impl-plan ${ctx.planPath} --mode acceptance）。

## 确定性产物已就绪（核对以汇总文件为准、仅异常步骤读全文日志）
前置脚本节点已执行完成，逐节点产物：
${depLines}

## 验收项
- ${row.item ?? "未登记"}（验收计划行 ${node.id}；组 ${row.group ?? "未登记"}）${adversarial}

## 驱动约束
- 项目有 verification skill 时，真机驱动一律经其进行（发现规则见 tech-design-v6 T3：\`verify-*\` 前缀 + Launch/Drive 节，项目 AGENTS.md 声明优先），禁绕过技能裸驱动。
- 判定先查排障文档：失败先 read 项目排障文档（典型 docs/TROUBLESHOOTING.md）归因，禁不归因重试、禁放宽断言。

## 返回契约（固定，禁改）
返回 JSON：\`{ "verdict": "pass"|"fail"|"degraded", "test_evidence": string, "deviations": [], "blockers": [] }\`
- 禁写 status 字段：执行完成语义由引擎按 verdict 分流（fail→failed；pass/degraded→核锚后 done）；把「执行完成」报成 status=done 会吞掉 FAIL 结论。
- 必须把判定书 JSON 原样写入 ${join(artifactsDir, "verdict.json")}（文件内 verdict 字段必须与结构化返回一致——引擎以此文件为 done 事实锚，缺失或不一致按失败处理）。
`;
}

function summaryInspectTaskBook({ node, verifyNodes, ctx }) {
  const lines = verifyNodes.map((v) => `- ${v.id}：\`${join(ctx.productRoot, `${ctx.name}.artifacts`, v.id, "summary.jsonl")}\``).join("\n");
  const artifactsDir = join(ctx.productRoot, `${ctx.name}.artifacts`, node.id);
  return `# ${node.id} 汇总验收审查任务书

> 本任务书由 dev-flow-v6 compile-exec-plan.mjs 生成（禁手改；语义修订回 impl-plan acceptancePlan 后重新编译：node ${SCRIPT_PATH} --impl-plan ${ctx.planPath} --mode acceptance）。

## 判定输入（全部脚本节点产物集中核对，以 summary.jsonl 为准、仅异常步骤读全文日志）
${lines}

## 判定要求
- 判 pass / fail / degraded：脚本断言全绿仅是基线，另须扫全页截图与 console 兜底（脚本断言盲区由这步补偿）。
- 扫各脚本节点产物中的未决项 / 未覆盖登记，汇入交付口径。
- fail 须归因定位到场景与日志行。

## 返回契约（固定，禁改）
返回 JSON：\`{ "verdict": "pass"|"fail"|"degraded", "test_evidence": string, "deviations": [], "blockers": [] }\`（禁写 status 字段）
- 必须把判定书 JSON 原样写入 ${join(artifactsDir, "verdict.json")}（文件内 verdict 必须与结构化返回一致——引擎事实锚）。
`;
}

// ── acceptance 部分编译（acceptancePlan → verify/inspect 节点 + wrapper 装配） ──

const LEVEL_VERIFY = (l) => isStr(l) && l.trim().startsWith("L3");
const LEVEL_INSPECT = (l) => isStr(l) && (l.trim().startsWith("L4") || l.trim() === "inspect-only");

function buildAcceptanceNodes(ctx) {
  const { plan, planPath, statusData } = ctx;
  const rows = Array.isArray(plan.acceptancePlan) ? plan.acceptancePlan : [];
  const nodes = [];
  const prompts = new Map();
  const wrapperAssets = []; // 走 gen-acceptance-wrapper 的清单条目
  const probeAssets = []; // 走 gen-runtime-probe-wrapper 的 runtime-probe 清单条目
  const compiledIds = new Set();
  let skippedRows = 0; // L0/L1/L2 等不编译行计数（D1/D2 已覆盖，compile.md 验收分组规则）

  // 逐行先编译 verify/inspect（deps 引用完整性第二步核对）
  for (const row of rows) {
    if (!isRec(row) || !isStr(row.id)) {
      gap(
        `acceptancePlan 条目缺 id（实际：${showVal(row)}）`,
        `验收计划行权威 = ${planPath} acceptancePlan[]（渲染必填校验由 tech-design-v6 渲染器承担——先过渲染门）`,
        "回 tech-design-v6 T3 补齐行 id 后重新渲染、重新编译",
      );
      continue;
    }
    // runtime-probe 行（设计 §7.3 D3 additive 行类型）：编译为 verify 节点，script = 生成的
    // probe wrapper；行字段形态与能力 id 对账由 check-exec-plan 同源函数承担（与写盘后校验器
    // 零漂移）。无 type 字段的行走下方既有 level 规则（向后兼容）
    if (isStr(row.type) && row.type === "runtime-probe") {
      compiledIds.add(row.id);
      const probeNode = buildRuntimeProbeNode(row, ctx);
      if (probeNode === null) continue; // 缺口已收集——该行不编译（编译整体中止）
      probeAssets.push(probeNode.asset);
      nodes.push(probeNode.node);
      continue;
    }
    const level = isStr(row.level) ? row.level.trim() : "";
    if (!LEVEL_VERIFY(level) && !LEVEL_INSPECT(level)) {
      skippedRows += 1; // L0/L1/L2 行不编译成节点——已由 D1 单元测试与 D2 Gate A 覆盖
      continue;
    }
    compiledIds.add(row.id);
    const assetsDirFor = (id) => (isStr(row.artifactsDir) ? abs(row.artifactsDir) : join(ctx.productRoot, `${ctx.name}.artifacts`, id));

    if (LEVEL_VERIFY(level) && row.verifyAsset !== "inspect-only") {
      const verifyAsset = isStr(row.verifyAsset) ? row.verifyAsset : "-";
      const artifactsDir = assetsDirFor(row.id);
      if (verifyAsset === "-") {
        // 项目无 verification skill：script = 实装剧本本体直跑（不走 wrapper）
        if (!isStr(row.script)) {
          gap(
            `验收行 ${row.id}（L3，verifyAsset="-"）未声明 acceptancePlan[].script（剧本本体绝对路径）`,
            `verifyAsset="-" 行的 script 权威 = ${planPath} acceptancePlan[].script（剧本实装硬门槛：必须已实装并对样本数据实跑 exit 0）`,
            `回 tech-design-v6 T3 登记该行 script（或走 wrapper 形态声明 runner/scenario）后重新编译；剧本尚未实装则先实装再登记`,
          );
          continue;
        }
        nodes.push({ id: row.id, kind: "verify", deps: [...(isStrArr(row.deps) ? row.deps : [])], script: abs(row.script), artifactsDir });
      } else if (verifyAsset === "new" || verifyAsset.startsWith("reuse:")) {
        // wrapper 形态：runner 调用契约必须显式声明（禁止猜参数）；new 态还须实装单元已完成
        if (verifyAsset === "new") {
          if (!isStr(row.unit)) {
            gap(
              `验收行 ${row.id}（verifyAsset="new"）未声明 acceptancePlan[].unit（实装单元 id）`,
              `new 态实装责任的权威 = ${planPath} acceptancePlan[].unit（编译器以 status.json 该单元 done 判定资产就绪，不猜完成态）`,
              `回 tech-design-v6 T3 补该行 unit 指向 units[].id 后重新编译`,
            );
            continue;
          }
          const st = statusData?.nodes?.[row.unit]?.status;
          if (st !== "done") {
            gap(
              `验收行 ${row.id}（verifyAsset="new"）的实装单元 ${row.unit} 未完成（status.json 实际：${st ?? "无记录"}）——验收资产未就绪`,
              "验收产物只在验证资产已存在、当次跑通后生成（设计 §6.3 第 2 条：新资产由开发单元完成后再生成验收产物）",
              `等单元 ${row.unit} 在 D1 执行完成（status=done）后重新运行 acceptance 编译；资产实装责任有变则回 impl-plan 修 unit 声明`,
            );
            continue;
          }
        }
        // runner 契约两查合并（形态 + flags 范围）在缺口收集阶段完成——超界/含糊在写盘前
        // 即报，不产生 verify-assets.json 等半截产物；模板与防手改仍由 gen-acceptance-wrapper 承担
        const runner = row.runner;
        const runnerOk = isRec(runner) && isStr(runner.path) && isAbsolute(expandHome(runner.path)) && "flags" in runner && isStrArr(runner.flags);
        let flagsProblem = null;
        if (runnerOk) {
          const unknown = runner.flags.filter((f) => !KNOWN_FLAGS.includes(f));
          if (unknown.length > 0) {
            flagsProblem = `声明了未建模的 flag（${unknown.join("、")}）——四旗之外（${KNOWN_FLAGS.join(" ")}）一律拒收`;
          } else {
            const dups = runner.flags.filter((f, i) => runner.flags.indexOf(f) !== i);
            if (dups.length > 0) flagsProblem = `flags 含重复声明（${[...new Set(dups)].join("、")}）——重复即契约含糊`;
          }
        }
        const scenarioOk = isRec(row.scenario) && isStr(row.scenario.path) && isAbsolute(expandHome(row.scenario.path));
        if (!runnerOk || !scenarioOk || flagsProblem !== null) {
          const missing = [!runnerOk ? "acceptancePlan[].runner {path, flags}" : null, !scenarioOk ? "acceptancePlan[].scenario {path}" : null].filter(Boolean).join(" 与 ");
          gap(
            `验收行 ${row.id}（L3，verifyAsset=${verifyAsset}）${flagsProblem !== null ? `runner.flags ${flagsProblem}` : `缺 ${missing}——wrapper 调用契约不完整`}`,
            "wrapper 契约权威 = impl-plan acceptancePlan[].runner/scenario（gen-acceptance-wrapper 清单契约：flags 显式声明逐字为准，未声明/超界即不生成，禁止猜参数）",
            `回 tech-design-v6 T3 对照项目 verification skill 的 API 契约文档登记 runner（path + 实际支持的 flags，仅 ${KNOWN_FLAGS.join(" ")} 之内）与 scenario.path 后重新编译；契约确实不明的行改判 inspect-only`,
          );
          continue;
        }
        wrapperAssets.push({
          nodeId: row.id,
          runner: { path: abs(row.runner.path), flags: [...row.runner.flags] },
          scenario: { path: abs(row.scenario.path) },
          artifactsDir,
        });
        nodes.push({
          id: row.id,
          kind: "verify",
          deps: [...(isStrArr(row.deps) ? row.deps : [])],
          script: join(ctx.productRoot, `${ctx.name}.verify`, `${row.id}.mjs`), // gen-acceptance-wrapper 落点（先登记，spawn 后核存在）
          artifactsDir,
        });
      } else {
        gap(
          `验收行 ${row.id} 的 verifyAsset 值不在已知三态（实际：${verifyAsset}）`,
          `verifyAsset 权威枚举 = reuse:<场景id> / new / inspect-only / "-"（tech-design-v6 flow/plan.md 验证资产三态）`,
          `回 tech-design-v6 T3 修正该行 verifyAsset 后重新渲染、重新编译`,
        );
        continue;
      }
    } else {
      // L4 / inspect-only → inspect 节点
      const promptRel = join(ctx.promptsDir, `${row.id}.md`);
      const deps = isStrArr(row.deps) ? [...row.deps] : [];
      const verifyDeps = deps.filter((d) => rows.some((r) => isRec(r) && r.id === d && LEVEL_VERIFY(isStr(r.level) ? r.level.trim() : "") && r.verifyAsset !== "inspect-only"));
      prompts.set(promptRel, inspectTaskBook({ node: { id: row.id }, row, ctx, verifyDeps }));
      nodes.push({
        id: row.id,
        kind: "inspect",
        deps,
        promptFile: promptRel,
        artifactsRefs: verifyDeps, // 引擎按 artifactsRefs 提示 verify 前驱产物目录
        artifactsDir: assetsDirFor(row.id), // verdict.json 判定书落点（引擎事实锚读取处）
      });
    }
  }

  // deps 引用完整性：验收节点 deps 只能指向编译成节点的验收行（L0/L1/L2 行不进 D3）
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!compiledIds.has(d)) {
        gap(
          `验收节点 ${n.id} 的 deps 指向未编译为 D3 节点的验收行「${d}」（L0/L1/L2 行不进 D3——已由 D1/D2 覆盖）`,
          `验收计划依赖权威 = ${planPath} acceptancePlan[].deps（只允许指向 L3/L4/inspect-only 行）`,
          `回 tech-design-v6 T3 修正该行 deps 指向，或把「${d}」行升为 L3/L4 后重新编译`,
        );
      }
    }
  }

  // 汇总 inspect 节点（compile.md 验收编译规则补编段）：全部 verify 产物集中判定
  const verifyNodes = nodes.filter((n) => n.kind === "verify");
  if (verifyNodes.length > 0) {
    const summaryId = "summarize";
    if (compiledIds.has(summaryId) || nodes.some((n) => n.id === summaryId)) {
      gap(
        `汇总 inspect 节点保留 id「${summaryId}」与验收计划行 id 冲突`,
        `验收行 id 清单权威 = ${planPath} acceptancePlan[].id`,
        `回 tech-design-v6 T3 改名占用「${summaryId}」的验收行后重新编译`,
      );
    } else {
      const promptRel = join(ctx.promptsDir, `${summaryId}.md`);
      prompts.set(promptRel, summaryInspectTaskBook({ node: { id: summaryId }, verifyNodes, ctx }));
      nodes.push({
        id: summaryId,
        kind: "inspect",
        deps: verifyNodes.map((v) => v.id),
        promptFile: promptRel,
        artifactsRefs: verifyNodes.map((v) => v.id),
        artifactsDir: join(ctx.productRoot, `${ctx.name}.artifacts`, summaryId),
      });
    }
  }

  return { nodes, prompts, wrapperAssets, probeAssets, skippedRows };
}

/** runtime-probe 行 → verify 节点 + probe wrapper 清单条目（设计 §7.3 D3）。缺口收集后
 *  返回 null（该行不编译，编译整体中止）；wrapper 落点 = <taskDir>/evidence/runtime-probes/
 *  <nodeId>.mjs（产物进 taskDir evidence——设计 §7.3 D0 末条）。 */
function buildRuntimeProbeNode(row, ctx) {
  const label = `runtime-probe 行 ${row.id}`;
  // runtime-probe 只适用于交付体系任务（wrapper 与 artifact 落 taskDir evidence，能力 id
  // 对账对象 = 验收包 externalContracts）——独立设计任务（无 --task-dir）声明该行即缺口
  if (!isStr(ctx.taskDir)) {
    gap(
      `${label} 只适用于交付体系任务（未传 --task-dir）`,
      `runtime-probe 行的 wrapper / artifact 落交付任务目录 evidence，能力 id 对账验收包 externalContracts（权威 = ${ctx.planPath} acceptancePlan[] + 交付任务目录）`,
      "交付体系任务补 --task-dir 后重新编译；独立设计任务回 tech-design-v6 T3 删除该行",
    );
    return null;
  }
  const level = isStr(row.level) ? row.level.trim() : "";
  if (!LEVEL_VERIFY(level)) {
    gap(
      `${label} 的 level 必须是 L3（脚本执行行；实际：${showVal(row.level)}）`,
      `runtime-probe 行 level 权威 = ${ctx.planPath} acceptancePlan[]（runtime 探针是脚本执行行，按 L3 编译为 verify 节点）`,
      `回 tech-design-v6 T3 把该行 level 改为 L3 后重新渲染、重新编译`,
    );
    return null;
  }
  // 能力 id 对账对象 = 验收包 externalContracts（缺声明即无对账权威——probe 只能观察已声明能力）
  const contracts =
    ctx.acceptance !== null && Array.isArray(ctx.acceptance.externalContracts) ? ctx.acceptance.externalContracts : null;
  if (contracts === null) {
    gap(
      `${label} 存在但验收包未声明 externalContracts——probe 观察的契约能力无对账对象`,
      "runtime-probe 行 capabilityIds 必须能回溯到验收包 externalContracts 的 capabilities（设计 §7.3 / §5.1 检查 6）",
      "回 delivery-v6 在验收包声明 externalContracts（含该行观察的能力）后重新编译，或回 tech-design-v6 T3 删除该行",
    );
    return null;
  }
  for (const e of checkRuntimeProbeRows([row], contracts)) {
    gap(
      `${label}：${e.message}`,
      `runtime-probe 行字段权威 = ${ctx.planPath} acceptancePlan[]（type="runtime-probe" + capabilityIds + command + artifact；能力 id 对账权威 = 验收包 externalContracts）`,
      "回 tech-design-v6 T3 修正该行字段后重新渲染、重新编译；能力 id 不在验收包时回 delivery-v6 修订 externalContracts",
    );
  }
  const command = normalizeCommand(row.command, TEST_WHITELIST);
  if (command === null) {
    gap(
      `${label} 的 command 形态非法（实际：${showVal(row.command)}）`,
      `runtime-probe 行 command 权威 = ${ctx.planPath} acceptancePlan[].command（{program, args}；program 受测试命令白名单 ${TEST_WHITELIST.join("/")} 约束）`,
      "回 tech-design-v6 T3 修正该行 command 形态后重新渲染、重新编译",
    );
    return null;
  }
  // driver 存在性（剧本实装硬门槛同款纪律：不编译指向不存在文件的引用——占位引用会把
  // D3 探针节点变成启动即炸的雷）。无可静态判定的 driver 文件（bash -c 封装等）不猜
  const missingDriver = missingDriverPath(row.command, ctx.projectRoot);
  if (missingDriver !== null) {
    gap(
      `${label} 的 driver 文件不存在：${missingDriver}——probe 资产未实装`,
      "runtime-probe 的 driver 由任务实现提供（acceptance 编译前须已实装——与 verify 剧本同款硬门槛；driver 契约 = 单文件、无动态 import、stdout 单一 JSON）",
      "等 driver 所在实装单元完成（status=done）后重跑 acceptance 编译；driver 归属单元有变则回 T3 修正该行 command",
    );
    return null;
  }
  const artifact = resolveProbeArtifact(row.artifact, ctx.taskDir);
  if (artifact === null) {
    gap(
      `${label} 的 artifact 缺失或越出交付任务目录（实际：${showVal(row.artifact)}）`,
      `runtime-probe 行 artifact 权威 = ${ctx.planPath} acceptancePlan[].artifact（相对交付任务目录的 evidence 路径，禁绝对路径与 .. 逃逸）`,
      "回 tech-design-v6 T3 把 artifact 改为任务目录内的 evidence 相对路径后重新渲染、重新编译",
    );
    return null;
  }
  const artifactsDir = isStr(row.artifactsDir) ? abs(row.artifactsDir) : join(ctx.productRoot, `${ctx.name}.artifacts`, row.id);
  const wrapperPath = join(ctx.taskDir, "evidence", "runtime-probes", `${row.id}.mjs`);
  const capabilityIds = [...row.capabilityIds];
  return {
    node: {
      id: row.id,
      kind: "verify",
      deps: isStrArr(row.deps) ? [...row.deps] : [],
      script: wrapperPath, // gen-runtime-probe-wrapper 落点（先登记，spawn 后核存在）
      artifactsDir,
      runtimeProbe: { capabilityIds, command, artifact },
    },
    asset: { nodeId: row.id, capabilityIds, command, artifact, artifactsDir },
  };
}

/** runtime-probe 行 command.args 中 node 系扩展名条目全部须在盘上（driver 与 import 前置
 *  文件）；返回缺失路径串（多个以「、」连接），无缺失或无可静态判定条目时返回 null */
function missingDriverPath(command, projectRoot) {
  if (!isRec(command) || !isStrArr(command.args)) return null;
  const nodeish = command.args.filter((a) => /\.(mjs|cjs|js)$/.test(a));
  if (nodeish.length === 0) return null;
  const resolved = nodeish.map((a) => (isAbsolute(expandHome(a)) ? abs(a) : resolve(projectRoot, a)));
  const missing = resolved.filter((p) => !existsSync(p));
  return missing.length > 0 ? missing.join("、") : null;
}

/** probe artifact 落点：任务目录相对声明 → 绝对路径；绝对路径与 .. 逃逸（越出任务目录）拒绝 */
function resolveProbeArtifact(artifact, taskDir) {
  if (!isStr(artifact) || !isStr(taskDir)) return null;
  const p = resolve(taskDir, expandHome(artifact));
  if (p !== taskDir && !p.startsWith(`${taskDir}/`)) return null;
  return p;
}

/** 组装 gen-acceptance-wrapper 验收资产清单并 spawn 生成器（确定性委派——wrapper 模板与
 *  防手改由 gen-acceptance-wrapper 承担；契约形态与 flags 范围已前移 buildAcceptanceNodes
 *  缺口收集阶段，此处生成器校验作为第二道独立防线，报缺口即转发中止）。 */
function materializeWrappers(ctx, wrapperAssets, planPath) {
  if (wrapperAssets.length === 0) return true;
  const manifestPath = join(ctx.productRoot, `${ctx.name}.verify-assets.json`);
  const manifest = { schemaVersion: 1, projectRoot: ctx.projectRoot, assets: wrapperAssets };
  const outDir = join(ctx.productRoot, `${ctx.name}.verify`);
  try {
    mkdirSync(ctx.productRoot, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    gap(`验收资产清单写盘失败：${manifestPath}（${e.message}）`, `清单落点 = dev-flow 段产物根（${ctx.productRoot}）`, `排除文件系统故障后重新运行编译命令`);
    return false;
  }
  const r = spawnSync(process.execPath, [GEN_WRAPPER, "--assets", manifestPath, "--out", outDir], { encoding: "utf8" });
  if (r.status !== 0) {
    // 生成器自报语义缺口（runner flags 超界 / 资产不存在等）——转发其三段式输出
    process.stderr.write(
      [
        "wrapper 生成器（gen-acceptance-wrapper.mjs）报告缺口，编译中止，未写 exec-plan：",
        "",
        String(r.stderr || r.stdout || "").trim(),
        "",
        `恢复动作处理后重新运行：node ${SCRIPT_PATH} --impl-plan ${planPath} --mode acceptance${ctx.taskDir ? ` --task-dir ${ctx.taskDir}` : ""}`,
      ].join("\n") + "\n",
    );
    process.exit(1);
  }
  for (const a of wrapperAssets) {
    const wrapperFile = join(outDir, `${a.nodeId}.mjs`);
    if (!existsSync(wrapperFile)) {
      gap(`wrapper 落点缺失：${wrapperFile}（生成器报告成功但文件不在盘上）`, `wrapper 落点 = <产物根>/<name>.verify/<nodeId>.mjs（gen-acceptance-wrapper 契约）`, `重新运行编译命令重试；仍失败按 gen-acceptance-wrapper --help 排障`);
    }
  }
  return gaps.length === 0;
}

/** 组装 gen-runtime-probe-wrapper probe 资产清单并 spawn 生成器（确定性委派——wrapper 模板、
 *  防手改与命令/落点校验由生成器承担；行字段形态与能力 id 对账已在 buildRuntimeProbeNode 的
 *  缺口收集阶段完成，此处生成器校验作为第二道独立防线，报缺口即转发中止）。wrapper 落点 =
 *  <taskDir>/evidence/runtime-probes/<nodeId>.mjs（产物进 taskDir evidence——设计 §7.3 D0 末条）。 */
function materializeProbeWrappers(ctx, probeAssets, planPath) {
  if (probeAssets.length === 0) return true;
  const outDir = join(ctx.taskDir, "evidence", "runtime-probes");
  const manifestPath = join(outDir, "probe-assets.json");
  const manifest = { schemaVersion: 1, assets: probeAssets };
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    gap(`probe 资产清单写盘失败：${manifestPath}（${e.message}）`, `清单落点 = 交付任务目录 evidence/runtime-probes/（${outDir}）`, "排除文件系统故障后重新运行编译命令");
    return false;
  }
  const r = spawnSync(process.execPath, [GEN_PROBE_WRAPPER, "--assets", manifestPath, "--out", outDir], { encoding: "utf8" });
  if (r.status !== 0) {
    // 生成器自报语义缺口（driver 命令恒绿形态 / capabilityIds 缺失等）——转发其三段式输出
    process.stderr.write(
      [
        "probe wrapper 生成器（gen-runtime-probe-wrapper.mjs）报告缺口，编译中止，exec-plan 已写盘但验收节点不可执行：",
        "",
        String(r.stderr || r.stdout || "").trim(),
        "",
        `恢复动作处理后重新运行：node ${SCRIPT_PATH} --impl-plan ${planPath} --mode acceptance${ctx.taskDir ? ` --task-dir ${ctx.taskDir}` : ""}`,
      ].join("\n") + "\n",
    );
    process.exit(1);
  }
  for (const a of probeAssets) {
    const wrapperFile = join(outDir, `${a.nodeId}.mjs`);
    if (!existsSync(wrapperFile)) {
      gap(`probe wrapper 落点缺失：${wrapperFile}（生成器报告成功但文件不在盘上）`, `wrapper 落点 = <taskDir>/evidence/runtime-probes/<nodeId>.mjs（gen-runtime-probe-wrapper 契约）`, `重新运行编译命令重试；仍失败按 gen-runtime-probe-wrapper --help 排障`);
    }
  }
  return gaps.length === 0;
}

// ── 比对与重放 ──

/** 深比较并产出差异路径清单（canonicalJson 逐路径对比；数组按下标对齐） */
function deepDiff(a, b, pathPrefix, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isRec(a) && isRec(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      deepDiff(a[k], b[k], `${pathPrefix}.${k}`, out);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) deepDiff(a[i], b[i], `${pathPrefix}[${i}]`, out);
  } else {
    out.push({ path: pathPrefix, old: a, fresh: b });
  }
}

function runCheckMode(ctx, execPlan, prompts) {
  const failures = [];
  // exec-plan：解析后深比较（键序无关——手改语义按内容判定，与 render-impl-plan 元数据豁免同一原则）
  const execPath = join(ctx.productRoot, `${ctx.name}.exec-plan.json`);
  let diskPlan;
  try {
    diskPlan = JSON.parse(readFileSync(execPath, "utf8"));
  } catch {
    failures.push({ file: execPath, reason: "exec-plan.json 不存在或不是合法 JSON（--check 需要盘上产物作比对对象）" });
  }
  if (diskPlan !== undefined) {
    const diffs = [];
    deepDiff(diskPlan, execPlan, "exec-plan", diffs);
    if (diffs.length > 0) {
      // baseline/skillVersion 属输入快照可比对——差异行如实报；HEAD 前进导致的 baseline 差异
      // 属执行演进不是手改，恢复动作里区分
      failures.push({
        file: execPath,
        reason: `与重新生成结果不一致（${diffs.length} 处）`,
        detail: diffs.map((d) => `  ${d.path}: 盘上=${showVal(d.old)} 重新生成=${showVal(d.fresh)}`),
      });
    }
  }
  // promptFile：逐字节
  for (const [p, text] of prompts) {
    let disk;
    try {
      disk = readFileSync(p, "utf8");
    } catch {
      failures.push({ file: p, reason: "任务书缺失" });
      continue;
    }
    if (disk !== text) {
      failures.push({ file: p, reason: "与重新生成结果不一致（逐字节比较）——被手改" });
    }
  }
  // status.json：执行态载体（设计 §4「仅 D0 初始化时生成；执行后由合法转移与对账更新」），
  // 不适用防手改检查——显式说明跳过，不静默
  const statusPath = join(ctx.productRoot, `${ctx.name}.status.json`);
  const statusNote = existsSync(statusPath) ? "status.json 为执行态载体，不适用防手改检查（已跳过）" : null;
  // wrapper：委托 gen-acceptance-wrapper --check（清单在场时）
  const manifestPath = join(ctx.productRoot, `${ctx.name}.verify-assets.json`);
  let wrapperNote = null;
  if (existsSync(manifestPath)) {
    const r = spawnSync(process.execPath, [GEN_WRAPPER, "--assets", manifestPath, "--out", join(ctx.productRoot, `${ctx.name}.verify`), "--check"], { encoding: "utf8" });
    if (r.status !== 0) {
      failures.push({ file: join(ctx.productRoot, `${ctx.name}.verify`), reason: `wrapper 防手改核对未过（gen-acceptance-wrapper --check）`, detail: String(r.stderr || r.stdout || "").trim().split("\n") });
    } else {
      wrapperNote = "wrapper 防手改核对 PASS（gen-acceptance-wrapper --check）";
    }
  }
  // probe wrapper：委托 gen-runtime-probe-wrapper --check（清单在场时——编译过 runtime-probe 行才有）
  const probeWrapperDir = ctx.taskDir ? join(ctx.taskDir, "evidence", "runtime-probes") : null;
  const probeManifestPath = probeWrapperDir ? join(probeWrapperDir, "probe-assets.json") : null;
  let probeWrapperNote = null;
  if (probeManifestPath !== null && existsSync(probeManifestPath)) {
    const r = spawnSync(process.execPath, [GEN_PROBE_WRAPPER, "--assets", probeManifestPath, "--out", probeWrapperDir, "--check"], { encoding: "utf8" });
    if (r.status !== 0) {
      failures.push({ file: probeWrapperDir, reason: `runtime-probe wrapper 防手改核对未过（gen-runtime-probe-wrapper --check）`, detail: String(r.stderr || r.stdout || "").trim().split("\n") });
    } else {
      probeWrapperNote = "runtime-probe wrapper 防手改核对 PASS（gen-runtime-probe-wrapper --check）";
    }
  }
  if (failures.length > 0) {
    const regen = `node ${SCRIPT_PATH} --impl-plan ${ctx.planPath} --mode ${ctx.mode}${ctx.taskDir ? ` --task-dir ${ctx.taskDir}` : ""}`;
    const out = [`FAIL：${failures.length} 项与重新生成结果不一致——生成物禁手改，语义修订回 impl-plan / 设计包后重新生成`];
    failures.forEach((f, i) => {
      out.push("", `[${i + 1}] ${f.file}`, `  不一致原因：${f.reason}`);
      if (f.detail) out.push(...(Array.isArray(f.detail) ? f.detail : [f.detail]).map((l) => `  ${l}`));
    });
    out.push("", `重新生成：${regen}`);
    if (statusNote) out.push(`说明：${statusNote}`);
    process.stderr.write(out.join("\n") + "\n");
    process.exit(1);
  }
  const lines = [`CHECK PASS：exec-plan 与 ${prompts.size} 份任务书与重新生成结果一致（impl-plan ${ctx.planPath}）`];
  if (statusNote) lines.push(`说明：${statusNote}`);
  if (wrapperNote) lines.push(wrapperNote);
  if (probeWrapperNote) lines.push(probeWrapperNote);
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

function runReplayCompare(ctx, execPlan, oldPlanArg) {
  const oldPath = abs(oldPlanArg);
  let oldPlan;
  try {
    oldPlan = JSON.parse(readFileSync(oldPath, "utf8"));
  } catch (e) {
    gap(`旧 exec-plan 不可读或不是合法 JSON：${oldPath}（${e.message}）`, "历史只读重放（设计 §7.7）的比对对象 = 旧 exec-plan.json（只读，不修改）", "核对 --replay-compare 路径后重试");
    printGaps();
    process.exit(1);
  }
  const oldMode = oldPlan?.mode;
  if (oldMode !== ctx.mode) {
    failUsage(`--replay-compare 的旧文件 mode=${JSON.stringify(oldMode)} 与本次编译 mode=${ctx.mode} 不一致——按旧文件 mode 重放请改用 --mode ${oldMode}`);
  }
  // 溯源字段豁免：generatedBy（生成命令与输入哈希随当次调用变化）、baseline（输入快照随
  // HEAD 前进变化）照常进差异报告但不计入手改语义——重放只报告差异，不判定对错
  const diffs = [];
  deepDiff(oldPlan, execPlan, "exec-plan", diffs);
  const lines = [
    `重放完成：${oldPath} 与按当前输入重新生成的 exec-plan 比对，差异 ${diffs.length} 处（历史只读重放 §7.7——不推断旧执行行为；对照实际执行须另行输入旧 status.json 等执行记录）`,
  ];
  if (diffs.length === 0) lines.push("零差异。");
  else {
    for (const d of diffs) lines.push(`  ${d.path}: 旧=${showVal(d.old)} 新=${showVal(d.fresh)}`);
    lines.push("说明：baseline / generatedBy 差异属输入快照与溯源字段的自然演进（HEAD 前进、调用参数变化），不是手改信号；业务字段差异按逐条核对。");
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

// ── --task-dir 前移核对（写盘前执行；数据源为已在内存的 increments.json 与交付任务目录）──
// 增量契约与验收绑定两段核对从写盘后校验器前移至此：缺口阶段发现归属/绑定不一致时不落盘
// 任何产物（此前形态会在 exec-plan 已写盘后才报 FAIL）。quality 段（check-quality-contract）
// 依赖盘上 exec-plan 与设计目录路径，仍由写盘后 spawn 真校验器承担。
// realpath 归一（symlink / 尾斜杠形态统一）——与 check-exec-plan.mjs CLI 侧同口径，失败回退原串。

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function checkTaskDirContract(execPlan, ctx) {
  const { taskDir, increments, acceptance, designDocPath } = ctx;
  if (taskDir === null || increments === null) return;
  // ① 增量契约核对（check-exec-plan 同口径移植函数，直接吃内存对象）
  for (const e of checkIncrementContract(execPlan, increments)) {
    gap(
      `增量契约核对未过：${e.message}`,
      `增量归属与命令的权威 = ${taskDir}/increments.json（delivery-v6 验收设计产出、随验收包批准冻结）`,
      "按缺口明细回上游修正后重新编译：归属/命令转抄问题回 tech-design-v6 T3「增量契约对齐」节；增量的增删改回 delivery-v6 递增验收版本重批",
    );
  }
  // ② 验收绑定一致性核对：读设计包 meta.json 与交付任务目录 acceptance.json（后者由 main
  // 预先读入 ctx.acceptance——外部契约门与 runtime-probe 对账共用同一份；读失败已报缺口）
  if (acceptance !== null) {
    const metaPath = join(designDocPath.endsWith(".rendered.md") ? join(dirname(designDocPath), basename(designDocPath, ".rendered.md")) : designDocPath, "meta.json");
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (e) {
      gap(
        `无法读取设计包 meta.json：${metaPath}（${e.message}）——验收绑定核对缺输入`,
        "meta.json 的 acceptanceBinding 由 tech-design-v6 T1 入口门（flow/write.md Step 0）写入；exec-plan designDocPath 指向渲染视图，meta.json 在同级设计目录",
        "确认设计包在 T1 入口门写入 acceptanceBinding（独立设计任务不传 --task-dir 即无此核对）后重新编译",
      );
      return;
    }
    const metaNorm =
      isRec(meta) && isRec(meta.acceptanceBinding) && isStr(meta.acceptanceBinding.taskDir)
        ? { ...meta, acceptanceBinding: { ...meta.acceptanceBinding, taskDir: realpathSafe(meta.acceptanceBinding.taskDir) } }
        : meta;
    for (const e of checkAcceptanceBinding(execPlan, metaNorm, acceptance, increments, realpathSafe(taskDir))) {
      gap(
        `验收绑定核对未过：${e.message}`,
        "验收版本与验收包内容变化属技能①职权（delivery-v6 裁决域）；绑定更新权威 = tech-design-v6 T1 入口门（flow/write.md Step 0）",
        "回 tech-design-v6 flow/write.md Step 0 重新影响审查并更新 meta.json acceptanceBinding 后重编译——不在 exec-plan 侧改",
      );
    }
  }
  // ③ 外部契约门（设计 §7.1 / §7.3 D0）：权威快照 / essential 契约的契约冒烟增量与 spike
  //   DAG / D0 复扫。验收包无 externalContracts 与 externalContractReview = 升级前旧任务，
  //   整门跳过（新规则只对新任务生效，历史任务不受影响）
  checkExternalContractGate(execPlan, ctx);
  // ④ runtime-probe 节点 vs 验收包能力对账（acceptance 模式编译产物；dev 模式无验收节点）
  for (const e of checkRuntimeProbeNodes(execPlan, acceptance)) {
    gap(
      `runtime-probe 核对未过：${e.message}`,
      "runtime-probe 节点的 capabilityIds 必须能回溯到验收包 externalContracts 的 capabilities（设计 §7.3 D3；exec-plan 节点由 impl-plan acceptancePlan 行编译，禁手改）",
      "回 tech-design-v6 T3 修正 acceptancePlan 的 runtime-probe 行后重编译；能力 id 不在验收包时回 delivery-v6 修订 externalContracts",
    );
  }
}

/** 外部契约门（设计 §7.3 D0 三条拒绝条件 + §4.2 D0 复扫规则 + §4.3 权威快照）。
 *  拒绝条件全部落在写盘前（与「契约前移 = 全体不生成」纪律一致——新门在写盘前）。 */
function checkExternalContractGate(execPlan, ctx) {
  const { taskDir, acceptance, increments, projectRoot } = ctx;
  if (taskDir === null || acceptance === null) return;
  const contracts = Array.isArray(acceptance.externalContracts) ? acceptance.externalContracts : null;
  const review = isRec(acceptance.externalContractReview) ? acceptance.externalContractReview : null;
  if (contracts === null && review === null) return; // 升级前旧任务——整门跳过

  const AUTHORITY_PKG =
    "外部契约声明与候选处置的权威 = 交付验收包 acceptance.json 顶层 externalContracts / externalContractReview（delivery-v6 验收设计产出；字段规则见设计 §4.1 / §4.2）";
  // ① 声明层形态（结构性缺漏在此拦，语义充分性归验收审查）
  if (contracts !== null) {
    contracts.forEach((c, i) => {
      if (!isRec(c) || !isStr(c.id)) {
        gap(
          `acceptance.externalContracts[${i}] 缺 id 或形态非法（实际：${showVal(c)}）`,
          AUTHORITY_PKG,
          "回 delivery-v6 修订验收包 externalContracts 后重新编译",
        );
      } else if (!Array.isArray(c.capabilities)) {
        gap(
          `外部契约 ${c.id} 缺 capabilities 数组`,
          `${AUTHORITY_PKG}；capabilities 是机器可对账的最小能力清单（设计 §4.1）`,
          "回 delivery-v6 补该契约 capabilities（含 detectionClasses / surfaceRefs / minEnvironment）后重新编译",
        );
      } else if (c.essential !== undefined && typeof c.essential !== "boolean") {
        gap(
          `外部契约 ${c.id} 的 essential 必须是布尔值（实际：${showVal(c.essential)}）`,
          `${AUTHORITY_PKG}；essential 决定权威不可解析 / runtime 义务未满足时能否批准与 accepted（设计 §4.1）`,
          "回 delivery-v6 修正该契约 essential 后重新编译",
        );
      }
    });
  }

  // ② 权威环境契约快照（指针 + 按哈希分文件快照）：缺快照即缺权威工件，拒绝编译
  const pointerPath = join(taskDir, "environment-contracts.current.json");
  let pointer = null;
  try {
    pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch (e) {
    gap(
      `缺权威环境契约快照指针：${pointerPath}（${e.message}）`,
      "环境契约快照指针 = 交付任务目录 environment-contracts.current.json（resolve-external-contracts.mjs --write 产物，指向 environment-contracts/<snapshotSha256>.json；无外部候选时也须有空快照 contracts: []——设计 §4.3 / §4.5）",
      `跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${taskDir} --project-root ${projectRoot} --write 重建后重新编译`,
    );
  }
  let snapshotContracts = null;
  if (pointer !== null) {
    const sha = ["snapshotSha256", "snapshot", "sha256", "path", "file"]
      .map((k) => (isStr(pointer?.[k]) ? pointer[k] : null))
      .find((v) => v !== null);
    const shaNorm = sha !== undefined && sha.includes("/") ? basename(sha).replace(/\.json$/, "") : sha;
    if (!isStr(shaNorm)) {
      gap(
        `环境契约快照指针形态非法：${pointerPath}（未找到 snapshotSha256 / snapshot / path 字段）`,
        "指针形态权威 = resolve-external-contracts.mjs 产物（current 指针指向当前快照的派生指针，可重建）",
        `重跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${taskDir} --project-root ${projectRoot} --write 重建指针；快照手改或损坏的恢复动作是重跑 resolve，不手工修复`,
      );
    } else {
      const snapshotPath = join(taskDir, "environment-contracts", `${shaNorm}.json`);
      let snapshot = null;
      try {
        snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      } catch (e) {
        gap(
          `环境契约快照不可读：${snapshotPath}（${e.message}）`,
          "快照落点 = <taskDir>/environment-contracts/<snapshotSha256>.json（按哈希分文件、不覆盖旧快照）",
          `重跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${taskDir} --project-root ${projectRoot} --write 重建`,
        );
      }
      if (snapshot !== null) {
        if (!Array.isArray(snapshot.contracts)) {
          gap(
            `环境契约快照缺 contracts 数组：${snapshotPath}`,
            "快照结构权威 = resolve-external-contracts.mjs 产物（contracts[{id, status, resolvedPath, surfaces, aggregateHash}]）",
            `重跑 resolve --write 重建快照`,
          );
        } else {
          snapshotContracts = snapshot.contracts;
        }
      }
    }
  }

  // ③ D0 复扫（判定单一实现 = delivery-v6 scripts/lib/contract-rescan.mjs；D3 候选完成门与
  //    evaluate 侧共用）：重新运行完整候选探测（当前源码 + intent），不只看源码调用——
  //    unresolved 停回、strong 候选调用类（含蕴含观察类）必须映射到已声明 capability、
  //    实际使用的契约强制按 essential。判定数据（code + 参数字段）经 dev-flow 渲染器转文案
  const rescan = runContractRescan({ taskDir, projectRoot, acceptance, stage: "d0" });
  for (const e of rescan.errors) {
    gap(
      `D0 外部契约复扫未过：${renderRescanErrorDevFlow(e)}`,
      "复扫判定权威 = detect-external-contracts.mjs 候选快照 × 验收包 externalContracts / externalContractReview（设计 §4.2 D0 复扫规则 / §7.3 D0）",
      "按明细回 delivery-v6 修订验收包（递增验收版本重批）或修掉未登记外部调用 / unresolved 访问后重新编译——本地 re-export 穿透归因由探测线承担，本门只消费其输出",
    );
  }
  ctx.contractNotes = rescan.notes;

  // ④ essential 契约（声明 essential + 复扫强制升级）→ 权威快照必须 resolved
  const essentialIds = rescan.effectiveEssential;
  if (snapshotContracts !== null) {
    const resolvedIds = new Set(snapshotContracts.filter((c) => isRec(c) && isStr(c.id) && c.status === "resolved").map((c) => c.id));
    for (const id of essentialIds) {
      if (!resolvedIds.has(id)) {
        const st = snapshotContracts.find((c) => isRec(c) && c.id === id);
        gap(
          `essential 外部契约 ${id} 在当前环境快照中非 resolved（status=${isRec(st) ? String(st.status) : "缺该契约条目"}）——权威工件不可解析时不得进入实现`,
          "essential 契约必须有 resolved 权威快照（设计 §5.1 检查 3；解析规则与离线 fail-closed 见 §4.3）",
          `跑 node ~/.agents/skills/delivery-v6/scripts/resolve-external-contracts.mjs --task-dir ${taskDir} --project-root ${projectRoot} --write 重建；权威确实不可得时任务停在批准前或走 open-revision，不得伪造 resolved`,
        );
      }
    }
  }

  // ⑤⑥ essential 契约 → 契约冒烟增量在场 + 业务单元 DAG 传递闭包可达契约 spike 单元
  if (essentialIds.length > 0) {
    const smokeItems = (Array.isArray(increments?.items) ? increments.items : []).filter((it) => isRec(it) && it.kind === "contract-smoke");
    if (smokeItems.length === 0) {
      gap(
        `验收含 essential 外部契约（${essentialIds.join("、")}）但 increments.json 无 kind=contract-smoke 增量`,
        `契约冒烟增量的权威 = ${taskDir}/increments.json items[].kind="contract-smoke"（设计 §7.1：每个含 essential 契约的任务必须有一个契约冒烟增量）`,
        "回 delivery-v6 递增验收版本补契约冒烟增量（含 spike / final 两阶段计划），再回 tech-design-v6 T3 拆 spike 单元后重新编译",
      );
    }
    const spikeNodes = execPlan.nodes.filter((n) => n.kind === "dev" && n.unitKind === "contract-spike");
    if (spikeNodes.length === 0) {
      gap(
        `验收含 essential 外部契约（${essentialIds.join("、")}）但 impl-plan 无 kind=contract-spike 单元`,
        `契约 spike 单元的权威 = impl-plan units[].kind="contract-spike"（设计 §7.2 T3：契约 spike 必须是 DAG 首个可执行节点）`,
        "回 tech-design-v6 T3 拆分契约 spike 单元（最小可装载实现先跑，确认 API 形态 / 字段名 / 调用签名 / 回执通道）后重新编译",
      );
    } else {
      // DAG 拓扑复算：只看 increments 数组顺序不算满足——用依赖边复算「全部业务单元
      // （dev 节点且非 spike）传递闭包可达 spike 单元」（review 节点不是业务单元，不参与）
      const byId = new Map(execPlan.nodes.map((n) => [n.id, n]));
      const isSpike = (n) => n.kind === "dev" && n.unitKind === "contract-spike";
      const reachesSpike = (id, seen) => {
        if (seen.has(id)) return false; // 环由校验器拦，这里只保证终止
        seen.add(id);
        const n = byId.get(id);
        if (n === undefined) return false;
        if (isSpike(n)) return true;
        for (const d of isStrArr(n.deps) ? n.deps : []) {
          if (reachesSpike(d, seen)) return true;
        }
        return false;
      };
      const unreached = execPlan.nodes
        .filter((n) => n.kind === "dev" && !isSpike(n) && !reachesSpike(n.id, new Set()))
        .map((n) => n.id);
      if (unreached.length > 0) {
        gap(
          `业务单元 DAG 未依赖契约 spike 单元：${unreached.join("、")}——只看 increments 数组顺序不算满足（契约 spike 失败时业务实现不得先行展开）`,
          `DAG 依赖权威 = impl-plan units[].deps（设计 §7.1：归属业务增量的全部单元必须显式依赖契约 spike 单元，D0 复算拓扑）`,
          "回 tech-design-v6 T3 给这些单元补指向契约 spike 单元（直接或经中间单元传递）的 deps 后重新编译",
        );
      }
    }
  }
}

// ── 主流程 ──

function parseArgs(argv) {
  const opts = { implPlan: null, mode: "dev", taskDir: null, check: false, replay: null, reinit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--impl-plan") opts.implPlan = argv[++i];
    else if (a === "--mode") {
      opts.mode = argv[++i];
      if (opts.mode !== "dev" && opts.mode !== "acceptance") failUsage(`--mode 只接受 dev|acceptance，收到：${opts.mode}`);
    } else if (a === "--task-dir") {
      opts.taskDir = argv[++i];
      if (!opts.taskDir || opts.taskDir.startsWith("--")) failUsage("--task-dir 须带交付任务目录参数");
    } else if (a === "--check") opts.check = true;
    else if (a === "--replay-compare") {
      opts.replay = argv[++i];
      if (!opts.replay || opts.replay.startsWith("--")) failUsage("--replay-compare 须带旧 exec-plan 路径参数");
    } else if (a === "--reinit") opts.reinit = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        [
          "用法：node compile-exec-plan.mjs --impl-plan <path>.impl-plan.json [--mode dev|acceptance] [--task-dir <交付任务目录>] [--check] [--replay-compare <旧 exec-plan 路径>] [--reinit]",
          "  --impl-plan       impl-plan.json 路径（唯一计划权威；渲染字段权威 = tech-design-v6/references/impl-plan-mapping.md）",
          "  --mode            dev（缺省：exec-plan + 任务书 + 初始 status.json）| acceptance（在其上填验收节点与 wrapper；前置 dev 编译已完成）",
          "  --task-dir        交付体系任务的交付任务目录（读 increments.json 做增量归属断言；增量契约与验收绑定核对在写盘前执行）",
          "  --check           防手改比对（exec-plan 深比较 + promptFile 逐字节；status.json 跳过；wrapper 委托 gen-acceptance-wrapper --check）",
          "  --replay-compare  历史只读重放：按旧 exec-plan 的 mode 重新生成（不写盘）并逐字段比对报告",
          "  --reinit          dev 重编译时显式确认重置已有执行进度（status.json 含非 pending 节点时缺省拒绝）",
          "",
          "退出码：0 成功 / PASS / 重放完成；1 语义缺口或校验 FAIL（全体不生成）；2 用法错误。",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else failUsage(`未知参数「${a}」（--help 查看完整用法）`);
  }
  if (!opts.implPlan) failUsage("缺必填参数 --impl-plan");
  if (opts.check && opts.replay) failUsage("--check 与 --replay-compare 互斥（一个只读会话只做一种比对）");
  if (opts.reinit && (opts.check || opts.replay)) failUsage("--reinit 是写盘操作确认，与只读的 --check / --replay-compare 不相容");
  if (opts.reinit && opts.mode !== "dev") failUsage("--reinit 只作用于 dev 编译（acceptance 模式不重写 status.json，无进度可重置）");
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projectRoot = gitToplevel();
  const loaded = loadImplPlan(opts.implPlan);
  if (loaded.plan !== null) runRenderCheck(loaded.planPath);
  if (gaps.length > 0) {
    printGaps();
    process.exit(1);
  }
  const plan = loaded.plan;
  const planPath = loaded.planPath;
  const skillVersion = readSkillVersion();
  if (skillVersion === null) {
    gap(`无法读取 dev-flow-v6 SKILL.md frontmatter version（${SKILL_MD}）`, "exec-plan.skillVersion 的权威 = dev-flow-v6/SKILL.md frontmatter（读文件实值，不凭记忆写）", "确认技能安装形态（skill 目录与 SKILL.md 同在）后重跑");
  }
  const address = detectAddress(projectRoot);
  const name = isStr(plan.name) ? plan.name.trim() : null;
  if (name === null) {
    gap("impl-plan.json 缺 name（非空字符串）", `计划名权威 = ${planPath} name（渲染器必填字段——渲染门应先拦；若到达此处说明渲染视图与 JSON 脱同步）`, "回 tech-design-v6 T3 补 name 后重跑渲染器与编译器");
  }
  if (gaps.length > 0) {
    printGaps();
    process.exit(1);
  }

  // 产物根：dev-flow 段寻址（双形态；worktreeName 只在 workspace 形态出现）
  const productRoot = address.form === "workspace"
    ? join(homedir(), ".agents", "skill-data", "dev-flow", address.slug, address.worktreeName)
    : join(homedir(), ".agents", "skill-data", "dev-flow", address.slug);
  const promptsDir = join(productRoot, `${name}.prompts`);
  const runlogDir = join(productRoot, `${name}.runlog`);

  // designDocPath：designDoc 指向设计目录，渲染视图 = <目录>.rendered.md（designDoc 已带
  // .rendered.md 后缀时原样——防御异形态）
  const designDoc = expandHome(isStr(plan.designDoc) ? plan.designDoc : "");
  const designDocPath = designDoc.endsWith(".rendered.md") ? designDoc : `${designDoc}.rendered.md`;

  // 交付体系任务：读 increments.json（增量归属断言数据源）与 acceptance.json（外部契约门 /
  // runtime-probe 能力对账 / 验收绑定核对共用）；task.json 的 deliveryProfile（设计 §13）
  let increments = null;
  let acceptance = null;
  let taskDirAbs = null;
  let deliveryProfile = "b";
  if (opts.taskDir) {
    taskDirAbs = abs(opts.taskDir);
    try {
      increments = JSON.parse(readFileSync(join(taskDirAbs, "increments.json"), "utf8"));
    } catch (e) {
      gap(`交付任务目录 increments.json 不可读：${join(taskDirAbs, "increments.json")}（${e.message}）`, "increments.json 由 delivery-v6 验收设计产出、随验收包批准冻结（增量归属断言与 --task-dir 校验的数据源）", "核对 --task-dir 指向 delivery-v6 产出的交付任务目录后重跑；独立设计任务去掉 --task-dir");
    }
    try {
      acceptance = JSON.parse(readFileSync(join(taskDirAbs, "acceptance.json"), "utf8"));
    } catch (e) {
      gap(
        `无法读取交付任务目录 acceptance.json：${join(taskDirAbs, "acceptance.json")}（${e.message}）——验收绑定 / 外部契约门 / runtime-probe 对账均缺输入`,
        "acceptance.json 由 delivery-v6 验收设计产出（已批准版本；顶层 externalContracts / externalContractReview 是外部契约守门的声明层）",
        "核对 --task-dir 指向 delivery-v6 产出的交付任务目录后重新编译",
      );
    }
    // deliveryProfile（设计 §13 任务分级）：task.json 由 gate init / set-delivery-profile user
    // 命令写入；读不到字段缺省 b。值非法 / 文件损坏报缺口——静默缺省会改变 D2 审查深度
    const taskMetaPath = join(taskDirAbs, "task.json");
    if (existsSync(taskMetaPath)) {
      try {
        const taskMeta = JSON.parse(readFileSync(taskMetaPath, "utf8"));
        const dp = isRec(taskMeta) ? taskMeta.deliveryProfile : undefined;
        if (dp === undefined || dp === null) deliveryProfile = "b";
        else if (dp === "a" || dp === "b" || dp === "c") deliveryProfile = dp;
        else {
          gap(
            `task.json deliveryProfile 值非法（实际：${showVal(dp)}）`,
            "deliveryProfile 权威枚举 = a|b|c（设计 §13；只能由 gate init 参数或 set-delivery-profile user 命令写入 task 元数据，禁直改 task.json）",
            "跑 delivery-v6 set-delivery-profile 修正后重新编译",
          );
        }
      } catch (e) {
        gap(
          `task.json 不可读或不是合法 JSON：${taskMetaPath}（${e.message}）`,
          "deliveryProfile 的权威载体 = 交付任务目录 task.json（gate init / set-delivery-profile 写入）",
          "修复 task.json（或重跑 set-delivery-profile）后重新编译",
        );
      }
    }
  }

  // 关联声明：存在但非数组 = 上游契约形态错误，报缺口不静默当空（静默丢关联声明会让
  // co-change 防线失效——校验器只在字段在场时对账，字段被静默丢弃等于从未声明）
  if (plan.associations !== undefined && !Array.isArray(plan.associations)) {
    gap(
      `associations 存在但不是数组（实际：${showVal(plan.associations)}）`,
      `关联声明权威 = ${planPath} associations[]（三类关联：contract/registry/build-artifact；不声明时删除该字段或写空数组）`,
      `回 tech-design-v6 T3 修正 associations 为数组形态后重新渲染、重新编译`,
    );
  }

  // dev 重编译检查：盘上 status.json 含非 pending 节点 = 已有执行进度——重初始化会清零
  // status/runlog/ledger 的执行记录，缺省拒绝；--reinit 是唯一显式确认通道（已有进度的
  // 正常修订路径 = 手修 exec-plan + ledger 登记，见 flow/compile.md 校验门路由）
  const statusPath = join(productRoot, `${name}.status.json`);
  if (opts.mode === "dev" && !opts.check && !opts.replay && !opts.reinit && existsSync(statusPath)) {
    let priorStatus = null;
    let parseError = null;
    try {
      priorStatus = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch (e) {
      parseError = e.message;
    }
    const progressed =
      priorStatus !== null &&
      isRec(priorStatus) &&
      Object.values(priorStatus.nodes ?? {}).some((n) => isRec(n) && (n.status !== "pending" || (typeof n.attempts === "number" && n.attempts > 0)));
    if (progressed || parseError !== null) {
      gap(
        parseError !== null
          ? `dev 重编译命中已有 status.json 但其不是合法 JSON（${statusPath}，解析错误：${parseError}）——执行态载体损坏`
          : `dev 重编译命中已有执行进度：${statusPath} 存在非 pending 节点（重初始化会清零 status/runlog/ledger 的执行记录）`,
        "status.json 是执行态唯一事实源（设计 §4：仅 D0 初始化生成，执行后由合法转移与对账更新）",
        `确认放弃执行进度才带 --reinit 重置（node ${SCRIPT_PATH} --impl-plan ${planPath} --reinit）；保留进度的修订走手修 exec-plan 对应字段 + ledger 登记（flow/compile.md 校验门路由）；status.json 损坏先按 flow/execute.md 断点恢复程序对账（冲突以 git 为准）`,
      );
    }
  }

  const ctx = { plan, planPath, projectRoot, productRoot, promptsDir, runlogDir, name, designDocPath, taskDir: taskDirAbs, increments, acceptance, deliveryProfile, mode: opts.mode, skillVersion };

  // dev 部分（两种模式共用——acceptance exec-plan 顶层保留 dev/review 节点与全部 dev 期字段）
  const dev = buildDevNodes(ctx);
  if (plan.units.length === 0) {
    gap("impl-plan.json units 为空数组", `单元清单权威 = ${planPath} units[]（exec-plan 顶层 nodes 必须非空）`, "回 tech-design-v6 T3 拆分实施单元后重新编译");
  }

  // exec-plan 主体
  const baseline = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
  const headHash = String(baseline.stdout || "").trim();
  if (baseline.status !== 0 || !/^[0-9a-f]{7,40}$/i.test(headHash)) {
    gap(`git rev-parse HEAD 失败（${projectRoot}）：${String(baseline.stderr || "").trim()}`, "exec-plan.baseline = 编译时点 git rev-parse HEAD（执行输入快照）", "确认项目至少有一个 commit 后重跑");
  }
  const fullSuite = normalizeCommand(plan.testPlan?.fullSuite, TEST_PLAN_WHITELIST);
  if (fullSuite === null) {
    gap(`testPlan.fullSuite 形态非法（实际：${showVal(plan.testPlan?.fullSuite)}）`, `全量命令权威 = ${planPath} testPlan.fullSuite（string 或 {program, args}）`, "回 tech-design-v6 T3 修正形态后重新渲染、重新编译");
  }
  const execPlan = {
    version: 1,
    skillVersion,
    mode: opts.mode,
    projectRoot,
    ...(address.form === "workspace" ? { workspaceRoot: address.workspaceRoot } : {}),
    planPath,
    designDocPath,
    baseline: headHash,
    statusPath: join(productRoot, `${name}.status.json`),
    testPlan: {
      ...(fullSuite ? { fullSuite } : {}),
      ...(isStr(plan.testPlan?.incremental) ? { incremental: plan.testPlan.incremental } : {}),
      ...(Array.isArray(plan.testPlan?.fullSuiteChecks) ? { fullSuiteChecks: plan.testPlan.fullSuiteChecks } : {}), // 视图归因参考，原样转抄
      ...(Array.isArray(plan.testPlan?.artifacts) ? { artifacts: plan.testPlan.artifacts.map((a) => ({ id: a?.id, command: normalizeCommand(a?.command, TEST_PLAN_WHITELIST) ?? a?.command })) } : {}),
    },
    commitTemplate: isStr(plan.commitTemplate) ? plan.commitTemplate : COMMIT_TEMPLATE_DEFAULT,
    // deliveryProfile（设计 §13；交付体系任务才登记）：a 级 D2 一致性审查分区降档的消费
    // 输入（W3 dev-consistency-loop-v6 按本字段 + units[].kind 过滤契约相关分区）。
    // 变更后需重编译生效（已有执行进度时手修本字段 + ledger 登记，同其它 exec-plan 字段纪律）
    ...(taskDirAbs ? { deliveryProfile } : {}),
    nodes: dev.nodes,
    ...(taskDirAbs ? { processReviewPath: join(taskDirAbs, "process-review.jsonl") } : {}),
    ...(Array.isArray(plan.associations) ? { associations: plan.associations } : {}),
    acceptance: opts.mode === "acceptance" ? null : { nodes: [], groups: { core: [], nonCore: [] } }, // D3 实例化前空壳（现行兼容字段）
    ...(Array.isArray(plan.formNotApplicable) ? { formNotApplicable: plan.formNotApplicable } : {}),
    generatedBy: {
      generator: "compile-exec-plan.mjs",
      generatorVersion: GENERATOR_VERSION,
      inputSha256: sha256Text(loaded.rawText),
      command: `node ${SCRIPT_PATH} --impl-plan ${planPath} --mode ${opts.mode}${taskDirAbs ? ` --task-dir ${taskDirAbs}` : ""}`,
    },
  };

  // acceptance 部分
  let acc = { nodes: [], prompts: new Map(), wrapperAssets: [], probeAssets: [], skippedRows: 0 };
  if (opts.mode === "acceptance") {
    // 前置读取按实际形态区分报缺（不存在 = 未跑 dev 编译；坏 JSON = 执行态载体损坏——
    // 两者恢复动作不同，合并成「不存在」会把损坏误报成缺前置）
    let statusData = null;
    if (!existsSync(statusPath)) {
      gap(
        `acceptance 编译前置未满足：dev 模式初始 status.json 不存在（${statusPath}）`,
        "acceptance 编译在 dev 编译产物之上进行（设计 §8 第三步：先生成 dev，验收资产就绪后再生成 acceptance）",
        `先运行 dev 模式编译：node ${SCRIPT_PATH} --impl-plan ${planPath}${taskDirAbs ? ` --task-dir ${taskDirAbs}` : ""}`,
      );
    } else {
      try {
        statusData = JSON.parse(readFileSync(statusPath, "utf8"));
      } catch (e) {
        gap(
          `acceptance 编译前置未满足：dev 模式初始 status.json 不是合法 JSON（${statusPath}，解析错误：${e.message}）——执行态载体损坏`,
          "status.json 是执行态唯一事实源；new 态资产就绪判定（实装单元 done）依赖它",
          "先按 flow/execute.md 断点恢复程序对账修复（冲突以 git 为准），或确认放弃进度后重跑 dev 编译 --reinit，再跑 acceptance 编译",
        );
      }
    }
    ctx.statusData = statusData;
    acc = buildAcceptanceNodes(ctx);
    execPlan.acceptance = { nodes: acc.nodes, groups: { core: [], nonCore: [] } }; // groups 为旧 exec-plan 兼容字段（退役语义，引擎忽略）
  }

  // --task-dir 增量契约与验收绑定核对前移（写盘前）：归属不全 / 绑定陈旧在此拦下，
  // 与其余语义缺口同通道输出，全体不生成（quality 段仍由写盘后真校验器承担）
  checkTaskDirContract(execPlan, ctx);

  // 写盘前统一出口：语义缺口全量报告，全体不生成
  if (gaps.length > 0) {
    printGaps();
    process.exit(1);
  }

  // 写盘前同口径预检（import check-exec-plan 的 checkPlan——与写盘后 spawn 真校验器零漂移）
  const pre = checkPlan(execPlan);
  if (!pre.ok) {
    process.stderr.write(
      [
        `编译预检未过（check-exec-plan 同口径，共 ${pre.errors.length} 条）——生成中止，未写任何文件。`,
        ...pre.errors.map((e) => `FAIL: ${e.category}: ${e.message}`),
        "处置路由见 flow/compile.md 校验门一节；值转抄自 impl-plan 的字段（testCommand / deps / 单元 id / territory）须回上游修。",
      ].join("\n") + "\n",
    );
    process.exit(1);
  }

  // --check / --replay-compare：只读出口
  if (opts.check) runCheckMode(ctx, execPlan, opts.mode === "acceptance" ? new Map([...dev.prompts, ...acc.prompts]) : dev.prompts);
  if (opts.replay) runReplayCompare(ctx, execPlan, opts.replay);

  // ── 写盘（acceptance 模式不重写 status.json / runlog / ledger——执行进度不可重置） ──

  const execPath = join(productRoot, `${name}.exec-plan.json`);
  try {
    mkdirSync(productRoot, { recursive: true });
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(execPath, `${JSON.stringify(execPlan, null, 2)}\n`);
    const allPrompts = opts.mode === "acceptance" ? new Map([...dev.prompts, ...acc.prompts]) : dev.prompts;
    // 声明了外部 promptFile 的 review 节点不在生成集内——清理生成目录中的陈旧生成件
    //（节点已删除/改声明后残留的生成任务书）；外部声明的文件不在本目录，不受影响
    const generatedNames = new Set([...allPrompts.keys()].map((p) => basename(p)));
    if (existsSync(promptsDir)) {
      for (const f of readdirSync(promptsDir)) {
        if (f.endsWith(".md") && !generatedNames.has(f)) rmSync(join(promptsDir, f));
      }
    }
    for (const [p, text] of allPrompts) writeFileSync(p, text);
    if (opts.mode === "acceptance") {
      if (!materializeWrappers(ctx, acc.wrapperAssets, planPath)) {
        printGaps();
        process.exit(1);
      }
      if (!materializeProbeWrappers(ctx, acc.probeAssets, planPath)) {
        printGaps();
        process.exit(1);
      }
    } else {
      mkdirSync(runlogDir, { recursive: true });
      const ledgerPath = join(productRoot, `${name}.ledger.md`);
      if (!existsSync(ledgerPath)) {
        writeFileSync(ledgerPath, `# ${name} 未决事项与裁决处置档案——引擎终态与主 agent 处置记录追加于此\n`);
      }
      const nodesStatus = {};
      for (const n of execPlan.nodes) nodesStatus[n.id] = { status: "pending", attempts: 0 };
      const status = {
        name,
        baseline: headHash,
        updated: new Date().toISOString(),
        skillVersion,
        nodes: nodesStatus,
        events: [],
      };
      writeFileSync(join(productRoot, `${name}.status.json`), `${JSON.stringify(status, null, 2)}\n`);
    }
  } catch (e) {
    gap(`产物写盘失败：${e.message}`, `产物落点 = dev-flow 段产物根（${productRoot}，寻址形态 ${address.form}）`, "排除文件系统故障后重新运行编译命令（生成幂等覆盖）");
    printGaps();
    process.exit(1);
  }

  // 写盘后 spawn 真校验器（生成即校验门；--task-dir 透传 quality 段——增量契约与验收绑定
  // 已前移写盘前，透传段的重跑对同数据只可能复绿，quality 段是新核对）
  const checkArgs = [CHECK_EXEC_PLAN, execPath];
  if (taskDirAbs) checkArgs.push("--task-dir", taskDirAbs);
  const checked = spawnSync(process.execPath, checkArgs, { encoding: "utf8" });
  if (checked.status !== 0) {
    // 预检（checkPlan）已拦静态错误，此处 FAIL 只可能来自依赖盘上路径的核对（quality 段）
    // 或上游数据在编译窗口内变化——按「上游语义缺口」路由，不吞不谎报为实现缺陷
    const failText = String(checked.stdout || checked.stderr || "").trim();
    process.stderr.write(
      [
        "编译产物校验未过（check-exec-plan.mjs）——属上游语义缺口，按分类路由处置：",
        "",
        failText,
        "",
        "恢复动作：按 FAIL 分类回上游修正后重新运行编译命令（quality → 回 tech-design-v6 T2 修设计包 s4-accept.json 的 criterionMechanisms / verificationBindings；",
        `其余分类见 flow/compile.md 校验门路由表）。exec-plan 已写盘（${execPath}），上游修复后重编译幂等覆盖；`,
        "防手改核对不受影响（--check 以重生成结果比对）。",
      ].join("\n") + "\n",
    );
    process.exit(1);
  }

  // 索引重建（每次 exec-plan 生成后重建——设计 §5.2；dev 与 acceptance 两次编译时点各一次）：
  // verification-index.json 落 exec-plan 同目录（禁手改；rebuildCommand 字段即重建命令）。
  // 构建失败按语义缺口上报不吞——exec-plan 已落盘且校验 PASS，恢复 = 修索引输入后重编译
  //（或直接重跑 build 命令），不回滚 exec-plan
  const indexRun = spawnSync(process.execPath, [VERIFY_INDEX_SCRIPT, "build", "--exec-plan", execPath], { encoding: "utf8" });
  let indexNote = null;
  if (indexRun.status !== 0) {
    process.stderr.write(
      [
        `索引构建失败（verification-index.mjs build exit ${indexRun.status}）——exec-plan 已落盘且校验 PASS，索引未更新`,
        "",
        String(indexRun.stderr || indexRun.stdout || "").trim(),
        "",
        `权威源：verification-index.json 由 verification-index.mjs build 子命令生成（禁手改）。`,
        `恢复动作：按索引错误回上游修正输入后重新编译；或直接重跑 node ${VERIFY_INDEX_SCRIPT} build --exec-plan ${execPath}`,
      ].join("\n") + "\n",
    );
    process.exit(1);
  } else {
    indexNote = String(indexRun.stdout || "").trim().split("\n")[0];
  }

  // 编译摘要
  const devCount = execPlan.nodes.filter((n) => n.kind === "dev").length;
  const reviewCount = execPlan.nodes.filter((n) => n.kind === "review").length;
  const waves = [...new Set(execPlan.nodes.filter((n) => n.kind === "dev").map((n) => n.wave))].sort((a, b) => a - b);
  const lines = [
    `编译完成（mode=${opts.mode}）→ ${execPath}`,
    `  dev 单元 ${devCount} 个（wave ${waves.join("/") || "-"}）；过程审查节点 ${reviewCount} 个；校验器 PASS`,
  ];
  if (indexNote !== null) lines.push(`  ${indexNote}`);
  if (Array.isArray(ctx.contractNotes) && ctx.contractNotes.length > 0) {
    for (const note of ctx.contractNotes) lines.push(`  外部契约披露：${note}`);
  }
  if (dev.noDesignRefUnits.length > 0) {
    lines.push(`  警告：${dev.noDesignRefUnits.length} 个单元未登记 units[].designRef（任务书缺设计章节锚）：${dev.noDesignRefUnits.join("、")}——建议回 impl-plan 补登记`);
  }
  if (opts.mode === "acceptance") {
    lines.push(`  验收节点：verify ${acc.nodes.filter((n) => n.kind === "verify").length} / inspect ${acc.nodes.filter((n) => n.kind === "inspect").length}；未编译行（L0/L1/L2，D1/D2 已覆盖）${acc.skippedRows} 行`);
    if (acc.wrapperAssets.length > 0) lines.push(`  wrapper ${acc.wrapperAssets.length} 个（gen-acceptance-wrapper 生成，落 ${join(productRoot, `${name}.verify`)}/）`);
    if (acc.probeAssets.length > 0) lines.push(`  runtime-probe wrapper ${acc.probeAssets.length} 个（gen-runtime-probe-wrapper 生成，落 ${join(taskDirAbs, "evidence", "runtime-probes")}/）`);
    lines.push(`  D3 发起前跑校验门：node ${CHECK_EXEC_PLAN} ${join(productRoot, `${name}.exec-plan.json`)}`);
    if (taskDirAbs) lines.push(`  D3 全绿后、D4 候选完成前跑外部契约复扫门：node ${join(SCRIPT_DIR, "check-contract-rescan.mjs")} --task-dir ${taskDirAbs} --project-root ${projectRoot} --exec-plan ${join(productRoot, `${name}.exec-plan.json`)} --stage d3`);
  } else {
    lines.push(`  初始 status.json / runlog / ledger 已初始化；防手改核对：node ${SCRIPT_PATH} --impl-plan ${planPath} --check${taskDirAbs ? ` --task-dir ${taskDirAbs}` : ""}`);
    lines.push(`  验收资产就绪后跑 acceptance 编译：node ${SCRIPT_PATH} --impl-plan ${planPath} --mode acceptance${taskDirAbs ? ` --task-dir ${taskDirAbs}` : ""}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

// 直跑入口判定按 realpath 比对（check-exec-plan.mjs 同款：技能经 symlink 安装时 argv[1] 是
// symlink 路径而 import.meta.url 是真实路径，直比会失配、CLI 静默不执行）
function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export { normalizeCommand, computeWaves, detectAddress, expandHome, NODE_PROJECT_ADDRESS_PROBE };

if (isMainEntry()) main();
