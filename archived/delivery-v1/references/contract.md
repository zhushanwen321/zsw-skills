# 产品契约与实施增量

产品契约是验收权威，记录用户可观察的正确行为。解决方案是实现辅助材料，不得反向替代契约。`solution.md` 与 `nonGoals` 是设计/审查/风险沟通材料：供 designer、reviewer 与用户对齐取舍，`delivery-gate` 不以它们作机器判定输入——判定只依据 requirements、increments 与 events。

## 契约示例

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "taskId": "feature-example",
  "projectRoot": "<项目根绝对路径>",
  "objective": "让项目维护者能够保存并复用项目约定",
  "requirements": [
    {
      "id": "R1",
      "kind": "goal",
      "statement": "保存约定后，同一项目的新会话能够读取该约定",
      "required": true,
      "riskAcceptable": false,
      "evidenceKinds": ["scenario"]
    },
    {
      "id": "R2",
      "kind": "invariant",
      "statement": "任何自动写入路径在功能关闭后都不得修改约定数据",
      "required": true,
      "riskAcceptable": false,
      "evidenceKinds": ["command", "inspection"]
    }
  ],
  "nonGoals": ["服务端同步"],
  "riskLevel": "high",
  "exploratoryReview": "required",
  "reviewDimensions": ["data", "lifecycle", "control"]
}
```

字段约束：

- `schemaVersion` 恒为 1；`contractVersion` 从 1 开始，每次修改契约递增。
- `kind = goal | invariant`；`riskLevel = low | medium | high`。
- `required/riskAcceptable` 为布尔。`riskAcceptable=false` 表示该行为不能由用户风险接受替代。
- `evidenceKinds` 至少一项：`command`（确定命令）、`scenario`（运行场景）、`inspection`（独立代码或产物检查）。
- `exploratoryReview = not-required | required`；high 必须 required。
- `reviewDimensions` 是本次探索审查要覆盖的维度名清单，由任务自行定义，不写死业务词。
- `requirements/nonGoals/reviewDimensions` 的 id 或文本不得含混到无法构造反例。

## 好与坏的行为表述

不推荐：

> 系统应当正常工作，记忆功能比较可靠。

推荐：

> 写入一条合法约定后，关闭并重新创建同项目会话，新会话的首次模型请求包含该约定。

后者的对象、动作和可观察结果都能被证伪。

## 实施增量

`increments.json` 与契约版本绑定：

```json
{
  "schemaVersion": 1,
  "contractVersion": 1,
  "items": [
    {
      "id": "I1",
      "title": "保存约定并在新会话读取",
      "requirementIds": ["R1", "R2"],
      "testCommand": { "program": "node", "args": ["--test"] }
    }
  ]
}
```

- 每个增量产生一个可运行行为，不按技术层堆完所有模块后再集成。
- `requirementIds` 必须引用当前契约；`testCommand` 的 program 与 args 分开，禁止拼接 shell 命令。
- 增量属于同一交付事务，不各自复制契约或形成独立 accepted。
- 新增自动生产者、消费者或共享状态写入点时，相关全局不变量必须重新验证。
