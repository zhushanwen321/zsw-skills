// skill-data.test.mjs — skill-data 寻址层独立局部测试
//
// 覆盖（对应实现：workflows/src/skill-data.shared.ts 单一权威源 + 构建器整层注入 +
// scripts/check-workflow-parity.mjs 探针注入不变量）：
//   1. 固定向量：探针对本仓检出根（单源向量表 fixture=repo-root）实跑输出 ==
//      zsw-skills-4ca4846f
//   2. 行为不变自证：单源探针输出与接管前四源内联算法（realpath basename + '-' +
//      sha256[:8] 的独立副本）对多个真实目录逐字节相同（仓根 / 随机 tmp 目录 /
//      含空格路径目录）
//   3. home 探针：输出 == os.homedir()
//   4. 单源形态约束：无 import/export（zcode 产物整层拼接依赖）；探针常量单行且
//      串内无双引号与反斜杠（parity 按行正则提取依赖）
//   5. 检测固定向量（U2，SKILL_DATA_DETECT_VECTORS 四类，fixture 自建用完即删）：
//      tai-ji 实形（.bare 主仓 + 兄弟 worktree + 游离临时 worktree）判 workspace、
//      游离项不进兄弟计数；单仓普通检出判 single 且 slug 与现行算法逐字节一致；
//      游离 worktree 自身形态输出确定；非 git 目录退单仓兜底不抛错。
//      附加固化：.bare 主 worktree 计入兄弟计数（.bare + 仅 1 个兄弟仍判 workspace）
//   6. 真实仓自证（AX5）：本仓检出根寻址输出 form=single、slug=zsw-skills-4ca4846f、
//      与 NODE_PROJECT_SLUG 现行输出逐字节一致
//   7. 真实工作区（存在 ~/Code/tai-ji-workspace 才跑，否则条件跳过）：全部 worktree
//      输出同一 ws-slug
//
// 运行：node scripts/tests/skill-data.test.mjs（或 node --test scripts/tests/skill-data.test.mjs）

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, realpathSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "skill-data.shared.ts");

/** vm 执行单源文件（纯 JS 声明——形态约束见该文件头注），取寻址常量与固定向量 */
function loadLayer() {
  const src = readFileSync(SRC, "utf8");
  const sandbox = { result: null };
  vm.runInNewContext(`${src}\nresult = { NODE_PROBE_HOME, NODE_PROJECT_SLUG, NODE_PROJECT_ADDRESS, SKILL_DATA_SLUG_VECTORS, SKILL_DATA_DETECT_VECTORS };`, sandbox);
  return sandbox.result;
}

/** 接管前四源内联算法的独立副本（逐表达式对齐退役前内联串；仅用于行为不变对账） */
function legacyInlineSlug(projectRoot) {
  const p = realpathSync(projectRoot);
  const h = createHash("sha256").update(p).digest("hex").slice(0, 8);
  return p.split("/").filter(Boolean).pop() + "-" + h;
}

/** node -e 实跑探针（与 workflow 内 world.run node -e 通道同形态：argv 传根） */
function runProbe(probeCode, argv) {
  const r = spawnSync("node", ["-e", probeCode, ...argv], { encoding: "utf8" });
  assert.equal(r.status, 0, `探针应零退出：${r.stderr}`);
  return r.stdout;
}

test("单源形态约束：无 import/export；探针常量单行且串内无双引号与反斜杠", () => {
  const src = readFileSync(SRC, "utf8");
  assert.doesNotMatch(src, /^\s*(?:import|export)\b/m, "skill-data.shared.ts 禁模块语法（zcode 产物整层拼接依赖）");
  // parity 注入不变量的提取正则（与 scripts/check-workflow-parity.mjs extractProbeConst 同形态）
  const extract = (constName) => {
    const m = src.match(new RegExp(`^const ${constName} = "((?:[^"\\\\]|\\\\.)*)";$`, "m"));
    assert.ok(m, `${constName} 应为单行字符串常量（parity 按行提取依赖该形态）`);
    return m[1];
  };
  const layer = loadLayer();
  for (const constName of ["NODE_PROBE_HOME", "NODE_PROJECT_SLUG", "NODE_PROJECT_ADDRESS"]) {
    assert.equal(extract(constName), layer[constName], `正则提取值应与 vm 执行值一致：${constName}`);
  }
});

test("固定向量：探针对本仓检出根输出 zsw-skills-4ca4846f", () => {
  const layer = loadLayer();
  const repoRoot = realpathSync(ROOT);
  for (const vector of layer.SKILL_DATA_SLUG_VECTORS) {
    assert.equal(vector.fixture, "repo-root", `U1 向量表只含单仓检出根向量，出现未知 fixture：${vector.fixture}`);
    const out = runProbe(layer.NODE_PROJECT_SLUG, [repoRoot]);
    assert.equal(out, vector.slug, `向量「${vector.label}」：探针输出应等于期望 slug`);
  }
  assert.ok(
    layer.SKILL_DATA_SLUG_VECTORS.some((v) => v.slug === "zsw-skills-4ca4846f"),
    "向量表须含 zsw-skills 检出根 → zsw-skills-4ca4846f",
  );
});

test("行为不变：单源探针与接管前内联算法对多个真实目录输出逐字节相同", () => {
  const layer = loadLayer();
  const spaceDir = mkdtempSync(join(tmpdir(), "slug probe space dir-")); // 含空格路径
  const plainDir = mkdtempSync(join(tmpdir(), "slug-probe-plain-"));
  try {
    for (const dir of [realpathSync(ROOT), spaceDir, plainDir]) {
      const expected = legacyInlineSlug(dir);
      const out = runProbe(layer.NODE_PROJECT_SLUG, [dir]);
      assert.equal(out, expected, `目录 ${dir}：单源探针输出应与旧内联算法逐字节相同`);
    }
  } finally {
    rmSync(spaceDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("home 探针：输出 == os.homedir()", () => {
  const layer = loadLayer();
  assert.equal(runProbe(layer.NODE_PROBE_HOME, []), homedir());
});

// ── workspace 检测算法（U2）：探针 NODE_PROJECT_ADDRESS 双形态 JSON 契约 ──

/** fixture 仓内 git 命令（构造临时仓库拓扑用；git 在 fixture 内属被测行为，非对本仓操作） */
function gitIn(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `fixture 构造 git ${args.join(" ")} 应成功：${r.stderr}`);
  return r.stdout;
}

/** 空临时目录内建最小普通仓（一个空 commit；分支名跟随环境默认，不写死） */
function makePlainRepo(parent) {
  gitIn(["init", "repo"], parent);
  const repo = join(parent, "repo");
  gitIn(["config", "user.email", "fixture@example.invalid"], repo);
  gitIn(["config", "user.name", "fixture"], repo);
  gitIn(["commit", "--allow-empty", "-m", "init"], repo);
  return repo;
}

/** tai-ji 实形 fixture：workspace 根下 .bare 裸仓 + ≥2 兄弟 worktree + 游离临时目录 worktree */
function buildTaijiLikeFixture(prefix) {
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), `skill-data-detect-${prefix}-`)));
  const seedParent = realpathSync(mkdtempSync(join(tmpdir(), `skill-data-detect-${prefix}-seed-`)));
  gitIn(["clone", "--bare", makePlainRepo(seedParent), join(wsRoot, ".bare")]);
  const bare = join(wsRoot, ".bare");
  gitIn(["worktree", "add", "../main"], bare); // 检出 HEAD 分支，不写死分支名
  gitIn(["worktree", "add", "../dev", "-b", "dev"], bare);
  const strayRoot = realpathSync(mkdtempSync(join(tmpdir(), `skill-data-detect-${prefix}-stray-`)));
  gitIn(["worktree", "add", join(strayRoot, "stray"), "-b", "stray"], bare); // 游离：不在 wsRoot 下
  const dirs = [wsRoot, seedParent, strayRoot];
  return { wsRoot, strayRoot, dirs };
}

/** 断言 single 形态输出的完整契约：恰有 form/slug 两键、slug 与现行算法逐字节一致 */
function assertSingleContract(addr, dir) {
  assert.deepEqual(Object.keys(addr).sort(), ["form", "slug"], "single 形态输出应恰含 form/slug（无 workspaceRoot/worktreeName）");
  assert.equal(addr.form, "single");
  assert.equal(addr.slug, legacyInlineSlug(dir), `slug 应与现行算法逐字节一致：${dir}`);
}

test("检测固定向量：SKILL_DATA_DETECT_VECTORS 四类 fixture 全绿（tai-ji 实形 / 单仓 / 游离 / 非 git）", () => {
  const layer = loadLayer();
  const kinds = layer.SKILL_DATA_DETECT_VECTORS.map((v) => v.kind);
  for (const expected of ["bare-siblings-stray", "plain-checkout", "stray-worktree", "non-git"]) {
    assert.ok(kinds.includes(expected), `向量表须含 kind=${expected}（四类 fixture 登记齐全）`);
  }
  for (const vector of layer.SKILL_DATA_DETECT_VECTORS) {
    assert.ok(
      vector.expectForm === "workspace" || vector.expectForm === "single",
      `向量「${vector.label}」expectForm 须为双形态之一`,
    );
  }

  // 向量 1 tai-ji 实形：兄弟判 workspace、游离项不进 S、.bare 主 worktree 计入
  {
    const { wsRoot, strayRoot, dirs } = buildTaijiLikeFixture("ws");
    try {
      for (const wt of ["main", "dev", ".bare"]) {
        const addr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [join(wsRoot, wt)]));
        assert.equal(addr.form, "workspace", `向量 1（${vector1Label(layer)}）：${wt} 应判 workspace`);
        assert.deepEqual(Object.keys(addr).sort(), ["form", "slug", "workspaceRoot", "worktreeName"], "workspace 形态输出应恰含四键");
        assert.equal(addr.slug, legacyInlineSlug(wsRoot), `${wt} 的 ws-slug 应派生自 workspace 根（兄弟同 slug——AX1）`);
        assert.equal(addr.workspaceRoot, wsRoot);
        assert.equal(addr.worktreeName, wt);
      }
      const stray = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [join(strayRoot, "stray")]));
      assertSingleContract(stray, join(strayRoot, "stray")); // 游离项自身：其父目录下只有自己 → single

      // 附加固化「.bare 主 worktree 计入 S」（最小形：.bare + 仅 1 个兄弟——若实现
      // 漏计 .bare 则 S={only} 只剩 1 → 错判 single，此断言抓住该回归）
      const minRoot = realpathSync(mkdtempSync(join(tmpdir(), "skill-data-detect-min-")));
      const minSeed = realpathSync(mkdtempSync(join(tmpdir(), "skill-data-detect-min-seed-")));
      gitIn(["clone", "--bare", makePlainRepo(minSeed), join(minRoot, ".bare")]);
      gitIn(["worktree", "add", "../only"], join(minRoot, ".bare"));
      try {
        const only = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [join(minRoot, "only")]));
        assert.equal(only.form, "workspace", "最小形（.bare + 1 兄弟）应判 workspace——.bare 主 worktree 计入 S");
        assert.equal(only.slug, legacyInlineSlug(minRoot));
      } finally {
        rmSync(minRoot, { recursive: true, force: true });
        rmSync(minSeed, { recursive: true, force: true });
      }
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  }

  // 向量 2 单仓：普通检出 → single、slug 与现行算法逐字节一致（AX5）
  {
    const plainParent = realpathSync(mkdtempSync(join(tmpdir(), "skill-data-detect-plain-")));
    try {
      const repo = makePlainRepo(plainParent);
      const addr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [repo]));
      assertSingleContract(addr, repo);
    } finally {
      rmSync(plainParent, { recursive: true, force: true });
    }
  }

  // 向量 3 游离 worktree：宿主仓与游离项的形态输出均确定、互不进对方兄弟计数
  {
    const hostParent = realpathSync(mkdtempSync(join(tmpdir(), "skill-data-detect-host-")));
    const outRoot = realpathSync(mkdtempSync(join(tmpdir(), "skill-data-detect-out-")));
    try {
      const host = makePlainRepo(hostParent);
      const stray = join(outRoot, "stray");
      gitIn(["worktree", "add", stray, "-b", "stray"], host);
      const hostAddr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [host]));
      assertSingleContract(hostAddr, host); // 游离项不在宿主父目录下 → 不进 S → 宿主仍 single
      const strayAddr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [stray]));
      assertSingleContract(strayAddr, stray); // 游离项自身：形态确定输出（其父目录下只有自己）
    } finally {
      rmSync(hostParent, { recursive: true, force: true });
      rmSync(outRoot, { recursive: true, force: true });
    }
  }

  // 向量 4 非 git 目录：git 不可用 → 退单仓兜底，探针零退出不抛错
  {
    const nogit = realpathSync(mkdtempSync(join(tmpdir(), "skill-data-detect-nogit-")));
    try {
      const addr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [nogit]));
      assertSingleContract(addr, nogit);
    } finally {
      rmSync(nogit, { recursive: true, force: true });
    }
  }
});

function vector1Label(layer) {
  const v = layer.SKILL_DATA_DETECT_VECTORS.find((x) => x.kind === "bare-siblings-stray");
  return v ? v.label : "tai-ji 实形";
}

test("真实仓自证（AX5）：本仓检出根寻址输出 single、slug 与现行算法逐字节一致", () => {
  const layer = loadLayer();
  const repoRoot = realpathSync(ROOT);
  const addr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [repoRoot]));
  assert.equal(addr.form, "single", "本仓为单仓形态（仅一个 worktree），应判 single");
  assert.equal(addr.slug, "zsw-skills-4ca4846f", "现行输出不变：zsw-skills-4ca4846f");
  assert.equal(addr.slug, runProbe(layer.NODE_PROJECT_SLUG, [repoRoot]), "寻址探针 slug 与现行 slug 探针输出逐字节一致");
  assert.deepEqual(Object.keys(addr).sort(), ["form", "slug"], "single 形态输出不含 workspaceRoot/worktreeName");
});

test("真实工作区（存在 ~/Code/tai-ji-workspace 才跑）：全部 worktree 输出同一 ws-slug", (t) => {
  const ws = join(homedir(), "Code", "tai-ji-workspace");
  if (!existsSync(ws)) {
    t.skip("tai-ji-workspace 不存在——按验收条款跳过（runlog 记录）");
    return;
  }
  const layer = loadLayer();
  const wsReal = realpathSync(ws);
  const addrs = [];
  for (const entry of readdirSync(wsReal, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const dir = join(wsReal, entry.name);
    const addr = JSON.parse(runProbe(layer.NODE_PROJECT_ADDRESS, [dir]));
    if (addr.form === "workspace") addrs.push(addr); // 非 git 的普通子目录判 single，不参与
  }
  assert.ok(addrs.length >= 2, `工作区形态的 worktree 数应 ≥2，实际 ${addrs.length}`);
  const slugs = new Set(addrs.map((a) => a.slug));
  assert.equal(slugs.size, 1, `全部 worktree 的 ws-slug 应一致（AX1），实际 ${[...slugs].join(" / ")}`);
  assert.equal([...slugs][0], legacyInlineSlug(wsReal), "ws-slug 应等于 workspace 根派生值");
  for (const a of addrs) {
    assert.deepEqual(Object.keys(a).sort(), ["form", "slug", "workspaceRoot", "worktreeName"], "workspace 形态输出应恰含四键");
    assert.equal(a.workspaceRoot, wsReal, "workspaceRoot 应为真实工作区根");
    assert.ok(a.worktreeName && !a.worktreeName.includes("/"), `worktreeName 应为子目录名：${a.worktreeName}`);
    assert.ok(
      readdirSync(wsReal, { withFileTypes: true }).some((e) => e.name === a.worktreeName && e.isDirectory()),
      `worktreeName 应为 workspace 根下的真实目录：${a.worktreeName}`,
    );
  }
});
