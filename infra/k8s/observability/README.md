# k3s 单节点观测栈安装说明

这套配置把 Compose 中的 Grafana、Loki、Tempo 和 OpenTelemetry Collector 部署到独立的 `observability` 命名空间。Loki 与 Tempo 使用 `local-path` 持久卷，Collector 以 DaemonSet 读取 kubelet 的 CRI 日志，并同时接收业务应用发送到 4317 或 4318 端口的 OTLP 数据。

## 固定版本与仓库

Grafana 系三个 chart（Loki、Tempo、Grafana）已从原 `grafana.github.io/helm-charts` 迁移到社区仓库 `grafana-community/helm-charts`（旧仓库 2026 年 1 月 30 日起停止更新，只剩带弃用标记的最终版本；Loki 的 OSS 版 2026 年 3 月 16 日也完成迁移）。本目录自 2026-07-17 起从社区仓库安装。

当前固定版本：Loki 使用 `18.5.0`（社区仓库重新编号，应用版本 3.7.3），Tempo 使用 `2.2.3`（应用 2.10.7），Grafana 使用 `12.7.2`（应用 13.1.0），OpenTelemetry Collector 使用 `0.164.0`。固定版本可以避免后续上游 values 结构变化造成静默漂移。

```bash
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update
```

## 安装

请在本目录执行命令。安装顺序是 Loki、Tempo、Collector、Grafana，这样 Collector 启动发送数据时两个后端已经存在，最后启动的 Grafana 也能立即连接数据源。`--create-namespace` 会在首次安装时创建命名空间。

```bash
helm upgrade --install loki grafana-community/loki --version 18.5.0 --namespace observability --create-namespace --values values-loki.yaml --wait
helm upgrade --install tempo grafana-community/tempo --version 2.2.3 --namespace observability --values values-tempo.yaml --wait
helm upgrade --install otel-collector open-telemetry/opentelemetry-collector --version 0.164.0 --namespace observability --values values-otel-collector.yaml --wait
set -a; source /opt/combo/infra/.env; set +a
test -n "${GRAFANA_ADMIN_PASSWORD:?/opt/combo/infra/.env 必须设置 GRAFANA_ADMIN_PASSWORD}"
helm upgrade --install grafana grafana-community/grafana --version 12.7.2 --namespace observability --values values-grafana.yaml --set-string adminPassword="$GRAFANA_ADMIN_PASSWORD" --wait
```

单节点集群上升级 Loki 有一个必须知道的坑：chart 默认给 gateway 加了硬性的 Pod 反亲和，而滚动更新要求新旧 Pod 在同一节点短暂共存，两者矛盾会让新 Pod 永远排不上、升级超时死锁。values-loki.yaml 里已把 gateway 的更新策略固定为 Recreate（先杀旧再起新），不要移除；gateway 的 affinity 字段是字符串模板类型，传空值会回落到默认反亲和，改它无效。

密码只通过 Helm 生成的 Kubernetes Secret 注入，不写入 values 文件。执行完安装后建议立即运行 `unset GRAFANA_ADMIN_PASSWORD`，减少密码留在当前 shell 环境中的时间。业务 `api`、`worker` 和 `runtime` 应把 `OTEL_EXPORTER_OTLP_ENDPOINT` 设置为 `http://otel-collector.observability.svc.cluster.local:4318`。

## 验收

先运行 `kubectl get pods,pvc,svc -n observability`，确认所有 Pod 为 `Running`、两个后端 PVC 为 `Bound`，并确认 `otel-collector` Service 暴露 4317 和 4318。再运行 `kubectl rollout status statefulset/loki -n observability`、`kubectl rollout status statefulset/tempo -n observability`、`kubectl rollout status daemonset/otel-collector -n observability` 和 `kubectl rollout status deployment/grafana -n observability`。

浏览器访问 `http://<k3s 节点地址>:30300`。在 Grafana 的数据源页面分别测试 Loki 与 Tempo，二者都应显示连接成功。随后让 `combo` 命名空间中的应用产生一条包含 `traceId` 的 JSON 日志并发起一条已启用 tracing 的请求。在 Explore 的 Loki 数据源执行 `{service_namespace="combo-mvp"} | json`，应看到去掉 CRI 包装后的应用日志，并能按 `traceId`、`trace_id` 或 `span_id` 过滤。在 Tempo 数据源按请求的 trace ID 搜索，应能打开 trace；打开 span 后使用关联日志功能，应能跳到同一 trace ID 的 Loki 日志。预置的 “Trace Debug” 仪表盘也可以直接输入 trace ID 验证日志查询。

如果日志没有进入 Loki，请先查看 `kubectl logs -n observability daemonset/otel-collector`，再确认目标节点确有 `/var/log/pods` 日志以及应用输出是单行 JSON。如果 trace 没有进入 Tempo，请确认业务端点使用 HTTP 协议的 4318 端口，并检查 Collector 日志中的导出错误。

## 指标监控

指标系统使用不包含 Operator 和 CRD 的 `prometheus-community/prometheus` chart。固定 chart 版本为 `29.14.0`（应用版本 v3.13.0），该稳定版本已于 2026-07-17 从 [Artifact Hub](https://artifacthub.io/packages/helm/prometheus-community/prometheus?modal=values) 核实。配置保留 chart 内置的 Kubernetes 节点、cAdvisor 和 Service Endpoints 等服务发现抓取任务，并启用 kube-state-metrics 与 node-exporter；Prometheus 历史数据保留 15 天且最多使用 8GB，PVC 使用 `local-path` 申请 10Gi。

先添加社区仓库并更新索引，再在本目录安装 Prometheus：

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install prometheus prometheus-community/prometheus --version 29.14.0 --namespace observability --create-namespace --values values-prometheus.yaml --wait
```

Grafana 无需卸载或重装，只需继续使用原 release 并带更新后的 values 升级；管理员密码仍按前文方式从服务器环境变量注入：

```bash
helm upgrade --install grafana grafana-community/grafana --version 12.7.2 --namespace observability --values values-grafana.yaml --set-string adminPassword="$GRAFANA_ADMIN_PASSWORD" --wait
```

验收时先运行 `kubectl get pods,pvc,svc -n observability`，确认 Prometheus server、kube-state-metrics 和 node-exporter Pod 均为 `Running`，Prometheus PVC 为 `Bound`。随后运行 `kubectl port-forward -n observability svc/prometheus-server 9090:80`，访问 `http://127.0.0.1:9090/targets`；除当前集群中确实不存在的注解抓取目标外，已发现的节点、cAdvisor、kube-state-metrics 和 node-exporter target 都应为 `UP`。如果 k3s 发行版关闭了某个 kubelet 指标端点，请在安装时核对对应 target 的错误信息和 k3s 参数，不要直接删除默认抓取配置。

访问 Grafana 后，在 “Dashboards → Kubernetes” 中可以找到 “Node Exporter Full”、“Kubernetes / Views / Pods”和“Kubernetes / Views / Global”三块看板。若要直接验证容器内存历史曲线，可在 Explore 选择 Prometheus 并查询 `sum by (namespace, pod, container) (container_memory_working_set_bytes{namespace="combo", container!="", image!=""})`，时间范围选择最近一小时后应看到 `combo` 命名空间各容器的曲线。首次安装时请核对社区看板 revision 仍可下载且其 Prometheus 数据源输入已映射到 UID `prometheus`。

本方案刻意不安装 Alertmanager、不配置告警规则，也禁用了 Pushgateway，只提供指标采集、存储与看板展示。

## 卸载

请按入口到后端的顺序卸载，避免卸载过程中继续写入已经删除的后端。

```bash
helm uninstall grafana --namespace observability
helm uninstall otel-collector --namespace observability
helm uninstall tempo --namespace observability
helm uninstall loki --namespace observability
```

Helm 卸载通常会保留 StatefulSet 创建的 PVC。确认历史日志、trace 和 Grafana 状态不再需要后，才运行 `kubectl delete pvc --all -n observability`。最后确认命名空间中没有需要保留的对象，再运行 `kubectl delete namespace observability`。
