# Development Guide

本文档保存项目的技术背景、关键决策和接手信息。安装与配置见 `README.md`，用户可见变化见 `CHANGELOG.md`，维护约束见 `AGENTS.md`。

## 当前状态

- 当前版本：`0.5.0`。
- 兼容目标：DeepSeek Harness `v0.1.5-rc.1`。
- 本机安装验证基线：顶层 `@deepseek-ai/dsh` 为 `0.1.5-rc.1`；其 caret 依赖当前实际解析为 `0.1.5-rc.2`（包括 session projection、token meter、Web UI、DeepSeek LLM adapter 与 JSONL persistence）。兼容声明指这套由 rc.1 安装出的实际依赖树，不外推到其他解析结果。
- 技术栈：ESM JavaScript、Cordis Host/Web bundle、`@deepseek-ai/schemastery`、`zod`。
- 费用 projection 的客户端可见状态版本：`stateVersion: 4`。
- 不保证兼容更早或其他 DSH 版本；升级 DSH 时必须重新验证 projection、slot、locale 和 RPC contract。

## 架构与数据流

1. Host 侧 `billingLedger` 折叠 `assistant/message` 的 usage 事件。
2. `lib/pricing.js` 先按事件时间选择当时有效的模型价格，再按缓存桶、输出 token 及北京时间工作日峰谷计算费用。
3. projection 通过 `wire.viewSchema` 将累计消费、当日消费、启用币种和计价状态传给 Web。
4. Web 客户端保留 DSH 原生 `StatsPills`，用独立 slot 项读取 `billingLedger` 并渲染消费账本和当前计价时段。
5. 余额走独立的 loopback RPC `/stats-decimal`；Host 调用 DeepSeek `/user/balance`，浏览器不接触 API Key。

余额不写入 Session。Session 日志拒绝未知事件类型，而 projection 已足以提供会话累计数据；因此不向 Session 追加插件自定义余额事件。

## 代码地图

- `lib/index.js`：Host 插件、配置 schema、`billingLedger` projection、余额 RPC 和凭据读取。
- `lib/client.js`：Web 费用/时段状态、本地化和余额轮询。
- `lib/pricing.js`：历史价格区间、公告档案、价格覆盖、费用计算及北京时间峰谷判断。
- `docs/PRICING_HISTORY.md`：历史价格证据、时间精度和公告修订说明。
- `docs/DEEPSEEK_NEWS_INDEX.md`：官网没有总入口时使用的中英文新闻目录。
- `cordis.patch.yml`：Cordis bundle 注册入口。
- `scripts/reload-plugin.mjs`：删除并重新安装 `file:` 插件快照。
- `scripts/check-deepseek-docs.mjs`：从 DeepSeek 英文 canonical 页面源码提取左侧导航目录并与仓库基线比较。
- `README.md`、`CHANGELOG.md`、`AGENTS.md`：使用说明、版本变化和维护规则。

## Contract 与关键约束

### DSH projection contract

- 内部 state schema 包含 `cumulative`、`today`、`todayStamp` 和 `pricingKnown`。
- 客户端 view schema 包含 `enabled`、`currencies`、`peakHours`、`cumulative`、`today` 和 `pricingKnown`，不暴露内部 `todayStamp`。
- 当前 DSH 版本要求 projection 通过 `wire.viewSchema` 向客户端提供数据；缺少 `wire` 时，`useProjection("billingLedger")` 不会收到可渲染数据。
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
- Web 端在 `conversation.composer.dock` 注册独立的 `stats-decimal-billing` 项，不覆盖官方 `stats` 项。
- 余额依赖 DSH Host 能读取现有 `DEEPSEEK_API_KEY` 凭据，并依赖 DeepSeek `/user/balance` 的响应格式。
- 当前只保证 DSH `v0.1.5-rc.1`；其他版本需要重新验证后才能更新兼容声明。

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

随后硬刷新 Web 页面，检查原生 StatsPills、累计/今日费用、未知模型状态、余额展示、官方峰谷状态和布局。

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
