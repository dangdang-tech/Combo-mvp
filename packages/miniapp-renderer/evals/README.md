# 渲染器合法率评测（协议占位，spec D4 第 5 条）

本目录用于存放 runtime agent 生成合法率的评测记录。spec 验收要求是：runtime agent（经 OpenRouter 调用）在拿到 `schema/miniapp-ui.schema.json` 与 20 个真实经验体任务描述后，生成的 mini-app JSON 通过 `miniAppDocumentSchema.safeParse` 的比例不低于 90%。

当前状态：协议已定，尚未执行（需要真实经验体任务集与 OpenRouter 凭据，属于下一步工作）。执行时在本目录落两个文件：`tasks.jsonl`（任务集）与 `results-YYYY-MM-DD.jsonl`（每次生成的原始输出、解析结果与失败原因），并把通过率写进本文件的记录表。

| 日期   | 模型 | 样本数 | 合法率 | 记录文件 |
| ------ | ---- | ------ | ------ | -------- |
| 待执行 | -    | -      | -      | -        |
