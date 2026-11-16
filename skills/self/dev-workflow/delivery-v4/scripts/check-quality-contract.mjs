#!/usr/bin/env node
// V4 质量契约联合校验：验收断言 → 设计机制与反例场景 → 实施测试绑定。
// schema 1 任务直接放行；schema 2 的结构完备性在此统一判定，语义等价仍由独立 reviewer 负责。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const USAGE = "用法：node check-quality-contract.mjs --task-dir <交付任务目录> [--design-dir <设计目录>] [--exec-plan <执行计划>]";

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不可读或不是合法 JSON：${path}（${error.message}）`);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function main() {
  const args = process.argv.slice(2);
  let taskDir = "";
  let designDir = "";
  let execPlanPath = "";
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--task-dir", "--design-dir", "--exec-plan"].includes(key) || !value) {
      console.error(`未知或不完整参数 ${key}。${USAGE}`);
      process.exit(2);
    }
    if (key === "--task-dir") taskDir = resolve(value);
    if (key === "--design-dir") designDir = resolve(value);
    if (key === "--exec-plan") execPlanPath = resolve(value);
    index += 1;
  }
  if (!taskDir || (!designDir && !execPlanPath)) {
    console.error(`至少提供 --design-dir 或 --exec-plan 之一。${USAGE}`);
    process.exit(2);
  }

  const acceptance = readJson(resolve(taskDir, "acceptance.json"), "验收文件");
  if (acceptance.schemaVersion === 1) {
    console.log("PASS: schema 1 任务沿用需求级判定，无 V4 质量契约附加检查");
    return;
  }
  if (acceptance.schemaVersion !== 2) {
    console.error("FAIL: acceptance: schemaVersion 必须为 1 或 2；先运行 delivery-gate validate-acceptance");
    process.exit(1);
  }

  const errors = [];
  const assertions = acceptance.requirements.flatMap((requirement) =>
    requirement.assertions.map((assertion) => ({ ...assertion, requirementId: requirement.id })),
  );
  const assertionIds = new Set(assertions.map((assertion) => assertion.id));
  const forms = acceptance.adversarialForms;
  const formIds = new Set(forms.map((form) => form.id));

  if (designDir) {
    const s3 = readJson(resolve(designDir, "s3-solution.json"), "方案章节");
    const s4 = readJson(resolve(designDir, "s4-accept.json"), "验收章节");
    const decisionIds = new Set((s3.decisions ?? []).map((decision) => decision.id));
    const mechanisms = Array.isArray(s4.criterionMechanisms) ? s4.criterionMechanisms : [];
    const bindings = Array.isArray(s4.verificationBindings) ? s4.verificationBindings : [];
    const mechanismByAssertion = new Map();
    for (const row of mechanisms) {
      if (!assertionIds.has(row.assertionId)) errors.push(`criterionMechanisms 引用未知断言 ${row.assertionId}`);
      if (!nonEmptyStrings(row.decisionIds)) errors.push(`断言 ${row.assertionId} 没有关联设计决策`);
      for (const id of row.decisionIds ?? []) {
        if (!decisionIds.has(id)) errors.push(`断言 ${row.assertionId} 引用未知设计决策 ${id}`);
      }
      if (!nonEmptyStrings(row.mechanismRefs)) errors.push(`断言 ${row.assertionId} 缺机制条款位置`);
      if (row.consistency !== "pass") errors.push(`断言 ${row.assertionId} 与机制未通过一致性检查（consistency=${row.consistency}）`);
      if (!nonEmpty(row.counterexample)) errors.push(`断言 ${row.assertionId} 缺反例检查过程或未反例说明`);
      if (!mechanismByAssertion.has(row.assertionId)) mechanismByAssertion.set(row.assertionId, []);
      mechanismByAssertion.get(row.assertionId).push(row);
    }
    for (const id of assertionIds) {
      if (!mechanismByAssertion.has(id)) errors.push(`断言 ${id} 缺 criterionMechanisms 对账行`);
    }

    const bindingByForm = new Map();
    for (const row of bindings) {
      if (!formIds.has(row.adversarialFormId)) errors.push(`verificationBindings 引用未知反例场景 ${row.adversarialFormId}`);
      if (!nonEmpty(row.testRef)) errors.push(`反例场景 ${row.adversarialFormId} 缺 testRef`);
      if (!nonEmptyStrings(row.preconditions)) errors.push(`反例场景 ${row.adversarialFormId} 缺实际前置条件`);
      if (!nonEmptyStrings(row.actions)) errors.push(`反例场景 ${row.adversarialFormId} 缺实际操作步骤`);
      if (!nonEmptyStrings(row.assertions)) errors.push(`反例场景 ${row.adversarialFormId} 缺测试断言位置`);
      if (!bindingByForm.has(row.adversarialFormId)) bindingByForm.set(row.adversarialFormId, []);
      bindingByForm.get(row.adversarialFormId).push(row);
      const form = forms.find((item) => item.id === row.adversarialFormId);
      if (form && !form.testAssetRefs.includes(row.testRef)) {
        errors.push(`反例场景 ${row.adversarialFormId} 的 testRef=${row.testRef} 未在验收包 testAssetRefs 登记`);
      }
    }
    for (const id of formIds) {
      if (!bindingByForm.has(id)) errors.push(`反例场景 ${id} 缺 verificationBindings 测试绑定`);
    }
  }

  if (execPlanPath) {
    const execPlan = readJson(execPlanPath, "执行计划");
    const implPlan = readJson(resolve(execPlan.planPath), "实施计划");
    const acceptancePlan = Array.isArray(implPlan.acceptancePlan) ? implPlan.acceptancePlan : [];
    const covered = new Set();
    for (const row of acceptancePlan) {
      for (const id of row.adversarialFormRefs ?? []) {
        if (!formIds.has(id)) errors.push(`acceptancePlan 引用未知反例场景 ${id}`);
        covered.add(id);
      }
    }
    for (const id of formIds) {
      if (!covered.has(id)) errors.push(`反例场景 ${id} 未进入 impl-plan.acceptancePlan`);
    }
    if (execPlan.mode === "acceptance") {
      const nodeCoverage = new Set();
      for (const node of execPlan.acceptance?.nodes ?? []) {
        for (const id of node.adversarialFormRefs ?? []) nodeCoverage.add(id);
      }
      for (const id of formIds) {
        if (!nodeCoverage.has(id)) errors.push(`反例场景 ${id} 未进入 D3 acceptance.nodes`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.log(`FAIL: quality: ${error}`);
    console.log("按以上引用关系补齐验收、设计与实施计划后重跑；机器只检查结构，语义等价须由独立 reviewer 判定。");
    process.exit(1);
  }
  console.log(`PASS: 断言 ${assertionIds.size} 条、反例场景 ${formIds.size} 条的机制与测试绑定完整`);
}

try {
  main();
} catch (error) {
  console.error(`FAIL: io: ${error.message}`);
  process.exit(1);
}
