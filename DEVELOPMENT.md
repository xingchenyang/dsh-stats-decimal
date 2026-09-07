# Development Guide

本文档保存项目的技术背景、关键决策和接手信息。安装与配置见 `README.md`，用户可见变化见 `CHANGELOG.md`。

## 当前状态

- 插件版本：`0.4.0`。
- 兼容目标：DeepSeek Harness `v0.1.2-rc.1`。
- 不保证兼容更早版本；升级 DSH 时必须重新验证 projection、slot、locale 和 RPC contract。

## 文件职责

- `lib/index.js`：Host 插件、配置 schema、`billingLedger` projection、余额 RPC 和凭据读取。
- `lib/client.js`：Web 统计栏、数字格式化、本地化和余额轮询。
- `lib/pricing.js`：模型价格表、价格覆盖、费用计算及北京时间峰谷判断。
- `cordis.patch.yml`：Cordis bundle 注册入口。
- `scripts/reload-plugin.mjs`：删除并重新安装 `file:` 插件快照。
- `README.md`、`CHANGELOG.md`、`AGENTS.md`：使用说明、版本变化和 Agent 维护规则。

## 数据流

1. Host 侧 `billingLedger` 折叠 `assistant/message` 的 usage。
2. `lib/pricing.js` 按模型、币种、北京时间工作日峰谷时段计算消费。
3. projection 通过 `wire.viewSchema` 将累计和当日消费传给 Web。
4. Web 客户端用 `useProjection("billingLedger")` 显示费用。
5. 余额走独立的 loopback RPC `/stats-decimal`；Host 调用 DeepSeek `/user/balance`，浏览器不接触 API Key。

## 必须保持的设计约束

- 所有百分比、token 简写和金额均直接截断，不四舍五入。
- 缓存命中率只有真实达到 100% 时才能显示 `100.00%`。
- 北京时间按固定 UTC+8 计算，不依赖宿主时区或夏令时；周六、周日始终为谷价。
- 未配置价格的模型费用必须显示未知，不得静默套用其他模型价格。
- 模型费用是否可计算不得影响余额；余额是官方 API 返回的独立数据。
- DeepSeek API Key 只能留在 Host，不得进入 client bundle、projection 或 Session 日志。
- 不向 Session 写入插件自定义余额事件，以免未知持久化事件破坏会话重放。

## 演进概览

- 初始版本：建立 Cordis Host/Web 插件并覆盖内置统计栏。
- 精度增强：缓存命中率和 token 简写改为两位小数截断，统计拆为两行。
- 费用账本：加入 CNY/USD 累计、当日消费、模型价格、峰谷计价及官方余额。
- 稳定性：修复跨日状态并适配 projection 的 `wire.viewSchema` contract。
- 当前版本：支持 DSH `v0.1.2-rc.1`、北京时间周末谷价、Vision 定价、自定义模型价格和未知模型保护。

具体版本变化见 `CHANGELOG.md`，逐次修改记录以 Git 历史为准。

## 已知限制

- “今日”按会话日志最后一个自然日累计；打开较早的历史会话时，不一定代表现实中的今天。
- 费用为本地估算，最终结果以 DeepSeek 官方账单为准。
- Web 端通过同名 `stats` slot 覆盖官方统计组件；DSH UI contract 变化时可能需要适配。

## 验证

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
- Vision 与 Flash 内置价格完全一致。
- 未知模型的 `costOf()` 返回 `null`。
- 通过 `overridePricing` 添加的模型可以正常计算。

安装验证：

```powershell
node scripts/reload-plugin.mjs --profile web
dsh web
```

随后硬刷新 Web 页面，检查 token 精度、累计/今日费用、未知模型状态和余额展示。

## 维护流程

1. 修改前阅读 `README.md`、本文件、`CHANGELOG.md` 和 `AGENTS.md`。
2. DSH 升级时先核对官方 release 和源码 contract，再修改兼容声明。
3. 用户可见变化写入 `CHANGELOG.md`；架构或约束变化更新本文件。
4. 提交或发布前确认文档、日期与 `package.json` 版本一致。
