// check-design-doc.test.mjs — 设计包机器自检 check-design-doc.mjs 的独立测试
//
// 对应实现：skills/self/dev-workflow/tech-design-v1/scripts/check-design-doc.mjs（十条规则）。
// 本测试聚焦守护全文单一登记契约（decisions[].guards 登记 + {{<id>}} 引用）三组校验：
//   - 规则 2 扩展：guards[].id 进全局唯一并集（重复定义 fail；元素 id/text 形态畸形 fail；
//     text 内嵌 {{...}} 叶子禁令 fail）
//   - 规则 4 扩展：{{<id>}} 完整 token 递归扫描六章节字符串值，引用不存在的守护 fail；
//     token 内层两端带空白（{{ G1 }}）同样放行——与渲染端 trim 后取 id 的行为一致
//   - 规则 10：guards[].text 两两精确重复（trim 后相等）fail；跨字段特征子串逐字重复
//     warning 不阻塞（同字段路径内重复不计数；guards[].text 登记处自身不参与提取——
//     否则收敛为「登记处 + 引用侧」的目标形态后仍会误报）；登记全文在正文其他字段的
//     逐字残留 warning 不阻塞（C1b，恰 1 条且含守护 id 与残留位置）；特征判据的命令动词
//     分支边界为 (?!\w)——下划线延续的标识符 token 不命中、连字符边界照常命中
//   - 渲染联动（render-design-doc.mjs）：{{ G1 }} 空白 token 展开为登记全文；meta.name
//     内联 {{G1}} 时渲染首行标题同样经统一出口展开
// 存量兼容：无 guards 的最小合法六章节（resources/templates/design-doc/ 裁剪形态）exit 0
// 零 warning；规则 8/9 的存量提示（穷举声明 / 渲染产物过期）在 fixture 中显式关掉
// （行声明 exhaustive=false + rendered.md 最后写入），使 warning 断言可归零。
//
// 运行：node --test scripts/tests/check-design-doc.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v1", "scripts", "check-design-doc.mjs");
const RENDER_SCRIPT = join(ROOT, "skills", "self", "dev-workflow", "tech-design-v1", "scripts", "render-design-doc.mjs");
const CHAPTER_FILES = ["meta.json", "s1-context.json", "s2-status.json", "s3-solution.json", "s4-accept.json", "s5-breakdown.json"];

// 特征子串用 token：单 token 无空白 35 字符，含正则元字符聚集（[[ 与 ]]）与 ASCII 左括号，
// 同时模拟真实设计包「命令正则被逐字抄进多个字段」的失真形态
const TOKEN = "'^test[a-z]+(one|two)[[:space:]]*$'";
const GUARD_TEXT_A = "出站导入仅允许 trigger 与 intraday 两处，第三处即红";
const GUARD_TEXT_B = "判定纯函数不得读库，读库即红";
// C1b 用例的短中文守护：trim 后长度 7（∈ [6, 29)），无空白、无 ≥30 特征 token——
// C2 特征子串提取不命中，残留判定只能走 C1b 的全文 includes
const GUARD_TEXT_SHORT = "出站仅两处入口";

// ── fixture 基座：最小合法六章节（evolution 分型，对照 resources/templates/design-doc/ 裁剪）──

function legalDesign() {
  return {
    "meta.json": {
      name: "fixture-design",
      designType: "evolution",
      typeRationale: "改动局部、无终态结构诉求——不需要终态视角",
      priority: "P2",
      riskScore: 3,
      riskRationale: "单模块内改动，风险低",
      reviewNav: [{ decisionId: "D1", anchor: "§3.3", level: "A", title: "决策一标题", criteria: "判据示意", impact: "影响示意" }],
      relatedDocs: [],
    },
    "s1-context.json": {
      background: "背景示意。",
      goals: [{ id: "GL1", statement: "使用者能做到示意事项" }],
      outOfScope: "范围外示意",
    },
    "s2-status.json": {
      currentBehaviour: "现状行为示意。",
      flowDiagram: "主流程 → 环节示意",
      problems: [{ id: "PR1", stage: "主流程 → 环节示意", symptom: "现象示意", rootCause: "根因示意" }],
      // exhaustive=false 显式声明：否则规则 8 对全未声明的设计包发存量提示 warning，warning 断言无法归零
      assumptions: [{ id: "AS1", statement: "前提示意", status: "pending", evidence: "", impactIfFalse: "影响示意", exhaustive: false }],
      artifactTables: {
        stateCopies: [{ id: "SC1", state: "状态示意", location: "模块示意", nature: "authority", sync: "同步机制示意", excluded: false, exclusionNote: "", exhaustive: false }],
        signalImplications: [],
        repairHistory: [],
        upstreamDeps: [],
      },
    },
    "s3-solution.json": {
      options: [
        { id: "OPT1", name: "方案一", longTerm: "长期评估示意", shortTerm: "短期成本示意", risk: "风险示意", recommended: true, costNote: "成本示意" },
        { id: "OPT2", name: "方案二", longTerm: "长期评估示意", shortTerm: "短期成本示意", risk: "风险示意", recommended: false, costNote: "成本示意" },
      ],
      decisions: [
        {
          id: "D1",
          title: "决策一标题",
          stage: "主流程 → 环节示意",
          level: "A",
          choice: "采用方案示意。",
          rejected: "不采用其余方案的理由示意。",
          evidence: "证据示意（已核实）",
          gapRefs: [],
          unitRefs: ["U1"],
          axiomRefs: [],
          impact: { architecture: "", function: "", complexity: "", performance: "", resource: "", redline: "" },
        },
      ],
    },
    "s4-accept.json": {
      scenarios: [{ id: "V1", scene: "场景示意", steps: "步骤示意", criteria: "标准示意", goalRefs: ["GL1"] }],
      assertionRedlights: [],
      e2eImpact: { items: [], noneReason: "无受影响项依据示意" },
    },
    "s5-breakdown.json": {
      units: [{ id: "U1", title: "单元示意", justification: "拆分理由示意", files: ["src/example.py"], checkpoints: ["待验证点示意"] }],
      fileMap: "文件改动地图示意。",
    },
  };
}

// 写入临时设计目录并跑检查器；mutate 在写盘前对六章节对象做用例级变形。
// rendered.md 最后写入（mtime 晚于全部章节 JSON）——规则 9 不发过期 warning
function runCheck(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "design-doc-check-"));
  try {
    const docs = legalDesign();
    if (mutate) mutate(docs);
    for (const file of CHAPTER_FILES) {
      writeFileSync(join(dir, file), JSON.stringify(docs[file], null, 2) + "\n");
    }
    writeFileSync(join(dir, `${basename(dir)}.rendered.md`), "# rendered\n");
    return spawnSync(process.execPath, [CHECK_SCRIPT, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// check + render 联动场景：同一临时目录内先跑 check 再跑 render，读回渲染产物后断言；
// 全部动作在 rmSync 之前完成，渲染产物不留盘
function runCheckAndRender(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "design-doc-render-"));
  try {
    const docs = legalDesign();
    if (mutate) mutate(docs);
    for (const file of CHAPTER_FILES) {
      writeFileSync(join(dir, file), JSON.stringify(docs[file], null, 2) + "\n");
    }
    writeFileSync(join(dir, `${basename(dir)}.rendered.md`), "# rendered\n");
    const check = spawnSync(process.execPath, [CHECK_SCRIPT, dir], { encoding: "utf8" });
    const render = spawnSync(process.execPath, [RENDER_SCRIPT, dir], { encoding: "utf8" });
    const rendered = readFileSync(join(dir, `${basename(dir)}.rendered.md`), "utf8");
    return { check, render, rendered };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 全绿形态断言：exit 0 且 stdout 仅一行确认（warning 会另起一行，行数即 warning 计数的上界）
function assertAllGreen(r, label) {
  assert.equal(r.status, 0, `「${label}」应 exit 0，实际 exit=${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `「${label}」应零 warning（stdout 仅确认一行），实际 stdout：${r.stdout}`);
  assert.match(lines[0], /十条规则全绿$/);
}

// ── 用例 1：合法含 guards（登记 + 引用齐备）──

test("合法含 guards：guards 登记正常、{{G1}} 引用存在 → exit 0 零 warning", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [{ id: "G1", text: GUARD_TEXT_A, note: "示例守护注记" }];
    d["s3-solution.json"].decisions[0].choice = `采用方案示意，出站边界由 {{G1}} 守护。`;
  });
  assertAllGreen(r, "合法含 guards");
});

// ── 用例 2：存量无 guards 向后兼容 ──

test("存量无 guards（最小合法六章节）→ exit 0 零 warning（向后兼容）", () => {
  assertAllGreen(runCheck(), "存量无 guards");
});

// ── 用例 3：规则 2 扩展——guards id 重复 / 形态畸形 ──

test("guards id 同数组内重复 → fail 且输出含定位（沿用规则 2 文案风格）", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [
      { id: "G1", text: GUARD_TEXT_A },
      { id: "G1", text: GUARD_TEXT_B },
    ];
  });
  assert.equal(r.status, 1);
  // 与规则 2 常规数组同语义：同数组内重复只报「数组内重复」（全局并集消息属跨数组场景，见下例）
  assert.match(r.stdout, /guards 内 id「G1」重复出现（guards\[0\] 与 guards\[1\]）/);
});

test("guards id 跨决策数组重复 → 全局并集 fail 且列出两处定义位置", () => {
  const r = runCheck((d) => {
    const meta = d["meta.json"];
    const s3 = d["s3-solution.json"];
    s3.decisions.push({
      id: "D2", title: "决策二标题", stage: "主流程 → 环节示意", level: "B",
      choice: "方案二选择示意。", rejected: "方案二不采用理由示意。", evidence: "证据示意（已核实）",
      gapRefs: [], unitRefs: ["U1"], axiomRefs: [],
      impact: { architecture: "", function: "", complexity: "", performance: "", resource: "", redline: "" },
      guards: [{ id: "G1", text: GUARD_TEXT_B }],
    });
    meta.reviewNav.push({ decisionId: "D2", anchor: "§3.4", level: "B", title: "决策二标题", criteria: "判据示意", impact: "影响示意" });
    s3.decisions[0].guards = [{ id: "G1", text: GUARD_TEXT_A }];
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /id「G1」重复定义于 s3-solution\.json decisions\[0\]\.guards\[0\] 与 s3-solution\.json decisions\[1\]\.guards\[0\]/);
});

test("guards 元素形态畸形（id/text 非字符串或空、条目非对象、guards 非数组）→ 各自 fail", () => {
  const cases = [
    {
      name: "guards 非数组",
      guards: "oops",
      expect: /decisions\[0\]（D1）guards 须为数组/,
    },
    {
      name: "id 空字符串",
      guards: [{ id: "", text: GUARD_TEXT_A }],
      expect: /guards\[0\] id 缺失、非字符串或为空/,
    },
    {
      name: "text 缺失",
      guards: [{ id: "G1" }],
      expect: /guards\[0\] text 缺失、非字符串或为空/,
    },
    {
      name: "条目非对象",
      guards: ["字符串元素"],
      expect: /guards\[0\] 条目须为对象/,
    },
  ];
  for (const c of cases) {
    const r = runCheck((d) => {
      d["s3-solution.json"].decisions[0].guards = c.guards;
    });
    assert.equal(r.status, 1, `「${c.name}」应 exit 1，实际 stdout：${r.stdout}`);
    assert.match(r.stdout, c.expect, `「${c.name}」输出缺定位`);
  }
});

// ── 用例 4：规则 10 C1——guards text 重复登记 fail ──

test("guards text 两两精确重复（含 trim 后相等的空白差异形态）→ fail", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [
      { id: "G1", text: GUARD_TEXT_A },
      { id: "G2", text: `  ${GUARD_TEXT_A}  ` },
    ];
  });
  assert.equal(r.status, 1, `应 exit 1，实际 stdout：${r.stdout}`);
  assert.match(r.stdout, /守护文本重复登记于 s3-solution\.json decisions\[0\]\.guards\[0\] 与 s3-solution\.json decisions\[0\]\.guards\[1\]/);
  assert.match(r.stdout, /text 须全局唯一（准则 14 单一登记）/);
});

// ── 用例 5：规则 4 扩展——{{...}} 引用校验 ──

test("{{拼错}} 引用不存在的守护 → fail 且含位置与保留语法提示", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [{ id: "G1", text: GUARD_TEXT_A }];
    d["s3-solution.json"].decisions[0].choice = "采用方案示意，由 {{G9}} 守护。";
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /s3-solution\.json decisions\[0\]\.choice 引用了不存在的守护「G9」/);
  assert.match(r.stdout, /\{\{\.\.\.\}\} 是守护引用保留语法/);
  assert.match(r.stdout, /现有 id：G1/);
});

test("无 guards 时任何 {{...}} 均无登记可指向 → fail", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].choice = "采用方案示意，由 {{G1}} 守护。";
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /引用了不存在的守护「G1」/);
  assert.match(r.stdout, /本文档未登记任何守护/);
});

// ── 用例 6：规则 10 C2——跨字段特征子串重复 warning（不阻塞）──

test("特征子串跨 2 字段重复 → exit 0 不阻塞，warning 列出两个位置", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].evidence = `证据示意：扫描命令 ${TOKEN} 已核实`;
    d["s4-accept.json"].assertionRedlights = [
      { id: "RL1", assumption: "运行时假设示意", redlight: `守护命令 ${TOKEN} 失败即红`, buildItem: "—" },
    ];
  });
  assert.equal(r.status, 0, `warning 不应阻塞判定，实际 exit=${r.status}\nstdout: ${r.stdout}`);
  const warnLine = r.stdout.split("\n").find((l) => l.includes("[单一登记]"));
  assert.ok(warnLine, `应含一条 [单一登记] warning，实际 stdout：${r.stdout}`);
  assert.ok(warnLine.includes(TOKEN), "warning 应含重复的特征子串原文");
  assert.ok(warnLine.includes("s3-solution.json decisions[0].evidence"), "warning 应含第一处位置");
  assert.ok(warnLine.includes("s4-accept.json assertionRedlights[0].redlight"), "warning 应含第二处位置");
  assert.ok(warnLine.includes("收敛为 decisions[].guards 单一登记"), "warning 应给收敛方向");
});

// ── 用例 7：C2 反例——同字段内重复不计数；guards.text 登记处自身不参与提取 ──

test("同一字段路径内重复出现 → 不触发 warning", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].evidence = `证据示意：${TOKEN} 与复述 ${TOKEN}（已核实）`;
  });
  assertAllGreen(r, "同字段内重复");
});

test("guards.text 登记处自身不参与特征子串提取 → 与引用侧并存不误报", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [{ id: "G1", text: `守护全文 ${TOKEN}` }];
    d["s3-solution.json"].decisions[0].choice = `采用方案示意，由 {{G1}} 守护，依据 ${TOKEN} 结束。`;
  });
  // TOKEN 两侧空白隔开：split(/\s+/) 后 TOKEN 本体独立成 token。登记处排除生效 →
  // TOKEN 仅引用侧一处，不凑成两位置 → 全绿；排除失效（登记路径不含 .text 的死代码
  // 形态）→ 登记处参与提取凑成两处 → 产生 [单一登记] warning，本用例必红
  assertAllGreen(r, "登记处排除");
});

// ── 用例 8：问题 2 回归——两份合法 guards 共享特征 token，登记处互相不误报 ──

test("两份合法 guards（text 全文不同）共享同一特征 token → 零 warning", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [
      { id: "G1", text: `守护甲 ${TOKEN} 结束` },
      { id: "G2", text: `守护乙 ${TOKEN} 收尾` },
    ];
  });
  // 登记处排除失效时两份登记处各自贡献 TOKEN → 跨 2 字段 warning；排除生效 → 零命中
  assertAllGreen(r, "两份合法 guards 共享 token");
});

// ── 用例 9：C1b——登记全文在正文逐字残留（warning 不阻塞，恰 1 条） ──

test("短中文守护全文在另一字段逐字残留 → 恰 1 条 [单一登记] warning（含守护 id 与残留位置）", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [{ id: "G1", text: GUARD_TEXT_SHORT }];
    d["s3-solution.json"].decisions[0].choice = `采用方案示意，出站仅两处入口。`;
  });
  assert.equal(r.status, 0, `warning 不阻塞判定，实际 exit=${r.status}\nstdout: ${r.stdout}`);
  const warnLines = r.stdout.trim().split("\n").filter((l) => l.includes("[单一登记]"));
  assert.equal(warnLines.length, 1, `应恰 1 条 [单一登记] warning，实际 stdout：${r.stdout}`);
  assert.ok(warnLines[0].includes("G1"), `warning 应含守护 id「G1」，实际：${warnLines[0]}`);
  assert.ok(warnLines[0].includes("s3-solution.json decisions[0].choice"), `warning 应含残留位置，实际：${warnLines[0]}`);
  assert.ok(warnLines[0].includes("{{<守护 id>}}"), `warning 应给收敛方向，实际：${warnLines[0]}`);
});

// ── 用例 10：规则 2 扩展——guards.text 叶子禁令（不得内嵌 {{...}} 引用） ──

test("guards.text 内嵌 {{G2}} 引用已登记的其他守护 → fail 且消息含叶子禁令", () => {
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].guards = [
      { id: "G1", text: `出站仅两处，细则见 {{G2}}` },
      { id: "G2", text: GUARD_TEXT_B },
    ];
  });
  // {{G2}} 指向已登记 id，规则 4 引用校验单独不拦——拦截只能靠叶子禁令
  assert.equal(r.status, 1, `应 exit 1，实际 stdout：${r.stdout}`);
  assert.match(r.stdout, /guards\[0\] text 内嵌 \{\{\.\.\.\}\} 引用/);
  assert.match(r.stdout, /必须是叶子内容/);
});

// ── 用例 11：空白 token 与渲染出口（check 放行 + render 展开，问题 5/8 回归） ──

test("{{ G1 }} 空白 token：check exit 0，渲染正文展开为登记全文", () => {
  const { check, render, rendered } = runCheckAndRender((d) => {
    d["s3-solution.json"].decisions[0].guards = [{ id: "G1", text: GUARD_TEXT_A }];
    d["s3-solution.json"].decisions[0].choice = `采用方案示意，由 {{ G1 }} 守护。`;
  });
  assert.equal(check.status, 0, `check 应放行空白 token（trim 后命中登记 id），实际 stdout：${check.stdout}`);
  assert.equal(render.status, 0, `render 应 exit 0，实际 stderr：${render.stderr}`);
  assert.ok(rendered.includes(GUARD_TEXT_A), `渲染产物应展开 {{ G1 }} 为登记全文，实际：${rendered.split("\n").find((l) => l.includes("采用"))}`);
  assert.ok(!rendered.includes("{{ G1 }}"), `渲染产物不应残留 {{ G1 }} token`);
});

test("meta.name 内联 {{G1}} → 渲染首行标题经统一出口展开为登记全文", () => {
  const { check, render, rendered } = runCheckAndRender((d) => {
    d["meta.json"].name = "fixture-{{G1}}-design";
    d["s3-solution.json"].decisions[0].guards = [{ id: "G1", text: GUARD_TEXT_B }];
  });
  assert.equal(check.status, 0, `check 应放行 meta.name 内联引用，实际 stdout：${check.stdout}`);
  assert.equal(render.status, 0, `render 应 exit 0，实际 stderr：${render.stderr}`);
  const firstLine = rendered.split("\n")[0];
  assert.equal(firstLine, `# fixture-${GUARD_TEXT_B}-design`, `首行标题应展开 {{G1}}，实际：${firstLine}`);
});

// ── 用例 12：动词边界——下划线延续不命中动词分支，连字符边界仍命中（端到端走真实脚本） ──

test("git_status_xxx 式标识符 token 跨两字段重复 → 不触发 warning", () => {
  // 动词分支收紧为 (?!\w)：下划线属单词字符。该 token ≥30 无空白、动词开头、无元字符聚集、
  // 无左括号——收紧前单凭动词分支进候选，收紧后三条判据全不中 → 零 warning。
  // 两处都放非登记处字段（guards.text 是登记处、不参与提取）
  const underscoreToken = "git_status_probe_boundary_check_token_xxx";
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].evidence = `证据示意：扫描 ${underscoreToken} 已核实`;
    d["s4-accept.json"].assertionRedlights.push({ id: "RL1", assumption: "运行时假设示意", redlight: `守护命令 ${underscoreToken} 失败即红`, buildItem: "—" });
  });
  assertAllGreen(r, "下划线延续 token");
});

test("grep- 连字符边界 token 跨两字段重复 → 仍触发 warning", () => {
  // 对照形态：连字符不是单词字符，动词分支照常命中——边界收紧只排除下划线延续
  const hyphenToken = "grep-rn-inbound-guard-trigger-intraday";
  const r = runCheck((d) => {
    d["s3-solution.json"].decisions[0].evidence = `证据示意：扫描 ${hyphenToken} 已核实`;
    d["s4-accept.json"].assertionRedlights.push({ id: "RL1", assumption: "运行时假设示意", redlight: `守护命令 ${hyphenToken} 失败即红`, buildItem: "—" });
  });
  assert.equal(r.status, 0, `warning 不阻塞判定，实际 exit=${r.status}\nstdout: ${r.stdout}`);
  const warnLines = r.stdout.trim().split("\n").filter((l) => l.includes("[单一登记]"));
  assert.equal(warnLines.length, 1, `应恰 1 条 [单一登记] warning，实际 stdout：${r.stdout}`);
  assert.ok(warnLines[0].includes(hyphenToken), `warning 应含该 token，实际：${warnLines[0]}`);
});
