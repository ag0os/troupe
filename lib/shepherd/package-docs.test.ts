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
	for (const name of ["PACKAGES.md", "SHEPHERD.md", "SETUP.md"])
		expect({ name, dashes: dashes.test(doc(name)) }).toEqual({
			name,
			dashes: false,
		});
	expect(doc("SHEPHERD.md")).toContain("packages/software/MODULE.md");
});

test("the docs describe software's guides and what a brief must still carry (O10, F6)", () => {
	const packages = doc("PACKAGES.md").replace(/\s+/g, " ");
	for (const bullet of [
		"`software build`: the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; read before briefing a builder",
		"`software check`: steps 6 and 7",
		"`software ship`: step 8, the grants' journal and a parked task",
		"`software hooks`: the builder hooks runbook: prepare into the item's run directory, copy base and exclusions into the brief, launch with --settings, confirm the first guarded call in the log, always recheck; read before launching a Claude Code builder",
	])
		expect(packages).toContain(bullet);
	expect(packages).not.toContain("the software coordination module, unchanged");
	expect(packages).toContain(
		"The builder runbook, for a Shepherd starting a Claude Code builder with these hooks, is in `shepherd tool guide software hooks`.",
	);
	expect(packages).not.toContain("Prepare through the installed binary");
	expect(packages).toContain(
		"still states the module's stop rule (step 4) and the attribution rule",
	);
	expect(packages).toContain(
		"A plain (unquoted) `description` that holds `: ` is a `module-schema` error; quote it. A semicolon needs no quoting.",
	);
	expect(doc("SHEPHERD.md")).toContain(
		"carries the `publish-check`, `contract` and `builder-hooks` tools and four guides",
	);
});

test("the eval guide describes both layouts, v2 stamps and C22 (A7)", () => {
	const evals = doc("SHEPHERD-EVALS.md").replace(/\s+/g, " ");
	expect(evals).toContain(
		"in the original layout that is the repository top with an empty prefix, and in the extracted package it is `extractions/shepherd/` with the prefix `extractions/shepherd`",
	);
	expect(evals).toContain(
		"The package root as the working directory (the repository root in the original layout, `extractions/shepherd/` in the extracted package)",
	);
	expect(evals).toContain(
		"shepherd revision=<full-git-revision> dirty=<true|false> source=sha256:<64-lowercase-hex>",
	);
	expect(evals).toContain(
		"shepherd troupe-agent-source-v2 framework/troupe=<rev>[+local|+dirty] package/shepherd=<rev>[+local|+dirty] source=sha256:<hex>",
	);
	const stamps = [...evals.matchAll(/\]\(([^)]*STAMPS\.md)\)/g)].map(
		(match) => match[1] ?? "",
	);
	expect(stamps).toHaveLength(1);
	expect(existsSync(resolve(repo, "docs", stamps[0] ?? ""))).toBe(true);
	expect(evals).toContain(
		"also hashes the executable status of runtime tools; its manifest records every entry's executable status",
	);
	expect(evals).toContain(
		"In the extracted package eval provenance keeps both flags: `dirty` stays repository wide, so any uncommitted change in the repository, an uncommitted Troupe change included, marks an eval build dirty, while the v2 version line marks each origin from its own selected bytes and never prints `dirty`",
	);
	expect(evals).toContain(
		"the eval seam `scripts/eval-source.ts` in the extracted package",
	);
	expect(evals).toContain(
		"remove a retained run directory with `chmod -R u+w <run dir>` first",
	);
	expect(dashes.test(doc("SHEPHERD-EVALS.md"))).toBe(false);
});
