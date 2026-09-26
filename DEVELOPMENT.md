# Development Guide

本文档保存项目的技术背景、关键决策和接手信息。安装与配置见 `README.md`，用户可见变化见 `CHANGELOG.md`，维护约束见 `AGENTS.md`。

## 当前状态

- 当前版本：`0.5.2`。
- 当前适配目标：DeepSeek Harness `v0.1.7-rc.2`。用户确认升级后的 Web 能显示费用数据，且费用行排在原生统计 pills 和上下文圆环之后，作为紧凑、清晰的第二行显示。运行时 DOM 显示上下文圆环是 composer dock 的后续兄弟节点；当前费用项仍注册在 `conversation.composer.dock` 并通过 footer flex order 排在两项原生统计之后，行距为 4px，不加背景装饰。
- Desktop 由 Electron 加载完整 Web 应用，但拥有独立的 `$DSH_HOME/profiles/desktop`、插件包管理状态和随应用提供的 pnpm，与 Web profile 相互隔离。`dsh.client.platform: "web"` 适用于嵌入的 Web 界面；Desktop 插件必须通过 Desktop 插件页的原生目录选择器安装，并在 Desktop profile 单独配置。
- 上游依据：[Desktop v0.1.7-rc.2 架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/apps/desktop/README.md)、[Plugin Manager v0.1.7-rc.2 说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/boot/plugin-manager/README.md)。
- 上一验证基线为顶层 `@deepseek-ai/dsh` `0.1.5-rc.1`；其 caret 依赖曾解析为 `0.1.5-rc.2`。当前适配目标不向更早或其他 DSH 版本外推。
- 技术栈：ESM JavaScript、Cordis Host/Web bundle、`@deepseek-ai/schemastery`、`zod`。
- 费用 projection 的客户端可见状态版本：`stateVersion: 4`。
- DSH `v0.1.7-rc.2` 的 Web 端由用户确认费用行工作。Web 与 Desktop 插件页添加本地目录后，两个 profile 都登记为指向同一仓库的 `link:`；当前 Web profile 有 `@deepseek-ai/schemastery` 和 `zod`，Desktop profile 没有。Desktop 因此复现 `ERR_MODULE_NOT_FOUND`（缺少 `@deepseek-ai/schemastery`）；在插件仓库根目录安装已声明的运行时依赖后，Desktop 链接路径可导入，用户确认界面显示正常。命令行 `dsh plugin --profile web add file:...` 已由用户验证；插件页本地目录方式也已验证。插件页 GitHub 仓库地址尚未用本插件端到端验证。公开 `dsh` CLI 不能管理 Desktop profile，Desktop 插件页使用应用提供的 package manager。Desktop 余额 RPC live run 仍未单独验证。升级 DSH 时必须重新验证 projection、slot、locale 和 RPC contract。

## 架构与数据流

1. Host 侧 `billingLedger` 折叠 `assistant/message` 的 usage 事件。
2. `lib/pricing.js` 先按事件时间选择当时有效的模型价格，再按缓存桶、输出 token 及北京时间工作日峰谷计算费用。
3. projection 通过 `wire.viewSchema` 将累计消费、当日消费、启用币种和计价状态传给 Web。
4. Web 客户端保留 DSH 原生 `StatsPills`，在 `conversation.composer.dock` 注册费用项。DSH 0.1.7-rc.2 把 `ContextMeter` 作为 dock 的后续兄弟节点；客户端在费用启用时允许共享 footer 换行，并通过 flex order 将费用项放到两项原生统计之后作为独立第二行。行间距为 4px，费用行不添加背景装饰。
5. 余额走独立的 loopback RPC `/stats-decimal`；Host 调用 DeepSeek `/user/balance`，浏览器不接触 API Key。

余额不写入 Session。Session 日志拒绝未知事件类型，而 projection 已足以提供会话累计数据；因此不向 Session 追加插件自定义余额事件。

## 代码地图

- `lib/index.js`：Host 插件、配置 schema、`billingLedger` projection、余额 RPC 和凭据读取。
- `lib/client.js`：Web 费用/时段状态、本地化和余额轮询。
- `lib/pricing.js`：历史价格区间、公告档案、价格覆盖、费用计算及北京时间峰谷判断。
- `docs/PRICING_HISTORY.md`：历史价格证据、时间精度和公告修订说明。
- `docs/DEEPSEEK_NEWS_INDEX.md`：官网没有总入口时使用的中英文新闻目录。
- `cordis.patch.yml`：Cordis bundle 注册入口。
- `package.json`：声明 Host 插件运行时依赖。Desktop 以本地 `link:` 方式安装时，依赖需要预先安装在链接目标目录中。
- `scripts/reload-plugin.mjs`：删除并重新安装 `file:` 插件快照。
- `scripts/check-deepseek-docs.mjs`：从 DeepSeek 英文 canonical 页面源码提取左侧导航目录并与仓库基线比较。
- `README.md`、`CHANGELOG.md`、`AGENTS.md`：使用说明、版本变化和维护规则。

## Contract 与关键约束

### DSH projection contract

- 内部 state schema 包含 `cumulative`、`today`、`todayStamp` 和 `pricingKnown`。
- 客户端 view schema 包含 `enabled`、`currencies`、`peakHours`、`cumulative`、`today` 和 `pricingKnown`，不暴露内部 `todayStamp`。
- 当前适配目标 DSH `v0.1.7-rc.2` 使用 `wire.viewSchema` 向客户端提供 projection 数据；缺少 `wire` 时，`useProjection("billingLedger")` 不会收到可渲染数据。
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
- 北京时间使用固定 UTC+8，不依赖宿主时区或夏令时；周六、周日始终为谷价。
- `cacheReadTokens` 和 `cacheWriteTokens` 按 cache-hit 价格，未缓存输入按 cache-miss 价格，输出按 output 价格。
- 模型必须同时具备启用币种的峰/谷、CNY/USD、cache hit/miss/output 完整价格才可计价。
- 未知模型或不完整价格返回 `null`，projection 将 `pricingKnown` 置为 `false`，不使用其他模型价格兜底。
- Vision 模型必须与官方价格表保持与 Flash 的同价约束；新增内置模型前须有完整且有依据的价格。

### 凭据与余额

- API Key 只在 Host 侧解析和使用，按 `.credentials.yaml`、credentials service、进程环境的顺序读取。
- API Key 不得进入 client bundle、projection、Session 日志、URL 或普通错误输出。
- 余额通过 Host 的 `/stats-decimal` loopback RPC 提供，客户端只收到余额数值、可用状态和安全错误标记。
- 余额失败、没有 Key 或没有对应币种余额时返回空值；余额读取独立于模型费用计价。

## 已知限制

- “今日”按会话日志最后一个自然日累计；打开较早历史会话时，不一定代表现实中的今天。
- 费用为本地估算，最终结果以 DeepSeek 官方账单为准。
- Web 端在 `conversation.composer.dock` 注册 `stats-decimal-billing`。由于 `ContextMeter` 位于 dock slot 外部、但仍是同一 footer 的后续兄弟节点，组件启用时允许 footer 换行，并通过 flex order 将费用排在完整原生统计栏之后作为独立第二行。行间距收紧到 4px，不添加背景装饰。卸载或关闭费用时恢复 footer 原来的 `flex-wrap` 和 `row-gap`。
- 余额依赖 DSH Host 能读取现有 `DEEPSEEK_API_KEY` 凭据，并依赖 DeepSeek `/user/balance` 的响应格式。
- 用户提供的运行时 DOM 显示 `ContextMeter` 是 `conversation.composer.dock` slot 的后续兄弟节点，因此仅增加 slot `order` 不能把费用放到它之后。当前客户端将费用排到 ContextMeter 后方作为独立第二行，使用 4px 行距且不加背景，Web 布局已由用户确认。Desktop 的本地目录管理器只链接仓库而不安装链接包依赖；插件仓库需先运行 `npm install --omit=dev --no-package-lock --ignore-scripts`，完整 Desktop Host 激活待重启验证。安装后还需检查 Desktop profile 的 `cordis.patch.yml` 是否启用了费用和币种；这些开关默认关闭。Desktop live run 与余额 RPC 尚未独立验证。

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

Desktop 手动验证必须从 Desktop 插件页安装到其保留的 `desktop` profile，在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 单独启用费用和币种配置，再重启 Desktop。检查原生 StatsPills 与费用行；余额 RPC 另行验证。不要通过 CLI 或 Web 的 reload 脚本操作保留的 Desktop profile。

## 后续计划

- 基于 `PRICE_HISTORY` 增加价格历史阶梯图，可按模型、币种、计费项及峰谷时段筛选。

## 发布检查

1. 运行 `npm run check:upstream`；如果英文 canonical 侧栏目录发生变化，打开新增页面，人工确认价格、生效时间和公告状态，再更新基线。
2. 确定版本号和发布日期，更新 `package.json`、`README.md`、`DEVELOPMENT.md` 和 `CHANGELOG.md`。
3. 核对 DSH projection、slot、locale 和 RPC contract；不凭经验扩大兼容范围。
4. 运行语法检查、计价回归和 `git diff --check`。
5. 用测试 profile 重新安装插件，确认原生 StatsPills、独立费用项、峰谷状态、未知模型和余额降级行为。
6. 确认 Git 中没有密钥、本地配置、缓存或辅助产物，再创建 tag/release。

### 上游文档检查

```powershell
npm run check:upstream
node scripts/check-deepseek-docs.mjs --snapshot
```

默认命令读取 `docs/deepseek-docs-baseline.json` 并报告差异：以不带语言前缀的英文站点 `https://api-docs.deepseek.com/` 为 canonical source，从首页发现最新新闻入口，再进入该新闻页源码提取完整左侧 `menu__link` 导航树。中文 URL 只作为在 canonical path 前添加 `/zh-cn` 的阅读引用，不单独抓取或维护第二套目录。`--snapshot` 输出当前结构化目录快照，供人工核对后更新基线。脚本不抓取 API 文档正文，也不会自动修改 `PRICE_HISTORY`。

## 维护流程

1. 修改前阅读 `README.md`、本文件、`CHANGELOG.md` 和 `AGENTS.md`。
2. DSH 升级时先核对对应源码 contract，再修改兼容声明或 projection 适配。
3. 用户可见变化写入 `CHANGELOG.md`；架构、限制或关键决策变化更新本文件。
4. 只有安装、配置或当前使用行为变化时才扩展 `README.md`。
5. Agent 为测试、诊断或验证生成的脚本、样例数据、日志和其他辅助文件统一放在 `.tools/`。
