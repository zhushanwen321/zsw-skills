import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/src/dev-consistency-loop-v4.shared.ts"), "utf8");
const NODE_PREP = eval(
  SOURCE.slice(SOURCE.indexOf("const NODE_PREP = ["), SOURCE.indexOf("].join(\"\\n\");", SOURCE.indexOf("const NODE_PREP = [")) + 1)
    .replace(/^const NODE_PREP = /, ""),
);

function fixture(t, { withBinding }) {
  const root = mkdtempSync(join(tmpdir(), "v4-d2-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const designDir = join(root, "design", "pkg");
  const taskDir = join(root, "task");
  mkdirSync(project);
  mkdirSync(designDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: project });
  spawnSync("git", ["config", "user.name", "t"], { cwd: project });
  writeFileSync(join(project, "a.txt"), "one\n");
  spawnSync("git", ["add", "."], { cwd: project });
  spawnSync("git", ["commit", "-qm", "init"], { cwd: project });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).stdout.trim();
  writeFileSync(join(designDir, "pkg.rendered.md"), "# design\n");
  writeFileSync(join(designDir, "meta.json"), JSON.stringify({
    acceptanceBinding: withBinding ? { taskDir, acceptanceVersion: 2 } : null,
  }));
  writeFileSync(join(taskDir, "acceptance.json"), JSON.stringify({ schemaVersion: 2, requirements: [] }));
  const planPath = join(root, "pkg.impl-plan.json");
  const templatePath = join(root, "reviewer.md");
  writeFileSync(planPath, "{}");
  writeFileSync(templatePath, "reviewer");
  const execPlanPath = join(root, "exec-plan.json");
  writeFileSync(execPlanPath, JSON.stringify({
    projectRoot: project,
    baseline: head,
    planPath,
    designDocPath: join(designDir, "pkg.rendered.md"),
    statusPath: join(root, "pkg.status.json"),
    nodes: [],
    testPlan: { fullSuite: { program: "node", args: ["-e", "process.exit(0)"] } },
  }));
  return { project, execPlanPath, templatePath, skillDataDir: join(root, "skill-data"), acceptancePath: join(taskDir, "acceptance.json") };
}

function runPrep(fx) {
  const result = spawnSync(process.execPath, [
    "-e", `var templateArgRaw = process.argv[2];\n${NODE_PREP.join("\n")}`, fx.execPlanPath, fx.templatePath, "1", fx.skillDataDir,
  ], { cwd: fx.project, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("D2 启动准备从设计绑定推导验收包并注入三方对账", (t) => {
  const fx = fixture(t, { withBinding: true });
  const info = runPrep(fx);
  assert.equal(info.acceptancePath, fx.acceptancePath);
});

test("独立设计任务无验收绑定时 acceptancePath 为 null 而不拒启", (t) => {
  const fx = fixture(t, { withBinding: false });
  const info = runPrep(fx);
  assert.equal(info.acceptancePath, null);
});
