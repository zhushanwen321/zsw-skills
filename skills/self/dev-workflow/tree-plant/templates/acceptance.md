# 实机验收 case

每条 case 必须在真实宿主/真实进程上执行；命令不得是单测 runner 或 mock 形态（root gate 拒绝）。
预期判据用分号分隔：`exit:0`（缺省）、`contains:子串`、`not-contains:子串`。
关联列 = `trunk` 或枝名（与设计文档树形拆分一致）。

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| T1 | 示例：真实宿主装载扩展并保存一条记忆 | node probe/save.e2e.mjs | exit:0;contains:saved | trunk |
| B1 | 示例：某枝场景 | node probe/xxx.e2e.mjs | exit:0 | 枝名 |

<!-- 命令形态要求：驱动真实宿主二进制/装载器/真实子进程；探针脚本随交付物入库。
     接口核实表（fact-check.md）的每一行必须至少被一条 case 覆盖。 -->
