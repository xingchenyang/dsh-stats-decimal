# dsh-stats-decimal

DSH（DeepSeek Harness）web 客户端插件：把会话统计条里的「缓存命中」从整数百分比改成两位小数（`99%` → `99.20%`），并把统计条改成两行布局：

```
6 轮 · 172 步 | LLM 30m8s · 工具调用 3m41s | 首 token 平均 2.4s · 137 tok/s
缓存命中 99.20% | 输入 40.90M tok · 输出 191K tok
```

- 缓存命中保留两位小数（`Math.round(x * 10000) / 100` 再 `toFixed(2)`）；
- 输入/输出在 K/M 量级、数值 < 100 时也显示两位小数（`40.90M`、`78.60K`），≥ 100 时取整（`191K`）；
- 去掉内置的截断省略号和 hover tooltip——直接完整输出，每行不换行；
- 字号/颜色/间距沿用内置 `StatsLine.module.css`（12px、三级文字色、居中、分隔符带边距）。

## 根因

`@deepseek-ai/dsh-client-ui-conversation` 的浏览器包在 `lib/client.js` 里计算命中率：

```js
return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100);
```

`Math.round(... * 100)` 直接取整：99.75% 显示成 100%，99.42% 显示成 99%。
插件没有官方「替换某行代码」的钩子，但 slot 注册表对 list 槽按 cell（`id`）遮蔽：
同一个 `conversation.composer.dock` 槽里，注册相同 `id: "stats"`、更低 `priority` 的条目会盖掉内置统计行。
本插件据此接管整条统计行。

## 安装（web profile）

```powershell
# 1) 把插件装进 web profile 的 node_modules（在插件目录的上一级执行）
dsh plugin --profile web add file:./dsh-stats-decimal

# 2) 在 profile 的用户 patch 层启用它：
#    编辑 $DSH_HOME\profiles\web\cordis.patch.yml（$DSH_HOME 默认是 ~/.dsh），追加：
#    - insert:
#        - id: stats-decimal
#          name: 'dsh-stats-decimal'
#
#    （二选一：也可以把 "dsh-stats-decimal" 加进 profiles\web\package.json 的
#     dsh.profile.bundles —— 本包自带 dsh.bundle.patch 与 cordis.patch.yml。）

# 3) 重启 dsh web（重新组合 loader 树与客户端 boot 图），浏览器硬刷新（Ctrl+Shift+R）
```

验证：统计条显示 `缓存命中 99.20%` 这类带两位小数的值，且为两行布局。

卸载：从 `cordis.patch.yml` 删掉该行（或从 bundles 移除），然后
`dsh plugin --profile web remove dsh-stats-decimal`，重启即可。

## 项目结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.client`（web 平台客户端包声明）、`dsh.bundle`（可选 bundle 补丁）、`exports["./client"]` |
| `lib/index.js` | node 半部：空 `apply`，仅让 loader 能导入 |
| `lib/client.js` | 浏览器半部：`window.__ModuleLoader__.load(...)` 工厂格式，注册遮蔽条目 |
| `cordis.patch.yml` | loader 行插入（bundle 路线用） |

无需任何构建工具：客户端包直接写成官方发布包同款的 `__ModuleLoader__.load({ id, factory })` 格式。

## 更快的临时方案（不写插件，2 分钟）

直接改安装包里同一处（你机器上 `dsh-client-ui-conversation` 包可能有多个副本，例如 dsh 安装目录与 profile 目录各一份，内容一致，建议都改）：

```js
// 改前
return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100);
// 改后
return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 10000) / 100;
```

重启 `dsh web` + 硬刷新。缺点：升级 `@deepseek-ai/dsh` 后会被覆盖，需要重打。

## License

MIT
