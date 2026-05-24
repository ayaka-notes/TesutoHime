# Docker 部署

本文档介绍如何用 Docker / Docker Compose 一键部署 TesutoHime（ACMOJ）。
相比[多机部署](overview.md)，Docker 方式把所有组件跑在一台机器上，
适合开发、测试和小规模使用。

## 组件一览

| 服务 | 说明 | 对外端口 |
| ---- | ---- | -------- |
| `postgres` | 主数据库 | 仅内网 |
| `redis` | 缓存 / 任务队列 | 仅内网 |
| `minio` | S3 对象存储 | `9000` API / `9001` 控制台 |
| `minio-init` | 一次性任务：建桶、设权限 | - |
| `web` | Flask Web 服务（gunicorn） | `5080` → 容器 `5000` |
| `scheduler` | 调度机 | 仅内网 `5100` |
| `judger` | 评测机（沙箱，需特权模式） | 仅内网 |

`judger` 位于 `judger` profile 中，默认不启动。

## 前置要求

- Docker Engine 与 Docker Compose v2
- 评测机需要内核支持 user namespaces（运行 `judger` 时容器以 `privileged` 模式启动）

## 快速开始

在仓库根目录执行：

```sh
# 构建并启动数据服务 + Web + 调度机
docker compose up -d --build
```

启动后访问 **<http://localhost:5080/OnlineJudge/>**（注意 `/OnlineJudge/` 前缀，
直接访问 `/` 会返回 404，这是应用挂载路径的设计）。

MinIO 控制台：<http://localhost:9001/>，账号 `minioadmin` / `minioadmin`。

### 创建管理员

```sh
docker compose exec web python -m scripts.create_admin
```

按提示输入用户名和密码，会创建一个超级管理员（`privilege = 2`）。

### 启动评测机

评测机镜像包含 Nix 与 nsjail 沙箱，构建较重、耗时较长：

```sh
docker compose --profile judger up -d --build
```

评测机以 `privileged` 模式运行。启动后需要在 Web 管理端把这台评测机加入数据库
（参见 [`scripts/add_runner.py`](../../scripts/add_runner.py)），Web 才能显示其状态。

## 配置

镜像内的配置文件来自 `docker/` 目录：

- `docker/web.config.py` → 容器内 `web/config.py`，所有值从环境变量读取
- `docker/scheduler.yml` → 容器内 `scheduler.yml`
- `docker/runner.yml` → 容器内 `runner.yml`

Web 的环境变量（数据库地址、S3 端点与密钥、调度器地址等）在
`docker-compose.yml` 的 `web` 服务里设置。生产环境请修改以下默认值：

- PostgreSQL 用户名 / 密码（`docker-compose.yml` 的 `postgres` 服务）
- MinIO `minioadmin` / `minioadmin`
- `SCHEDULER_AUTH` 共享密钥
- `S3_PUBLIC_URL` / `S3_PUBLIC_ENDPOINT`：浏览器访问 S3 对象时使用的地址，
  生成预签名 URL 时签名按此 host 计算，必须与浏览器实际访问的地址一致

## 常用命令

```sh
docker compose ps                  # 查看状态
docker compose logs -f web         # 跟踪 Web 日志
docker compose restart web         # 重启某个服务
docker compose down                # 停止并删除容器（数据卷保留）
docker compose down -v             # 连同数据卷一起删除（清空所有数据）
```

## 数据持久化

数据保存在命名卷中：

- `postgres-data`：数据库
- `redis-data`：Redis 持久化文件
- `minio-data`：对象存储（题目、提交、图片等）

## 常见问题

**访问 `localhost:5080` 返回 403？**
若使用 macOS，5000 端口被系统 AirPlay 接收器占用；本部署已改用 `5080`。
若仍冲突，可在 `docker-compose.yml` 中修改 `web` 服务的端口映射。

**通过 VS Code / Cursor 远程连接时打不开？**
需要在编辑器的 PORTS 面板中手动转发 `5080` 端口。

**Web 起来了但图片 / 文件打不开？**
检查 `S3_PUBLIC_ENDPOINT` 是否与浏览器实际访问 MinIO 的地址一致，
否则 S3 预签名 URL 的签名校验会失败。
