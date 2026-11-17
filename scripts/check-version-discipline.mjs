#!/usr/bin/env node
// check-version-discipline.mjs — 技能版本纪律检查器（设计 AX3 的强制器）
//
// 三条规则（bump 判定口径全设计统一，与设计 D2 一致）：
//   规则 1（bump 对账）：staged 触及技能自有文件（tech-design-wf/、dev-flow-wf/ 与
//     delivery-wf/ 目录下全部文件：SKILL.md / flow / agents / references / 技能 scripts），
//     对应技能 frontmatter version 必须在同一次提交中 bump（staged 值 ≠ HEAD 值）。
//     文档类改动无产物 diff，但直接驱动手工路径行为，同规则覆盖。
//   规则 2（共享源联动）：staged 含 workflows/src/ 改动时，以产物逐字节 diff 判定——
//     产物（skills/self/dev-workflow/workflows/ 下除 src/ 外的全部文件）与 HEAD 逐字节
//     相同 → 豁免（共享构建源的唯一行为出口是产物，纯注释改动零产物 diff）；产物有变 →
//     全部技能联动要求 bump（每个 frontmatter 都须 bump）。
//   规则 3（版本戳一致性）：产物内嵌 SKILL_VERSION 必须等于对应技能 frontmatter 当前值
//     （拦 bump 后忘重建）。检查器直接读两侧值比对，不改 scripts/build-workflows.mjs。
//
// 判定对象 = git 索引（即将提交的内容，与 HEAD 比较），不看工作区未暂存改动——提交门
// 只对「这次提交会写进历史的内容」负责，并行会话的在途改动不参与判定。
//
// 用法：node scripts/check-version-discipline.mjs [--root <仓库根>]
//   缺省仓库根 = 本脚本所在仓库根；--root 供 fixture 测试指向临时仓库。
// 退出码：0 = 通过（含无相关改动）；1 = 违规；2 = 环境错误（非 git 仓库 / 版本权威源缺失）

import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "用法：node scripts/check-version-discipline.mjs [--root <仓库根>]";
const SCRIPT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function failEnv(message) {
  console.error(`[version-discipline] ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  let root = SCRIPT_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) failEnv(`--root 缺参数值。${USAGE}`);
      root = resolve(value);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      failEnv(`未知参数 ${arg}。${USAGE}`);
    }
  }
  return root;
}

const ROOT = parseArgs(process.argv.slice(2));

function git(args) {
  const r = spawnSync("git", ["-C", ROOT, ...args], { maxBuffer: 32 * 1024 * 1024 });
  if (r.error) failEnv(`git 无法执行（${r.error.message}）——确认 git 已安装后重试`);
  return r;
}

function gitText(args) {
  const r = git(args);
  if (r.status !== 0) {
    failEnv(`git ${args.join(" ")} 失败（退出码 ${r.status}）：${r.stderr.toString("utf8").trim()}`);
  }
  return r.stdout.toString("utf8");
}

/** 读 git 对象（":path" = 索引内容，"HEAD:path" = 上次提交内容）；不存在返回 null */
function gitBlob(spec) {
  const r = git(["show", spec]);
  return r.status === 0 ? r.stdout : null;
}

function blobsEqual(a, b) {
  if (a === null || b === null) return a === b;
  return Buffer.compare(a, b) === 0;
}

const repoCheck = git(["rev-parse", "--is-inside-work-tree"]);
if (repoCheck.status !== 0 || repoCheck.stdout.toString("utf8").trim() !== "true") {
  failEnv(`--root 指向的目录不是 git 工作仓库：${ROOT}——确认指向 zsw-skills 仓库根（或 fixture 仓库根）后重试`);
}

// ── 技能 ↔ 自有文件目录 / 产物 ↔ 技能 映射 ──
// 登记范围 = 现行代技能（V4 冻结 / V5 内核线 / V6 结构化线）。V1-V3 代技能已归档（仓库根
// .archived/<技能名>/，不入版本库），不参与版本纪律；design-code-sync 两引擎跨代共用，产物归属
// dev-flow-v5（见 PRODUCT_SKILL）。归档代复活时在此重新登记
const SKILLS = [
  { name: "tech-design-v4", dir: "skills/self/dev-workflow/tech-design-v4" },
  { name: "dev-flow-v4", dir: "skills/self/dev-workflow/dev-flow-v4" },
  { name: "delivery-v4", dir: "skills/self/dev-workflow/delivery-v4" },
  { name: "tech-design-v5", dir: "skills/self/dev-workflow/tech-design-v5" },
  { name: "dev-flow-v5", dir: "skills/self/dev-workflow/dev-flow-v5" },
  { name: "delivery-v5", dir: "skills/self/dev-workflow/delivery-v5" },
  { name: "tech-design-v6", dir: "skills/self/dev-workflow/tech-design-v6" },
  { name: "dev-flow-v6", dir: "skills/self/dev-workflow/dev-flow-v6" },
  { name: "delivery-v6", dir: "skills/self/dev-workflow/delivery-v6" },
];
const WORKFLOWS = "skills/self/dev-workflow/workflows";
const SHARED_SRC_PREFIX = `${WORKFLOWS}/src/`;
// 产物 → 所属技能。权威映射见 scripts/build-workflows.mjs 的 SKILL_VERSION_SOURCES；
// 新增 workflow 产物时两处同步登记，否则规则 3 无版本戳可对账
const PRODUCT_SKILL = {
  // design-code-sync 两引擎跨代共用（V4/V5/V6 在用），归属 dev-flow-v6
  // （原登记 dev-flow-v1，随 V1 代归档改归现行执行线）
  "design-code-sync-loop.dwf.ts": "dev-flow-v6",
  "pi/design-code-sync-loop.js": "dev-flow-v6",
  "design-code-sync-v2.dwf.ts": "dev-flow-v6",
  "pi/design-code-sync-v2.js": "dev-flow-v6",
  "tech-review-loop-v4.dwf.ts": "tech-design-v4",
  "pi/tech-review-loop-v4.js": "tech-design-v4",
  "wave-executor-v4.dwf.ts": "dev-flow-v4",
  "pi/wave-executor-v4.js": "dev-flow-v4",
  "dev-consistency-loop-v4.dwf.ts": "dev-flow-v4",
  "pi/dev-consistency-loop-v4.js": "dev-flow-v4",
  "acceptance-design-v4.dwf.ts": "delivery-v4",
  "pi/acceptance-design-v4.js": "delivery-v4",
  "candidate-build-v4.dwf.ts": "delivery-v4",
  "pi/candidate-build-v4.js": "delivery-v4",
  "independent-assurance-v4.dwf.ts": "delivery-v4",
  "pi/independent-assurance-v4.js": "delivery-v4",
  "assurance-repair-loop-v4.dwf.ts": "delivery-v4",
  "pi/assurance-repair-loop-v4.js": "delivery-v4",
  "tech-review-loop-v5.dwf.ts": "tech-design-v5",
  "pi/tech-review-loop-v5.js": "tech-design-v5",
  "wave-executor-v5.dwf.ts": "dev-flow-v5",
  "pi/wave-executor-v5.js": "dev-flow-v5",
  "dev-consistency-loop-v5.dwf.ts": "dev-flow-v5",
  "pi/dev-consistency-loop-v5.js": "dev-flow-v5",
  "acceptance-design-v5.dwf.ts": "delivery-v5",
  "pi/acceptance-design-v5.js": "delivery-v5",
  "candidate-build-v5.dwf.ts": "delivery-v5",
  "pi/candidate-build-v5.js": "delivery-v5",
  "independent-assurance-v5.dwf.ts": "delivery-v5",
  "pi/independent-assurance-v5.js": "delivery-v5",
  "assurance-repair-loop-v5.dwf.ts": "delivery-v5",
  "pi/assurance-repair-loop-v5.js": "delivery-v5",
  "tech-review-loop-v6.dwf.ts": "tech-design-v6",
  "pi/tech-review-loop-v6.js": "tech-design-v6",
  "wave-executor-v6.dwf.ts": "dev-flow-v6",
  "pi/wave-executor-v6.js": "dev-flow-v6",
  "dev-consistency-loop-v6.dwf.ts": "dev-flow-v6",
  "pi/dev-consistency-loop-v6.js": "dev-flow-v6",
  "acceptance-design-v6.dwf.ts": "delivery-v6",
  "pi/acceptance-design-v6.js": "delivery-v6",
  "candidate-build-v6.dwf.ts": "delivery-v6",
  "pi/candidate-build-v6.js": "delivery-v6",
  "independent-assurance-v6.dwf.ts": "delivery-v6",
  "pi/independent-assurance-v6.js": "delivery-v6",
  "assurance-repair-loop-v6.dwf.ts": "delivery-v6",
  "pi/assurance-repair-loop-v6.js": "delivery-v6",
};
const STAMP_RE = /const SKILL_VERSION = "([^"]*)";/;
const VERSION_RE = /^version:\s*(\d+\.\d+\.\d+)\s*$/m;

/** frontmatter version（唯一权威）；缺失 / 非 semver → null */
function readVersion(blob) {
  if (!blob) return null;
  const text = blob.toString("utf8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(VERSION_RE);
  return m ? m[1] : null;
}

function listNullSeparated(args) {
  return gitText(args).split("\0").filter(Boolean);
}

const stagedFiles = listNullSeparated(["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"]);
const isProduct = (p) => p.startsWith(`${WORKFLOWS}/`) && !p.startsWith(SHARED_SRC_PREFIX);

const versions = new Map();
for (const skill of SKILLS) {
  const skillMd = `${skill.dir}/SKILL.md`;
  const headVersion = readVersion(gitBlob(`HEAD:${skillMd}`));
  const stagedVersion = readVersion(gitBlob(`:${skillMd}`));
  if (headVersion === null && stagedVersion === null) {
    failEnv(
      `技能版本权威源缺失：${skillMd}（HEAD 与索引均无可用 version）——确认 --root 指向 zsw-skills 仓库根；` +
        `若本次提交删除该技能，请同步更新本检查器的技能清单`,
    );
  }
  versions.set(skill.name, { headVersion, stagedVersion, bumped: stagedVersion !== null && stagedVersion !== headVersion });
}

const violations = [];
const notes = [];

// ── 规则 1：bump 对账 ──
for (const skill of SKILLS) {
  const touched = stagedFiles.filter((p) => p.startsWith(`${skill.dir}/`)).sort();
  if (touched.length === 0) continue;
  const v = versions.get(skill.name);
  if (v.bumped) continue;
  const change =
    v.stagedVersion === null
      ? `staged 内容中 frontmatter version 缺失或非 semver 形态（HEAD ${v.headVersion}）`
      : `frontmatter version 未 bump（HEAD ${v.headVersion} → staged ${v.stagedVersion}）`;
  violations.push({
    title: `规则 1（bump 对账）：技能自有文件有 staged 改动，但 frontmatter version 未 bump`,
    details: [
      `技能：${skill.name}`,
      change,
      `权威源：${skill.dir}/SKILL.md frontmatter version（该技能版本唯一权威）`,
      `触及的技能自有文件（${touched.length}）：`,
      ...touched.map((p) => `  - ${p}`),
    ],
    recovery:
      `把 ${skill.dir}/SKILL.md frontmatter 的 version 升号后重新 git add 再提交：` +
      `PATCH = 修复与措辞、MINOR = 行为新增（新参数 / 新阶段）、MAJOR = 数据契约变更（须同时升 schemaVersion 并重建产物）`,
  });
}

// ── 规则 2：共享源联动（产物逐字节 diff） ──
// 共享层文件（skill-data/observability/provenance.shared.ts）拼入全部产物——变化要求全技能联动；
// 单 workflow 独享源（<name>.shared.ts 及其模板）只影响本 workflow 产物——只要求产物所属技能 bump。
const SHARED_LAYER_FILES = new Set([
  "skill-data.shared.ts",
  "observability.shared.ts",
  "provenance.shared.ts",
]);
const sharedTouched = stagedFiles.filter((p) => p.startsWith(SHARED_SRC_PREFIX)).sort();
const hasSharedLayerChange = sharedTouched.some((p) => SHARED_LAYER_FILES.has(p.slice(SHARED_SRC_PREFIX.length)));
let rule2State = "none"; // none = 无共享源变更；exempt = 有变更但产物零 diff；linked = 产物变且应联动技能已联动 bump
if (sharedTouched.length > 0) {
  rule2State = "exempt";
  const productSet = new Set(
    [...listNullSeparated(["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", WORKFLOWS]),
     ...listNullSeparated(["ls-files", "-z", "--", WORKFLOWS])].filter(isProduct),
  );
  const changedProducts = [];
  for (const rel of [...productSet].sort()) {
    const head = gitBlob(`HEAD:${rel}`);
    const staged = gitBlob(`:${rel}`);
    if (!blobsEqual(head, staged)) {
      const kind = head === null ? "新增" : staged === null ? "删除" : "内容变化";
      changedProducts.push(`${rel}（${kind}）`);
    }
  }
  if (changedProducts.length === 0) {
    notes.push(`规则 2（共享源联动）：workflows/src/ 有 staged 改动（${sharedTouched.length} 个文件），产物与 HEAD 逐字节相同 → 豁免`);
  } else {
    rule2State = "linked";
    // 联动范围：共享层变化 → 全技能；仅独享源变化 → 变化产物所属技能（PRODUCT_SKILL 映射）
    const changedProductRels = [...productSet].filter((rel) => {
      const head = gitBlob(`HEAD:${rel}`);
      const staged = gitBlob(`:${rel}`);
      return !blobsEqual(head, staged);
    });
    const affectedSkills = hasSharedLayerChange
      ? SKILLS.map((s) => s.name)
      : [...new Set(changedProductRels
          .map((rel) => PRODUCT_SKILL[rel.slice(WORKFLOWS.length + 1)])
          .filter(Boolean))];
    const unbumped = SKILLS.filter((s) => affectedSkills.includes(s.name) && !versions.get(s.name).bumped);
    for (const skill of unbumped) {
      const v = versions.get(skill.name);
      violations.push({
        title: `规则 2（${hasSharedLayerChange ? "共享源联动" : "独享源联动"}）：workflows/src/ 的 staged 改动改变了产物，但 ${skill.name} 版本未联动 bump`,
        details: [
          `未 bump 的技能：${skill.name}（HEAD ${v.headVersion} → staged ${v.stagedVersion}）`,
          `权威源：scripts/build-workflows.mjs 从各 SKILL.md frontmatter version 注入产物 SKILL_VERSION；构建源的唯一行为出口是产物`,
          hasSharedLayerChange ? `共享层构建源：` : `独享构建源（仅影响本 workflow 产物）：`,
          ...sharedTouched.map((p) => `  - ${p}`),
          `产物逐字节 diff（${changedProducts.length} 份，与 HEAD 比较）：`,
          ...changedProducts.map((p) => `  - ${p}`),
        ],
        recovery:
          `构建源变更使产物变化时对应技能联动升版本：把所属 SKILL.md frontmatter 的 version 升号` +
          `（共享层变化时全部技能升号），重跑 node scripts/build-workflows.mjs 重建产物后重新 git add 再提交；` +
          `若本次源改动是纯注释、不应改变产物，重跑构建确认产物与 HEAD 逐字节相同即自动豁免`,
      });
    }
  }
}

// ── 规则 3：版本戳一致性 ──
const stampProblems = [];
const reportedFrontmatterIssues = new Set();
for (const [rel, skillName] of Object.entries(PRODUCT_SKILL)) {
  const path = `${WORKFLOWS}/${rel}`;
  const blob = gitBlob(`:${path}`);
  if (blob === null) {
    stampProblems.push(`${path}：提交内容中缺该产物文件（产物应入 git）`);
    continue;
  }
  const m = blob.toString("utf8").match(STAMP_RE);
  if (!m) {
    stampProblems.push(`${path}：无 SKILL_VERSION 常量（产物早于版本注入机制，或常量行被手改）`);
    continue;
  }
  const fmVersion = versions.get(skillName).stagedVersion;
  if (fmVersion === null) {
    if (!reportedFrontmatterIssues.has(skillName)) {
      reportedFrontmatterIssues.add(skillName);
      stampProblems.push(
        `${SKILLS.find((s) => s.name === skillName).dir}/SKILL.md：frontmatter 缺 version 或非 semver 形态（产物版本戳无从对账）`,
      );
    }
    continue;
  }
  if (m[1] !== fmVersion) {
    stampProblems.push(`${path}：内嵌 SKILL_VERSION=${m[1]} ≠ ${skillName} frontmatter=${fmVersion}`);
  }
}
if (stampProblems.length > 0) {
  violations.push({
    title: "规则 3（版本戳一致性）：产物内嵌 SKILL_VERSION 与对应技能 frontmatter 当前值不一致",
    details: [
      `权威源：产物 SKILL_VERSION 由 scripts/build-workflows.mjs 从 SKILL.md frontmatter version 注入，产物不手改`,
      `不一致清单（${stampProblems.length}）：`,
      ...stampProblems.map((p) => `  - ${p}`),
    ],
    recovery:
      `bump frontmatter 后必须重建产物：node scripts/build-workflows.mjs，然后 git add 产物再提交；` +
      `手工改产物内的 SKILL_VERSION 不算修复（下次构建会被覆盖回 frontmatter 值）`,
  });
}

// ── 输出 ──
if (violations.length === 0) {
  const stampCount = Object.keys(PRODUCT_SKILL).length;
  const summary = [
    `staged 文件 ${stagedFiles.length} 个`,
    "规则 1：技能自有文件无未 bump 改动",
    `规则 2：${
      rule2State === "exempt"
        ? "共享源变更零产物 diff 已豁免"
        : rule2State === "linked"
          ? "共享源变更使产物变化，全部技能版本已联动 bump"
          : "无共享源变更"
    }`,
    `规则 3：${stampCount} 份产物版本戳一致`,
  ];
  for (const note of notes) console.log(note);
  console.log(`版本纪律：通过（${summary.join("；")}）`);
  process.exit(0);
}

for (const note of notes) console.log(note);
console.error(`版本纪律：红灯——发现 ${violations.length} 处违规（判定对象 = 本次提交的 git 索引内容）：`);
violations.forEach((v, i) => {
  console.error("");
  console.error(`${i + 1}. ${v.title}`);
  for (const line of v.details) console.error(`   ${line}`);
  console.error(`   恢复动作：${v.recovery}`);
});
console.error("");
console.error("处置：逐条按恢复动作修正 → git add 修正后的文件 → 重新提交。版本语义见各技能 SKILL.md frontmatter 紧邻注释。");
process.exit(1);
