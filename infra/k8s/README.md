# Combo 单机 k3s 清单

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

日常更新由 CD 流水线全自动完成：main 的 CI 通过后，CD 把本目录同步到服务器 `/opt/combo/infra/k8s`，再在服务器上执行 `scripts/deploy-k8s.sh`（钉镜像 SHA、删旧迁移 Job、kustomize 渲染后 apply、等迁移完成与四个业务面滚动就绪），最后对 30080 入口跑冒烟。手动部署或回滚在服务器上执行同一个脚本：`env SHA=<完整提交SHA> bash /opt/combo/scripts/deploy-k8s.sh`。

注意两个操作纪律：迁移 Job 的模板不可修改而镜像标签每次都变，所以脚本每次都会先删旧 Job；apply 必须经 kustomize 渲染（脚本已保证），直接 apply 单个原始文件会带上未钉版的 latest 标签。

## 当前生产状态与流量拓扑

2026-07-17 已完成从 docker compose 到本套清单的割接（过程与验证记录见 issue #86）。系统 nginx 的两个公网 vhost 现在指向 k8s：`agora.43-160-242-46.sslip.io` 反代到节点 30080（web 的 NodePort），`s3.43-160-242-46.sslip.io` 反代到节点 30900（minio 的 NodePort，浏览器预签直传入口）。

回滚兜底：compose 栈的容器已停止但配置与数据卷都保留（数据冻结在割接时刻，仅作灾难兜底）。回滚方法是恢复 `/etc/nginx/conf.d/zz-agora-demo.conf.bak.cutover` 并 reload nginx，再到 `/opt/combo/infra` 执行 compose up。

观测栈部署在 `observability` 命名空间，用 Helm 单独安装与升级，配置和安装说明在 `observability/` 子目录；业务三进程的 OTLP 上报地址已写进各自清单的环境变量。Grafana 在节点的 30300 端口。

## combo-dev 覆盖层

开发组合环境的固定覆盖层位于 `overlays/combo-dev/`。它只复用 `combo-preview` 命名空间，并用 Kubernetes 内置的静态卷模式把三个 PVC 预绑定到独立有界挂载中的三个本地 PV，不包含自定义存储 provisioner。共享 k3s 只依赖生产所需父数据盘，开发工作负载只挂载 PVC，不使用 `hostPath`。主机 bootstrap 会先完成全部只读检查，再写入持久阻断、关闭转发器并验证所有写入者停止，随后才清理通过精确绑定验证的旧 Cloud Review 三卷数据、创建固定目录或应用平台对象。额外、部分或路径漂移的旧存储不会被自动删除。Namespace、集群 RBAC、StorageClass 和三个 PV 必须与 bootstrap 保存的规范契约完整一致。应用清单只能由手工触发的受保护工作流处理；工作流要求当前 `main` 的完整 SHA 与成功 CI，并与生产 CD 共用 `cd-tecent2` 并发组。它注入镜像摘要后，从五个固定阶段的已验证字节按覆盖层 README 的顺序部署，不能直接应用仓库模板。
