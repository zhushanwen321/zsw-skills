# 定量诊断工具箱

> 配合 SKILL.md 场景 C / D 使用。判据（什么算垃圾测试）见 junk-patterns.md；本文件是扫描与测量的工具：弱断言密度、变异测试体检、慢测试帕累托。

## 弱断言密度扫描

```
grep -rc "toBeDefined\|toBeTruthy\|toBeFalsy" <测试目录>/ | sort -t: -k2 -rn
```

`toBeDefined` 数量是套件腐败的头号指标。某文件出现 20+ 个，几乎可以确定是"写了测试但没测任何东西"——覆盖率好看，但 mutation 100% 存活，删掉被测逻辑照样绿。

**治理**：逐个问"改成错的实现它会红吗？"不会红的按判据处理（改强断言或删除，见 junk-patterns.md）。

层错位与慢的判别（集成测试测纯逻辑、每用例重建 setup）见 test-layering.md「用错层的代价」。

## 变异测试（mutation testing）：凑数的客观裁判

覆盖率能骗（一个 `toBeDefined` 让行覆盖达 100%），变异骗不了。

**原理**：工具自动把生产代码做微小变异——`+`→`-`、`>=`→`>`、`<`→`<=`、删一行、改布尔常量。每个变异跑一遍测试套件：

- 变异后测试红了 = **mutant 被杀死**（测试有效）
- 变异后测试仍绿 = **mutant 存活**（测试对这个分支是凑数的）

**mutation score = 杀死 / 总变异**。低于 60% 的文件就是凑数重灾区。

**何时跑**：一次性诊断，不改代码。报告会精确指出"哪些测试存活了 mutant"——比凭感觉清理准得多。日常不跑（慢），作为体检或战役档（test-audit-workflow.md）开始前的基线测量。

```bash
# Node/TS 项目示例（Stryker；其他栈用等价变异测试工具）
npx stryker init
npx stryker run --mutate "src/core/**/*.ts"
# 报告在 reports/mutation/，按文件看存活 mutant
```

单契约级的验证不依赖工具：手工最小变异探针（改坏生产代码一处 → 跑保留者必须红 → 还原），操作序列见 test-audit-workflow.md 步骤 6。

## 慢测试帕累托优化

80% 耗时集中在 20% 文件。定位它们：

```bash
# vitest 输出每个文件的 endTime-startTime
npx vitest run --reporter=json --outputFile=/tmp/vitest.json
# 解析 json.testResults，按 duration 降序，标红 >1s 的
```

**优化优先级**（按 ROI）：

1. **纯逻辑误放层 2** → 下沉层 1（收益最大：秒级→毫秒级）
2. **每用例重建 setup** → 改 `beforeAll` + 清表（收益大：5-10x）
3. **不必要的外部依赖**（真起端口、真连网络）→ mock 或 app.inject（收益中）
4. **超时/重试默认值过大** → 测试专用调小（收益中）
5. **串行可并行** → 拆文件并行跑（收益取决于核数）

**不要做的"优化"**：

- 跳过慢测试（`it.skip`）——掩盖问题，测试债务只增不减
- 降低断言来加速——本末倒置
- 给凑数测试加缓存——凑数测试该删不该缓存

## 真实诊断案例

某项目 158 个测试文件、1906 个用例、总耗时 150s。实测分布：

- 35 个慢文件（≥1s）占 132s（88% 耗时），但只含 24% 的用例
- 83 个快文件（<0.2s）含 62% 的用例，几乎零成本
- 全仓 229 个 `toBeDefined()`，集中在 stream-bridge（43）、modality-redirect（20）等文件
- 慢文件特征：`beforeEach` 重建 app + 每用例 `app.inject` 完整 round-trip

**结论**：测试数量（1906）不等于测试价值。治理方向不是加更多测试，而是把 35 个慢文件里的纯逻辑下沉层 1、弱断言改强断言——同样的回归保护力，耗时砍到 1/4。
