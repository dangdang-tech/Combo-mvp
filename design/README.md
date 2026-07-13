# design — Combo 设计交付物快照

这个目录存放 Combo 设计侧的交付物，来源是 2026-07-13 的设计交接包（combo-design-handoff）。全部是纯静态资料，不在 pnpm workspace 之内，不参与构建和部署。

## 各子目录与文件

- `ONBOARDING.md`：开发者上手指南，规定了这套材料的阅读顺序，读完约一小时能建立完整认知。
- `prototype/`：占卜消费流的可交互原型 `oracle-flow.html`。它是自包含单文件（内联 CSS 和原生 JS），用浏览器直接打开即可运行，顶部带原型调试条；同目录的 README 说明调试条用法和每个演示态对应的设计决策。
- `ds-cards/`：28 张自包含 HTML 设计卡加品牌资产（`assets/`），从 `index.html` 进入总览。分组为基础（foundations）、品牌（brand）、组件（components）、对话框系统与页面（pages）、明暗对比（compare）。它是 Claude Design 在线面板的离线快照。
- `system/`：设计系统契约。`AGENTS.md` 是给开发 agent 的规则手册（token 用法、组件清单、禁令、验证命令），`design-taste.md` 是品味守则和视觉硬禁令，`tokens/` 是密度定稿的 token 契约快照，含原料层 `primitives.json`、语义层 `semantic.json`、动效 `motion.json` 和构建产物 `tokens.css`（产物文件不可手改）。

## 真源与边界

- 设计决策记录（DEC-01 至 DEC-43）与设计系统总纲**不入仓**，真源在飞书。决策文档见 [Combo 设计决策记录](https://zcndjgnt0026.feishu.cn/docx/D1qEdfDQ8oV4i2xeWgycEnPbnY4)；总纲（含伴随对话框六层处理模型）在飞书设计侧文档，与决策文档同处维护。项目整体的 PRD 与技术方案真源见仓库根 README 的「文档真源」一节。
- 可构建的设计系统包（`@cb/ds-tokens`、`@cb/ds`、`@cb/miniapp-renderer`）目前在 `ds/agent-ready-v1` 分支上，其 token 值是更早的「活力红橙」版本，落后于本目录；将来包化或合并该分支时，token 取值一律以 `system/tokens/` 的密度定稿值为准。
- `system/AGENTS.md` 里的样式约束（只准引用 `--cb-*` 语义 token）要等 `apps/runtime-web` 实际接入设计系统后才生效，当前放在这里仅作契约参考，不约束现有代码。
