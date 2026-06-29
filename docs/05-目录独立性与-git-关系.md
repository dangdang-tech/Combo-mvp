# 仓库结构与 Git 归属

这份文档回答两个常被问到的问题：本 monorepo 与外层 `agora-mvp` 仓库是什么关系？它的 Git 历史是否完整？

一句话结论：**本 monorepo 原是 `agora-mvp` 仓库下的 `creator-builder/` 子目录，现已「提升一层」成为仓库根本身；提升用 `git mv`（rename）完成，全部历史保留，可用 `git log --follow` 追溯。外层那套老 agora-mvp demo 脚本已一并删除。**

---

## 1. 现状：monorepo 即仓库根，完全自包含

仓库根就是一个独立的 pnpm monorepo（package 名 `@cb/root`）。证据如下。

| 维度       | 实际情况                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 包与依赖   | 仓库根自带 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`node_modules`，依赖全部在仓库内解析。 |
| 工作区范围 | `pnpm-workspace.yaml` 圈定 `packages/*`、`apps/*`、`db`、`infra`、`scripts`，无任何外部引用。 |
| TypeScript | `tsconfig.json` 的项目引用只指向 `./packages/shared`、`./apps/api`、`./apps/web`。 |
| 源码 import | `apps/web/src` 里的相对路径最深只回到 `apps/web/src` 内部。 |
| 容器构建   | `infra/docker-compose.yml` 的构建上下文是 `context: ..`（compose 文件在 `infra/` 下，故 `..` 指仓库根），Dockerfile 都在 `infra/` 内。 |
| CI         | `.github/workflows/ci.yml` 位于仓库根，GitHub Actions 直接识别并运行；步骤均以仓库根为工作目录（无 `working-directory` 前缀）。 |
| 配置       | 仓库根自带 `.env`、`.env.local.example`、`.env.compose.example`、`.nvmrc`、`eslint.config.js`、`tsconfig.base.json`。 |

**怎么跑**：本地子集开发与 Compose 起全栈的完整命令都在仓库根的 [`README.md`](../README.md)（「安装」「本地开发」「Compose 起全栈」三节）。所有命令都从仓库根执行。

---

## 2. Git 层面：普通的仓库根，历史完整

- 仓库根有一个**真正的 `.git` 目录**，这就是 `agora-mvp` 仓库本身。在仓库内任意位置执行 git，都落到这个仓库。
- 「提升一层」这次重构用 `git mv`（rename）把原 `creator-builder/<path>` 全部移到 `<path>`，Git 以 rename 记录，**历史不丢**。追溯某文件的完整历史：

  ```bash
  git log --follow -- <当前路径>      # 跨越 creator-builder/ → 仓库根 的改名，历史连续
  ```

- 同次重构删除了外层老 agora-mvp demo 脚本（`loop-server.mjs`、`anchor.html`、`miniapp.html`、`experiments/`、`fixtures/` 等）——它们与本 monorepo 无任何代码/配置引用关系，属上一代 MVP 试验产物。

---

## 3. 历史背景：为什么曾经是子目录

本 monorepo 早期作为 `creator-builder/` 子目录与外层老 MVP 脚本并存，目的是「新产物全部归拢一处、不碰外层」。当新主链路成为唯一方向后，外层老脚本退役，子目录被提升为仓库根，结构回归常态（仓库根即工程根）。

> 历史注记：更早的一份开发机检出曾把外层目录设为 `agora-mvp` 的一个 linked worktree（`.git` 是文件而非目录）。当前这份检出是**主仓库**（`.git` 是目录），不涉及 worktree。

---

## 4. 自己复核结论的命令

```bash
# 确认 .git 是目录（主仓库，非 worktree）
test -d .git && echo "main repo"

# 确认提升后的历史可追溯（应见 creator-builder/ 时期的提交）
git log --follow --oneline -- package.json | head

# 确认没有引用爬出仓库（应只返回仓库内部的相对路径）
grep -rn "loop-server\|anchor.html\|miniapp" . --exclude-dir=node_modules --exclude-dir=.git

# 确认工作区只圈自己的子目录
cat pnpm-workspace.yaml
```
