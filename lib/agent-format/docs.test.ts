import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Troupe's own format guide, checked here since Shepherd's documentation
// tests travel with the Shepherd package.
const guide = readFileSync(
	resolve(import.meta.dir, "../../docs/AGENT-FORMAT.md"),
	"utf8",
);

// Built from code points so this file holds no dash itself.
const dashes = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

test("the format guide documents dispatch and uses no em or en dashes (D11)", () => {
	expect(dashes.test(guide)).toBe(false);
	expect(guide).toContain("dispatch");
});
