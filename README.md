# NBA 看台 · 关注球员实时数据

一个 NBA 实时数据看板：按比赛日浏览赛程，关注球员，实时跟踪他们在场上的表现，并自动标记「打疯了」的热手球员。

![tech](https://img.shields.io/badge/stack-HTML%20%2B%20CSS%20%2B%20Vanilla%20JS%20%2B%20Node-orange)

## 功能

- **按日期看赛程** — 以美东赛程日切换前后比赛日，展示当日全部比赛与比分
- **关注球员** — 搜索球员并加入关注列表，跨场次汇总自己关心的球员数据
- **实时刷新** — 每 20 秒自动拉取最新比分与球员数据，比赛中自动保持高频刷新
- **热手提醒** — 上场满 10 分钟且满足任意 2 项硬指标时触发提醒：
  - 20+ 分 / 8+ 篮板 / 6+ 助攻 / 3+ 抢断盖帽
  - 真实命中率 ≥ 60%（至少 8 次出手）
  - 正负值 ≥ +10
  - 两双 / 三双
- **中文界面** — 球队、位置、缺阵原因等字段均已做中文映射
- **账号与云同步** — 登录即注册，关注名单与提醒设置可跨设备同步；未登录时自动退回本地模式
- **本地持久化** — 未登录状态下的数据保存在 localStorage，刷新不丢

## 技术说明

前端零构建、零依赖。数据来自 ESPN 公开接口，由 Node 服务端代理转发：浏览器只请求同源的 `/api/espn/*`，避免 CORS 限制，同时便于在代理层统一处理压缩与缓存。

| 用途 | 接口 |
| --- | --- |
| 当日比分板 | `site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard` |
| 单场技术统计 | `site.api.espn.com/apis/site/v2/sports/basketball/nba/summary` |
| 球员搜索 | `site.web.api.espn.com/apis/common/v3/search` |
| 球员比赛日志 | `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/gamelog` |

球队 logo 与球员头像来自 `a.espncdn.com`。

## 目录结构

```
.
├── index.html    # 页面骨架与内联 SVG 图标
├── styles.css    # 深色主题样式
├── app.js        # 全部业务逻辑：接口请求、状态管理、渲染、热手规则、账号
├── server.js     # 静态服务 + ESPN 代理 + 账号与会话（无第三方依赖）
└── package.json  # 仅声明启动入口，无依赖
```

## 本地运行

```bash
node server.js
# 打开 http://localhost:5590
```

端口可通过环境变量覆盖：

```bash
PORT=8080 node server.js
```

服务端会在启动时自动创建 `data/` 目录，用于存放账号（`users.json`）、会话（`sessions.json`）与各用户的关注名单（`user-data/`）。该目录已被 `.gitignore` 忽略。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth` | 登录，账号不存在则自动注册 |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/me` | 当前登录用户 |
| GET / PUT | `/api/data` | 读取 / 写入云端关注名单与设置 |
| GET | `/api/espn/site/*` | 代理 `site.api.espn.com` |
| GET | `/api/espn/web/*` | 代理 `site.web.api.espn.com` |

## 部署注意事项

**服务端必须监听 `PORT` 环境变量并绑定 `0.0.0.0`**，否则无法在容器化/反代环境中被访问。

代理层做了两件必须保留的事：

1. **向 ESPN 申请并透传 gzip**。单场技术统计未压缩约 490 KB，gzip 后仅约 46 KB。在出口带宽受限的部署环境里，不开压缩会让单次请求耗时超过 10 秒，前端会因超时中断，页面停在「技术统计同步中」。
2. **15 秒 TTL 短缓存**。同一场比赛在多端/自动刷新间复用，避免重复回溯 ESPN。

鉴权支持多通道，因为部分部署网关会丢弃 `Authorization` 请求头：`Authorization: Bearer`、`X-Auth-Token`、`nba_token` Cookie、`?token=` 查询参数四者等价。

## 免责声明

本项目仅用于个人学习与技术演示，数据版权归 ESPN 及各联赛官方所有，与 NBA 官方无关联。
