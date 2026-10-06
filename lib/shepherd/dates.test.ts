import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const datesModule = pathToFileURL(join(import.meta.dir, "dates.ts")).href;

function inTimezone(zone: string, expression: string): unknown {
	const script = `
		import { dayOf, daysBetween, localDate, monthOf } from ${JSON.stringify(datesModule)};
		console.log(JSON.stringify(${expression}));
	`;
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		env: { ...process.env, TZ: zone },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0) {
		throw new Error(child.stderr?.toString() ?? "time zone child failed");
	}
	return JSON.parse(child.stdout.toString());
}

describe("local date helpers", () => {
	test("child processes apply different time zones", () => {
		const expression = `new Date("2026-01-15T00:00:00Z").getHours()`;
		expect([
			inTimezone("UTC", expression),
			inTimezone("America/Argentina/Buenos_Aires", expression),
		]).toEqual([0, 21]);
	});

	test("formats the local month near a UTC month boundary", () => {
		expect(
			inTimezone(
				"America/Argentina/Buenos_Aires",
				`(() => {
					const now = new Date("2026-11-01T01:30:00Z");
					return { day: dayOf(now), month: monthOf(now) };
				})()`,
			),
		).toEqual({ day: "2026-10-31", month: "2026-10" });
	});

	test("counts calendar days across a daylight-saving change", () => {
		expect(
			inTimezone(
				"America/New_York",
				`daysBetween(localDate("2026-03-07"), localDate("2026-03-09"))`,
			),
		).toBe(2);
	});

	test("parses bare dates as local midnight east and west of UTC", () => {
		for (const zone of ["America/Argentina/Buenos_Aires", "Pacific/Auckland"]) {
			expect(
				inTimezone(
					zone,
					`(() => {
						const date = localDate("2026-09-30");
						return { day: dayOf(date), hour: date.getHours() };
					})()`,
				),
			).toEqual({ day: "2026-09-30", hour: 0 });
		}
	});

	test("rejects non-date text and impossible calendar dates", () => {
		expect(
			inTimezone(
				"UTC",
				`[
					Number.isNaN(localDate("tomorrow").getTime()),
					Number.isNaN(localDate("2026-13-40").getTime()),
				]`,
			),
		).toEqual([true, true]);
	});
});
