import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, isWithin } from "./path-within";

describe("isWithin", () => {
	test("the parent itself and its descendants are within", () => {
		expect(isWithin("/live", "/live")).toBe(true);
		expect(isWithin("/live", "/live/packages/x")).toBe(true);
	});

	test("a name starting with two dots is within", () => {
		expect(isWithin("/live", "/live/..evidence")).toBe(true);
		expect(isWithin("/live", "/live/..evidence/round-2")).toBe(true);
		expect(isWithin("/live", "/live/...")).toBe(true);
	});

	test("the parent's parent, siblings and prefix siblings are outside", () => {
		expect(isWithin("/live", "/")).toBe(false);
		expect(isWithin("/live", "/other")).toBe(false);
		expect(isWithin("/live", "/live-2/x")).toBe(false);
		expect(isWithin("/live/a", "/live/b")).toBe(false);
	});
});

describe("canonical", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "canonical-")));
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	test("an existing path is its realpath, an absent tail is kept", () => {
		mkdirSync(join(base, "real/inner"), { recursive: true });
		symlinkSync(join(base, "real"), join(base, "alias"));
		expect(canonical(join(base, "alias/inner"))).toBe(join(base, "real/inner"));
		expect(canonical(join(base, "alias/absent/deeper"))).toBe(
			join(base, "real/absent/deeper"),
		);
	});

	test("a dangling link is judged by its target", () => {
		symlinkSync(join(base, "elsewhere/gone"), join(base, "dangling"));
		expect(canonical(join(base, "dangling/x"))).toBe(
			join(base, "elsewhere/gone/x"),
		);
	});
});
