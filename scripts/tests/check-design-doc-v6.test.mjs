// check-design-doc-v6.test.mjs — tech-design-v6 设计包机器自检的第二轮加固规则测试
//
// 对应实现：skills/self/dev-workflow/tech-design-v6/scripts/check-design-doc.mjs。
// 覆盖 2026-11-19 第二轮审查修复新增的四条判定（v5 代无这些规则，不与 check-design-doc.test.mjs
// 的 v5 fixture 混跑）：
//   - 零决策拦截：s3-solution.json decisions 缺失或空数组 → fail（占位导航行无法替代真实决策）
//   - 分级一致性：reviewNav 行 level 与 decisions 本体 level 不一致 → fail（防借 nav 行降档
//     绕过 A 级 criteria 必填）；一侧缺失无法比对 → 放行
//   - e2eImpact 互斥双向：items 非空且 noneReason 写实质依据 → fail；items 非空且
//     noneReason 填「—」占位（模板注记规定形态）→ 放行
//   - stateCopies 形态：存在但非数组 → fail；字段缺失 → 放行（与「未触发不写」一致）
//
// 基座 = resources/templates/design-doc/ 模板复制（顺带守护模板自身合法——模板腐化即红灯）。
//
// 运行：node --test scripts/tests/check-design-doc-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v6", "scripts", "check-design-doc.mjs");
const TEMPLATE_DIR = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v6", "resources", "templates", "design-doc");

/** 模板副本 → 最小合法化（占位文本补实义，使基座 exit 0），返回 {dir, patch} */
function makeDesign(t) {
  const dir = mkdtempSync(join(tmpdir(), "cdd-v6-"));
  cpSync(TEMPLATE_DIR, dir, { recursive: true });
  const readJson = (file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  const writeJson = (file, value) => writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  // 最小合法化：占位文本替换为实义（check-design-doc 只判非空/枚举/引用存在，语义不论）
  const meta = readJson("meta.json");
  meta.name = "cdd-v6-fixture";
  meta.typeRationale = "改动局部、无终态结构诉求——不需要终态视角";
  meta.riskRationale = "单模块内改动，风险低";
  meta.reviewNav[0].title = "决策一标题";
  meta.reviewNav[0].criteria = "命中判据 1";
  meta.reviewNav[0].impact = "影响示意";
  writeJson("meta.json", meta);
  const s3 = readJson("s3-solution.json");
  s3.decisions[0].title = "决策一标题";
  s3.decisions[0].stage = "主流程 → 环节示意";
  s3.decisions[0].choice = "采用示意";
  s3.decisions[0].rejected = "若用别的做法，现状例子会变成示意";
  s3.decisions[0].evidence = "src/demo.ts:1（已核实）";
  s3.decisions[0].guards[0].text = "fixture 专属守护全文：^[a-z][a-z0-9-]+$";
  s3.decisions[0].guards[0].note = "防标识符越界示意";
  writeJson("s3-solution.json", s3);
  const patch = (file, mut) => {
    const value = readJson(file);
    mut(value);
    writeJson(file, value);
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, patch };
}

const runCheck = (dir) => spawnSync(process.execPath, [CHECK_SCRIPT, dir], { encoding: "utf8" });

test("基座：模板复制 + 最小合法化后 exit 0（模板自身合法守护）", (t) => {
  const { dir } = makeDesign(t);
  const r = runCheck(dir);
  assert.equal(r.status, 0, `基座应全绿：stdout=${r.stdout} stderr=${r.stderr}`);
});

test("零决策拦截：decisions 置空数组 → fail（占位导航行无法替代真实决策）", (t) => {
  const { dir, patch } = makeDesign(t);
  patch("s3-solution.json", (v) => {
    v.decisions = [];
  });
  const r = runCheck(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /decisions 缺失或为空数组/);
  assert.match(r.stdout, /零关键决策的设计不成立/);
});

test("零决策拦截：decisions 字段删除 → 同 fail（缺失与空数组同语义）", (t) => {
  const { dir, patch } = makeDesign(t);
  patch("s3-solution.json", (v) => {
    delete v.decisions;
  });
  const r = runCheck(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /decisions 缺失或为空数组/);
});

test("分级一致性：nav 行 level=B 而决策本体 level=A → fail（防借 nav 行降档绕过 A 级义务）", (t) => {
  const { dir, patch } = makeDesign(t);
  patch("meta.json", (v) => {
    v.reviewNav[0].level = "B";
    delete v.reviewNav[0].criteria;
  });
  const r = runCheck(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /level「B」与 s3-solution\.json decisions 本体的 level「A」不一致/);
});

test("分级一致性：决策本体 level 缺失（一侧无法比对）→ 不因一致性新规则 fail", (t) => {
  const { dir, patch } = makeDesign(t);
  patch("s3-solution.json", (v) => {
    delete v.decisions[0].level;
  });
  const r = runCheck(dir);
  // A 级 nav 行 criteria 已在基座补实义，本体 level 缺失不触发新规则；其余规则照常判定
  assert.doesNotMatch(r.stdout, /不一致——两侧取同一权威事实改正/);
});

test("e2eImpact 互斥双向：items 非空且 noneReason 写实质依据 → fail；「—」占位放行", (t) => {
  const { dir, patch } = makeDesign(t);
  patch("s4-accept.json", (v) => {
    v.e2eImpact.noneReason = "全链路无端到端触点所以不需要";
  });
  const r = runCheck(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /items 非空（1 项）但 noneReason 写了实质内容/);

  // 模板注记规定的非空集占位形态放行
  patch("s4-accept.json", (v) => {
    v.e2eImpact.noneReason = "—";
  });
  const r2 = runCheck(dir);
  assert.doesNotMatch(r2.stdout, /noneReason 写了实质内容/);
});

test("stateCopies 形态：存在但非数组 → fail；字段缺失放行（未触发不写）", (t) => {
  const { dir, patch } = makeDesign(t);
  patch("s2-status.json", (v) => {
    v.artifactTables.stateCopies = { id: "SC1" };
  });
  const r = runCheck(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stateCopies 存在但不是数组/);

  patch("s2-status.json", (v) => {
    delete v.artifactTables.stateCopies;
  });
  const r2 = runCheck(dir);
  assert.doesNotMatch(r2.stdout, /stateCopies 存在但不是数组/);
});
