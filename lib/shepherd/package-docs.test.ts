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

test("the docs describe software's guides and what a brief must still carry (O10, F6)", () => {
	const packages = doc("PACKAGES.md").replace(/\s+/g, " ");
	for (const bullet of [
		"`software build`: the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; read before briefing a builder",
		"`software check`: steps 6 and 7",
		"`software ship`: step 8, the grants' journal and a parked task",
	])
		expect(packages).toContain(bullet);
	expect(packages).not.toContain("the software coordination module, unchanged");
	expect(packages).toContain(
		"still states the module's stop rule (step 4) and the attribution rule",
	);
	expect(packages).toContain(
		"A plain (unquoted) `description` that holds `: ` is a `module-schema` error; quote it. A semicolon needs no quoting.",
	);
	expect(doc("SHEPHERD.md")).toContain(
		"carries the `publish-check` and `contract` tools and three guides",
	);
});
