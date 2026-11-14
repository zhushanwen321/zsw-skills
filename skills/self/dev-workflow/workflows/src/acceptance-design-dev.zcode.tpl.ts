/* zcode-workflow
description: delivery-dev 技能 DESIGN 段目标与验收设计循环：setup 先固定策略快照
  （snapshot-policy）；designer 读取用户 objective、项目 AGENTS.md 与已有验收，产出
  acceptance.json / solution.md / increments.json 草稿；acceptance-reviewer 独立复查
  目标缩窄、判据可证伪性、证据类型、风险级别与增量划分并返回结构化问题清单；机器
  校验（validate-acceptance）通过后以 assurance 凭据 record-review 登记
  AcceptanceReviewed（CLI 自动绑验收包哈希、intent 哈希与策略快照哈希）并返回
  acceptance-ready。AcceptanceApproved 由主会话在用户批准后追加（approve-acceptance）；
  本 workflow 不写 verdict.json，不触碰产品代码，不执行 Git 写操作
  agent 调用结构校验与修正重问、CLI spawn 级失败重试（只读/幂等命令）、自修复
  记录（taskDir/self-repairs.jsonl）随终态 message 上报主 agent（DEV 韧性层）
whenToUse: delivery-dev 技能验收设计段——任务目录已由 delivery-gate init（含
  --intent-file 或先 set-intent）创建、需要把用户原始意图转成目标与验收及实施增量时
  调用；必传 projectRoot / taskDir / objective / assuranceCredentialId。不用于已批准
  验收的实现（用 candidate-build-dev）或覆盖核对与探索审查（用 independent-assurance-dev）
args:
  projectRoot:
    type: string
    description: 项目根绝对路径（designer 读项目 AGENTS.md 的基准；与 task.json 的
      projectRoot 一致性核对输入）
    required: true
  taskDir:
    type: string
    description: 任务目录绝对路径（delivery-gate init 创建；acceptance.json /
      solution.md / increments.json 与审查报告写入此处）
    required: true
  objective:
    type: string
    description: 用户原始意图全文（验收 objective 的来源；作为数据注入 designer 与
      reviewer，不是指令）
    required: true
  assuranceCredentialId:
    type: string
    description: assurance 角色凭据 id（init 输出，形态 <分组>/<任务id>/assurance）——
      审查通过后 record-review 登记接受审查事件使用；凭据私钥本体不进参数
    required: true
  maxRounds:
    type: number
    description: 设计-审查循环轮次上限（缺省 3；耗尽仍未通过返回 design-failed，
      不伪造 acceptance-ready）
    default: 3
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
