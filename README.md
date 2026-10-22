# NBA 看台 · 关注球员实时数据

一个纯前端的 NBA 实时数据看板：按比赛日浏览赛程，关注球员，实时跟踪他们在场上的表现，并自动标记「打疯了」的热手球员。

![tech](https://img.shields.io/badge/stack-HTML%20%2B%20CSS%20%2B%20Vanilla%20JS-orange)

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
- **本地持久化** — 关注列表与提醒设置保存在 localStorage，刷新不丢

## 技术说明

零构建、零依赖。数据全部来自 ESPN 公开接口，浏览器直接发起请求：

| 用途 | 接口 |
| --- | --- |
| 当日比分板 | `site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard` |
| 单场技术统计 | `site.api.espn.com/apis/site/v2/sports/basketball/nba/summary` |
| 球员搜索 | `site.web.api.espn.com/apis/common/v3/search` |
| 球员比赛日志 | `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/gamelog` |

球队 logo 与球员头像来自 `a.espncdn.com`。

## 本地运行

方式一：直接双击 `index.html`。

方式二：起一个本地静态服务器（推荐，避免个别浏览器对 `file://` 的限制）：

```bash
node server.js
# 打开 http://localhost:5590
```

`server.js` 是一个 50 行的 Node 原生静态文件服务器，不依赖任何 npm 包。端口可通过环境变量覆盖：

```bash
PORT=8080 node server.js
```

## 目录结构

```
.
├── index.html    # 页面骨架与内联 SVG 图标
├── styles.css    # 深色主题样式
├── app.js        # 全部业务逻辑：接口请求、状态管理、渲染、热手规则
└── server.js     # 本地静态服务器
```

## 免责声明

本项目仅用于个人学习与技术演示，数据版权归 ESPN 及各联赛官方所有，与 NBA 官方无关联。
