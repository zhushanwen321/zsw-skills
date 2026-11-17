#!/usr/bin/env node
// verification-index.mjs — 逐断言引用索引（three-skill-v5 结构化优化设计 §5.2，迁移第四步）
//
// 只读派生：从五类输入的既有引用连接派生「断言 → 决策/单元/反例场景/验证资产/验收节点」
// 索引。每次 exec-plan 生成后全量重建（D0 dev 模式生成后首次重建——acceptanceNodeIds 全空；
// D3 acceptance exec-plan 生成后再重建——acceptanceNodeIds 填充），禁止手改，可删除重建。
//
// 红线（§5.2）：索引只保存引用——不设 coverage 状态、不派生 verified、不判定计划缺漏。
// 空引用集合只是查询事实；缺漏判定仍归 check-quality-contract、formNotApplicable 与既有
// 流程。查询不声称找到完整语义依赖：实际 diff 始终完整提供，未映射文件 / 跨单元契约 /
// 计划外改动回退现行分区审查，reviewer 可主动向外扩展。
//
// rows 字段的派生通道（全部来自既有显式引用，不新建登记、不猜语义）：
//   assertionId        = 验收包 requirements[].assertions[].id ∪ s4 criterionMechanisms[].assertionId
//                        （验收包缺省的独立设计任务从设计包对账行取断言全集）
//   decisionIds        = s4 criterionMechanisms[assertionId].decisionIds
//   adversarialFormIds = 验收包 assertion.adversarialFormRefs ∪ adversarialForms[].assertionId 反查
//                        （validate-acceptance 强制双向一致，并集防单侧登记遗漏；验收包缺省时为空）
//   unitIds            = 三通道并集：
//                        ① decisionIds → s3 decisions[].unitRefs（s5-breakdown 拆分单元 id，设计域）
//                        ② 验收包 assertion.dependsOn.incrementIds → impl-plan units[].incrementId
//                           匹配（开发单元 id）
//                        ③ adversarialFormIds → impl-plan acceptancePlan[].adversarialFormRefs
//                           认领条目 → 条目 deps ∩ impl-plan units[].id（验收计划显式登记的依赖单元）
//                        混合两个 id 域（设计拆分单元 / 开发单元）是既有引用的如实反映——
//                        impl-plan 单元与断言之间没有显式 id 引用（验收计划「对应开发单元」
//                        是隐含默认依赖），缺什么由查询方按回退语义自行扩展
//   verificationAssetIds = 上述 acceptancePlan 条目的 verifyAsset 为 `reuse:<id>` 形态时的 id
//                        （`new` / `inspect-only` / `-` 不产生资产 id）
//   acceptanceNodeIds  = exec-plan.mode=acceptance 时，acceptance.nodes 中 adversarialFormRefs
//                        与本断言场景集有交集的节点 id；dev 模式 / 节点未生成时为空（不算失败，
//                        §5.2——acceptance exec-plan 生成后重建索引即填充）
//
// 顶层登记字段口径（如实）：scenarioIds = 验收包反例场景全集；devUnits = dev 节点 territory
// （--reviewer-seeds 的文件映射域）；unitIds 只登记 impl-plan 开发域单元——rows.unitIds 混两域
// （设计拆分单元 U 前缀 + 开发单元），两域同名碰撞时 uniq 合并为一条（既有引用如实反映，
// 不做域间消歧）。三者是 rows 引用域的判定域（--empty-refs / territory 映射），权威仍在
// acceptance 与 impl-plan，此处只登记不校验。
//
// inputHashes 五键（§5.2）：acceptancePackage（taskDir 的 acceptance.json + increments.json
// 联合哈希，公式与 delivery-gate.mjs acceptancePackageSha256 逐字同源——内层逐文件
// canonicalJson 化为字符串、外层对象再 canonical 化，保证与事件流冻结哈希可对账；独立设计
// 任务无验收绑定时为 null）/ designPackage（designDocPath 推导目录下六章节 JSON 的解析内容
// 规范联合哈希，按实际存在文件计）/ implPlan（planPath）/ projectCapabilities（exec-plan
// 同目录，可缺省——W1 探测命令 detect-project-capabilities.mjs 的缺省落点即 dev-flow 段
// exec-plan 所在目录族，单仓与工作区形态一致）/ execPlan。除 acceptancePackage 外的键值 =
// 输入解析内容的 canonicalJson sha256——观测元数据（如能力快照 observedAt）变化会如实改变
// 哈希，这正是「记录重建基线」的语义。
//
// 资产回溯校验（设计 §5.2「资产 id 必须能回溯到能力快照中的真实资产」）：能力快照在场时
// build 逐条对照 reuse:<id> 是否命中快照 verificationAssets 的真实资产 id（空清单同样对照），
// 未命中三段式报错（回 T3 核对引用或重建快照）；快照缺省时不判错，索引顶层 note 登记
// 「资产 id 未核验」。
//
// 用法：
//   node verification-index.mjs build --exec-plan <exec-plan.json> [--out <verification-index.json>]
//     缺省 out = exec-plan 同目录 verification-index.json；每次全量重建
//   node verification-index.mjs check --exec-plan <exec-plan.json> [--index <verification-index.json>]
//     防手改：重算五输入哈希对照索引登记值（不等 = 输入漂移），并重新派生索引内容对照
//     盘上文件（不一致 = 索引被手改）；恢复命令随错误输出
//   node verification-index.mjs query --index <verification-index.json>
//     (--assertion <id> | --unit <id> | --asset <id> | --empty-refs | --reviewer-seeds [--files <f1,f2>])
//     只读查询。--reviewer-seeds = 给定改动文件集返回初始候选设计条目/断言/单元/场景清单
//     （按索引登记的 dev 节点 territory 前缀匹配文件→单元——一个文件命中多个单元时收集全部
//     命中单元并回退标注）；存在未映射文件 / 多单元重合 / 索引无 dev 节点可匹配时注明回退
//     现行分区审查。
//
// 输出契约：build / check / query 成功 → stdout 结果（build 另打印落盘路径），exit 0；输入
// 不合法 / 校验不一致 → stderr 三段式错误（哪个输入不合法 → 权威源在哪里 → 修改后运行哪个
// 命令），exit 1；用法错误 exit 2。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const GENERATOR = { name: "verification-index", version: "1.0.0" };
const DESIGN_PACKAGE_FILES = [
  "meta.json",
  "s1-context.json",
  "s2-status.json",
  "s3-solution.json",
  "s4-accept.json",
  "s5-breakdown.json",
];
const ROW_REF_FIELDS = ["decisionIds", "unitIds", "adversarialFormIds", "verificationAssetIds", "acceptanceNodeIds"];
const USAGE =
  "用法：node verification-index.mjs build --exec-plan <exec-plan.json> [--out <path>]\n" +
  "      node verification-index.mjs query --index <index.json> (--assertion <id> | --unit <id> | --asset <id> | --empty-refs | --reviewer-seeds [--files <f1,f2>])";

// ── 纯工具 ──

/** 解析后规范 JSON 的 sha256（键排序、无空白）——与 delivery-gate canonicalJson 同族口径 */
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// 验收包联合哈希：与 delivery-v6/scripts/delivery-gate.mjs acceptancePackageSha256 逐字同源
// （两段式——内层逐文件 canonicalJson 化为字符串，外层对象再 canonical 化），保证索引登记值
// 与事件流冻结哈希同源可对账；改任一侧必须同步另一侧（口径同 check-exec-plan.mjs 复刻段）
function acceptancePackageSha256(acceptanceParsed, incrementsParsed) {
  return sha256Canonical({
    "acceptance.json": canonicalJson(acceptanceParsed),
    "increments.json": canonicalJson(incrementsParsed),
  });
}

/** 读 JSON 文件；不存在返回 null（可缺省输入由调用方裁决），语法错走三段式退出 */
function readJsonFile(path, label) {
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fatal(`${label} 不可读或不是合法 JSON：${path}（${error.message}）`, "核对路径与 JSON 语法；该文件是上游权威产物，缺字段回对应技能修订后重生成，禁止手修后直接建索引", "修复上游文件后重跑本命令");
  }
  return parsed;
}

/** 三段式错误：哪个输入不合法 → 权威源在哪里 → 修改后运行哪个命令（设计 §7 错误消息统一形态） */
function fatal(headline, source, recovery, code = 1) {
  process.stderr.write(`FAIL: verification-index: ${headline}\n  权威源：${source}\n  恢复：${recovery}\n`);
  process.exit(code);
}

/** 三段式单条消息（不退出）——check 子命令收集问题清单用 */
function failLine(headline, source, recovery) {
  return `FAIL: verification-index: ${headline}\n  权威源：${source}\n  恢复：${recovery}`;
}

function parseArgs(argv, flagsWithValues) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (flagsWithValues.includes(key)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fatal(`参数 ${key} 缺值`, "用法见脚本头注释", USAGE, 2);
      out[key] = value;
      i += 1;
    } else if (key.startsWith("--")) {
      out[key] = true;
    } else {
      out._.push(key);
    }
  }
  return out;
}

/** 数组去重，保持首次出现序 */
function uniq(items) {
  return [...new Set(items)];
}

// 设计目录推导：与 dev-flow-v6/scripts/check-exec-plan.mjs designDirFromDocPath 逐字同源——
// 渲染视图 <slug>/<name>.rendered.md → 设计目录 <slug>/<name>/（六章节 JSON 权威源所在子目录，
// 布局权威 = dev-workflow references/skill-data-addressing.md §2：rendered.md 与 <name>/ 平铺同层）；
// designDocPath 本身已是目录形态时原样返回。designDirFromDocPath 未在 check-exec-plan.mjs 的
// export 清单中，目录推导逻辑在此复刻，两处须同源演化（与该脚本复刻 delivery-gate
// canonicalJson / acceptancePackageSha256 的同步纪律同款）
function designDirFromDocPath(designDocPath) {
  if (designDocPath.endsWith(".rendered.md")) {
    return join(dirname(designDocPath), basename(designDocPath, ".rendered.md"));
  }
  return designDocPath;
}

function isStrArr(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// ── build：读五类输入 ──

function readInputs(execPlanPath) {
  const execPlan = readJsonFile(execPlanPath, "exec-plan");
  if (execPlan === null) {
    fatal(`exec-plan 文件不存在：${execPlanPath}`, "exec-plan 是 dev-flow-v6 D0 编译产物（flow/compile.md 步骤 2）", "先完成 D0 编译清单生成 exec-plan，再运行本命令重建索引");
  }
  if (typeof execPlan.planPath !== "string" || typeof execPlan.designDocPath !== "string") {
    fatal(`exec-plan 缺 planPath / designDocPath（实际：planPath=${JSON.stringify(execPlan.planPath)}, designDocPath=${JSON.stringify(execPlan.designDocPath)}）`, "exec-plan 顶层 W3 启动契约必填字段（compile.md §2 结构）", "核对 exec-plan 内容或回 D0 编译清单重生成后重跑本命令");
  }
  const implPlanPath = resolve(execPlan.planPath);
  const implPlan = readJsonFile(implPlanPath, "impl-plan");
  if (implPlan === null) {
    fatal(`planPath 指向的实施计划不存在：${implPlanPath}`, "impl-plan.json 是 tech-design-v6 T3 的唯一计划权威（flow/plan.md「JSON 单源产出」）", "回 tech-design-v6 T3 产出 impl-plan.json（含渲染）后重跑本命令");
  }
  // designDocPath 指向渲染视图，设计目录 = <name>/ 子目录（口径与 check-exec-plan 同源，见 designDirFromDocPath 注）
  const designDir = designDirFromDocPath(resolve(execPlan.designDocPath));
  if (!existsSync(designDir)) {
    fatal(`designDocPath 推导的设计目录不存在：${designDir}`, "设计目录是 tech-design-v6 设计包权威（六章节 JSON）", "核对 exec-plan designDocPath 取值后重跑本命令");
  }
  const designFiles = {};
  for (const name of DESIGN_PACKAGE_FILES) {
    const parsed = readJsonFile(join(designDir, name), `设计章节 ${name}`);
    if (parsed !== null) designFiles[name] = parsed;
  }
  const meta = designFiles["meta.json"] ?? null;
  const s3 = designFiles["s3-solution.json"] ?? null;
  const s4 = designFiles["s4-accept.json"] ?? null;
  if (s3 === null || s4 === null) {
    fatal(`设计目录缺 s3-solution.json 或 s4-accept.json：${designDir}`, "六章节设计 JSON 是设计语义权威（tech-design-v6 references/design-doc-schema.md）", "回 tech-design-v6 补齐章节 JSON 后重跑本命令");
  }
  // taskDir 从设计包 meta.json acceptanceBinding 推导（交付体系任务必填；独立设计任务省略 → 验收包可缺省）
  const binding = meta !== null && typeof meta.acceptanceBinding === "object" && meta.acceptanceBinding !== null ? meta.acceptanceBinding : null;
  let taskDir = null;
  if (binding !== null && typeof binding.taskDir === "string" && binding.taskDir.trim() !== "") taskDir = resolve(binding.taskDir);
  let acceptance = null;
  let increments = null;
  if (taskDir !== null) {
    acceptance = readJsonFile(join(taskDir, "acceptance.json"), "验收包 acceptance.json");
    if (acceptance === null) {
      fatal(`设计包 acceptanceBinding.taskDir 指向的任务目录缺 acceptance.json：${taskDir}`, "验收包是 delivery-v6 验收设计权威（批准后冻结）", "核对设计包 meta.json acceptanceBinding 指向，或回 delivery-v6 补验收包后重跑本命令");
    }
    increments = readJsonFile(join(taskDir, "increments.json"), "increments.json");
  }
  const capabilitiesPath = join(dirname(resolve(execPlanPath)), "project-capabilities.json");
  const capabilities = readJsonFile(capabilitiesPath, "能力快照 project-capabilities.json");
  return { execPlan, implPlan, designFiles, acceptance, increments, capabilities };
}

// ── build：派生 rows ──

function deriveRows({ execPlan, implPlan, acceptance, designFiles }) {
  const s3 = designFiles["s3-solution.json"];
  const s4 = designFiles["s4-accept.json"];
  const mechanisms = Array.isArray(s4.criterionMechanisms) ? s4.criterionMechanisms : [];
  const decisions = Array.isArray(s3.decisions) ? s3.decisions : [];
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const units = Array.isArray(implPlan.units) ? implPlan.units : [];
  const unitIdSet = new Set(units.map((u) => u.id));
  const unitIdsByIncrement = new Map();
  for (const u of units) {
    if (typeof u.incrementId === "string" && u.incrementId !== "") {
      if (!unitIdsByIncrement.has(u.incrementId)) unitIdsByIncrement.set(u.incrementId, []);
      unitIdsByIncrement.get(u.incrementId).push(u.id);
    }
  }
  const acceptancePlan = Array.isArray(implPlan.acceptancePlan) ? implPlan.acceptancePlan : [];
  const acceptanceNodes =
    execPlan.mode === "acceptance" && execPlan.acceptance && Array.isArray(execPlan.acceptance.nodes) ? execPlan.acceptance.nodes : [];

  // 断言全集：验收包断言 ∪ 设计包对账行登记的断言（验收包缺省的独立设计任务从后者取全集）
  const assertionIds = [];
  if (acceptance !== null && Array.isArray(acceptance.requirements)) {
    for (const req of acceptance.requirements) {
      for (const assertion of Array.isArray(req.assertions) ? req.assertions : []) {
        if (!assertionIds.includes(assertion.id)) assertionIds.push(assertion.id);
      }
    }
  }
  for (const row of mechanisms) {
    if (typeof row.assertionId === "string" && !assertionIds.includes(row.assertionId)) assertionIds.push(row.assertionId);
  }

  const formsByAssertion = new Map();
  const scenarioIds = [];
  if (acceptance !== null && Array.isArray(acceptance.adversarialForms)) {
    for (const form of acceptance.adversarialForms) {
      scenarioIds.push(form.id);
      if (!formsByAssertion.has(form.assertionId)) formsByAssertion.set(form.assertionId, []);
      formsByAssertion.get(form.assertionId).push(form.id);
    }
  }
  const assertionById = new Map();
  if (acceptance !== null && Array.isArray(acceptance.requirements)) {
    for (const req of acceptance.requirements) {
      for (const assertion of Array.isArray(req.assertions) ? req.assertions : []) assertionById.set(assertion.id, assertion);
    }
  }

  const rows = assertionIds.map((assertionId) => {
    const decisionIds = uniq(
      mechanisms
        .filter((row) => row.assertionId === assertionId)
        .flatMap((row) => (isStrArr(row.decisionIds) ? row.decisionIds : [])),
    );
    // 反例场景：断言侧 refs ∪ 场景侧 assertionId 反查（validate-acceptance 强制双向一致，取并集防单侧遗漏）
    const adversarialFormIds = uniq([
      ...(isStrArr(assertionById.get(assertionId)?.adversarialFormRefs) ? assertionById.get(assertionId).adversarialFormRefs : []),
      ...(formsByAssertion.get(assertionId) ?? []),
    ]);
    const formSet = new Set(adversarialFormIds);
    // 单元三通道（派生链见头注释）：设计拆分单元 / 增量归属单元 / 验收计划依赖单元
    const unitRefs = uniq(decisionIds.flatMap((id) => (isStrArr(decisionById.get(id)?.unitRefs) ? decisionById.get(id).unitRefs : [])));
    const incrementUnits = uniq(
      (isStrArr(assertionById.get(assertionId)?.dependsOn?.incrementIds) ? assertionById.get(assertionId).dependsOn.incrementIds : []).flatMap(
        (incId) => unitIdsByIncrement.get(incId) ?? [],
      ),
    );
    const claimedPlans = acceptancePlan.filter((row) => (isStrArr(row.adversarialFormRefs) ? row.adversarialFormRefs : []).some((id) => formSet.has(id)));
    const planDepUnits = uniq(claimedPlans.flatMap((row) => (isStrArr(row.deps) ? row.deps : []).filter((id) => unitIdSet.has(id))));
    const unitIdsOut = uniq([...unitRefs, ...incrementUnits, ...planDepUnits]);
    // 验证资产：仅 reuse:<id> 形态产生资产 id（`new` / `inspect-only` / `-` 不指向已有资产）
    const verificationAssetIds = uniq(
      claimedPlans
        .map((row) => (typeof row.verifyAsset === "string" && row.verifyAsset.startsWith("reuse:") ? row.verifyAsset.slice("reuse:".length).trim() : null))
        .filter((id) => id !== null && id !== ""),
    );
    // 验收节点：acceptance exec-plan 已生成时，按节点 adversarialFormRefs 与本断言场景集的交集归属
    const acceptanceNodeIds = uniq(
      acceptanceNodes
        .filter((node) => (isStrArr(node.adversarialFormRefs) ? node.adversarialFormRefs : []).some((id) => formSet.has(id)))
        .map((node) => node.id),
    );
    return { assertionId, decisionIds, unitIds: unitIdsOut, adversarialFormIds, verificationAssetIds, acceptanceNodeIds };
  });
  return { rows, scenarioIds, unitIds: units.map((u) => u.id) };
}

/** 读五类输入 → 派生 rows → 资产回溯校验 → 组装索引对象。build 与 check 共用同一派生路径，
 *  保证「重新生成后无差异」检查与生成逻辑不会漂移成两套。 */
function computeIndex(execPlanPath, outPath) {
  const inputs = readInputs(execPlanPath);
  const { rows, scenarioIds, unitIds } = deriveRows(inputs);
  // 资产回溯校验（§5.2「资产 id 必须能回溯到能力快照中的真实资产」）：快照在场即逐条对照
  // （verificationAssets 为空清单的快照同样对照——reuse:<id> 必然悬空），幽灵资产 id 是输入
  // 引用悬空（与 criterionMechanisms 引用未知断言同级的不合法输入），三段式报错回 T3 /
  // 重建快照——这不是计划缺漏判定，缺漏判定仍归 check-quality-contract
  const assets = inputs.capabilities !== null && Array.isArray(inputs.capabilities.verificationAssets) ? inputs.capabilities.verificationAssets : [];
  const knownAssetIds = new Set(assets.map((asset) => asset.id));
  const ghostAssets = uniq(rows.flatMap((row) => row.verificationAssetIds)).filter((id) => !knownAssetIds.has(id));
  if (inputs.capabilities !== null && ghostAssets.length > 0) {
    fatal(
      `verificationAssetIds 引用了能力快照中不存在的资产 id：${ghostAssets.join("、")}`,
      `验证资产权威 = ${dirname(resolve(execPlanPath))}/project-capabilities.json 的 verificationAssets（来源：项目 verification skill 场景清单，由 detect-project-capabilities.mjs 探测）；impl-plan verifyAsset=reuse:<id> 的 id 必须真实存在于快照`,
      "回 tech-design-v6 T3 核对 verifyAsset 引用（对照项目 verification skill 场景清单）后重渲染，或运行 detect-project-capabilities.mjs 重建过期快照，再运行本命令重建索引",
    );
  }
  // dev 节点 territory 登记：--reviewer-seeds 的文件→单元映射域（索引自包含，查询不回读 exec-plan）
  const devUnits = (inputs.execPlan.mode === "dev" && Array.isArray(inputs.execPlan.nodes) ? inputs.execPlan.nodes : [])
    .filter((node) => node.kind === "dev" && isStrArr(node.territory))
    .map((node) => ({ id: node.id, territory: node.territory }));
  const inputHashes = {
    acceptancePackage: inputs.acceptance !== null ? acceptancePackageSha256(inputs.acceptance, inputs.increments) : null,
    designPackage: sha256Canonical(inputs.designFiles),
    implPlan: sha256Canonical(inputs.implPlan),
    projectCapabilities: inputs.capabilities !== null ? sha256Canonical(inputs.capabilities) : null,
    execPlan: sha256Canonical(inputs.execPlan),
  };
  const index = {
    schemaVersion: 1,
    generator: GENERATOR,
    rebuildCommand: `node ~/.agents/skills/dev-flow-v6/scripts/verification-index.mjs build --exec-plan ${execPlanPath} --out ${outPath}`,
    inputHashes,
    unitIds,
    scenarioIds,
    devUnits,
    rows,
  };
  // 快照缺省 = 资产 id 无从回溯，显式登记核验缺口（「未核验」比静默通过诚实；快照在场时无 note）
  if (inputs.capabilities === null) {
    index.note = "资产 id 未核验（能力快照缺失：exec-plan 同目录无 project-capabilities.json；运行 detect-project-capabilities.mjs 生成后重建索引可补核验）";
  }
  return index;
}

function cmdBuild(argv) {
  const args = parseArgs(argv, ["--exec-plan", "--out"]);
  if (!args["--exec-plan"]) fatal("build 缺 --exec-plan 参数", "用法见脚本头注释", USAGE, 2);
  const execPlanPath = resolve(args["--exec-plan"]);
  const outPath = args["--out"] ? resolve(args["--out"]) : join(dirname(execPlanPath), "verification-index.json");
  const index = computeIndex(execPlanPath, outPath);
  // 全量重建：整文件覆盖写，手改会被下次重建覆盖——本文件禁止手改（rebuildCommand 字段即生成命令与输入哈希见证）
  writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n");
  process.stdout.write(`PASS: verification-index 写入 ${outPath}（断言 ${index.rows.length} 条）\n`);
}

/** 防手改检查（设计 §7.4：输入哈希或生成内容不一致时报错并输出重新生成命令）：
 *  ① 重算五输入哈希对照登记值——不等 = 输入漂移（输入在索引生成后变了）；
 *  ② 用同一派生路径重新生成索引内容对照盘上文件——不一致 = 索引被手改（含 rows/清单被改）。
 *  两类可分则分：哈希差逐键列出（输入漂移），内容差逐字段列出（手改嫌疑）。 */
function cmdCheck(argv) {
  const args = parseArgs(argv, ["--exec-plan", "--index"]);
  if (!args["--exec-plan"]) fatal("check 缺 --exec-plan 参数", "用法见脚本头注释", USAGE, 2);
  const execPlanPath = resolve(args["--exec-plan"]);
  const indexPath = args["--index"] ? resolve(args["--index"]) : join(dirname(execPlanPath), "verification-index.json");
  const onDisk = readJsonFile(indexPath, "verification-index");
  if (onDisk === null) {
    fatal(`索引文件不存在：${indexPath}`, "verification-index.json 由本工具 build 子命令生成（禁止手改）", `运行 node ~/.agents/skills/dev-flow-v6/scripts/verification-index.mjs build --exec-plan ${execPlanPath} --out ${indexPath} 重建索引`);
  }
  if (typeof onDisk.inputHashes !== "object" || onDisk.inputHashes === null) {
    fatal(`索引缺 inputHashes（或形态不对）：${indexPath}`, "inputHashes 五键是防手改对账基线（§5.2），缺键 = 索引被手改或旧版本索引", `运行 node ~/.agents/skills/dev-flow-v6/scripts/verification-index.mjs build --exec-plan ${execPlanPath} --out ${indexPath} 重建索引`);
  }
  const expected = computeIndex(execPlanPath, typeof onDisk.rebuildCommand === "string" && onDisk.rebuildCommand.includes("--out ") ? onDisk.rebuildCommand.split("--out ")[1] : indexPath);
  const problems = [];
  const source = `verification-index.json 是只读派生索引（禁止手改，可删除重建）；对账基线 = 五输入的 canonical 哈希与派生内容`;
  const recovery = `运行 node ~/.agents/skills/dev-flow-v6/scripts/verification-index.mjs build --exec-plan ${execPlanPath} --out ${indexPath} 重建索引`;
  // ① 输入漂移：重算哈希对照登记值（acceptancePackage 为 null = 独立设计任务无验收包，等值合法）
  for (const key of ["acceptancePackage", "designPackage", "implPlan", "projectCapabilities", "execPlan"]) {
    if (!Object.hasOwn(onDisk.inputHashes, key)) {
      problems.push(failLine(`索引 inputHashes 缺键 ${key}（手改嫌疑或旧版本索引）`, source, recovery));
      continue;
    }
    if (onDisk.inputHashes[key] !== expected.inputHashes[key]) {
      problems.push(failLine(`输入漂移：inputHashes.${key} 登记值与当前输入重算值不一致`, `该输入在索引生成后被修改；五输入哈希是重建基线（§5.2）`, recovery));
    }
  }
  // ② 手改嫌疑：同一派生路径重新生成的内容对照盘上文件（哈希全对但 rows/清单被改也在此拦住）
  for (const key of ["schemaVersion", "generator", "rebuildCommand", "unitIds", "scenarioIds", "devUnits", "rows", "note"]) {
    if (canonicalJson(onDisk[key]) !== canonicalJson(expected[key])) {
      problems.push(failLine(`索引内容与输入派生不一致：字段 ${key} 被手改（或由旧输入生成后输入又回退）`, source, recovery));
    }
  }
  if (problems.length > 0) {
    process.stderr.write(problems.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write(`PASS: verification-index 一致（五输入哈希与派生内容均可对账，断言 ${expected.rows.length} 条）\n`);
}

// ── query ──

function loadIndex(path) {
  const index = readJsonFile(path, "verification-index");
  if (index === null) {
    fatal(`索引文件不存在：${path}`, "verification-index.json 由本工具 build 子命令生成（禁止手改）", "先运行 node ~/.agents/skills/dev-flow-v6/scripts/verification-index.mjs build --exec-plan <exec-plan.json> 重建索引");
  }
  const rows = Array.isArray(index.rows) ? index.rows : [];
  return { index, rows };
}

function outputJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** reviewer 初始候选：文件 → dev 节点 territory 前缀匹配 → 单元 → rows 反查。
 *  前缀语义与 exec-plan territory 一致（条目 = 相对仓库根的文件或目录前缀）；
 *  一个文件命中多个单元时收集全部命中单元（territory 多单元重合的候选不裁剪）。 */
function reviewerSeeds(rows, devUnits, files) {
  const matchedUnits = new Set();
  const unmapped = [];
  let multiUnitHit = false;
  for (const file of files) {
    const hits = devUnits.filter((unit) => unit.territory.some((t) => file === t || file.startsWith(t.replace(/\/$/, "") + "/")));
    if (hits.length === 0) unmapped.push(file);
    else {
      for (const unit of hits) matchedUnits.add(unit.id);
      if (hits.length > 1) multiUnitHit = true;
    }
  }
  const hitRows = rows.filter((row) => row.unitIds.some((id) => matchedUnits.has(id)));
  // seeds.units 含全部命中单元（含与断言暂无引用链的命中单元——空引用集合也是候选事实）
  const seeds = {
    units: [...matchedUnits],
    designEntries: uniq(hitRows.flatMap((row) => row.decisionIds)),
    assertions: uniq(hitRows.map((row) => row.assertionId)),
    scenarios: uniq(hitRows.flatMap((row) => row.adversarialFormIds)),
    acceptanceNodes: uniq(hitRows.flatMap((row) => row.acceptanceNodeIds)),
  };
  // §5.2 / §6.3 第 6 条：索引只作初始定位——存在未映射文件 / 多单元重合 / 无 dev 节点可匹配
  // （如 acceptance 模式重建后的索引）时必须注明回退现行分区审查，完整分区 diff 始终完整提供
  let fallback = null;
  if (unmapped.length > 0 || devUnits.length === 0) {
    fallback = "存在未映射文件或索引无 dev 节点可匹配——回退现行分区审查范围（完整 diff 始终完整提供），reviewer 可主动向外扩展";
  } else if (multiUnitHit) {
    fallback = "territory 多单元重合（同一文件命中多个单元，单元归属不可机器裁决）——回退现行分区审查范围（完整 diff 始终完整提供），reviewer 可主动向外扩展";
  }
  return { seeds, unmappedFiles: unmapped, fallback };
}

function cmdQuery(argv) {
  const args = parseArgs(argv, ["--index", "--assertion", "--unit", "--asset", "--files"]);
  if (!args["--index"]) fatal("query 缺 --index 参数", "用法见脚本头注释", USAGE, 2);
  const modes = ["--assertion", "--unit", "--asset", "--empty-refs", "--reviewer-seeds"].filter((k) => args[k]);
  if (modes.length !== 1) fatal("query 必须且只能指定一种查询（--assertion / --unit / --asset / --empty-refs / --reviewer-seeds）", "用法见脚本头注释", USAGE, 2);
  const { index, rows } = loadIndex(resolve(args["--index"]));

  if (args["--assertion"]) {
    const row = rows.find((entry) => entry.assertionId === args["--assertion"]);
    if (!row) fatal(`断言 ${args["--assertion"]} 不在索引 rows 中`, `索引 ${args["--index"]} 的断言全集来自验收包与设计包 criterionMechanisms（共 ${rows.length} 条）`, "核对断言 id；断言是新增的则回验收包/设计包修订并重建索引", 1);
    outputJson(row);
    return;
  }
  if (args["--unit"]) {
    const unitId = args["--unit"];
    const hit = rows.filter((row) => row.unitIds.includes(unitId));
    if (hit.length === 0) {
      // 空结果 = 查询事实非缺漏判定（§5.2 红线）：单元与断言间无显式引用链时如实返回空
      outputJson({ unitId, assertions: [], note: "索引无该单元的直接引用记录（单元与断言间无显式引用链，属查询事实非缺漏判定）；完整失效范围仍按 acceptance dependsOn 与既有质量检查判定" });
      return;
    }
    outputJson({ unitId, assertions: hit.map((row) => ({ assertionId: row.assertionId, verificationAssetIds: row.verificationAssetIds, acceptanceNodeIds: row.acceptanceNodeIds })) });
    return;
  }
  if (args["--asset"]) {
    const assetId = args["--asset"];
    const hit = rows.filter((row) => row.verificationAssetIds.includes(assetId));
    if (hit.length === 0) {
      outputJson({ assetId, assertions: [], note: "索引无该资产的直接引用记录（资产经 acceptancePlan verifyAsset=reuse:<id> 连接，属查询事实非缺漏判定）" });
      return;
    }
    outputJson({ assetId, assertions: hit.map((row) => row.assertionId) });
    return;
  }
  if (args["--empty-refs"]) {
    // 空引用集合只是查询事实（§5.2 红线）：是否构成缺漏由 check-quality-contract 等既有检查判定
    const emptyAssertions = rows
      .map((row) => ({ assertionId: row.assertionId, emptyFields: ROW_REF_FIELDS.filter((field) => Array.isArray(row[field]) && row[field].length === 0) }))
      .filter((row) => row.emptyFields.length > 0);
    const claimedUnitIds = new Set(rows.flatMap((row) => row.unitIds));
    const claimedScenarioIds = new Set(rows.flatMap((row) => row.adversarialFormIds));
    outputJson({
      assertionsWithEmptyRefs: emptyAssertions,
      // unitsWithoutRefs 只覆盖 impl-plan 开发域（顶层 unitIds 登记口径）；设计拆分单元的引用
      // 情况看 rows.unitIds 的 U 前缀条目，不在本清单判定域
      unitsWithoutRefs: (Array.isArray(index.unitIds) ? index.unitIds : []).filter((id) => !claimedUnitIds.has(id)),
      scenariosWithoutRefs: (Array.isArray(index.scenarioIds) ? index.scenarioIds : []).filter((id) => !claimedScenarioIds.has(id)),
      note: "空引用集合 = 查询事实，计划缺漏判定归 check-quality-contract / formNotApplicable / 既有流程；unitsWithoutRefs 只覆盖 impl-plan 开发域单元（rows.unitIds 另混设计拆分单元域）",
    });
    return;
  }
  // --reviewer-seeds
  if (!args["--files"]) fatal("--reviewer-seeds 需配 --files <f1,f2>（逗号分隔的改动文件，相对仓库根）", "用法见脚本头注释", USAGE, 2);
  const files = args["--files"].split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (files.length === 0) fatal("--files 为空（解析结果无有效文件名）", "用法见脚本头注释", USAGE, 2);
  const devUnits = Array.isArray(index.devUnits) ? index.devUnits : [];
  outputJson(reviewerSeeds(rows, devUnits, files));
}

// ── 入口 ──

const [, , subcommand, ...rest] = process.argv;
if (subcommand === "build") cmdBuild(rest);
else if (subcommand === "check") cmdCheck(rest);
else if (subcommand === "query") cmdQuery(rest);
else fatal(`未知子命令：${subcommand ?? "（缺省）"}`, "本工具只有 build / check / query 三个子命令", USAGE, 2);
