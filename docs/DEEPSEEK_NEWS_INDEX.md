# DeepSeek API 新闻索引

DeepSeek API 文档目前没有单独的新闻汇总入口，新闻目录由网站侧栏提供。本文件保存侧栏中可见的官方新闻链接，方便后续核对模型、价格和计费规则变化。

不带语言前缀的英文站点作为 canonical source；中文页面由同一路径增加 `/zh-cn` 得到。以下链接同时保留两种语言，自动目录检查只查询英文侧栏。

| 日期 | 新闻 | 定价内容 | 中文 | English |
|---|---|---|---|---|
| 2026-09-10 | DeepSeek-V4.1-Flash 发布 | 明确 Flash 新价及生效时刻 | [中文](https://api-docs.deepseek.com/zh-cn/news/news260910/) | [English](https://api-docs.deepseek.com/news/news260910/) |
| 2026-08-21 | DeepSeek-V4-Flash-Vision-Exp 上线 | 声明与 Flash 同价 | [中文](https://api-docs.deepseek.com/zh-cn/news/news260821/) | [English](https://api-docs.deepseek.com/news/news260821/) |
| 2026-08-13 | DeepSeek-V4-Pro 正式版上线 | 峰谷调价及精确生效时刻 | [中文](https://api-docs.deepseek.com/zh-cn/news/news260813/) | [English](https://api-docs.deepseek.com/news/news260813/) |
| 2026-04-24 | DeepSeek-V4 预览版发布 | 首发价格表在正文图片中 | [中文](https://api-docs.deepseek.com/zh-cn/news/news260424/) | [English](https://api-docs.deepseek.com/news/news260424/) |
| 2025-12-01 | DeepSeek-V3.2 正式版发布 | 声明临时 Speciale 价格不变 | [中文](https://api-docs.deepseek.com/zh-cn/news/news251201/) | [English](https://api-docs.deepseek.com/news/news251201/) |
| 2025-09-29 | DeepSeek-V3.2-Exp 发布 | 即刻降价 50% 以上；价格表在图片中 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250929/) | [English](https://api-docs.deepseek.com/news/news250929/) |
| 2025-09-22 | DeepSeek V3.1 更新 | 未发现价格变化 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250922/) | [English](https://api-docs.deepseek.com/news/news250922/) |
| 2025-08-21 | DeepSeek V3.1 发布 | 新价格及取消夜间优惠的生效时刻 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250821/) | [English](https://api-docs.deepseek.com/news/news250821/) |
| 2025-05-28 | DeepSeek-R1-0528 发布 | 未发现价格变化 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250528/) | [English](https://api-docs.deepseek.com/news/news250528/) |
| 2025-03-25 | DeepSeek-V3-0324 发布 | 未发现价格变化 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250325/) | [English](https://api-docs.deepseek.com/news/news250325/) |
| 2025-01-20 | DeepSeek-R1 发布 | 明确 CNY/USD 三项价格 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250120/) | [English](https://api-docs.deepseek.com/news/news250120/) |
| 2025-01-15 | DeepSeek APP 发布 | 未发现 API 价格内容 | [中文](https://api-docs.deepseek.com/zh-cn/news/news250115/) | [English](https://api-docs.deepseek.com/news/news250115/) |
| 2024-12-26 | DeepSeek-V3 发布 | 明确优惠价、正式价和优惠截止时间 | [中文](https://api-docs.deepseek.com/zh-cn/news/news1226/) | [English](https://api-docs.deepseek.com/news/news1226/) |
| 2024-12-10 | DeepSeek-V2.5-1210 发布 | 未发现价格变化 | [中文](https://api-docs.deepseek.com/zh-cn/news/news1210/) | [English](https://api-docs.deepseek.com/news/news1210/) |
| 2024-11-20 | DeepSeek-R1-Lite 发布 | 未发现正式 API 定价 | [中文](https://api-docs.deepseek.com/zh-cn/news/news1120/) | [English](https://api-docs.deepseek.com/news/news1120/) |
| 2024-09-05 | DeepSeek-V2.5 发布 | 未发现价格变化 | [中文](https://api-docs.deepseek.com/zh-cn/news/news0905/) | [English](https://api-docs.deepseek.com/news/news0905/) |
| 2024-08-02 | API 上线硬盘缓存 | 明确缓存命中/未命中价格 | [中文](https://api-docs.deepseek.com/zh-cn/news/news0802/) | [English](https://api-docs.deepseek.com/news/news0802/) |
| 2024-07-25 | API 升级新功能 | 未发现价格变化 | [中文](https://api-docs.deepseek.com/zh-cn/news/news0725/) | [English](https://api-docs.deepseek.com/news/news0725/) |

## 维护方法

1. 在插件升级前运行 `npm run check:upstream`，比较英文 canonical 页面源码中的左侧导航目录。
2. 查看新增新闻或发生正文变化的页面，并将确认的新条目补入本表。
3. 如果新闻涉及价格，继续在 `PRICING_HISTORY.md` 和 `lib/pricing.js` 中记录公告状态与实际生效区间。
4. 新闻正文与当前价格页冲突时，不直接覆盖历史：先判断它是未来计划、已生效变化，还是后来撤回的公告。
5. 人工核对完成后，用 `node scripts/check-deepseek-docs.mjs --snapshot` 生成候选基线内容，再更新 `deepseek-docs-baseline.json`。
