---
name: zsw-session-cleanup
description: "zsw 会话残留清理：zcode 引擎库残留会话（侧边栏噪音）、doctor clean、VACUUM 回收磁盘。触发词：zsw 清理、会话残留、zcode 清理、侧边栏残留、清理残留会话、doctor clean、残留清理、VACUUM、zsw-session-cleanup。覆盖：只读体检→dry-run 三道安全网→停机窗口官方清理 / 在线清理（不停机）→VACUUM→验收。不用于普通文件清理或 zsw 工作流编排。"
---

# zsw 会话残留清理

## 背景与操作对象

zsw 引擎共享宿主 HOME，会话写真实 `~/.zcode/cli/db/db.sqlite`（与 ZCode GUI 共库，WAL 模式）：
- **双库**：引擎库 `~/.zcode/cli/db/db.sqlite{,-wal,-shm}` + GUI 索引库 `~/.zcode/v2/tasks-index.sqlite{,-wal,-shm}`
- **三文件面**：`~/.zcode/cli/{artifacts,log,exec}`
- **备份位**：`~/.zcode/zsw/maintenance/backup-*/`

权威文档：插件 README「会话残留维护」节（命令语义与安全网机制）+ 本 skill `references/acceptance-manual.md`（停机窗口验收手册，已从 /tmp 持久化）。

**插件 checkout 路径会漂移**（worktree 重组织）。先探测：`ls /Users/zhushanwen/Code/zcode-plugin-workspace/`，优先 `main/z-subagent-workflow`（权威分支，git log 最新 release 提交者）。下称 `<zsw>`。要求 Node ≥22.5（推荐 24，node:sqlite）。

## 删除集识别口径（三类 + 文件面）

1. **白名单∩库**：records.jsonl（`~/.zcode/zsw/records.jsonl`）中键名恰为 `sessionId` 的值 ∩ session.id——zsw 自建会话
2. **特征目录类**：闭集表 `/tmp/zsw-sidebar-probe`、`/tmp/pz2-work` + 路径段 `zsub-e2e-*`——e2e/探针产物
3. **超龄 subagent_child**：task_type='subagent_child' 且 time_created 早于 7 天前
4. 文件面：artifacts 集内目录 / exec sess_ 前缀双通道 / log 超 14 天

**红线：interactive 真实用户会话永不删除**（zsw 设计零误删）。用户工作分支的 workflow 批量轻会话即使像残留，也不是本 skill 范围——需用户逐案授权定制规则。

## 标准流程

### 第 1 步：体检 + 预览（只读，随时可跑）

```bash
cd <zsw> && node bin/zsw.js doctor | tee /tmp/zsw-doctor-baseline-$(date +%Y%m%d).txt
node bin/zsw.js doctor clean --dry-run | tee /tmp/zsw-dryrun-$(date +%Y%m%d).txt
```

**三道安全网审查**（任一不过 → 停手）：
- 污染哨兵：删除集 ∩ targetSessionId 值域必须 = 0（非 0 = 识别污染或嵌套合法重叠，逐条核查）
- 索引冲突：命中会话自动整体剔除，确认剔除清单均为被分组/自动化引用即可
- 目录红灯：临时类占比 >30% 常为机械误报——核「特征表外临时目录命中」= 0 即可；再人工抽查删除集 directory 分布（可用 `lib/clean-identify.js` 的 `buildDeleteSet` 直接出 byClass 目录清单，零口径漂移）

### 第 2 步：判断执行路径

先摸清持库进程（不停库就跑不了官方 clean）：

```bash
lsof ~/.zcode/cli/db/db.sqlite ~/.zcode/v2/tasks-index.sqlite 2>/dev/null
ps -p <持库pid> -o pid=,ppid=,etime=,%cpu=,command=   # 归属判据用 ppid（zcode-cli 已改写 process.title）
```

**判读**（详见插件 README 排障节）：
- 父 = GUI host / pi rpc 会话且 %cpu>0 → **活跃引擎，不可杀**，等其结束
- 空闲（0% CPU、WAL 无写入）→ 向用户确认后 `kill -TERM`（一次给全链 pid；3s 后仍活再 KILL）
- 孤儿 zcode-cli（ppid=1）且无任务在跑 → 可直接 kill
- WAL 活性：`stat -f %Sm db.sqlite-wal`，近几分钟有 mtime 变化 = 有人正在写

**路径 A（首选）：停机窗口官方 clean**——GUI 全退 + 持库进程清零时：

```bash
cd <zsw> && node bin/zsw.js doctor clean | tee /tmp/zsw-clean-$(date +%Y%m%d-%H%M%S).txt
```

自动完成：四项停机校验 → 三段磁盘校验 → 双库三件套备份（keep-1）→ 分块删除+级联 → VACUUM → 索引联动 → 文件面。crashpad 残留进程（命令行含 /ZCode.app/）会触发 GUI 探测误拦，需一并清理。

**路径 B：在线清理（不停机）**——GUI 已退但有空闲持库进程且用户要求保留时：

```bash
node ~/.agents/skills/zsw-session-cleanup/scripts/online-clean.cjs          # 预演（全只读）
ZSW_ONLINE_CLEAN_CONFIRM=YES node ~/.agents/skills/zsw-session-cleanup/scripts/online-clean.cjs  # 执行
```

脚本特性：复用插件 `lib/clean-identify`/`lib/clean-fs`（零口径漂移）；执行前重算安全网 + 「活跃 subagent 会话 ∩ 删除集 = 0」专项防护；python3 sqlite3 在线 .backup 备份 + quick_check；1:1 复刻 clean-exec 删除序（FK=ON、200/事务、批间 PASSIVE checkpoint）；**跳过 VACUUM**（活跃持库者存在时拿不到独占锁）。若插件路径变了，改脚本头部 `PLUGIN` 常量。

**路径 C：只差 VACUUM**（行已删、空间未回收）——所有持库进程退出后：

```bash
sqlite3 ~/.zcode/cli/db/db.sqlite "PRAGMA busy_timeout=120000; VACUUM;"
sqlite3 ~/.zcode/cli/db/db.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"   # VACUUM 会把 WAL 撑到 ~库体积，必须收回
```

实测（2026-09-08）：WAL 模式下空闲连接不阻塞 VACUUM（32s 完成 6.8GB→2.9GB）；但**活跃写入者**会卡住或被卡——VACUUM 持写锁数分钟，活跃会话写入会等其 busy_timeout 后报错。动手前确认 WAL mtime 静默多时。TRUNCATE 后 WAL 归零。

### 第 3 步：验收

- `node bin/zsw.js doctor` 复核：三类识别面应归零（或仅剩新积攒）、quick_check ok
- 后验三件：删除集残留 = 0；8 个调用方会话（targetSessionId）完好；session 总数 = 前 − 删除数
- 重启 ZCode 按 `references/acceptance-manual.md` §2–§4 勾验收清单（侧边栏 / 调用方会话 / 零误伤抽查 / 引擎容错）
- 观察 1–2 天无异常后才可释放备份（官方路径 `--purge-backup`；手工备份直接 rm -rf 备份目录）

## 纪律

- **备份是回滚唯一安全网**，确认无异常前禁删；回滚必须整组六文件（半套覆盖产生 WAL 不一致），见验收手册 §5
- **禁止 cron/launchd 自动化清理**（删除无人值守 + 停机窗口无法保证）；周期维护档 = `doctor clean --stale --older-than 30d` 手动触发
- 留档/脚本/报告一律写 `/tmp/` 或项目 `.tmp/`，**不写 `~/`**（AGENTS.md 规则）
- dry-run 数据随时间漂移属正常：白名单/特征/索引三类只因新写入变化应精确持平，超龄 child 随 7 天线前移单调增长——校验按此口径，勿用总数 ±N 粗阈值

## 实战参照

2026-09-08 首次全量：删除集 6,202 会话（白名单 57 / 特征 180 / 超龄 child 5,965）+ 索引 45 + 文件面 8,027 目录；在线路径（4 个空闲持库进程保留 1 个活跃）+ 后补 VACUUM，库 7.0GB→2.9GB，全程零失败。验收手册 Gate B 副本演练：6.71GB 快照删 5,776 会话回收 3.64GB，86 项断言全过。
