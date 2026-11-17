# archived/ — 已退役技能与产物归档

本目录存放 V1-V3 代三技能（delivery / dev-flow / tech-design）与其配套 workflow 产物，均已退役、不再作为正式技能维护。git 历史可追溯各代完整沿革。

## 目录

| 条目 | 内容 |
|------|------|
| `delivery-v1` `dev-flow-v1` `tech-design-v1` | v1 代技能（目录名保持原名，路径从 `skills/self/dev-workflow/` 迁出） |
| `delivery-v2` `dev-flow-v2` `tech-design-v2` | v2 代技能（三技能体系稳定线） |
| `delivery-v3` `dev-flow-v3` `tech-design-v3` | v3 代技能（dev 线基线复制版） |
| `workflows-v1/` | v1 代 workflow 产物：`<name>.dwf.ts` + `pi/<name>.js` + `src/`（单源三件套）。含 tech-review-loop / wave-executor / dev-consistency-loop / contract-design / candidate-build / independent-assurance |
| `workflows-v2/` | v2 代 workflow 产物（同名加 `-v2` 后缀，acceptance-design-v2 等六件） |
| `workflows-v3/` | v3 代 workflow 产物（`-v3` 后缀六件） |

## 约束

- **不再构建**：`scripts/build-workflows.mjs` 的构建名单（NAMES）与版本权威映射不含归档产物；改归档文件不需要重建，版本纪律检查器也不登记归档技能。
- **不安装**：`~/.agents/skills/` 不设归档技能 symlink；归档产物不部署到 `~/.zcode/workflows/` 与 `~/.pi/agent/workflows/`。
- **跨代共用引擎例外**：`design-code-sync-v2` 与 `design-code-sync-loop` 两引擎留在 `skills/self/dev-workflow/workflows/`（现行构建树），归 V4/V5 与 dev 线的 D5 终态同步共用——复制引擎会造成状态双写者。
- **观测词表保留两名**：构建器 `OBS_SKILLS` 保留 `dev-flow-v1` / `dev-flow-v2`——两引擎按发起方代际归缺省发射这两个技能名（obsSkill 参数），历史与跨代统计数据按此过滤。
- **测试锚点**：`scripts/tests/` 部分测试以归档产物 / 归档裁决器为载体测通用机制（产物字节未变，仅路径迁移）：delivery-gate 三套、workflow-observability 第 1-6 节与第 10 节。
- **复活通道**：恢复某一代时从本目录 git mv 回 `skills/self/dev-workflow/`，并在 `scripts/build-workflows.mjs`（NAMES / SKILL_VERSION_SOURCES）与 `scripts/check-version-discipline.mjs`（SKILLS / PRODUCT_SKILL）重新登记。

## 归档时同步退役的通道

「交付体系外独立设计 / 独立执行」（用户明确不走交付体系）曾由 tech-design-v1 / dev-flow-v1 承载，随归档一并退役——现行技能（dev / v4 / v5 线）的入口路由对该类任务按普通任务处理，不再指向专用技能。
