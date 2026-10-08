# DeepSeek API News Index

The DeepSeek API documentation site has no single news landing page; its sidebar provides the news directory. This file records the official news links shown there for later checks of model, price, and billing-rule changes.

The English site without a language prefix is the canonical source. Chinese pages use the same path with a `/zh-cn` prefix. Both language links are retained below; the automated directory check reads only the English sidebar.

| Date | Topic | Pricing information | Chinese page | English page |
| --- | --- | --- | --- | --- |
| 2026-09-10 | DeepSeek-V4.1-Flash release | States the new Flash prices and effective time | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news260910/) | [English](https://api-docs.deepseek.com/news/news260910/) |
| 2026-08-21 | DeepSeek-V4-Flash-Vision-Exp launch | States that it has the same price as Flash | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news260821/) | [English](https://api-docs.deepseek.com/news/news260821/) |
| 2026-08-13 | DeepSeek-V4-Pro general availability | Peak/off-peak price change and exact effective time | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news260813/) | [English](https://api-docs.deepseek.com/news/news260813/) |
| 2026-04-24 | DeepSeek-V4 Preview release | Launch price table appears in an article image | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news260424/) | [English](https://api-docs.deepseek.com/news/news260424/) |
| 2025-12-01 | DeepSeek-V3.2 general release | States that temporary Speciale pricing is unchanged | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news251201/) | [English](https://api-docs.deepseek.com/news/news251201/) |
| 2025-09-29 | DeepSeek-V3.2-Exp release | Immediate price cut of more than 50%; price table is an image | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250929/) | [English](https://api-docs.deepseek.com/news/news250929/) |
| 2025-09-22 | DeepSeek V3.1 update | No pricing change found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250922/) | [English](https://api-docs.deepseek.com/news/news250922/) |
| 2025-08-21 | DeepSeek V3.1 release | New prices and the effective time for ending the overnight discount | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250821/) | [English](https://api-docs.deepseek.com/news/news250821/) |
| 2025-05-28 | DeepSeek-R1-0528 release | No pricing change found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250528/) | [English](https://api-docs.deepseek.com/news/news250528/) |
| 2025-03-25 | DeepSeek-V3-0324 release | No pricing change found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250325/) | [English](https://api-docs.deepseek.com/news/news250325/) |
| 2025-01-20 | DeepSeek-R1 release | States all three CNY/USD rates | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250120/) | [English](https://api-docs.deepseek.com/news/news250120/) |
| 2025-01-15 | DeepSeek app launch | No API pricing information found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news250115/) | [English](https://api-docs.deepseek.com/news/news250115/) |
| 2024-12-26 | DeepSeek-V3 release | States promotional and regular prices and the promotion end time | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news1226/) | [English](https://api-docs.deepseek.com/news/news1226/) |
| 2024-12-10 | DeepSeek-V2.5-1210 release | No pricing change found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news1210/) | [English](https://api-docs.deepseek.com/news/news1210/) |
| 2024-11-20 | DeepSeek-R1-Lite release | No official API price found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news1120/) | [English](https://api-docs.deepseek.com/news/news1120/) |
| 2024-09-05 | DeepSeek-V2.5 release | No pricing change found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news0905/) | [English](https://api-docs.deepseek.com/news/news0905/) |
| 2024-08-02 | Context caching launch | States cache-hit and cache-miss prices | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news0802/) | [English](https://api-docs.deepseek.com/news/news0802/) |
| 2024-07-25 | API feature update | No pricing change found | [Chinese](https://api-docs.deepseek.com/zh-cn/news/news0725/) | [English](https://api-docs.deepseek.com/news/news0725/) |

## Maintenance

1. Before upgrading the plugin, run `npm run check:upstream` to compare the English canonical page's sidebar.
2. Review new articles and pages whose content changed, then add confirmed entries to this table.
3. If an article changes pricing, record the announcement status and effective period in `PRICING_HISTORY.md` and `lib/pricing.js`.
4. If an article conflicts with the current price table, do not overwrite historical data immediately. Determine whether it describes a future plan, an effective change, or a later withdrawal.
5. After manual review, run `node scripts/check-deepseek-docs.mjs --snapshot` to generate a candidate baseline, then update `deepseek-docs-baseline.json`.
