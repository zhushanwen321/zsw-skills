---
name: zsession-wait
description: >-
  等待 / 监控另一个 zcode 会话是否「完全停止」的工具：给定会话 id，轮询判定
  会话及其全部 subagent、workflow、后台 bash 是否都已收尾，满足后退出。
  用户说「等 xx 会话跑完」「盯着 xx 会话」「会话停了叫我 / 告诉我」「监控 xx 会话是否结束」
  「wait/monitor session」或点名本 skill 时使用。
  不用于读会话内容（那是 pi-session-reader）；不用于监控 pi 会话（只认 zcode 的 db）；
  判「停止」不判「成功」——成败要看报告里的 last_outcome。
---

# zsession-wait：等待 zcode 会话完全停止

外部旁观 CLI：zcode 的活状态（在跑的轮次、后台任务注册表）只在 app-server 进程内存里，db 不记运行中标志，也无外部 RPC 通道，所以本工具组合 db 只读查询 + 进程表扫描 + 静默稳定期做推断。判定条件（全部满足、连续 N 轮，默认 3）：

1. 会话及其全部子会话（subagent / workflow actor）db 静默超 `--quiet-period`（默认 180s）
2. 会话树无在途工具调用（`tool_usage.status='running'`）
3. 会话树无在途 workflow run（`dwf_run` 非终态）且无存活沙箱进程
4. 宿主 app-server 进程树无 shell 后代（后台 bash 的唯一外部可见证据）

宿主进程消失时，db 里的 running 行按崩溃残留处理（zcode 崩溃不写终态），只有沙箱孤儿 / 孤儿 shell（`--strict-orphan`）仍阻塞判定。

## Quick Reference

```bash
node ~/.agents/skills/zsession-wait/bin/zsession-wait.mjs <sessionId> [options]
```

| 选项 | 默认 | 说明 |
|------|------|------|
| `--interval <sec>` | 15 | 轮询间隔 |
| `--quiet-period <sec>` | 180 | db 静默阈值，防模型长思考空窗误判 |
| `--rounds <n>` | 3 | 连续全绿轮数 |
| `--timeout <sec>` | 7200 | 总超时（0 = 不限） |
| `--json` | - | 最终 JSON 报告进 stdout（进度行始终在 stderr） |
| `--ignore-shells` | - | 跳过宿主 shell 后代信号 |
| `--strict-orphan` | - | 孤儿 shell（PPID=1）升级为阻塞信号，默认只提示 |
| `--db <path>` | `~/.zcode/cli/db/db.sqlite` | db 路径 |

退出码：`0` 已停止 / `1` 超时 / `2` 会话不存在或 db 不可读 / `3` 参数错误 / `4` 采集连续失败。

## Agent 使用决策

**sessionId 来源**：用户直接给（如 `session_aa132ed6...`，markdown 链接 `[#标题](#session_xxx)` 里 `#` 后那段）；用户只描述会话不给 id 时，按 workspace 目录 + 时间查 db：

```bash
sqlite3 -readonly ~/.zcode/cli/db/db.sqlite \
  "select id, title, datetime(time_updated/1000,'unixepoch','localtime') \
   from session where directory='<workspace 目录>' and task_type='interactive' \
   order by time_updated desc limit 3;"
```

**推荐后台挂法**（agent 侧不要前台阻塞等十几分钟）：

```
用 Bash 工具 run_in_background 跑 zsession-wait（不加 --json，stdout 末行是人读结论）。
后台任务完成时通知自动回流本会话，届时读输出：exit 0 → 已停止，按 last_outcome 裁决成败；
exit 1 → 超时，把最后状态的 red 信号报给用户裁决（继续等 / 放弃 / 换参数）。
```

**参数调整**：

- 监控对象用的是长推理模型（几分钟不回话属正常）→ `--quiet-period` 调大到 300~600
- 用户给了明确期限（「最多等到 6 点」）→ `--timeout` 按期限减当前时间设置
- 只想快照看一眼状态而不等待 → `--rounds 1 --interval 1 --timeout 30`，用 `--json` 拿 `finalSignals`

**`--ignore-shells` 抉择**（shell 信号是 workspace 级、无法归属单个会话）：

- 默认保留：目标会话挂的后台 bash 在跑就该判「未停」——后台 bash 运行期间 db 完全静默，没有这个信号会误判完成
- 加上开关：已知目标会话挂的是常驻型脚本（永不结束的监控脚本，会话任务本身已完成），或同一 workspace 有其他会话在并发跑——此时 shell 信号会永远红，用户明确表示「不管后台脚本 / 不管别的会话」才加

**成败裁决**：退出码 0 只表示「停了」。成败看输出里的 `last_outcome`（completed / error / interrupted）与 `last_message_finish`；自动化脚本用 `--json` 读 `session.lastOutcome`。报告「等待完成」时必须带上这两个字段，不许把「停止」说成「成功」。

## 语义边界（引用本工具结论时须知道）

- **cron / 闲时任务防不住**：目标会话若登记了 cron 自动化或闲时任务（OffPeakCreate），会话可能在静默任意久之后复活——本工具判定的是「当前无在途工作」，不承诺「永不再跑」。监控对象挂了这两类登记时，须向用户说明此边界。
- **同 workspace 兄弟会话**：沙箱信号按「db 活跃 run id 交集」判定，不受兄弟会话 workflow 影响；但 shell 信号会（见上）。兄弟会话的沙箱进程会出现在 stderr 的 `note:` 提示里，不阻塞判定。
- **「完全停止」的精度**：秒级采样窗口由连续 N 轮跨过；模型思考空窗由 quiet-period 跨过；两者都是概率性防御，不是数学保证。

## 排障

- 报 `cannot open db`：确认 `~/.zcode/cli/db/db.sqlite` 存在（zcode 版本演进可能挪路径，用 `--db` 指定）
- 需要 Node >= 22.5（`node:sqlite`）；`ps` / `lsof` 缺失时进程信号失效
- stderr 每轮进度行格式：`[HH:MM:SS] #轮次 green n/N | host=PID tools=.. runs=.. sandbox=.. queue=.. shells=.. idle=..`，`RED (原因码)` 表示未停原因
- 源码与判定依据注释在 skill 目录 `bin/`、`lib/` 内；CLI 单一权威源即本 skill 目录
