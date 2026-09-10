# dsh-stats-decimal v0.4.0

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-v0.1.2--rc.1-4D6BFE)](https://github.com/deepseek-ai)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/license-MIT-2EA44F)](LICENSE)

一个运行在 DeepSeek Harness Web 会话中的 Cordis 插件。它修正内置统计栏的数字精度，并可追加 CNY/USD 消费与充值余额账本。费用在 Host 侧按会话事件计算，余额通过 loopback RPC 读取，API Key 不进入浏览器或 Session 日志。

## 特性

- 缓存命中率、K/M/G token 数和金额均按两位小数直接截断，永不四舍五入。
- 将会话摘要、token 统计和消费/余额账本分行显示，避免关键数字被省略。
- 支持 CNY/USD 累计消费、最后一个会话自然日的消费和充值余额。
- 按模型、缓存命中/未命中、输出 token 及北京时间工作日峰谷时段估算费用。
- 周六、周日固定按谷价；支持为已有或自定义模型覆盖完整价格表。
- 未配置价格的模型显示 `费用未知 / Cost unknown`，不套用其他模型价格。
- 精度修复始终生效；费用和余额功能由配置开关控制，默认关闭。

## 文档

- [CHANGELOG.md](CHANGELOG.md)：版本与用户可见变化。
- [DEVELOPMENT.md](DEVELOPMENT.md)：架构、兼容性约束、测试与发布流程。
- [AGENTS.md](AGENTS.md)：自动化 Agent 和维护者必须遵守的仓库规则。

## 兼容性与结构

- 当前唯一保证的 DeepSeek Harness 版本：`v0.1.2-rc.1`。
- 插件直接使用该版本的 projection、slot 和 RPC contract，不保证更早或其他版本。
- 运行目标为 DSH Web profile；源码为 ESM JavaScript，依赖 `@deepseek-ai/schemastery` 和 `zod`。

```text
lib/index.js             Host 插件、配置 schema、billingLedger projection、余额 RPC
lib/client.js            Web 统计栏、数字格式化、本地化和余额轮询
lib/pricing.js           模型价格表、价格覆盖、费用计算和北京时间峰谷判断
cordis.patch.yml         Cordis bundle 注册入口
scripts/reload-plugin.mjs 删除并重新安装 file: 插件快照
```

## 显示内容

精度修复示例：

| 项目 | 内置显示 | 修复后 |
|---|---|---|
| 缓存命中 | `99%` 或 `100%` | `99.78%` |
| 输入 token | `124.6M` | `124.66M tok` |
| 输出 token | `236.2K` | `236.18K tok` |

缓存命中率使用整数运算截断到两位小数，只有真实达到 100% 时才显示 `100.00%`。K/M/G 量级的 token 恒显示两位小数并截断，少于 1000 token 时显示整数。

费用账本示例：

```text
CNY 累计 ¥3.55 · 今日 ¥0.95 · 余额 ¥27.21 | USD 累计 $0.50 · 今日 $0.13 · 余额 $0.00
CNY Total ¥3.55 · Today ¥0.95 · Balance ¥27.21 | USD Total $0.50 · Today $0.13 · Balance $0.00
```

每个启用币种只出现一次；多币种用 `|` 分隔，单币种不显示分隔符。费用未知时显示 `费用未知 / Cost unknown`，不影响余额显示。

## 安装

依赖 pnpm（`dsh plugin` 内部调用）。如果新开的 PowerShell 窗口被执行策略拦截，可先运行：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
npm install -g pnpm
```

先进入插件源码目录的上一级，再用相对路径安装：

```powershell
cd <插件源码目录的上一级>        # 例如 C:\PROJETS-PERSO
dsh plugin --profile web add file:./dsh-stats-decimal
```

`file:./dsh-stats-decimal` 从当前 shell 目录解析，不从 profile 目录解析。`add` 会把插件写入 profile 并自动加入 `dsh.profile.bundles`，无需手动 insert。

## 更新与卸载

`file:` 安装的是复制快照。修改源码后，必须先删除旧快照，再重新安装并重启 DSH：

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

## 配置

编辑 `$DSH_HOME\profiles\web\cordis.patch.yml`；文件不存在时新建，顶层必须是 YAML 数组：

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

改完后重启 `dsh web` 并硬刷新（Ctrl+F5）。所有开关默认关闭：

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `enableCost` | `false` | 消费账本总开关 |
| `cnyEnabled` | `false` | 显示 CNY 片段 |
| `usdEnabled` | `false` | 显示 USD 片段 |
| `balance.enabled` | `false` | 在消费片段中追加余额 |

精度修复不受这些开关影响。消费行只有在 `enableCost=true` 且至少启用一个币种时显示。每个币种显示“累计/Total · 今日/Today”；余额开关打开后再追加“余额/Balance”。

### `peakHours`

填北京时间工作日的峰钟点（0–23）。例如北京峰时段为 9:00–12:00、14:00–18:00，则填写 `[9,10,11,14,15,16,17]`。计算使用固定 UTC+8，与宿主时区和冬夏令时无关；北京时间周六、周日始终按谷价。空数组表示全程谷价。

### 价格与模型

内置价格表覆盖：

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash-vision-exp`（与 Flash 同价）

将以下内容放在前例的 `config` 下；`overridePricing` 可覆盖已有模型或添加其他模型：

```yaml
overridePricing:
  my-model:
    cny:
      peak: { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 }
      valley: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 }
    usd:
      peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 }
      valley: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }
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
