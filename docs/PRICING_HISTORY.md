# DeepSeek API Price History

This file records the evidence, timestamp precision, and announcement status for the price periods built into `lib/pricing.js`. It supports historical Session pricing and documents the data planned for a future price-history step chart.

## Official references

- [CNY price table](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [USD price table](https://api-docs.deepseek.com/quick_start/pricing/)
- [Chinese updates](https://api-docs.deepseek.com/zh-cn/updates)
- [English updates](https://api-docs.deepseek.com/updates/)
- [Official news index](DEEPSEEK_NEWS_INDEX.md)

Price pages are updated in place and cannot serve as the only historical record. The official site has no single news index; when maintaining price periods, check independent news articles linked from the documentation sidebar and existing snapshots of the price pages. Update logs mainly confirm model release order and count as pricing evidence only when they explicitly state prices or effective times. Preserve date-level precision whenever an exact time is unavailable.

## Earlier official pricing announcements

The following price events were confirmed from individual news articles and stored in `PRICE_NOTICES` for a future multi-year chart. They have not extended the currently supported V4 model billing periods.

| Date | Pricing information in the official article | Current handling |
| --- | --- | --- |
| 2024-08-02 | Context caching launched: CNY cache hit 0.1, miss 1; USD cache hit 0.014, miss 0.14 | Announcement recorded; corresponding model output rates and effective boundaries are still needed for a complete curve |
| 2024-12-26 | V3 promotional prices continue until 2025-02-09 00:00 Beijing time; afterward CNY is 0.5 / 2 / 8 and USD is 0.07 / 0.27 / 1.10 | Announcement and exact end time recorded |
| 2025-01-20 | R1: CNY 1 / 4 / 16 and USD 0.14 / 0.55 / 2.19 | Announcement recorded |
| 2025-08-21 | V3.1 prices take effect at 2025-09-06 00:00 Beijing time, and the overnight discount ends | Announcement and exact effective time recorded; complete old promotional periods still need compilation |
| 2025-09-29 | V3.2-Exp API prices cut by more than 50% immediately | Date-precision announcement recorded; exact prices appear in an official image and are excluded from the billing table until image evidence is captured |

Rate order is cache hit / cache miss / output. Record a complete three-rate tuple only when the article explicitly provides all three prices.

## Billing periods

Prices are per million tokens. Rate order is cache hit / cache miss / output. All times are Beijing time (UTC+8).

### DeepSeek V4 Flash

| Effective time | CNY | USD | Note |
| --- | --- | --- | --- |
| 2026-04-24 (date precision) | 0.2 / 1 / 2 | 0.028 / 0.14 / 0.28 | V4 Preview launch prices |
| 2026-04-26 (date precision) | 0.02 / 1 / 2 | 0.0028 / 0.14 / 0.28 | Cache-hit price cut to one tenth of launch price |
| 2026-08-17 00:00 | Off-peak 0.05 / 1.5 / 4.5; peak 0.10 / 3 / 9 | Off-peak 0.007 / 0.22 / 0.66; peak 0.014 / 0.44 / 1.32 | Peak/off-peak pricing begins |
| 2026-09-10 12:00 | Off-peak 0.02 / 1 / 4; peak 0.04 / 2 / 8 | Off-peak 0.003 / 0.15 / 0.6; peak 0.006 / 0.3 / 1.2 | Two legacy Flash IDs route to V4.1 Flash |

The new model ID `deepseek-flash` exists from 2026-09-10 12:00. Earlier events with that ID do not fall back to another model's price.

### DeepSeek V4 Pro

| Effective time | CNY | USD | Note |
| --- | --- | --- | --- |
| 2026-04-24 (date precision) | 1 / 12 / 24 | 0.145 / 1.74 / 3.48 | V4 Preview launch prices |
| 2026-04-25 (date precision) | 0.25 / 3 / 6 | 0.03625 / 0.435 / 0.87 | 75% limited-time discount |
| 2026-04-26 (date precision) | 0.025 / 3 / 6 | 0.003625 / 0.435 / 0.87 | Cache-hit prices cut again to one tenth across the series |
| 2026-08-17 00:00 | Off-peak 0.15 / 4.5 / 13.5; peak 0.30 / 9 / 27 | Off-peak 0.022 / 0.66 / 1.98; peak 0.044 / 1.32 / 3.96 | Peak/off-peak pricing begins |

On 2026-06-01 00:00, the 75% discount became the permanent price, but the amount users paid did not change. The announcement is recorded without creating a duplicate price period.

### DeepSeek V4 Flash Vision Exp

This model launched on 2026-08-21 at the same price as V4 Flash. From 2026-09-10 12:00, the compatible model name routes to V4.1 Flash and uses the updated Flash prices. Events with this model name before launch have unknown cost.

## Withdrawn plan

The V4.1 Flash announcement initially planned to route `deepseek-v4-pro` to V4.1 Flash starting 2026-09-14 12:00. DeepSeek later stated that V4 Pro API would remain available after September 14 and its pricing would remain unchanged. Therefore:

- The plan is marked `cancelled` in `PRICE_NOTICES`.
- September 14, 2026 does not create a Pro pricing boundary.
- A historical chart may show the withdrawn announcement, but the actual price curve remains continuous.

## Timestamp precision

- `instant` means the official source provided an exact effective time that can be used directly as an event-pricing boundary.
- `date` means only the Beijing calendar date is confirmed. The implementation uses midnight on that date as a deterministic boundary, while retaining the lower precision so it is not presented as an exact official time.

If a more reliable official archive becomes available, update the precision and boundary, then increment projection `stateVersion` so historical sessions are refolded.
