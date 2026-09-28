# Changelog

本文件记录面向使用者的功能变化。开发背景与技术决策见 `DEVELOPMENT.md`。

格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [0.5.4] - 2026-09-28

### Added

- 支持在没有 `DEEPSEEK_API_KEY` 时，通过 DSH `deepseekAccount` Host 服务读取账户登录模式的充值余额；保留 API Key 路径优先级，不读取或传递账户 token。

### Changed

- 将适配目标更新为 DSH `v0.2.0-rc.1`。
- 补充 Desktop GitHub 插件更新方式：在「添加插件」中再次填写同一仓库 URL，更新后重启 Desktop。
- 记录本次观察到的状态不一致：pnpm 显示 `Done` 且插件版本更新后，界面仍可能提示“无法从依赖变更中确定安装了哪一个包”；核对安装详情、版本并重启以确认实际结果。

## [0.5.3] - 2026-09-26

### Fixed

- 修复余额不显示：改用 Connection 的共享 `/api` 精确路由，避开 DSH 组合 profile 中 `rpc.handle()` 的 Host 路由注册问题；并在费用行挂载后立即发起首次读取。

## [0.5.2] - 2026-09-26

### Changed

- 明确按运行环境划分插件管理方式：Web 使用 CMD/PowerShell 命令行；Desktop 使用主应用「插件」页面中的「添加插件」功能。GitHub 安装后需重启 Desktop。

### Fixed

- 补齐 Host 直接导入的运行时依赖，并记录 Desktop 的依赖处理差异：本地 `link:` 安装前需在源码目录安装依赖，GitHub 安装则由 profile pnpm 按插件清单安装。

## [0.5.1] - 2026-09-26

### Changed

- 更新 DSH 适配目标为 `v0.1.7-rc.2`，记录 Web 端费用行已实际显示，并补充 Desktop 独立 profile 的安装、配置和重启说明。

### Fixed

- 将费用排在输入框下方的两项原生统计之后作为独立第二行，并收紧行距，不增加背景装饰。

## [0.5.0] - 2026-09-12

### Added

- 新增 DeepSeek-V4.1-Flash 的 `deepseek-flash` 模型及当前 CNY/USD 峰谷价格。
- 在费用区域显示官方计价时段名称：`空闲时段 / 高峰时段`、`OFF-PEAK / PEAK`。
- 增加 DeepSeek 官方人民币与美元价格表链接及计价回归测试。
- 增加 V4 系列结构化历史价格与公告档案；重放旧会话时按消息发生时间计价，为后续价格历史阶梯图提供统一数据源。

### Changed

- 兼容目标升级为 DeepSeek Harness `v0.1.5-rc.1`。
- 两个旧 Flash 模型名继续作为兼容别名，并统一使用当前 V4.1 Flash 价格；V4 Pro 价格保持不变。
- 保留 DSH 原生可展开 `StatsPills`，插件改为注册独立费用项，不再覆盖原生 `stats`。
- 默认北京时间高峰钟点改为官方工作日 `[9,10,11,14,15,16,17]`。
- 费用 projection 状态版本更新为 `4`，使已有会话按历史价格区间重新折叠，而不是统一套用当前价格。
- 记录 2026 年 9 月 14 日 Pro 路由计划已经撤回；该日期不改变 `deepseek-v4-pro` 的价格。
- 增加 DeepSeek 中英文更新日志入口，便于后续核对价格生效日期与公告修订。
- 保存 DeepSeek 官网侧栏新闻目录，并为价格相关公告配对中文、英文官方链接。
- 增加上游侧栏目录差异检查脚本，在升级时从英文 canonical 页面源码发现新增、移除、改名或重新排序的入口；中文链接由相同路径派生，不读取正文或自动修改计费数据。
- 统一 README、DEVELOPMENT 和 CHANGELOG 的文档结构，补充文档导航、架构状态、验证入口和发布检查。

## [0.4.0] - 2026-09-07

### Added

- 以 DeepSeek Harness `v0.1.2-rc.1` 为当前兼容目标，不保证向下兼容。
- 明确支持 `deepseek-v4-flash-vision-exp`，价格与 `deepseek-v4-flash` 一致。
- 北京时间周六、周日固定按谷价计算。
- `overridePricing` 可以为未内置的模型添加完整价格配置。

### Changed

- 未配置价格的模型不再套用 Flash 价格，费用改为显示“费用未知 / Cost unknown”。
- 模型价格未知时，DeepSeek API 返回的 CNY/USD 余额仍正常显示。
- 费用 projection 状态版本更新为 `2`。

## [0.3.2] - 2026-09-01

### Added

- 增加 `scripts/reload-plugin.mjs`，用于在 Windows 上重新安装本地插件快照。

### Fixed

- 适配 DSH `v0.1.1-rc.2` 的 `wire.viewSchema` projection contract，修复成本/余额行消失。

## [0.3.1] - 2026-08-22

### Fixed

- 修复跨自然日后“今日消费”没有随事件日期重置的问题。
- 补全计价、币种和余额配置的默认值与开关行为。

## [0.3.0] - 2026-08-21

### Added

- 增加 CNY/USD 会话累计消费、当日消费和充值余额账本。
- 根据模型、缓存命中/未命中、输出 token 及北京时间峰谷时段估算费用。
- 从 DSH 凭据自动复用 `DEEPSEEK_API_KEY`，由 Host 通过 loopback RPC 查询官方余额，密钥不进入浏览器。
- 增加价格覆盖、币种开关、余额开关和峰时段配置。

## [0.2.0] - 2026-08-21

### Changed

- 缓存命中率和 K/M/G token 数改为两位小数截断，避免进位造成虚高。
- 将运行摘要和 token 账本拆分为两行，避免省略关键数字。
- 增加 MIT License 并整理安装说明。

## [0.1.0] - 2026-08-21

### Added

- 建立 Cordis Host 插件和 Web client bundle。
- 通过同名 `stats` slot 覆盖 DSH 内置会话统计栏。
- 增加初始安装、配置说明和 bundle patch。
