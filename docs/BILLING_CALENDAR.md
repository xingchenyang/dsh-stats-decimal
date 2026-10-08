# Billing Holiday Calendar

## Pricing rules and evidence

Classify Beijing dates with a fixed UTC+8 offset. Saturdays and Sundays always use off-peak pricing. Next, statutory Chinese public holidays in the bundled annual calendar use off-peak pricing all day. Other Mondays through Fridays use peak pricing only during configured `peakHours`. A weekend makeup workday remains off-peak.

The billing row shows the date type and current pricing period: weekday peak, weekday off-peak, weekend off-peak, or the named holiday with off-peak status. The label precedence is statutory holiday, weekend, then weekday; a weekend within a holiday span shows the holiday name, while a weekend makeup workday remains a weekend. The English interface uses localized English labels and holiday names.

On 2026-09-19, DeepSeek's API usage page showed a note that weekend makeup workdays and statutory Chinese public holidays use off-peak pricing all day. The accessible public record is an [IT Home report published that day](https://www.ithome.com/0/100/4494.htm), which quotes that note. As of 2026-09-29, no stable public URL for that specific notice hosted by DeepSeek had been found. DeepSeek's [official price table](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) defines weekday peak pricing as 09:00–12:00 and 14:00–18:00 Beijing time; other times are off-peak.

## 2026 sources and date ranges

`lib/billing-calendar/2026.js` records the seven complete holiday spans published in the State Council General Office notice, “Notice on the Arrangement of Certain Public Holidays in 2026” (original title: `国务院办公厅关于2026年部分节假日安排的通知`; document number `国办发明电〔2025〕7号`; issued 2025-11-04). Dates were checked against the [State Council notice republished by the Beijing Municipal Government](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html): New Year's Day, January 1–3; Spring Festival, February 15–23; Qingming Festival, April 4–6; Labour Day, May 1–5; Dragon Boat Festival, June 19–21; Mid-Autumn Festival, September 25–27; and National Day, October 1–7.

The calendar retains weekend dates within every full holiday span. Weekend makeup workdays such as September 20 and October 10 are not included in holiday data; the fixed weekend rule classifies them as off-peak.

## Supported years and fallback

Only 2026 statutory holidays are currently bundled. For other years, use Beijing weekend status and `peakHours`. Do not treat an unknown weekday as a holiday or predict future schedules.

## Annual maintenance

Before adding a year, check the State Council General Office notice for that year. Add `lib/billing-calendar/<year>.js` with only that year's source and complete holiday spans, then register the file in `lib/billing-calendar/index.js`. Do not add weekend makeup workdays to holiday spans, runtime network lookup, or lunar-calendar calculations.

After updating an annual calendar, run the full test suite and required syntax and diff checks. If the projection view or historical-folding semantics change, update the corresponding schemas, client consumer, and `stateVersion`.
