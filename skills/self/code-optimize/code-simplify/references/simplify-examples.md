# 简化示例速查

> 只保留最能说明边界的一个例子（P5 示例驱动），其余场景靠信号清单判断。

## TS/JavaScript

```typescript
// 冗余 async 包装
async function getUser(id: string): Promise<User> {
  return await userService.findById(id);
}
// → 不需要 async，直接返回
function getUser(id: string): Promise<User> {
  return userService.findById(id);
}

// 冗余布尔返回
if (input.length > 0 && input.length < 100) {
  return true;
}
return false;
// → return input.length > 0 && input.length < 100;

// 嵌套三元（反例） vs 具名函数（正例）
// ✗ const label = isNew ? 'New' : isUpdated ? 'Updated' : isArchived ? 'Archived' : 'Active';
// ✓
function getStatusLabel(item: Item): string {
  if (item.isNew) return 'New';
  if (item.isUpdated) return 'Updated';
  if (item.isArchived) return 'Archived';
  return 'Active';
}

// 重复簇 → 静态工具方法（rule of two：第二处出现即抽；差异点参数化；命名按能力）
// ✗ 两处各自手写：const key = raw.trim().toLowerCase().replace(/\s+/g, '-');
// ✓
class TextUtils {
  static normalizeKey(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, '-');
  }
}
```

## Python

```python
# 手工建 dict → dict 推导式
# result = {}
# for item in items: result[item.id] = item.name
result = {item.id: item.name for item in items}

# 嵌套条件 → 守卫从句
def process(data):
    if data is None:
        raise TypeError("Data is None")
    if not data.is_valid():
        raise ValueError("Invalid data")
    if not data.has_permission():
        raise PermissionError("No permission")
    return do_work(data)
```

## 一眼可扫的判断

- **该简化**：冗余包装、可推导缓存、重复块、死代码、误导名、嵌套三元、无价值抽象。
- **不该简化**：为可扩展性/可测性服务的抽象、性能关键路径上会更慢的改写、你还不懂的代码、范围外代码。
