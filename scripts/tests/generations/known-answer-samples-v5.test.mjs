import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SAMPLES_PATH = join(
  ROOT,
  "skills",
  "self",
  "dev-workflow",
  "delivery-v5",
  "policies",
  "known-answer-samples.json",
);

// 合并设计稿 §12.1 七条样例表的「最早必须发现它的阶段」列原文（保真固化：改表须同步本数组）
const DOC_STAGE_TEXTS = [
  "T3 场景拆解或 D2 三方对账",
  "验收反例场景或 T1 机制对账",
  "T3 入口矩阵或 D2 局部实验",
  "T1 存储状态分析或 D2",
  "T2 判据与机制对账（必须发现）",
  "T1 状态分析或 D2 状态迁移测试",
  "T3 时序矩阵或候选反例审查",
];

// docStageText 中的阶段标记 → stageVocabulary id（测试口径：两列必须一一对应）
const STAGE_MARKERS = [
  { marker: "验收反例", stageId: "acceptance-counterexample" },
  { marker: "T1", stageId: "t1-mechanism-reconciliation" },
  { marker: "T2", stageId: "t2-main-review" },
  { marker: "T3", stageId: "t3-scenario-split" },
  { marker: "D2", stageId: "d2-three-way" },
  { marker: "候选反例审查", stageId: "candidate-exploration" },
];

// 每条样例的行为关键词（防行为描述被改写到丢失判据限定词的可辨识度）
const BEHAVIOR_KEYWORDS = {
  "KAS-1": ["长度限制", "编辑"],
  "KAS-2": ["作用范围", "项目"],
  "KAS-3": ["只读", "异常"],
  "KAS-4": ["损坏", "指纹"],
  "KAS-5": ["指纹", "kind", "去重"],
  "KAS-6": ["空注入", "召回"],
  "KAS-7": ["shutdown", "写盘"],
};

const doc = JSON.parse(readFileSync(SAMPLES_PATH, "utf8"));

test("样例文件头注释声明 expectedStageAccuracy 呼应关系", () => {
  const comment = doc._comment;
  assert.ok(comment, "缺 _comment 头");
  for (const key of ["purpose", "expectedStageAccuracy", "source", "anchorsNote"]) {
    assert.equal(typeof comment[key], "string", `_comment.${key} 须为非空字符串`);
    assert.ok(comment[key].length > 0, `_comment.${key} 不得为空`);
  }
  assert.match(
    comment.expectedStageAccuracy,
    /delivery-quality-stats/,
    "expectedStageAccuracy 说明须指向 delivery-quality-stats 指标",
  );
  assert.match(
    comment.expectedStageAccuracy,
    /expectedStageAccuracy/,
    "expectedStageAccuracy 说明须含指标名",
  );
});

test("阶段词表完备且 id 唯一", () => {
  assert.ok(Array.isArray(doc.stageVocabulary) && doc.stageVocabulary.length >= 6);
  const ids = new Set();
  for (const stage of doc.stageVocabulary) {
    assert.equal(typeof stage.id, "string", "stage.id 须为字符串");
    assert.equal(typeof stage.name, "string", `stage ${stage.id} 缺 name`);
    assert.equal(typeof stage.description, "string", `stage ${stage.id} 缺 description`);
    assert.ok(stage.description.length > 0, `stage ${stage.id} description 不得为空`);
    assert.ok(!ids.has(stage.id), `stage id 重复：${stage.id}`);
    ids.add(stage.id);
  }
  for (const { stageId } of STAGE_MARKERS) {
    assert.ok(ids.has(stageId), `词表缺阶段 ${stageId}`);
  }
});

test("七条样例齐全、字段完备、阶段值在词表内", () => {
  assert.ok(Array.isArray(doc.samples), "缺 samples 数组");
  assert.equal(doc.samples.length, 7, "须恰好七条样例");
  const stageIds = new Set(doc.stageVocabulary.map((stage) => stage.id));
  const seenIds = new Set();
  for (const sample of doc.samples) {
    assert.ok(sample.id, "样例缺 id");
    assert.ok(!seenIds.has(sample.id), `样例 id 重复：${sample.id}`);
    seenIds.add(sample.id);
    assert.equal(typeof sample.behavior, "string", `${sample.id} 缺 behavior`);
    assert.ok(sample.behavior.length > 10, `${sample.id} behavior 过短`);
    assert.equal(typeof sample.docStageText, "string", `${sample.id} 缺 docStageText`);
    assert.ok(sample.behavior, `${sample.id} behavior 非空`);
    const qualifierSource = sample.qualifierSource;
    assert.ok(qualifierSource, `${sample.id} 缺 qualifierSource`);
    assert.equal(typeof qualifierSource.qualifier, "string", `${sample.id} 缺 qualifierSource.qualifier`);
    assert.ok(qualifierSource.qualifier.length > 0, `${sample.id} qualifier 不得为空`);
    assert.equal(typeof qualifierSource.sourceRef, "string", `${sample.id} 缺 qualifierSource.sourceRef`);
    assert.ok(qualifierSource.sourceRef.length > 0, `${sample.id} sourceRef 不得为空`);
    assert.ok(Array.isArray(sample.expectedStages) && sample.expectedStages.length > 0, `${sample.id} 缺 expectedStages`);
    for (const entry of sample.expectedStages) {
      assert.ok(stageIds.has(entry.stage), `${sample.id} 阶段值 ${entry.stage} 不在 stageVocabulary 内`);
      assert.equal(typeof entry.mechanism, "string", `${sample.id}.${entry.stage} 缺 mechanism`);
      assert.ok(entry.mechanism.length > 0, `${sample.id}.${entry.stage} mechanism 不得为空`);
    }
  }
  assert.equal(seenIds.size, 7, "七条样例 id 须互不相同");
});

test("docStageText 与设计稿表格值一致（保真固化）", () => {
  assert.deepEqual(
    doc.samples.map((sample) => sample.docStageText),
    DOC_STAGE_TEXTS,
    "七条样例的最早应发现阶段须与合并设计稿 §12.1 表格值逐条一致",
  );
});

test("docStageText 提到的阶段与 expectedStages 一一对应", () => {
  for (const sample of doc.samples) {
    const marked = STAGE_MARKERS.filter(({ marker }) => sample.docStageText.includes(marker)).map(({ stageId }) => stageId);
    const declared = sample.expectedStages.map((entry) => entry.stage);
    assert.deepEqual(
      [...declared].sort(),
      [...marked].sort(),
      `${sample.id} docStageText 阶段标记与 expectedStages 不一致（docStageText=${sample.docStageText}）`,
    );
  }
});

test("行为描述保留判据限定词可辨识关键词", () => {
  for (const sample of doc.samples) {
    const keywords = BEHAVIOR_KEYWORDS[sample.id];
    assert.ok(keywords, `${sample.id} 缺行为关键词登记`);
    for (const keyword of keywords) {
      assert.ok(sample.behavior.includes(keyword), `${sample.id} behavior 缺关键词「${keyword}」`);
    }
  }
});

test("每个拦截机制锚点在 V4 文档中可定位（锚点被删时本测试变红）", () => {
  assert.ok(Array.isArray(doc.samples));
  let anchorCount = 0;
  for (const sample of doc.samples) {
    assert.ok(
      Array.isArray(sample.interceptionAnchors) && sample.interceptionAnchors.length > 0,
      `${sample.id} 缺 interceptionAnchors`,
    );
    for (const anchor of sample.interceptionAnchors) {
      anchorCount += 1;
      assert.equal(typeof anchor.mechanismId, "string", `${sample.id} 锚点缺 mechanismId`);
      assert.equal(typeof anchor.doc, "string", `${sample.id}.${anchor.mechanismId} 缺 doc`);
      assert.equal(typeof anchor.anchor, "string", `${sample.id}.${anchor.mechanismId} 缺 anchor`);
      const docPath = join(ROOT, anchor.doc);
      assert.ok(existsSync(docPath), `${sample.id}.${anchor.mechanismId} 锚点文档不存在：${anchor.doc}`);
      const content = readFileSync(docPath, "utf8");
      assert.ok(
        content.includes(anchor.anchor),
        `${sample.id}.${anchor.mechanismId} 锚点串在 ${anchor.doc} 中不可定位（拦截机制可能已被删除）：${anchor.anchor}`,
      );
    }
  }
  assert.ok(anchorCount >= 14, `锚点总数 ${anchorCount} 少于每样例两处的下限`);
});
