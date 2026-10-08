import calendar2026 from "./2026.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const CALENDARS = new Map([[calendar2026.year, calendar2026]]);

/**
 * Check whether an absolute timestamp falls inside a bundled Beijing-date
 * statutory holiday span. Years without a bundled calendar return false.
 */
export function isStatutoryPublicHoliday(timeEpochMs) {
	if (!Number.isFinite(timeEpochMs)) return false;
	const beijingDate = new Date(timeEpochMs + BEIJING_OFFSET_MS);
	if (!Number.isFinite(beijingDate.getTime())) return false;
	const dateText = beijingDate.toISOString().slice(0, 10);
	const calendar = CALENDARS.get(beijingDate.getUTCFullYear());
	return calendar?.holidays.some((holiday) => holiday.startDate <= dateText && dateText <= holiday.endDate) ?? false;
}

/**
 * Return holiday ranges and localized display names required by the browser's
 * live day-type and pricing-period label.
 */
export function holidaySpansForClient() {
	return [...CALENDARS.values()]
		.sort((left, right) => left.year - right.year)
		.flatMap((calendar) => calendar.holidays.map(({ startDate, endDate, name, nameEn }) => ({
			startDate,
			endDate,
			name,
			nameEn
		})));
}
