import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AgentBuildDefinition,
	type Builder,
	type BuildRequest,
	compileAgent,
	describePublishFailure,
	generateEntry,
	inspectExtension,
	loadAgentDefinition,
	PartialPublishError,
	PruneError,
	planBuild,
	publish,
	resolveAgentName,
	startWatcher,
} from "../entries/compiler";
import {
	AgentSourceError,
	PROMPT_SEPARATOR,
	type SourceIssue,
} from "../entries/declaration";

// O3, O6 to O10, O12, O18 through the public `troupe/compiler` entry, with a
// consumer whose declarations live outside `agents/`. Fixtures only.

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "build-definition-")));
	mkdirSync(join(root, "defs"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): string {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
	return full;
}

const header = "---\ndescription: Fixture\nbackends: [claude, codex]\n";

function addAgent(path: string, frontmatter = "", body = "Body") {
	write(path, `${header}${frontmatter}---\n${body}\n`);
}

function definition(
	extra: Partial<AgentBuildDefinition> = {},
): AgentBuildDefinition {
	return {
		consumerRoot: root,
		declarationRoot: "defs",
		roster: [],
		outDir: "out",
		...extra,
	};
}

/** Writes a nonempty fake binary naming its entry; records every request. */
function fakeBuilder(seen: BuildRequest[] = []): Builder {
	return async (request) => {
		seen.push(request);
		writeFileSync(request.outFile, `binary for ${request.label}\n`);
	};
}

async function issuesOf(promise: Promise<unknown>): Promise<SourceIssue[]> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AgentSourceError) return [...error.issues];
		throw error;
	}
	throw new Error("expected an AgentSourceError");
}

/** Path, kind and bytes of everything under `dir`. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string, prefix: string) => {
		if (!existsSync(current)) return;
		for (const name of readdirSync(current).sort()) {
			const full = join(current, name);
			const stat = lstatSync(full);
			if (stat.isDirectory()) {
				out[`${prefix}${name}`] = "dir";
				walk(full, `${prefix}${name}/`);
			} else {
				out[`${prefix}${name}`] =
					`${stat.mode} ${readFileSync(full).toString("base64")}`;
			}
		}
	};
	walk(dir, "");
	return out;
}

function buildLeftovers(): string[] {
	return readdirSync(root).filter((name) =>
		/^\.(troupe|agent)-build-/.test(name),
	);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const fakeProvenance = {
	revision: "f".repeat(40),
	dirty: false,
	sourceDirty: false,
	manifest: { source: "sha256:fixture", entries: [] },
};
const fakeStamp = {
	capture: () => fakeProvenance,
	recheck: () => fakeProvenance.manifest,
};

type Listener = (event: string, filename: string | null) => void;
function fakeWatch() {
	const watched: { dir: string; listener: Listener; closed: boolean }[] = [];
	return {
		watched,
		watch: (
			dir: string,
			_options: { recursive: boolean },
			listener: Listener,
		) => {
			const entry = { dir, listener, closed: false };
			watched.push(entry);
			return {
				close() {
					entry.closed = true;
				},
			};
		},
		emit(dir: string, filename: string) {
			for (const entry of watched) {
				if (entry.dir === dir && !entry.closed) {
					entry.listener("change", filename);
				}
			}
		},
	};
}

describe("O6 declaration roots", () => {
	test("nested declarations under a non-agents root get colon names everywhere", async () => {
		addAgent("defs/team/sub/name.md");
		addAgent("defs/top.md");
		addAgent("agents/elsewhere.md");
		const def = definition({ roster: ["team:sub:name", "top"] });

		const agent = await loadAgentDefinition(def, "defs/team/sub/name.md");
		expect(agent.id).toBe("team:sub:name");
		expect(agent.file).toBe("defs/team/sub/name.md");
		expect(resolveAgentName(def, "defs/team/sub/name.md", root)).toBe(
			"team:sub:name",
		);
		expect(resolveAgentName(def, "agents/elsewhere.md", root)).toBe(
			"agents/elsewhere.md",
		);

		const plan = await planBuild({ definition: def });
		expect(plan.entries.map((entry) => [entry.id, entry.source])).toEqual([
			["team:sub:name", "defs/team/sub/name.md"],
			["top", "defs/top.md"],
		]);
		expect(plan.warnings).toEqual([]);

		const built = await compileAgent({
			definition: def,
			file: "defs/team/sub/name.md",
			outFile: "single",
			build: fakeBuilder(),
		});
		expect(built.id).toBe("team:sub:name");
		expect(readFileSync(join(root, "single"), "utf8")).toBe(
			"binary for defs/team/sub/name.md\n",
		);
	});

	test("local/ under the declaration root is excluded with a warning naming it", async () => {
		addAgent("defs/a.md");
		addAgent("defs/local/private.md");
		const plan = await planBuild({ definition: definition({ roster: ["a"] }) });
		expect(plan.entries.map((entry) => entry.id)).toEqual(["a"]);
		expect(plan.warnings).toEqual([
			"warning: defs/local/ is not compiled; private agents are not supported",
		]);
	});

	test("traversal and symlink escapes from the declaration root fail", async () => {
		addAgent("outside.md");
		symlinkSync(join(root, "outside.md"), join(root, "defs/link.md"));
		for (const file of ["defs/../outside.md", "defs/link.md"]) {
			const issues = await issuesOf(loadAgentDefinition(definition(), file));
			expect(issues).toEqual([
				{
					file: "outside.md",
					field: "path",
					message: "declarations live under defs/",
				},
			]);
		}
	});

	test("duplicate IDs and unpaired TypeScript under the root are rejected", async () => {
		addAgent("defs/a/b.md");
		addAgent("defs/a:b.md");
		write("defs/stray.ts", "export const x = 1;\n");
		const issues = await issuesOf(
			planBuild({ definition: definition({ roster: ["a:b"] }) }),
		);
		expect(issues.map((issue) => issue.message)).toContain(
			"only Markdown declarations are built; a .ts under defs/ must be the same-stem extension of a declaration",
		);
		expect(
			issues.some((issue) =>
				issue.message.includes('"a:b" is also defined by'),
			),
		).toBe(true);
	});

	test("a configured root outside the consumer root is refused, naming the root", async () => {
		const issues = await issuesOf(
			planBuild({
				definition: definition({
					roster: ["a"],
					declarationRoot: "../elsewhere",
					includeRoots: ["/etc"],
				}),
			}),
		);
		expect(issues).toEqual([
			{
				file: "../elsewhere",
				field: "declarationRoot",
				message: `root "../elsewhere" lies outside the consumer root ${root}`,
			},
			{
				file: "/etc",
				field: "includeRoots",
				message: `root "/etc" lies outside the consumer root ${root}`,
			},
		]);
	});

	test("a directory named ..x under a root is inside it", async () => {
		// Base: both callers read "..x" as outside. The declaration under it
		// was refused as outside agents/; the include as outside its root.
		write("system-prompts/..y/t.md", "Two-dot include\n");
		addAgent("defs/a.md", "includes: [../system-prompts/..y/t.md]\n");
		const agent = await loadAgentDefinition(definition(), "defs/a.md");
		expect(agent.spec.systemPrompt).toBe(
			["Body", "Two-dot include"].join(PROMPT_SEPARATOR),
		);
		addAgent("defs/..x/b.md");
		const [issue] = await issuesOf(
			loadAgentDefinition(definition(), "defs/..x/b.md"),
		);
		expect(issue?.field).toBe("id");
		expect(issue?.message).toStartWith('"..x:b" is not a valid agent id');
	});
});

describe("O7 include roots", () => {
	test("configured roots keep declaration-relative order and normalization", async () => {
		write("prompts-a/one.md", "\n\nOne  \n");
		write("prompts-b/two.md", "Two\n");
		addAgent(
			"defs/a.md",
			"includes:\n  - ../prompts-b/two.md\n  - ../prompts-a/one.md\n",
		);
		const agent = await loadAgentDefinition(
			definition({ includeRoots: ["prompts-a", "prompts-b"] }),
			"defs/a.md",
		);
		expect(agent.spec.systemPrompt).toBe(
			["Body", "Two", "One"].join(PROMPT_SEPARATOR),
		);
	});

	test("missing, unreadable and escaping includes keep their diagnostics", async () => {
		write("prompts/locked.md", "Locked\n");
		chmodSync(join(root, "prompts/locked.md"), 0o000);
		write("secret.md", "Secret\n");
		symlinkSync(join(root, "secret.md"), join(root, "prompts/escape.md"));
		addAgent(
			"defs/a.md",
			"includes:\n  - ../prompts/nope.md\n  - ../prompts/locked.md\n  - ../prompts/escape.md\n  - ../secret.md\n",
		);
		try {
			const issues = await issuesOf(
				loadAgentDefinition(
					definition({ includeRoots: ["defs", "prompts"] }),
					"defs/a.md",
				),
			);
			expect(issues.map((issue) => [issue.field, issue.line])).toEqual([
				["includes[0]", 5],
				["includes[1]", 6],
				["includes[2]", 7],
				["includes[3]", 8],
			]);
			expect(issues[0]?.message).toBe('"../prompts/nope.md" does not exist');
			expect(issues[1]?.message).toStartWith(
				'"../prompts/locked.md" could not be read:',
			);
			expect(issues[2]?.message).toBe(
				'"../prompts/escape.md" resolves outside defs/ and prompts/',
			);
			expect(issues[3]?.message).toBe(
				'"../secret.md" resolves outside defs/ and prompts/',
			);
		} finally {
			chmodSync(join(root, "prompts/locked.md"), 0o644);
		}
	});

	test("the default roots are the declaration root and system-prompts", async () => {
		write("system-prompts/s.md", "Shared\n");
		write("prompts/p.md", "Elsewhere\n");
		addAgent("defs/local-include.md", "includes: [../system-prompts/s.md]\n");
		addAgent("defs/b.md", "includes: [../prompts/p.md]\n");
		const ok = await loadAgentDefinition(definition(), "defs/local-include.md");
		expect(ok.spec.systemPrompt).toBe(
			["Body", "Shared"].join(PROMPT_SEPARATOR),
		);
		const [issue] = await issuesOf(
			loadAgentDefinition(definition(), "defs/b.md"),
		);
		expect(issue?.message).toBe(
			'"../prompts/p.md" resolves outside defs/ and system-prompts/',
		);
	});
});

describe("O8 extension code roots", () => {
	const helper = "export const greeting = 'hi';\n";
	const extension = (specifier: string) =>
		`import { greeting } from "${specifier}";\nexport function prepare() {\n\treturn { prompt: greeting };\n}\n`;

	test("a helper under a configured root is accepted", async () => {
		write("tools/helpers/h.ts", helper);
		addAgent("defs/a.md");
		write("defs/a.ts", extension("../tools/helpers/h.ts"));
		const agent = await loadAgentDefinition(
			definition({ extensionCodeRoots: ["tools/helpers"] }),
			"defs/a.md",
		);
		expect(agent.extension?.exports).toEqual(["prepare"]);
	});

	test("an equivalent neighbouring helper and a symlinked one fail", async () => {
		write("tools/helpers/h.ts", helper);
		write("tools/other/h.ts", helper);
		symlinkSync(
			join(root, "tools/other/h.ts"),
			join(root, "tools/helpers/link.ts"),
		);
		const def = definition({ extensionCodeRoots: ["tools/helpers"] });
		for (const specifier of [
			"../tools/other/h.ts",
			"../tools/helpers/link.ts",
		]) {
			addAgent("defs/a.md");
			write("defs/a.ts", extension(specifier));
			const issues = await issuesOf(loadAgentDefinition(def, "defs/a.md"));
			expect(issues.map((issue) => issue.message)).toEqual([
				`value import from "${specifier}" (only packages, builtins and tools/helpers may be imported); extensions must not run code on import`,
			]);
		}
	});

	test("with no code roots only packages and builtins may be imported", async () => {
		write("tools/helpers/h.ts", helper);
		addAgent("defs/a.md");
		write("defs/a.ts", extension("../tools/helpers/h.ts"));
		const issues = await issuesOf(
			loadAgentDefinition(definition(), "defs/a.md"),
		);
		expect(issues[0]?.message).toBe(
			'value import from "../tools/helpers/h.ts" (only packages and builtins may be imported); extensions must not run code on import',
		);
	});
});

describe("O9 text roots and static inspection", () => {
	const extension = (statement: string) =>
		`${statement}\nexport function prepare() {\n\treturn {};\n}\n`;
	const def = () => definition({ extensionTextRoots: ["texts"] });

	test("the exact text import shape from a configured root succeeds", async () => {
		write("texts/p.md", "Prompt text\n");
		addAgent("defs/a.md");
		write(
			"defs/a.ts",
			extension('import text from "../texts/p.md" with { type: "text" };'),
		);
		const agent = await loadAgentDefinition(def(), "defs/a.md");
		expect(agent.extension?.exports).toEqual(["prepare"]);
	});

	test("wrong attributes, bare paths, directories, escapes and non-Markdown fail", async () => {
		write("texts/p.md", "Prompt\n");
		mkdirSync(join(root, "texts/dir.md"));
		write("outside.md", "Outside\n");
		write("texts/p.txt", "Text\n");
		symlinkSync(join(root, "outside.md"), join(root, "texts/escape.md"));
		const cases: [string, string][] = [
			[
				'import text from "../texts/p.md" with { type: "json" };',
				'import attributes on "../texts/p.md" must be exactly with { type: "text" }',
			],
			[
				'import text from "texts/p.md" with { type: "text" };',
				'text import "texts/p.md" must be a relative path into texts/',
			],
			[
				'import text from "../texts/dir.md" with { type: "text" };',
				'text import "../texts/dir.md" is not a file',
			],
			[
				'import text from "../texts/escape.md" with { type: "text" };',
				'text import "../texts/escape.md" resolves outside texts/',
			],
			[
				'import text from "../texts/p.txt" with { type: "text" };',
				'text import "../texts/p.txt" must name a .md file under texts/',
			],
		];
		for (const [statement, message] of cases) {
			addAgent("defs/a.md");
			write("defs/a.ts", extension(statement));
			const issues = await issuesOf(loadAgentDefinition(def(), "defs/a.md"));
			expect(issues.map((issue) => issue.message)).toEqual([
				`${message}; extensions must not run code on import`,
			]);
		}
	});

	test("loading and planning never run a sentinel-writing extension", async () => {
		const sentinel = join(root, "sentinel");
		addAgent("defs/a.md");
		write(
			"defs/a.ts",
			[
				'import { writeFileSync } from "node:fs";',
				`writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
				"export function prepare() {",
				"\treturn {};",
				"}",
			].join("\n"),
		);
		const loaded = await issuesOf(loadAgentDefinition(def(), "defs/a.md"));
		const planned = await issuesOf(
			planBuild({ definition: { ...def(), roster: ["a"] } }),
		);
		for (const issues of [loaded, planned]) {
			expect(issues).toEqual([
				{
					file: "defs/a.ts",
					line: 2,
					field: "top-level",
					message: expect.stringContaining(
						"extensions must not run code on import",
					),
				},
			]);
		}
		expect(existsSync(sentinel)).toBe(false);
	});

	test("inspection never runs the module and rejects import-time work", () => {
		const sentinel = join(root, "sentinel");
		const inspection = inspectExtension(
			"defs/a.ts",
			[
				'import { writeFileSync } from "node:fs";',
				'import "./side-effect.ts";',
				'export { x } from "./re-export.ts";',
				'import legacy = require("./legacy");',
				`writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
				"export function prepare() {",
				"\treturn {};",
				"}",
			].join("\n"),
		);
		expect(existsSync(sentinel)).toBe(false);
		expect(inspection.exports).toEqual(["prepare"]);
		expect(inspection.sideEffects.map((issue) => issue.line)).toEqual([
			2, 3, 4, 5,
		]);
		expect(inspection.sideEffects[0]?.message).toBe(
			'side-effect import "./side-effect.ts"; extensions must not run code on import',
		);
	});
});

describe("O10 roster", () => {
	test("a Shepherd-only package plans and publishes only shepherd", async () => {
		addAgent("defs/shepherd.md");
		const seen: BuildRequest[] = [];
		const entries: string[] = [];
		const record = fakeBuilder(seen);
		const def = definition({ roster: ["shepherd"] });
		const plan = await planBuild({ definition: def });
		expect(plan.entries.map((entry) => entry.id)).toEqual(["shepherd"]);
		const result = await publish({
			definition: def,
			stamp: fakeStamp,
			build: async (request) => {
				entries.push(readFileSync(request.entry, "utf8"));
				await record(request);
			},
		});
		expect(result.built).toEqual(["shepherd"]);
		expect(result.provenance).toEqual(fakeProvenance);
		expect(readdirSync(join(root, "out"))).toEqual(["shepherd"]);
		expect(seen.map((request) => request.label)).toEqual(["defs/shepherd.md"]);
		expect(entries[0]).toContain("resolveVersion(spec.id");
		expect(entries[0]).toContain(`revision=${"f".repeat(40)}`);
	});

	test("missing, extra and malformed sibling declarations fail", async () => {
		const def = definition({ roster: ["shepherd"] });
		const missing = await issuesOf(planBuild({ definition: def }));
		expect(missing).toEqual([
			{
				file: "defs/shepherd.md",
				field: "roster",
				message: 'roster agent "shepherd" has no declaration',
			},
		]);

		addAgent("defs/shepherd.md");
		addAgent("defs/extra.md");
		const extra = await issuesOf(planBuild({ definition: def }));
		expect(extra).toEqual([
			{
				file: "defs/extra.md",
				field: "roster",
				message: '"extra" is not a roster agent',
			},
		]);

		rmSync(join(root, "defs/extra.md"));
		write("defs/shepherd.ts", "export const notAHook = 1;\n");
		const sibling = await issuesOf(planBuild({ definition: def }));
		expect(sibling).toEqual([
			{
				file: "defs/shepherd.ts",
				field: "exports",
				message: "a same-stem .ts must export prepare or finish",
			},
		]);
	});

	test("planning, publishing and watching require a roster", async () => {
		addAgent("defs/a.md");
		const { roster: _, ...unrostered } = definition();
		const bare = unrostered as AgentBuildDefinition;
		// R7 at compile time: a definition without a roster does not typecheck.
		const typeOnly = () => {
			// @ts-expect-error roster is required
			void planBuild({ definition: unrostered });
			// @ts-expect-error roster is required
			void publish({ definition: unrostered });
			// @ts-expect-error roster is required
			startWatcher({ definition: unrostered });
		};
		expect(typeof typeOnly).toBe("function");
		await expect(planBuild({ definition: bare })).rejects.toThrow(
			"the build definition must name its roster",
		);
		await expect(publish({ definition: bare })).rejects.toThrow(
			"the build definition must name its roster",
		);
		expect(() => startWatcher({ definition: bare })).toThrow(
			"the build definition must name its roster",
		);
	});

	test("compileAgent builds a declaration that belongs to no roster", async () => {
		addAgent("defs/outsider.md");
		mkdirSync(join(root, "out"));
		const { roster: _, ...sourceOnly } = definition();
		const agent = await compileAgent({
			definition: sourceOnly,
			file: "defs/outsider.md",
			outFile: "out/outsider",
			build: fakeBuilder(),
		});
		expect(agent.id).toBe("outsider");
		expect(existsSync(join(root, "out/outsider"))).toBe(true);
	});
});

describe("O12 publication", () => {
	function seed() {
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out/a"), "old a");
		writeFileSync(join(root, "out/orphan"), "stale");
		writeFileSync(join(root, "out/keep"), "kept by another tool");
	}
	const def = () =>
		definition({ roster: ["a", "b"], protectedOutputs: ["keep"] });
	beforeEach(() => {
		addAgent("defs/a.md");
		addAgent("defs/b.md");
	});

	test("builds serially, renames into the configured outDir and spares protected outputs", async () => {
		seed();
		let active = 0;
		let peak = 0;
		const result = await publish({
			definition: def(),
			build: async (request) => {
				active++;
				peak = Math.max(peak, active);
				await sleep(10);
				writeFileSync(request.outFile, `built ${request.label}`);
				active--;
			},
		});
		expect(peak).toBe(1);
		expect(result.built).toEqual(["a", "b"]);
		expect(result.pruned).toEqual(["orphan"]);
		expect(readdirSync(join(root, "out")).sort()).toEqual(["a", "b", "keep"]);
		expect(readFileSync(join(root, "out/a"), "utf8")).toBe("built defs/a.md");
		expect(buildLeftovers()).toEqual([]);
	});

	test("every failure before the first rename leaves prior outputs byte for byte", async () => {
		const failures: [string, () => Parameters<typeof publish>[0]][] = [
			[
				"custom builder error",
				() => ({
					definition: def(),
					build: async () => {
						throw new Error("custom builder exploded");
					},
				}),
			],
			[
				"empty output",
				() => ({
					definition: def(),
					build: async (request) => writeFileSync(request.outFile, ""),
				}),
			],
			[
				"abort during the second build",
				() => {
					const controller = new AbortController();
					let count = 0;
					return {
						definition: def(),
						signal: controller.signal,
						build: async (request) => {
							writeFileSync(request.outFile, "x");
							if (++count === 2) controller.abort(new Error("stop"));
						},
					};
				},
			],
			[
				"source error",
				() => ({ definition: { ...def(), roster: ["a", "b", "ghost"] } }),
			],
		];
		for (const [name, options] of failures) {
			seed();
			const before = snapshot(join(root, "out"));
			const failure = await publish(options()).then(
				() => undefined,
				(error) => error,
			);
			expect([name, failure]).not.toEqual([name, undefined]);
			expect([name, snapshot(join(root, "out"))]).toEqual([name, before]);
			expect([name, buildLeftovers()]).toEqual([name, []]);
			if (name === "custom builder error") {
				expect(describePublishFailure(failure, "out/")).toBe(
					"custom builder exploded\nNothing published; out/ left untouched.",
				);
			}
		}
	});

	test("a directory where an output goes fails preflight and leaves outputs alone", async () => {
		seed();
		mkdirSync(join(root, "out/b"));
		const before = snapshot(join(root, "out"));
		await expect(
			publish({ definition: def(), build: fakeBuilder() }),
		).rejects.toThrow("out/b is a directory; remove it and rerun");
		expect(snapshot(join(root, "out"))).toEqual(before);
	});

	test("a failing first rename publishes nothing", async () => {
		seed();
		chmodSync(join(root, "out"), 0o555);
		try {
			const before = snapshot(join(root, "out"));
			const failure = await publish({
				definition: def(),
				build: fakeBuilder(),
			}).then(
				() => undefined,
				(error) => error,
			);
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(PartialPublishError);
			expect(snapshot(join(root, "out"))).toEqual(before);
		} finally {
			chmodSync(join(root, "out"), 0o755);
		}
	});

	test.if(process.platform === "darwin")(
		"a rename failing after the first throws PartialPublishError",
		async () => {
			seed();
			writeFileSync(join(root, "out/b"), "old b");
			Bun.spawnSync(["chflags", "uchg", join(root, "out/b")]);
			try {
				const failure = await publish({
					definition: def(),
					build: fakeBuilder(),
				}).then(
					() => undefined,
					(error) => error,
				);
				expect(failure).toBeInstanceOf(PartialPublishError);
				expect((failure as PartialPublishError).renamed).toBe(1);
				expect(String(failure.message)).toStartWith(
					"out/ partly updated (1 of 2); rerun compile:all",
				);
				expect(readFileSync(join(root, "out/b"), "utf8")).toBe("old b");
			} finally {
				Bun.spawnSync(["chflags", "nouchg", join(root, "out/b")]);
			}
		},
	);

	test("an orphan that cannot be removed throws PruneError after every rename", async () => {
		seed();
		write("out/stuck/inner/file", "x");
		chmodSync(join(root, "out/stuck/inner"), 0o555);
		try {
			const failure = await publish({
				definition: def(),
				build: fakeBuilder(),
			}).then(
				() => undefined,
				(error) => error,
			);
			expect(failure).toBeInstanceOf(PruneError);
			expect(readFileSync(join(root, "out/b"), "utf8")).toBe(
				"binary for defs/b.md\n",
			);
			expect(existsSync(join(root, "out/keep"))).toBe(true);
		} finally {
			chmodSync(join(root, "out/stuck/inner"), 0o755);
		}
	});
});

describe("O18 configured watching", () => {
	test("explicit watch roots are watched and a burst publishes the roster once", async () => {
		addAgent("defs/a.md");
		addAgent("defs/b.md");
		mkdirSync(join(root, "prompts"));
		const fake = fakeWatch();
		const seen: BuildRequest[] = [];
		const logs: string[] = [];
		const watcher = startWatcher({
			definition: definition({
				roster: ["a", "b"],
				watchRoots: ["defs", "prompts", "absent"],
			}),
			watch: fake.watch,
			build: fakeBuilder(seen),
			debounceMs: 5,
			log: (line) => logs.push(line),
		});
		expect(watcher.roots).toEqual([join(root, "defs"), join(root, "prompts")]);
		for (let i = 0; i < 5; i++) fake.emit(join(root, "prompts"), "p.md");
		fake.emit(join(root, "defs"), "local/private.md");
		await sleep(40);
		await watcher.queue.idle();
		expect(seen.map((request) => request.label)).toEqual([
			"defs/a.md",
			"defs/b.md",
		]);
		expect(logs).toContain("rebuilt 2 agents");
		expect(logs.filter((line) => line.startsWith("change:"))).toHaveLength(5);
		expect(readdirSync(join(root, "out")).sort()).toEqual(["a", "b"]);
		watcher.close();
		expect(fake.watched.every((entry) => entry.closed)).toBe(true);
	});

	test("the default roots are every configured input root", () => {
		for (const dir of ["defs", "inc", "code", "texts"]) {
			mkdirSync(join(root, dir), { recursive: true });
		}
		const fake = fakeWatch();
		const watcher = startWatcher({
			definition: definition({
				roster: [],
				includeRoots: ["defs", "inc"],
				extensionCodeRoots: ["code"],
				extensionTextRoots: ["texts"],
			}),
			watch: fake.watch,
		});
		expect(watcher.roots).toEqual(
			["defs", "inc", "code", "texts"].map((dir) => join(root, dir)),
		);
		watcher.close();
	});

	test("requests during a rebuild serialize, and close cancels a pending one", async () => {
		const fake = fakeWatch();
		let active = 0;
		let peak = 0;
		let runs = 0;
		const watcher = startWatcher({
			definition: definition({ roster: [], watchRoots: ["defs"] }),
			watch: fake.watch,
			debounceMs: 1,
			rebuild: async () => {
				active++;
				runs++;
				peak = Math.max(peak, active);
				await sleep(20);
				active--;
			},
		});
		void watcher.queue.request();
		void watcher.queue.request();
		void watcher.queue.request();
		await watcher.queue.idle();
		expect(peak).toBe(1);
		expect(runs).toBe(2);

		fake.emit(join(root, "defs"), "a.md");
		watcher.close();
		await sleep(20);
		await watcher.queue.idle();
		expect(runs).toBe(2);
	});

	test("abort stops a running rebuild and keeps prior outputs", async () => {
		addAgent("defs/a.md");
		mkdirSync(join(root, "out"));
		writeFileSync(join(root, "out/a"), "old a");
		const controller = new AbortController();
		const fake = fakeWatch();
		const logs: string[] = [];
		const watcher = startWatcher({
			definition: definition({ roster: ["a"], watchRoots: ["defs"] }),
			watch: fake.watch,
			signal: controller.signal,
			log: (line) => logs.push(line),
			build: async (request) => {
				writeFileSync(request.outFile, "new");
				controller.abort(new Error("interrupted"));
			},
		});
		await watcher.queue.request();
		watcher.close();
		expect(readFileSync(join(root, "out/a"), "utf8")).toBe("old a");
		expect(logs.at(-1)).toBe(
			"rebuild failed:\ninterrupted\nNothing published; out/ left untouched.",
		);
		expect(buildLeftovers()).toEqual([]);
	});

	test("the compiler's own writes under a watch root never schedule a rebuild", async () => {
		const fake = fakeWatch();
		let runs = 0;
		const watcher = startWatcher({
			definition: definition({ roster: [], watchRoots: ["."] }),
			watch: fake.watch,
			debounceMs: 1,
			rebuild: async () => {
				runs++;
			},
		});
		fake.emit(root, "out/a");
		fake.emit(root, "out");
		fake.emit(root, ".troupe-build-abc/bin/a");
		fake.emit(root, ".agent-build-abc/entry.ts");
		await sleep(20);
		expect(runs).toBe(0);
		fake.emit(root, "evidence/run.md");
		await sleep(20);
		await watcher.queue.idle();
		expect(runs).toBe(1);
		watcher.close();
	});

	test("an outside write under a real watched root rebuilds once, not again", async () => {
		addAgent("defs/a.md");
		const logs: string[] = [];
		const watcher = startWatcher({
			definition: definition({ roster: ["a"], watchRoots: ["."] }),
			watch: watch as never,
			build: fakeBuilder(),
			debounceMs: 50,
			log: (line) => logs.push(line),
		});
		const rebuilds = (from: number) =>
			logs.slice(from).filter((line) => line === "rebuilt 1 agents").length;
		try {
			// Fixture setup events may still arrive; let them settle first.
			await sleep(400);
			await watcher.queue.idle();
			const mark = logs.length;
			write("evidence/run.md", "evidence\n");
			for (let i = 0; i < 40 && rebuilds(mark) === 0; i++) await sleep(50);
			await watcher.queue.idle();
			// Let the rebuild's own output and temp-dir events arrive.
			await sleep(600);
			await watcher.queue.idle();
			expect(rebuilds(mark)).toBe(1);
			expect(
				logs.filter((line) =>
					/^change: (out|\.(troupe|agent)-build-)/.test(line),
				),
			).toEqual([]);
			expect(existsSync(join(root, "out/a"))).toBe(true);
		} finally {
			watcher.close();
		}
	});
});

describe("canonical consumer boundary (O6 to O9)", () => {
	let outside: string;
	beforeEach(() => {
		outside = realpathSync(mkdtempSync(join(tmpdir(), "build-outside-")));
	});
	afterEach(() => {
		rmSync(outside, { recursive: true, force: true });
	});

	test("a symlinked root leading outside is refused for every field", async () => {
		symlinkSync(outside, join(root, "link"));
		const fields = [
			"declarationRoot",
			"includeRoots",
			"extensionCodeRoots",
			"extensionTextRoots",
			"watchRoots",
		] as const;
		for (const field of fields) {
			const extra: Partial<AgentBuildDefinition> =
				field === "declarationRoot"
					? { declarationRoot: "link" }
					: { [field]: ["link"] };
			const issues = await issuesOf(
				planBuild({ definition: definition({ roster: [], ...extra }) }),
			);
			expect([field, issues]).toEqual([
				field,
				[
					{
						file: "link",
						field,
						message: `root "link" resolves to ${outside}, outside the consumer root ${root}`,
					},
				],
			]);
		}
	});

	test("an absent root beneath a link leading outside is refused", async () => {
		symlinkSync(outside, join(root, "link"));
		const issues = await issuesOf(
			planBuild({
				definition: definition({ roster: [], includeRoots: ["link/absent"] }),
			}),
		);
		expect(issues).toEqual([
			{
				file: "link/absent",
				field: "includeRoots",
				message: `root "link/absent" resolves to ${join(outside, "absent")}, outside the consumer root ${root}`,
			},
		]);
	});

	test("a dangling link to an absent outside path is refused", async () => {
		symlinkSync(join(outside, "gone"), join(root, "dangling"));
		const issues = await issuesOf(
			planBuild({
				definition: definition({ roster: [], watchRoots: ["dangling"] }),
			}),
		);
		expect(issues.map((issue) => issue.field)).toEqual(["watchRoots"]);
	});

	test("an absent watch root inside the consumer is accepted and skipped", () => {
		const watcher = startWatcher({
			definition: definition({ roster: [], watchRoots: ["defs", "absent"] }),
			watch: fakeWatch().watch,
		});
		expect(watcher.roots).toEqual([join(root, "defs")]);
		watcher.close();
	});

	test("a consumer root reached through a symlink plans, loads and publishes", async () => {
		addAgent("defs/a.md");
		const alias = join(outside, "alias");
		symlinkSync(root, alias);
		const def = definition({ consumerRoot: alias, roster: ["a"] });
		expect((await planBuild({ definition: def })).entries[0]?.id).toBe("a");
		expect((await loadAgentDefinition(def, "defs/a.md")).id).toBe("a");
		const result = await publish({ definition: def, build: fakeBuilder() });
		expect(result.built).toEqual(["a"]);
		expect(readFileSync(join(root, "out/a"), "utf8")).toBe(
			"binary for defs/a.md\n",
		);
	});
});

describe("owned locations (O12, O18)", () => {
	test("an outDir containing the consumer root is refused and nothing is removed", async () => {
		addAgent("defs/a.md");
		write("prompts/p.md", "Prompt\n");
		write("package.json", "{}\n");
		const before = snapshot(root);
		const failure = await publish({
			definition: definition({ roster: ["a"], outDir: "." }),
			build: fakeBuilder(),
		}).then(
			() => undefined,
			(error) => error,
		);
		expect(failure).toBeInstanceOf(AgentSourceError);
		expect((failure as AgentSourceError).issues).toEqual([
			{
				file: ".",
				field: "outDir",
				message: `output directory "." contains the consumer root ${root}; pruning would remove its sources`,
			},
		]);
		expect(snapshot(root)).toEqual(before);
	});

	test("an input root inside outDir is refused, naming the root", async () => {
		const issues = await issuesOf(
			planBuild({
				definition: definition({
					roster: [],
					outDir: "out",
					includeRoots: ["out/prompts"],
				}),
			}),
		);
		expect(issues).toEqual([
			{
				file: "out/prompts",
				field: "includeRoots",
				message: 'root "out/prompts" lies inside the output directory "out"',
			},
		]);
	});

	test("an outDir equal to a watch root is refused, naming the root", async () => {
		const issues = await issuesOf(
			planBuild({
				definition: definition({
					roster: [],
					outDir: "generated",
					watchRoots: ["generated"],
				}),
			}),
		);
		expect(issues).toEqual([
			{
				file: "generated",
				field: "watchRoots",
				message:
					'root "generated" lies inside the output directory "generated"',
			},
		]);
	});

	test("a root under a temporary build name beside outDir is refused", async () => {
		const issues = await issuesOf(
			planBuild({
				definition: definition({
					roster: [],
					outDir: "out",
					extensionCodeRoots: [".troupe-build-keep/lib"],
					extensionTextRoots: [".agent-build-x"],
				}),
			}),
		);
		expect(issues).toEqual([
			{
				file: ".troupe-build-keep/lib",
				field: "extensionCodeRoots",
				message:
					'root ".troupe-build-keep/lib" lies inside the temporary build directory .troupe-build-keep beside the output directory "out"',
			},
			{
				file: ".agent-build-x",
				field: "extensionTextRoots",
				message:
					'root ".agent-build-x" lies inside the temporary build directory .agent-build-x beside the output directory "out"',
			},
		]);
	});
});

describe("one naming coordinate (O6)", () => {
	test("a symlinked declaration root names agents from its real location", async () => {
		mkdirSync(join(root, "sources/team"), { recursive: true });
		rmSync(join(root, "defs"), { recursive: true });
		symlinkSync(join(root, "sources"), join(root, "defs"));
		addAgent("defs/team/a.md");
		const def = definition({ roster: ["team:a"] });
		const plan = await planBuild({ definition: def });
		expect(
			plan.entries.map((entry) => [entry.id, entry.agent.spec.id]),
		).toEqual([["team:a", "team:a"]]);
		expect((await loadAgentDefinition(def, "defs/team/a.md")).id).toBe(
			"team:a",
		);
		expect(resolveAgentName(def, "defs/team/a.md", root)).toBe("team:a");
		mkdirSync(join(root, "out"));
		const built = await compileAgent({
			definition: def,
			file: "defs/team/a.md",
			outFile: "out/team:a",
			build: fakeBuilder(),
		});
		expect(built.id).toBe("team:a");
		const entry = plan.entries[0];
		if (!entry) throw new Error("no entry");
		expect(generateEntry(entry.agent)).toContain('"id": "team:a"');
	});
});

describe("watcher filter in canonical coordinates (O18)", () => {
	test("output and temp writes seen through a symlinked root schedule nothing", async () => {
		mkdirSync(join(root, "generated"));
		symlinkSync(join(root, "generated"), join(root, "watched"));
		const fake = fakeWatch();
		let runs = 0;
		const watcher = startWatcher({
			definition: definition({
				roster: [],
				outDir: "generated/out",
				watchRoots: ["watched", "defs"],
			}),
			watch: fake.watch,
			debounceMs: 1,
			rebuild: async () => {
				runs++;
			},
		});
		fake.emit(join(root, "watched"), "out/a");
		fake.emit(join(root, "watched"), ".troupe-build-x/bin/a");
		await sleep(20);
		expect(runs).toBe(0);
		fake.emit(join(root, "defs"), "a.md");
		await sleep(20);
		await watcher.queue.idle();
		expect(runs).toBe(1);
		watcher.close();
	});

	for (const [name, extra] of [
		["a watch root of the consumer root", { watchRoots: ["."] }],
		["an include root of the consumer root", { includeRoots: ["."] }],
	] as const) {
		test(`local/ events from ${name} schedule nothing`, async () => {
			mkdirSync(join(root, "defs/local"));
			const fake = fakeWatch();
			let runs = 0;
			const watcher = startWatcher({
				definition: definition({ roster: [], ...extra }),
				watch: fake.watch,
				debounceMs: 1,
				rebuild: async () => {
					runs++;
				},
			});
			fake.emit(root, "defs/local/p.md");
			await sleep(20);
			expect(runs).toBe(0);
			fake.emit(root, "defs/p.md");
			await sleep(20);
			await watcher.queue.idle();
			expect(runs).toBe(1);
			watcher.close();
		});
	}
});
