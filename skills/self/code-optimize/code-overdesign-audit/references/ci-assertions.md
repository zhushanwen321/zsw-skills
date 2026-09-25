# pre-commit 断言（ci-assertions）

> 防新增投机复杂度的快速断言集。设计 SSOT：`<skill_dir>/docs/plans/2026-09-10-code-overdesign-audit-skill.md` §3.3.7。目标：单次提交断言耗时 <10s、零外部依赖（git/grep/date 内置）、不改 package.json/lock。

## 断言集与拦截口径

| # | 断言 | 原因码 | 拦截口径 |
|---|------|--------|----------|
| 1 | 新增无调用方导出 | `no-reference` | 暂存新增的**具名非别名导出**（`export default` / `export { x as y }` 不进拦截面），`git grep -w` 全仓引用计数（限 tracked，排除注释行/re-export 行/定义文件本身）= 0 即拦 |
| 2 | 新增单实现接口 | `single-impl` | 暂存新增 interface，全仓 implements/extends 计数 = 1 即拦 |
| 3 | 新增纯转发方法 | `pass-through` | 暂存新增方法体为单行同名校验（`m(a){ return x.m(a); }`）即拦 |

**已知漏拦四类（接受代价，audit 细网兜底）**：①撞名符号（含 `.open()` 成员访问）②import 占位 ③动态引用/字符串拼接 ④default/别名导出。监控分类以此清单为准。

**豁免标记**：`// oe-exempt:<yyyymmdd>:<类目>:<理由>`，类目 `wip`（30 天）/ `test`（90 天）/ `framework`（无期限）。**日期过期 = 视为无豁免重新拦截**（`expired-exempt`），恢复动作：复核移除标记，或确属长期豁免改类目补理由。断言对基线 `.tmp/code-overdesign-audit/`（项目根下）**只读**（复核队列由 audit 步骤 0 重建，pre-commit 不写盘）。

**监控口径**：「月误拦 >5 次触发口径重审」仅统计 `no-reference` 类；`expired-exempt` 是设计预期行为单列计数。

## 断言脚本模板（oe-assert.sh，TS/JS 首版）

```bash
#!/usr/bin/env bash
# oe-assert.sh — code-overdesign-audit pre-commit assertions (template v1, TS/JS)
# 卸载：删除 hook 中带 `# oe-audit-assert` marker 的调用行 + 删除本文件。
# 可移植性：仅用 POSIX/BSD/GNU/ugrep 四实现的公共 ERE 子集——禁 \b \s（BSD 不支持）、
# 禁转义加号 \+（ugrep 解析为量词），行首 + 用括号类 [+]、字面花括号用 [{]，空白用 [[:space:]]。
set -u

# --- skip 纪律：工具级故障打印 skipped，不阻塞提交（失败要出声）
command -v git  >/dev/null 2>&1 || { echo "[oe-audit] skipped: git unavailable";  exit 0; }
command -v grep >/dev/null 2>&1 || { echo "[oe-audit] skipped: grep unavailable"; exit 0; }

SRC_FILES=$(git diff --cached --name-only --diff-filter=A -- '*.ts' '*.tsx' '*.js' '*.mjs')
[ -z "$SRC_FILES" ] && exit 0

VIOLATIONS=""
TODAY=$(date +%Y%m%d)

# 豁免解析：$1=标记行整行。输出 ok | expired | none
check_exempt() {
  local tag; tag=$(printf '%s' "$1" | grep -oE 'oe-exempt:[0-9]{8}:(wip|test|framework)' | head -1)
  [ -z "$tag" ] && { echo none; return; }
  local d=${tag#oe-exempt:}; d=${d%%:*}
  local cat=${tag##*:}
  local days
  # 兼容 BSD/GNU date：解析失败按 0 天处理（U7 场景 4 实测适配点）
  days=$(( ( $(date +%s) - $(date -j -f "%Y%m%d" "$d" +%s 2>/dev/null || date -d "${d:0:4}-${d:4:2}-${d:6:2}" +%s 2>/dev/null || echo 0) ) / 86400 ))
  { [ "$cat" = "wip"  ] && [ "$days" -gt 30 ]; } && { echo expired; return; }
  { [ "$cat" = "test" ] && [ "$days" -gt 90 ]; } && { echo expired; return; }
  echo ok   # framework 无期限
}

# 引用计数：$1=符号 $2=定义文件。git grep 限 tracked；排除注释行/re-export 行/定义文件
count_refs() {
  git grep -I -w -F "$1" -- ':!*.md' ':!*.mdx' 2>/dev/null \
    | grep -v "^$2:" \
    | grep -vE '^[[:space:]]*(//|/\*|\*|#)' \
    | grep -vE 'export[^(]*from' \
    | wc -l | tr -d ' '
}

# ---------- 断言 1：新增具名非别名导出零引用（按新增文件迭代，定义文件即该文件本身） ----------
for f in $SRC_FILES; do
  ADDED=$(git diff --cached --diff-filter=A -U0 -- "$f" | grep -E '^[+]' | grep -vE '^[+][+][+]')
  # 具名声明导出：export const|let|var|function|class|async function <name>
  SYMS=$(printf '%s\n' "$ADDED" \
    | grep -oE 'export (async function|function|const|let|var|class) [A-Za-z_$][A-Za-z0-9_$]*' \
    | awk '{print $NF}' | sort -u)
  # 具名花括号导出，跳过别名（export { x as y } 拦截面外）
  SYMS="$SYMS
$(printf '%s\n' "$ADDED" | grep -oE 'export [{][^}]*[}]' \
    | sed -E 's/export[[:space:]]*[{]//; s/[}]//' | tr ',' '\n' \
    | grep -v ' as ' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/:.*//' \
    | grep -E '^[A-Za-z_$][A-Za-z0-9_$]*$' | sort -u)"
  SYMS=$(printf '%s\n' "$SYMS" | sed '/^$/d' | sort -u)
  [ -z "$SYMS" ] && continue

  for sym in $SYMS; do
    exempt_line=$(printf '%s\n' "$ADDED" | grep -E "export .*$sym" | grep -E 'oe-exempt:[0-9]{8}:' | head -1)
    if [ -n "$exempt_line" ]; then
      st=$(check_exempt "$exempt_line")
      [ "$st" = "ok" ] && continue
      if [ "$st" = "expired" ]; then
        VIOLATIONS="$VIOLATIONS
$f | $sym | expired-exempt | 豁免已过期（wip>30d/test>90d）——复核移除标记，或改类目补理由"
        continue
      fi
    fi
    refs=$(count_refs "$sym" "$f")
    if [ "$refs" -eq 0 ]; then
      VIOLATIONS="$VIOLATIONS
$f | $sym | no-reference | 全仓零引用——删除该导出，或分步提交加豁免 // oe-exempt:$TODAY:wip:<理由>"
    fi
  done
done

# ---------- 断言 2：新增单实现接口（-w 整词，不用 \b） ----------
ALL_ADDED=$(git diff --cached --diff-filter=A -U0 -- '*.ts' '*.tsx' '*.js' '*.mjs' | grep -E '^[+]' | grep -vE '^[+][+][+]')
IFACES=$(printf '%s\n' "$ALL_ADDED" | grep -oE 'interface [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $2}' | sort -u)
for ifc in $IFACES; do
  impls=$(git grep -I -w -E "(implements|extends) $ifc" 2>/dev/null | wc -l | tr -d ' ')
  [ "$impls" -le 1 ] && VIOLATIONS="$VIOLATIONS
? | $ifc | single-impl | 接口仅 1 实现——内联或等待第 2 个真实变体（Rule of Three）"
done

# ---------- 断言 3：新增纯转发方法 ----------
PT=$(printf '%s\n' "$ALL_ADDED" \
  | grep -nE '[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)[^{]*[{] *return [A-Za-z_$][A-Za-z0-9_.$]*\.[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\); *[}]' \
  | head -5)
[ -n "$PT" ] && VIOLATIONS="$VIOLATIONS
(暂存新增行) | pass-through | pass-through | 纯转发方法——直接暴露目标或下沉语义（Remove Middle Man）"

# ---------- 汇总输出 ----------
if [ -n "$VIOLATIONS" ]; then
  echo "[oe-audit] intercepted:" >&2
  printf '%s\n' "$VIOLATIONS" | sed '/^$/d' | while IFS='|' read -r loc sym reason fix; do
    [ -z "$loc$sym$reason" ] && continue
    echo "  $loc | $sym | [$reason] $fix" >&2
  done
  echo "  依据与口径：code-overdesign-audit skill references/ci-assertions.md（四类已知漏拦由 audit 细网兜底）" >&2
  exit 1
fi
exit 0
```

> 待验证检查点（U7 场景 4 实测适配）：date 解析的 BSD/GNU 兼容写法；monorepo 下 workspace 依赖/跨包 re-export 间接链的计数口径（注意与已进口径的 barrel 单行排除区分）。

## 安装（写入面穷举，每面有安装/卸载路径）

**步骤 0：`git config core.hooksPath` 三分支检测**

- **(a) 未设置**（hooks 在 `.git/hooks/`）→ 下述 append 模式。
- **(b) 重定向型框架**（husky `.husky/_`、lefthook、python pre-commit——husky v9 安装即 `git config core.hooksPath .husky/_`，`.git/hooks/` 内一切不被执行，真实链 `.husky/_/pre-commit` shim → `sh -e .husky/pre-commit`）→ **显式二选一，禁止静默装到死目录**：
  - 向框架用户 hook 文件（如 `.husky/pre-commit`）append 带 marker 行 + 部署脚本到 `.git/hooks/oe-assert.sh`，并显式登记「写入面进工作区、一行 diff 随版本库」代价，征得用户同意（挂起模式同构：给代价说明 + 默认推荐后结束回合等选择）。**默认推荐：登记代价并安装**（一行可见债务优于断言缺失）；仓库明确禁工作区写入时推荐放弃。
  - 或打印 skipped + 手动接入指引后放弃（指引：把下方调用行手动加进框架 hook）。
- **(c) 目标 hook 文件不存在** → 创建仅含本调用的最小 hook。

**append 调用行**（两分支通用，marker 供卸载识别）：

```bash
bash "$(git rev-parse --git-dir)/hooks/oe-assert.sh" # oe-audit-assert
```

**写入面清单**：

| 面 | 安装 | 卸载 |
|----|------|------|
| `.git/hooks/oe-assert.sh`（脚本本体） | 写入模板 | 删文件 |
| hook 调用行（`.git/hooks/pre-commit` 或框架 hook 文件） | append 带 `# oe-audit-assert` marker 的一行；hook 已有内容时追加末尾，不碰他人步骤 | 按 marker 识别删行 |
| 配置/依赖 | 无（阈值内嵌默认值；零 package.json/lock 变更） | — |
| clone 仓库 | 分支 (a) 全在 `.git/` 内不污染工作区；分支 (b) 一行 marker 注释进工作区（已征同意的显式 diff） | — |

**marker 互斥约束**：oe-exempt 汇总用 `grep -r "oe-exempt:"`（冒号锚定），与 `# oe-audit-assert` 前缀互斥——调用行不会被 audit 步骤 0 误认作豁免；两端标记格式演进时必须维持互斥。

## 验收对照（SSOT §4 场景 4）

a 具名导出零引用被拦｜b 正常修改十连放行（含一次 default 修改）｜c 豁免标记放行且可被 grep 汇总｜d WIP 两步提交 + audit 汇总无残留｜e 单次耗时 <10s×10 次｜f 故障 skipped 可见｜g husky 仓库走分支 (b) 且真实提交断言输出实际出现。
