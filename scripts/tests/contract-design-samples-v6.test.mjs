// contract-design-samples-v6.test.mjs — 设计 §17 样例→用例对照表（机器可断言登记）
//
// 登记内容：设计《V6 运行可用性与外部契约守门升级》§17「测试与已知答案样例」25 条
// （期望摘要硬编码在本文件 SAMPLES 常量表，注释标「源自设计 §17」——设计变更时本表
// 与实际承载不一致须人工核对后更新，表本身不随磁盘上的设计文档自动同步）。
//
// 对照表回答一个问题：设计承诺的每条已知答案样例，当前由哪条测试承载、承载到什么
// 程度。状态四态：
//   已承载 = 存在对应该样例判定路径的既有/新增用例（红绿双态或拒绝/放行双态可断言）；
//   部分   = 主判定路径有承载，但样例要求的某一条分支（如 evaluate 侧强制 essential）
//           尚未落执行锚——pending 字段注明缺哪条；
//   无     = 无任何执行承载（真实宿主探针类 / 机制八未实现类）——pending 字段注明
//           待哪个波次（R5 实跑 / 机制八波次），使「无承载」成为机器可断言事实；
//   仅桩   = 只有桩级或存在性锚，无行为断言（当前登记表无此态条目，词表保留）。
//
// 本文件的断言全部是「登记表自身的一致性 + 承载文件存在性」：样例数、四态词表、
// 状态与承载/待办的匹配关系、carrier 指向的测试文件确实在盘上。行为断言在各 carrier
// 文件内（contract-rescan-gates-v6 / ia-contract-negative-v6 / external-contract-* /
// compile-contract-gate-v6 / runtime-obligations-v6 / ia-contract-independence-v6 /
// external-contract-resolve-v6 / external-contract-detect-v6 / defect-family-regression-v6）。
//
// 运行：node --test scripts/tests/contract-design-samples-v6.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TESTS_DIR = join(ROOT, "scripts", "tests");

const STATUSES = ["已承载", "部分", "无", "仅桩"];

/**
 * §17 样例登记表（期望摘要源自设计 §17，逐条硬编码）：
 *   no         样例号（1..25，与设计 §17 编号一致）
 *   summary    样例形态一句话（设计原文压缩）
 *   expectation 期望判定（设计原文的「期望」部分压缩）
 *   carriers   承载测试文件名（相对 scripts/tests/；行为断言在这些文件内）
 *   status     四态之一
 *   pending    非「已承载」条目的待办标注（缺哪条 / 待哪个波次）
 */
const SAMPLES = [
  {
    no: 1,
    summary: "GLM V5 复放：原始 intent + mock-only acceptance + 同构三份契约",
    expectation: "validate-acceptance 拒绝；登记被删时 D0/D3/evaluate 至少一处复扫拒绝；复扫被绕过时 IA 与 accepted 的 runtime 义务仍拦截",
    carriers: ["external-contracts-v6.test.mjs", "compile-contract-gate-v6.test.mjs", "runtime-obligations-v6.test.mjs", "ia-contract-independence-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 2,
    summary: "能力低报：契约只登记 load-extension，源码出现 registerTool/registerCommand/context 调用类",
    expectation: "D0 拒绝编译；D1 才引入时 D3 与 evaluate 复扫拒绝并回验收修订",
    carriers: ["contract-rescan-gates-v6.test.mjs", "compile-contract-gate-v6.test.mjs", "runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 3,
    summary: "候选虚假处置：strong 候选被写成 not-external",
    expectation: "validate 拒绝；实现后源码出现该调用类时 D0 拒绝",
    carriers: ["external-contracts-v6.test.mjs", "contract-rescan-gates-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 4,
    summary: "动态外部访问：计算式成员访问或动态 import 无法归类",
    expectation: "D0 标 unresolved 并停回",
    carriers: ["contract-rescan-gates-v6.test.mjs", "external-contract-detect-v6.test.mjs", "runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 5,
    summary: "cwd 断链：authority types 无 cwd，spike 观察工厂 API 键集合",
    expectation: "spike 观察失败（真实宿主探针）",
    carriers: [],
    status: "无",
    pending: "待 R5 实跑波次：真实宿主探针资产（benchmark/golden 任务级构造，机器层无法脱离真实宿主非伪实现）",
  },
  {
    no: 6,
    summary: "命令签名与名称：真实 registerCommand 两参 + 命令分发首空格截断",
    expectation: "失败（真实宿主探针）",
    carriers: [],
    status: "无",
    pending: "待 R5 实跑波次：真实宿主探针资产",
  },
  {
    no: 7,
    summary: "工具签名：五参调用 + AgentToolResult 检查",
    expectation: "失败（真实宿主探针）",
    carriers: [],
    status: "无",
    pending: "待 R5 实跑波次：真实宿主探针资产",
  },
  {
    no: 8,
    summary: "字段错误：usageNote / completeArgs / label 对照 authority surface",
    expectation: "失败（真实宿主探针）",
    carriers: [],
    status: "无",
    pending: "待 R5 实跑波次：真实宿主探针资产",
  },
  {
    no: 9,
    summary: "authority 伪造：项目内自造 SDK、local-path 未经 user 登记或 registry integrity 不一致",
    expectation: "resolve 拒绝",
    carriers: ["external-contract-resolve-v6.test.mjs", "external-contract-resolve-integrity-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 10,
    summary: "sourceHash 伪造：证据声明 hash 与 resolver 重算不一致",
    expectation: "证据降级（partial）",
    carriers: ["runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 11,
    summary: "authority 升级：surface hash 变化，EnvironmentBaselineConfirmed 后仍需重跑 probe",
    expectation: "runtime 义务 open；确认基线后仍须重跑 probe 才 established",
    carriers: ["runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 12,
    summary: "mock parity 差异：mock 全名匹配 vs 真实首空格截断；realObserved 未引用 probe case",
    expectation: "mock 不能继续证明命令语义；parity 引用不存在时无效（must-fix）",
    carriers: ["ia-contract-independence-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 13,
    summary: "typescript 缺失：tsconfig 存在但 tsc 不可执行",
    expectation: "L0 失败（机制八 §11.3 测试命令有效性）",
    carriers: [],
    status: "无",
    pending: "待机制八波次（验证资产与工具链真实性）：§11.3 测试命令有效性检查未实现",
  },
  {
    no: 14,
    summary: "passWithNoTests：测试文件全部缺失但命令 exit 0",
    expectation: "验证资产义务 open（机制八 §11.4）",
    carriers: [],
    status: "无",
    pending: "待机制八波次：§11.4 资产义务落位未实现",
  },
  {
    no: 15,
    summary: "声明脚本未接线：机检脚本存在但无增量或 Gate A 命令",
    expectation: "asset open（机制八）",
    carriers: [],
    status: "无",
    pending: "待机制八波次：资产接线核对未实现",
  },
  {
    no: 16,
    summary: "弱反驳：finding 结构命中外部契约但 authorityBacked/authorityHash/authorityObservationRef 缺失",
    expectation: "拒绝写入",
    carriers: ["external-contracts-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 17,
    summary: "无外部依赖普通任务：internal library 只依赖 Node 内置模块",
    expectation: "不要求 externalContracts，流程不受影响",
    carriers: ["external-contracts-v6.test.mjs", "ia-contract-independence-v6.test.mjs", "runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 18,
    summary: "非 essential 可选集成：authority 缺失时可风险接受",
    expectation: "runtimeReadiness 保持 not-established（逐条披露）",
    carriers: ["runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 19,
    summary: "语义风险清单：契约任务 reviewer 缺 riskCoverage 或类别非法",
    expectation: "验收审查结构校验失败（十类逐类三值）",
    carriers: ["ia-contract-negative-v6.test.mjs", "counter-implementation-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 20,
    summary: "控制状态缺陷族：开关写入中途失败后显式关闭被静默恢复",
    expectation: "验收判据（riskCoverage control-state 类必答）与回归测试必须能拒绝",
    carriers: ["defect-family-regression-v6.test.mjs", "ia-contract-negative-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 21,
    summary: "绿地后引入外部契约：验收与 D0 时源码为空，D1 才写入真实 SDK import 与外部注册调用",
    expectation: "D3 候选完成前复扫拒绝，evaluate 也拒绝",
    carriers: ["contract-rescan-gates-v6.test.mjs", "runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 22,
    summary: "可选契约实际使用：验收标 essential=false，但源码出现该契约调用类",
    expectation: "D0/D3/evaluate 复扫强制改判 essential 并要求 runtime probe",
    carriers: ["compile-contract-gate-v6.test.mjs", "contract-rescan-gates-v6.test.mjs", "runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 23,
    summary: "注册-分发蕴含：源码只出现 registerCommand，能力清单缺 dispatch-command 观察类",
    expectation: "D0/D3/evaluate 复扫拒绝",
    carriers: ["contract-rescan-gates-v6.test.mjs", "runtime-obligations-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 24,
    summary: "本地 re-export / 动态代码：外部包经本地模块 re-export 或 eval 动态生成调用",
    expectation: "探测器无法归因时 unresolved 停回",
    carriers: ["external-contract-detect-v6.test.mjs", "contract-rescan-gates-v6.test.mjs"],
    status: "已承载",
  },
  {
    no: 25,
    summary: "negative case 独立执行：反例 case 只由 builder driver 输出",
    expectation: "不得满足判别力义务，必须由 assurance 亲自执行",
    carriers: ["ia-contract-independence-v6.test.mjs"],
    status: "已承载",
  },
];

test("§17 样例登记表：25 条齐备、字段完整、状态在四态词表内", () => {
  assert.equal(SAMPLES.length, 25, "设计 §17 共 25 条样例（设计变更时先核对条数）");
  const seen = new Set();
  for (const sample of SAMPLES) {
    assert.ok(Number.isInteger(sample.no) && sample.no >= 1 && sample.no <= 25, `样例号非法：${sample.no}`);
    assert.ok(!seen.has(sample.no), `样例号重复：${sample.no}`);
    seen.add(sample.no);
    assert.ok(typeof sample.summary === "string" && sample.summary.length > 0, `样例 ${sample.no} 缺 summary`);
    assert.ok(typeof sample.expectation === "string" && sample.expectation.length > 0, `样例 ${sample.no} 缺 expectation`);
    assert.ok(Array.isArray(sample.carriers), `样例 ${sample.no} carriers 必须为数组`);
    assert.ok(STATUSES.includes(sample.status), `样例 ${sample.no} 状态「${sample.status}」不在四态词表（${STATUSES.join(" / ")}）`);
  }
});

test("§17 样例登记表：状态与承载/待办匹配（无承载 = 机器可断言事实）", () => {
  for (const sample of SAMPLES) {
    if (sample.status === "已承载") {
      assert.ok(sample.carriers.length > 0, `样例 ${sample.no} 标已承载但无承载文件`);
      assert.equal(sample.pending, undefined, `样例 ${sample.no} 已承载不得挂待办`);
    }
    if (sample.status === "无") {
      assert.equal(sample.carriers.length, 0, `样例 ${sample.no} 标无不得挂承载（要么补执行用例后改状态，要么摘掉）`);
      assert.ok(typeof sample.pending === "string" && sample.pending.length > 0, `样例 ${sample.no} 无承载必须带 pending 待办标注（待 R5 实跑 / 机制八波次）`);
      assert.match(sample.pending, /R5|机制八/, `样例 ${sample.no} 待办须指明波次`);
    }
    if (sample.status === "部分" || sample.status === "仅桩") {
      assert.ok(sample.carriers.length > 0, `样例 ${sample.no}（${sample.status}）须有承载文件`);
      assert.ok(typeof sample.pending === "string" && sample.pending.length > 0, `样例 ${sample.no}（${sample.status}）须带 pending 缺项标注`);
    }
  }
  // 无承载条目集中且可解释：真实宿主探针类（样例 5-8，待 R5）与机制八未实现类（样例 13-15）
  const none = SAMPLES.filter((sample) => sample.status === "无").map((sample) => sample.no);
  assert.deepEqual(none, [5, 6, 7, 8, 13, 14, 15], "无承载条目应恰为真实宿主探针四条 + 机制八三条（新增无承载条目须同步设计决策）");
});

test("§17 样例登记表：carrier 指向的测试文件都在盘上（存在性锚，防登记指向已移除文件）", () => {
  const referenced = new Set(SAMPLES.flatMap((sample) => sample.carriers));
  for (const name of referenced) {
    assert.ok(existsSync(join(TESTS_DIR, name)), `承载文件缺失：scripts/tests/${name}（更新登记表或恢复文件）`);
  }
});

test("样例 20 登记锚：control-state 类别在验收审查风险清单词表内（验收判据侧可答）", () => {
  // 样例 20 的「验收判据必须能拒绝」侧：riskCoverage 十类词表含 control-state
  const shared = readFileSync(join(ROOT, "skills", "self", "dev-workflow", "workflows", "src", "acceptance-design-v6.shared.ts"), "utf8");
  assert.match(shared, /"control-state"/, "riskCoverage 十类词表须含 control-state（样例 20 判据载体）");
  // 「回归测试必须能拒绝」侧由 defect-family-regression-v6 双态断言承载（样例 1/2 的缺陷版红/修复版绿）
  const defectFamily = readFileSync(join(TESTS_DIR, "defect-family-regression-v6.test.mjs"), "utf8");
  assert.match(defectFamily, /缺陷版红/, "缺陷族回归须保持双态断言（样例 20 回归侧）");
});
