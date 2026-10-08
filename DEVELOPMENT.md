# Development Guide

本文档保存项目的技术背景、关键决策和接手信息。安装与配置见 `README.md`，用户可见变化见 `CHANGELOG.md`，维护约束见 `AGENTS.md`。

## 当前状态

- 当前适配目标：DeepSeek Harness `v0.2.0-rc.1`（官方 release commit `4878cda`）。用户在 Desktop 的 GitHub 安装环境确认账户登录模式余额正常显示；这项运行验证仅覆盖该路径。
- Desktop 由 Electron 加载完整 Web 应用，但拥有独立的 `$DSH_HOME/profiles/desktop`、插件包管理状态和随应用提供的 pnpm，与 Web profile 相互隔离。`dsh.client.platform: "web"` 适用于嵌入的 Web 界面。Web 使用 `dsh plugin --profile web` 命令行管理插件；Desktop 使用主应用「插件」页面，并在 Desktop profile 单独配置。
- 上游依据：[DSH v0.2.0-rc.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)（commit `4878cda`）。
- 技术栈：ESM JavaScript、Cordis Host/Web bundle、`@deepseek-ai/schemastery`、`zod`。
- 费用 projection 的客户端可见状态版本：`stateVersion: 5`。版本 5 增加浏览器所需的法定节假日日期范围，并使已有 session usage 按修正后的峰谷规则重新折叠。
- Desktop 通过 GitHub 仓库安装插件时，由 profile 包管理器安装插件声明的依赖；安装或更新后重启 Desktop 才会应用。已安装的 GitHub 插件可在「添加插件」中再次提交相同 URL 更新。
- Desktop 通过本地目录安装时会登记为 `link:`，不会替链接目标安装依赖；使用此开发路径前，需在插件仓库根目录安装声明的运行时依赖。公开 `dsh` CLI 不管理 Desktop profile。

## 架构与数据流

1. Host 侧 `billingLedger` 折叠 `assistant/message` 的 usage 事件。
2. `lib/pricing.js` 先按事件时间选择当时有效的模型价格，再按缓存桶、输出 token 及北京时间峰谷计算费用。`lib/billing-calendar/` 提供单一年度法定假日日历；周末先按谷价处理，工作日法定节假日再按谷价处理。
3. projection 通过 `wire.viewSchema` 将累计消费、当日消费、启用币种、计价状态和仅含起止日期的假期范围传给 Web。
4. Web 客户端保留 DSH 原生 `StatsPills`，在 `conversation.composer.dock` 注册费用项。`ContextMeter` 是 dock 的后续兄弟节点；客户端在费用启用时允许共享 footer 换行，并通过 flex order 将费用项放到两项原生统计之后作为独立第二行。行间距为 4px，费用行不添加背景装饰。
5. 余额走 DSH Connection 的共享 `/api` 精确路由。Host 优先使用 DSH 凭据中的 `DEEPSEEK_API_KEY` 调用 DeepSeek `/user/balance`；未配置 API Key 时，按需读取可选的 `deepseekAccount` Host 服务并调用 `getBalance(AccountClientMetadata)`。账户 token、Platform 请求头均由 DSH provider 持有和处理，浏览器不接触凭据。

余额不写入 Session。Session 日志拒绝未知事件类型，而 projection 已足以提供会话累计数据；因此不向 Session 追加插件自定义余额事件。

## 代码地图

- `lib/index.js`：Host 插件、配置 schema、`billingLedger` projection、余额 RPC 和 DSH credentials service 调用。
- `lib/client.js`：Web 费用/时段状态、本地化和余额轮询。
- `lib/pricing.js`：历史价格区间、公告档案、价格覆盖、费用计算及北京时间峰谷判断。
- `lib/billing-calendar/index.js`：年度法定假日数据的唯一程序入口及 Host 日期查询；`2026.js` 保存完整的 2026 官方放假区间。
- `docs/BILLING_CALENDAR.md`：法定假日计价证据、日历来源、缺失年份回退和年度维护方式。
- `docs/PRICING_HISTORY.md`：历史价格证据、时间精度和公告修订说明。
- `docs/DEEPSEEK_NEWS_INDEX.md`：官网没有总入口时使用的中英文新闻目录。
- `cordis.patch.yml`：Cordis bundle 注册入口。
- `package.json`：声明 Host 插件运行时依赖。Desktop 以本地 `link:` 方式安装时，依赖需要预先安装在链接目标目录中；通过 GitHub 仓库安装时，Desktop profile 的 pnpm 会解析并安装这些依赖。
- `scripts/reload-plugin.mjs`：删除并重新安装 `file:` 插件快照。
- `scripts/check-deepseek-docs.mjs`：从 DeepSeek 英文 canonical 页面源码提取左侧导航目录并与仓库基线比较。
- `README.md`、`CHANGELOG.md`、`AGENTS.md`：使用说明、版本变化和维护规则。

## Contract 与关键约束

### DSH projection contract

- 内部 state schema 包含 `cumulative`、`today`、`todayStamp` 和 `pricingKnown`。
- 客户端 view schema 包含 `enabled`、`currencies`、`peakHours`、最小 `publicHolidaySpans`、`cumulative`、`today` 和 `pricingKnown`，不暴露内部 `todayStamp` 或日历来源元数据。
- DSH contract 使用 `wire.viewSchema` 向客户端提供 projection 数据；缺少 `wire` 时，`useProjection("billingLedger")` 不会收到可渲染数据。
- 修改 projection state 或 wire view shape 时，必须同步更新 schema、view、客户端消费代码和 `stateVersion`。
- `todayStamp` 用于跨自然日折叠时先清零当日消费，避免历史事件和不同日期混算。

### 计价

- 当前价格依据：[人民币（CNY）价格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 与 [美元（USD）价格表](https://api-docs.deepseek.com/quick_start/pricing/)；历史价格优先使用包含具体定价的独立新闻及当时价格页快照。[中文更新日志](https://api-docs.deepseek.com/zh-cn/updates) 和 [英文更新日志](https://api-docs.deepseek.com/updates/) 主要用于核对模型迭代顺序，正文没有明确价格时不得单独作为价格依据。
- `PRICE_HISTORY` 是计费事实源，按模型保存从旧到新的生效区间；`PRICES` 只是无时间参数调用和配置合并使用的当前价格兼容视图。
- `PRICE_NOTICES` 保存价格相关公告及其状态；`cancelled`、`effective-no-rate-change` 不产生新的计费区间。
- 每条相关新闻保存 `zhCN`、`en` 成对来源；完整发现入口维护在 `docs/DEEPSEEK_NEWS_INDEX.md`，其依据是官网文档侧栏而非猜测 URL。新闻索引同时标记正文是否含具体定价、调价时间或“价格不变”声明。
- 2026-08-17 00:00 和 2026-09-10 12:00 使用官方精确北京时间；只有日期证据的 2026 年 4 月节点标记为 `effectivePrecision: "date"` 并以北京时间零点作为可重复计算的边界。
- 价格覆盖针对指定模型的完整历史生效，适合私有代理或自定义合同价；没有覆盖的内置模型继续使用官方历史区间。
- 所有百分比、token 简写和金额均直接截断，不四舍五入。
- 北京时间使用固定 UTC+8，不依赖宿主时区或夏令时；周六、周日始终为谷价，且不因调休上班改为峰价。已编入年度日历的中国法定节假日全天为谷价；未编入年份沿用周末谷价与工作日 `peakHours` 回退。
- `cacheReadTokens` 和 `cacheWriteTokens` 按 cache-hit 价格，未缓存输入按 cache-miss 价格，输出按 output 价格。
- 模型必须同时具备启用币种的峰/谷、CNY/USD、cache hit/miss/output 完整价格才可计价。
- 未知模型或不完整价格返回 `null`，projection 将 `pricingKnown` 置为 `false`，不使用其他模型价格兜底。
- Vision 模型必须与官方价格表保持与 Flash 的同价约束；新增内置模型前须有完整且有依据的价格。

### 年度法定假日日历

- 年度日期与来源元数据只存于 `lib/billing-calendar/<year>.js`，Host 和 Web 通过 `lib/billing-calendar/index.js` 获取数据；Web 只收到当前计价所需的起止日期。
- 年度文件保留国务院通知列出的完整假期范围，包括落在周末的日期；调休上班周末不属于假期数据。
- 修改 projection wire view 时同步更新 schema、client 消费代码和 `stateVersion`。历史峰谷分类改变时也必须提高版本，保证旧累计金额重新折叠。
- 目前仅内置 2026 年；未支持年份不预测节假日，沿用原工作日/周末规则。新增年度前按 `docs/BILLING_CALENDAR.md` 核对国务院办公厅通知。

### 凭据与余额

- API Key 只在 Host 侧通过 `credentials.resolve("DEEPSEEK_API_KEY")` 解析和使用；凭据存储、启动环境和回退优先级由 DSH credentials service 管理，插件不读取私有凭据文件或直接检查进程环境。
- API Key 不得进入 client bundle、projection、Session 日志、URL 或普通错误输出。
- 余额通过 Host 注册的 `/api/stats-decimal/getBalance` 精确路由提供，客户端只收到余额数值、可用状态和安全错误标记。
- 配置了 `DEEPSEEK_API_KEY` 时，余额使用 API Key 路径；credentials capability 缺失、解析失败或没有 Key 时再查询可选的 `deepseekAccount` 服务。两个 capability 均通过 `ctx.get()` 按请求查找，不把它们设成插件的必需依赖；两者都不可用时返回 `no-balance-credentials`。
- `deepseekAccount.getBalance()` 的调用元数据仅包含 DSH 客户端版本、请求语言和时区偏移；余额映射仅读取充值钱包的 `value`，赠送钱包不并入余额。
- 余额失败、没有 API Key 且没有已登录账号，或没有对应币种余额时返回空值；余额读取独立于模型费用计价。

## 已知限制

- “今日”按会话日志最后一个自然日累计；打开较早历史会话时，不一定代表现实中的今天。
- 费用为本地估算，最终结果以 DeepSeek 官方账单为准。
- 余额依赖以下任一 Host 能力：`DEEPSEEK_API_KEY` 凭据及 DeepSeek `/user/balance` 响应格式，或 DSH `deepseekAccount.getBalance()` 服务及其 Platform 钱包结构。API Key 路径优先；未配置 API Key 才使用账户登录路径。
- Desktop 本地目录安装只链接仓库，不安装链接包依赖；使用该开发路径前，需在插件仓库根目录运行 `npm install --omit=dev --no-package-lock --ignore-scripts`。Desktop GitHub 安装由 profile pnpm 安装声明的依赖，安装后需重启 Desktop。安装后还需检查 Desktop profile 的 `cordis.patch.yml` 是否启用了费用和币种；这些开关默认关闭。

## 构建与验证

提交前至少运行：

```powershell
node --check lib/index.js
node --check lib/client.js
node --check lib/pricing.js
git diff --check
```

涉及计价时还应验证：

- 北京时间工作日峰时段返回 `peak`。
- 北京时间工作日非峰时段及周末返回 `valley`。
- 编入日历的工作日法定假日、普通周末和调休上班周末返回 `valley`；未支持年份保留工作日回退。
- 新旧三个 Flash ID 的内置价格完全一致。
- 未知模型的 `costOf()` 返回 `null`。
- 通过 `overridePricing` 添加的模型可以正常计算。
- 自定义 CNY/USD 价格、余额独立失败和未知计价状态均不违反显示约束。

安装验证：

```powershell
node scripts/reload-plugin.mjs --profile web
dsh web
```

随后硬刷新 Web 页面，检查原生 StatsPills、独立费用行是否位于完整统计栏下方、累计/今日费用、未知模型状态、余额展示、官方峰谷状态和布局。

Desktop 手动检查必须通过主应用「插件」页面中的「添加插件」功能安装到其保留的 `desktop` profile，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 单独启用费用和币种配置，再重启 Desktop。检查原生 StatsPills、费用行和余额显示。不要通过 CLI 或 Web 的 reload 脚本操作保留的 Desktop profile。

## 后续计划

- 基于 `PRICE_HISTORY` 增加价格历史阶梯图，可按模型、币种、计费项及峰谷时段筛选。

## 发布检查

1. 运行 `npm run check:upstream`；如果英文 canonical 侧栏目录发生变化，打开新增页面，人工确认价格、生效时间和公告状态，再更新基线。
2. 确定版本号和发布日期：
   - 更新 `package.json` 中的版本号；
   - 在 `CHANGELOG.md` 建立对应版本章节；
   - 只有安装、配置、兼容性或当前使用行为变化时更新 `README.md`；
   - 只有架构、限制、关键决策或维护流程变化时更新 `DEVELOPMENT.md`；
   - 只有仓库维护约束变化时更新 `AGENTS.md`。
3. 核对 DSH projection、slot、locale 和 RPC contract；不凭经验扩大兼容范围。
4. 运行语法检查、计价回归和 `git diff --check`。
5. 用测试 profile 重新安装插件，确认原生 StatsPills、独立费用项、峰谷状态、未知模型和余额降级行为。
6. 确认 Git 中没有密钥、本地配置、缓存或辅助产物，再创建 tag/release。

### 上游文档检查

```powershell
npm run check:upstream
node scripts/check-deepseek-docs.mjs --snapshot
```

默认命令读取 `docs/deepseek-docs-baseline.json` 并报告差异：以英文首页发现最新新闻入口，从当前英文 Models & Pricing 文档页提取 API 文档导航，并从最新新闻页提取独立的 News 导航，再比较两者的合并目录。这样不会把某个分类页的局部侧栏误判为其他仍在使用的导航项全部被移除。中文 URL 只作为在 canonical path 前添加 `/zh-cn` 的阅读引用，不单独抓取或维护第二套目录。`--snapshot` 输出当前结构化目录快照，供人工核对后更新基线。脚本不抓取 API 文档正文，也不会自动修改 `PRICE_HISTORY`。

2026-09-29，上游把原先同一侧栏中的 API Guides、News 和其他资源改为分开的 API 文档与 News 导航。旧导航中的指南、计价页和 18 条历史新闻链接仍可访问，News 路径与标题均未变化；因此仅按新导航重建目录基线，不改价目或历史公告数据。

## 维护流程

1. 修改前阅读 `README.md`、本文件、`CHANGELOG.md` 和 `AGENTS.md`。
2. DSH 升级时先核对对应源码 contract，再修改兼容声明或 projection 适配。
3. 用户可见变化写入 `CHANGELOG.md`；架构、限制或关键决策变化更新本文件。
4. 只有安装、配置或当前使用行为变化时才扩展 `README.md`。
5. Agent 为临时审查、诊断、下载、补丁和验证生成的脚本、样例数据、日志及其他辅助文件统一放在 `.work/`；维护中的项目脚本放在 `scripts/`。

## 仓库 Git 身份与本地工作区

项目自有仓库使用项目专属 Safe Public Git 身份；本仓库为 `dsh-stats-decimal <dsh-stats-decimal@example.invalid>`，不修改全局 Git 身份。`.work/` 仅用于临时本地材料，只有 `.work/README.md` 跟踪，其余内容忽略。`.githooks/` 保存维护并跟踪的仓库安全工具；本地启用身份检查 hook：

```sh
git config --local core.hooksPath .githooks
```
