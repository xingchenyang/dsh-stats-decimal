# dsh-stats-decimal v0.5.2

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-v0.1.7--rc.2-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

一个运行在 DeepSeek Harness Web 会话和 Desktop 内嵌 Web 界面中的 Cordis 插件。它保留 DSH 原生可展开统计，并追加 CNY/USD 消费、充值余额与当前计价时段。费用在 Host 侧按会话事件计算，余额通过 RPC 读取，API Key 不进入浏览器或 Session 日志。

## 特性

- 保留 DSH 0.1.7 原生 `StatsPills` 的轮次、速度、精确 token 和缓存命中详情。
- 独立显示消费/余额账本，不覆盖 DSH 原生 `stats` 项。
- 支持 CNY/USD 累计消费、最后一个会话自然日的消费和充值余额。
- 按事件发生时的历史价格、模型、缓存命中/未命中、输出 token 及北京时间工作日峰谷时段估算费用。
- 显示当前官方计价时段：`空闲时段 / 高峰时段`、`OFF-PEAK / PEAK`。
- 周六、周日固定按空闲时段；支持为已有或自定义模型覆盖完整价格表。
- 未配置价格的模型显示 `费用未知 / Cost unknown`，不套用其他模型价格。
- 费用和余额功能由配置开关控制，默认关闭。

## 文档

- [CHANGELOG.md](CHANGELOG.md)：版本与用户可见变化。
- [DEVELOPMENT.md](DEVELOPMENT.md)：架构、兼容性约束、测试与发布流程。
- [docs/PRICING_HISTORY.md](docs/PRICING_HISTORY.md)：历史价格、公告状态与官方来源。
- [docs/DEEPSEEK_NEWS_INDEX.md](docs/DEEPSEEK_NEWS_INDEX.md)：从官网侧栏整理的中英文新闻入口。
- [AGENTS.md](AGENTS.md)：自动化 Agent 和维护者必须遵守的仓库规则。

## 兼容性与结构

- 当前适配目标：DeepSeek Harness `v0.1.7-rc.2`。用户已确认 Web 端费用行排在原生统计 pills 和上下文圆环之后，作为紧凑、清晰的第二行显示。
- 插件使用 projection、slot 和 RPC contract；不据此承诺其他 DSH 版本。
- Desktop 使用同一 Web 界面，但插件和配置位于独立的 `desktop` profile。安装成功后仍需在该 profile 启用费用配置；详见下文。
- 源码为 ESM JavaScript，依赖 `@deepseek-ai/schemastery` 和 `zod`。

```text
lib/index.js             Host 插件、配置 schema、billingLedger projection、余额 RPC
lib/client.js            Web 费用/时段状态、本地化和余额轮询
lib/pricing.js           模型价格表、价格覆盖、费用计算和北京时间峰谷判断
cordis.patch.yml         Cordis bundle 注册入口
scripts/reload-plugin.mjs 删除并重新安装 file: 插件快照
```

## 显示内容

DSH 原生统计保持不变；插件在输入框下方的统计带中追加独立费用行，排在原生统计 pills 和上下文圆环之后。费用行紧接原生行显示，不加背景装饰。金额按两位小数直接截断，不四舍五入。

费用账本示例：

```text
高峰时段  CNY 累计 ¥3.55 · 今日 ¥0.95 · 余额 ¥27.21 | USD 累计 $0.50 · 今日 $0.13 · 余额 $0.00
PEAK  CNY Total ¥3.55 · Today ¥0.95 · Balance ¥27.21 | USD Total $0.50 · Today $0.13 · Balance $0.00
```

每个启用币种只出现一次；多币种用 `|` 分隔，单币种不显示分隔符。费用未知时显示 `费用未知 / Cost unknown`，不影响余额显示。

## 安装

支持命令行和插件页两类入口。命令行只用于 Web profile；插件页可以分别管理 Web 或 Desktop profile，并接受包名、GitHub 仓库地址或本地目录。

| 方式 | 目标 profile | 本插件安装验证 |
|---|---|---|
| CMD / PowerShell：`dsh plugin --profile web ...` | Web | 已验证 |
| 插件页：GitHub 仓库地址 | 当前打开的 Web 或 Desktop profile | 尚未验证 |
| 插件页：本地插件目录 | 当前打开的 Web 或 Desktop profile | 已验证；先安装源码目录依赖 |

### CMD / PowerShell 命令行安装（仅 Web；已验证）

`dsh plugin` 内部调用 pnpm；pnpm 必须在 PATH 中。若尚未安装 pnpm，在 CMD 中运行：

```cmd
npm install -g pnpm
```

在 PowerShell 中运行：

```powershell
npm.cmd install -g pnpm
```

在 CMD 中从插件源码目录的上一级执行：

```cmd
cd /d C:\PROJETS-PERSO
dsh plugin --profile web add file:./dsh-stats-decimal
dsh web
```

在 PowerShell 中执行相同的 Web profile 安装：

```powershell
Set-Location C:\PROJETS-PERSO
dsh plugin --profile web add file:./dsh-stats-decimal
dsh web
```

`file:./dsh-stats-decimal` 从当前 shell 目录解析，不从 profile 目录解析。`add` 会把插件写入 profile 并自动加入 `dsh.profile.bundles`，无需手动 insert。此命令管理 Web profile；官方 Desktop profile 由 Desktop 应用独占，不能用公共 `dsh` CLI 管理，参见 [Desktop 说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/apps/desktop/README.md)。

CLI 的 `file:` 安装与插件页的「本地目录」不同：前者由 profile 包管理器安装本地包及其依赖；后者登记为 `link:`，不会替链接目标安装依赖。

### 通过插件页安装 GitHub 仓库地址（尚未验证）

在目标应用的「插件」页打开添加插件流程，输入 GitHub 仓库地址，例如 `https://github.com/<owner>/<repository>`。DSH 会在当前 profile 中通过 pnpm 安装仓库包；仓库 `package.json` 中声明的运行时依赖也会随之安装。安装前请确认所选分支或标签已包含本插件所需的依赖声明。此方式尚未用本插件完成端到端验证；Git 仓库若带有 `prepare` 构建脚本，pnpm 可能要求先在 profile 中批准该脚本。

### 通过插件页安装本地目录（已验证）

插件页将本地目录登记为 `link:`；profile 安装器不会替链接目标安装 `package.json` 中的依赖。Web 与 Desktop profile 相互独立，不能依赖 Web profile 中碰巧已有的包。通过任一插件页添加本地目录前，在仓库根目录安装依赖。

CMD：

```cmd
cd /d C:\PROJETS-PERSO\dsh-stats-decimal
npm.cmd install --omit=dev --no-package-lock --ignore-scripts
```

PowerShell：

```powershell
Set-Location C:\PROJETS-PERSO\dsh-stats-decimal
npm.cmd install --omit=dev --no-package-lock --ignore-scripts
```

把依赖安装在链接目标中，可避免依赖恰好只存在某个 profile 的情况。

#### Web

在 Web 的「插件」页打开添加插件流程，选择「本地目录」，再选择本仓库根目录（其中包含 `package.json` 和 `cordis.patch.yml`）。此方式管理 Web profile；配置路径为 `$DSH_HOME\profiles\web\cordis.patch.yml`。

#### DeepSeek Harness Desktop

在 Desktop 自带的「插件」页打开添加插件流程，通过原生目录选择器选中本仓库根目录。Desktop 使用随应用提供的 pnpm，并独占 `$DSH_HOME\profiles\desktop`；安装、激活列表和配置都与 Web profile 分开。若 Desktop 已经链接到该目录，完成上一步后直接重启 Desktop；首次安装则在准备依赖后从 Desktop 插件页添加目录。安装后在 Desktop profile 配置并重启 Desktop。请勿用 `dsh plugin --profile desktop` 或本仓库的 Web 重装脚本操作 Desktop profile。

## 更新与卸载

使用 CLI 的 `file:` 方式安装后，修改源码时应重新安装并重启 DSH，让 profile 和 Host 重新加载插件：

```powershell
cd <插件源码目录的上一级>
dsh plugin --profile web remove dsh-stats-decimal
dsh plugin --profile web add    file:./dsh-stats-decimal
dsh web
```

推荐使用项目自带的一步脚本：

```powershell
cd C:\PROJETS-PERSO\dsh-stats-decimal
node scripts/reload-plugin.mjs                 # 默认 profile=web
node scripts/reload-plugin.mjs --profile web   # 显式指定
node scripts/reload-plugin.mjs --dry-run       # 只显示命令，不改动
```

脚本只更新 profile 的依赖和 `node_modules`，不修改 `cordis.patch.yml`。执行后仍需重启 `dsh web` 并硬刷新（Ctrl+F5）。Windows 上直接用 `node` 调用脚本，不受 PowerShell `.ps1` 执行策略影响；终端需要能写入 `$DSH_HOME\profiles\web`。

卸载：

```powershell
dsh plugin --profile web remove dsh-stats-decimal
```

如果 profile 的 `cordis.patch.yml` 仍有 `stats-decimal` 条目，建议一并删除；遗留条目不会影响重新安装。

通过插件页安装的本地目录，在对应应用的「插件」页移除旧条目，再重新选择本仓库根目录安装，以刷新已安装的包和依赖。Desktop 操作只在 Desktop 插件页完成，并在重装后重启 Desktop；Web CLI 和重装脚本只用于 Web profile。

## 配置

编辑 `$DSH_HOME\profiles\web\cordis.patch.yml`；文件不存在时新建，顶层必须是 YAML 数组。Desktop 则编辑 `$DSH_HOME\profiles\desktop\cordis.patch.yml`，使用相同配置：

```yaml
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
```

改完后重启 `dsh web` 并硬刷新（Ctrl+F5）。Desktop 改完后重启 Desktop。仅安装插件不会显示费用行，因为 `enableCost`、`cnyEnabled` 和 `usdEnabled` 默认都是 `false`；Web 与 Desktop 的配置互不继承。所有开关默认关闭：

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `enableCost` | `false` | 消费账本总开关 |
| `cnyEnabled` | `false` | 显示 CNY 片段 |
| `usdEnabled` | `false` | 显示 USD 片段 |
| `balance.enabled` | `false` | 在消费片段中追加余额 |
| `peakHours` | `[9,10,11,14,15,16,17]` | 北京时间工作日高峰钟点 |

消费行只有在 `enableCost=true` 且至少启用一个币种时显示。每个币种显示“累计/Total · 今日/Today”；余额开关打开后再追加“余额/Balance”。

### `peakHours`

填北京时间工作日的峰钟点（0–23）。例如北京峰时段为 9:00–12:00、14:00–18:00，则填写 `[9,10,11,14,15,16,17]`。计算使用固定 UTC+8，与宿主时区和冬夏令时无关；北京时间周六、周日始终按谷价。空数组表示全程谷价。

### 价格与模型

官方价格与历史查询入口：

- [人民币（CNY）价格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [美元（USD）价格表](https://api-docs.deepseek.com/quick_start/pricing/)
- [官网侧栏新闻目录](docs/DEEPSEEK_NEWS_INDEX.md)：部分独立新闻正文包含具体价格、优惠截止时间和调价生效时间。
- [中文更新日志](https://api-docs.deepseek.com/zh-cn/updates) / [英文更新日志](https://api-docs.deepseek.com/updates/)：主要用于核对模型迭代顺序；只有明确出现价格内容时才作为价格证据。

内置价格表覆盖：

- `deepseek-flash`
- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash-vision-exp`（与 Flash 同价）

两个旧 Flash 名称仍可调用，但由 DeepSeek-V4.1-Flash 提供服务并按当前 Flash 价格计费，因此三个 Flash ID 的当前价格相同。重放旧会话时，插件会根据每条消息的发生时间选择当时已经生效的价格；模型尚未发布或价格资料不完整的时间段显示费用未知，不用当前价格倒推。

内置历史价格及公告依据见 [价格历史档案](docs/PRICING_HISTORY.md)。其中 2026 年 9 月 14 日将 Pro 路由至 Flash 的原计划已经撤回，不构成计费断点；`deepseek-v4-pro` 继续按 Pro 价格计费。

将以下内容放在前例的 `config` 下；`overridePricing` 可覆盖已有模型或添加其他模型：

```yaml
overridePricing:
  my-model:
    cny:
      peak: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 }
      valley: { cacheHit: 0.02, cacheMiss: 1.0, output: 4.0 }
    usd:
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
      valley: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }
```

每个启用币种都必须有 `peak` 和 `valley` 下的 `cacheHit`、`cacheMiss`、`output` 三项价格，否则该模型费用显示未知。

### 余额

- 不需要配置 `apiKey`；Host 按 DSH 的凭据优先级复用 `DEEPSEEK_API_KEY`（包括 `$DSH_HOME\.credentials.yaml`）。
- API Key 只在 Host 侧解析和使用，不进入浏览器、projection 或 Session 日志。
- 页面加载时读取一次，之后每 5 分钟轮询；刷新页面即可手动刷新。
- Key 为空、请求降级或该币种没有余额时显示 `余额 – / Balance –`。

## 注意事项

- “今日”按会话日志中最后一个自然日统计；打开较早的历史会话时，它不一定代表现实中的今天。
- 费用是基于本地 token 统计和价格表的估算，最终金额以 DeepSeek 官方账单为准。
- 余额是官方 API 的独立数据；模型价格未知不会隐藏或改变 DeepSeek API 返回的余额。

## 项目边界与 License

这是一个独立的个人项目，与 DeepSeek、DeepSeek Harness 或 OpenAI 官方没有隶属、合作或背书关系。部分实现和文档使用 AI 辅助开发。项目按 [MIT License](LICENSE) 发布。
