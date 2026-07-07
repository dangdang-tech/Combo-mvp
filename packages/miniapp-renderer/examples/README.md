# examples 目录

本目录存放 mini-app UI 文档的真实感示例，既是人看的参考样例，也是测试的固定输入：`src/renderer.test.tsx` 会逐个验证这里的每份 JSON 同时通过 zod 校验，并且文档里出现的所有 type 值都在 12 种节点白名单内。

- `ctr-review.json` 是「女装主推款 CTR 判断」经验体的输出示例：标题与说明文字、一张卡片内三条候选款指标 list-item（各带判断徽标）、markdown 结论块、引用原始复盘会话的 citation，以及一个携带 `rerun-ctr-review` 动作标识的复跑按钮和相对时间戳。
- `daily-brief.json` 是「每日情报简报」经验体的输出示例：标题、日期与数量徽标行、一张卡片内三条情报 list-item、markdown 今日建议、带外链的情报源 citation，以及两个分别携带 `generate-next-brief` 与 `open-brief-history` 动作标识的按钮。

新增示例文件后无需改测试代码之外的配置，把文件名加进 `renderer.test.tsx` 顶部的 `EXAMPLE_FILES` 数组即可纳入一致性检查。
