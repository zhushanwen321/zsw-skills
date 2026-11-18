import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = readFileSync(join(ROOT, "skills/self/dev-workflow/workflows/src/dev-consistency-loop-v4.shared.ts"), "utf8");
const NODE_PREP = eval(
  SOURCE.slice(SOURCE.indexOf("const NODE_PREP = ["), SOURCE.indexOf("].join(\"\\n\");", SOURCE.indexOf("const NODE_PREP = [")) + 1)
    .replace(/^const NODE_PREP = /, ""),
);

// 模板仓：每测试进程只构建一次「初始提交仓」，fixture 经 cpSync 复制实例化——git 对象是
// 内容寻址的只读数据，复制保真，省掉每 fixture 的 init/config/add/commit spawn
let gitTemplate = null;
let gitTemplateHead = "";
function ensureGitTemplate() {
  if (gitTemplate === null) {
    const tpl = mkdtempSync(join(tmpdir(), "v4-d2-contract-tpl-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: tpl });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: tpl });
    spawnSync("git", ["config", "user.name", "t"], { cwd: tpl });
    writeFileSync(join(tpl, "a.txt"), "one\n");
    spawnSync("git", ["add", "."], { cwd: tpl });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: tpl });
    gitTemplateHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tpl, encoding: "utf8" }).stdout.trim();
    process.on("exit", () => rmSync(tpl, { recursive: true, force: true }));
    gitTemplate = tpl;
  }
  return gitTemplate;
}

function fixture(t, { withBinding }) {
  const root = mkdtempSync(join(tmpdir(), "v4-d2-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const designDir = join(root, "design", "pkg");
  const taskDir = join(root, "task");
  mkdirSync(designDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  cpSync(ensureGitTemplate(), project, { recursive: true });
  const head = gitTemplateHead;
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
