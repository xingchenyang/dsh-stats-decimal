# dsh-stats-decimal

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-v0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

[English](README.md) | 中文

> 本文件是与插件版本 `0.9.0` 对应的中文理解快照。发生冲突时，以英文版 `README.md` 为准；快照版本和同步状态见[本地化清单](docs/localization-manifest.json)。

这是一个运行于 DeepSeek Harness Desktop 应用的 Cordis 插件。它保留 DSH 原生可展开会话统计，并增加 provider 计费的 Session 与子智能体费用、余额和当前计价时段。费用由 Host 根据 Session 事件计算。余额通过 Host 侧 RPC 查询，API Key 不会进入 renderer 或 Session 日志。

## 特性

- 保留 DSH 原生 `StatsPills` 的轮次、速度、精确 token 数和缓存命中详情。
- 独立显示 Usage & Billing 页脚，不覆盖 DSH 原生 `stats` 项。
- 从 Session 自身的 provider usage 事件计算费用，包含 attempt、stream 与 retry replacement 语义，并排除 fork 继承的历史。
- 通过 DSH 权威子代理成员关系显示仅包含后代的子智能体费用，不根据 parent/header 推断。
- 显示累计费用、当前客户端本地日期费用、独立的本地今日 profile 汇总，以及所选 provider 的 CNY/USD 余额。
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

- 最低 Host 要求：DeepSeek Harness `v0.2.1-rc.1` 或更高版本（插件 `0.9.0`）。0.9.0 实际完成运行时资格验证的是 DSH `v0.2.2-rc.1`、Host protocol 4，资格环境中的 Node 为 `v24.20.0`。
- 版本范围允许加载并不表示更高版本已通过运行时资格验证。历史 RC.1 的资格结论仍仅适用于原测试范围；只有引入必需的 Host 能力或证实存在不兼容时，才提高最低版本。
- 插件使用 projection、slot 和 RPC contract；这不代表兼容资格记录以外的 DSH 版本。
- Desktop 使用独立的 `desktop` profile。安装后需在该 profile 启用费用配置。
- 本地今日通过 DSH SessionQuery 读取当前 profile 的 Session 日志，不依赖 API Key 或账户登录认证。优先使用公开 `observeSession` 读取路径；不可用时回退到 `readSession`。Desktop renderer 提供本地 IANA 时区。
- 插件使用 ESM JavaScript，依赖 `@deepseek-ai/schemastery` 和 `zod`。

~~~text
lib/index.js             Host 插件、费用 projection、provider/树聚合和 RPC 路由
lib/client.js            响应式 Usage & Billing UI、账务详情、本地化和余额轮询
lib/usage.js             Session 与子智能体账务共用的 provider usage fold
lib/pricing.js           价格表、价格覆盖、费用计算、北京时间计价时段
cordis.patch.yml         Cordis bundle 注册入口
~~~

## 显示内容

DSH 原生统计保持不变。插件在 composer 下方、原生统计 pills 和上下文计量器之后添加紧凑的 Usage & Billing 页脚，包含居中的计价时段 pill 和四个账务 scope：

~~~text
● 工作日 · 空闲时段

会话        ¥10.28 / ¥10.28       子智能体    ¥17.92 / ¥17.92
本地今日    ¥40.12                余额        ¥50.17
~~~

正常桌面宽度为两列两行；真正狭窄的宽度回退为一列四行。容器由插件自己建立并按宽度响应，不依赖 Session 类型。

- **会话**：当前 Session 自身累计/今日费用。
- **子智能体**：来自 DSH 权威子代理成员关系的仅后代费用（`tree.subagentsAggregate`），不是 Tree 合计，也不是相减结果。
- **本地今日**：当前 profile 在当前客户端时区当天的汇总。
- **余额**：所选 provider 的独立余额。

详情弹窗为每个 scope 增加缓存命中和逐行 token：输入、缓存读取、缓存写入、输出、推理。Ready scope 不重复显示正常状态；partial、unknown、unavailable 仍可见。没有子智能体时，compact 显示 `未使用`，详情只显示简洁说明。多智能体树合计只作为轻量解释行，不是主要组成项。

金额显示两位小数并直接截断，不四舍五入；token 数以分组整数显示，不使用 K/M/G 缩写。峰谷计价仍按北京时间。每个启用币种只显示一次；计价未知不会隐藏或改变余额。页脚不使用金额省略号或水平滚动。

## 安装

通过 DeepSeek Harness Desktop 的插件管理安装：

1. 在 DSH Desktop 中打开 Plugins 页面。
2. 选择 Add Plugin。
3. 输入仓库地址：

~~~text
https://github.com/xingchenyang/dsh-stats-decimal
~~~

4. 选择 Enable Now 并重启 DSH Desktop。

Desktop profile 的 pnpm 会安装插件声明的依赖。未指定 Git ref 时，pnpm 选择默认分支的最新 commit，并将该 commit 写入 profile lockfile。GitHub Release 不决定安装哪个 commit。

若要从本地源码安装，可在 Add Plugin 中选择仓库目录。此方式登记为 `link:` 包，不会替链接目标目录安装依赖。先在仓库根目录准备运行时依赖：

~~~powershell
npm.cmd install --omit=dev --no-package-lock --ignore-scripts
~~~

此命令只准备源码依赖，不会把插件安装到 DSH。安装和配置都属于 Desktop profile。

**已知插件管理器警告：** 已安装插件再次提交同一 URL 后，pnpm 可能正常结束并显示 `Already up to date`、`added 0` 和 `Done`，但插件页面随后提示无法从依赖变更中确定安装了哪个包。观察到此提示时，插件版本已更新，重启后账户登录余额正常显示。pnpm 报错、重启后版本未变或功能不可用时，应按安装失败处理。

## 更新与卸载

更新 GitHub 安装时，在 Plugins 页面再次选择 Add Plugin 并输入相同仓库地址，然后重启 Desktop。无需先卸载插件或重新安装 DSH Desktop。

本地源码安装更新源码后，如 Desktop 插件管理器需要刷新，可重新提交本地目录；更新后重启 Desktop。

卸载时通过 DSH Desktop 的插件管理移除插件，如提示则重启 Desktop。当前版本的受支持安装和管理入口是 DSH Desktop 应用。

## 配置

Desktop 使用 `$DSH_HOME\profiles\desktop\cordis.patch.yml`。文件不存在时新建，顶层必须为 YAML 序列：

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
~~~

修改 Desktop profile 后重启 Desktop。仅安装插件不会显示页脚，因为 `enableCost`、`cnyEnabled` 和 `usdEnabled` 默认均为 `false`。

| 设置 | 默认值 | 用途 |
| --- | ---: | --- |
| `enableCost` | `false` | 费用账本总开关 |
| `cnyEnabled` | `false` | 显示 CNY 片段 |
| `usdEnabled` | `false` | 显示 USD 片段 |
| `balance.enabled` | `false` | 在启用币种片段中追加余额 |
| `peakHours` | `[9,10,11,14,15,16,17]` | 北京时间工作日高峰钟点 |

只有 `enableCost=true` 且至少启用一种币时才显示页脚。compact 页脚显示第一个配置的 CNY/USD 币种；详情弹窗显示全部启用币种。余额是独立的 compact scope，不使用累计/今日语义。

本地今日通过 DSH 的 `sessionQuery` 服务读取实时和已持久化 Session 日志。Desktop renderer 会把 IANA 时区传给 Host，因此日期边界跟随设备时区并适用夏令时变化；renderer 无法提供时区时使用 UTC。该估算不依赖会话使用 DeepSeek API Key 还是账户登录认证。Host 优先使用公开的 `observeSession` 读取路径，避免 v0.2.2 中每次读取 Session 前的持久化列表预检；`observeSession` 不可用时回退到 `readSession`。短时间连续发生的用量和 Session 事件会合并刷新。本地今日包含当前 profile 中每个 Session 自己产生的事件（包括子代理），并排除 fork 继承的事件前缀以免重复计算。会话和子智能体 scope 独立于本地今日加载。若查询服务不可用或任一日志无法读取，本地今日显示不可用，而不是伪造零值；若当天任一事件价格未知，则显示费用未知。该值只覆盖当前 DSH Desktop profile 的日志，不是官方账户账单。峰谷计价仍按北京时间。

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

两个旧 Flash 名称仍可调用，但由 DeepSeek-V4.1-Flash-1017 提供服务并按当前 Flash 价格计费，因此三个 Flash ID 当前价格相同。历史会话按每条消息时间选择当时生效的价格。若模型当时尚未发布，或历史价格资料不完整，则费用未知；不会用当前价格倒推。

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

- `balance.enabled=true` 时，余额会跟随当前 DSH Session 实际选中的模型 provider。待执行的模型选择优先；否则使用该 Session 最近一次请求的模型；新 Session 跟随 DSH 当前默认模型。无需配置 provider。
- 只有 Host 确认当前 DSH 路由使用规范的 `https://api.deepseek.com/anthropic` Messages endpoint 时，`deepseek-official` 才显示余额。插件通过 DSH credentials service 解析该路由配置的 `apiKeyEnv` 引用（默认 `DEEPSEEK_API_KEY`），并且只请求固定地址 `https://api.deepseek.com/user/balance`，拒绝重定向。自定义网关或缺少有效路由配置时会显示 `Balance –`，且不会解析 API Key。
- 官方 API 路径显示 `total_balance`，其中包含未过期赠送余额和充值余额。
- `deepseek-account` 只调用 DSH 的 `deepseekAccount.getBalance()` 服务，并按币种合计该服务分别返回的充值钱包和赠送钱包。不要在插件中配置账户 token 或 API Key。
- 插件不会根据现有凭据或登录状态推测 provider。所选 provider 的服务或凭据不可用时显示 `Balance –`，绝不尝试另一个 provider。未知或无法确认的模型 provider 也显示 `Balance –`。
- 为兼容旧 profile YAML，旧字段 `balance.provider` 和 `balance.apiBase` 会被接受但忽略。可在方便时删除；`apiBase` 无法改变固定 HTTPS 请求地址。
- 这些余额路径在 DSH Desktop 中可用。插件不会查询第三方模型服务商的账单或用量接口；每日统计仍是根据本地 token 用量和已配置模型价格计算的估算。
- API Key 只在 Host 侧解析和使用，只发送到固定官方地址，不发送到 Desktop renderer、projection 或 Session 日志。Host 会从同一个 DSH 设置快照读取 endpoint 和凭据引用；请求期间 provider 路由或设置代次发生变化时会丢弃余额结果。这能将请求绑定到配置的路由，但不能从密码学上证明 API Key 的所有权。
- 启用时，页面加载会读取余额，之后每五分钟轮询。切换 Session 或 provider 会立即清除旧余额。刷新页面可手动重新读取。
- 禁用余额时，Desktop renderer 不会轮询余额 RPC。请求完成但没有任何可用 CNY/USD 金额时显示不可用，而不是零；详情状态徽标不会在所有金额均为 `—` 时显示“正常”。provider source 仍可显示。

## 注意事项与许可证

- “今日”金额（会话和本地今日）均按当前 Desktop renderer 的 IANA 日历日期统计。会话 scope 只覆盖打开的 Session；本地今日覆盖当前 DSH Desktop profile 中 `sessionQuery` 可读取的所有会话。两者读取实时和已持久化日志；不可读历史或查询服务缺失会使相应 scope 显示不可用。本地今日包含子代理 Session，并排除 fork 继承的事件。两者都是本地日志估算，不是官方账户账单；峰谷计价和时段标签仍按北京时间。
- 费用仅根据模型 token 用量和价格表估算，不包含 Search/Fetch 请求费用。直接调用 Search 或 Fetch API 时，每 1,000 次成功请求各为 ¥5 / $0.75；DeepSeek Harness、Claude Code 和 Codex 的服务端 Search/Fetch 调用目前免费，官方公告称自北京时间 2026-11-01 00:00（UTC+8）起计费。本插件无法从 Session 日志统计可计费的 Search/Fetch 请求。详见[价格历史档案](docs/PRICING_HISTORY.md)。最终金额以 DeepSeek 官方账单为准。
- 余额是独立的官方 API 数据。模型价格未知不会隐藏或改变 DeepSeek 返回的余额。
- 这是一个独立个人项目，与 DeepSeek、DeepSeek Harness 或 OpenAI 没有隶属、合作或背书关系。部分实现和文档使用了 AI 辅助。项目依据 [MIT License](LICENSE) 发布。

插件版本和中文快照同步状态记录在[本地化清单](docs/localization-manifest.json)中。
