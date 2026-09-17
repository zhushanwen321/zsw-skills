---
name: web-fetch
description: "Use when fetching URL content without API keys, extracting readable text from web pages, or getting YouTube subtitles. Triggers: fetch url、获取网页、抓取页面、下载内容、网页转 markdown、YouTube 字幕。Not for web search — use anysearch instead (it routes to Tavily). Not for stocks/CVE — use anysearch instead."
---

# Web Fetch

纯本地 URL 内容抓取。`curl` + `python3`（仅 stdlib），无需 API key，无需额外进程。

## Quick Reference

| 需求 | 命令 |
|------|------|
| 原始 HTML | `curl -sL "<url>" \| head -c 50000` |
| 转 Markdown | `curl -sL "<url>" \| pandoc -f html -t markdown --wrap=none` |
| 正文提取 | 见下方 fetch_readable |
| 纯文本 | 见下方 fetch_txt |
| JSON 格式化 | `curl -sL "<url>" \| python3 -m json.tool \| head -c 50000` |
| YouTube 字幕 | 见下方 YouTube |

带 header/代理：`curl -sL -H "Authorization: Bearer TOKEN" --proxy "http://host:8080" "<url>" | head -c 50000`

## fetch_readable（提取正文）

去除导航/广告/页脚，只留正文内容：

```bash
curl -sL "<url>" | python3 << 'PYEOF'
import sys, re
html = sys.stdin.read()
for tag in ['article', 'main']:
    m = re.search(rf'<{tag}[^>]*>(.*?)</{tag}>', html, re.S)
    if m:
        html = m.group(1)
        break
else:
    for t in ['nav','header','footer','aside','script','style','form','noscript']:
        html = re.sub(rf'<{t}[^>]*>.*?</{t}>', '', html, flags=re.S)
html = re.sub(r'<br\s*/?>|</p>', '\n', html, flags=re.S)
html = re.sub(r'<[^>]+>', '', html)
print(re.sub(r'\n\s*\n+', '\n\n', html).strip())
PYEOF
```

安装 `readability-lxml` 可提升质量：`pip3 install readability-lxml html2text`

## fetch_txt（纯文本）

```bash
curl -sL "<url>" | python3 << 'PYEOF'
import sys, re
h = sys.stdin.read()
for t in ['script','style','noscript']:
    h = re.sub(rf'<{t}[^>]*>.*?</{t}>', '', h, flags=re.S)
h = re.sub(r'<br\s*/?>|</p>', '\n', h, flags=re.S)
h = re.sub(r'<[^>]+>', '', h)
print(re.sub(r'\n\s*\n+', '\n\n', h).strip())
PYEOF
```

## YouTube 字幕

需 `yt-dlp`（`brew install yt-dlp`）：

```bash
# 自动生成字幕
yt-dlp --write-auto-sub --sub-lang en --skip-download -o "/tmp/yt_%(id)s" "<youtube_url>"
cat /tmp/yt_*.vtt | head -c 50000

# 指定语言字幕
yt-dlp --write-sub --sub-lang zh --skip-download -o "/tmp/yt_%(id)s" "<youtube_url>"

# 列出可用字幕
yt-dlp --list-subs "<youtube_url>"
```

## When NOT to Use

- 搜索信息（非已知 URL）→ `anysearch`（统一搜索入口，内部分流 Tavily/垂直检索）
- 股票/CVE/论文等垂直领域 → `anysearch`
- 需要高质量正文去杂的 URL 提取 → `anysearch` 的 Tavily `extract`（API 去杂更好）

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 忘记 `head -c` 限制输出 | 大页面会撑爆 context，必须限制 |
| 用 web-fetch 搜信息 | 这是 URL 抓取工具，不是搜索引擎 |
| 在 fetch_readable 后又做 HTML 清理 | fetch_readable 已经输出纯文本 |
