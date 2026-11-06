#!/usr/bin/env python3
"""slop-scan — 扫描套式句式（I 型，「AI slop」）候选，供人工逐条判断。

word-scan.py 只能扫「词」，扫不到句式。本脚本补这一层：用句式模板找出
**候选行**，再由人读原文判断该句是修辞套式还是有效表达。

⚠️ 本脚本的输出是**候选清单，不是违规报告**。技术文档里「不是 A，而是 B」
多数是真实区分（如「不是门面，是 JNI wire-format 的 ordinal 镜像」）。
**禁止按命中直接改**——必须逐条读原文，按 review-checklist.md 的 I 型判据裁决。

用法:
    slop-scan.py <文件或目录>...            扫全部 I 型子式
    slop-scan.py --only I-1 ...             只扫指定子式（I-1..I-5）
    slop-scan.py --context 2 ...            每条命中附带前后 N 行上下文（便于判断）
    slop-scan.py --stat ...                 只输出按子式分组的计数，不列明细

输出: 每条命中「路径:行号: [子式] 「命中片段」｜ 原文」，末尾按子式汇总。
退出码: 0 = 无候选，1 = 有候选（待人工判断），2 = 参数或读取错误。

判据出处：references/review-checklist.md「I 型」+ references/patterns.md「模式九」。
"""
import argparse
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist",
             "build", ".next", ".bare", ".tmp"}
MAX_BYTES = 5 * 1024 * 1024
TEXT_EXT = {".md", ".txt", ".rst", ".adoc"}

# ---------------------------------------------------------------------------
# I 型句式模板。每条 = (子式标签, 正则, 该子式的附加说明)
# 设计原则：宁可多抓（候选），不可漏抓；精确判断交给人和上下文。
# ---------------------------------------------------------------------------

# 抽象名词表：用于 I-1 的「两侧都是抽象描述」辅助判断。
# 两侧都命中此表时可信度更高（但不作为唯一判据——句式本身已足以标候选）。
ABSTRACT_NOUNS = (
    "性能 效率 体验 质量 价值 成本 收益 效果 结果 本质 关键 核心 重点 "
    "能力 水平 程度 状态 方式 方法 思路 逻辑 意义 力度 速度 力度 深度 广度 "
    "问题 缺陷 风险 隐患 优势 劣势 差异 变化 提升 下降 增长 减少 "
    "跑得 做得 干得 变得 来得"
).split()

# 具体名词线索：出现这些词时更可能是有效对比（技术文档常见）
CONCRETE_HINTS = (
    "门面 包名 模块 接口 字段 类 函数 方法 变量 参数 文件 目录 路径 行号 行 "
    "帧 指令 周期 像素 带宽 缓存 显存 线程 进程 锁 队列 缓冲区 "
    "API JDK SDK NDK JNI CPU GPU GL ES NEON SIMD ARM Mali Adreno "
    "编译 构建 链接 加载 序列化 解析 渲染 光栅化 采样 上传 下载 "
    "字节 毫秒 毫秒 秒 帧 条 个 次 处 行"
).split()

PATTERNS = [
    ("I-1", "对偶否定",
     r"不是[^。；\n]{2,25}[，,]\s*(?:而|倒|反)?是[^。；\n]{2,25}"),

    ("I-2", "悬念引出",
     r"(?:比[^。；\n，,]{2,14}(?:更|还|更更)[^。；\n，,]{1,8}(?:的)?(?:是|，))"
     r"|(?:最[^。；\n，,]{2,10}(?:的)?不是[^。；\n，,]{2,14}[，,]\s*是)"
     r"|(?:真正(?:的)?(?:问题|关键|难点|价值|意义)(?:是|在于|不在))"),

    # I-3 只抓「没有实指对象的空洞收尾」。原先把裸「这正是 X」全部捕获，
    # 但技术文档里「这正是 load_slot3 的成因」有具体主语+关系，是有效陈述。
    # 收紧为两类：① 抽象名词收尾（的样子/本质/关键/核心/意义）② 后跟抽象评价词。
    ("I-3", "空洞强调",
     r"(?:这|那|它)(?:才|正|恰恰|就)是[^。；\n]{2,30}"
     r"(?:的样子|的本质|的关键|的核心|的意义|所在)"
     r"|(?:这|那)(?:才|正|恰恰)是"
     r"(?:真正的|真正的|最(?:重要|关键|核心|本质))"),

    # 主语表扩到「会被当成施动者的抽象名词」：优化/改动/收益被"吃掉"是同一族问题
    # ——不是程序有意图，而是一个无生命的过程被写成了能主动吞掉东西的主体。
    ("I-4", "意图投射",
     r"(?:代码|程序|算法|函数|编译器|调度器|GC|JIT|内核|驱动|系统|框架|它|"
     r"优化|改动|收益|提升|性能|瓶颈|流程|逻辑|机制|设计)"
     r"(?:想|知道|认为|决定|选择|觉得|喜欢|讨厌|愿意|试图|打算|考虑|希望|"
     r"吃掉|吞掉|吃掉你|自己跑|自己测)"),

    # 两类都是结构旁白：① 解释性元话语（说白了/换句话说）② 预告性元话语
    # （我先给结论/先看数字/现在讲/这一节写给）。后者是 AI 生成长文的高频开场。
    ("I-5", "元话语",
     r"^\s*(?:说白了|换句话说|也就是说|简单说|简言之|其实说白了)\s*[，,：:]"
     r"|(?:说白了|换句话说|也就是说|简单说|简言之)\s*[，,：:]"
     r"|(?:我?先(?:给|说|讲|看|摆)(?:结论|结果|数字|答案|事实))"
     r"|(?:^|[。；\n])\s*(?:现在讲|现在说|这一?节(?:写给|讲|说)|"
     r"前面讲的|下面(?:开始|进入|我|我们))"),
]

# I-5 的「给出换算」豁免线索：元话语后面跟这些内容时，通常是有效换算而非复述
META_VALID_HINTS = re.compile(r"\d|等于|相当于|换算|即|倍|%|吨|小时|分钟")


def to_regex(pat):
    return re.compile(pat)


def is_abstract_duet(snippet):
    """I-1 辅助判断：两侧是否都是抽象描述。

    返回 (abstract_hits, concrete_hits)：前者多、后者少 ⇒ 更像 slop 候选。
    仅用于输出时的「可信度」标注，不影响是否命中。
    """
    a = sum(1 for w in ABSTRACT_NOUNS if w in snippet)
    c = sum(1 for w in CONCRETE_HINTS if w in snippet)
    return a, c


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
                    if Path(f).suffix.lower() in TEXT_EXT:
                        yield Path(root) / f
        else:
            yield path


def scan(paths, patterns, context_lines=0, stat_only=False):
    compiled = [(tag, name, to_regex(p)) for tag, name, p in patterns]
    hits = []
    skipped = 0
    for f in iter_files(paths):
        try:
            if f.stat().st_size > MAX_BYTES:
                skipped += 1
                continue
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            skipped += 1
            continue
        lines = text.splitlines()
        for lineno, line in enumerate(lines, 1):
            for tag, name, rx in compiled:
                for m in rx.finditer(line):
                    snip = m.group(0).strip()
                    if not snip:
                        continue
                    note = ""
                    if tag == "I-1":
                        a, c = is_abstract_duet(snip)
                        if a > c:
                            note = f"  [两侧抽象词 {a} / 具体词 {c}：更像套式]"
                        elif c >= a and c > 0:
                            note = f"  [含具体词 {c}：可能是有效对比]"
                    elif tag == "I-5":
                        tail = line[m.end():m.end() + 40]
                        if META_VALID_HINTS.search(tail):
                            note = "  [后接数字/换算：可能是有效衔接]"
                    hits.append({
                        "path": str(f), "lineno": lineno, "tag": tag,
                        "name": name, "snip": snip, "note": note,
                        "line": line.strip(),
                        "ctx": (max(1, lineno - context_lines), lineno + context_lines),
                        "all_lines": lines,
                    })
    return hits, skipped


def main():
    ap = argparse.ArgumentParser(
        description="扫描套式句式（I 型）候选——输出供人工判断，不是违规报告")
    ap.add_argument("paths", nargs="+", help="文件或目录，可多个")
    ap.add_argument("--only", action="append", default=None,
                    metavar="I-1",
                    help="只扫指定子式，可重复（I-1..I-5）")
    ap.add_argument("--context", type=int, default=0, metavar="N",
                    help="每条命中附带前后 N 行上下文")
    ap.add_argument("--stat", action="store_true", help="只输出按子式分组的计数")
    args = ap.parse_args()

    missing = [p for p in args.paths if not Path(p).exists()]
    if missing and len(missing) == len(args.paths):
        print(f"错误：输入路径均不存在：{'、'.join(missing)}", file=sys.stderr)
        return 2

    patterns = PATTERNS
    if args.only:
        wanted = {x.upper() for x in args.only}
        patterns = [p for p in PATTERNS if p[0] in wanted]
        if not patterns:
            print(f"错误：--only 未匹配任何子式（可选 I-1..I-5）", file=sys.stderr)
            return 2

    hits, skipped = scan(args.paths, patterns, args.context, args.stat)

    if args.stat:
        by = {}
        for h in hits:
            by.setdefault((h["tag"], h["name"]), []).append(h)
        for (tag, name), items in sorted(by.items()):
            files = len({i["path"] for i in items})
            print(f"{tag} {name}: {len(items)} 处 / {files} 文件")
        print(f"合计 {len(hits)} 处候选")
        return 1 if hits else 0

    for h in hits:
        print(f"{h['path']}:{h['lineno']}: [{h['tag']} {h['name']}] "
              f"「{h['snip']}」{h['note']}")
        print(f"    ｜ {h['line'][:150]}")
        if args.context:
            lo, hi = h["ctx"]
            al = h["all_lines"]
            for i in range(lo, min(hi + 1, len(al) + 1)):
                if i == h["lineno"]:
                    continue
                print(f"    {i:>5}| {al[i-1][:150]}")

    summary = f"{len(hits)} 处候选（{len(patterns)} 个句式模板）"
    if skipped:
        summary += f"；跳过 {skipped} 个无法解码或超 5MB 的文件"
    print(summary)
    print("⚠️ 候选清单，不是违规报告——逐条读原文判断，禁止按命中直接改。")
    print("   判据：references/review-checklist.md 的 I 型（含五个子式）。")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
