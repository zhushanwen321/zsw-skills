#!/usr/bin/env node
// ============================================================================
// migrate-skill-data.mjs — skill-data 存量目录一次性迁移（设计 D4 / 实施单元 U6）
//
// 把旧布局（<段>/<单仓 slug>/…，slug 由 worktree 路径派生）里可按 projectRoot
// 重算地址的产物归位到两级布局：
//   tech-design 段 = 工作区级共享 <段>/<ws-slug>/…
//   dev-flow 段    = worktree 级隔离 <段>/<ws-slug>/<worktreeName>/…
// 不可判定项进待人工指派，同名冲突不覆盖、不改名，单仓项目目录零触碰。
//
// 检测算法唯一来源 = skills/self/dev-workflow/workflows/src/skill-data.shared.ts
// 的 NODE_PROJECT_ADDRESS 探针。本脚本不复制算法：启动时读单源文件、vm 取探针串，
// 对每个 projectRoot 以 `node -e <探针> <root>` 实跑（与各 workflow 运行期同一
// 子进程通道）。单源文件按产物形态约束不导出模块符号（zcode 产物禁 import/export），
// 探针串即它的可执行契约。
//
// 两种模式：
//   --check  干跑：只输出报告，不动盘；报告可经 --report 落文件（同时打印到 stdout）
//   --apply  实迁：双信号活动检测任一命中即整体拒绝（退出码 2，提示稍后重试）；
//            成功后生成反向对照表（源 → 目标），作为可逆通道
//
// 扫描范围硬限制：只读或只写 <skill-data 根>/tech-design 与 dev-flow 两段。其余邻居段
// （其他技能段 + workflow-observability 观测段）只做清单快照，作为零触碰证据。
// ============================================================================

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SINGLE_SOURCE = join(
  REPO_ROOT,
  "skills",
  "self",
  "dev-workflow",
  "workflows",
  "src",
  "skill-data.shared.ts",
);
const SEGMENTS = ["tech-design", "dev-flow"];
const JUNK_FILES = new Set([".DS_Store"]);
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const SCAN_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt"]);
const DEFAULT_ACTIVITY_WINDOW_MINUTES = 120;

// ── 命令行 ──────────────────────────────────────────────────────────────────

const USAGE = `用法：node scripts/migrate-skill-data.mjs --check|--apply [选项]

  --check                         干跑：只输出报告，不动盘
  --apply                         实迁：活动检测通过后执行移动并生成反向对照表
  --skill-data-root <目录>        默认 ${join(homedir(), ".agents", "skill-data")}
  --observability-root <目录>     默认 <skill-data 根>/workflow-observability
  --report <文件>                 报告落盘路径（Markdown；同目录另写 .json 机读报告与反向对照表）
  --activity-window-minutes <n>   活动检测窗口，默认 ${DEFAULT_ACTIVITY_WINDOW_MINUTES}
  --now <ISO 时间>                活动检测基准时刻（测试可注入）
  --known-misfile <路径>          已知误写产物（可重复；只登记去留，不做通用扫描）
  --help                          显示本说明

退出码：0 成功；2 活动检测命中、实迁被拒；1 参数或环境错误。`;

function parseArgs(argv) {
  const opts = {
    mode: null,
    skillDataRoot: join(homedir(), ".agents", "skill-data"),
    observabilityRoot: null,
    report: null,
    activityWindowMinutes: DEFAULT_ACTIVITY_WINDOW_MINUTES,
    now: null,
    knownMisfiles: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`选项 ${arg} 缺少取值。恢复动作：补齐取值后重发（--help 查看用法）`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--check":
        setMode(opts, "check");
        break;
      case "--apply":
        setMode(opts, "apply");
        break;
      case "--skill-data-root":
        opts.skillDataRoot = resolve(next());
        break;
      case "--observability-root":
        opts.observabilityRoot = resolve(next());
        break;
      case "--report":
        opts.report = resolve(next());
        break;
      case "--activity-window-minutes": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("--activity-window-minutes 须为正数。恢复动作：改传正整数后重发");
        }
        opts.activityWindowMinutes = n;
        break;
      }
      case "--now": {
        const t = Date.parse(next());
        if (Number.isNaN(t)) throw new Error("--now 须为可解析的 ISO 时间。恢复动作：改传 ISO 时间后重发");
        opts.now = t;
        break;
      }
      case "--known-misfile":
        opts.knownMisfiles.push(resolve(next()));
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${arg}。恢复动作：用 --help 查看可用选项后重发`);
    }
  }
  if (opts.mode === null) {
    throw new Error("须显式指定 --check（干跑）或 --apply（实迁）。恢复动作：先跑 --check 读报告");
  }
  opts.observabilityRoot = opts.observabilityRoot ?? join(opts.skillDataRoot, "workflow-observability");
  return opts;
}

function setMode(opts, mode) {
  if (opts.mode !== null && opts.mode !== mode) {
    throw new Error("--check 与 --apply 互斥。恢复动作：只保留一个模式后重发");
  }
  opts.mode = mode;
}

// ── 检测算法单源加载（不复制算法）───────────────────────────────────────────

function loadSingleSource() {
  if (!existsSync(SINGLE_SOURCE)) {
    throw new Error(
      `检测算法单源不存在：${SINGLE_SOURCE}。恢复动作：确认在本仓检出根下运行，或先补齐单源文件`,
    );
  }
  const src = readFileSync(SINGLE_SOURCE, "utf8");
  if (!/const NODE_PROJECT_ADDRESS = "/.test(src)) {
    throw new Error(
      `${SINGLE_SOURCE} 未找到 NODE_PROJECT_ADDRESS 常量。恢复动作：确认单源仍是寻址算法权威源（设计 D5）后重发`,
    );
  }
  const sandbox = { result: null };
  vm.runInNewContext(`${src}\nresult = { NODE_PROJECT_ADDRESS, NODE_PROJECT_SLUG };`, sandbox, {
    filename: SINGLE_SOURCE,
  });
  const layer = sandbox.result;
  if (typeof layer.NODE_PROJECT_ADDRESS !== "string" || layer.NODE_PROJECT_ADDRESS === "") {
    throw new Error("单源探针 NODE_PROJECT_ADDRESS 为空。恢复动作：检查单源文件后重发");
  }
  return layer;
}

function makeDetector(layer) {
  const cache = new Map();
  const legacyCache = new Map();
  const detect = (root) => {
    if (cache.has(root)) return cache.get(root);
    const r = spawnSync(process.execPath, ["-e", layer.NODE_PROJECT_ADDRESS, root], { encoding: "utf8" });
    let addr;
    if (r.status !== 0) {
      addr = { error: (r.stderr || `退出码 ${r.status}`).trim().split("\n").slice(-3).join(" ") };
    } else {
      try {
        addr = JSON.parse(r.stdout);
      } catch {
        addr = { error: `探针输出非 JSON：${String(r.stdout).slice(0, 120)}` };
      }
    }
    cache.set(root, addr);
    return addr;
  };
  /** 旧版本单仓 slug（现行算法原样输出）：用于识别「目录名 = 哪个 projectRoot 的旧 slug」 */
  const legacySlug = (root) => {
    if (legacyCache.has(root)) return legacyCache.get(root);
    if (!existsSync(root)) return null;
    const r = spawnSync(process.execPath, ["-e", layer.NODE_PROJECT_SLUG, root], { encoding: "utf8" });
    const slug = r.status === 0 ? r.stdout : null;
    legacyCache.set(root, slug);
    return slug;
  };
  return { detect, legacySlug };
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function createScan(skillDataRoot) {
  return {
    root: skillDataRoot,
    segments: [],
    neighbors: [],
    segmentMissing: [],
  };
}

function scanSkillData(scan) {
  for (const segment of SEGMENTS) {
    const segAbs = join(scan.root, segment);
    const record = { name: segment, abs: segAbs, slugDirs: [], ignored: [] };
    scan.segments.push(record);
    if (!existsSync(segAbs)) {
      scan.segmentMissing.push(segment);
      continue;
    }
    for (const entry of readdirSync(segAbs, { withFileTypes: true })) {
      const abs = join(segAbs, entry.name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (entry.name.startsWith(".") || st.isSymbolicLink() || !st.isDirectory()) {
        record.ignored.push({ name: entry.name, why: "非目录或隐藏条目（不参与迁移）" });
        continue;
      }
      const slugDir = { segment, name: entry.name, abs, files: [], junk: [], unreadable: [] };
      collectFiles(slugDir, abs, "");
      slugDir.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      record.slugDirs.push(slugDir);
    }
    record.slugDirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  scan.neighbors = snapshotNeighbors(scan.root);
}

function collectFiles(slugDir, dirAbs, relPrefix) {
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    slugDir.unreadable.push({ rel: relPrefix || ".", error: String(err.message || err) });
    return;
  }
  for (const entry of entries) {
    const abs = join(dirAbs, entry.name);
    const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      slugDir.unreadable.push({ rel, error: String(err.message || err) });
      continue;
    }
    if (st.isSymbolicLink()) {
      slugDir.files.push({
        rel,
        abs,
        isSymlink: true,
        size: 0,
        mtimeMs: 0,
        selfRoots: [],
        invalidRoots: [],
      });
      continue;
    }
    if (st.isDirectory()) {
      collectFiles(slugDir, abs, rel);
      continue;
    }
    if (JUNK_FILES.has(entry.name)) {
      slugDir.junk.push(rel);
      continue;
    }
    const rec = {
      rel,
      abs,
      isSymlink: false,
      size: st.size,
      mtimeMs: st.mtimeMs,
      selfRoots: [],
      invalidRoots: [],
    };
    const extracted = extractProjectRoots(rec);
    rec.selfRoots = extracted.roots;
    rec.invalidRoots = extracted.invalid;
    slugDir.files.push(rec);
  }
}

const PROJECT_ROOT_RE = /"projectRoot"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function extractProjectRoots(file) {
  if (file.size > MAX_SCAN_BYTES) return { roots: [], invalid: [] };
  const ext = extname(file.rel).toLowerCase();
  if (!SCAN_EXTENSIONS.has(ext)) return { roots: [], invalid: [] };
  let text;
  try {
    text = readFileSync(file.abs, "utf8");
  } catch {
    return { roots: [], invalid: [] };
  }
  const raw = new Set();
  if (ext === ".json") {
    try {
      collectProjectRoots(JSON.parse(text), raw);
    } catch {
      // 非法 JSON 退回文本正则（.bak / 手工片段仍可能有可读证据）
    }
  }
  if (raw.size === 0) {
    for (const match of text.matchAll(PROJECT_ROOT_RE)) {
      raw.add(unescapeJsonFragment(match[1]));
    }
  }
  const roots = new Set();
  const invalid = new Set();
  for (const value of raw) {
    const normalized = normalizeRootPath(value);
    if (normalized === null) invalid.add(value);
    else roots.add(normalized);
  }
  return { roots: [...roots].sort(), invalid: [...invalid].sort() };
}

function collectProjectRoots(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectProjectRoots(item, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "projectRoot" && typeof value === "string") out.add(value);
    else collectProjectRoots(value, out);
  }
}

function unescapeJsonFragment(s) {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\\//g, "/");
}

/**
 * projectRoot 归一化：展开 `~/`、收敛重复斜杠、去掉尾部斜杠。
 * 不做 realpath——已被删除的 worktree 路径必须保持原样才能进父目录检验。
 * 返回 null 表示形态非法（相对路径 / 空串），进报告证据列。
 */
function normalizeRootPath(raw) {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (p === "") return null;
  p = p.replace(/\\\//g, "/");
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) return null;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

function snapshotNeighbors(skillDataRoot) {
  const out = [];
  if (!existsSync(skillDataRoot)) return out;
  for (const entry of readdirSync(skillDataRoot, { withFileTypes: true })) {
    if (SEGMENTS.includes(entry.name)) continue;
    const abs = join(skillDataRoot, entry.name);
    const snap = {
      name: entry.name,
      abs,
      kind: entry.isDirectory() ? "dir" : "file",
      files: 0,
      newestMtime: 0,
    };
    if (entry.isDirectory()) {
      const stack = [abs];
      while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          let st;
          try {
            st = lstatSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) stack.push(p);
          else {
            snap.files += 1;
            if (st.mtimeMs > snap.newestMtime) snap.newestMtime = st.mtimeMs;
          }
        }
      }
    }
    out.push(snap);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── 归属判定（文件级 projectRoot + 结构锚点）─────────────────────────────────

function dirRelOf(rel) {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

/**
 * 给单个 slug 目录内的每个文件定 projectRoot：
 *   1. 文件自身恰含一个 projectRoot → 用它（最强证据）
 *   2. 自身没有 → 由所在目录的子树唯一 projectRoot 继承（子树内证据一致，无歧义）
 *   3. 仍没有 → 由 basename 家族锚继承（根级文件 `<名>.*` 或有唯一 projectRoot 的子目录 `<名>/`）
 *   4. 仍没有 → 全目录唯一 projectRoot 时归它
 *   5. 仍没有 / 证据互相矛盾 → 待人工指派
 *
 * 规则 2 只看文件所在目录的整个子树、不向父目录扩散——父目录里恰好只有一个
 * 根级锚文件就把它认作所有后代产物的来源，会把别人的设计包整批搬错（实测
 * Stock 目录里混有另一工作区的 impl-plan，根级锚规则曾把 Stock 全部产物判给该工作区）。
 */
function attributeSlugDir(slugDir, legacySlug) {
  const files = slugDir.files;
  const directRoots = new Map(); // dirRel -> { roots:Set, anchors:string[] }
  const familyAnchors = []; // { stem, root, anchor }

  for (const f of files) {
    if (f.isSymlink || f.selfRoots.length !== 1) continue;
    const d = dirRelOf(f.rel);
    const rec = directRoots.get(d) ?? { roots: new Set(), anchors: [] };
    rec.roots.add(f.selfRoots[0]);
    rec.anchors.push(f.rel);
    directRoots.set(d, rec);
    if (d === "") {
      familyAnchors.push({ stem: basename(f.rel).split(".")[0], root: f.selfRoots[0], anchor: f.rel });
    }
  }

  // 子树 projectRoot 集合：目录（或顶层首段）下全部自身证据的并集
  const subtreeCache = new Map();
  const subtreeRoots = (dirOrFirstSeg) => {
    if (subtreeCache.has(dirOrFirstSeg)) return subtreeCache.get(dirOrFirstSeg);
    const set = new Set();
    for (const f of files) {
      if (f.isSymlink || f.selfRoots.length !== 1) continue;
      if (
        dirOrFirstSeg === "" ||
        f.rel === dirOrFirstSeg ||
        f.rel.startsWith(`${dirOrFirstSeg}/`)
      ) {
        set.add(f.selfRoots[0]);
      }
    }
    subtreeCache.set(dirOrFirstSeg, set);
    return set;
  };

  // 子目录锚：子树内 projectRoot 唯一的目录以目录名为家族键
  const firstSegs = new Set(files.filter((f) => f.rel.includes("/")).map((f) => f.rel.split("/")[0]));
  for (const firstSeg of firstSegs) {
    const roots = subtreeRoots(firstSeg);
    if (roots.size === 1) {
      familyAnchors.push({ stem: firstSeg, root: [...roots][0], anchor: `${firstSeg}/` });
    }
  }

  const allSlugRoots = new Set();
  for (const f of files) {
    if (f.isSymlink || f.selfRoots.length !== 1) continue;
    allSlugRoots.add(f.selfRoots[0]);
  }

  // 旧目录名证据：旧布局的 slug 目录是按某个 projectRoot 的单仓 slug 命名的。
  // 目录名恰好等于某 projectRoot 的旧 slug 时，该目录的无归属文件归它。
  const legacyOwners = [];
  for (const root of allSlugRoots) {
    const slug = legacySlug(root);
    if (slug && slug === slugDir.name) legacyOwners.push(root);
  }

  for (const f of files) {
    if (f.isSymlink) {
      f.attribution = { manualReason: "symlink", detail: "符号链接不自动迁移（目标可能在迁移范围外）" };
      continue;
    }
    if (f.selfRoots.length > 1) {
      f.attribution = {
        manualReason: "ambiguous-roots",
        detail: `文件内出现多个不同 projectRoot：${f.selfRoots.join("、")}`,
      };
      continue;
    }
    if (f.selfRoots.length === 1) {
      f.attribution = { root: f.selfRoots[0], via: "文件自身 projectRoot" };
      continue;
    }

    // 规则 2：所在目录的子树唯一 projectRoot
    const ownDir = dirRelOf(f.rel);
    const ownSubtree = subtreeRoots(ownDir);
    if (ownSubtree.size === 1) {
      const anchor = directRoots.get(ownDir)?.anchors[0] ?? `${ownDir || "."}/`;
      f.attribution = { root: [...ownSubtree][0], via: `同目录子树唯一 projectRoot（锚文件 ${anchor}）` };
      continue;
    }

    // 规则 3：basename 家族锚
    const firstSeg = f.rel.split("/")[0];
    const matches = familyAnchors.filter((a) => firstSeg === a.stem || firstSeg.startsWith(`${a.stem}.`));
    if (matches.length > 0) {
      const maxStem = Math.max(...matches.map((a) => a.stem.length));
      const winners = matches.filter((a) => a.stem.length === maxStem);
      const roots = new Set(winners.map((a) => a.root));
      if (roots.size === 1) {
        f.attribution = { root: [...roots][0], via: `basename 家族锚 ${winners[0].anchor}` };
        continue;
      }
      f.attribution = {
        manualReason: "ambiguous-roots",
        detail: `basename 家族锚指向多个 projectRoot：${[...roots].join("、")}`,
      };
      continue;
    }

    // 规则 3.5：旧目录名对应该 projectRoot 的单仓 slug（旧布局的创建者证据）
    if (legacyOwners.length === 1) {
      f.attribution = {
        root: legacyOwners[0],
        via: `旧目录名 ${slugDir.name} 对应该 projectRoot 的单仓 slug`,
      };
      continue;
    }

    // 规则 4：全目录唯一 projectRoot
    if (allSlugRoots.size === 1) {
      f.attribution = { root: [...allSlugRoots][0], via: "全目录唯一 projectRoot" };
      continue;
    }

    f.attribution = {
      manualReason: "no-project-root",
      detail:
        allSlugRoots.size === 0
          ? "目录内没有任何 projectRoot 证据"
          : `目录内存在 ${allSlugRoots.size} 个不同 projectRoot，无结构锚点可归属`,
    };
  }
}

// ── 目标地址计算 ────────────────────────────────────────────────────────────

function planMigration(scan, detector) {
  const deletedCache = new Map();

  const resolveDeleted = (root) => {
    const parent = dirname(root);
    if (!existsSync(parent)) {
      return { status: "unresolved", reason: `worktree 与父目录均不存在：${parent}` };
    }
    let parentReal;
    try {
      parentReal = realpathSync(parent);
    } catch {
      return { status: "unresolved", reason: `父目录不可解析：${parent}` };
    }
    if (deletedCache.has(parentReal)) {
      const cached = deletedCache.get(parentReal);
      return cached.status === "workspace" ? { ...cached, worktreeName: basename(root) } : cached;
    }
    const candidates = [];
    let children;
    try {
      children = readdirSync(parentReal, { withFileTypes: true });
    } catch {
      children = [];
    }
    for (const entry of children) {
      const childAbs = join(parentReal, entry.name);
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const addr = detector.detect(childAbs);
      if (addr.error) continue;
      if (addr.form === "workspace" && resolve(addr.workspaceRoot) === parentReal) {
        candidates.push(addr);
      }
    }
    const slugs = [...new Set(candidates.map((c) => c.slug))].sort();
    let result;
    if (slugs.length === 1) {
      result = {
        status: "workspace",
        slug: slugs[0],
        workspaceRoot: parentReal,
        evidence: `worktree 已删除；父目录下仍检出 ${candidates.length} 个同仓 worktree`,
      };
    } else if (slugs.length === 0) {
      result = {
        status: "unresolved",
        reason: `worktree 已删除，且父目录 ${parentReal} 下同仓 worktree 不足 2 个（检验不出工作区）`,
      };
    } else {
      result = {
        status: "unresolved",
        reason: `worktree 已删除，父目录 ${parentReal} 下出现多个候选工作区：${slugs.join("、")}`,
      };
    }
    deletedCache.set(parentReal, result);
    return result.status === "workspace" ? { ...result, worktreeName: basename(root) } : result;
  };

  const resolveForm = (root) => {
    if (existsSync(root)) {
      const addr = detector.detect(root);
      if (addr.error) return { status: "error", reason: `检测探针失败：${addr.error}` };
      if (addr.form === "single" || addr.form === "workspace") return { status: "ok", addr };
      return { status: "error", reason: `探针输出未知形态：${JSON.stringify(addr)}` };
    }
    return resolveDeleted(root);
  };

  const canonicalRoot = (segment, addr) => {
    const base = join(scan.root, segment, addr.slug);
    if (addr.form === "workspace" && segment === "dev-flow") return join(base, addr.worktreeName);
    return base;
  };

  /** rel 已含 worktreeName 段（新布局内再次扫描）时不再重复拼接 */
  const canonicalFile = (segment, addr, slugDirName, rel) => {
    const base = join(scan.root, segment, addr.slug);
    if (addr.form === "workspace" && segment === "dev-flow") {
      const wt = addr.worktreeName;
      if (slugDirName === addr.slug && (rel === wt || rel.startsWith(`${wt}/`))) {
        return join(base, rel);
      }
      return join(base, wt, rel);
    }
    return join(base, rel);
  };

  for (const segment of scan.segments) {
    for (const slugDir of segment.slugDirs) {
      attributeSlugDir(slugDir, detector.legacySlug);
      for (const file of slugDir.files) {
        file.sourceRel = relative(scan.root, file.abs).split(sep).join("/");
        if (file.attribution?.manualReason) {
          file.manualReason = file.attribution.manualReason;
          file.detail = file.attribution.detail ?? "";
          continue;
        }
        if (!file.attribution || !file.attribution.root) continue;
        const resolved = resolveForm(file.attribution.root);
        file.resolved = resolved;
        if (resolved.status === "unresolved" || resolved.status === "error") {
          file.manualReason = resolved.status === "error" ? "probe-error" : "deleted-unresolved";
          file.detail = resolved.reason;
          continue;
        }
        const addr = resolved.addr ?? {
          form: "workspace",
          slug: resolved.slug,
          workspaceRoot: resolved.workspaceRoot,
          worktreeName: resolved.worktreeName,
        };
        file.form = addr.form;
        if (resolved.status === "workspace") file.evidence = resolved.evidence;
        const target = canonicalFile(segment.name, addr, slugDir.name, file.rel);
        if (!isWithinScope(scan.root, target)) {
          file.manualReason = "target-outside-scope";
          file.detail = `目标路径越出 tech-design/dev-flow 两段：${target}`;
          continue;
        }
        file.target = target;
        file.targetRel = relative(scan.root, target).split(sep).join("/");
        file.targetRoot = relative(scan.root, canonicalRoot(segment.name, addr)).split(sep).join("/");
        file.alreadyInPlace = target === file.abs;
      }
    }
  }
}

function isWithinScope(skillDataRoot, target) {
  const rel = relative(skillDataRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  const first = rel.split(sep)[0];
  return SEGMENTS.includes(first);
}

// ── 同名冲突（不覆盖、不改名）──────────────────────────────────────────────

function markConflicts(scan) {
  const planned = [];
  for (const segment of scan.segments) {
    for (const slugDir of segment.slugDirs) {
      for (const file of slugDir.files) {
        if (file.target && !file.alreadyInPlace && !file.manualReason) {
          planned.push({ segment: segment.name, file });
        }
      }
    }
  }
  const byTarget = new Map();
  for (const { file } of planned) {
    const list = byTarget.get(file.target) ?? [];
    list.push(file);
    byTarget.set(file.target, list);
  }
  const conflicts = [];
  for (const { segment, file } of planned) {
    const others = byTarget.get(file.target).filter((x) => x !== file);
    const targetExists = existsSync(file.target);
    if (others.length === 0 && !targetExists) continue;
    const sides = [file.sourceRel];
    if (targetExists) sides.push(`目标已存在：${file.targetRel}`);
    for (const other of others) sides.push(`同目标来源：${other.sourceRel}`);
    file.manualReason = "same-name-conflict";
    file.detail = sides.join("；");
    conflicts.push({
      segment,
      path: file.sourceRel,
      targetRel: file.targetRel,
      detail: sides.join("；"),
    });
  }
  return conflicts;
}

// ── 活动检测（双信号）──────────────────────────────────────────────────────

function evaluateActivity(scan, opts, now) {
  const cutoff = now - opts.activityWindowMinutes * 60 * 1000;
  const observabilityHits = [];
  if (existsSync(opts.observabilityRoot)) {
    const stack = [opts.observabilityRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(abs);
        else if (entry.name.endsWith(".jsonl") && st.mtimeMs >= cutoff) {
          observabilityHits.push({ path: abs, mtimeMs: st.mtimeMs });
        }
      }
    }
  }
  observabilityHits.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const recentDirs = [];
  for (const segment of scan.segments) {
    for (const slugDir of segment.slugDirs) {
      const hasMoves = slugDir.files.some((f) => f.target && !f.alreadyInPlace && !f.manualReason);
      if (!hasMoves) continue;
      const recent = slugDir.files.filter((f) => !f.isSymlink && f.mtimeMs >= cutoff);
      if (recent.length > 0) {
        recentDirs.push({
          segment: segment.name,
          slugDir: slugDir.name,
          files: recent.length,
          newest: recent.reduce((a, b) => (a.mtimeMs >= b.mtimeMs ? a : b)),
        });
      }
    }
  }
  return {
    windowMinutes: opts.activityWindowMinutes,
    cutoff,
    observabilityHits,
    recentDirs,
    blocking: observabilityHits.length > 0 || recentDirs.length > 0,
  };
}

// ── 汇总与建议档 ─────────────────────────────────────────────────────────────

function buildSummary(scan) {
  const auto = [];
  const manual = [];
  const dirs = [];
  let fileCount = 0;
  let inPlaceCount = 0;
  let singleInPlaceCount = 0;

  for (const segment of scan.segments) {
    for (const slugDir of segment.slugDirs) {
      const row = {
        segment: segment.name,
        slugDir: slugDir.name,
        files: slugDir.files.length,
        auto: 0,
        manual: 0,
        inPlace: 0,
        singleFiles: 0,
        singleInPlace: 0,
        targets: [],
        forms: new Set(),
      };
      for (const file of slugDir.files) {
        fileCount += 1;
        if (file.form) row.forms.add(file.form);
        if (file.form === "single") row.singleFiles += 1;
        if (file.manualReason) {
          manual.push({
            segment: segment.name,
            path: file.sourceRel,
            reason: file.manualReason,
            detail: file.detail ?? "",
          });
          row.manual += 1;
        } else if (file.target && file.alreadyInPlace) {
          row.inPlace += 1;
          inPlaceCount += 1;
          if (file.form === "single") {
            singleInPlaceCount += 1;
            row.singleInPlace += 1;
          }
        } else if (file.target) {
          auto.push({
            segment: segment.name,
            from: file.abs,
            fromRel: file.sourceRel,
            to: file.target,
            toRel: file.targetRel,
            form: file.form ?? "",
            via: file.attribution?.via ?? "",
            evidence: file.evidence ?? "",
          });
          row.auto += 1;
          if (file.targetRoot && !row.targets.includes(file.targetRoot)) row.targets.push(file.targetRoot);
        } else {
          // 防御：未归类文件不得静默丢弃（正常路径不会到这里）
          manual.push({
            segment: segment.name,
            path: file.sourceRel,
            reason: "unclassified",
            detail: "脚本未归类（内部一致性检查失败）",
          });
          row.manual += 1;
        }
      }
      row.targets.sort();
      dirs.push(row);
    }
  }
  return { auto, manual, dirs, fileCount, inPlaceCount, singleInPlaceCount };
}

function buildSuggestions(scan, summary, detector) {
  const manualBySlug = new Map();
  for (const item of summary.manual) {
    const slugDir = item.path.split("/")[1];
    const key = `${item.segment}/${slugDir}`;
    const list = manualBySlug.get(key) ?? [];
    list.push(item);
    manualBySlug.set(key, list);
  }
  const observedRoots = collectObservedRoots(scan);
  const workspaces = discoverWorkspaces(observedRoots, detector);
  const suggestions = [];
  for (const [key, items] of manualBySlug.entries()) {
    const [segment, slugDir] = key.split("/");
    const relevant = items.filter((x) => x.reason === "no-project-root" || x.reason === "deleted-unresolved");
    if (relevant.length === 0) continue;
    const familyKey = slugFamilyKey(slugDir);
    suggestions.push({
      segment,
      slugDir,
      familyKey,
      manualCount: relevant.length,
      candidates: workspaceCandidates(workspaces, familyKey, slugDir).filter((c) => c.matched),
    });
  }
  // 家族复核提示：同名家族横跨多个工作区时，即使文件可自动归位也列出候选
  for (const segment of scan.segments) {
    for (const slugDir of segment.slugDirs) {
      const familyKey = slugFamilyKey(slugDir.name);
      const matched = workspaceCandidates(workspaces, familyKey, slugDir.name).filter((c) => c.matched);
      if (matched.length < 2) continue;
      if (suggestions.some((s) => s.segment === segment.name && s.slugDir === slugDir.name)) continue;
      suggestions.push({
        segment: segment.name,
        slugDir: slugDir.name,
        familyKey,
        manualCount: 0,
        candidates: matched,
        advisory: true,
      });
    }
  }
  suggestions.sort((a, b) => (`${a.segment}/${a.slugDir}` < `${b.segment}/${b.slugDir}` ? -1 : 1));
  return suggestions;
}

function collectObservedRoots(scan) {
  const roots = new Set();
  for (const segment of scan.segments) {
    for (const slugDir of segment.slugDirs) {
      for (const file of slugDir.files) {
        if (file.attribution?.root) roots.add(file.attribution.root);
      }
    }
  }
  return [...roots].sort();
}

function discoverWorkspaces(roots, detector) {
  const parents = new Set(roots.map((r) => dirname(r)));
  const workspaces = new Map();
  for (const parent of [...parents].sort()) {
    if (!existsSync(parent)) continue;
    let parentReal;
    try {
      parentReal = realpathSync(parent);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = readdirSync(parentReal, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(parentReal, entry.name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const addr = detector.detect(abs);
      if (addr.error) continue;
      if (addr.form !== "workspace" || resolve(addr.workspaceRoot) !== parentReal) continue;
      const rec = workspaces.get(parentReal) ?? {
        workspaceRoot: parentReal,
        slug: addr.slug,
        members: new Set(),
      };
      rec.members.add(entry.name);
      workspaces.set(parentReal, rec);
    }
  }
  return [...workspaces.values()].map((w) => ({ ...w, members: [...w.members].sort() }));
}

function slugFamilyKey(slugDirName) {
  return slugDirName.replace(/-[0-9a-f]{8}$/, "");
}

function workspaceCandidates(workspaces, familyKey, slugDirName) {
  return workspaces.map((ws) => {
    const exactMember = ws.members.includes(familyKey);
    const prefixMembers = ws.members.filter(
      (m) => m === familyKey || m.startsWith(`${familyKey}-`) || m === slugDirName,
    );
    let evidence = "";
    if (exactMember) evidence = `工作区成员存在同名 worktree：${familyKey}/`;
    else if (prefixMembers.length > 0) evidence = `工作区成员名匹配：${prefixMembers.join("、")}`;
    return {
      workspaceRoot: ws.workspaceRoot,
      slug: ws.slug,
      members: ws.members,
      evidence,
      matched: evidence !== "",
    };
  });
}

// ── 报告渲染 ───────────────────────────────────────────────────────────────

function renderReport({ opts, scan, summary, suggestions, conflicts, activity, knownMisfiles, applyResult, now }) {
  const lines = [];
  const modeLabel = opts.mode === "check" ? "--check 干跑（不动盘）" : "--apply 实迁";
  lines.push(`# skill-data 存量迁移报告（${modeLabel}）`);
  lines.push("");
  lines.push(`- 生成时间：${new Date(now).toISOString()}`);
  lines.push(`- skill-data 根：${scan.root}`);
  lines.push(`- 观测段：${opts.observabilityRoot}`);
  lines.push(`- 检测算法来源：${SINGLE_SOURCE}（NODE_PROJECT_ADDRESS 探针，运行时读取，不复制算法）`);
  lines.push(`- 活动检测窗口：${activity.windowMinutes} 分钟`);
  lines.push("");

  lines.push("## 汇总");
  lines.push("");
  lines.push("| 项 | 数量 |");
  lines.push("| --- | --- |");
  lines.push(`| 扫描 slug 目录 | ${scan.segments.reduce((n, s) => n + s.slugDirs.length, 0)} |`);
  lines.push(`| 扫描产物文件 | ${summary.fileCount} |`);
  lines.push(`| 自动归位文件 | ${summary.auto.length} |`);
  lines.push(`| 已在终态（零移动） | ${summary.inPlaceCount}（其中 single 形态 ${summary.singleInPlaceCount}） |`);
  lines.push(`| 待人工指派 | ${summary.manual.length} |`);
  lines.push(`| 同名冲突 | ${conflicts.length} |`);
  lines.push(`| 建议档条目 | ${suggestions.length} |`);
  lines.push(`| 活动检测阻断目录 | ${activity.recentDirs.length} |`);
  if (applyResult) {
    lines.push(`| 实迁已移动文件 | ${applyResult.moved} |`);
    lines.push(`| 实迁失败 | ${applyResult.failed.length} |`);
  }
  lines.push("");

  lines.push("## 1. 自动归位（文件级对照表）");
  lines.push("");
  if (summary.auto.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| # | 源文件 | 目标路径 | 形态 | projectRoot 依据 |");
    lines.push("| --- | --- | --- | --- | --- |");
    summary.auto.forEach((row, i) => {
      lines.push(
        `| ${i + 1} | ${row.fromRel} | ${row.toRel} | ${row.form}${row.evidence ? `（${row.evidence}）` : ""} | ${row.via} |`,
      );
    });
  }
  lines.push("");
  lines.push("### 1.1 目录归位摘要");
  lines.push("");
  lines.push("| 段 | 源目录 | 目标目录 | 自动文件数 | 人工文件数 | 方式 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const d of summary.dirs) {
    if (d.auto === 0 && d.manual === 0) continue;
    const targets = d.targets.length === 0 ? "—" : d.targets.join("；");
    const mode =
      d.targets.length > 1
        ? "混源，文件级拆分"
        : d.auto > 0
          ? d.manual > 0
            ? "单目标（部分文件留待人工）"
            : "单目标（可目录级整体移动）"
          : "—";
    lines.push(`| ${d.segment} | ${d.segment}/${d.slugDir} | ${targets} | ${d.auto} | ${d.manual} | ${mode} |`);
  }
  lines.push("");

  lines.push("## 2. 建议档（basename 家族项，只列候选不定案）");
  lines.push("");
  if (suggestions.length === 0) {
    lines.push("（无）");
  } else {
    suggestions.forEach((s, index) => {
      const tag = s.advisory
        ? "（家族复核提示：文件已可按 projectRoot 自动归位，候选仅供人工复核）"
        : "（存在无法归属的文件，逐项裁决）";
      lines.push(`### 2.${index + 1} ${s.segment}/${s.slugDir}（家族键：${s.familyKey}）${tag}`);
      lines.push("");
      lines.push(`待裁决文件数：${s.manualCount}`);
      lines.push("");
      lines.push("| 候选工作区 | ws-slug | 证据 |");
      lines.push("| --- | --- | --- |");
      if (s.candidates.length === 0) lines.push("| （无候选） | — | 已发现工作区均无同名成员 |");
      for (const c of s.candidates) {
        lines.push(`| ${c.workspaceRoot} | ${c.slug} | ${c.evidence || "无 basename 匹配项（低置信候选）"} |`);
      }
      lines.push("");
    });
  }

  lines.push("## 3. 待人工指派");
  lines.push("");
  if (summary.manual.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| # | 源路径 | 原因 | 证据 / 两侧路径 |");
    lines.push("| --- | --- | --- | --- |");
    summary.manual.forEach((row, i) => {
      lines.push(`| ${i + 1} | ${row.path} | ${manualReasonLabel(row.reason)} | ${escapeCell(row.detail)} |`);
    });
  }
  lines.push("");
  lines.push("### 3.1 同名冲突明细（不覆盖、不改名）");
  lines.push("");
  if (conflicts.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| 源文件 | 目标路径 | 冲突方 |");
    lines.push("| --- | --- | --- |");
    for (const c of conflicts) {
      lines.push(`| ${c.path} | ${c.targetRel} | ${escapeCell(c.detail)} |`);
    }
  }
  lines.push("");
  lines.push("### 3.2 已知误写产物（静态清单，去留待人工裁决）");
  lines.push("");
  if (knownMisfiles.length === 0) {
    lines.push("（本次未提供 --known-misfile）");
  } else {
    lines.push("| 路径 | 存在 | 大小（字节） | 最新写入 |");
    lines.push("| --- | --- | --- | --- |");
    for (const k of knownMisfiles) {
      lines.push(
        `| ${k.path} | ${k.exists ? "是" : "否"} | ${k.exists ? k.size : "—"} | ${k.exists ? new Date(k.mtimeMs).toISOString() : "—"} |`,
      );
    }
  }
  lines.push("");

  lines.push("## 4. 零触碰清单");
  lines.push("");
  lines.push("### 4.1 目录零触碰状态（终态即当前位置的文件）");
  lines.push("");
  const dirRows = summary.dirs.filter((d) => d.files > 0);
  const fullyInPlace = dirRows.filter((d) => d.inPlace === d.files);
  lines.push(
    `- 单仓形态零移动文件：${summary.singleInPlaceCount} 个（路径不变，AX5 零触碰）`,
  );
  lines.push(
    `- 全目录零移动：${fullyInPlace.length === 0 ? "（无）" : fullyInPlace.map((d) => `${d.segment}/${d.slugDir}`).join("、")}`,
  );
  const singleDirs = dirRows.filter((d) => d.singleFiles > 0);
  if (singleDirs.length > 0) {
    lines.push(
      `- 单仓形态目录明细：${singleDirs
        .map(
          (d) =>
            `${d.segment}/${d.slugDir}（single 文件 ${d.singleFiles} 个，零移动 ${d.singleInPlace} 个${
              d.singleFiles > d.singleInPlace ? `，其余 ${d.singleFiles - d.singleInPlace} 个未留在原路径（冲突或证据矛盾，见第 3 节）` : ""
            }）`,
        )
        .join("；")}`,
    );
  }
  lines.push("");
  if (dirRows.length === 0) lines.push("（无）");
  else {
    lines.push("| 目录 | 文件数 | 零移动 | 自动归位 | 人工指派 | 形态 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const d of dirRows) {
      const forms = d.forms.size === 0 ? "—" : [...d.forms].sort().join("+");
      lines.push(
        `| ${d.segment}/${d.slugDir} | ${d.files} | ${d.inPlace} | ${d.auto} | ${d.manual} | ${forms} |`,
      );
    }
  }
  lines.push("");
  lines.push("### 4.2 范围外邻居段（零触碰，仅清单快照）");
  lines.push("");
  if (scan.neighbors.length === 0) lines.push("（无）");
  else {
    lines.push("| 条目 | 类型 | 文件数 | 最新写入 |");
    lines.push("| --- | --- | --- | --- |");
    for (const n of scan.neighbors) {
      lines.push(
        `| ${n.name} | ${n.kind === "dir" ? "目录" : "文件"} | ${n.files} | ${n.newestMtime ? new Date(n.newestMtime).toISOString() : "—"} |`,
      );
    }
  }
  if (scan.segmentMissing.length > 0) {
    lines.push(`- 未找到的迁移段：${scan.segmentMissing.join("、")}（脚本不创建缺失段，不做任何推断）`);
  }
  lines.push("");
  lines.push("### 4.3 忽略的非产物条目");
  lines.push("");
  const junkLines = [];
  for (const s of scan.segments) {
    for (const i of s.ignored) junkLines.push(`${s.name}/${i.name}（${i.why}）`);
    for (const d of s.slugDirs) for (const j of d.junk) junkLines.push(`${s.name}/${d.name}/${j}（系统垃圾文件）`);
    for (const d of s.slugDirs) {
      for (const u of d.unreadable) junkLines.push(`${s.name}/${d.name}/${u.rel}（读取失败：${u.error}）`);
    }
  }
  if (junkLines.length === 0) lines.push("（无）");
  else for (const line of junkLines) lines.push(`- ${line}`);
  lines.push("");

  lines.push("## 5. 活动检测（双信号）");
  lines.push("");
  lines.push(
    `- 观测 JSONL 近期写入：${activity.observabilityHits.length > 0 ? "命中" : "未命中"}（窗口 ${activity.windowMinutes} 分钟）`,
  );
  for (const hit of activity.observabilityHits.slice(0, 10)) {
    lines.push(`  - ${hit.path}（${new Date(hit.mtimeMs).toISOString()}）`);
  }
  if (activity.observabilityHits.length > 10) {
    lines.push(`  - …其余 ${activity.observabilityHits.length - 10} 个`);
  }
  lines.push(`- 待迁移目录内近期写入：${activity.recentDirs.length > 0 ? "命中" : "未命中"}`);
  for (const dir of activity.recentDirs) {
    lines.push(
      `  - ${dir.segment}/${dir.slugDir}：${dir.files} 个文件在窗口内，最新 ${dir.newest.rel}（${new Date(dir.newest.mtimeMs).toISOString()}）`,
    );
  }
  lines.push(
    `- 实迁结论：${
      activity.blocking
        ? "将拒绝执行（提示稍后重试；补迁约定：在途 run 终态后重跑 --check → 补迁，直至零可迁移项）"
        : "可执行"
    }`,
  );
  lines.push("");

  lines.push("## 6. 幂等与可逆");
  lines.push("");
  lines.push("- 实迁模式生成反向对照表：`migration-reverse-map.json`（与报告同目录）。");
  lines.push("- 实迁后重跑 `--check` 应报零可迁移项；活动检测拒迁项在补迁前仍报可迁移属预期。");
  lines.push("");
  if (applyResult) {
    lines.push("## 7. 实迁执行结果");
    lines.push("");
    lines.push(`- 已移动：${applyResult.moved} 个文件`);
    lines.push(`- 已删除空目录：${applyResult.removedDirs} 个`);
    if (applyResult.failed.length > 0) {
      lines.push("- 失败：");
      for (const f of applyResult.failed) lines.push(`  - ${f.from} → ${f.to}：${f.error}`);
    } else {
      lines.push("- 失败：无");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function manualReasonLabel(reason) {
  switch (reason) {
    case "no-project-root":
      return "零 projectRoot（无法归属）";
    case "ambiguous-roots":
      return "projectRoot 证据矛盾";
    case "deleted-unresolved":
      return "worktree 已删除且检验不出工作区";
    case "same-name-conflict":
      return "同名冲突（不覆盖、不改名）";
    case "symlink":
      return "符号链接";
    case "target-outside-scope":
      return "目标越出迁移范围";
    case "probe-error":
      return "检测探针失败";
    default:
      return reason;
  }
}

function escapeCell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ── 实迁 ───────────────────────────────────────────────────────────────────

function applyPlan(summary, opts, now) {
  const moved = [];
  const failed = [];
  const touchedDirs = new Set();
  for (const row of summary.auto) {
    try {
      mkdirSync(dirname(row.to), { recursive: true });
      try {
        renameSync(row.from, row.to);
      } catch (err) {
        if (err && err.code === "EXDEV") {
          copyFileSync(row.from, row.to);
          unlinkSync(row.from);
        } else {
          throw err;
        }
      }
      moved.push({ from: row.from, to: row.to, segment: row.segment, via: row.via });
      touchedDirs.add(dirname(row.from));
    } catch (err) {
      failed.push({ from: row.from, to: row.to, error: String(err.message || err) });
    }
  }
  let removedDirs = 0;
  for (const start of [...touchedDirs].sort((a, b) => b.length - a.length)) {
    let dir = start;
    while (true) {
      const relDir = relative(opts.skillDataRoot, dir).split(sep).join("/");
      if (relDir === "" || relDir === ".." || relDir.startsWith(`..${sep}`) || SEGMENTS.includes(relDir)) break;
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        break;
      }
      if (entries.length > 0) break;
      try {
        rmdirSync(dir);
        removedDirs += 1;
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
  const reverseMap = {
    generatedAt: new Date(now).toISOString(),
    skillDataRoot: opts.skillDataRoot,
    moves: moved,
    failed,
  };
  return { moved: moved.length, failed, removedDirs, reverseMap };
}

function writeOutputs(opts, markdown, machine) {
  if (opts.report) {
    mkdirSync(dirname(opts.report), { recursive: true });
    writeFileSync(opts.report, markdown, "utf8");
    const jsonPath = opts.report.replace(/\.md$/i, "") + ".json";
    writeFileSync(jsonPath, `${JSON.stringify(machine, null, 2)}\n`, "utf8");
    if (machine.reverseMap) {
      const mapPath = join(dirname(opts.report), "migration-reverse-map.json");
      writeFileSync(mapPath, `${JSON.stringify(machine.reverseMap, null, 2)}\n`, "utf8");
    }
  }
  process.stdout.write(markdown);
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    process.exit(1);
  }
  if (!existsSync(opts.skillDataRoot)) {
    process.stderr.write(
      `skill-data 根不存在：${opts.skillDataRoot}。恢复动作：确认路径后重发（--help 查看用法）\n`,
    );
    process.exit(1);
  }
  if (opts.mode === "apply" && !opts.report) {
    process.stderr.write(
      "实迁须指定 --report：反向对照表与实迁报告需要落盘留档。恢复动作：补 --report <文件> 后重发\n",
    );
    process.exit(1);
  }
  const now = opts.now ?? Date.now();
  const layer = loadSingleSource();
  const detector = makeDetector(layer);

  const scan = createScan(opts.skillDataRoot);
  scanSkillData(scan);
  planMigration(scan, detector);
  const conflicts = markConflicts(scan);
  const summary = buildSummary(scan);
  const suggestions = buildSuggestions(scan, summary, detector);
  const activity = evaluateActivity(scan, opts, now);

  const knownMisfiles = opts.knownMisfiles.map((p) => {
    const exists = existsSync(p);
    let size = 0;
    let mtimeMs = 0;
    if (exists) {
      try {
        const st = statSync(p);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // 保持 0
      }
    }
    return { path: p, exists, size, mtimeMs };
  });

  if (opts.mode === "apply" && activity.blocking) {
    const markdown = renderReport({
      opts,
      scan,
      summary,
      suggestions,
      conflicts,
      activity,
      knownMisfiles,
      applyResult: null,
      now,
    });
    const machine = buildMachineReport(opts, summary, suggestions, activity, null, conflicts, now);
    writeOutputs(opts, markdown, machine);
    process.stderr.write(
      "\n实迁被拒绝：活动检测命中（观测 JSONL 近期写入或待迁移目录内有近期产物）。恢复动作：稍后重试；在途 run 终态后重跑 --check → 补迁。\n",
    );
    process.exit(2);
  }

  const applyResult = opts.mode === "apply" ? applyPlan(summary, opts, now) : null;
  const markdown = renderReport({
    opts,
    scan,
    summary,
    suggestions,
    conflicts,
    activity,
    knownMisfiles,
    applyResult,
    now,
  });
  const machine = buildMachineReport(opts, summary, suggestions, activity, applyResult, conflicts, now);
  writeOutputs(opts, markdown, machine);
  if (applyResult && applyResult.failed.length > 0) {
    process.stderr.write(
      `\n实迁有 ${applyResult.failed.length} 个文件失败（详见报告第 7 节）。恢复动作：按报告中的 from/to 与错误信息处理后可重跑 --check 复核。\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

function buildMachineReport(opts, summary, suggestions, activity, applyResult, conflicts, now) {
  return {
    mode: opts.mode,
    generatedAt: new Date(now).toISOString(),
    skillDataRoot: opts.skillDataRoot,
    observabilityRoot: opts.observabilityRoot,
    counts: {
      files: summary.fileCount,
      auto: summary.auto.length,
      manual: summary.manual.length,
      inPlace: summary.inPlaceCount,
      singleInPlace: summary.singleInPlaceCount,
      conflicts: conflicts.length,
      suggestions: suggestions.length,
      activeDirs: activity.recentDirs.length,
      observabilityHits: activity.observabilityHits.length,
    },
    auto: summary.auto.map((r) => ({
      segment: r.segment,
      from: r.from,
      fromRel: r.fromRel,
      to: r.to,
      toRel: r.toRel,
      form: r.form,
      via: r.via,
    })),
    manual: summary.manual.map((m) => ({
      segment: m.segment,
      path: m.path,
      reason: m.reason,
      detail: m.detail,
    })),
    conflicts,
    suggestions,
    directories: summary.dirs.map((d) => ({
      segment: d.segment,
      slugDir: d.slugDir,
      files: d.files,
      auto: d.auto,
      manual: d.manual,
      inPlace: d.inPlace,
      singleFiles: d.singleFiles,
      singleInPlace: d.singleInPlace,
      targets: d.targets,
      forms: [...d.forms].sort(),
    })),
    activity: {
      windowMinutes: activity.windowMinutes,
      blocking: activity.blocking,
      observabilityHits: activity.observabilityHits.map((h) => ({
        path: h.path,
        mtime: new Date(h.mtimeMs).toISOString(),
      })),
      recentDirs: activity.recentDirs.map((d) => ({
        segment: d.segment,
        slugDir: d.slugDir,
        files: d.files,
        newest: d.newest.rel,
        newestMtime: new Date(d.newest.mtimeMs).toISOString(),
      })),
    },
    applyResult: applyResult
      ? { moved: applyResult.moved, failed: applyResult.failed, removedDirs: applyResult.removedDirs }
      : null,
    reverseMap: applyResult?.reverseMap ?? null,
  };
}

try {
  main();
} catch (err) {
  process.stderr.write(`迁移失败：${String(err?.message || err)}\n`);
  process.exit(1);
}
