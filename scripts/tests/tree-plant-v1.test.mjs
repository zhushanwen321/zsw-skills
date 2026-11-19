// tree-plant v1 CLI 六道 gate 的行为测试：一个端到端夹具走完全部阶段 + 六个负向用例。
// 夹具用 echo 作实机 case（真进程、真实退出码与输出），覆盖 case 解析/执行/判据、
// 三分类核验（行号亲核、case 覆盖、虚构作废）、阶段顺序、哈希防手改、终态裁决与报告生成。
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

function makeFixture({ factCheck, acceptance, failingCase = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-plant-"));
  sh("git", ["init", "-q"], dir);
  sh("git", ["config", "user.email", "t@t"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".run/\n");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test/all.test.mjs"), 'console.log("suite-ok");\n');
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "node test/all.test.mjs" } }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "docs/design.md"),
    [
      "# 设计", "",
      "## 背景与目标", "为宿主做显式记忆便签，服务单项目用户。", "",
      "## 验收是什么", "本次重点：真实宿主装载与保存往返、关闭彻底性、不重复注入。",
      "验收判据 = acceptance.md 的实机 case 全绿。", "",
      "## 树形拆分", "主干：装载→保存→读回。枝：save（保存增强）、gov（治理）。", "",
      "## 非功能设计", "崩溃窗口数据损坏（可靠性）：断电丢全量数据，天级出问题。", "",
      "### 显式不做", "- 读缓存", "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "docs/api.md"),
    "# API\n\n## 命令\n/memory list\n\n## 工具\nmemory_save\n\n## 配置\nenabled\n\n## 存储\nJSONL 追加\n\n## 挂点\ncontext\n"
  );
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
        ...(failingCase ? ["| T2 | 必失败 | exit 3 | exit:0 | trunk |"] : []),
        "",
      ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "docs/fact-check.md"),
    factCheck ??
      [
        "# 事实核查", "",
        "## 论据三分类表", "",
        "| 编号 | 论据 | 分类 | 证据 | 说明 |",
        "|---|---|---|---|---|",
        "| A1 | design.md 存在 | 事实 | docs/design.md:1 | |",
        "| A2 | 环境可用 | 推断 | | 待核 |",
        "",
        "## 外部接口核实表", "",
        "| 接口 | 形态 | 依据 | case |",
        "|---|---|---|---|",
        "| echo | 真进程 | docs/design.md:2 | T1,B1 |",
        "",
        "## 未核实风险", "",
        "- A2：环境未实测",
        "",
      ].join("\n")
  );
  sh("git", ["add", "-A"], dir);
  sh("git", ["commit", "-qm", "fixture"], dir);
  return dir;
}

function runCli(dir, args) {
  return sh(process.execPath, [CLI, ...args], dir);
}

function readRun(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".run", `${name}.json`), "utf8"));
}

test("端到端：root→trunk→branch×2→leaf→prune→harvest 全绿并产出报告", () => {
  const dir = makeFixture();
  try {
    for (const args of [["root"], ["trunk"], ["branch", "--name", "save"], ["branch", "--name", "gov"], ["leaf"]]) {
      const r = runCli(dir, args);
      assert.equal(r.status, 0, `${args.join(" ")} 应通过：${r.stdout}${r.stderr}`);
    }
    const findings = [
      { id: "P1", category: "card-01", finding: "写循环中 off 后仍写", status: "fixed", evidence: "修复+回归", mutationEvidence: "摘掉复查门禁，用例转红" },
      { id: "P2", category: "card-03", finding: "并发竞态申报", status: "refuted", evidence: "复现命令输出：未复现" },
      { id: "P3", category: "card-05", finding: "极端环境登记", status: "registered", reason: "触发条件极端且后果有界" },
    ];
    fs.mkdirSync(path.join(dir, ".run"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".run", "prune-findings.json"), JSON.stringify(findings));
    const prune = runCli(dir, ["prune"]);
    assert.equal(prune.status, 0, prune.stderr);
    const harv = runCli(dir, ["harvest"]);
    assert.equal(harv.status, 0, harv.stderr);
    assert.match(harv.stdout, /delivered/);
    const report = fs.readFileSync(path.join(dir, ".run", "report.md"), "utf8");
    assert.match(report, /delivered/);
    assert.match(report, /T1/);
    assert.match(report, /P3/); // registered 进残余风险
    assert.equal(readRun(dir, "harvest").terminal, "delivered");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：事实论据引用不存在的文件:行号", () => {
  const dir = makeFixture({
    factCheck: [
      "# 事实核查", "",
      "## 论据三分类表", "",
      "| 编号 | 论据 | 分类 | 证据 | 说明 |",
      "|---|---|---|---|---|",
      "| A1 | 引用不存在 | 事实 | docs/nope.md:9 | |",
      "",
      "## 外部接口核实表", "",
      "| 接口 | 形态 | 依据 | case |",
      "|---|---|---|---|",
      "| echo | 真进程 | docs/design.md:2 | T1 |",
      "",
    ].join("\n"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.equal(readRun(dir, "root").pass, false);
    assert.match(r.stdout + r.stderr, /nope\.md 不存在/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：接口核实表引用不存在的 case（无 case 覆盖=没验证过的接口）", () => {
  const dir = makeFixture({
    factCheck: [
      "# 事实核查", "",
      "## 论据三分类表", "",
      "| 编号 | 论据 | 分类 | 证据 | 说明 |",
      "|---|---|---|---|---|",
      "| A1 | design 存在 | 事实 | docs/design.md:1 | |",
      "",
      "## 外部接口核实表", "",
      "| 接口 | 形态 | 依据 | case |",
      "|---|---|---|---|",
      "| echo | 真进程 | docs/design.md:2 | X9 |",
      "",
    ].join("\n"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /不存在的 case：X9/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：虚构论据未标作废", () => {
  const dir = makeFixture({
    factCheck: [
      "# 事实核查", "",
      "## 论据三分类表", "",
      "| 编号 | 论据 | 分类 | 证据 | 说明 |",
      "|---|---|---|---|---|",
      "| A1 | 臆断的 API | 虚构 | 想象出来的 | |",
      "| A2 | design 存在 | 事实 | docs/design.md:1 | |",
      "",
      "## 外部接口核实表", "",
      "| 接口 | 形态 | 依据 | case |",
      "|---|---|---|---|",
      "| echo | 真进程 | docs/design.md:2 | T1 |",
      "",
    ].join("\n"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /虚构论据已标作废/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("root 红：验收 case 命令是单测/mock 形态被拒", () => {
  const dir = makeFixture({
    acceptance: [
      "# 实机验收 case", "",
      "| 编号 | 场景 | 命令 | 预期 | 关联 |",
      "|---|---|---|---|---|",
      "| T1 | 单测冒充验收 | node --test test/ | exit:0 | trunk |",
      "",
    ].join("\n"),
  });
  try {
    const r = runCli(dir, ["root"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /单测\/mock 形态/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trunk 红：case 执行失败如实转红", () => {
  const dir = makeFixture({ failingCase: true });
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
    fs.writeFileSync(
      path.join(dir, ".run", "prune-findings.json"),
      JSON.stringify([{ id: "P1", category: "card-01", finding: "x", status: "fixed", evidence: "e" }])
    );
    const r = runCli(dir, ["prune"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /变异验证/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
