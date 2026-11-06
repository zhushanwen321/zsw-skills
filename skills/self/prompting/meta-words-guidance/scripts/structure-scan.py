#!/usr/bin/env python3
"""structure-scan — 扫描版面层（K 型）与语序层（J 型）的 AI 腔候选，供人工逐条判断。

三个脚本的分工：
    word-scan.py       词层（A–H 型）：单个词命中词表
    slop-scan.py       句内修辞层（I 型）：一句之内的修辞框架
    本脚本              K 型（篇章层）+ J 型（句法层）：
                       问题不在词也不在单句修辞，而在标题形态、全篇密度、
                       以及「整句语序是英文直译」这三种跨句现象。

⚠️ 本脚本输出是**候选清单，不是违规报告**。
   「一个反直觉的测量事实」被标为名词短语标题，但它可能是有效的技术概括；
   「帧」出现在「采样窗口」里是术语不是比喻。必须逐条读原文判断。

K 型（篇章层）检出的形态：
    标题冒号复读      冒号右侧是评价而非补充信息
    名词短语标题      整句无谓语，定语+名词，读者要先解码
    标题用比喻        标题里出现比喻词
    加粗密度          每千中文字加粗过多（视觉噪音，失去强调作用）
    破折号密度        中文破折号本已少见，过密是英文节奏直搬
    比喻复用/叠加     同一比喻域反复出现，说明是套模板不是真想出来的
    章节同构          多数章节首句都是结构旁白（先看/现在讲/这一节…）

J 型（句法层）检出的形态：
    一X的Y            定语是状态/情感词时更像英文名词语序直译
    一面墙的Y         a wall of 的直译量词搭配
    有了X才Y          with X you can Y 直译
    N步看清X          N steps to see X 直译模板
    X之外的另一个Y    beyond X, another Y
    硬/软+名词        hard evidence 一类直译
    一个N的X证伪式    数字+学术动词名词化作标题

用法:
    structure-scan.py <文件或目录>...        扫全部 K 型 + J 型
    structure-scan.py --only 标题 ...        只扫 kind 含该关键词的条目
    structure-scan.py --only-title ...       只扫标题层（跳过密度与语序）
    structure-scan.py --json ...             机器可读输出
    structure-scan.py --stat ...             只输出统计与按 kind 分组计数

退出码: 0 = 无候选，1 = 有候选（待人工判断），2 = 参数或读取错误。

判据出处：SKILL.md 问题类型表的 J/K 型 + references/patterns.md 模式十/十一。
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist",
             "build", ".next", ".bare", ".tmp"}
MAX_BYTES = 5 * 1024 * 1024
TEXT_EXT = {".md", ".txt", ".rst", ".adoc"}

# ---------------------------------------------------------------------------
# 词表
# ---------------------------------------------------------------------------

# 比喻域：封闭词表，可枚举 ⇒ 高可脚本化
METAPHOR_FAMILIES = {
    "测量": "尺子 标尺 刻度 天平 量杯 温度计 卡尺",
    "空间/方向": "方向 道路 路口 大门 钥匙 窗口 门槛 台阶 山顶",
    "战争": "战场 战役 攻坚 武器 弹药 火力 阵地 攻防",
    "建筑": "地基 脚手架 承重 桥梁 砖瓦 梁柱 骨架",
    "商业/账目": "账本 对账 成本 债务 账目 清账 簿记",
    "身体": "骨架 血脉 脉搏 病灶 免疫 体检 心脏",
    "自然/生物": "土壤 根系 生长 生态 养分 种子 枝叶",
    "旅行": "旅程 旅途 路线 风景 终点 驿站",
    "舞台/表演": "舞台 剧本 角色 台词 谢幕 聚光灯",
}

# 术语化用法白名单：这些词在本仓技术语境里是术语，不是比喻
METAPHOR_TECHNO_WHITELIST = {
    "窗口": ("采样窗口 时间窗口 窗口数 一帧窗口 日志窗口 统计窗口 滑动窗口 "
             "窗口内 每窗口 窗口平均 窗口值 窗口间隔"),
    "门槛": ("阈值门槛 过门槛 门槛值 门槛为 门槛线 5% 门槛 3% 门槛 不达门槛 未过门槛"),
    "成本": ("时间成本 CPU 成本 渲染成本 单帧成本 计算成本 采样成本 改造成本"),
    "角色": ("角色走动 角色头发 角色移动 主角"),
    "方向": ("方向键 四个方向 上方向 下方向"),
}

# 评价词：出现在标题冒号右侧 = 复读而非补充信息
EVAL_WORDS = (
    "最重要 最关键 最有价值 最有意思 最需要 真正的 不体面 诚实 残酷 "
    "真相 本质 代价 教训 启示 反思 复盘 觉醒 秘密 神奇 厉害"
).split()

# 元话语开场词表（出现在章节首句 = 结构旁白）
META_OPENERS = (
    "先看 现在讲 这一节 前面讲的 下面 接下来 先说 再说 顺带 另外 "
    "总的来说 综上 值得注意的是 需要指出 这里要"
).split()

# 英文名词语序直译模板
CALQUE_PATTERNS = [
    ("一X的Y", r"(?:^|[，。；：\s])(?:一|几)[个条段场部步块张][^。，\n：]{0,10}的[^。，\n：]{1,8}"),
    ("一面墙的Y", r"[一二三四五六七八九十百千万整]+(?:面|堵|整面)[^。，\n：]{0,6}(?:墙|壁)的"),
    ("有了X才Y", r"有了[^。，\n]{1,14}[，,]?\s*才[^。，\n]{1,14}"),
    ("N步看清X", r"[一二三四五六七八九十0-9]+\s*步\s*(?:看清|看懂|看懂|拆解|理解)"),
    ("X之外的另一个Y", r"[^。，\n]{1,12}之外的(?:另|第二|新)[^。，\n]{1,10}"),
    ("硬/软+名词", r"(?:硬|软)(?:证据|实力|门槛|约束|伤|着陆)"),
    ("更硬的是", r"比[^。，\n]{1,12}更(?:硬|狠|重|关键)(?:的)?是"),
    ("一个N的X证伪式", r"一[个次轮]?[0-9.]+\s*(?:ms|秒|毫秒|倍|%|帧)的\S{2,6}"),
]

# 「一X的Y」定语性质分类：决定是直译语序还是正常中文
FACTUAL_MOD = ("行 帧 字节 条 次 处 个 秒 毫秒 倍 % 位 层 组 类 项 步 帧率 "
               "指令 周期 像素 尺寸 分辨率 线程 队列 缓冲 模块 接口 字段")

# 状态/情感定语：这类定语 + 的 + 名词 = 英文名词语序直译的特征
EMOTIVE_MOD = ("没打完 未完成 不体面 诚实 残酷 反直觉 尴尬 惨 漂亮 有趣 "
               "最重要 真正 完美 优雅 干净 真实 意外 神奇 无声 沉默 孤独")

# 中文动词线索：用于判断标题是否为「无动词名词短语」
VERB_HINTS = (
    "给 做 改 跑 测 查 看 写 读 拿 放 找 试 用 换 修 建 合 拆 升 降 加 减 "
    "说 讲 谈 问 答 让 使 要 会 能 可 需 应 成 变 出现 达到 超过 低于 "
    "移植 优化 合并 对比 验证 复现 排除 推翻 确认 发现 追出 省下"
).split()

# 名词尾缀：标题以此结尾且无动词 ⇒ 名词短语标题候选
NOUN_SUFFIXES = ("游戏 记录 故事 世界 真相 本质 代价 答案 密码 边界 门槛 底色 答卷 逻辑 意义 价值 历程")


def strip_heading_noise(h):
    """去掉编号前缀、markdown 标记。"""
    s = re.sub(r"^#+\s*", "", h)
    s = re.sub(r"^[0-9]+(?:\.[0-9]+)*\s*[.、]?\s*", "", s)
    s = re.sub(r"^[A-Z]\.\s*", "", s)
    return s.strip()


def check_heading(raw, lineno, metaphor_hits):
    """标题层检测。返回候选列表。"""
    out = []
    text = strip_heading_noise(raw)
    if not text:
        return out

    # ① 冒号复读：右侧是评价/自评，不是补充信息
    m = re.match(r"^([^：:]{2,30})[：:]\s*(.{2,40})$", text)
    if m:
        right = m.group(2)
        ev = [w for w in EVAL_WORDS if w in right]
        # 右侧无数字/无具体类的技术名词 ⇒ 更像复读
        has_number = bool(re.search(r"\d", right))
        if ev or (not has_number and len(right) <= 20 and
                  any(k in right for k in ("教训", "比", "才是", "真实", "另一"))):
            out.append({
                "kind": "标题冒号复读", "lineno": lineno, "heading": text,
                "detail": f"冒号右侧「{right}」是评价而非补充信息",
                "hits": ev or ["<右侧无具体信息>"],
            })

    # ② 名词短语标题：无动词 + 名词尾缀 / 一X的Y
    has_verb = any(v in text for v in VERB_HINTS)
    if not has_verb and len(text) >= 6:
        if text.endswith(NOUN_SUFFIXES) or re.search(r"的[^的]{1,6}$", text):
            out.append({
                "kind": "名词短语标题", "lineno": lineno, "heading": text,
                "detail": "整句无谓语，是定语+名词短语，读者要先解码再理解",
                "hits": ["无动词"],
            })

    # ③ 比喻词出现在标题
    for fam, words in metaphor_hits.items():
        in_title = [w for w in words if w in text]
        if in_title:
            out.append({
                "kind": "标题用比喻", "lineno": lineno, "heading": text,
                "detail": f"{fam}族比喻「{'、'.join(in_title)}」",
                "hits": in_title,
            })
    return out


def scan(path):
    text = Path(path).read_text(encoding="utf-8")
    lines = text.splitlines()
    n_cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    out = []

    # ---------- 文档层：密度 ----------
    bold = text.count("**") // 2
    emdash = text.count("——")
    # 每千中文字
    if n_cjk > 0:
        bdens = bold / n_cjk * 1000
        edens = emdash / n_cjk * 1000
        if bdens > 8:
            out.append({"kind": "加粗密度", "lineno": 0,
                        "detail": f"{bold} 处 / {n_cjk} 中文字 = 每千字 {bdens:.1f} 处（建议 <8）",
                        "hits": [f"{bold}"], "heading": ""})
        if edens > 1.5:
            out.append({"kind": "破折号密度", "lineno": 0,
                        "detail": f"{emdash} 处 / {n_cjk} 中文字 = 每千字 {edens:.1f} 处（建议 <1.5）",
                        "hits": [f"{emdash}"], "heading": ""})

    # ---------- 比喻复用 ----------
    metaph = defaultdict(list)
    for fam, words in METAPHOR_FAMILIES.items():
        for w in words.split():
            wl = METAPHOR_TECHNO_WHITELIST.get(w, ())
            for i, l in enumerate(lines, 1):
                if w not in l:
                    continue
                # 统计非术语化出现次数
                cnt = l.count(w)
                for ph in wl:
                    cnt -= l.count(ph)
                    if cnt <= 0:
                        break
                for _ in range(max(0, cnt)):
                    metaph[fam].append((w, i))
    reused = {f: sorted({w for w, _ in v}) for f, v in metaph.items() if v}
    for fam, hits in metaph.items():
        if not hits:
            continue
        words = sorted({w for w, _ in hits})
        if len(words) >= 2 or len(hits) >= 3:
            out.append({"kind": "比喻复用/叠加", "lineno": hits[0][1],
                        "detail": f"{fam}族比喻出现 {len(hits)} 次（{len(words)} 个不同词：{'、'.join(words)}）",
                        "hits": [f"{w}:{i}" for w, i in hits], "heading": ""})

    # ---------- 标题层 ----------
    headings = []
    for i, l in enumerate(lines, 1):
        if re.match(r"^#{1,4}\s", l):
            headings.append((i, l))
            out.extend(check_heading(l, i, reused))

    # ---------- 文档层：章节同构（首句都是元话语） ----------
    meta_open = 0
    for idx, (lineno, _) in enumerate(headings):
        # 找该标题后第一个非空、非表格、非子标题行
        j = lineno
        while j < len(lines):
            s = lines[j].strip()
            if s and not s.startswith("#") and not s.startswith("|") and not s.startswith("!["):
                break
            j += 1
        if j < len(lines):
            first = lines[j]
            if any(first.startswith(w) or (w in first[:12]) for w in META_OPENERS):
                meta_open += 1
    if len(headings) >= 4 and meta_open >= 3:
        out.append({"kind": "章节同构（元话语开场）", "lineno": 0,
                    "detail": f"{meta_open}/{len(headings)} 个章节首句是结构旁白（先看/现在讲/这一节…）",
                    "hits": [f"{meta_open}/{len(headings)}"], "heading": ""})

    # ---------- 语序层：英文直译模板 ----------
    for name, pat in CALQUE_PATTERNS:
        rx = re.compile(pat)
        for i, l in enumerate(lines, 1):
            for m in rx.finditer(l):
                snip = m.group(0).strip()
                if len(snip) < 4:
                    continue
                conf = ""
                # 「一X的Y」：按定语性质判可信度
                if name == "一X的Y":
                    if any(e in snip for e in EMOTIVE_MOD):
                        conf = "  [定语是状态/情感词：更像直译语序]"
                    elif any(f in snip for f in FACTUAL_MOD) or re.search(r"\d", snip):
                        conf = "  [定语是事实性修饰：正常中文，可忽略]"
                        continue
                    else:
                        conf = "  [定语性质不明：需人工判]"
                # 「一个N的X证伪式」限定在标题
                if name == "一个N的X证伪式" and not re.match(r"^#{1,4}\s", l):
                    continue
                out.append({"kind": f"直译语序：{name}", "lineno": i,
                            "detail": f"「{snip}」{conf}",
                            "hits": [name], "heading": l.strip()[:90]})
    return out, {"cjk": n_cjk, "bold": bold, "emdash": emdash,
                 "headings": len(headings), "meta_open": meta_open}


def iter_files(paths):
    """目录递归，追符号链接（与同族脚本一致；漏追会得出 0 残留的假阴性）。"""
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


def main():
    ap = argparse.ArgumentParser(
        description="扫描版面层（K 型）与语序层（J 型）AI 腔候选")
    ap.add_argument("paths", nargs="+", help="文件或目录，可多个")
    ap.add_argument("--only", action="append", default=None, metavar="关键词",
                    help="只输出 kind 含该关键词的条目，可重复")
    ap.add_argument("--only-title", action="store_true",
                    help="只扫标题层（跳过密度、语序与章节同构）")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    ap.add_argument("--stat", action="store_true", help="只输出统计与分组计数")
    args = ap.parse_args()

    missing = [p for p in args.paths if not Path(p).exists()]
    if missing and len(missing) == len(args.paths):
        print(f"错误：输入路径均不存在：{'、'.join(missing)}", file=sys.stderr)
        return 2

    all_hits, stats, skipped = [], {}, 0
    for f in iter_files(args.paths):
        try:
            if f.stat().st_size > MAX_BYTES:
                skipped += 1
                continue
        except OSError:
            skipped += 1
            continue
        hits, st = scan(str(f))
        for h in hits:
            h["path"] = str(f)
        all_hits.extend(hits)
        stats[str(f)] = st

    if args.only_title:
        all_hits = [h for h in all_hits if h["kind"] in
                    ("标题冒号复读", "名词短语标题", "标题用比喻")]
    if args.only:
        want = set(args.only)
        all_hits = [h for h in all_hits if any(w in h["kind"] for w in want)]

    if args.json:
        print(json.dumps({"stats": stats, "hits": all_hits},
                         ensure_ascii=False, indent=2))
        return 1 if all_hits else 0

    for p, st in stats.items():
        print(f"\n=== {p}")
        print(f"    中文字 {st['cjk']} · 加粗 {st['bold']} · 破折号 {st['emdash']}"
              f" · 标题 {st['headings']} · 元话语开场 {st['meta_open']}")

    by = defaultdict(list)
    for h in all_hits:
        by[h["kind"]].append(h)
    for kind in sorted(by, key=lambda k: -len(by[k])):
        items = by[kind]
        print(f"\n[{kind}] {len(items)} 处")
        for h in items[:12]:
            loc = f"{h['path']}:{h['lineno']}" if h["lineno"] else h["path"]
            print(f"  {loc}  {h['detail']}")
            if h["heading"] and not h["heading"].startswith("|"):
                print(f"      ｜ {h['heading'][:100]}")
        if len(items) > 12:
            print(f"  … 另 {len(items)-12} 处")

    total = len(all_hits)
    print(f"\n合计 {total} 处候选")
    if skipped:
        print(f"（跳过 {skipped} 个超 5MB 或不可读的文件）")
    print("⚠️ 候选清单，不是违规报告——逐条读原文判断，禁止按命中直接改。")
    print("   判据：SKILL.md 问题类型表的 J/K 型 + patterns.md 模式十/十一。")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
