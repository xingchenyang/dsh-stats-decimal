/**
 * Declarative Chinese statutory public-holiday dates for 2026.
 *
 * Source: State Council General Office notice "国务院办公厅关于2026年部分节假日安排的通知",
 * 国办发明电〔2025〕7号, issued 2025-11-04.
 */
export default {
	year: 2026,
	source: {
		title: "国务院办公厅关于2026年部分节假日安排的通知",
		documentNumber: "国办发明电〔2025〕7号",
		issuedOn: "2025-11-04",
		url: "https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html"
	},
	holidays: [
		{ id: "new-year", name: "元旦", nameEn: "New Year's Day", startDate: "2026-01-01", endDate: "2026-01-03" },
		{ id: "spring-festival", name: "春节", nameEn: "Spring Festival", startDate: "2026-02-15", endDate: "2026-02-23" },
		{ id: "qingming", name: "清明节", nameEn: "Qingming Festival", startDate: "2026-04-04", endDate: "2026-04-06" },
		{ id: "labour-day", name: "劳动节", nameEn: "Labour Day", startDate: "2026-05-01", endDate: "2026-05-05" },
		{ id: "dragon-boat", name: "端午节", nameEn: "Dragon Boat Festival", startDate: "2026-06-19", endDate: "2026-06-21" },
		{ id: "mid-autumn", name: "中秋节", nameEn: "Mid-Autumn Festival", startDate: "2026-09-25", endDate: "2026-09-27" },
		{ id: "national-day", name: "国庆节", nameEn: "National Day", startDate: "2026-10-01", endDate: "2026-10-07" }
	]
};
