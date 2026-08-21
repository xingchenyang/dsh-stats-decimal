# dsh-stats-decimal

DSH（DeepSeek Harness）web 会话统计条的增强插件。它做两件事：**修正内置统计栏的数字精度**（最初的目的），并**追加一行分币种消费/余额账本**。

## 一、修正数字精度（插件初衷）

官方内置统计条有两处丢精度：

1. **缓存命中 % 只显示整数**：`99.75%` 显示成 `100%`，`99.42%` 显示成 `99%`；即便补小数，四舍五入也可能把 `99.9999%` 进位成 `100.00%`（虚高）。
2. **token 数在 K/M 量级只保留一位小数**：`124.6M`、`236.2K`；基数很大时 0.01 也代表大量 token，省略会明显失真。

本插件整行重绘，用**整数运算截断到两位小数、永不进位**修复：

| 项目 | 内置 | 修复后 |
|---|---|---|
| 缓存命中 | `99%`（100%）| `99.78%` |
| 输入 token | `124.6M` | `124.66M tok` |
| 输出 token | `236.2K` | `236.18K tok` |

修复原则：
- 缓存命中：`Math.floor(cacheRead * 10000 / billed)` → 两位小数截断，**永不进位**，只有真 100% 才显示 `100.00%`。
- token：K/M 量级恒两位小数、截断；< 1000 显示整数（`131 tok`）。
- 两行布局（摘要 + token 账本），去掉省略号与 hover tooltip，每行不换行。

## 二、第三行消费/余额账本

在新加的一行里，按 CNY / USD 显示会话**累计消费、今日消费、充值余额**：

```
CNY 累计 ¥3.55 · 今日 ¥0.95 · 余额 ¥27.21| USD 累计 $0.50 · 今日 $0.13 · 余额 $0.00
CNY Total ¥3.55 · Today ¥0.95 · Balance ¥27.21 | USD Total $0.50 · Today $0.13 · Balance $0.00
```

（上：中文界面；下：英文界面。）

- 金额 **2 位小数、直接截断**（不四舍五入）。
- 每个启用币种出现一次；多币种间用 `|` 分隔，单币种无 `|`。
- 会话累计 = 全程消费；今日 = 当天消费；余额 = 官方账号充值余额。

## 安装

> 依赖 pnpm（`dsh plugin` 内部调用）。若未安装，需允许 npm 脚本执行（**每次新开窗口跑 `.ps1` 都可能需要**）：
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
> npm install -g pnpm
> ```

先 `cd` 到插件源码目录的**上一级**，再用相对路径安装：

```powershell
cd <插件源码目录的上一级>        # 例如 cd C:\...\dsh-stats-decimal 的父目录
dsh plugin --profile web add file:./dsh-stats-decimal
```

> `file:./dsh-stats-decimal` 的 `./` **从当前 shell 目录解析**（不是 profile 目录），所以先 `cd` 到插件父目录即可，无需写绝对路径。

`add` 会把插件写进 profile 并自动加入 `dsh.profile.bundles`（自注册 bundle），**不需要**手动 insert。

## 更新

改源码后，`file:` 是**复制快照**，必须**先删除再安装**才生效：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process   # 若本窗口未设过
cd <插件源码目录的上一级>
dsh plugin --profile web remove dsh-stats-decimal        # 第 1 步：删除旧版
dsh plugin --profile web add    file:./dsh-stats-decimal  # 第 2 步：安装新版
dsh web                                                   # 第 3 步：重启
```

> 少跑任何一步都不行：只 `add` 不 `remove` 会因快照未刷新而用旧代码；`add` 前也需 `Set-ExecutionPolicy`（`dsh plugin` 内部走 pnpm/npm 脚本）。若 profile 的 `cordis.patch.yml` 里已写了 `stats-decimal` 条目，`remove` 不会删它，重装后仍命中，无需改。

## 卸载

```powershell
dsh plugin --profile web remove dsh-stats-decimal
# 可选清理：若 cordis.patch.yml 还留了 stats-decimal 条目，忘删也无影响，仅建议删除以保持整洁
```

## 配置（编辑 `cordis.patch.yml`）

`$DSH_HOME\profiles\web\cordis.patch.yml`（不存在就新建，顶层必须 YAML 数组）。

```yaml
- id: stats-decimal
  name: 'dsh-stats-decimal'
  config:
    enableCost: true                    # 第三行账本总开关
    cnyEnabled: true                    # 显示 CNY
    usdEnabled: true                    # 显示 USD
    peakHours: [9, 10, 11, 14, 15, 16, 17]  # 北京峰时段；空=全程谷价
    balance:
      enabled: true                     # 显示余额
```

改完重启 `dsh web` 并硬刷新（Ctrl+F5）生效。

## 关键 bool 逻辑（默认全关）

| 开关 | 默认 | 作用 |
|---|---|---|
| `enableCost` | false | 第三行账本总开关；false 则整行不显示 |
| `cnyEnabled` | false | 是否显示 CNY 片段 |
| `usdEnabled` | false | 是否显示 USD 片段 |
| `balance.enabled` | false | 是否追加 `余额/Balance` |

- 精度修复（第一部分）**始终生效**，不受开关影响。
- 第三行只在 `enableCost` 且至少一个币种为 true 时显示。
- 某币种片段 = `累计/Total · 今日/Today` +（若 `balance.enabled`）`· 余额/Balance`。

### 余额

- **Key 自动复用**：无需配 `apiKey`，直接读 DSH 现有 `DEEPSEEK_API_KEY`（`$DSH_HOME/.credentials.yaml`）——DeepSeek 平台 Key 只可复制一次，正因此复用已有凭据。
- **显示**：`balance.enabled=true` 时有值显示数值；Key 空/降级/该币种无余额 → `Balance –`。
- **刷新**：页面加载拉一次，之后每 5 分钟轮询（`lib/client.js` 的 `BALANCE_REFRESH_MS`）。刷新页面即手动刷新。

### `peakHours`（北京时间峰谷）

填**北京时间**峰钟点（0-23），例：北京峰 9:00–12:00、14:00–18:00 → `[9,10,11,14,15,16,17]`。按固定 UTC+8 换算，与宿主时区/冬夏令时无关；空则全程谷价。峰谷价默认来自 `lib/pricing.js` 官方价目，可用 `overridePricing` 覆盖。

## License

[MIT](LICENSE)
