import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { relativeClosure } from "./import-closure";
import { readSurface, surfaceModule } from "./stage-surface";
import {
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

/** The PR 1 public surface per subpath (design.md section 2, E1 to E9). */
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
	let staged: ReturnType<typeof stageTroupe>;
	let install: ReturnType<typeof run>;
	staged = stageTroupe(repo, dist);
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
			include: ["main.ts", "surface.ts"],
		}),
	);
	put(consumer, "agents/hello.md", DECLARATION);
	put(consumer, "guide.md", "Guide text.\n");
	put(consumer, "main.ts", MAIN);
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
	install = run([process.execPath, "install"], consumer);

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
		expect(STAGED_MEMBERS).toHaveLength(26);
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
	});

	test("installs without the repository's development tools", () => {
		expect(install.code).toBe(0);
		for (const tool of ["husky", "@biomejs/biome"]) {
			expect(existsSync(join(consumer, "node_modules", tool))).toBe(false);
		}
	});

	test("a consumer parses, previews, executes and dispatches through subpaths", () => {
		const result = run([process.execPath, "main.ts"], consumer);
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
		const result = run([process.execPath, "surface.ts"], consumer);
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
		const queue = run(
			[
				process.execPath,
				"-e",
				'const m = await import("troupe/compiler"); if ("createSerialQueue" in m) process.exit(3);',
			],
			consumer,
		);
		expect(queue.code).toBe(0);
	});

	test("restaging removes stale members in place", () => {
		writeFileSync(join(dist, "lib/stale.ts"), "export {};\n");
		const again = stageTroupe(repo, dist);
		expect(existsSync(join(dist, "lib/stale.ts"))).toBe(false);
		expect(again.digest).toBe(staged.digest);
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
			"lib/index.ts": 'export * from "./linked";\n',
			"elsewhere.ts": "export const y = 2;\n",
		});
		symlinkSync(join(root, "elsewhere.ts"), join(root, "lib/linked.ts"));
		expect(problems(root)).toEqual(["symlink lib/linked.ts"]);
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
			"lib/index.ts": 'export * from "./sub/a";\n',
			"lib/sub/a.ts": "export const a = 1;\n",
		});
		const out = join(parent, "link-dir-out");
		expect(problems(root, out)).toEqual([]);
		const sentinel = join(parent, "sentinel-dir");
		put(sentinel, "a.ts", "sentinel bytes\n");
		rmSync(join(out, "lib/sub"), { recursive: true });
		symlinkSync(sentinel, join(out, "lib/sub"));
		expect(problems(root, out)).toEqual([
			"destination holds a symlink: lib/sub",
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
