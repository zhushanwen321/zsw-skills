// tree-plant CLI 六道 gate 的行为测试：端到端夹具走完全部阶段 + 负向用例集。
// 覆盖 case 解析/执行/判据、三分类核验（空证据、行号亲核、case 覆盖、虚构作废、推断登记）、
// 改动范围核对（主干清单/枝声明）、阶段顺序、哈希防手改、四文档基线、终态裁决与报告生成。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO, "skills/self/dev-workflow/tree-plant/tree-plant.mjs");

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { encoding: "utf8", cwd, timeout: 60_000 });
}

const DESIGN = [
  "# 设计", "",
  "## 背景与目标", "为宿主做显式记忆便签，服务单项目用户。", "",
  "## 验收是什么", "本次重点：真实宿主装载与保存往返、关闭彻底性、不重复注入。",
  "验收判据 = acceptance.md 的实机 case 全绿。", "",
  "## 树形拆分", "",
  "主干文件清单：", "- docs/", "- test/", "- package.json", "- src/core/", "",
  "| 枝名 | 目标 | 依赖 | 风险级 | 文件 | case |",
  "|---|---|---|---|---|---|",
  "| save | 保存增强 | - | 常规 | src/save/ | B1 |",
  "| gov | 治理 | - | 常规 | src/gov/ | B2 |",
  "",
  "## 非功能设计", "崩溃窗口数据损坏（可靠性）：断电丢全量数据，天级出问题。", "",
  "### 显式不做", "- 读缓存", "",
].join("\n");

const FACT_CHECK = [
  "# 事实核查", "",
  "## 论据三分类表", "",
  "| 编号 | 论据 | 分类 | 证据 | 说明 |",
  "|---|---|---|---|---|",
  "| A1 | design.md 存在 | 事实 | docs/design.md:1 | |",
  "| A2 | 环境可用 | 推断 | | 升级路径：实测后改事实 |",
  "",
  "## 外部接口核实表", "",
  "| 接口 | 形态 | 依据 | case |",
  "|---|---|---|---|",
  "| echo | 真进程 | docs/design.md:2 | T1,B1 |",
  "",
  "## 未核实风险", "",
  "- A2：环境未实测",
  "",
].join("\n");

function makeFixture({ factCheck, acceptance, noTestEntry = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-plant-"));
  sh("git", ["init", "-q"], dir);
  sh("git", ["config", "user.email", "t@t"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".run/\n");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/all.test.mjs"), 'console.log("suite-ok");\n');
  if (!noTestEntry) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test/all.test.mjs" } }, null, 2));
  }
  fs.writeFileSync(path.join(dir, "docs/design.md"), DESIGN);
  fs.writeFileSync(path.join(dir, "docs/api.md"), "# API\n\n## 命令\n/memory list\n\n## 工具\nmemory_save\n\n## 配置\nenabled\n\n## 存储\nJSONL 追加\n\n## 挂点\ncontext\n");
  fs.writeFileSync(
    path.join(dir, "docs/acceptance.md"),
    acceptance ??
      [
        "# 实机验收 case", "",
        "| 编号 | 场景 | 命令 | 预期 | 关联 |",
        "|---|---|---|---|---|",
        "| T1 | 装载并保存 | echo trunk-ok | exit:0;contains:trunk-ok | trunk |",
        "| B1 | 保存枝 | echo save-ok | exit:0;contains:save-ok | save |",
        "| B2 | 治理枝 | echo gov-ok | exit:0;contains:gov-ok | gov |",
        "",
      ].join("\n")
  );
  fs.writeFileSync(path.join(dir, "docs/fact-check.md"), factCheck ?? FACT_CHECK);
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-qm", "fixture"], dir);
  return dir;
}

function runCli(dir, args) {
  return sh(process.execPath, [CLI, ...args], dir);
}

function commitAll(dir, msg) {
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-qm", msg], dir);
}

const FINDINGS = [
  { id: "P1", category: "card-01", finding: "写循环中 off 后仍写", status: "fixed", reproCmd: "node probe/off-mid.mjs", evidence: "修复+回归", mutationEvidence: "摘掉复查门禁，用例转红" },
  { id: "P2", category: "card-03", finding: "并发竞态申报", status: "refuted", reproCmd: "node probe/race.mjs", evidence: "复现命令输出：未复现" },
  { id: "P3", category: "card-05", finding: "极端环境登记", status: "registered", reason: "触发条件极端且后果有界" },
];

test("端到端：root→trunk→branch×2→leaf→prune→harvest 全绿并产出报告", () => {
  const dir = makeFixture();
  try {
    for (const args of [["root"], ["trunk"], ["branch", "--name", "save"], ["branch", "--name", "gov"], ["leaf"]]) {
      const r = runCli(dir, args);
      assert.equal(r.status, 0, `${args.join(" ")} 应通过：${r.stdout}${r.stderr}`);
    }
    fs.mkdirSync(path.join(dir, ".run"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".run", "prune-findings.json"), JSON.stringify(FINDINGS));
    assert.equal(runCli(dir, ["prune"]).status, 0);
    const harv = runCli(dir, ["harvest"]);
    assert.equal(harv.status, 0, harv.stderr);
    assert.match(harv.stdout, /delivered/);
    const report = fs.readFileSync(path.join(dir, ".run", "report.md"), "utf8");
    assert.match(report, /delivered/);
    assert.match(report, /T1/);
    assert.match(report, /P3/); // registered 进残余风险
    assert.match(report, /## 交付文件清单/);
    assert.match(report, /docs\/design\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：事实论据证据列无引用（纯文字证据绕过被堵）", () => {
  const dir = makeFixture({
    factCheck: FACT_CHECK.replace("| A1 | design.md 存在 | 事实 | docs/design.md:1 | |", "| A1 | 引用纯文字 | 事实 | 官方文档说可用 | |"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /没有可解析的/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：接口核实表 case 列为空（无 case 覆盖=没验证过的接口）", () => {
  const dir = makeFixture({
    factCheck: FACT_CHECK.replace("| echo | 真进程 | docs/design.md:2 | T1,B1 |", "| echo | 真进程 | docs/design.md:2 |  |"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /没有任何 case 覆盖/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：虚构论据未标作废", () => {
  const dir = makeFixture({
    factCheck: FACT_CHECK.replace("| A1 | design.md 存在 | 事实 | docs/design.md:1 | |", "| A3 | 臆断的 API | 虚构 | 想象出来的 | |"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /虚构论据已标作废/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：推断论据未登记未核实风险", () => {
  const dir = makeFixture({
    factCheck: FACT_CHECK.replace("- A2：环境未实测", "- （空）"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /推断论据已登记未核实风险/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：验收 case 命令是单测 runner 形态被拒（pytest）", () => {
  const dir = makeFixture({
    acceptance: [
      "# 实机验收 case", "",
      "| 编号 | 场景 | 命令 | 预期 | 关联 |",
      "|---|---|---|---|---|",
      "| T1 | 单测冒充验收 | pytest tests/ | exit:0 | trunk |",
      "",
    ].join("\n"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /单测 runner\/mock 形态/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trunk 红：无单测入口（TDD 测试绿为必须）", () => {
  const dir = makeFixture({ noTestEntry: true });
  try {
    assert.equal(runCli(dir, ["root"]).status, 0);
    const r = runCli(dir, ["trunk"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /找不到单测入口/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trunk 红：改动越出主干文件清单", () => {
  const dir = makeFixture();
  try {
    assert.equal(runCli(dir, ["root"]).status, 0);
    fs.writeFileSync(path.join(dir, "out-of-scope.txt"), "x");
    const r = runCli(dir, ["trunk"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /out-of-scope\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("branch 红：改动越出枝声明文件", () => {
  const dir = makeFixture();
  try {
    assert.equal(runCli(dir, ["root"]).status, 0);
    assert.equal(runCli(dir, ["trunk"]).status, 0);
    fs.mkdirSync(path.join(dir, "src/other"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/other/x.ts"), "x");
    const r = runCli(dir, ["branch", "--name", "gov"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /src\/other\/x\.ts/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("branch 红：枝无关联 case", () => {
  const dir = makeFixture();
  try {
    assert.equal(runCli(dir, ["root"]).status, 0);
    assert.equal(runCli(dir, ["trunk"]).status, 0);
    assert.equal(runCli(dir, ["branch", "--name", "save"]).status, 0);
    const r2 = runCli(dir, ["branch", "--name", "nonexist"]);
    assert.equal(r2.status, 1);
    assert.match(r2.stdout + r2.stderr, /没有关联 case/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trunk 红：无法解析的预期判据转红", () => {
  const dir = makeFixture({
    acceptance: [
      "# 实机验收 case", "",
      "| 编号 | 场景 | 命令 | 预期 | 关联 |",
      "|---|---|---|---|---|",
      "| T1 | 非法判据 | echo ok | foo:bar | trunk |",
      "",
    ].join("\n"),
    factCheck: FACT_CHECK.replace("| echo | 真进程 | docs/design.md:2 | T1,B1 |", "| echo | 真进程 | docs/design.md:2 | T1 |"),
  });
  try {
    assert.equal(runCli(dir, ["root"]).status, 0);
    const r = runCli(dir, ["trunk"]);
    assert.equal(r.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("阶段记录被手改后，后续 gate 拒绝（哈希自洽）", () => {
  const dir = makeFixture();
  try {
    assert.equal(runCli(dir, ["root"]).status, 0);
    const file = path.join(dir, ".run", "root.json");
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    body.caseCount = 999;
    fs.writeFileSync(file, JSON.stringify(body));
    const r = runCli(dir, ["trunk"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /哈希不符/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prune 红：fixed 发现缺变异验证记录", () => {
  const dir = makeFixture();
  try {
    for (const args of [["root"], ["trunk"], ["leaf"]]) assert.equal(runCli(dir, args).status, 0, args.join(" "));
    fs.mkdirSync(path.join(dir, ".run"), { recursive: true });
    const { mutationEvidence, ...noMutation } = FINDINGS[0];
    fs.writeFileSync(path.join(dir, ".run", "prune-findings.json"), JSON.stringify([noMutation]));
    const r = runCli(dir, ["prune"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /变异验证/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prune 红：refuted 发现缺复现命令 reproCmd", () => {
  const dir = makeFixture();
  try {
    for (const args of [["root"], ["trunk"], ["leaf"]]) assert.equal(runCli(dir, args).status, 0, args.join(" "));
    fs.mkdirSync(path.join(dir, ".run"), { recursive: true });
    const { reproCmd, ...noRepro } = FINDINGS[1];
    fs.writeFileSync(path.join(dir, ".run", "prune-findings.json"), JSON.stringify([noRepro]));
    const r = runCli(dir, ["prune"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /reproCmd/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("harvest 红：root 后 acceptance 被整体替换（四文档基线+静态复检）", () => {
  const dir = makeFixture();
  try {
    for (const args of [["root"], ["trunk"], ["leaf"]]) assert.equal(runCli(dir, args).status, 0, args.join(" "));
    fs.mkdirSync(path.join(dir, ".run"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".run", "prune-findings.json"), JSON.stringify(FINDINGS));
    assert.equal(runCli(dir, ["prune"]).status, 0);
    fs.writeFileSync(
      path.join(dir, "docs/acceptance.md"),
      "# c\n\n| 编号 | 场景 | 命令 | 预期 | 关联 |\n|---|---|---|---|---|\n| Z9 | 无关 | echo z | exit:0 | trunk |\n"
    );
    commitAll(dir, "swap");
    const r = runCli(dir, ["harvest"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /root/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
