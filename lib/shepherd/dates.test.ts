import { describe, expect, test } from "bun:test";
import { dayOf, daysBetween, localDate, monthOf } from "./dates";

function inTimezone(zone: string, run: () => void): void {
	const previous = process.env.TZ;
	try {
		process.env.TZ = zone;
		run();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

describe("local date helpers", () => {
	test("formats the local month near a UTC month boundary", () => {
		inTimezone("America/Argentina/Buenos_Aires", () => {
			const now = new Date("2026-11-01T01:30:00Z");
			expect(dayOf(now)).toBe("2026-10-31");
			expect(monthOf(now)).toBe("2026-10");
		});
	});

	test("counts calendar days across a daylight-saving change", () => {
		inTimezone("America/New_York", () => {
			expect(
				daysBetween(localDate("2026-03-07"), localDate("2026-03-09")),
			).toBe(2);
		});
	});

	test("parses bare dates as local midnight east and west of UTC", () => {
		for (const zone of ["America/Argentina/Buenos_Aires", "Pacific/Auckland"]) {
			inTimezone(zone, () => {
				const date = localDate("2026-09-30");
				expect(dayOf(date)).toBe("2026-09-30");
				expect(date.getHours()).toBe(0);
			});
		}
	});

	test("rejects non-date text and impossible calendar dates", () => {
		expect(localDate("tomorrow").getTime()).toBeNaN();
		expect(localDate("2026-13-40").getTime()).toBeNaN();
	});
});
