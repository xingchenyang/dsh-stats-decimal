# dsh-stats-decimal

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-v0.2.0--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

[English](README.md) | 中文

> 本文件是与插件版本 `0.8.0` 对应的中文理解快照。发生冲突时，以英文版 `README.md` 为准；快照版本和同步状态见[本地化清单](docs/localization-manifest.json)。

这是一个运行于 DeepSeek Harness Web 会话及 Desktop 应用内嵌 Web 界面的 Cordis 插件。它保留 DSH 原生可展开会话统计，并增加 CNY/USD 费用估算、充值余额和当前计价时段。费用由 Host 根据会话事件计算。余额通过 Host 侧 RPC 查询，API Key 不会进入浏览器或 Session 日志。

## 特性

- 保留 DSH 原生 `StatsPills` 的轮次、速度、精确 token 数和缓存命中详情。
- 独立显示费用和余额账本，不覆盖 DSH 原生 `stats` 项。
- 显示 CNY/USD 会话累计费用、会话最后一个自然日的费用和充值余额。
- 在第二行显示当前北京时间日期的本地全会话费用估算，包含子代理会话。
- 根据每条事件发生时的历史模型价格、缓存桶、输出 token 及北京时间计价时段重放费用。
- 显示当前北京时间日期类型和计价时段：工作日高峰/空闲、周末空闲或带名称的法定节假日。界面会显示本地化节日名称。
- 周六、周日（包括调休上班日）和已编入日历的中国法定节假日始终使用谷价。可为内置模型或其他模型配置完整价格。
- 未配置完整价格的模型显示 `Cost unknown`，不会套用其他模型的价格。
- 费用和余额功能由配置控制，默认关闭。

## 文档

- [CHANGELOG.md](CHANGELOG.md)：版本历史与用户可见变更。
- [DEVELOPMENT.md](DEVELOPMENT.md)：架构、兼容性、验证与发布流程。
- [AGENTS.md](AGENTS.md)：维护者与自动化必须遵守的仓库规则。
- [docs/BILLING_CALENDAR.md](docs/BILLING_CALENDAR.md)：节假日计价规则和日历来源。
- [docs/PRICING_HISTORY.md](docs/PRICING_HISTORY.md)：历史价格与公告依据。
- [docs/DEEPSEEK_NEWS_INDEX.md](docs/DEEPSEEK_NEWS_INDEX.md)：官网新闻侧栏中的精选入口。

## 兼容性与代码结构

- 当前兼容目标：DeepSeek Harness `v0.2.0-rc.2`（插件 `0.8.1`）。
- 插件使用 projection、slot 和 RPC contract；这不代表兼容其他 DSH 版本。
- Desktop 使用同一 Web 界面，但拥有独立的 `desktop` profile。安装后需在该 profile 启用费用配置。
- 插件使用 ESM JavaScript，依赖 `@deepseek-ai/schemastery` 和 `zod`。

~~~text
lib/index.js             Host 插件、费用 projection、跨会话汇总和 RPC 路由
lib/client.js            Web 账本、全会话当日估算、本地化和余额轮询
lib/pricing.js           价格表、价格覆盖、费用计算、北京时间计价时段
cordis.patch.yml         Cordis bundle 注册入口
scripts/reload-plugin.mjs 重新安装本地 file: 插件快照
~~~

## 显示内容

DSH 原生统计保持不变。插件在 composer 下方、原生统计 pills 和上下文计量器之后添加独立费用区。第一行显示当前 Session 账本，第二行显示当前北京时间日期的本地全会话费用估算。该区域没有背景装饰。金额显示两位小数并直接截断，不四舍五入。

示例：

~~~text
工作日 · 高峰时段  CNY 累计 ¥0.57 · 今日 ¥0.57 · 余额 ¥89.54 | USD 累计 $0.08 · 今日 $0.08 · 余额 $0.00
Weekday · PEAK  CNY Total ¥0.57 · Today ¥0.57 · Balance ¥89.54 | USD Total $0.08 · Today $0.08 · Balance $0.00
北京时间 2026-10-09 · 本地全会话今日 CNY ¥9.22 · USD $1.38 · 25 个会话
~~~

每个启用币种只显示一次。多币种用 `|` 分隔；单币种不显示分隔符。计价未知不会隐藏或改变余额。

## 安装与插件管理

根据目标 profile 选择管理方式。Desktop profile 由 Desktop 应用的 Plugins 页面管理；Web profile 由命令行管理。两个 profile 互相独立。

| 环境 | 管理方式 |
| --- | --- |
| Desktop | Plugins 页面；使用 Add Plugin |
| Web | CMD 或 PowerShell：`dsh plugin --profile web ...` |

### Desktop

在 Desktop 应用中打开 Plugins 页面，选择 Add Plugin，然后输入仓库地址：

~~~text
https://github.com/xingchenyang/dsh-stats-decimal
~~~

安装后选择 Enable Now 并重启 DSH Desktop。Desktop profile 的 pnpm 会安装插件声明的依赖。未指定 Git ref 时，pnpm 选择默认分支的最新 commit，并将该 commit 写入 profile lockfile。GitHub Release 不决定安装哪个 commit。

如需更新 GitHub 安装，在 Add Plugin 中再次输入相同仓库地址，然后重启 Desktop。无需先卸载插件或重新安装 DSH Desktop。

**DSH `v0.2.0-rc.1` 的已知界面警告：** 已安装插件再次提交同一 URL 后，pnpm 可能正常结束并显示 `Already up to date`、`added 0` 和 `Done`，但插件页面随后提示无法从依赖变更中确定安装了哪个包。观察到此提示时，插件版本已更新，重启后账户登录余额正常显示。遇到该情况时，pnpm 结果和已安装版本比界面警告更能反映安装结果。pnpm 报错、重启后版本未变或功能不可用时，应按安装失败处理。

若要从本地源码安装，可在 Add Plugin 中选择仓库目录。此方式登记为 `link:` 包，不会替链接目标目录安装依赖。先在仓库根目录准备运行时依赖：

~~~powershell
npm.cmd install --omit=dev --no-package-lock --ignore-scripts
~~~

此命令只准备源码依赖，不会把插件安装到 DSH。Desktop 本地安装和配置都属于 Desktop profile。不要用 Web CLI 命令或 Web 重装脚本管理 Desktop profile。

### Web

`dsh` 命令只管理 Web profile；Desktop profile 由 Desktop 应用管理。`dsh plugin` 内部使用 pnpm，因此 pnpm 必须已加入 PATH。若尚未安装 pnpm，可在 CMD 中运行：

~~~cmd
npm install -g pnpm
~~~

也可在 PowerShell 中运行：

~~~powershell
npm.cmd install -g pnpm
~~~

在包含已克隆仓库的目录中，添加插件并启动 Web：

~~~cmd
dsh plugin --profile web add file:./dsh-stats-decimal
dsh web
~~~

PowerShell 命令相同。`file:./dsh-stats-decimal` 相对于当前 shell 目录解析，而不是相对于 profile 目录。`add` 会将插件写入 profile，并自动加入 `dsh.profile.bundles`，无需手动 insert。公共 `dsh` CLI 不管理官方 Desktop profile。参见 [DSH Desktop 指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/desktop/README.zh.md)。

## 更新与卸载

使用 Web CLI 的 `file:` 方式安装后，如果修改了源码，应重新安装并重启 DSH，使 Web profile 和 Host 重新加载插件。从包含仓库克隆的目录运行：

~~~powershell
dsh plugin --profile web remove dsh-stats-decimal
dsh plugin --profile web add file:./dsh-stats-decimal
dsh web
~~~

仓库还提供一步重装脚本。从仓库根目录运行：

~~~powershell
node scripts/reload-plugin.mjs                 # profile 默认值为 web
node scripts/reload-plugin.mjs --profile web   # 显式选择 web
node scripts/reload-plugin.mjs --dry-run       # 只显示命令，不做修改
~~~

脚本只更新 profile 依赖和 `node_modules`，不会修改 `cordis.patch.yml`。之后仍需重启 `dsh web` 并硬刷新页面（Ctrl+F5）。直接通过 `node` 调用脚本可以避开 PowerShell 的 `.ps1` 执行策略。终端必须有权限写入 `$DSH_HOME\profiles\web`。

从 Web profile 卸载：

~~~powershell
dsh plugin --profile web remove dsh-stats-decimal
~~~

如果 profile 的 `cordis.patch.yml` 中仍有 `stats-decimal` 条目，也应删除。残留条目不会妨碍以后重新安装。Desktop 插件只能通过 Desktop 应用的 Plugins 页面管理。

## 配置

Desktop 使用 `$DSH_HOME\profiles\desktop\cordis.patch.yml`。文件不存在时新建，顶层必须为 YAML 序列。使用 Web CLI 管理时，编辑 `$DSH_HOME\profiles\web\cordis.patch.yml`。两个 profile 使用相同设置：

~~~yaml
- id: stats-decimal
  name: 'dsh-stats-decimal'
  config:
    enableCost: true
    cnyEnabled: true
    usdEnabled: true
    peakHours: [9, 10, 11, 14, 15, 16, 17]
    balance:
      enabled: true
      # apiBase: 'https://api.deepseek.com'
~~~

修改 Desktop profile 后重启 Desktop；修改 Web profile 后重启 `dsh web` 并硬刷新（Ctrl+F5）。仅安装插件不会显示费用行，因为 `enableCost`、`cnyEnabled` 和 `usdEnabled` 默认均为 `false`。两个 profile 的配置互不共享。

| 设置 | 默认值 | 用途 |
| --- | ---: | --- |
| `enableCost` | `false` | 费用账本总开关 |
| `cnyEnabled` | `false` | 显示 CNY 片段 |
| `usdEnabled` | `false` | 显示 USD 片段 |
| `balance.enabled` | `false` | 在启用币种片段中追加余额 |
| `peakHours` | `[9,10,11,14,15,16,17]` | 北京时间工作日高峰钟点 |

只有 `enableCost=true` 且至少启用一种币时才显示费用行。每种币显示累计金额和会话最后一个自然日的金额；启用余额后还会显示充值余额。

全会话当日估算会在页面加载、当前会话的当日费用变化或会话结束后，以及每五分钟兜底时通过 DSH 的 `sessionQuery` 服务读取当前 profile 中的实时和已持久化 Session 日志。短时间连续发生的用量和会话事件会合并刷新。它汇总每个 Session 自己产生的事件，包含子代理 Session，并排除 fork 继承的事件前缀以免重复计算。若查询服务不可用或任一日志无法读取，界面会显示统计暂不可用；若当天任一事件的价格未知，则显示费用未知。该估算只覆盖当前 DSH profile 的日志，不是官方账户账单；Web 和 Desktop profile 的会话存储互相独立。

### `peakHours`

填写北京时间工作日的高峰钟点，范围为 0–23。例如，北京时间 09:00–12:00 和 14:00–18:00 为高峰时填写 `[9,10,11,14,15,16,17]`。计算使用固定 UTC+8，不受 Host 时区和夏令时影响。周六、周日（包括调休上班日）及已编入日历的中国法定节假日全天按谷价。当前日历包含 2026 年假期；未内置年份仍按周末规则及 `peakHours` 判断工作日，不推测假期。空数组表示全天谷价。

### 价格与模型

官方价格和历史查询入口：

- [人民币（CNY）价格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [美元（USD）价格表](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek 新闻索引](docs/DEEPSEEK_NEWS_INDEX.md)：部分独立新闻正文包含价格、优惠截止时间或调价生效时间。
- [中文更新日志](https://api-docs.deepseek.com/zh-cn/updates)和[英文更新日志](https://api-docs.deepseek.com/updates/)：主要用于核对模型发布顺序；只有明确列出价格信息时才作为价格依据。

内置价格表覆盖：

- `deepseek-flash`
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash-vision-exp`（与 Flash 同价）

两个旧 Flash 名称仍可调用，但由 DeepSeek-V4.1-Flash 提供服务并按当前 Flash 价格计费，因此三个 Flash ID 当前价格相同。历史会话按每条消息时间选择当时生效的价格。若模型当时尚未发布，或历史价格资料不完整，则费用未知；不会用当前价格倒推。

历史价格和公告依据见[价格历史档案](docs/PRICING_HISTORY.md)。2026-09-14 将 Pro 路由到 Flash 的计划已撤回，不构成计价边界；`deepseek-v4-pro` 继续使用 Pro 价格。

在前例 `config` 下加入 `overridePricing`，即可覆盖内置模型或添加其他模型：

~~~yaml
overridePricing:
  my-model:
    cny:
      peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 }
      valley: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 }
    usd:
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
      valley: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
~~~

每个启用币种都必须在 `peak` 和 `valley` 中包含 `cacheHit`、`cacheMiss` 和 `output` 价格；否则该模型费用显示未知。对于会报告缓存写入量的模型，可选填每百万 token 的 `cacheWrite` 价格；只有计费规则明确规定该价格时才填写。事件报告了正数缓存写入量但没有适用价格时，费用显示未知。未报告缓存写入量的模型无需该字段。

### 余额

- Host 通过 DSH credentials service 解析 `DEEPSEEK_API_KEY`，再调用 DeepSeek 余额 API。凭据存储格式由 DSH 管理；插件不读取凭据文件。
- 未配置 API Key 时，插件可以使用 DSH 可选的 `deepseekAccount` 服务读取已登录账户的充值余额。不要在插件中配置账户 token 或 `apiKey`。
- API Key 与账户登录同时可用时优先使用 API Key。账户登录路径只返回充值钱包，不包含赠送钱包。
- API Key 只在 Host 侧解析和使用，不发送到浏览器、projection 或 Session 日志。
- 页面加载时读取一次，之后每五分钟轮询。刷新页面可手动重新读取。
- 凭据不可用、请求失败或某币种没有充值余额时显示 `Balance –`。

## 注意事项与许可证

- “今日”按 Session 日志中最后一个自然日统计。打开较早的 Session 时，它可能不是现实中的今天。
- 全会话当日估算使用当前北京时间日期，只覆盖当前 DSH profile 中 `sessionQuery` 可读取的会话。
- 费用根据本地 token 用量和价格表估算，最终金额以 DeepSeek 官方账单为准。
- 余额是独立的官方 API 数据。模型价格未知不会隐藏或改变 DeepSeek 返回的余额。
- 这是一个独立个人项目，与 DeepSeek、DeepSeek Harness 或 OpenAI 没有隶属、合作或背书关系。部分实现和文档使用了 AI 辅助。项目依据 [MIT License](LICENSE) 发布。

插件版本和中文快照同步状态记录在[本地化清单](docs/localization-manifest.json)中。
