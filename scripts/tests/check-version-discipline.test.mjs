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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "..", "check-version-discipline.mjs");
const WORKFLOWS = "skills/self/dev-workflow/workflows";
const SKILL_DIRS = {
  "tech-design-wf": "skills/self/dev-workflow/tech-design-wf",
  "dev-flow-wf": "skills/self/dev-workflow/dev-flow-wf",
  "delivery-wf": "skills/self/dev-workflow/delivery-wf",
};
// 与检查器 PRODUCT_SKILL 同域的产物清单（新增产物时两处同步）
const PRODUCTS = [
  "tech-review-loop.dwf.ts",
  "pi/tech-review-loop.js",
  "wave-executor.dwf.ts",
  "pi/wave-executor.js",
  "dev-consistency-loop.dwf.ts",
  "pi/dev-consistency-loop.js",
  "design-code-sync-loop.dwf.ts",
  "pi/design-code-sync-loop.js",
  "design-code-sync-v2.dwf.ts",
  "pi/design-code-sync-v2.js",
  "contract-design.dwf.ts",
  "pi/contract-design.js",
  "candidate-build.dwf.ts",
  "pi/candidate-build.js",
  "independent-assurance.dwf.ts",
  "pi/independent-assurance.js",
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

/** 最小 fixture 仓：三技能 frontmatter + 各自一个自有文件 + 共享源 + 全部带版本戳的产物 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "version-discipline-"));
  for (const [skill, dir] of Object.entries(SKILL_DIRS)) {
    writeFile(root, `${dir}/SKILL.md`, skillMd(skill, "0.1.0"));
    writeFile(root, `${dir}/flow/step.md`, `# ${skill} fixture 步骤\n`);
  }
  writeFile(root, `${WORKFLOWS}/src/skill-data.shared.ts`, "// fixture 共享源\n");
  for (const rel of PRODUCTS) writeFile(root, `${WORKFLOWS}/${rel}`, product("0.1.0"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "fixture@example.com"]);
  git(root, ["config", "user.name", "fixture"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".no-hooks"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  return root;
}

function stageAll(root) {
  git(root, ["add", "-A"]);
}

function runChecker(root) {
  const r = spawnSync("node", [CHECKER, "--root", root], { encoding: "utf8" });
  assert.notEqual(r.status, null, `检查器应正常启动：${r.error?.message ?? r.stderr}`);
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
  appendLine(root, `${SKILL_DIRS["tech-design-wf"]}/flow/step.md`, "补充一行");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 1, `应红灯，实际输出：${r.output}`);
  assert.match(r.output, /规则 1（bump 对账）/);
  assert.match(r.output, /tech-design-wf/);
  assert.match(r.output, /frontmatter version 未 bump/);
  assert.match(r.output, /恢复动作：/);
  assert.match(r.output, /PATCH/);
});

test("改技能自有文件且 bump（产物同步重建）→ 放行", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${SKILL_DIRS["tech-design-wf"]}/flow/step.md`, "补充一行");
  setSkillVersion(root, "tech-design-wf", "0.1.1");
  setStamp(root, "tech-review-loop.dwf.ts", "0.1.1");
  setStamp(root, "pi/tech-review-loop.js", "0.1.1");
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
  appendLine(root, `${WORKFLOWS}/tech-review-loop.dwf.ts`, "// 产物随共享源变化");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 1, `应红灯，实际输出：${r.output}`);
  assert.match(r.output, /规则 2（共享源联动）/);
  assert.match(r.output, /tech-design-wf/);
  assert.match(r.output, /dev-flow-wf/);
  assert.match(r.output, /delivery-wf/);
  assert.match(r.output, /全部技能联动升版本/);
  assert.match(r.output, /恢复动作：/);
});

test("frontmatter bump 后产物未重建 → 拦（版本戳一致性）", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  setSkillVersion(root, "dev-flow-wf", "0.1.1");
  stageAll(root);

  const r = runChecker(root);
  assert.equal(r.status, 1, `应红灯，实际输出：${r.output}`);
  assert.match(r.output, /规则 3（版本戳一致性）/);
  assert.match(r.output, /内嵌 SKILL_VERSION=0\.1\.0 ≠ dev-flow-wf frontmatter=0\.1\.1/);
  assert.match(r.output, /node scripts\/build-workflows\.mjs/);
});

test("共享源 + 产物变 + 全部技能联动 bump → 放行", (t) => {
  const root = makeFixture();
  cleanup(t, root);
  appendLine(root, `${WORKFLOWS}/src/skill-data.shared.ts`, "// 行为变更");
  setSkillVersion(root, "tech-design-wf", "0.1.1");
  setSkillVersion(root, "dev-flow-wf", "0.1.1");
  setSkillVersion(root, "delivery-wf", "0.1.1");
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
  appendLine(root, `${SKILL_DIRS["dev-flow-wf"]}/flow/step.md`, "未暂存改动");

  const r = runChecker(root);
  assert.equal(r.status, 0, `索引无改动应放行，实际输出：${r.output}`);
});
