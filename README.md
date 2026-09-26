# Domain Watch（域名监控独立网站）

一个自托管的域名监控服务：**RDAP / WHOIS 域名查询**、**到期提醒**、**过期抢注提醒**，通过 Telegram Bot API 推送通知。

只依赖 Node.js 内置 HTTP 服务，不使用数据库和 Web 框架，一个容器即可运行。

## 功能

- RDAP / WHOIS 域名查询：先查 IANA 引导文件定位 RDAP 服务，没有可用 RDAP 的后缀自动回退到 WHOIS
- 到期提醒：每日定时检查，提醒窗口内每天最多提醒一次
- 过期抢注提醒：域名进入删除期后提醒一次，可续费赎回或关注抢注
- Telegram 通知：Token 与 Chat ID 使用 AES-256-GCM 加密保存，页面和接口都不回显明文
- 单用户账号：首次启动生成随机密码并打印到日志，scrypt 哈希存储，HttpOnly 会话 Cookie
- 默认全站私有：除登录页和健康检查外，所有页面与接口都需登录；需要公开查询页时可显式开启
- 面板热修改：监控域名、提醒天数、检查时间等在设置页保存后立即生效，无需重启
- RDAP 映射可自定义：指定某些域名后缀去哪个 RDAP 服务器查，支持设置页面与外部 JSON 文件两层配置
- 提醒去重：状态持久化到 `reminders.json`，重启不重复发送
- 免构建部署：GitHub Actions 按版本标签发布多架构镜像，用户直接 `docker pull`

## 快速开始

仓库地址：<https://github.com/cnprobe/Domain-Watch>
镜像地址：`ghcr.io/cnprobe/domain-watch`

### 方式一：直接用已发布镜像（推荐，无需构建）

```sh
docker pull ghcr.io/cnprobe/domain-watch:latest
```

准备配置：

```sh
mkdir -p ~/domain-watch && cd ~/domain-watch
```

创建 `~/domain-watch/.env`：

```env
DOMAINS=example.com,example.org
CHECK_TIME=09:00
TZ=Asia/Shanghai
```

启动：

```sh
docker run -d \
  --name domain-watch \
  --env-file ~/domain-watch/.env \
  -p 3000:3000 \
  -v domain-watch-data:/app/data \
  ghcr.io/cnprobe/domain-watch:latest
```

首次启动会生成管理员密码，**只打印一次**：

```sh
docker logs domain-watch
```

用 Compose：

```sh
export DOMAIN_WATCH_IMAGE=ghcr.io/cnprobe/domain-watch:latest
docker compose -f docker-compose.ghcr.yml up -d
```

`docker-compose.ghcr.yml` 只拉取镜像，不会在本地执行 `docker build`。

> 镜像名跟随 GitHub 仓库名（`cnprobe/Domain-Watch` → `ghcr.io/cnprobe/domain-watch`）。
> 若 GHCR 包为私有，先登录：
> `echo "$TOKEN" | docker login ghcr.io -u cnprobe --password-stdin`（Token 需要 `read:packages`）。
> 希望所有人免登录拉取，需在 GitHub Package Settings 中把包设为 Public。
>
> 仓库改名前发布的镜像名为 `ghcr.io/cnprobe/komari-plugin-domain-watch`，已不再更新，请改用新镜像名。

### 方式二：本地构建 Docker 镜像

```sh
git clone https://github.com/cnprobe/Domain-Watch.git
cd Domain-Watch
cp .env.example .env
vim .env                   # 至少设置 DOMAINS
docker compose up -d --build
docker compose logs domain-watch
```

### 方式三：不用 Docker，直接用 Node.js 运行

需要 Node.js 20+。

```sh
npm ci
npm run typecheck          # 可选
npm run website:build      # 打包到 website/dist/server.cjs
npm run website:start      # 读取根目录 .env 并启动
```

本地数据默认写在 `./data`。改代码后用 `npm run website:dev`（重新打包并启动）。

## 页面

| 路径 | 说明 | 访问控制 |
| --- | --- | --- |
| `/` | 域名查询页 | 需登录 |
| `/login` | 管理员登录 | 公开 |
| `/monitor` | 监控面板 | 需登录 |
| `/settings` | 账号与 Telegram 设置 | 需登录 |
| `/healthz` | 健康检查 | 公开 |

**默认全站私有**：除 `/login` 和 `/healthz` 外，所有页面和接口都必须登录后才能访问，未登录访问 `/` 会跳转到 `/login?next=/`，登录成功后自动跳回原页面。

如果确实需要一个公开的查询页，把 `.env` 中的 `PUBLIC_QUERY` 设为 `true` 即可，此时 `/` 和 `/api/whois` 免登录可访问，其余页面仍然需要登录。生产环境建议保持默认的 `false`，避免查询接口被外部滥用（每次查询都会请求第三方 RDAP / WHOIS 服务）。

查询页右上角有「监控面板」和「管理员」按钮，登录后「管理员」自动变为「设置」。

监控面板顶部可以直接添加域名，列表每行有「移除」按钮，增删即时生效并有右上角结果弹窗；也可以在设置页的「监控设置」里一次性编辑整个列表。

监控列表还有**续费价格**、**商家**、**商家网站**三列，用「编辑」按钮填写。这三项注册局（RDAP / WHOIS）都不提供，只能自己记录：商家留空时会自动显示查询到的注册商名。域名从监控列表移除时，对应备注会一并清掉。

设置页包含三块：监控设置、查询设置（RDAP 映射）、Telegram 通知，外加账号安全。所有保存操作都有右上角结果弹窗，成功显示绿框、失败显示红框并带具体原因。

## 环境变量

完整列表见 [`.env.example`](.env.example)。

下面这些**监控参数可以直接在 `/settings` 页面改，保存后立即生效，不用重启容器**：

| 参数 | 说明 |
| --- | --- |
| `DOMAINS` | 监控域名，支持逗号、空格或换行分隔 |
| `REMIND_DAYS` | 提前提醒天数，超出 0-365 会自动夹紧 |
| `CHECK_TIME` | 每日检查时间 `HH:mm`；改成当前分钟，下一次轮询就会立刻检查一次 |
| `DAILY_REMIND` | 提醒窗口内是否每天提醒一次 |
| `BACKORDER_NOTIFY` | 过期后是否发送抢注提醒 |
| `RUN_ON_STARTUP` | 容器启动时检查一次（**仅下次启动生效**） |

配置优先级：**设置面板保存的值 > `.env`**。首次启动使用 `.env` 的值；一旦在面板保存过，就以面板为准，启动日志和监控页都会显示当前来源。想改回 `.env`，在设置页点「恢复为 .env 配置」。

其余变量必须重启容器才生效：

| 参数 | 原因 |
| --- | --- |
| `PORT` `HOST` | 监听参数在启动时确定 |
| `TZ` | 影响「今天」的判定和检查时间，热改会导致提醒去重错乱 |
| `PUBLIC_QUERY` `COOKIE_SECURE` | 决定路由鉴权和 Cookie 属性 |
| `ADMIN_USERNAME` `SESSION_TTL_DAYS` | 账号初始化与会话签发 |
| `CONFIG_ENCRYPTION_KEY` | 更换密钥会导致已保存的 Telegram 配置无法解密 |
| `DATA_DIR` | 存储位置 |

### HTTP 与账号

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口。Docker 端口映射需与之一致；镜像内置 `HEALTHCHECK` 会自动跟随 |
| `HOST` | `0.0.0.0` | 监听地址，容器内保持 `0.0.0.0` |
| `TZ` | 系统时区 | 影响 `CHECK_TIME` 与「今日是否已提醒」，例如 `Asia/Shanghai` |
| `DATA_DIR` | `./data` | 数据目录。Compose 中固定为 `/app/data` |
| `ADMIN_USERNAME` | `admin` | 首次启动创建的用户名，之后以设置页保存值为准 |
| `SESSION_TTL_DAYS` | `7` | 会话有效期，1-30 天 |
| `COOKIE_SECURE` | `false` | HTTPS 反向代理时设为 `true`；请求带 `X-Forwarded-Proto: https` 时也会自动启用 |
| `PUBLIC_QUERY` | `false` | 设为 `true` 时才允许未登录访问 `/` 和 `/api/whois`；默认全站需登录 |
| `RESET_ADMIN_PASSWORD` | `false` | 临时设为 `true` 重启一次可重置密码并打印新密码 |
| `CONFIG_ENCRYPTION_KEY` | 空 | Telegram 配置加密密钥，留空自动生成 `data/config.key` |
| `ADMIN_TOKEN` | 空 | 已弃用的 API 兼容令牌（`Authorization: Bearer`），正常留空 |
| `PUBLIC_FILE` | `admin.html` | 查询页文件路径 |
| `MONITOR_PAGE_FILE` | `website/monitor.html` | 监控页文件路径 |
| `LOGIN_PAGE_FILE` | `website/login.html` | 登录页文件路径 |
| `SETTINGS_PAGE_FILE` | `website/settings.html` | 设置页文件路径 |

页面文件路径默认相对当前工作目录解析：容器内为 `/app`，本地运行为仓库根目录。

### 登录防护（防暴力破解）

`POST /api/auth/login` 是唯一无需登录的写入口，因此同时按**来源 IP** 和**账号**两层累计失败次数：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOGIN_IP_MAX_FAILURES` | `5` | 同一来源 IP 在窗口内允许的失败次数 |
| `LOGIN_IP_WINDOW_MINUTES` | `15` | IP 级统计窗口（分钟） |
| `LOGIN_ACCOUNT_MAX_FAILURES` | `10` | 同一账号在窗口内允许的失败次数，**跨所有来源 IP 累计** |
| `LOGIN_ACCOUNT_WINDOW_MINUTES` | `30` | 账号级统计窗口（分钟），应明显长于 IP 级 |
| `TRUST_PROXY` | `false` | 仅当服务确实在你自己的反向代理后面时设为 `true` |

要点：

- **账号级是抵御分布式字典攻击的关键**。只按 IP 限制时，攻击者轮换 IP（或 IPv6 地址）即可无限次尝试；两层同时生效才能堵住。
- **`TRUST_PROXY` 默认为 `false`，此时 `X-Forwarded-For` 被忽略**。若无条件信任该请求头，攻击者每次换一个伪造 IP 就能完全绕过 IP 级限制。放在 nginx / Caddy 后面时需要显式开启，具体做法见下节。
- 触发上限后返回 `429` 与 `Retry-After`，响应体不区分是 IP 还是账号被锁，避免被反过来探测。
- 用户名不存在时也会执行一次口令散列，两种失败的响应时间一致，无法用来枚举用户名。
- 计数只保存在内存，容器重启即清零；这样即使误锁也不会把管理员永久挡在门外。登录成功会同时清零两层计数。
- 每层最多跟踪 512 个键，被随机用户名/地址灌入时会淘汰最久未使用的记录，不会无限增长。

#### 放在反向代理后面时必须做什么

容器本身只提供 HTTP。要公网访问通常要自己套一层 nginx / Caddy / Cloudflare Tunnel，这时有**两件事必须做，缺一不可**。

**第一步：开启 `TRUST_PROXY=true`**

不开的话，应用看到的所有请求都来自代理自己的容器地址，于是**所有人共用一个失败计数**——任何人输错 5 次密码，你自己的正确密码也会被 429 挡在门外。

```yaml
services:
  domain-watch:
    image: ghcr.io/cnprobe/domain-watch:latest
    environment:
      TRUST_PROXY: "true"        # 让应用按 X-Forwarded-For 识别真实来源
      COOKIE_SECURE: "true"      # 走 HTTPS 后会话 Cookie 才有 Secure 标记
    ports:
      - "127.0.0.1:3000:3000"    # 只监听回环地址，公网流量一律走代理
```

**第二步：让代理把真实来源写进 `X-Forwarded-For`**

应用读取该头链的**最后一段**（最靠近客户端的那一跳），所以代理用「覆盖」还是「追加」写法都能得到正确地址。

nginx（推荐覆盖写法，最直观）：

```nginx
server {
    listen 443 ssl http2;
    server_name watch.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        # 覆盖而非追加：客户端伪造的同名头会被这里冲掉
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

nginx（沿用默认追加写法也可以）：

```nginx
        # $proxy_add_x_forwarded_for 是追加语义，但应用只取最后一段，
        # 最后一段仍是 $remote_addr，结果与覆盖写法一致
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
```

Caddy 不用额外配置，反代会自动带上正确的 `X-Forwarded-For`：

```
watch.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**自查清单**

| 检查项 | 期望结果 |
| --- | --- |
| `docker exec <容器> printenv TRUST_PROXY` | `TRUST_PROXY=true` |
| 用另一台机器故意输错 5 次密码，再用正确密码登录 | 仍能登录，说明按真实 IP 计数 |
| 故意输错 5 次后等 15 分钟 | 恢复可登录 |
| `curl -I https://watch.example.com/healthz` | `200`，容器日志无异常 |
| 浏览器登录 | 正常跳转 `/monitor` |

**常见问题**

- **所有人输错几次就一起被锁**：`TRUST_PROXY` 没开，或代理没把 `X-Forwarded-For` 传过来。抓包确认该头存在再排查。
- **锁了之后自己也进不去**：等窗口过期（IP 级 15 分钟、账号级 30 分钟），或重启容器——计数只在内存。或用 `RESET_ADMIN_PASSWORD=true` 重置密码。
- **日志出现「登录被临时锁定（账号级）」**：同一账号从多个来源累计失败过多，通常是真的有人在猜密码，建议同时把密码改到 16 位以上。
- **前面还套了 Cloudflare**：把 `CF-Connecting-IP` 写进 `X-Forwarded-For` 再开 `TRUST_PROXY`，例如 `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`。

### 监控

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOMAINS` | 空 | 监控域名，逗号/分号/空白分隔。留空仍可查询，但不发提醒 |
| `REMIND_DAYS` | `30` | 距到期 ≤ 该天数时提醒，范围 0-365 |
| `DAILY_REMIND` | `true` | 提醒窗口内每天提醒一次 |
| `BACKORDER_NOTIFY` | `true` | 过期后发送一次抢注/赎回提醒 |
| `CHECK_TIME` | `09:00` | 每日检查时间，24 小时制 `HH:mm`（使用 `TZ` 本地时间） |
| `RUN_ON_STARTUP` | `false` | 启动时立即检查一次 |

### Telegram

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 空 | BotFather 提供的 Token。仅在 `settings.json` 不存在时导入一次 |
| `TELEGRAM_CHAT_ID` | 空 | 聊天/用户/频道 ID，也可用 `@channelusername` |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 自建 Bot API Server 时修改 |

## Telegram 配置

1. 在 [@BotFather](https://t.me/BotFather) 创建 Bot，拿到 Token。
2. 给 Bot 发一条消息，访问 `https://api.telegram.org/bot<TOKEN>/getUpdates`，取 `message.chat.id`。
3. 登录后打开 `/settings`，填入 Token 和 Chat ID，输入当前密码保存。
4. 在 `/monitor` 点击「测试 Telegram」验证。

Token 和 Chat ID 保存后即加密，接口只返回掩码（如 `****9999`）。修改请直接在设置页操作——`.env` 里的值不会覆盖已保存的配置。

## 查询设置（RDAP 映射）

默认情况下，后缀 → RDAP 服务器的对应关系来自 IANA 引导文件（`dns.json`，72 小时刷新一次）。有些后缀没被收录，或某个后缀的 RDAP 地址不可用，可以在设置页的「查询设置」里自行指定。

映射按**后缀从长到短**匹配，`co.uk` 会优先于 `uk`；把某个后缀设为**空数组**表示禁用它的 RDAP、强制回退 WHOIS 查询。

### 方式一：设置页面（热更新，保存即生效）

在 `/settings` →「查询设置（RDAP 映射）」里直接编辑 JSON，键是域名后缀，值是该后缀的 RDAP 服务器地址数组：

```json
{
  "cn": ["https://rdap.example.cn/rdap/"],
  "jp": [],
  "co.uk": ["https://rdap.nominet.uk/"]
}
```

- **空数组表示禁用该后缀的 RDAP**，查询时回退 WHOIS（例如上面的 `jp`）
- **一个后缀可以配多个地址**，按数组顺序依次尝试，适合主地址不可用时留备用
- 后缀不区分大小写，保存时统一转小写并去掉前导点（`.CO.UK` → `co.uk`）；支持多级后缀（`co.uk`、`com.cn`）
- IANA 引导文件未收录的后缀（`.cn`/`.jp` 等）直接写在这里即可
- 想参考完整的后缀列表，可调用 `GET /api/settings/rdap/tlds`（IANA 全量 TLD，约 1400 条）
- 文本框留空 = 清空面板层配置
- 只要有**一个**后缀或地址不合法，整份配置就会被拒绝（`invalid_rdap_overrides`）并指出是哪一项，已有配置保持不变

保存后立即生效；「从文件重新载入」可立即读取外部文件，「清空面板配置」只清面板层。JSON 语法错误会提示出错位置且不会发出请求。

### 方式二：外部 JSON 文件（适合挂载进容器）

设置环境变量 `RDAP_OVERRIDES_FILE` 指向一个 JSON 文件，并用 compose 挂载进来：

```yaml
services:
  domain-watch:
    image: ghcr.io/cnprobe/domain-watch:latest
    environment:
      RDAP_OVERRIDES_FILE: /config/rdap-overrides.json
    volumes:
      - ./rdap-overrides.json:/config/rdap-overrides.json:ro
      - domain-watch-data:/app/data
```

文件内容（`tlds` 可省略，直接写映射也可以）：

```json
{
  "tlds": {
    "cn": ["https://rdap.example.cn/rdap/"],
    "jp": []
  }
}
```

应用对文件只读，**文件内容变化后最多 30 秒自动生效**，无需重启容器；JSON 格式或内容有误时会沿用上一份可用配置，并在日志和设置页提示错误。

### 两层优先级

| 层 | 来源 | 说明 |
| --- | --- | --- |
| 文件层 | `RDAP_OVERRIDES_FILE` | 适合做「运维强制配置」，同名后缀**优先于面板** |
| 面板层 | 设置页面 | 保存在数据卷 `settings.json`，重启后仍生效 |

设置页会同时显示两层的条数、生效条数与文件路径。启动日志也会打印加载结果。

### 相关接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/settings/rdap` | 读取面板层、文件层、合并结果与文件状态 |
| `PUT /api/settings/rdap` | 保存面板层映射（`{"tlds":{...}}`），立即生效；`{"reset":true}` 清空面板层 |
| `POST /api/settings/rdap` | 立即从外部文件重新载入（不等 30 秒） |

错误码 `invalid_rdap_overrides` 表示后缀或地址格式不合法（例如 `cn!@#`、`ftp://...`），错误信息里会逐条列出。

## 提醒逻辑

程序每 30 秒比对一次当前时间，到 `CHECK_TIME` 就执行检查：

1. 读取 `DOMAINS`，逐个查询 RDAP / WHOIS。
2. 计算剩余天数，`≤ REMIND_DAYS` 且 `DAILY_REMIND=true` 时发送到期提醒。
3. 已过期且 `BACKORDER_NOTIFY=true` 时发送一次抢注提醒。
4. 发送成功后写入 `reminders.json`，同一天或同一到期日不重复发送。
5. **只有落在提醒窗口内的域名才会发消息**。`example.com` 还剩 300 多天、窗口是 30 天时，定时任务照常执行但不会推送——这是正常行为。每次检查都会在日志里留下一行结论，便于确认：

```
[domain-watch] 每日定时检查完成：检查 1 个，提醒 0 个，跳过 1 个，
跳过原因：example.com：剩余 321 天，未到提醒窗口（提醒窗口 30 天内才通知，窗口外的域名不会发消息）
```

想验证整条通知链路，可以把「提前提醒天数」临时调到大于剩余天数（例如 365），或用 `POST /api/check?simulate=expired` 模拟过期；`POST /api/test-notify` 则直接发一条测试通知。
5. 到期日变化时自动重置该域名的去重状态。

定时器运行在进程内，只应运行**一个实例**；多副本会重复检查。

## 数据与备份

数据保存在 `DATA_DIR`（容器内 `/app/data`，Compose 卷 `domain-watch-data`）：

| 文件 | 作用 |
| --- | --- |
| `settings.json` | 用户名、密码哈希、会话密钥、加密后的 Telegram 配置、域名备注（价格/商家）（600） |
| `config.key` | 自动生成的 AES-256-GCM 密钥（600） |
| `rdap-bootstrap.json` | IANA RDAP 引导缓存，72 小时刷新 |
| `tlds.txt` | IANA 全量 TLD 列表缓存，供 `GET /api/settings/rdap/tlds` 使用 |
| `reminders.json` | 每个域名的到期日与提醒时间，用于去重 |

备份与恢复：

```sh
docker run --rm \
  -v domain-watch-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/domain-watch-backup.tar.gz -C /data .
```

`config.key`（或 `CONFIG_ENCRYPTION_KEY`）必须一起备份，否则已保存的 Telegram 配置无法解密。

## HTTP 接口

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 公开 | 健康检查 |
| `GET /api/whois?domain=` | 需登录（`PUBLIC_QUERY=true` 时公开） | 域名查询，兼容 `GET /api/plugin/whois` |
| `POST /api/auth/login` | 公开 | 登录，成功后下发 `dw_session` Cookie |
| `POST /api/auth/logout` | 登录 | 退出登录 |
| `GET /api/auth/me` | 登录 | 当前账号信息 |
| `POST /api/auth/change-credentials` | 登录 | 修改用户名和密码，**需当前密码**（改的是登录凭据本身）；省略的字段保持原值，传入 `confirmPassword` 时会校验两次是否一致，成功后当前会话失效 |
| `GET /api/settings` | 登录 | 读取设置（不回显 Token），含 `monitorConfig`（面板可编辑的监控参数）和 `monitor`（当前生效值） |
| `PUT /api/settings/monitor` | 登录 | 保存监控参数，**保存后立即生效**；未提供的字段沿用当前值，可只改其中一项；传 `{"reset":true}` 恢复为 `.env` 中的值 |
| `GET /api/settings/rdap` | 登录 | 读取 RDAP 映射配置（面板层 / 文件层 / 合并结果） |
| `GET /api/settings/rdap/tlds` | 登录 | 读取后缀候选列表（IANA 全量 TLD，便于脚本或自行编辑映射时参考） |
| `PUT /api/settings/rdap` | 登录 | 保存 RDAP 映射，立即生效；`{"reset":true}` 清空面板层 |
| `POST /api/settings/rdap` | 登录 | 立即从外部文件重新载入 |
| `PUT /api/settings/telegram` | 登录 | 保存 Telegram 配置 |
| `GET /api/monitor` | 登录 | 实时查询全部监控域名并返回汇总，不发通知；每项含 `price` / `vendor` / `vendorUrl` / `registrarName` |
| `POST /api/settings/reminders/clear` | 登录 | 清除提醒记录，同时重置「今日已提醒」与「已发过抢注提醒」两个标记，让两类通知都能再发一次；传 `{"domain":"a.com"}` 只清单个域名，不传则清全部 |
| `PUT /api/settings/domain-meta` | 登录 | 保存域名备注：`{"set":{"example.com":{"price":"¥85/年","vendor":"Cloudflare","vendorUrl":"dash.cloudflare.com"}}}`；值为 `null` 或传 `remove` 即删除 |
| `PUT /api/settings/monitor/domains` | 登录 | 增删监控域名：`{"add":"a.com,b.com"}` / `{"remove":"a.com"}`，可同时传；自动去重并清理被移除域名的提醒记录 |
| `GET /api/status` | 登录 | 监控参数与 Telegram 是否已配置 |
| `POST /api/test-notify` | 登录 | 发送测试通知 |
| `POST /api/check` | 登录 | 立即检查；`?simulate=expired` 可测试抢注分支 |

登录接口限流：同一 IP 15 分钟内失败 5 次后返回 `429`。带会话的写操作会校验 `Origin` 同源，不一致返回 `403 csrf_rejected`。

保存设置（监控参数、Telegram）只需登录会话，不再重复要求输入当前密码；只有修改登录凭据时才需要。

### `GET /api/whois` 响应字段

`RDAP` 查询成功时 `source` 为 `rdap`，回退到 WHOIS 时为 `whois`；字段按来源尽力填充，缺失即为 `null` 或空数组。

| 字段 | 说明 |
| --- | --- |
| `domain` / `asciiDomain` | 原始输入与 punycode 形式（IDN 会同时给出） |
| `tld` | 域名后缀 |
| `source` | 数据来源：`rdap` 或 `whois` |
| `rdapServer` / `whoisServer` | 实际使用的服务器，与 `source` 对应，另一个为 `null` |
| `ldhName` / `unicodeName` | 注册局或 WHOIS 返回的原始名称 |
| `registration` / `expiration` / `lastChanged` | 注册、到期、最后变更时间 |
| `registrar` | 注册商对象，含 `handle` 与 `name` |
| `nameservers` / `status` | 名称服务器列表与域名状态 |
| `dnssec` | DNSSEC 状态，含 `delegationSigned` 与 `dsData` |
| `events` | 事件表（键名沿用数据源原文，如 `last changed`） |

时间字段在 RDAP 来源下是完整的 ISO 8601；回退到 WHOIS 时取决于注册局返回的文本，可能只有时间或日期片段。**到期提醒与抢注判断以 `expiration` 为准**，解析不出该字段时不会误发提醒。

### 错误码

失败响应统一为 `{"ok": false, "error": {"code", "message"}}`，`code` 为 snake_case：

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `unauthorized` | 401 | 未登录或会话失效 |
| `invalid_credentials` | 401 / 403 | 用户名或密码错误 |
| `invalid_username` | 400 | 用户名格式不合法 |
| `invalid_password` | 400 | 密码长度不在 12-256 之间 |
| `invalid_telegram_settings` | 400 | Telegram Token 或 Chat ID 为空 |
| `invalid_json` | 400 | 请求体不是合法 JSON |
| `payload_too_large` | 413 | 请求体超过 1 MB |
| `csrf_rejected` | 403 | 写操作来源不同源 |
| `too_many_attempts` | 429 | 登录失败次数过多（IP 级或账号级触发，见「登录防护」），带 `Retry-After` 头 |
| `telegram_not_configured` | 400 | 未配置 Telegram |
| `telegram_error` | 502 | Telegram API 返回失败 |
| `telegram_network_error` | 502 | 无法连接 Telegram |
| `telegram_timeout` | 504 | Telegram 请求超过 15 秒 |
| `page_unavailable` | 500 | 页面文件缺失或不可读 |
| `settings_corrupted` / `settings_unreadable` | 500 | 设置文件损坏或读取失败 |
| `invalid_config_key` | 500 | 加密密钥缺失或不匹配 |
| `telegram_decrypt_failed` | 500 | 无法解密 Telegram 配置 |
| `invalid_data_dir` | 500 | `DATA_DIR` 未配置 |
| `not_found` | 404 | 页面或接口不存在 |
| `invalid_domain` / `invalid_argument` | 400 | 域名参数为空或非法 |
| `invalid_domains` | 400 | 监控域名内容为空、格式错误或超过 4000 字符 |
| `invalid_domain_meta` | 400 | 域名备注不合法：域名格式、价格/商家超长、商家网站不是 http(s) 地址或数量超限 |
| `no_domain_change` | 400 | 要添加的域名已存在，或要移除的域名不在列表中 |
| `invalid_check_time` | 400 | 检查时间不是 `HH:mm` 格式 |
| `invalid_rdap_overrides` | 400 | RDAP 映射的后缀或地址格式不合法 |
| `rdap_file_not_configured` | 400 | 未设置 `RDAP_OVERRIDES_FILE`，无法从文件载入 |
| `invalid_telegram_api_base` | 400 | Telegram API 地址格式错误（缺协议、含空格/账号密码/查询参数、主机名不完整、粘贴错位） |
| `invalid_remind_days` | 400 | 提前提醒天数不是 0-365 之间的数字 |
| `rate_limited` | 429 | 上游 WHOIS 服务限流 |
| `timeout` / `network_error` / `http_error` / `parse_error` | 502 | 上游查询失败 |
| `bootstrap_error` | 502 | IANA 引导文件加载失败 |
| `insufficient_credits` | 502 | 上游 WHOIS 服务余额不足 |

`POST /api/check` 会在 `failed[]`（可读字符串）和 `failedCodes[]`（错误码数组）中列出每个失败域名。

## 项目结构

```text
.
├── admin.html                # 查询页（网站首页）
├── src/
│   └── domain-core.ts        # RDAP / WHOIS 查询核心（TypeScript）
├── website/
│   ├── server.mjs            # HTTP 服务入口、路由、鉴权
│   ├── auth.mjs              # 单用户账号、会话、加密存储
│   ├── monitor.mjs           # 定时检查、提醒去重、Telegram 发送
│   ├── domain-watch.mjs      # 查询核心适配器
│   ├── login.html            # 登录页
│   ├── monitor.html          # 监控面板
│   └── settings.html         # 设置页
├── .env.example              # 环境变量模板
├── Dockerfile                # 多阶段构建，构建上下文 = 仓库根
├── docker-compose.yml        # 本地构建运行
├── docker-compose.ghcr.yml   # 直接拉取已发布镜像
├── package.json
└── .github/workflows/docker.yml
```

## GitHub Actions 与镜像标签

工作流 [`.github/workflows/docker.yml`](.github/workflows/docker.yml) **只在推送版本标签时**运行，日常推送分支和 Pull Request 都不构建。

```sh
git tag v0.0.2
git push origin v0.0.2
```

推送后发布到 `ghcr.io/cnprobe/domain-watch`：

| 标签 | 含义 |
| --- | --- |
| `latest` | 最近一次推送的版本标签 |
| `v0.0.2` | Git 版本标签 |
| `<commit-sha>` | 精确提交 |

镜像同时构建 `linux/amd64` 与 `linux/arm64`。

## 开发命令

```sh
npm ci                # 安装依赖（只有 esbuild + typescript）
npm run typecheck     # TypeScript 类型检查
npm run website:build # 打包服务到 website/dist/server.cjs
npm run website:start # 启动（读取 .env）
npm run website:dev   # 重新打包并启动
```

项目没有自动化测试脚本，功能通过 Docker 容器和实际 Telegram 配置验证。

## 安全建议

- 不要提交 `.env`、`config.key` 和任何 Token。
- 首次登录后立即修改随机密码。
- `RESET_ADMIN_PASSWORD` 只临时用一次，用完改回 `false`。
- 公网部署建议加 HTTPS 反向代理并设置 `COOKIE_SECURE=true`，同时对 `/api/whois` 限流。
- 用了反向代理就必须设 `TRUST_PROXY=true` 并让代理传 `X-Forwarded-For`，否则所有来源算作同一个 IP，一人输错全员被锁。完整配置见「登录防护 → 放在反向代理后面时必须做什么」。
- 被锁定时看容器日志：会出现「登录被临时锁定」和「登录连续失败 N 次」，据此判断是否有人在猜密码。
- 密码至少 12 位（初始随机密码 24 位），scrypt 单次校验约 60ms，字典攻击成本很高。
- 忘记密码：`.env` 中设 `RESET_ADMIN_PASSWORD=true`，重启后从日志取新密码，再改回 `false`。
- 能读取 Docker 日志或数据卷的人应视为管理员。
- Telegram Bot Token 泄露后立即在 BotFather 撤销并重新生成。
- 只运行一个实例，避免重复执行提醒任务。

## License

[MIT](LICENSE)
