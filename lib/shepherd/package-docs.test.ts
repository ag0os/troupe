import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const doc = (name: string) => {
	const path = join(repo, "docs", name);
	return existsSync(path) ? readFileSync(path, "utf8") : "";
};

test("the contract documents every variable and finding code it names (O22)", () => {
	const docs = `${doc("PACKAGES.md")}\n${doc("SHEPHERD.md")}`;
	const source = readdirSync(import.meta.dir)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.map((name) => readFileSync(join(import.meta.dir, name), "utf8"))
		.join("\n");
	const variables = [...new Set(source.match(/\bSHEPHERD_[A-Z_]+(?=:)/g))];
	const codes = [...new Set(source.match(/"package-[a-z-]+"/g))].map((code) =>
		code.slice(1, -1),
	);
	expect(variables.sort()).toEqual([
		"SHEPHERD_CONFIG_DIR",
		"SHEPHERD_CONTRACT",
		"SHEPHERD_PACKAGE",
		"SHEPHERD_PACKAGE_DIR",
		"SHEPHERD_STATE_DIR",
		"SHEPHERD_TOOL",
		"SHEPHERD_WORKSPACE",
	]);
	expect(codes.length).toBeGreaterThanOrEqual(8);
	for (const name of [...variables, ...codes])
		expect({ name, documented: docs.includes(name) }).toEqual({
			name,
			documented: true,
		});
});

// Built from code points so this file holds no dash itself.
const dashes = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

test("the docs name the SHEPHERD_WORKSPACE leak and use no em or en dashes (D11)", () => {
	const packages = doc("PACKAGES.md");
	expect(packages).toContain("nested sessions and forks");
	for (const name of [
		"PACKAGES.md",
		"SHEPHERD.md",
		"AGENT-FORMAT.md",
		"SETUP.md",
	])
		expect({ name, dashes: dashes.test(doc(name)) }).toEqual({
			name,
			dashes: false,
		});
	expect(doc("AGENT-FORMAT.md")).toContain("dispatch");
	expect(doc("SHEPHERD.md")).toContain("packages/software/MODULE.md");
});
