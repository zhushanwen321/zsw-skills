---
name: anysearch
description: "Unified search skill covering both general web search and vertical domains. Use when searching the web, looking up facts, reading news, extracting URL content, crawling websites, OR searching structured vertical sources general search cannot cover: stock quotes, forex rates, CVE vulnerabilities, academic papers, patents. Also use for batch parallel searches (2-5 queries at once). Triggers: 搜索、查一下、搜一下、lookup、search、research、fact-check、联网搜索、股票、行情、汇率、CVE、漏洞、论文、DOI、学术、专利、批量搜索、A股。Route internally: general web/news/URL extract/crawl → Tavily; finance/CVE/papers/batch → anysearch CLI. Not for keyless local fetching — use web-fetch instead."
---

# AnySearch

统一搜索入口，内部分两条路径：

- **通用搜索（Tavily）**：web 搜索、新闻、URL 内容提取、网站爬取。执行体是机器上已装的 `tavily` wrapper，本 skill 只提供用法规范。
- **垂直搜索（anysearch CLI）**：Tavily 无法覆盖的结构化垂直场景 + 批量并行搜索。自包含脚本，无需安装。

## 路由规则

| 场景 | 用哪条 |
|------|--------|
| 通用 web 搜索、新闻、事实核查 | Tavily `search` |
| URL 内容提取（去广告导航） | Tavily `extract` |
| 网站递归爬取 / 站点结构 | Tavily `crawl` / `map` |
| 股票行情、汇率、A 股 | anysearch CLI（zone=cn） |
| CVE、文件哈希、IP/域名扫描 | anysearch CLI |
| 论文、DOI、生物医学、专利 | anysearch CLI |
| 2-5 个独立查询并行 | anysearch CLI 批量 |
| 无 API key 的纯本地抓取 | `web-fetch` skill（不在本 skill 内） |

---

# 路径一：Tavily 通用搜索

## Quick Reference

```bash
tavily search "query" [--depth basic|advanced] [--topic general|news] [--max-results N] [--time-range day|week|month|year]
tavily extract <url1> [url2...] [--depth basic|advanced]
tavily crawl <url> [--max-depth N] [--limit N]
tavily map <url> [--max-depth N]
tavily status  # key pool health
```

## search 选项

| Option | Default | Description |
|--------|---------|-------------|
| `--depth basic\|advanced` | `basic` | `advanced` 更全面，耗 2 credits |
| `--topic general\|news` | `general` | `news` 仅新闻源 |
| `--max-results N` | `10` | 1-20 |
| `--time-range day\|week\|month\|year` | — | 按时间过滤 |
| `--include-domains a,b` | — | 仅这些域名 |
| `--exclude-domains a,b` | — | 排除域名 |

**depth 选择：** `basic` 用于快速事实、定义、API 文档；`advanced` 用于深度研究、竞品分析。

**Credit 管理：** basic 1 credit、advanced 2；每免费 key 1000 credits/月。省法：用 basic、`max-results` 保持 3-5、避免 `--include-raw`/`--include-images`。

## 环境与排障

**key 来源**：`~/.shell/*tavily*.sh`（如 `04-tavily.sh`）中的 `export TAVILY_API_KEYS="k1,k2,k3"`。

**调用链**：`~/.local/bin/tavily`（wrapper）→ `~/.local/share/tavily/tavily.py`。wrapper 在 `TAVILY_API_KEYS` 缺失时按 glob `~/.shell/*tavily*.sh` 查找并注入，非交互式 shell（agent 工具子进程、cron、CI）无需手动 source。

| 现象 | 处理 |
|------|------|
| `错误: TAVILY_API_KEYS 未设置` | 创建 `~/.shell/04-tavily.sh`，内容 `export TAVILY_API_KEYS="k1,k2"` |
| 某 key 额度耗尽 | `tavily status` 查池状态，轮询自动切换 |

---

# 路径二：anysearch 垂直搜索

## 入口

首次加载时运行 `doc` 命令获取完整接口规范（本地操作，无网络请求）：

```bash
python3 <skill_dir>/scripts/anysearch_cli.py doc
```

## 支持领域

| 领域 | 示例 |
|------|------|
| 金融 | 股票代码/行情、汇率、A 股（zone=cn） |
| 学术 | 论文搜索、DOI、生物医学文献 |
| 安全 | CVE、文件哈希、IP/域名扫描 |
| 其他 | 法律、专利、教育、健康 |
| 批量 | 2-5 个独立查询同时执行 |

## 调用

```bash
python3 <skill_dir>/scripts/anysearch_cli.py <command> [options]
```

四个 runtime 覆盖同一套命令与参数，功能等价，按机器可用环境选用：

| Runtime | 命令 |
|---------|------|
| Python | `python3 <skill_dir>/scripts/anysearch_cli.py <command> [options]` |
| Bash | `bash <skill_dir>/scripts/anysearch_cli.sh <command> [options]` |
| Node.js | `node <skill_dir>/scripts/anysearch_cli.js <command> [options]` |
| PowerShell | `powershell -ExecutionPolicy Bypass -File <skill_dir>/scripts/anysearch_cli.ps1 <command> [options]` |

### 查看参数（--help）

- 子命令级 `<command> --help`（查看某个子命令的参数）：**Python 与 Bash 版支持**，返回 0；Node.js / PowerShell 版没有子命令级帮助，传入会被当成未知 flag（返回 1）。
- 顶层 `--help` / `-h` / 无子命令：四个 runtime 均支持，打印总用法后返回 0。

## API Key

匿名可用（低限额）。可选配置 `<skill_dir>/.env`：`ANYSEARCH_API_KEY=<key>`。

优先级：`--api_key` flag > `.env` > 环境变量 > 匿名。Key 耗尽时 API 可能返回新 key → 需用户确认后写入 `.env`。

`--api_key` flag 的合法位置因 runtime 而异：

| Runtime | 合法位置 |
|---------|----------|
| Python | 子命令前后均可 |
| Bash / Node.js / PowerShell | 必须放子命令之后 |

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（`doc`、`--help` 等本地操作也返回 0） |
| 1 | API / 网络错误；Bash 版的用法错误（未知命令 / 未知 flag / 缺必填参数）返回 1 |
| 2 | 参数误用。Python 版所有参数问题均返回 2；Bash 版 `--max_results` 非数字返回 2，`--sub_domain_params` 非法 JSON 在有 python3 时返回 2 |

Node.js / PowerShell 版把用法错误与参数错误都归为 1，未按 2 细分。

---

# Common Mistakes

| 错误 | 正确 |
|------|------|
| 用 anysearch CLI 搜 "Python 3.13 release" | 通用搜索，走 Tavily |
| 用 Tavily 搜股票行情/CVE/论文 | 结构化垂直数据，走 anysearch CLI |
| `python scripts/tavily.py` 或 `python ...` | `tavily`（已装在 PATH）；非交互式用 `python3` |
| 手动 `source ~/.shell/*tavily*.sh` 后才能跑 | 不需要，wrapper 自动读取 key 并注入 |
| 跳过 `doc` 命令直接调 anysearch CLI | doc 提供完整参数规范，必须先运行 |
| 在 chat 中粘贴 API key | 用 `.env` 文件或环境变量 |
