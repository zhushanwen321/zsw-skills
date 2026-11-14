/* zcode-workflow
description: delivery-dev 技能 ASSURE 段独立覆盖核对与探索性审查：coverage-reviewer 逐
  requirement × evidenceKind 独立取证（证据事件绑 artifactSha256），explorer 按维度构造
  验收外反例（exploratoryReview=required 时）；证据/发现/解决事件逐条以 assurance 凭据
  追加。收尾由引擎在当前 revision 重跑全部增量测试命令并登记带完整绑定的
  AssuranceCompleted（本轮证据事件 id 集 + 冻结覆盖清单哈希 + 探索事件 id +
  逐增量测试回执）；finalize 比对 revision，漂移登记 AssuranceRevisionDrift（连续漂移
  链超上限由裁决器判 revision-unstable）。本 workflow 只产证据与发现，不改产品代码、
  验收、风险接受或 verdict，不宣告 accepted
whenToUse: delivery-dev 技能独立保证段——验收已批准、增量已齐（evaluate 的
  missing.incrementIds 为空）时调用；必传 projectRoot / taskDir /
  assuranceCredentialId。不用于验收设计（用 acceptance-design-dev）或候选实现
  （用 candidate-build-dev）
args:
  projectRoot:
    type: string
    description: 项目根绝对路径（assurance 角色运行验证命令的工作目录；与 task.json 的
      projectRoot 一致性核对输入）
    required: true
  taskDir:
    type: string
    description: 任务目录绝对路径（delivery-gate init 创建；读取 acceptance.json /
      increments.json / events.jsonl / verdict.json，证据与报告写入 evidence/）
    required: true
  assuranceCredentialId:
    type: string
    description: assurance 角色凭据 id（init 输出，形态 <分组>/<任务id>/assurance）——
      append --credential 以 assurance 身份签名追加证据/发现/保证事件。只接收本角色凭据
      id——user/builder 凭据不得注入；凭据私钥本体不进参数与 prompt
    required: true
  runId:
    type: string
    description: 写事务租约运行标识（可选；传入时 setup 执行 lease-acquire、finalize
      执行 lease-release，append 带 --run-id 做代次复核——projectRoot 级写入互斥）
  taskId:
    type: string
    description: 观测任务标识（可选；与 executionId 同时提供才启用阶段事件观测，只传其
      一会告警并关闭观测）。同时是观测落盘目录名——字母/数字开头，仅含字母、数字、点、
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
