# dsh-stats-decimal

DSH（DeepSeek Harness）web 客户端插件：修正会话统计条的数字精度。

## 问题

- 「缓存命中」只显示整数百分比：99.75% 显示成 100%，99.42% 显示成 99%；即便补上小数位，四舍五入也会把 99.9999% 进位成 100.00%（虚高）；
- 输入/输出 token 数在 K/M 量级只显示一位小数（`40.9M`、`202K`）——基数大时 0.01 也代表大量 token，不应省略。

## 位置

`@deepseek-ai/dsh-client-ui-conversation` 浏览器包 `lib/client.js` 的 `cacheHitPercent`：

```js
return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100);
```

`Math.round(... * 100)` 直接取整；token 格式化同样丢失了小数位。

## 修改

以客户端插件接管 `conversation.composer.dock` 槽的 `stats` 条目（同 `id`、更低 `priority` 遮蔽内置行），整行重绘：

- 缓存命中：整数运算截断到两位小数（`Math.floor(cacheRead * 10000 / denominator)`），永不进位 → 99.9999% 显示 `99.99%`，只有真 100% 才显示 `100.00%`；
- 输入/输出：K/M 量级恒两位小数、截断 → `40.90M`、`202.00K`；< 1000 无单位显示整数（`131 tok`）；
- 两行布局：第 1 行轮数/耗时/速度，第 2 行缓存命中/输入输出；
- 去掉截断省略号与 hover tooltip，完整输出，每行不换行。

## 安装

```powershell
# 在插件目录的上一级执行
dsh plugin --profile web add file:./dsh-stats-decimal
```

然后编辑 `$DSH_HOME\profiles\web\cordis.patch.yml`（`$DSH_HOME` 默认 `~/.dsh`）追加：

```yaml
- insert:
    - id: stats-decimal
      name: 'dsh-stats-decimal'
```

重启 `dsh web` 并硬刷新浏览器。

## 卸载

删除 `cordis.patch.yml` 中的插入行，执行 `dsh plugin --profile web remove dsh-stats-decimal`，重启。

## License

[MIT](LICENSE)
