# 断言强度与 property-based 测试

> 配合 SKILL.md 场景 B 使用。写测试代码时选择断言风格、判断是否该用 property-based。

## 断言强度分级

| 级别 | 判定 | 示例 | mutation 存活率 |
|------|------|------|----------------|
| **强** | 断言具体值或完整结构 | `toBe(42)` / `toEqual({...})` / `toMatchObject` | ~0% |
| **中** | 断言集合内容或精确关系 | `toContainEqual(x)` / `toHaveLength(3)` 配合具体元素 | 低 |
| **弱** | 只断言"有值"或"非空" | `toBeDefined()` / `toBeTruthy()` / `toBe(true)` / `length > 0` | **接近 100%** |

弱断言的致命问题：把被测代码从 `+` 改成 `-`、从 `>=` 改成 `>`，它**仍然通过**。覆盖率达 100% 但抓不到任何回归——这就是"凑数测试"的本质。

## 弱断言黑名单与改写

| 弱断言 | 为什么弱 | 改写为 |
|--------|---------|--------|
| `expect(x).toBeDefined()` | `undefined`→`{}`、`null`→`0` 都通过 | `expect(x).toEqual(具体值)` |
| `expect(x).toBeTruthy()` | 几乎任何值都通过 | 断言具体字段 `expect(x.field).toBe(...)` |
| `expect(arr.length).toBeGreaterThan(0)` | 只要有元素，内容全错也通过 | `expect(arr).toEqual([具体元素])` |
| `expect(fn).toHaveBeenCalled()` | 调没调用对，调了什么参数没验 | `.toHaveBeenCalledWith(具体参数)` |
| `expect(res.statusCode).toBe(200)` 后不断言 body | 状态码对但返回错数据 | 加 `expect(body).toMatchObject({...})` |
| `expect(result).toBeInstanceOf(Class)` | 任何该类实例都通过 | 断言实例的具体属性 |

**自检规则**：断言里出现黑名单成员时，问自己"被测逻辑改成错的实现，这个断言会红吗？"答不出或答"不会" → 重写。

## property-based：何时用、怎么写

### 何时用

满足任一条件，优先 property-based 而非堆 example：

- 被测函数是**纯函数**（无副作用，相同输入恒定输出）
- 能表达成**不变量**："对所有合法输入 X，Y 恒成立"
- 输入空间大，example 不可能穷举边界（数值范围、字符串组合、集合排列）

### 何时不该用

- 有副作用（DB/HTTP）→ property-based 会放大副作用成本
- 逻辑本质是状态机但有外部依赖 → 先抽成纯转移函数再 property-based
- 只有一个固定业务场景 → example 更直接

### 最小模板（fast-check）

```typescript
import { describe, it, expect } from "vitest";
import fc from "fast-check";

describe("serialize↔parse round-trip", () => {
  it("∀合法 MappingTarget: serialize(parse(x)) 深相等", () => {
    fc.assert(
      fc.property(arbitraryMappingTarget(), (target) => {
        const roundTrip = serialize(parse(serialize([target])));
        expect(roundTrip).toEqual([target]);
      }),
    );
  });
});

// 任意值生成器：约束合法输入空间
const arbitraryMappingTarget = fc.record({
  backend_model: fc.string({ minLength: 1 }),
  provider_id: fc.string({ minLength: 1 }),
  circuit_breaker: fc.option(fc.record({
    enabled: fc.boolean(),
    window_sec: fc.integer({ min: 1 }),
    failure_rate: fc.float({ min: 0, max: 1, noDefaultInfinity: true }),
    // ...其余字段
  })),
});
```

### 常见不变量模式

| 场景 | 不变量 |
|------|--------|
| 序列化 round-trip | `serialize(parse(x)) === x` |
| 排序 | 输出长度不变 ∧ 每元素 ≤ 后继 ∧ 是输入的排列 |
| 过滤 | 输出 ⊆ 输入 ∧ 每元素满足谓词 |
| 状态机转移 | 合法转移不违反状态图 ∧ 非法输入被拒 |
| 计数器 | 计数总和 == 输入事件数 ∧ 各类计数 ≥ 0 |

### 成本控制

- `fc.assert` 默认跑 100 个用例。纯逻辑下 <50ms，可接受。
- 任意值生成器要**约束合法空间**——不加约束会生成大量"非法输入被拒"的无意义用例。
- 失败时 fast-check 会 shrink 到最小反例，直接给出可复现的最小输入。

## 真实案例

**序列化 round-trip 用 property-based 替代 10 个 example**：测试 `parseMappingRule` ↔ `serializeRule` 双向透传。example 方案要手构造"有 CB"、"无 CB"、"部分字段"、"空数组"等 10+ 组合，且仍可能漏边界。property-based 方案：定义合法 `MappingTarget` 任意值生成器，断言 `∀target: serialize(parse(serialize([target]))) === [target]`。一个测试覆盖全部字段组合的边界，30ms 跑完 100 个自动用例。
