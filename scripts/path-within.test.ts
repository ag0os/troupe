import { describe, expect, test } from "bun:test";
import { isWithin } from "./path-within";

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
