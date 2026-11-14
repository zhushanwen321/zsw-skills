---
name: symbol-watchlist
version: 0.1.0
description: >-
  Use when 需要生成或自验设计包的符号词表（<basename>.symbol-watchlist.json）：tech-design-v2 T3
  产词表、dev-flow-v2 D5 发起 design-code-sync-loop 前自验。触发词：「符号词表」「watchlist」
  「词表自验」「词表重产」「提取反引号」。
  Not for 词表语义甄别与落盘流程（用 tech-design-v2 flow/plan.md「符号词表」节）、
  design-code-sync 发起与 FAIL 处置流程（用 dev-flow-v2 flow/sync.md）。
---

# symbol-watchlist（符号词表生成与自验工具）

两技能共享的词表契约载体：**工具与协议在本 skill，流程在消费方技能**。词表协议横跨
tech-design-v2（生成侧）与 dev-flow-v2（自验侧），本 skill 收拢单一脚本与协议要点，
消除「脚本挂在单一技能目录、另一技能跨技能引用」的不对称依赖。

## 工具

`scripts/extract-backticks.mjs`——符号词表生成器第一步（提取设计文档反引号词，纯机械零语义）
与落盘词表的自验器，单一脚本两用：

### 生成（tech-design-v2 T3 产草稿）

```bash
# 推荐：cd 到设计包目录后相对传参，调用串短
cd ~/.agents/skill-data/tech-design/<project-slug>
node ~/.agents/skills/symbol-watchlist/scripts/extract-backticks.mjs <name>/<name>.rendered.md <name>.impl-plan.md
```

**传参形态不限**（相对 / `~/` / 绝对均可）——脚本把任意形态入参归一为绝对路径，归一结果同时
用作读取路径与指纹键。stdout = JSON 草稿：`sourceFingerprints`（输入文件 sha256 指纹，键 =
归一绝对路径）/ `words`（提取词数组）/ `dropped`（被过滤词与剔除规则，漏报可审计）。
任一输入不可读即 exit 1（不做跳过降级）。

### 自验（dev-flow-v2 D5 发起门）

```bash
node ~/.agents/skills/symbol-watchlist/scripts/extract-backticks.mjs --check <watchlist 绝对路径>
```

stdout 输出 `PASS` 并 exit 0 = 可发起；任一失败输出 `FAIL: <分类>: <明细>` 并 exit 1，
按分类处置后重验。

## 词表协议要点

- **键 = 归一绝对路径**：`sourceFingerprints` 的键是脚本归一后的输入文件绝对路径（`~/` 前缀按
  HOME 展开，其余 `path.resolve`），下游 setup 引擎按键 `fs.readFileSync` 直读——相对或
  `~/` 形态的键 ENOENT。落盘时原样抄草稿输出的键，勿手写或改动。
- **指纹**：键值 = 输入文件当前内容 sha256。发起时引擎重算比对——源文档任何改动使指纹不等 =
  词表过期，拒启指路重产。
- **8 类拒启判定**（`--check` 校验集，与引擎 setup 探针同源）：词表不可读或非合法 JSON /
  词表内容非 JSON 对象（顶层 null 或标量）/ 缺 scan 数组或 skip 数组 / skip 元素畸形 /
  缺 sourceFingerprints / 指纹值形态畸形（须 64 位 sha256 hex）/ 指纹键不可读 / 指纹不等。
- **同源纪律 + 差分测试防漂移**：反引号提取规则与 design-code-sync-loop 扫描器
  （NODE_BACKTICK_GREP）逐字同源，`--check` 校验集与引擎 setup 词表探针同源——两侧必须
  同步修改；zsw-skills 仓 `scripts/tests/extract-backticks.test.mjs` 的差分测试
  （两侧对同一批 fixture 逐判定断言等价）拦截漂移。

## 与两技能的关系

- **T3 生成流程**（语义甄别 scan/skip 判定、落盘位置与格式）见 tech-design-v2
  `flow/plan.md`「符号词表」节——本 skill 只产机械草稿，哪些词纳入扫描由该节的语义分析裁决。
- **D5 发起门**（自验时机、FAIL 各分类的分流处置）见 dev-flow-v2 `flow/sync.md`
  「W4 workflow 契约」节。
- 本 skill 只承载工具与协议，不承载流程。两技能文档引用本脚本时写安装后路径
  `~/.agents/skills/symbol-watchlist/scripts/extract-backticks.mjs`。
