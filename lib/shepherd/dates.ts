const DAY_MS = 86_400_000;

/** A bare YYYY-MM-DD at local midnight, or an invalid date for any other input. */
export function localDate(text: string): Date {
	const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return new Date(Number.NaN);

	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	const day = Number(match[3]);
	const date = new Date(0);
	date.setHours(0, 0, 0, 0);
	date.setFullYear(year, month, day);
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month ||
		date.getDate() !== day
	) {
		return new Date(Number.NaN);
	}
	return date;
}

/** YYYY-MM-DD of a date in local time. */
export function dayOf(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM of a date in local time. */
export function monthOf(date: Date): string {
	return dayOf(date).slice(0, 7);
}

/** Local calendar days between two dates, ignoring times and clock changes. */
export function daysBetween(earlier: Date, later: Date): number {
	const dayNumber = (date: Date) =>
		Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
	return dayNumber(later) - dayNumber(earlier);
}
