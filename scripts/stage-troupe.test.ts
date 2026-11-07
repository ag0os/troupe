import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { installFakeClis, readRecords } from "../lib/agent-format/fake-cli";
import { relativeClosure } from "./import-closure";
import { readSurface, surfaceModule } from "./stage-surface";
import {
	DEFAULT_STAGE,
	STAGE_MANIFEST,
	StageError,
	stageTroupe,
	TEMPORARY_MEMBERS,
} from "./stage-troupe";

/** The staged inventory, pinned: any change to it is a reviewed change. */
const STAGED_MEMBERS = [
	"lib/agent-format/adapters/claude.ts",
	"lib/agent-format/adapters/codex.ts",
	"lib/agent-format/adapters/index.ts",
	"lib/agent-format/adapters/shared.ts",
	"lib/agent-format/adapters/types.ts",
	"lib/agent-format/binary-name.ts",
	"lib/agent-format/cli.ts",
	"lib/agent-format/command-text.ts",
	"lib/agent-format/compiler.ts",
	"lib/agent-format/errors.ts",
	"lib/agent-format/fake-cli.ts",
	"lib/agent-format/interpolate.ts",
	"lib/agent-format/path-within.ts",
	"lib/agent-format/preview.ts",
	"lib/agent-format/run.ts",
	"lib/agent-format/schema.ts",
	"lib/agent-format/template.ts",
	"lib/agent-format/types.ts",
	"lib/entries/cli.ts",
	"lib/entries/compiler.ts",
	"lib/entries/declaration.ts",
	"lib/entries/provenance.ts",
	"lib/entries/runtime.ts",
	"lib/entries/testing.ts",
	"lib/index.ts",
	"lib/text-imports.d.ts",
	"scripts/shepherd-source.ts",
];

/** The public surface per subpath (design.md section 2, E1 to E9; PR 2 adds the definition types). */
const EXPECTED_SURFACE: Record<string, { values: string[]; types?: string[] }> =
	{
		troupe: {
			values: [
				"BACKENDS",
				"PROMPT_MODES",
				"AGENT_MODES",
				"ACCESS_LEVELS",
				"FRAMEWORK_OPTIONS",
				"FRAMEWORK_SHORTS",
				"forwardsPassthrough",
				"EXTENSION_EXPORTS",
			],
		},
		"troupe/declaration": {
			values: [
				"parseAgentMarkdown",
				"materializeAgentSpec",
				"PROMPT_SEPARATOR",
				"AgentSourceError",
				"formatIssue",
			],
			types: ["ParsedAgent", "IncludeText", "SourceIssue"],
		},
		"troupe/cli": {
			values: [
				"parseCli",
				"resolveCli",
				"resolveVersion",
				"formatHelp",
				"CliError",
			],
			types: ["ParsedInvocation", "CliOutcome", "CliIo"],
		},
		"troupe/runtime": {
			values: [
				"previewAgent",
				"executeAgent",
				"runDispatch",
				"previewAndExit",
				"runAndExit",
				"dispatchAndExit",
			],
			types: [
				"AgentExtension",
				"PreviewIo",
				"ExecuteIo",
				"DispatchIo",
				"SignalSource",
				"RunnerSignal",
			],
		},
		"troupe/compiler": {
			values: [
				"loadAgentDefinition",
				"inspectExtension",
				"resolveAgentName",
				"planBuild",
				"generateEntry",
				"compileAgent",
				"publish",
				"preflightPublish",
				"describePublishFailure",
				"PartialPublishError",
				"PruneError",
				"startWatcher",
				"abortOnSignals",
			],
			types: [
				"LoadedAgent",
				"ExtensionInspection",
				"InspectOptions",
				"CompilerOptions",
				"BuildEntry",
				"BuildPlan",
				"BuildRequest",
				"Builder",
				"PublishOptions",
				"PublishResult",
				"WatcherOptions",
				"AgentBuildDefinition",
				"AgentSourceDefinition",
			],
		},
		"troupe/provenance": {
			values: ["compareUtf8", "framedDigest", "sameSource", "createGitRunner"],
			types: ["SourceFile", "ManifestEntry", "SourceManifest", "GitRunner"],
		},
		"troupe/testing": {
			values: ["installFakeClis", "readRecords"],
			types: ["FakeScenario", "FakeRecord"],
		},
	};

// O1, O2, O5a, O17a: a consumer installs the staged folder as a `file:`
// dependency, outside the checkout, and uses only the export map.

const repo = resolve(import.meta.dir, "..");
const parent = realpathSync(mkdtempSync(join(tmpdir(), "troupe-stage-")));
const dist = join(parent, "dist/troupe");
const consumer = join(parent, "consumer");
afterAll(() => {
	if (!process.env.KEEP_STAGE) rmSync(parent, { recursive: true, force: true });
});

const bunTypes = JSON.parse(
	readFileSync(join(repo, "node_modules/@types/bun/package.json"), "utf8"),
).version as string;
const nodeTypes = JSON.parse(
	readFileSync(join(repo, "node_modules/@types/node/package.json"), "utf8"),
).version as string;

function put(root: string, path: string, text: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

/**
 * Runs a consumer script the way an installed consumer must under a `file:`
 * folder dependency. Bun runs the stage's own imports from its real
 * location, beside no node_modules, and would auto-install them from its
 * global cache at whatever version is newest there. `--no-install` makes
 * that fail instead, and `NODE_PATH` resolves them from the consumer's
 * lockfile.
 */
function runConsumer(argv: string[], cwd: string) {
	const child = Bun.spawnSync([process.execPath, "--no-install", ...argv], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			NO_COLOR: "1",
			NODE_PATH: join(consumer, "node_modules"),
		},
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

function run(argv: string[], cwd: string) {
	const child = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

const MAIN = `/// <reference types="troupe/text-imports" />
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSpec, BACKENDS, type PrepareContext } from "troupe";
import { formatHelp, parseCli, resolveCli } from "troupe/cli";
import {
	type IncludeText,
	materializeAgentSpec,
	PROMPT_SEPARATOR,
	type ParsedAgent,
	parseAgentMarkdown,
} from "troupe/declaration";
import {
	type AgentExtension,
	executeAgent,
	previewAgent,
	runDispatch,
} from "troupe/runtime";
import { type FakeRecord, installFakeClis, readRecords } from "troupe/testing";
import declaration from "./agents/hello.md" with { type: "text" };
import guide from "./guide.md" with { type: "text" };

const parsed: ParsedAgent = parseAgentMarkdown("agents/hello.md", declaration);
const includes: IncludeText[] = [{ path: "guide.md", text: guide }];
const spec: AgentSpec = materializeAgentSpec(parsed, { id: "hello", includes });

const scratch = mkdtempSync(join(tmpdir(), "troupe-consumer-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
installFakeClis(bin);
const recordFile = join(scratch, "records.jsonl");

const out = { stdout: "", stderr: "" };
const io = {
	cwd: scratch,
	stdout: (text: string) => {
		out.stdout += text;
	},
	stderr: (text: string) => {
		out.stderr += text;
	},
	isDirectory: () => true as const,
};
const seen: string[] = [];
const finished: number[] = [];
const extension: AgentExtension = {
	prepare: (ctx: PrepareContext) => {
		seen.push(ctx.args.join(" "));
		return {};
	},
	finish: (result) => {
		finished.push(result.exitCode);
		return result.exitCode === 0
			? { stdout: result.stdout, exitCode: 0 }
			: { stdout: \`ERROR: backend exit \${result.exitCode}\\n\`, exitCode: 5 };
	},
	dispatch: (argv) =>
		argv[0] === "tool"
			? { exec: { file: "/bin/sh", args: ["-c", "exit 7"], cwd: scratch, env: {} } }
			: undefined,
};

const help = parseCli(spec, ["--help"], { cwd: scratch });
const resolved = resolveCli(spec, ["--help"], io);
const previewParsed = parseCli(spec, ["--show-prompt", "greet"], { cwd: scratch });
if (previewParsed.kind !== "run") throw new Error("preview parse");
const previewCode = await previewAgent(spec, extension, previewParsed.invocation, {
	...io,
	runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
});
const previewOut = out.stdout;
const runParsed = parseCli(spec, ["greet", "me"], { cwd: scratch });
if (runParsed.kind !== "run") throw new Error("run parse");
const executeCode = await executeAgent(spec, extension, runParsed.invocation, {
	...io,
	env: { PATH: \`\${bin}:\${process.env.PATH}\`, FAKE_RECORD: recordFile },
	interpolate: async () => ({ mcp: {}, env: {} }),
});
const beforeFail = out.stdout.length;
const failCode = await executeAgent(spec, extension, runParsed.invocation, {
	...io,
	env: {
		PATH: \`\${bin}:\${process.env.PATH}\`,
		FAKE_RECORD: recordFile,
		FAKE_SCENARIO: "fail",
	},
	interpolate: async () => ({ mcp: {}, env: {} }),
});
const failStdout = out.stdout.slice(beforeFail);
const codexParsed = parseCli(spec, ["--backend", "codex", "greet", "codex"], {
	cwd: scratch,
});
if (codexParsed.kind !== "run") throw new Error("codex parse");
const codexCode = await executeAgent(spec, extension, codexParsed.invocation, {
	...io,
	env: { PATH: \`\${bin}:\${process.env.PATH}\`, FAKE_RECORD: recordFile },
	interpolate: async () => ({ mcp: {}, env: {} }),
});
const records: FakeRecord[] = readRecords(recordFile);
const dispatched = await runDispatch(spec, extension, ["tool"], {
	cwd: scratch,
	env: process.env,
	stdout: io.stdout,
	stderr: io.stderr,
});
const passed = await runDispatch(spec, extension, ["greet"], {
	cwd: scratch,
	env: process.env,
	stdout: io.stdout,
	stderr: io.stderr,
});

console.log(
	JSON.stringify({
		backends: BACKENDS,
		id: spec.id,
		separator: PROMPT_SEPARATOR,
		promptHasGuide: JSON.stringify(spec).includes("Guide text."),
		help: help.kind,
		helpText: formatHelp(spec).includes("hello"),
		resolvedExit: "exitCode" in resolved ? resolved.exitCode : "run",
		previewCode,
		previewShowsPrompt: previewOut.includes("greet"),
		executeCode,
		failCode,
		failStdout,
		codexCode,
		finished,
		records: records.map((record) => record.name),
		codexArgvHasPrompt: records.at(-1)?.argv.join(" ").includes("greet codex"),
		seen,
		dispatched,
		passed: passed ?? "not dispatched",
	}),
);
`;

// O3, O11, O18 and C1: a consumer build script compiles its own agents
// through troupe/compiler with the real Bun builder, from an unrelated
// working directory, with declarations outside agents/.
const BUILD = `import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentBuildDefinition,
	type AgentSourceDefinition,
	compileAgent,
	describePublishFailure,
	generateEntry,
	planBuild,
	publish,
	startWatcher,
} from "troupe/compiler";

// The builder must find the runtime's packages on its own.
delete process.env.NODE_PATH;
const [consumerRoot, mode, outDir] = process.argv.slice(2);
if (!consumerRoot || !mode || !outDir) throw new Error("usage");
const definition: AgentBuildDefinition = {
	consumerRoot,
	declarationRoot: "defs",
	includeRoots: ["defs", "prompts"],
	roster: ["greet:hello"],
	outDir,
	watchRoots: ["defs", "prompts"],
};
try {
	if (mode === "compile") {
		const { roster: _, ...rest } = definition;
		const source: AgentSourceDefinition = rest;
		mkdirSync(outDir, { recursive: true });
		const agent = await compileAgent({
			definition: source,
			file: "defs/solo/one.md",
			outFile: join(outDir, "solo:one"),
		});
		console.log(JSON.stringify({ id: agent.id, file: agent.file }));
	} else if (mode === "entry") {
		const plan = await planBuild({ definition });
		const [entry] = plan.entries;
		if (!entry) throw new Error("no entry");
		console.log(generateEntry(entry.agent));
	} else if (mode === "publish") {
		const result = await publish({ definition });
		console.log(JSON.stringify(result));
	} else {
		const changes: string[] = [];
		const watched: string[] = [];
		const closed: string[] = [];
		const watcher = startWatcher({
			definition,
			watch: (dir) => {
				watched.push(dir);
				return { close: () => closed.push(dir) };
			},
			debounceMs: 20,
			log: (line) => changes.push(line),
		});
		await watcher.queue.request();
		watcher.close();
		console.log(JSON.stringify({ roots: watcher.roots, watched, closed, changes }));
	}
} catch (error) {
	console.error(describePublishFailure(error, "out/"));
	process.exit(1);
}
`;

const HELLO = `---
description: A consumer's nested agent.
backends: [claude, codex]
mode: print
includes:
  - ../../prompts/guide.md
---
Say hello from defs.
`;

const SOLO = `---
description: A declaration in no roster.
backends: [claude]
---
Solo body outside the roster.
`;

const HELLO_EXTENSION = `export function dispatch(argv: readonly string[]) {
	return argv[0] === "tool"
		? { exec: { file: "/bin/sh", args: ["-c", "exit 7"], cwd: "/", env: {} } }
		: undefined;
}

export function prepare() {
	return {};
}
`;

/** Path, size and content of every file under the stage, for no-write checks. */
function stageInventory(): string {
	const lines: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const rel = `${prefix}${name}`;
			if (statSync(full).isDirectory()) walk(full, `${rel}/`);
			else lines.push(`${rel} ${readFileSync(full).toString("base64")}`);
		}
	};
	walk(dist, "");
	return lines.join("\n");
}

const DECLARATION = `---
description: A consumer's agent.
backends: [claude, codex]
mode: print
includes:
  - guide.md
---
Say hello.
`;

describe("staged distribution", () => {
	const surfaces = readSurface(
		repo,
		JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).exports,
	);
	const staged = stageTroupe(repo, dist);
	put(
		consumer,
		"package.json",
		JSON.stringify({
			name: "troupe-consumer",
			type: "module",
			private: true,
			dependencies: { troupe: "file:../dist/troupe" },
			// Pinned to the root lock: a newer @types/node drops AbortSignal
			// members bun-types relies on.
			devDependencies: { "@types/bun": bunTypes, "@types/node": nodeTypes },
		}),
	);
	put(
		consumer,
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				lib: ["ESNext"],
				target: "ESNext",
				module: "ESNext",
				moduleResolution: "bundler",
				allowImportingTsExtensions: true,
				verbatimModuleSyntax: true,
				noEmit: true,
				strict: true,
				skipLibCheck: true,
				// Bun installs a folder dependency as per-file symlinks into the
				// stage; without this tsc resolves its imports from the stage.
				preserveSymlinks: true,
			},
			include: ["main.ts", "surface.ts", "build.ts"],
		}),
	);
	put(consumer, "agents/hello.md", DECLARATION);
	put(consumer, "guide.md", "Guide text.\n");
	put(consumer, "main.ts", MAIN);
	put(consumer, "build.ts", BUILD);
	put(consumer, "defs/greet/hello.md", HELLO);
	put(consumer, "defs/greet/hello.ts", HELLO_EXTENSION);
	put(consumer, "prompts/guide.md", "Guide from prompts.\n");
	put(consumer, "surface.ts", surfaceModule(surfaces));
	put(
		consumer,
		"tsconfig.private.json",
		JSON.stringify({ extends: "./tsconfig.json", include: ["private.ts"] }),
	);
	put(
		consumer,
		"private.ts",
		'import { createSerialQueue } from "troupe/compiler";\nexport const q = createSerialQueue;\n',
	);
	const install = run([process.execPath, "install"], consumer);

	test("holds exactly the export closure, package.json and its manifest", () => {
		const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
		const entries = Object.values(
			pkg.exports as Record<string, string | { types: string }>,
		).map((target) =>
			(typeof target === "string" ? target : target.types).slice(2),
		);
		const closure = relativeClosure(repo, entries).files;
		expect(staged.members.map((member) => member.path)).toEqual(closure);
		expect(closure).toEqual(STAGED_MEMBERS);
		expect(STAGED_MEMBERS).toHaveLength(27);
		expect(closure).toContain("lib/text-imports.d.ts");
		expect(closure).toContain("lib/agent-format/run.ts");
		expect(closure.some((path) => path.endsWith(".test.ts"))).toBe(false);
		expect(existsSync(join(dist, STAGE_MANIFEST))).toBe(true);
	});

	test("declares no lifecycle scripts and only runtime dependencies", () => {
		const pkg = JSON.parse(readFileSync(join(dist, "package.json"), "utf8"));
		expect(pkg.scripts).toBeUndefined();
		expect(pkg.devDependencies).toBeUndefined();
		expect(Object.keys(pkg.dependencies).sort()).toEqual([
			"typescript",
			"yaml",
			"zod",
		]);
	});

	test("labels the legacy stamp module as the one temporary member", () => {
		const manifest = JSON.parse(
			readFileSync(join(dist, STAGE_MANIFEST), "utf8"),
		);
		const temporary = manifest.members
			.filter((member: { temporary?: string }) => member.temporary)
			.map((member: { path: string }) => member.path);
		expect(temporary).toEqual(Object.keys(TEMPORARY_MEMBERS));
		expect(temporary).toEqual(["scripts/shepherd-source.ts"]);
		// The label names both reasons the member is still reached.
		const label = TEMPORARY_MEMBERS["scripts/shepherd-source.ts"];
		expect(label).toContain("compiler");
		expect(label).toContain("troupe/provenance");
	});

	test("installs without the repository's development tools", () => {
		expect(install.code).toBe(0);
		for (const tool of ["husky", "@biomejs/biome"]) {
			expect(existsSync(join(consumer, "node_modules", tool))).toBe(false);
		}
	});

	test("the stage's packages resolve from the consumer's lockfile, not a cache", () => {
		const from = join(dist, "lib/agent-format/compiler.ts");
		const result = runConsumer(
			[
				"-e",
				`for (const name of ["zod", "yaml", "typescript"]) console.log(Bun.resolveSync(name, ${JSON.stringify(from)}));`,
			],
			consumer,
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const resolved = result.stdout.trim().split("\n");
		expect(resolved).toHaveLength(3);
		for (const [index, name] of ["zod", "yaml", "typescript"].entries()) {
			expect(resolved[index]).toStartWith(
				join(consumer, "node_modules", name, ""),
			);
		}
	});

	test("a consumer parses, previews, executes and dispatches through subpaths", () => {
		const result = runConsumer(["main.ts"], consumer);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			backends: ["claude", "codex"],
			id: "hello",
			separator: "\n\n---\n\n",
			promptHasGuide: true,
			help: "help",
			helpText: true,
			resolvedExit: 0,
			previewCode: 0,
			previewShowsPrompt: true,
			executeCode: 0,
			failCode: 5,
			failStdout: "ERROR: backend exit 3\n",
			codexCode: 0,
			finished: [0, 3, 0],
			records: ["claude", "claude", "codex"],
			codexArgvHasPrompt: true,
			seen: ["greet", "greet me", "greet me", "greet codex"],
			dispatched: 7,
			passed: "not dispatched",
		});
	}, 60_000);

	describe("compiled consumer", () => {
		const unrelated = join(parent, "unrelated-cwd");
		mkdirSync(unrelated, { recursive: true });
		const out = join(parent, "consumer-out");
		const build = (mode: string, target = out) =>
			runConsumer(
				[join(consumer, "build.ts"), consumer, mode, target],
				unrelated,
			);

		test("generated entries import the runtime from the installed distribution", () => {
			const result = build("entry");
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			const imports = [...result.stdout.matchAll(/from ("[^"]+");/g)].map(
				(match) => JSON.parse(match[1] ?? '""') as string,
			);
			expect(imports).toEqual([
				"node:fs",
				join(dist, "lib/agent-format/cli.ts"),
				join(dist, "lib/agent-format/run.ts"),
				join(consumer, "defs/greet/hello.ts"),
			]);
			expect(result.stdout).not.toContain(repo);
		});

		test("the shipped runtime missing fails explicitly before any build", () => {
			const runtime = join(dist, "lib/agent-format/run.ts");
			const aside = `${runtime}.aside`;
			renameSync(runtime, aside);
			try {
				const result = build("publish");
				expect(result.code).toBe(1);
				expect(result.stderr).toBe(
					`the troupe runtime file ${runtime} is missing from the installed distribution; reinstall troupe\nNothing published; out/ left untouched.\n`,
				);
				expect(existsSync(out)).toBe(false);
			} finally {
				renameSync(aside, runtime);
			}
		});

		test("publishes, previews, runs and dispatches through the exit forms", () => {
			const before = stageInventory();
			const result = build("publish");
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				built: ["greet:hello"],
				dryRun: false,
			});
			expect(readdirSync(out)).toEqual(["greet:hello"]);
			const binary = join(out, "greet:hello");
			// O11: the compiled bytes name no checkout path.
			expect(readFileSync(binary).includes(Buffer.from(repo))).toBe(false);

			const preview = run([binary, "--show-prompt", "hi"], unrelated);
			expect(preview.code).toBe(0);
			expect(preview.stdout).toContain("Say hello from defs.");
			expect(preview.stdout).toContain("Guide from prompts.");

			const fakes = join(parent, "fake-bin");
			mkdirSync(fakes, { recursive: true });
			installFakeClis(fakes);
			const records = join(parent, "compiled-records.jsonl");
			const env = {
				...process.env,
				PATH: `${fakes}:${process.env.PATH}`,
				FAKE_RECORD: records,
			};
			const executed = Bun.spawnSync([binary, "greet", "me"], {
				cwd: unrelated,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(executed.exitCode).toBe(0);
			expect(readRecords(records).map((record) => record.name)).toEqual([
				"claude",
			]);

			const dispatched = run([binary, "tool"], unrelated);
			expect(dispatched.code).toBe(7);
			expect(stageInventory()).toEqual(before);
		}, 120_000);

		test("compileAgent builds a declaration outside the roster from the installed package", () => {
			const before = stageInventory();
			const solo = join(parent, "solo-out");
			put(consumer, "defs/solo/one.md", SOLO);
			try {
				const result = build("compile", solo);
				expect(result.stderr).toBe("");
				expect(result.code).toBe(0);
				expect(JSON.parse(result.stdout)).toEqual({
					id: "solo:one",
					file: "defs/solo/one.md",
				});
				// No .agent-build- directory is left beside the output.
				expect(readdirSync(solo)).toEqual(["solo:one"]);
				const preview = run(
					[join(solo, "solo:one"), "--show-prompt", "hi"],
					unrelated,
				);
				expect(preview.code).toBe(0);
				expect(preview.stdout).toContain("Solo body outside the roster.");
			} finally {
				rmSync(join(consumer, "defs/solo"), { recursive: true, force: true });
			}
			expect(stageInventory()).toEqual(before);
		}, 120_000);

		test("the configured watcher rebuilds the roster from the installed package", () => {
			const before = stageInventory();
			const result = build("watch");
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			const report = JSON.parse(result.stdout);
			const roots = [join(consumer, "defs"), join(consumer, "prompts")];
			expect(report.roots).toEqual(roots);
			expect(report.watched).toEqual(roots);
			expect(report.closed).toEqual(roots);
			expect(report.changes).toEqual(["built greet:hello", "rebuilt 1 agents"]);
			expect(stageInventory()).toEqual(before);
		}, 120_000);
	});

	test("every subpath exports exactly its named surface", () => {
		const byPath = Object.fromEntries(
			surfaces.map((surface) => [surface.subpath, surface]),
		);
		expect(Object.keys(byPath)).toEqual(Object.keys(EXPECTED_SURFACE));
		for (const [subpath, expected] of Object.entries(EXPECTED_SURFACE)) {
			const actual = byPath[subpath];
			expect({ subpath, values: actual?.values }).toEqual({
				subpath,
				values: [...expected.values].sort(),
			});
			if (expected.types) {
				expect({ subpath, types: actual?.types }).toEqual({
					subpath,
					types: [...expected.types].sort(),
				});
			}
		}
		// E1's types: every type of the agent-format types and the adapter types.
		const rootTypes = byPath.troupe?.types ?? [];
		for (const name of [
			"AgentSpec",
			"PrepareContext",
			"FinishResult",
			"RunResult",
			"DispatchResult",
			"BackendAdapter",
			"StreamDecoder",
		]) {
			expect(rootTypes).toContain(name);
		}
	});

	test("an installed consumer imports every member and each value is defined", () => {
		const result = runConsumer(["surface.ts"], consumer);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			defined: Object.values(EXPECTED_SURFACE).reduce(
				(sum, surface) => sum + surface.values.length,
				0,
			),
		});
	});

	test("the consumer typechecks, Markdown imports included", () => {
		const tsc = run(
			[process.execPath, "node_modules/typescript/bin/tsc", "-p", "."],
			consumer,
		);
		expect(tsc.stdout).toBe("");
		expect(tsc.code).toBe(0);
	}, 60_000);

	test("the private queue factory is not part of the typed surface", () => {
		const tsc = run(
			[
				process.execPath,
				"node_modules/typescript/bin/tsc",
				"-p",
				"tsconfig.private.json",
			],
			consumer,
		);
		const errors = tsc.stdout
			.split("\n")
			.filter((line) => line.includes("error TS"));
		expect(errors.length).toBe(1);
		expect(errors[0]).toStartWith("private.ts");
		expect(errors[0]).toContain("createSerialQueue");
	}, 60_000);

	test("private deep imports fail", () => {
		for (const specifier of [
			"troupe/lib/agent-format/compiler.ts",
			"troupe/lib/agent-format/run",
			"troupe/scripts/shepherd-source.ts",
		]) {
			const result = run(
				[process.execPath, "-e", `await import(${JSON.stringify(specifier)})`],
				consumer,
			);
			expect(result.code).not.toBe(0);
		}
		const queue = runConsumer(
			[
				"-e",
				'const m = await import("troupe/compiler"); if ("createSerialQueue" in m) process.exit(3);',
			],
			consumer,
		);
		expect(queue.stderr).toBe("");
		expect(queue.code).toBe(0);
	});

	test("restaging removes stale members in place", () => {
		writeFileSync(join(dist, "lib/stale.ts"), "export {};\n");
		const again = stageTroupe(repo, dist);
		expect(existsSync(join(dist, "lib/stale.ts"))).toBe(false);
		expect(again.digest).toBe(staged.digest);
	});
});

describe("root program", () => {
	test("the root tsconfig excludes the default stage directory", () => {
		const config = ts.readConfigFile(
			join(repo, "tsconfig.json"),
			ts.sys.readFile,
		);
		expect(config.error).toBeUndefined();
		const exclude: string[] = config.config.exclude ?? [];
		expect(exclude).toContain(dirname(DEFAULT_STAGE));
		expect(DEFAULT_STAGE).toStartWith(`${dirname(DEFAULT_STAGE)}/`);
	});
});

describe("stage refusals", () => {
	function fixture(name: string, files: Record<string, string>): string {
		const root = join(parent, "fixtures", name);
		put(
			root,
			"package.json",
			JSON.stringify({
				name: "troupe",
				version: "0.0.0",
				exports: { ".": "./lib/index.ts" },
				dependencies: {},
			}),
		);
		for (const [path, text] of Object.entries(files)) put(root, path, text);
		return root;
	}

	function problems(root: string, out = join(root, "..", "out")): string[] {
		try {
			stageTroupe(root, out);
		} catch (error) {
			if (error instanceof StageError) return error.problems;
			throw error;
		}
		return [];
	}

	test("a member outside the library", () => {
		const root = fixture("unexpected", {
			"lib/index.ts": 'export * from "../agents/x";\n',
			"agents/x.ts": "export const x = 1;\n",
		});
		expect(problems(root)).toEqual(["unexpected file agents/x.ts"]);
	});

	test("a self-contained lib/shepherd dependency", () => {
		const root = fixture("shepherd-lib", {
			"lib/index.ts": 'export * from "./shepherd/helper";\n',
			"lib/shepherd/helper.ts": "export const helper = 1;\n",
		});
		expect(problems(root)).toEqual(["unexpected file lib/shepherd/helper.ts"]);
	});

	test("a bare local URL is a member, not the declared package", () => {
		const root = join(parent, "fixtures", "url-yaml");
		put(
			root,
			"package.json",
			JSON.stringify({
				name: "troupe",
				version: "0.0.0",
				exports: { ".": "./lib/index.ts" },
				dependencies: { yaml: "^2" },
			}),
		);
		put(
			root,
			"lib/index.ts",
			'export const u = new URL("yaml/helper.ts", import.meta.url);\n',
		);
		put(root, "lib/yaml/helper.ts", "export {};\n");
		expect(problems(root)).toEqual(["unexpected file lib/yaml/helper.ts"]);
	});

	test("a .spec.ts member", () => {
		const root = fixture("spec-member", {
			"lib/index.ts": 'export * from "./agent-format/x.spec";\n',
			"lib/agent-format/x.spec.ts": "export const x = 1;\n",
		});
		expect(problems(root)).toEqual([
			"unexpected file lib/agent-format/x.spec.ts",
		]);
	});

	test("a missing closure member", () => {
		const root = fixture("missing", {
			"lib/index.ts": 'export * from "./gone";\n',
		});
		expect(problems(root)).toEqual([
			"missing closure member: lib/index.ts -> ./gone",
		]);
	});

	test("a symlinked member", () => {
		const root = fixture("symlink", {
			"lib/index.ts": 'export * from "./agent-format/linked";\n',
			"elsewhere.ts": "export const y = 2;\n",
		});
		mkdirSync(join(root, "lib/agent-format"), { recursive: true });
		symlinkSync(
			join(root, "elsewhere.ts"),
			join(root, "lib/agent-format/linked.ts"),
		);
		expect(problems(root)).toEqual(["symlink lib/agent-format/linked.ts"]);
	});

	test("an opaque reference", () => {
		const root = fixture("opaque", {
			"lib/index.ts": "export const d = import.meta.dir;\n",
		});
		expect(problems(root)).toEqual([
			"opaque reference lib/index.ts:1: import.meta.dir",
		]);
	});

	test("an undeclared dependency", () => {
		const root = fixture("undeclared", {
			"lib/index.ts": 'export * from "left-pad";\n',
		});
		expect(problems(root)).toEqual([
			"import of undeclared dependency left-pad",
		]);
	});

	test("a symlinked file in the destination", () => {
		const root = fixture("link-file", { "lib/index.ts": "export {};\n" });
		const out = join(parent, "link-file-out");
		expect(problems(root, out)).toEqual([]);
		const sentinel = join(parent, "sentinel-file.ts");
		writeFileSync(sentinel, "sentinel bytes\n");
		rmSync(join(out, "lib/index.ts"));
		symlinkSync(sentinel, join(out, "lib/index.ts"));
		expect(problems(root, out)).toEqual([
			"destination holds a symlink: lib/index.ts",
		]);
		expect(readFileSync(sentinel, "utf8")).toBe("sentinel bytes\n");
	});

	test("a symlinked directory in the destination", () => {
		const root = fixture("link-dir", {
			"lib/index.ts": 'export * from "./agent-format/a";\n',
			"lib/agent-format/a.ts": "export const a = 1;\n",
		});
		const out = join(parent, "link-dir-out");
		expect(problems(root, out)).toEqual([]);
		const sentinel = join(parent, "sentinel-dir");
		put(sentinel, "a.ts", "sentinel bytes\n");
		rmSync(join(out, "lib/agent-format"), { recursive: true });
		symlinkSync(sentinel, join(out, "lib/agent-format"));
		expect(problems(root, out)).toEqual([
			"destination holds a symlink: lib/agent-format",
		]);
		expect(readFileSync(join(sentinel, "a.ts"), "utf8")).toBe(
			"sentinel bytes\n",
		);
		expect(readdirSync(sentinel)).toEqual(["a.ts"]);
	});

	test("a destination that is not a previous stage", () => {
		const root = fixture("foreign", { "lib/index.ts": "export {};\n" });
		const out = join(parent, "foreign-out");
		put(out, "keep.txt", "not a stage\n");
		expect(problems(root, out)[0]).toContain("holds no troupe-stage.json");
		expect(existsSync(join(out, "keep.txt"))).toBe(true);
	});
});
