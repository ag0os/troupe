import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentSourceError, type SourceIssue } from "../lib/agent-format/errors";
import {
	type BuildEntry,
	createSerialQueue,
	describePublishFailure,
	LOCAL_AGENTS_WARNING,
	PartialPublishError,
	PruneError,
	type PublishOptions,
	planBuild,
	preflightPublish,
	protectedBinaries,
	publish,
	ROSTER,
	resolveAgentName,
	startWatcher,
	WATCH_ROOTS,
} from "./agent-compiler";

let root: string;
let outDir: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-publish-")));
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, "system-prompts"));
	outDir = join(root, "bin");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string) {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

const header = "---\ndescription: Fixture\nbackends: [claude, codex]\n";

/** A declaration whose body is `body`. */
function addDeclaration(path: string, body = path) {
	write(path, `${header}---\n${body}\n`);
}

/** A stray TypeScript file that is not an extension. */
function stray(path: string) {
	write(path, 'console.log("stray");\n');
}

/** The system prompt a built binary previews. */
function previewedPrompt(binary: string): string {
	const preview = run(binary, ["--show-prompt"]);
	expect(preview.code).toBe(0);
	return preview.stdout.split("--- System prompt ---\n")[1]?.split("\n")[0] ?? "";
}

/** Every entry under `dir`: type, mode and content, keyed by relative path. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	const walk = (current: string, prefix: string) => {
		for (const name of readdirSync(current).sort()) {
			const full = join(current, name);
			const stat = lstatSync(full);
			const key = `${prefix}${name}`;
			if (stat.isSymbolicLink()) {
				out[key] = `link ${readlinkSync(full)}`;
			} else if (stat.isDirectory()) {
				out[key] = `dir ${stat.mode}`;
				walk(full, `${key}/`);
			} else {
				out[key] =
					`file ${stat.mode} ${stat.mtimeMs} ${readFileSync(full).toString("base64")}`;
			}
		}
	};
	walk(dir, "");
	return out;
}

/** An output directory with an existing roster binary and an orphan. */
function seedOutDir() {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "a"), "old a binary");
	chmodSync(join(outDir, "a"), 0o755);
	writeFileSync(join(outDir, "orphan"), "stale");
	writeFileSync(join(outDir, "local:mine"), "private");
}

function opts(extra: Partial<PublishOptions> = {}): PublishOptions {
	return { root, outDir, roster: ["a", "ns:b"], ...extra };
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

function run(binary: string, args: string[] = []) {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

function tempLeftovers(): string[] {
	return readdirSync(dirname(outDir)).filter((name) =>
		name.startsWith(".troupe-build-"),
	);
}

describe("roster", () => {
	test("is the fixed 22 names and matches today's agents/ sources", () => {
		expect(ROSTER.length).toBe(22);
		expect(new Set(ROSTER).size).toBe(22);
		// D-036: personas:github was removed from the hub.
		expect(ROSTER as readonly string[]).not.toContain("personas:github");
		const repo = resolve(import.meta.dir, "..");
		return planBuild({ root: repo }).then((plan) => {
			expect(plan.entries.map((entry) => entry.id)).toEqual([...ROSTER].sort());
			for (const entry of plan.entries) {
				expect([entry.id, entry.source]).toEqual([
					entry.id,
					`agents/${entry.id.split(":").join("/")}.md`,
				]);
			}
		});
	});
});

describe("the real roster (D-036)", () => {
	const sourceOf = (id: string) => `agents/${id.split(":").join("/")}.md`;

	test("the 22 roster declarations satisfy the roster check", async () => {
		for (const id of ROSTER) write(sourceOf(id), `${header}---\n${id}\n`);
		const plan = await planBuild({ root });
		expect(plan.entries.map((entry) => entry.id)).toEqual([...ROSTER].sort());
	});

	test("a personas:github declaration is refused, and a missing one is not required", async () => {
		for (const id of ROSTER) write(sourceOf(id), `${header}---\n${id}\n`);
		write("agents/personas/github.md", `${header}---\nGitHub\n`);
		const issues = await issuesOf(planBuild({ root }));
		expect(issues).toEqual([
			expect.objectContaining({
				file: "agents/personas/github.md",
				field: "roster",
				message: '"personas:github" is not a roster agent',
			}),
		]);
	});
});

describe("extensions (D-017)", () => {
	test("a paired TS that exports prepare and is side-effect free is the extension", async () => {
		addDeclaration("agents/a.md", "A body");
		write(
			"agents/a.ts",
			'export function prepare() { return { systemPromptFragments: ["From prepare"] }; }\n',
		);
		addDeclaration("agents/ns/b.md", "B body");
		const plan = await planBuild(opts());
		expect(plan.entries[0]?.agent.extension?.exports).toEqual(["prepare"]);
		expect(plan.entries[1]?.agent.extension).toBeUndefined();
	});

	test("a paired TS that exports prepare but runs code on import fails with file and line", async () => {
		addDeclaration("agents/a.md", "A body");
		write(
			"agents/a.ts",
			'export function prepare() { return {}; }\nconsole.log("boot");\n',
		);
		addDeclaration("agents/ns/b.md", "B body");
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual([
			expect.objectContaining({
				file: "agents/a.ts",
				line: 2,
				field: "top-level",
			}),
		]);
	});
});

describe("declarations only (D-017)", () => {
	test("discovers Markdown only and accepts same-stem extensions and test files", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		write(
			"agents/a.ts",
			"export function finish() { return { exitCode: 0 }; }\n",
		);
		write("agents/ns/b.md", `${header}---\nB body\n`);
		write("agents/ns/b.test.ts", 'import "bun:test";\n');
		const plan = await planBuild(opts());
		expect(
			plan.entries.map((entry) => [entry.id, entry.source]),
		).toEqual([
			["a", "agents/a.md"],
			["ns:b", "agents/ns/b.md"],
		]);
	});

	test("rejects an unpaired .ts and a paired .ts without prepare/finish, naming file and field", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		stray("agents/a.ts");
		write("agents/ns/b.md", `${header}---\nB body\n`);
		stray("agents/ns/stray.ts");
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: "agents/ns/stray.ts", field: "path" }),
				expect.objectContaining({ file: "agents/a.ts", field: "exports" }),
			]),
		);
		expect(issues.length).toBe(2);
	});

	test("a .ts alone does not satisfy the roster", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		stray("agents/ns/b.ts");
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: "agents/ns/b.ts", field: "path" }),
				expect.objectContaining({ file: "agents/ns/b.md", field: "roster" }),
			]),
		);
	});

	test("roster errors publish nothing", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		stray("agents/ns/b.ts");
		const before = snapshot(root);
		await issuesOf(publish(opts()));
		expect(snapshot(root)).toEqual(before);
	});
});

describe("roster errors (B-001/D-008)", () => {
	test("missing, extra and out-of-roster names each name file and field", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		write("agents/extra.md", `${header}---\nExtra\n`);
		const before = snapshot(root);
		const issues = await issuesOf(publish(opts()));
		expect(issues).toEqual([
			{
				file: "agents/extra.md",
				field: "roster",
				message: '"extra" is not a roster agent',
			},
			{
				file: "agents/ns/b.md",
				field: "roster",
				message: 'roster agent "ns:b" has no declaration',
			},
		]);
		expect(snapshot(root)).toEqual(before);
	});

	test("an invalid declaration anywhere publishes nothing", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		write("agents/ns/b.md", `${header}unknown: 1\n---\n`);
		const before = snapshot(root);
		const issues = await issuesOf(publish(opts()));
		expect(issues).toEqual([
			expect.objectContaining({ file: "agents/ns/b.md", field: "unknown" }),
		]);
		expect(snapshot(root)).toEqual(before);
	});

	test("an include outside agents/ and system-prompts/ fails naming file and field (D-027)", async () => {
		seedOutDir();
		write("docs/outside.md", "Outside");
		write("system-prompts/inside.md", "Inside");
		write(
			"agents/a.md",
			`${header}includes:\n  - ../system-prompts/inside.md\n  - ../docs/outside.md\n---\nA\n`,
		);
		symlinkSync(join(root, "docs"), join(root, "system-prompts/linked"));
		write(
			"agents/ns/b.md",
			`${header}includes: [../../system-prompts/linked/outside.md]\n---\nB\n`,
		);
		const before = snapshot(root);
		const issues = await issuesOf(publish(opts()));
		expect(issues).toEqual([
			expect.objectContaining({
				file: "agents/a.md",
				line: 6,
				field: "includes[1]",
			}),
			expect.objectContaining({
				file: "agents/ns/b.md",
				field: "includes[0]",
			}),
		]);
		expect(snapshot(root)).toEqual(before);
	});
});

describe("publication (D-011, D-023)", () => {
	test("a failing build leaves the output directory byte-identical", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		write(
			"agents/ns/b.ts",
			'import { missing } from "troupe-package-that-does-not-exist";\nexport function prepare() { return missing(); }\n',
		);
		const before = snapshot(outDir);
		const parent = readdirSync(root).sort();
		await expect(publish(opts())).rejects.toThrow(/bun build failed/);
		expect(snapshot(outDir)).toEqual(before);
		expect(readdirSync(root).sort()).toEqual(parent);
	}, 120_000);

	test("an abort during the build leaves the output directory untouched", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		const before = snapshot(outDir);
		const controller = new AbortController();
		const pending = publish(opts({ signal: controller.signal }));
		setTimeout(() => controller.abort(new Error("stop")), 50);
		await expect(pending).rejects.toThrow("stop");
		expect(snapshot(outDir)).toEqual(before);
		expect(tempLeftovers()).toEqual([]);
	}, 120_000);

	test("--dry-run reports builds and prunes and writes nothing", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		mkdirSync(join(root, "agents/local"));
		const before = snapshot(root);
		const lines: string[] = [];
		const result = await publish(
			opts({ dryRun: true, log: (line) => lines.push(line) }),
		);
		expect(result).toEqual({
			built: ["a", "ns:b"],
			pruned: ["local:mine", "orphan"],
			dryRun: true,
		});
		expect(lines).toEqual([
			LOCAL_AGENTS_WARNING,
			"would build a (agents/a.md)",
			"would build ns:b (agents/ns/b.md)",
			"would prune local:mine",
			"would prune orphan",
		]);
		expect(snapshot(root)).toEqual(before);
	});

	test("default prune removes orphans and local:* but spares other compile:* binaries; --no-prune keeps orphans", async () => {
		seedOutDir();
		writeFileSync(join(outDir, "helper"), "owned by compile:helper");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					"compile:helper":
						"bun build --compile tools/helper.ts --outfile bin/helper",
					other: "bun build --compile x.ts --outfile bin/orphan",
				},
			}),
		);
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");

		const kept = await publish(opts({ prune: false }));
		expect(kept.pruned).toEqual([]);
		expect(readdirSync(outDir).sort()).toEqual([
			"a",
			"helper",
			"local:mine",
			"ns:b",
			"orphan",
		]);
		expect(readFileSync(join(outDir, "a")).toString()).not.toBe("old a binary");

		const pruned = await publish(opts());
		expect(pruned.pruned).toEqual(["local:mine", "orphan"]);
		expect(readdirSync(outDir).sort()).toEqual(["a", "helper", "ns:b"]);
		expect(readFileSync(join(outDir, "helper")).toString()).toBe(
			"owned by compile:helper",
		);
		expect(previewedPrompt(join(outDir, "ns:b"))).toBe("B body");
		expect(tempLeftovers()).toEqual([]);
	}, 240_000);

	test("protectedBinaries reads only compile:* scripts", () => {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					"compile:x": "bun build --compile a.ts --outfile ./bin/x",
					"compile:y": "bun build --compile a.ts --outfile=bin/y",
					"compile:q": 'bun build --compile a.ts --outfile "bin/q"',
					"compile:s": "bun build --compile a.ts --outfile='./bin/s'",
					"compile:o": "bun build --compile a.ts -o bin/o && echo done",
					"compile:two":
						"bun build --compile a.ts --outfile bin/t1 && bun build --compile b.ts -o=bin/t2",
					"compile:up":
						"cd tools && bun build --compile a.ts --outfile ../bin/up",
					"compile:nested": "bun build --compile a.ts --outfile bin/sub/n",
					"compile:no": "bun build --compile a.ts --no-bundle bin/no",
					build: "bun build --compile a.ts --outfile bin/z",
				},
			}),
		);
		expect([...protectedBinaries(root)].sort()).toEqual([
			"o",
			"q",
			"s",
			// bin/sub/n: prune works on top-level entries, so "sub" is kept.
			"sub",
			"t1",
			"t2",
			"x",
			"y",
		]);
		rmSync(join(root, "package.json"));
		expect(protectedBinaries(root).size).toBe(0);
	});
});

describe("single compile (D-011)", () => {
	test("builds only the named roster agent and prunes nothing", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		const result = await publish(opts({ only: "ns:b" }));
		expect(result).toEqual({ built: ["ns:b"], pruned: [], dryRun: false });
		expect(readdirSync(outDir).sort()).toEqual([
			"a",
			"local:mine",
			"ns:b",
			"orphan",
		]);
		expect(readFileSync(join(outDir, "a")).toString()).toBe("old a binary");
		expect(previewedPrompt(join(outDir, "ns:b"))).toBe("B body");
	}, 120_000);

	test("a name outside the roster fails and writes nothing", async () => {
		seedOutDir();
		addDeclaration("agents/extra.md");
		const before = snapshot(root);
		for (const only of ["extra", "nope", "local:mine"]) {
			const issues = await issuesOf(publish(opts({ only })));
			expect(issues).toEqual([
				expect.objectContaining({
					field: "roster",
					message: `"${only}" is not a roster agent`,
				}),
			]);
		}
		expect(snapshot(root)).toEqual(before);
	});

	test("an unrelated unpaired .ts fails a single compile and leaves bin/ unchanged (D-017)", async () => {
		seedOutDir();
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		stray("agents/stray.ts");
		const before = snapshot(outDir);
		const issues = await issuesOf(publish(opts({ only: "ns:b" })));
		expect(issues).toEqual([
			expect.objectContaining({ file: "agents/stray.ts", field: "path" }),
		]);
		expect(snapshot(outDir)).toEqual(before);
		expect(tempLeftovers()).toEqual([]);
	});

	test("another declaration's hookless or .tsx sibling fails a single compile", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		stray("agents/a.ts");
		addDeclaration("agents/ns/b.md", "B body");
		addDeclaration("agents/ns/c.md", "C body");
		write("agents/ns/c.tsx", "export function prepare() { return {}; }\n");
		const issues = await issuesOf(
			publish(opts({ roster: ["a", "ns:b", "ns:c"], only: "ns:b" })),
		);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: "agents/a.ts", field: "exports" }),
				expect.objectContaining({ file: "agents/ns/c.tsx", field: "path" }),
			]),
		);
		expect(issues.length).toBe(2);
		expect(existsSync(outDir)).toBe(false);
	});

	test("a sibling that is an extension does not fail a single compile of another agent", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		write("agents/a.ts", "export function prepare() { return {}; }\n");
		addDeclaration("agents/ns/b.md", "B body");
		const plan = await planBuild(opts({ only: "ns:b" }));
		expect(plan.entries.map((entry) => entry.id)).toEqual(["ns:b"]);
	});

	test("a roster name without a source fails naming the expected file", async () => {
		const issues = await issuesOf(publish(opts({ only: "ns:b" })));
		expect(issues).toEqual([
			expect.objectContaining({ file: "agents/ns/b.md", field: "roster" }),
		]);
	});

	test("resolveAgentName accepts a roster name or a source path", () => {
		expect(resolveAgentName(root, "ns:b")).toBe("ns:b");
		expect(resolveAgentName(root, "agents/ns/b.md", root)).toBe("ns:b");
		expect(resolveAgentName(root, "agents/ns/b.ts", root)).toBe("ns:b");
		expect(resolveAgentName(root, "b.ts", join(root, "agents/ns"))).toBe(
			"ns:b",
		);
	});

	test("a path outside agents/ is not mapped to a same-named roster agent", async () => {
		addDeclaration("agents/shepherd.md");
		write("system-prompts/shepherd.md", "fragment");
		expect(resolveAgentName(root, "system-prompts/shepherd.md", root)).toBe(
			"system-prompts/shepherd.md",
		);
		expect(resolveAgentName(root, "shepherd.ts", root)).toBe("shepherd.ts");
		expect(resolveAgentName(root, "../x/shepherd.ts", root)).toBe(
			"../x/shepherd.ts",
		);
		for (const argument of ["system-prompts/shepherd.md", "shepherd.ts"]) {
			const issues = await issuesOf(
				publish(
					opts({
						roster: ["shepherd"],
						only: resolveAgentName(root, argument, root),
					}),
				),
			);
			expect(issues).toEqual([
				expect.objectContaining({
					field: "roster",
					message: `"${argument}" is not a roster agent`,
				}),
			]);
		}
		expect(existsSync(outDir)).toBe(false);
	});
});

describe("agents/local/ (D-011)", () => {
	test("is never discovered, and a present directory gives one warning line", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		write("agents/local/broken.md", "not a declaration");
		write("agents/local/mine.ts", 'throw new Error("never built");\n');
		const plan = await planBuild(opts());
		expect(plan.entries.map((entry) => entry.id)).toEqual(["a", "ns:b"]);
		expect(plan.warnings).toEqual([LOCAL_AGENTS_WARNING]);
		const narrowed = await planBuild(opts({ roster: ["a"] })).catch(
			(error: AgentSourceError) => error.issues,
		);
		expect(JSON.stringify(narrowed)).not.toContain("agents/local");

		rmSync(join(root, "agents/local"), { recursive: true });
		expect((await planBuild(opts())).warnings).toEqual([]);
	});
});

describe("watcher (D-011, D-027)", () => {
	test("the serial queue never overlaps and coalesces a burst into one follow-up", async () => {
		let active = 0;
		let maxActive = 0;
		let runs = 0;
		const gates: (() => void)[] = [];
		const queue = createSerialQueue(async () => {
			runs++;
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((done) => gates.push(done));
			active--;
		});
		const first = queue.request();
		const second = queue.request();
		const third = queue.request();
		expect(second).toBe(third);
		expect(runs).toBe(1);
		gates.shift()?.();
		await first;
		await Bun.sleep(0);
		expect(runs).toBe(2);
		gates.shift()?.();
		await second;
		expect(maxActive).toBe(1);
		await queue.idle();
		expect(runs).toBe(2);
	});

	test("a failing run does not stop the queue", async () => {
		let runs = 0;
		const queue = createSerialQueue(async () => {
			runs++;
			if (runs === 1) throw new Error("boom");
		});
		await queue.request();
		await queue.request();
		expect(runs).toBe(2);
	});

	test("watches exactly agents/ and system-prompts/ and rebuilds everything on any change", async () => {
		mkdirSync(join(root, "settings"));
		mkdirSync(join(root, "lib"));
		const watched: string[] = [];
		const listeners: ((event: string, name: string | null) => void)[] = [];
		let rebuilds = 0;
		const watcher = startWatcher({
			root,
			debounceMs: 5,
			watch: (dir, options, listener) => {
				expect(options.recursive).toBe(true);
				watched.push(dir);
				listeners.push(listener);
				return { close() {} };
			},
			rebuild: async () => {
				rebuilds++;
			},
		});
		expect(WATCH_ROOTS).toEqual(["agents", "system-prompts"]);
		expect(watched).toEqual([
			join(root, "agents"),
			join(root, "system-prompts"),
		]);

		const [agents, prompts] = listeners;
		agents?.("change", "local/mine.ts");
		agents?.("rename", "local");
		await Bun.sleep(30);
		expect(rebuilds).toBe(0);

		agents?.("change", "ns/b.md");
		prompts?.("change", "shared.md");
		agents?.("change", "a.ts");
		for (let waited = 0; rebuilds === 0 && waited < 5_000; waited += 10) {
			await Bun.sleep(10);
		}
		await Bun.sleep(50);
		await watcher.queue.idle();
		expect(rebuilds).toBe(1);
		watcher.close();
	});

	test("a real rebuild publishes through the shared compiler", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		const lines: string[] = [];
		const watcher = startWatcher({
			...opts(),
			watch: () => ({ close() {} }),
			log: (line) => lines.push(line),
		});
		await watcher.queue.request();
		watcher.close();
		expect(lines).toContain("rebuilt 2 agents");
		expect(readdirSync(outDir).sort()).toEqual(["a", "ns:b"]);
	}, 120_000);
});

describe("package scripts", () => {
	const repo = resolve(import.meta.dir, "..");
	const scripts = JSON.parse(
		readFileSync(join(repo, "package.json"), "utf8"),
	).scripts;

	test("compile, compile:all and watch all run the shared compiler", () => {
		expect(scripts.compile).toBe("bun scripts/compile.ts");
		expect(scripts["compile:all"]).toBe("bun scripts/compile-all.ts");
		expect(scripts.watch).toBe("bun scripts/watch-agents.ts");
		for (const script of ["compile", "compile-all", "watch-agents"]) {
			const text = readFileSync(join(repo, `scripts/${script}.ts`), "utf8");
			expect(text).toContain('from "./agent-compiler"');
			expect(text).not.toContain("bun build");
		}
	});

	function cli(script: string, args: string[]) {
		const child = Bun.spawnSync(
			[process.execPath, join(repo, "scripts", script), ...args],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		return {
			code: child.exitCode,
			stdout: child.stdout.toString(),
			stderr: child.stderr.toString(),
		};
	}

	test("compile-all --dry-run over the full roster writes nothing", () => {
		for (const id of ROSTER) addDeclaration(`agents/${id.split(":").join("/")}.md`);
		mkdirSync(join(root, "agents/local"));
		seedOutDir();
		const before = snapshot(root);
		const result = cli("compile-all.ts", ["--dry-run"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe(`${LOCAL_AGENTS_WARNING}\n`);
		expect(result.stdout).toContain("22 would be built, 3 would be pruned.");
		expect(snapshot(root)).toEqual(before);
	});

	test("compile-all rejects an unknown argument, and on a roster error names the file", () => {
		expect(cli("compile-all.ts", ["--mode=mixed"]).code).toBe(1);
		seedOutDir();
		stray("agents/extra.ts");
		const before = snapshot(root);
		const result = cli("compile-all.ts", []);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"agents/extra.ts: path: only Markdown declarations are built",
		);
		expect(result.stderr).toContain(
			'agents/shepherd.md: roster: roster agent "shepherd" has no declaration',
		);
		expect(snapshot(root)).toEqual(before);
	});

	test("compile of one roster agent fails on an unrelated stray .ts and writes nothing", () => {
		for (const id of ROSTER)
			addDeclaration(`agents/${id.split(":").join("/")}.md`, id);
		stray("agents/stray.ts");
		seedOutDir();
		const before = snapshot(root);
		const result = cli("compile.ts", ["shepherd"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"agents/stray.ts: path: only Markdown declarations are built",
		);
		expect(result.stderr).toContain("✗ shepherd failed");
		expect(snapshot(root)).toEqual(before);
	});

	test("compile rejects a name outside the roster", () => {
		seedOutDir();
		addDeclaration("agents/extra.md");
		const before = snapshot(root);
		const result = cli("compile.ts", ["agents/extra.md"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'agents/extra.md: roster: "extra" is not a roster agent',
		);
		expect(snapshot(root)).toEqual(before);
	});
});

describe("fix round 1: paired siblings (D-017)", () => {
	for (const [label, text] of [
		["export default", 'console.log("legacy");\nexport default {};\n'],
		["export =", 'console.log("legacy");\nexport = {};\n'],
	] as const) {
		test(`a paired sibling with ${label} and no hooks fails`, async () => {
			write("agents/a.md", `${header}---\nA body\n`);
			write("agents/a.ts", text);
			write("agents/ns/b.md", `${header}---\nB body\n`);
			const issues = await issuesOf(planBuild(opts()));
			expect(issues).toEqual([
				expect.objectContaining({ file: "agents/a.ts", field: "exports" }),
			]);
		});
	}

	test("a problem that could hide a hook names its line", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		write("agents/a.ts", 'export * from "node:path";\n');
		addDeclaration("agents/ns/b.md", "B body");
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual([
			expect.objectContaining({
				file: "agents/a.ts",
				line: 1,
				field: "exports",
				message: expect.stringContaining("export *"),
			}),
		]);
	});

	test("a hook file that also has export default fails", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		write(
			"agents/a.ts",
			"export function prepare() { return {}; }\nexport default {};\n",
		);
		addDeclaration("agents/ns/b.md", "B body");
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual([
			expect.objectContaining({
				file: "agents/a.ts",
				line: 2,
				field: "exports",
			}),
		]);
	});

	test("a same-stem .tsx beside a declaration fails naming the file", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		write("agents/a.tsx", "export function prepare() { return {}; }\n");
		write("agents/ns/b.md", `${header}---\nB body\n`);
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual([
			{
				file: "agents/a.tsx",
				field: "path",
				message:
					"an extension must be a same-stem .ts file; a .tsx beside a declaration is not read",
			},
		]);
	});

	test("an unpaired .tsx is refused", async () => {
		write("agents/a.md", `${header}---\nA body\n`);
		write("agents/ns/b.tsx", 'console.log("b");\n');
		const issues = await issuesOf(planBuild(opts()));
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ file: "agents/ns/b.tsx", field: "path" }),
			]),
		);
	});
});

describe("fix round 1: publication safety (D-011, D-023)", () => {
	test("sequential builds: a roster-sized set of declarations, published three times, each binary previews its own body", async () => {
		const roster = Array.from(
			{ length: ROSTER.length },
			(_, i) => `ns:agent-${i}`,
		);
		for (const id of roster) addDeclaration(`agents/ns/${id.slice(3)}.md`, id);
		for (let round = 0; round < 3; round++) {
			const result = await publish(opts({ roster }));
			expect(result.built).toEqual([...roster].sort());
			for (const id of roster) {
				expect([id, previewedPrompt(join(outDir, id))]).toEqual([id, id]);
			}
			expect(tempLeftovers()).toEqual([]);
		}
	}, 600_000);

	test("a directory at a roster name: nothing is written and the message says untouched", async () => {
		seedOutDir();
		mkdirSync(join(outDir, "ns:b"));
		writeFileSync(join(outDir, "ns:b", "keep"), "keep");
		write("agents/a.md", `${header}---\nA body\n`);
		addDeclaration("agents/ns/b.md", "B body");
		const before = snapshot(outDir);
		let failure: unknown;
		await publish(opts()).catch((error) => {
			failure = error;
		});
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(PartialPublishError);
		expect(describePublishFailure(failure)).toBe(
			"bin/ns:b is a directory; remove it and rerun\nNothing published; bin/ left untouched.",
		);
		expect(snapshot(outDir)).toEqual(before);
		expect(tempLeftovers()).toEqual([]);
	}, 120_000);

	test("preflight rejects a missing, empty or non-file build output", () => {
		const built = join(root, "built");
		mkdirSync(built);
		mkdirSync(outDir);
		const entries = ["gone", "empty", "dir", "ok"].map(
			(id) => ({ id, source: `agents/${id}.md` }) as BuildEntry,
		);
		writeFileSync(join(built, "empty"), "");
		mkdirSync(join(built, "dir"));
		writeFileSync(join(built, "ok"), "binary");
		expect(() => preflightPublish(entries, built, outDir)).toThrow(
			[
				"build of gone reported success but produced no file",
				"build of empty reported success but produced an empty file",
				"build of dir reported success but produced no regular file",
			].join("\n"),
		);
		expect(() =>
			preflightPublish(entries.slice(3), built, outDir),
		).not.toThrow();
	});

	test("failure messages say whether bin/ was touched", () => {
		const cause = new Error("EISDIR");
		expect(
			describePublishFailure(new PartialPublishError("bin/", 3, 22, cause)),
		).toBe("bin/ partly updated (3 of 22); rerun compile:all\nEISDIR");
		expect(
			describePublishFailure(new PruneError("bin/", 22, "old", cause)),
		).toBe("bin/ updated (22 of 22), but pruning old failed: EISDIR");
		expect(describePublishFailure(new Error("bun build failed"))).toBe(
			"bun build failed\nNothing published; bin/ left untouched.",
		);
		expect(
			describePublishFailure(
				new AgentSourceError([
					{ file: "agents/a.md", field: "x", message: "bad" },
				]),
			),
		).toBe("agents/a.md: x: bad\nNothing published; bin/ left untouched.");
	});

	for (const signals of [["SIGINT", "SIGINT"], ["SIGHUP"]] as const) {
		test(`compile-all on ${signals.join(" then ")} removes its temp dir and leaves bin/ untouched`, async () => {
			for (const id of ROSTER) addDeclaration(`agents/${id.split(":").join("/")}.md`, id);
			seedOutDir();
			const before = snapshot(outDir);
			const child = Bun.spawn(
				[process.execPath, resolve(import.meta.dir, "compile-all.ts")],
				{ cwd: root, stdout: "pipe", stderr: "pipe" },
			);
			const reader = child.stdout.getReader();
			let seen = "";
			while (!seen.includes("built ")) {
				const chunk = await reader.read();
				if (chunk.done) break;
				seen += new TextDecoder().decode(chunk.value);
			}
			expect(seen).toContain("built ");
			for (const signal of signals) {
				child.kill(signal);
				await Bun.sleep(20);
			}
			reader.releaseLock();
			const code = await child.exited;
			const stderr = await new Response(child.stderr).text();
			expect(code).toBe(signals[0] === "SIGHUP" ? 129 : 130);
			expect(stderr).toContain(
				"Interrupted; nothing published, bin/ left untouched.",
			);
			expect(snapshot(outDir)).toEqual(before);
			expect(tempLeftovers()).toEqual([]);
		}, 120_000);
	}

	test(".troupe-build-*/ is gitignored", () => {
		const ignore = readFileSync(
			resolve(import.meta.dir, "../.gitignore"),
			"utf8",
		);
		expect(ignore.split("\n")).toContain(".troupe-build-*/");
	});
});
