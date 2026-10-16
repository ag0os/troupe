import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isSourcePath } from "../../scripts/shepherd-source";
import { composeFragments, composeSession } from "./compose";
import { dispatchPackageTool } from "./dispatch";
import {
	builtInModules,
	moduleCatalog,
	resolveModules,
} from "./module-resolution";
import {
	baseLocation,
	type PackageLocation,
	packageLocations,
	packageModules,
} from "./package-resolution";
import { MAIL_TOOLS, makeTree, packageText } from "./test-support";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function tree(files: Record<string, string>) {
	const made = makeTree(files);
	cleanups.push(made.cleanup);
	return realpathSync(made.root);
}

const header = (fragments: string[]) => fragments.at(-1) ?? "";
const now = new Date("2026-10-15T12:00:00");

describe("packageModules (O1)", () => {
	test("reads <dir>/<name>/MODULE.md with its package record", () => {
		const root = tree({
			"loc/mail/MODULE.md": packageText("mail", MAIL_TOOLS),
			"loc/notes.txt": "not a package",
			"loc/empty/README.md": "no MODULE.md, not a package",
		});
		const [mail, ...rest] = packageModules([
			{ dir: join(root, "loc"), layer: "builtin" },
		]);
		expect(rest).toEqual([]);
		expect(mail?.problems).toEqual([]);
		expect(mail?.layer).toBe("builtin");
		expect(mail?.source).toBe(join(root, "loc/mail/MODULE.md"));
		expect(mail?.package).toEqual({
			name: "mail",
			dir: join(root, "loc/mail"),
			contract: 1,
			tools: {
				unread: {
					description: "List unread threads in the inbox",
					access: "read",
					requires: ["hey"],
					network: true,
				},
				send: {
					description: "Send a drafted reply",
					access: "write",
					requires: [],
					network: false,
				},
			},
			guides: {
				triage: { description: "How to triage the inbox, in order" },
			},
		});
	});

	test("a missing location yields nothing", () => {
		expect(
			packageModules([{ dir: "/nonexistent/packages", layer: "builtin" }]),
		).toEqual([]);
	});
});

describe("default locations (O2, R2 a)", () => {
	test("the base is <repo>/packages from source and <bin>/../packages compiled", () => {
		expect(baseLocation()).toBe(resolve(import.meta.dir, "../../packages"));
		expect(baseLocation("/$bunfs/root", "/opt/troupe/bin/shepherd")).toBe(
			"/opt/troupe/packages",
		);
		expect(packageLocations("/w/parent", "/base")).toEqual([
			{ dir: "/base", layer: "builtin" },
			{ dir: "/w/parent/.shepherd/packages", layer: "inherited" },
		]);
		expect(packageLocations(undefined, "/base")).toEqual([
			{ dir: "/base", layer: "builtin" },
		]);
	});

	test("an enclosing package is an inherited candidate and publishes", () => {
		const root = tree({
			"parent/.shepherd/packages/mail/MODULE.md": packageText("mail"),
			"parent/child/.shepherd/charter.md": "Modules: mail\n",
		});
		const catalog = moduleCatalog(join(root, "parent/child"));
		const mail = catalog.candidates.find((m) => m.package?.name === "mail");
		expect(mail?.layer).toBe("inherited");
		expect(catalog.published).toBe(true);
		expect(resolveModules(catalog).selected).toContain(mail);
	});

	test("base packages follow the embedded built-ins in name order", () => {
		const root = tree({
			"base/zeta/MODULE.md": packageText("zeta"),
			"base/alpha/MODULE.md": packageText("alpha"),
			"w/.shepherd/charter.md": "Modules: alpha, zeta\n",
		});
		const catalog = moduleCatalog(join(root, "w"), undefined, false, [
			{ dir: join(root, "base"), layer: "builtin" },
		]);
		const builtin = catalog.candidates.filter((m) => m.layer === "builtin");
		expect(builtin.slice(-2).map((m) => m.metadata?.name)).toEqual([
			"alpha",
			"zeta",
		]);
		expect(builtin.slice(0, -2).some((m) => m.package)).toBe(false);
	});
});

function compose(root: string, cwd: string, locations: PackageLocation[]) {
	const problems: string[] = [];
	const fragments = composeFragments(
		join(root, cwd),
		"claude-cli",
		undefined,
		[],
		now,
		(details) => problems.push(details),
		locations,
	);
	return { fragments, problems, prompt: fragments.join("\n") };
}

describe("contract check (O4)", () => {
	test("contract 2 leaves the package out and names the problem", () => {
		const root = tree({
			"base/mail/MODULE.md": packageText(
				"mail",
				MAIL_TOOLS,
				"MAIL BODY\n",
				"contract: 2\n",
			),
			"w/.shepherd/charter.md": "Modules: mail\n",
		});
		const { fragments, prompt } = compose(root, "w", [
			{ dir: join(root, "base"), layer: "builtin" },
		]);
		expect(prompt).not.toContain("MAIL BODY");
		expect(header(fragments)).toContain(
			`- Module problems: ${join(root, "base/mail/MODULE.md")}: package-contract: `,
		);
		expect(header(fragments)).not.toContain("- Package tools:");
	});

	test("a missing contract, or a newer one with new keys, is one package-contract problem", () => {
		const root = tree({
			"base/old/MODULE.md": packageText("old", "", "OLD\n", ""),
			"base/new/MODULE.md": packageText(
				"new",
				"sandbox: strict\n",
				"NEW\n",
				"contract: 2\n",
			),
		});
		const found = packageModules([
			{ dir: join(root, "base"), layer: "builtin" },
		]);
		for (const m of found) {
			expect(m.body).toBeUndefined();
			expect(m.problems.map((p) => p.code)).toEqual(["package-contract"]);
		}
	});
});

describe("one name, one package (O5)", () => {
	test("the same name in base and enclosing loads neither", () => {
		const root = tree({
			"base/mail/MODULE.md": packageText("mail", "", "BASE MAIL\n"),
			"parent/.shepherd/packages/mail/MODULE.md": packageText(
				"mail",
				"",
				"SHARED MAIL\n",
			),
			"parent/w/.shepherd/charter.md": "Modules: mail\n",
		});
		const enclosing = join(root, "parent");
		const fragments = composeFragments(
			join(enclosing, "w"),
			"claude-cli",
			enclosing,
			[],
			now,
			undefined,
			packageLocations(enclosing, join(root, "base")),
		);
		const prompt = fragments.join("\n");
		expect(prompt).not.toContain("BASE MAIL");
		expect(prompt).not.toContain("SHARED MAIL");
		expect(header(fragments).match(/package-duplicate/g)?.length).toBe(2);
	});
});

describe("a broken base package reports, it does not throw (O7)", () => {
	test("malformed frontmatter composes with a problem line", () => {
		const root = tree({
			"base/mail/MODULE.md":
				"---\nname: mail\ntype: [unclosed\n---\nBROKEN BODY\n",
			"w/.shepherd/charter.md": "Modules: mail\n",
		});
		const { fragments, prompt, problems } = compose(root, "w", [
			{ dir: join(root, "base"), layer: "builtin" },
		]);
		expect(prompt).not.toContain("BROKEN BODY");
		expect(header(fragments)).toContain(
			`${join(root, "base/mail/MODULE.md")}: module-schema: `,
		);
		expect(problems.length).toBe(1);
	});
});

describe("a package loads only where a charter names it (B1, R2 a)", () => {
	test("no applies-when, or one naming another package, selects and dispatches nowhere", () => {
		const run = "tools:\n  run:\n    description: Run it\n    access: read\n";
		const root = tree({
			"base/loose/MODULE.md": `---\nname: loose\ntype: domain\ndescription: loose package\nbudget: 400\ncontract: 1\n${run}---\nLOOSE BODY\n`,
			"base/loose/tools/run": "#!/bin/sh\n",
			"base/squatter/MODULE.md": packageText(
				"squatter",
				run,
				"SQUATTER BODY\n",
			).replace("charter-declares: squatter", "charter-declares: other"),
			"base/squatter/tools/run": "#!/bin/sh\n",
			"base/other/MODULE.md": packageText("other", "", "OTHER BODY\n"),
			"ws1/.shepherd/charter.md": "Modules: other\n",
			"ws2/.shepherd/charter.md": "# Charter\n",
		});
		for (const tool of ["loose", "squatter"])
			chmodSync(join(root, "base", tool, "tools/run"), 0o755);
		const locations: PackageLocation[] = [
			{ dir: join(root, "base"), layer: "builtin" },
		];
		const selected = (ws: string) =>
			resolveModules(
				moduleCatalog(join(root, ws), undefined, false, locations),
			).selected.flatMap((m) => (m.package ? [m.package.name] : []));
		expect(selected("ws1")).toEqual(["other"]);
		expect(selected("ws2")).toEqual([]);
		expect(compose(root, "ws2", locations).prompt).not.toContain("BODY");
		for (const ws of ["ws1", "ws2"])
			for (const name of ["loose", "squatter"]) {
				const result = dispatchPackageTool(["tool", name, "run"], {
					cwd: join(root, ws),
					env: {},
					locations: () => locations,
				});
				expect({ ws, name, exec: result && "exec" in result }).toEqual({
					ws,
					name,
					exec: false,
				});
				expect(result && "exit" in result && result.exit.code).toBe(2);
			}
	});
});

describe("header lines (O9, D14)", () => {
	const locations = (root: string): PackageLocation[] => [
		{ dir: join(root, "base"), layer: "builtin" },
	];

	test("a selected package lists its tools and guides after Gated modules loaded", () => {
		const root = tree({
			"base/mail/MODULE.md": packageText("mail", MAIL_TOOLS),
			"w/.shepherd/charter.md": "Modules: mail\n",
		});
		const lines = header(compose(root, "w", locations(root)).fragments).split(
			"\n",
		);
		const gated = lines.indexOf("- Gated modules loaded: mail");
		expect(gated).toBeGreaterThan(0);
		expect(lines[gated + 1]).toBe(
			"- Package tools: mail unread (read), mail send (write); run as shepherd tool <package> <tool> [args], --help for usage; read tools need no permission prompt on Claude",
		);
		expect(lines[gated + 2]).toBe(
			"- Package guides: mail triage (How to triage the inbox, in order); read with shepherd tool guide <package> <guide>",
		);
	});

	test("an unselected package, or one with no tools or guides, adds no line", () => {
		const root = tree({
			"base/mail/MODULE.md": packageText("mail", MAIL_TOOLS),
			"base/plain/MODULE.md": packageText("plain"),
			"w/.shepherd/charter.md": "Modules: plain\n",
		});
		const text = header(compose(root, "w", locations(root)).fragments);
		expect(text).toContain("- Gated modules loaded: plain\n");
		expect(text).not.toContain("- Package ");
	});

	test("composeSession returns the selected packages with their tools", () => {
		const root = tree({
			"base/mail/MODULE.md": packageText("mail", MAIL_TOOLS),
			"w/.shepherd/charter.md": "Modules: mail\n",
		});
		const session = composeSession(
			join(root, "w"),
			"claude-cli",
			undefined,
			[],
			now,
			undefined,
			locations(root),
		);
		expect(session.packages.map((p) => p.name)).toEqual(["mail"]);
		const bare = tree({ "w/.shepherd/charter.md": "# no modules\n" });
		mkdirSync(join(bare, "base"));
		expect(
			composeSession(
				join(bare, "w"),
				"claude-cli",
				undefined,
				[],
				now,
				undefined,
				locations(bare),
			).packages,
		).toEqual([]);
	});
});

describe("software is a base package (O8, O2)", () => {
	test("four embedded built-ins; software loads from packages/software", () => {
		expect(builtInModules().map((m) => m.name)).toEqual([
			"herdr.md",
			"inter-agent.md",
			"nested.md",
			"root.md",
		]);
		const software = packageModules(packageLocations(undefined)).find(
			(m) => m.package?.name === "software",
		);
		expect(software?.layer).toBe("builtin");
		expect(software?.problems).toEqual([]);
		expect(software?.source).toBe(
			resolve(import.meta.dir, "../../packages/software/MODULE.md"),
		);
		expect(software?.package?.tools["publish-check"]).toEqual({
			description: expect.any(String),
			access: "read",
			requires: ["git"],
			network: false,
		});
		expect(software?.package?.guides).toEqual({});
	});
});

describe("build identity covers packages (O10)", () => {
	test("package files are source paths", () => {
		expect(isSourcePath("packages/software/MODULE.md")).toBe(true);
		expect(isSourcePath("packages/software/tools/publish-check")).toBe(true);
	});
});
