# Combo 单机 k3s 清单

生产清单位于本目录根部。固定单槽云端评审环境使用 `overlays/cloud-review`，完整隔离边界、Secret 前置与工作流说明见 [`../../docs/cloud-review.md`](../../docs/cloud-review.md)。

这套清单把生产 Docker Compose 栈中的 PostgreSQL、两个 Redis 实例、MinIO、桶初始化任务、数据库迁移任务和三个业务镜像部署到单节点 k3s。所有资源位于 `combo` 命名空间，持久卷使用默认可用的 `local-path` 存储类。

清单保留了 Compose 中的数据持久化、Redis 队列不驱逐、Redis 热数据可驱逐、MinIO 建桶和独立数据库迁移等语义。Kubernetes 没有采用 Compose 的 `depends_on`；基础设施的就绪探针负责报告状态，两个一次性任务和业务工作负载由部署命令按顺序创建。生产使用外部 Logto，因此这里不部署 Logto 服务。

## 部署前准备

先创建命名空间，再从服务器上的生产环境文件创建应用配置 Secret：

```sh
kubectl apply -f infra/k8s/namespace.yaml
kubectl -n combo create secret generic combo-env --from-env-file=/opt/combo/infra/.env
kubectl -n combo create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=<GitHub 用户名> --docker-password=<具有 read:packages 权限的 PAT>
```

`ghcr-pull` 用的 token 需要长期有效：CD 流水线用的是 GitHub Actions 的临时 token、部署完即登出，集群里拉镜像必须另建一个 read:packages 权限的个人访问令牌（PAT）。

`combo-env` 必须包含清单引用的 PostgreSQL、S3、Logto 和 LLM 配置。部署前还必须把 `kustomization.yaml` 中三个业务镜像的 `latest` 改成被部署提交的完整 SHA。可以在 `infra/k8s` 目录执行以下命令：

```sh
kustomize edit set image ghcr.io/dangdang-tech/combo-api=ghcr.io/dangdang-tech/combo-api:<SHA> ghcr.io/dangdang-tech/combo-runtime=ghcr.io/dangdang-tech/combo-runtime:<SHA> ghcr.io/dangdang-tech/combo-web=ghcr.io/dangdang-tech/combo-web:<SHA>
```

## 首次部署

首次部署应先创建基础设施，并等待 PostgreSQL、Redis 和 MinIO 就绪：

```sh
kubectl apply -f infra/k8s/postgres.yaml -f infra/k8s/redis-queue.yaml -f infra/k8s/redis-hot.yaml -f infra/k8s/minio.yaml
kubectl -n combo rollout status statefulset/postgres
kubectl -n combo rollout status statefulset/redis-queue
kubectl -n combo rollout status statefulset/minio
kubectl -n combo rollout status deployment/redis-hot
```

基础设施就绪后创建建桶任务和数据库迁移任务，并等待它们成功完成：

```sh
kubectl apply -f infra/k8s/job-minio-init.yaml -f infra/k8s/job-migrate.yaml
kubectl -n combo wait --for=condition=complete job/minio-init job/migrate --timeout=300s
```

两个任务完成后创建业务工作负载：

```sh
kubectl apply -f infra/k8s/api.yaml -f infra/k8s/worker.yaml -f infra/k8s/runtime.yaml -f infra/k8s/web.yaml
```

完成首次分阶段部署后，整套声明也可以使用 `kubectl apply -k infra/k8s` 重复应用。就绪探针会阻止尚未就绪的 API 和 runtime 接收流量，但不会替代首次部署时对任务完成状态的检查。

## 日常更新

这条 WIP 分支只用于隔离的 Cloud Review，不直接更新生产环境。Review 的镜像钉版、迁移顺序、专属 Secret 与公网冒烟均由 `scripts/deploy-cloud-review.sh` 和 Cloud Review workflow 负责；完整操作见 [`../../docs/cloud-review.md`](../../docs/cloud-review.md)。

生产部署继续以 `origin/main` 的清单和工作流为准，不能从本分支直接 apply 到 `combo` namespace。
