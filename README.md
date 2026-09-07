# Codex 用量记录器

一个本地运行的 Codex 账号用量采样器与可视化面板，支持维护多个账号，并为每个账号独立保存历史快照。

## 启动

需要支持原生 `fetch` 的 Node.js（建议 Node.js 24）。项目无第三方运行时依赖，无需安装 npm 包。

```powershell
cd .\codex-usage-tracker
npm start
```

服务默认监听 `127.0.0.1:4782`。普通用户可以查看数据、手动查询和切换图表范围；登录管理员后可以添加、修改、删除账号和修改自动查询配置。后端独立采样，网页每 30 秒同步已有数据，多开页面不会创建额外的采样定时器。

管理员密码通过启动进程的 `CODEX_ADMIN_PASSWORD` 环境变量提供。请在本机设置，不要提交真实密码或凭据。Windows CMD 使用 `set "CODEX_ADMIN_PASSWORD=你的密码"`，PowerShell 使用 `$env:CODEX_ADMIN_PASSWORD = '你的密码'`，Linux 使用 `export CODEX_ADMIN_PASSWORD='你的密码'`，然后在同一终端运行 `npm start`。程序不会自动加载 `.env` 文件。

管理员会话使用 HttpOnly Cookie，有效期 8 小时；服务重启后需要重新登录。同一浏览器的页面共享 Cookie。当前登录功能没有失败限速，面向本机或可信环境；公网部署需要另外配置 HTTPS 和访问保护。

然后打开 http://127.0.0.1:4782，在页面中添加账号名称并粘贴对应的 `auth.json` 完整 JSON 内容。后端会为每个账号在 `data/accounts/` 下维护独立凭据文件，网页不会展示凭据文件路径或回填 token，也不会读取或修改用户根目录的 `.codex/auth.json`。

服务每隔一段时间请求 `GET https://chatgpt.com/backend-api/wham/usage`。账号配置保存在 `data/accounts.json`，带账号归属的快照保存在 `data/snapshots.json`，全局采样配置保存在 `data/config.json`。

自动查询和“刷新全部”会跳过未设置有效凭据的账号，不把它们记作查询失败。历史按账号分别保留最近 20,000 条；保存快照时只淘汰超过该上限的账号自身的旧记录，不挤占其他账号的记录。旧版已经淘汰的数据无法恢复。

所有 JSON 文件通过同目录临时文件写入、同步到磁盘后原子替换，避免中途退出留下半截 JSON；该机制保证单个文件替换完整，不提供多个文件之间的事务。写入请求最大为 1 MiB，超出返回 HTTP 413，无效 JSON 返回 HTTP 400。

接口失败会区分凭据过期、权限拒绝、接口不存在、限流、服务异常、网络故障、超时，以及 JSON/字段结构不兼容。无法识别的响应不会写入历史，已有快照保留。兼容已有的部分蛇形/驼峰字段，但无法保证自动适配未来接口变更，也不会自动刷新登录凭据；结构变化需要更新解析逻辑。

运行 `npm test` 可执行隔离测试，使用临时目录与模拟用量接口，不访问真实账号。

## 数据迁移

Git 仓库只包含代码，整个 `data/` 目录均被忽略。迁移已有账号和历史时，请先停止原服务，再单独安全复制 `data/` 到目标项目目录，确保运行用户有读写权限，并重新设置管理员密码。凭据以本地 JSON 保存，不能公开分享。新克隆的项目会自动创建空数据目录。

首次升级时，如果目录中存在旧版 `data/snapshots.json` 而没有 `data/accounts.json`，程序会自动创建账号记录，并按历史快照里的 `account_id` 拆分混合数据。旧版绑定根目录 `auth.json` 的记录不会被读取，已有账号需要重新粘贴各自的凭据 JSON。

接口为 Codex/ChatGPT 后端的只读用量接口，返回 `plan_type`、`rate_limit.primary_window`、`rate_limit.secondary_window`、`additional_rate_limits`、`credits` 等字段。该接口属于 Codex 客户端实际使用的后端接口，可能随服务端版本调整；遇到 401 时请在对应账号的凭据文件中更新登录状态。
