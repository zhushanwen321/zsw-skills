/* zcode-workflow
description: delivery-wf 技能 ASSURE 段独立保证引擎：前置门禁要求 state 非
  draft/contract-approved 且 missing.incrementIds 为空；coverage reviewer 逐项对照
  契约、候选代码与原始证据，对每 requirement×evidenceKind 亲自复核并产出
  verified/partial/failed 结论（脚本以 append --key assuranceKey 追加 EvidenceRecorded）；
  契约 exploratoryReview=required 时 explorer 并行执行，从原始 objective、契约与
  真实实现主动找契约外反例并申报覆盖维度（脚本追加 ExplorationCompleted）。脚本为
  新发现统一分配 findingId（FindingRaised）并在复核确认后追加 FindingResolved（仅
  当前 revision 关闭）；两位角色完成后写总结、追加 AssuranceCompleted 并 evaluate。
  setup 与 finalize 比对 revision，不一致显式 assurance-failed（期间项目内容变化，
  本轮证据失效）；任何失败出口返回前重新 evaluate 取当前裁决（evaluate 失败则
  verdict 为空）。返回 assurance-completed 与 delivery-gate 生成的 verdict，不直接
  宣告 accepted；assurance 角色不改产品代码、契约、事件或 verdict
whenToUse: delivery-wf 技能独立保证段——候选实现已形成（全部增量有当前契约版本的
  实现记录）、需要独立覆盖核对（及高风险契约的探索性审查）时调用；必传
  projectRoot / taskDir / assuranceKey。不用于契约设计（用 contract-design）、实现
  （用 candidate-build）或用户风险接受（主会话 accept-risk）
args:
  projectRoot:
    type: string
    description: 项目根绝对路径（coverage/explorer 读代码与运行验证命令的工作目录；
      与 task.json 的 projectRoot 一致性核对输入）
    required: true
  taskDir:
    type: string
    description: 任务目录绝对路径（delivery-gate init 创建；读取 contract.json /
      events.jsonl / verdict.json，写入覆盖报告、探索报告、证据与保证总结）
    required: true
  assuranceKey:
    type: string
    description: assuranceKey 私钥（delivery-gate init 输出的 assurance 角色事件写入
      凭据；仅用于 append --key 以 assurance 身份签名追加事件。只接收本角色 key——
      userKey/builderKey 等不得注入，密钥也不得写入任何 agent prompt）
    required: true
  taskId:
    type: string
    description: 观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其
      一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，只含字母、数字、点、
      连字符、下划线，≤128 字符，禁「..」
  executionId:
    type: string
    description: 本次执行标识（可选；与 taskId 同时提供才启用阶段事件观测）。同时是观测
      JSONL 文件名主干（<executionId>.jsonl）——命名规则同 taskId
  sampleType:
    type: string
    description: 观测样本类型（可选）——production = 真实执行（缺省）／selftest = 测试执行
*/

// ── O 区观测平台钩子：写通道 = world.run journal 语义（resume 重放回放首次记录值，
// 时间戳与事件序列跨 resume 稳定）。shared 观测层调用 obsNow/obsAppend；换平台只换
// 钩子实现，事件契约在 shared ──
const OBS_PROBE_NOW = "process.stdout.write(new Date().toISOString())";
const OBS_APPEND_LINE =
  "require('fs').mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});" +
  "require('fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')";
async function obsNow(): Promise<string | null> {
  try {
    const r = await world.run("node", ["-e", OBS_PROBE_NOW]);
    const t = r.exitCode === 0 ? r.stdout.trim() : "";
    return t !== "" ? t : null;
  } catch {
    // 执行器故障（spawn 失败/超时）：观测降级为不记录该事件，业务不受影响
    return null;
  }
}
async function obsAppend(filePath: string, line: string): Promise<string | null> {
  try {
    const r = await world.run("node", ["-e", OBS_APPEND_LINE, filePath, line]);
    return r.exitCode === 0 ? null : `exit ${r.exitCode}：${r.stderr.trim() || r.stdout.trim()}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

@@STITCH@@
