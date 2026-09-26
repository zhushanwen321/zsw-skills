#!/usr/bin/env python3
"""word-scan — 扫描文档命中 meta-words-guidance 词表的位置，给出替换建议。

用法:
    word-scan.py <文件或目录>...     默认只扫「已裁决替换表」（确定要改的）
    word-scan.py --watch ...         追加「观察名单」（待裁决词，仅提示）
    word-scan.py --conditional ...   追加「带条件保留表」（能用但需解释，仅提示）
    word-scan.py --all ...           三张表全扫
    word-scan.py --wordlist <path>   指定词表文件（默认全局 AGENTS.md：
                                     ~/.zcode/AGENTS.md，回退 ~/.pi/agent/AGENTS.md）

白名单是放行词，不参与扫描；启动时校验白名单与其他三表无同词冲突，有冲突即报错退出。

目录扫描递归并追符号链接；跳过 .git/node_modules 等目录、点开头目录、
超过 5MB 的文件与无法按 UTF-8 解码的文件（跳过计数在末尾报告）。
扫描目标是词表 SSOT 文件本身时，跳过各表区（含白名单）内的表格行（枚举必然命中），其余行文照扫。

输出: 每行一条命中「路径:行号: [表] 「命中词」→ 建议 ｜ 原文片段」，末尾汇总计数。
退出码: 0 = 无命中，1 = 有命中，2 = 参数或读取错误、或白名单与其他表同词冲突。

匹配规则: 词表单元格按 / 、拆分变体；尾部括号注（如「盘面（作业）」）不参与匹配，
括号内含 / 时视为变体列表（如「gate 族（Gate/门禁/…）」）；「…」视为通配（≤30 字）；
纯 ASCII 词要求两侧不是字母数字下划线（避免命中标识符，如 oracledb 不误报 oracle）；
大小写敏感。同一位置多个变体重叠时只报最长匹配。
"""
import argparse
import os
import re
import sys
from pathlib import Path

def default_wordlist():
    candidates = [Path.home() / ".zcode" / "AGENTS.md", Path.home() / ".pi" / "agent" / "AGENTS.md"]
    for p in candidates:
        if p.is_file():
            return p
    return candidates[0]


DEFAULT_WORDLIST = default_wordlist()
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
MAX_BYTES = 5 * 1024 * 1024

TABLE_HEADERS = {
    "已裁决替换表": "替换",
    "带条件保留表": "条件",
    "观察名单": "观察",
}
SECTION_OF_LABEL = {label: section for section, label in TABLE_HEADERS.items()}
WHITELIST_TABLE = "白名单"
ALL_TABLE_NAMES = (*TABLE_HEADERS, WHITELIST_TABLE)


def split_variants(cell):
    """把词表单元格拆成可匹配词面：去括号注、按 / 与 、拆分；括号内含 / 时并入变体。"""
    parens = re.findall(r"[（(]([^（）()]*)[）)]", cell)
    base = re.sub(r"[（(][^（）()]*[）)]", "", cell)
    parts = [base] + [p for p in parens if "/" in p]
    variants = []
    for part in parts:
        for v in re.split(r"\s*/\s*|、", part):
            v = v.strip()
            if v:
                variants.append(v)
    return variants


def to_regex(term):
    pat = re.escape(term).replace("…", r".{0,30}?")
    if re.fullmatch(r"[A-Za-z0-9_]+", term):
        pat = rf"(?<![A-Za-z0-9_]){pat}(?![A-Za-z0-9_])"
    return re.compile(pat)


def load_terms(path, tables):
    """解析词表，返回 [(regex, 词面, 表标签, 建议)]，按词面长度降序利于最长匹配优先。"""
    terms = []
    seen = set()
    section = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^#{2,5}\s*(.+?)\s*$", raw)
        if m:
            heading = m.group(1)
            # 章节标题可能带括号注（如「观察名单（待裁决，…）」），按前缀匹配表名
            section = next((t for t in TABLE_HEADERS if heading.startswith(t)), None)
            continue
        if section not in tables or not raw.startswith("|"):
            continue
        cells = [c.strip() for c in raw.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[0] in ("原词", "词") or set(cells[0]) <= {"-", ":"}:
            continue
        word_cell, action = cells[0], cells[1]
        if section == "带条件保留表":
            action = f"带条件保留：{action}"
        elif section == "观察名单":
            action = f"观察名单（待裁决）：{action}"
        elif len(cells) >= 3 and cells[2]:
            action = f"{action}（{cells[2]}）"
        for v in split_variants(word_cell):
            if v in seen:
                continue
            seen.add(v)
            try:
                terms.append((to_regex(v), v, TABLE_HEADERS[section], action))
            except re.error:
                print(f"警告：词「{v}」无法编译为正则，已跳过", file=sys.stderr)
    terms.sort(key=lambda t: -len(t[1]))
    return terms


def load_whitelist(path):
    """解析白名单表，返回词面集合；「候选：」前缀行去前缀后计入。"""
    words = set()
    section = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^#{2,5}\s*(.+?)\s*$", raw)
        if m:
            section = m.group(1).startswith(WHITELIST_TABLE)
            continue
        if not section or not raw.startswith("|"):
            continue
        cells = [c.strip() for c in raw.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[0] == "词" or set(cells[0]) <= {"-", ":"}:
            continue
        word_cell = cells[0]
        if word_cell.startswith("候选："):
            word_cell = word_cell[len("候选："):]
        words.update(split_variants(word_cell))
    return words


def iter_files(paths):
    for p in paths:
        path = Path(p)
        if not path.exists():
            print(f"警告：路径不存在 {p}", file=sys.stderr)
            continue
        if path.is_dir():
            for root, dirs, files in os.walk(path, followlinks=True):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
                for f in sorted(files):
                    yield Path(root) / f
        else:
            yield path


def scan_file(path, terms, is_wordlist):
    try:
        if path.stat().st_size > MAX_BYTES:
            return [], "too-large"
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return [], "undecodable"
    hits = []
    in_table_section = False
    for lineno, line in enumerate(text.splitlines(), 1):
        if is_wordlist:
            # 词表 SSOT 自身：三张表区内的表格行是枚举必然命中，跳过；其余行文照扫
            h = re.match(r"^#{2,5}\s*(.+?)\s*$", line)
            if h:
                in_table_section = any(h.group(1).startswith(t) for t in ALL_TABLE_NAMES)
            if in_table_section and line.startswith("|"):
                continue
        found = []
        for rx, surface, table, action in terms:
            for m in rx.finditer(line):
                found.append((m.start(), m.end(), surface, table, action))
        kept = []
        for f in sorted(found, key=lambda x: (x[0], -(x[1] - x[0]))):
            if not any(f[0] < k[1] and f[1] > k[0] for k in kept):
                kept.append(f)
        for start, end, surface, table, action in sorted(kept):
            snippet = line.strip()
            if len(snippet) > 120:
                snippet = snippet[:117] + "..."
            hits.append(f"{path}:{lineno}: [{table}] 「{surface}」→ {action} ｜ {snippet}")
    return hits, None


def main():
    ap = argparse.ArgumentParser(description="扫描文档命中用语词表的位置（详见文件头注释）")
    ap.add_argument("paths", nargs="+", help="文件或目录，可多个")
    ap.add_argument("--watch", action="store_true", help="追加观察名单")
    ap.add_argument("--conditional", action="store_true", help="追加带条件保留表")
    ap.add_argument("--all", action="store_true", help="三张表全扫")
    ap.add_argument("--wordlist", type=Path, default=DEFAULT_WORDLIST, help="词表文件路径")
    args = ap.parse_args()

    tables = {"已裁决替换表"}
    if args.watch or args.all:
        tables.add("观察名单")
    if args.conditional or args.all:
        tables.add("带条件保留表")
    if not args.wordlist.is_file():
        print(f"错误：词表不存在 {args.wordlist}——用 --wordlist 指定有效路径", file=sys.stderr)
        return 2

    full_terms = load_terms(args.wordlist, set(TABLE_HEADERS))
    terms = [t for t in full_terms if SECTION_OF_LABEL[t[2]] in tables]

    whitelist = load_whitelist(args.wordlist)
    conflicts = sorted({v for _, v, _, _ in full_terms} & whitelist)
    if conflicts:
        for w in conflicts:
            print(f"错误：词「{w}」同时登记在白名单与其他表中，放行与限制矛盾——先修词表再扫描", file=sys.stderr)
        return 2
    all_hits, skipped = [], 0
    wordlist_resolved = args.wordlist.resolve()
    for f in iter_files(args.paths):
        hits, skip_reason = scan_file(f, terms, f.resolve() == wordlist_resolved)
        if skip_reason:
            skipped += 1
        all_hits.extend(hits)

    for h in all_hits:
        print(h)
    summary = f"{len(all_hits)} 处命中（{len(terms)} 个词面，表：{'、'.join(sorted(TABLE_HEADERS[t] for t in tables))}）"
    if skipped:
        summary += f"；跳过 {skipped} 个无法解码或超 5MB 的文件"
    print(summary)
    return 1 if all_hits else 0


if __name__ == "__main__":
    sys.exit(main())
