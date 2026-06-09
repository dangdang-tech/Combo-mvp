# 经验体 mini-app · 换皮实验台

这是对【重构后框架】的一次**尝试性实现 + 验证**(对应 `docs/重构-agentic-miniapp-经验体而非流水线.md`)。
它不接生产的 share/relay 系统,而是把框架的核心命题做成一个**自包含、能跑、能测**的最小原型,
专门回答两个问题:

1. **目标1 · GUI↔Engine 兼容性** —— 界面和引擎的边界是不是真的解耦?
2. **目标2 · 流程/交付是否成立** —— 这个交互流程顺不顺、最终交付的东西站不站得住?

## 核心命题(被验证的那句话)

> mini-app = 一个被某人「经验」condition 的灵活 agent。
> 可复用的是【这个人的决策模式】,不是事实、不是固定流程。

落成三件套:
- **经验体(灵魂)** = 一组 memory block(品味 / 判断守则 / 带证据的案例),creator 拥有、只读 → `fixtures/experience-career.json`
- **有环行为(执行壳)** = turn 链 + checkpoint;「手改 / 继续对话」= 指回更早节点的环
- **自适应交互(外壳)** = `stance` 决定怎么暴露同一份经验(advisor / coach / collaborator / delegate)

## 关键设计:同一个 engine,两套 GUI

```
                 ┌─────────────── engine.mjs(变体无关)───────────────┐
 经验体 JSON ──▶ │ compileSystemPrompt(只换 STANCE RULES 段)         │
                 │ runTurn → 权威事件集(task.progress/output/...)    │
                 │ mergeAgentArtifact + patchArtifact(locked-by-origin)│
                 └───────────┬───────────────────────┬───────────────┘
                   stance=advisor            stance=collaborator
                        │                            │
                  advisor.html                  collab.html
                  纯对话 · 无产物              意图框 → 可编辑矩阵 → 有环微调
```

**换皮实验的逻辑**:两套界面后端跑的是同一个 `engine.mjs`、同一份经验体、同一套事件。
服务端代码(`exp-server.mjs`)对它俩一视同仁——只把 GUI 发来的 intent 路由进 engine。
若同一引擎既能裸驱动纯对话、又能驱动可编辑产物面 → 边界真解耦。

## 跑起来

```bash
# 确定性 mock brain(不烧钱、可离线,用于演示/CI)
EXP_BRAIN=mock node experiments/exp-server.mjs
# → http://localhost:7800  (首页选 advisor 或 collab)

# 真 LLM(需 OPENROUTER_API_KEY)
set -a; . ./.env; set +a
EXP_BRAIN=pi EXP_MODEL=deepseek/deepseek-chat node experiments/exp-server.mjs

# 引擎自动化验收(29 项,mock brain,无需网络)
node experiments/test-engine.mjs
```

## 文件

| 文件 | 职责 |
|---|---|
| `engine.mjs` | **变体无关引擎**:经验体→systemPrompt、跑 turn、解析产物契约、合并/锁定产物、发权威事件。无任何 GUI 分支。 |
| `brain-mock.mjs` / `brain-pi.mjs` | 可插拔 brain(确定性脚本 / 真·pi createAgent 流式),契约一致。 |
| `exp-server.mjs` | 实验台:HTTP+SSE,把 intent/message/artifact-op 路由进 engine。变体无关。 |
| `advisor.html` | 变体 A:被问式纯对话,答案带出处 chip,追问即环。 |
| `collab.html` | 变体 B:意图框 → 可编辑对比矩阵 → 手改 pin/continue + 对话微调(有环)。 |
| `test-engine.mjs` | 29 项自动化验收(换皮 + 并发/锁定/terminal-guard/隔离/有环)。 |
| `fixtures/experience-career.json` | 固定夹具:「老周」的职业判断经验体(2 品味 + 3 守则 + 3 案例)。 |

## 验证结论(2026-06-09 实跑)

### ✅ 目标1:GUI↔Engine 边界解耦——成立
- 同一 `engine.mjs` 实例,只换 `stance` 参数,同时驱动 advisor / collaborator 两条路。
- 两路只消费**权威事件集** `EVENTS`(engine 在 `_emit` 里硬断言,不许发明新事件)→ 边界守得住。
- 经验体编译断言:换 stance 时 `[TASTE]/[GUARDRAILS]/[CASES]` 逐字不变,只有 `[STANCE RULES]` 变 → 一份经验,四 stance 复用。
- 浏览器实测:两个完全不同的前端,后端零差异。

### ✅ 目标2:流程/交付成立——成立(有前提)
- **有环 + locked-by-origin 经得起重跑**:用户手改某格并 pin/continue,触发真实 re-run 后,
  锁定格保持 user 值、未锁定格被 agent 增量调整。浏览器端 version 2→4 单调递增、无回退。
- **并发正确性**:迟到的 agent 输出不覆盖锁定格;取消后迟到的完成不复活产物(terminal-guard);跨 session 不串数据。
- **真 LLM 交付物确实「像这个人的判断」**:
  - advisor 用创作者口吻作答,正确引用 `taste1/taste2/g1`,把握度 0.9,且按案例 c1 的模式选 A。
  - collaborator 自己长出评估维度(把 taste1「三年视角」提成了一列),每格引用真实 block,
    并正确执行守则优先级(「选项B 触发 g1 → 直接否决」)。**零幻觉引用**。
- **前提(也是边界)**:产物必须是结构化可编辑的(矩阵/清单),长文 markdown 的手改回流会退化成模糊 diff;
  经验体必须够厚(守则带优先级、案例带证据),否则答案会塌回通用 GPT 口吻——这版同时也是对「经验提取质量」的压测。

### 一句话
> 框架的两个最难命题——**同一引擎换皮**、**有环手改不塌**——都在真实 HTTP+SSE+浏览器里跑通了,
> 且真 LLM 的交付物是可追溯到经验体的、可辨认的「这个人的判断」。下一步该验的是**经验提取**那一端:
> 能不能从真实 session 里稳定抽出这种带优先级守则 + 带证据案例的经验体。
