import { expect, test } from "bun:test";
import { toBinaryName } from "../lib/agent-format/binary-name";

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

test("a directory whose name starts with two dots is inside agents/", () => {
	// Base: "..x" read as outside, so the name lost its namespace ("a").
	expect(toBinaryName("/repo/agents/..x/a.md", "/repo")).toBe("..x:a");
	expect(toBinaryName("/repo/../agents/a.md", "/repo")).toBe("a");
});

test("a configured declaration root replaces agents/", () => {
	expect(toBinaryName("/repo/defs/ns/a.md", "/repo", "/repo/defs")).toBe(
		"ns:a",
	);
	expect(toBinaryName("/repo/agents/ns/a.md", "/repo", "/repo/defs")).toBe("a");
	expect(toBinaryName("/repo/..x/a.md", "/repo", "/repo/..x")).toBe("a");
});
