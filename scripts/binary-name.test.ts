import { expect, test } from "bun:test";
import { toBinaryName } from "./binary-name";

test("Markdown declarations get the same path-derived name as launchers", () => {
	const root = "/repo";
	expect(toBinaryName("/repo/agents/design/diagram/all.md", root)).toBe(
		"design:diagram:all",
	);
	expect(toBinaryName("/repo/agents/shepherd.md", root)).toBe("shepherd");
	expect(toBinaryName("/repo/agents/design/diagram/all.ts", root)).toBe(
		"design:diagram:all",
	);
});
