# Price Alert - 加密货币价格监控告警系统

🔔 实时监控加密货币价格，触发条件时自动通过 Telegram 发送通知

## 功能特性

- 📊 **多用户支持** - 支持多个用户，每个用户数据隔离
- 🔔 **灵活告警条件** - 支持上穿、下穿、价格大于/小于、涨跌幅等多种条件
- ⏱️ **秒级轮询** - 1-3600 秒可选轮询间隔
- 🔁 **重复提醒** - 触发后可发送多次通知（每次间隔 3 秒）
- 🔒 **安全认证** - 密码保护，支持修改密码
- 👥 **管理员功能** - 管理员可创建/管理用户
- 📖 **完整 UI** - 友好的 Web 界面

## 快速开始

### 下载安装
```bash
# 克隆项目
git clone https://github.com/Onpicex/Crypto-price-alert.git
```

### 安装依赖

```bash
# 进入项目目录
cd Crypto-price-alert

# 安装依赖
npm install express axios cors
```

### 启动服务

```bash
node server.cjs
```

服务默认运行在 `http://0.0.0.0:3847`

### 首次登录

- 用户名：`admin`
- 密码：`admin123`

## Telegram Bot 配置

### 1. 创建 Bot

1. 在 Telegram 搜索 `@BotFather`
2. 发送 `/newbot`
3. 按照提示设置名称和用户名
4. 获取 Bot Token

### 2. 获取 Chat ID

- **私聊**：搜索 `@userinfobot` 获取你的用户 ID
- **群组**：把 Bot 加入群组，获取群组 ID

### 3. 在系统设置中配置

登录后进入"系统设置"页面，填写 Bot Token 和 Chat ID

## API 接口

### 认证

```
POST /api/login
Body: { "username": "xxx", "password": "xxx" }
```

### 用户管理（仅管理员）

```
GET    /api/admin/users      # 获取用户列表
POST   /api/admin/users     # 创建用户
DELETE /api/admin/users/:id # 删除用户
```

### 告警规则

```
GET    /api/alerts          # 获取规则列表
POST   /api/alerts          # 创建规则
PUT    /api/alerts/:id      # 更新规则
PATCH  /api/alerts/:id      # 启用/禁用
DELETE /api/alerts/:id      # 删除规则
```

### 规则参数

| 参数 | 说明 |
|------|------|
| symbol | 交易对，如 BTCUSDT |
| condition_type | 条件类型：cross_up, cross_down, price_gte, price_lte, pct_change_up, pct_change_down |
| threshold | 阈值 |
| poll_interval_sec | 轮询间隔（秒） |
| cooldown_sec | 冷却时间（秒） |
| notify_times | 提醒次数（1-10） |
| is_enabled | 是否启用 |

### 其他接口

```
GET  /api/settings          # 获取设置
PUT  /api/settings          # 保存设置
POST /api/settings/telegram/test # 测试 Telegram
GET  /api/events           # 获取触发日志
GET /api/price/:symbol     # 获取价格
```

## 配置说明

### 创建用户

管理员登录后，在"用户管理"页面创建新用户。

### 创建监控规则

1. 点击"监控规则"
2. 填写交易对、条件、阈值等参数
3. 点击"创建规则"

## 技术栈

- **后端**：Node.js + Express
- **存储**：JSON 文件（轻量级，无需数据库）
- **价格源**：Binance API

## 目录结构

```
price-alert/
├── server.cjs          # 主程序入口
├── public/
│   └── index.html      # Web UI
├── lib/
│   ├── api.cjs         # API 处理
│   ├── db.cjs          # 数据存储
│   ├── monitor-engine.cjs # 监控引擎
│   ├── notify-worker.cjs  # 通知队列
│   ├── password.cjs    # 密码加密
│   └── price-source.cjs  # 价格获取
└── state/
    └── price-alert.json # 数据文件
```

## 开源协议

MIT License
