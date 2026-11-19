// check-version-discipline.test.mjs — 版本纪律检查器的 fixture 仓双向测试
//
// 被测实现：scripts/check-version-discipline.mjs（三条规则——bump 对账 / 共享源按产物
// 逐字节 diff 联动 / 产物版本戳一致性）。判定对象 = fixture 仓的 git 索引（与 HEAD 比较），
// 因此测试在 fixture 内真实 git add（被测行为，非对本仓库操作），不在本仓库暂存任何东西。
//
// 用例：
//   1. 改技能自有文件未 bump → 拦（非 0 退出 + 恢复动作文案在场）
//   2. 改技能自有文件且 bump（产物同步重建）→ 放行
//   3. 改 workflows/src/ 纯注释（产物零 diff）→ 放行（规则 2 豁免）
//   4. 改 workflows/src/ 且产物变、未 bump → 拦（全部技能联动文案，每个技能各一条）
//   5. frontmatter bump 后产物未重建 → 拦（规则 3 版本戳一致性）
//   6. 共享源 + 产物变 + 全部技能联动 bump → 放行（规则 2 的正向路径）
//   7. 工作区未暂存改动不参与判定 → 放行（提交门只对索引内容负责）
//
// 运行：node scripts/tests/check-version-discipline.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 提速通道：检查器进程内转译执行（内部 git 调用仍走真实 spawn，判定的索引行为不变）；
// fixture 仓 = 模板副本（git init/config/add/commit 只做一次）；CLI spawn 保留在防漂移对拍锚
import { runMjsScript } from "./helpers/mjs-runner.mjs";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "..", "check-version-discipline.mjs");
const WORKFLOWS = "skills/self/dev-workflow/workflows";
// 与检查器 SKILLS 同域的技能清单（登记变化时两处同步）；tree-plant 无 workflow 产物
const SKILL_DIRS = {
  "design-code-sync": "skills/self/dev-workflow/design-code-sync",
  "tree-plant": "skills/self/dev-workflow/tree-plant",
};
// 与检查器 PRODUCT_SKILL 同域的产物清单（新增产物时两处同步）；两引擎（design-code-sync
// ×2）归属 design-code-sync 技能
const PRODUCTS = [
  "design-code-sync-loop.dwf.ts",
  "pi/design-code-sync-loop.js",
  "design-code-sync-v2.dwf.ts",
  "pi/design-code-sync-v2.js",
];

const skillMd = (name, version) => `---\nname: ${name}\nversion: ${version}\ndescription: fixture\n---\n\n# ${name}\n`;
const product = (version) => `// fixture 产物\nconst SKILL_VERSION = "${version}"; // 构建注入\n`;

function writeFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `fixture git ${args.join(" ")} 应成功：${r.stderr}`);
  return r.stdout;
}

/** fixture 模板仓（内容固定的最小仓：技能 frontmatter + 各自一个自有文件 + 共享源 +
 *  全部带版本戳的产物，init/config/add/commit 只做一次）——每用例复制副本替代逐用例
 *  git spawn；模板落系统临时目录，进程退出后由 OS 清理 */
let fixtureTemplate = null;
function ensureFixtureTemplate() {
  if (fixtureTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "version-discipline-tpl-"));
    for (const [skill, dir] of Object.entries(SKILL_DIRS)) {
      writeFile(tpl, `${dir}/SKILL.md`, skillMd(skill, "0.1.0"));
      writeFile(tpl, `${dir}/flow/step.md`, `# ${skill} fixture 步骤\n`);
    }
    writeFile(tpl, `${WORKFLOWS}/src/skill-data.shared.ts`, "// fixture 共享源\n");
    for (const rel of PRODUCTS) writeFile(tpl, `${WORKFLOWS}/${rel}`, product("0.1.0"));
    git(tpl, ["init", "-q", "-b", "main"]);
    git(tpl, ["config", "user.email", "fixture@example.com"]);
    git(tpl, ["config", "user.name", "fixture"]);
    git(tpl, ["config", "commit.gpgsign", "false"]);
    git(tpl, ["config", "core.hooksPath", ".no-hooks"]);
    git(tpl, ["add", "-A"]);
    git(tpl, ["commit", "-qm", "fixture baseline"]);
    fixtureTemplate = tpl;
  }
  return fixtureTemplate;
}

/** 最小 fixture 仓：模板副本（内容与逐用例全新 init 等价） */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "version-discipline-"));
  cpSync(ensureFixtureTemplate(), root, { recursive: true });
  return root;
}

function stageAll(root) {
  git(root, ["add", "-A"]);
}

function runChecker(root) {
  // 进程内转译执行：与 CLI spawn 语义一致（一致性由防漂移对拍锚锚定）；检查器内部的
  // git 调用经 ctx.require 真实 spawnSync 在 fixture 仓上执行——判定的索引行为不变
  const r = runMjsScript(CHECKER, ["--root", root], { env: process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}\n${r.stderr}` };
}

function appendLine(root, rel, line) {
  writeFileSync(join(root, rel), `${readFileSync(join(root, rel), "utf8")}${line}\n`);
}

function setSkillVersion(root, skill, version) {
  const rel = `${SKILL_DIRS[skill]}/SKILL.md`;
  writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8").replace(/^version: .*$/m, `version: ${version}`));
}

function setStamp(root, productRel, version) {
  const rel = `${WORKFLOWS}/${productRel}`;
  writeFileSync(
    join(root, rel),
    readFileSync(join(root, rel), "utf8").replace(/const SKILL_VERSION = "[^"]*";/, `const SKILL_VERSION = "${version}";`),
  );
}

function cleanup(t, root) {
  t.after(() => rmSync(root, { recursive: true, force: true }));
}

test("改技能自有文件未 bump → 拦（恢复动作文案在场）", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${SKILL_DIRS["design-code-sync"]}/flow/step.md`, "补充一行");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 1, `应红灯，实际输出：${r.output}`);
  assert.match(r.output, /规则 1（bump 对账）/);
  assert.match(r.output, /design-code-sync/);
  assert.match(r.output, /frontmatter version 未 bump/);
  assert.match(r.output, /恢复动作：/);
  assert.match(r.output, /PATCH/);
});

test("改技能自有文件且 bump（产物同步重建）→ 放行", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${SKILL_DIRS["design-code-sync"]}/flow/step.md`, "补充一行");
  setSkillVersion(root, "design-code-sync", "0.1.1");
  for (const rel of PRODUCTS) setStamp(root, rel, "0.1.1");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 0, `应放行，实际输出：${r.output}`);
  assert.match(r.stdout, /版本纪律：通过/);
});

test("改 workflows/src/ 纯注释（产物零 diff）→ 放行", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${WORKFLOWS}/src/skill-data.shared.ts`, "// 纯注释改动");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 0, `应放行，实际输出：${r.output}`);
  assert.match(r.output, /规则 2（共享源联动）：workflows\/src\/ 有 staged 改动/);
  assert.match(r.output, /逐字节相同 → 豁免/);
});

test("改 workflows/src/ 且产物变、未 bump → 拦（全部技能联动文案）", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${WORKFLOWS}/src/skill-data.shared.ts`, "// 行为变更");
  appendLine(root, `${WORKFLOWS}/design-code-sync-loop.dwf.ts`, "// 产物随共享源变化");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 1, `应红灯，实际输出：${r.output}`);
  assert.match(r.output, /规则 2（共享源联动）/);
  assert.match(r.output, /design-code-sync/);
  assert.match(r.output, /tree-plant/);
  assert.match(r.output, /共享层变化时全部技能升号/);
  assert.match(r.output, /恢复动作：/);
});

test("frontmatter bump 后产物未重建 → 拦（版本戳一致性）", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  setSkillVersion(root, "design-code-sync", "0.1.1");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 1, `应红灯，实际输出：${r.output}`);
  assert.match(r.output, /规则 3（版本戳一致性）/);
  assert.match(r.output, /内嵌 SKILL_VERSION=0\.1\.0 ≠ design-code-sync frontmatter=0\.1\.1/);
  assert.match(r.output, /node scripts\/build-workflows\.mjs/);
});

test("共享源 + 产物变 + 全部技能联动 bump → 放行", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${WORKFLOWS}/src/skill-data.shared.ts`, "// 行为变更");
  for (const skill of Object.keys(SKILL_DIRS)) setSkillVersion(root, skill, "0.1.1");
  for (const rel of PRODUCTS) {
    appendLine(root, `${WORKFLOWS}/${rel}`, "// 产物随共享源变化");
    setStamp(root, rel, "0.1.1");
  }
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 0, `应放行，实际输出：${r.output}`);
  assert.match(r.stdout, /版本纪律：通过/);
});

test("工作区未暂存改动不参与判定 → 放行", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  // 只改工作区、不 git add：判定的提交内容（索引）仍与 HEAD 一致
  appendLine(root, `${SKILL_DIRS["tree-plant"]}/flow/step.md`, "未暂存改动");

  const r = runChecker(root);
  assert.equal(r.status, 0, `索引无改动应放行，实际输出：${r.output}`);
});

test("防漂移锚：进程内转译执行 == CLI spawn（规则 1 红灯形态双跑对拍）", (t) => {
  // 提速通道的防漂移约束：同改动在两个独立 fixture 仓各跑一次，退出码与 stdout/stderr
  // 逐字段一致（仓路径不同不影响输出——检查器只报相对路径与版本值）
  const rootIn = makeFixture();
  cleanup(t, rootIn);
  appendLine(rootIn, `${SKILL_DIRS["design-code-sync"]}/flow/step.md`, "补充一行");
  stageAll(rootIn);
  const rootCli = makeFixture();
  cleanup(t, rootCli);
  appendLine(rootCli, `${SKILL_DIRS["design-code-sync"]}/flow/step.md`, "补充一行");
  stageAll(rootCli);
  const inProc = runChecker(rootIn);
  const cli = spawnSync("node", [CHECKER, "--root", rootCli], { encoding: "utf8" });
  assert.equal(inProc.status, cli.status, `退出码不一致：进程内 ${inProc.status} vs CLI ${cli.status}`);
  assert.equal(inProc.stdout, cli.stdout, "stdout 不一致");
  assert.equal(inProc.stderr, cli.stderr, "stderr 不一致");
});
