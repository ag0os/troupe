import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type AgentBuildDefinition,
	type Builder,
	type BuildStampPolicy,
	type CapturedBuildStamp,
	compileAgent,
	generateEntry,
	publish,
} from "../entries/compiler";
import { AgentSourceError } from "../entries/declaration";
import {
	combineSourceInputs,
	readSourceInputs,
	type SourceInputDefinition,
} from "../entries/provenance";

// O13 and O16 through the public entries: per-agent stamp policies, with
// fixtures only. No ID is special to the compiler.

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "stamp-policy-")));
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

function addAgent(path: string, description = "Fixture") {
	write(
		path,
		`---\ndescription: ${description}\nbackends: [claude]\n---\nBody\n`,
	);
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

const captured: CapturedBuildStamp = {
	manifest: { source: "sha256:fixture", entries: [] },
	provenance: { revision: "unknown", origins: [] },
};

function policy(events: string[] = []): BuildStampPolicy {
	return {
		capture: (context) => {
			events.push(`capture ${context.agentId}`);
			return captured;
		},
		recheck: (context) => {
			events.push(`recheck ${context.agentId}`);
			return captured.manifest;
		},
		versionLine: (id, stamp) => `${id} source=${stamp.manifest.source}`,
	};
}

/** Records each entry it is given, writes a stand-in binary. */
function recordingBuilder(
	entries: Record<string, string>,
	events: string[] = [],
): Builder {
	return async (request) => {
		const id = request.outFile.split("/").at(-1) ?? "";
		events.push(`build ${id}`);
		entries[id] = readFileSync(request.entry, "utf8");
		writeFileSync(request.outFile, `new ${id}\n`);
	};
}

describe("O13 stamp activation", () => {
	test("any named agent is stamped and an unnamed one is not", async () => {
		addAgent("defs/helper.md");
		addAgent("defs/shepherd.md");
		const entries: Record<string, string> = {};
		const result = await publish({
			definition: definition({
				roster: ["helper", "shepherd"],
				stamps: { helper: policy() },
			}),
			build: recordingBuilder(entries),
		});
		expect(entries.helper).toContain(
			'resolveVersion(spec.id, "helper source=sha256:fixture"',
		);
		expect(entries.shepherd).not.toContain("resolveVersion");
		expect(result.stamps).toEqual({ helper: captured });
	});

	test("Shepherd can deliberately be unstamped", async () => {
		addAgent("defs/shepherd.md");
		const entries: Record<string, string> = {};
		const result = await publish({
			definition: definition({ roster: ["shepherd"] }),
			build: recordingBuilder(entries),
		});
		expect(entries.shepherd).not.toContain("resolveVersion");
		expect(result).not.toHaveProperty("stamps");
		const single = await compileAgent({
			definition: definition(),
			file: "defs/shepherd.md",
			outFile: "out/one",
			build: async (request) => writeFileSync(request.outFile, "x"),
		});
		expect(single).not.toHaveProperty("stamp");
	});

	test("capture precedes the declaration read, and recheck precedes the rename", async () => {
		addAgent("defs/helper.md", "Before capture");
		const events: string[] = [];
		const entries: Record<string, string> = {};
		const rewriting: BuildStampPolicy = {
			...policy(events),
			capture: (context) => {
				events.push(`capture ${context.agentId}`);
				// A declaration read before capture would keep the old text.
				addAgent("defs/helper.md", "After capture");
				expect(
					readdirSync(root).filter((name) => name.startsWith(".troupe-build-")),
				).toEqual([]);
				return captured;
			},
			recheck: (context) => {
				events.push(`recheck ${context.agentId}`);
				expect(readdirSync(join(root, "out"))).toEqual([]);
				return captured.manifest;
			},
		};
		mkdirSync(join(root, "out"));
		await publish({
			definition: definition({
				roster: ["helper"],
				stamps: { helper: rewriting },
			}),
			build: recordingBuilder(entries, events),
		});
		expect(entries.helper).toContain('"After capture"');
		expect(events).toEqual([
			"capture helper",
			"build helper",
			"recheck helper",
		]);
		expect(readdirSync(join(root, "out"))).toEqual(["helper"]);
	});

	test("compileAgent captures before reading and rechecks before renaming", async () => {
		addAgent("defs/helper.md", "Before capture");
		const events: string[] = [];
		const entries: Record<string, string> = {};
		const built = await compileAgent({
			definition: definition({
				stamps: {
					helper: {
						...policy(events),
						capture: () => {
							events.push("capture helper");
							addAgent("defs/helper.md", "After capture");
							return captured;
						},
					},
				},
			}),
			file: "defs/helper.md",
			outFile: "helper",
			build: recordingBuilder(entries, events),
		});
		expect(events).toEqual([
			"capture helper",
			"build binary",
			"recheck helper",
		]);
		expect(entries.binary).toContain('"After capture"');
		expect(built.stamp).toEqual(captured);
	});

	test("a dry run validates without capturing or publishing", async () => {
		addAgent("defs/helper.md");
		const events: string[] = [];
		const result = await publish({
			definition: definition({
				roster: ["helper"],
				stamps: { helper: policy(events) },
			}),
			dryRun: true,
			build: recordingBuilder({}, events),
		});
		expect(result.dryRun).toBe(true);
		expect(events).toEqual([]);
		expect(existsSync(join(root, "out"))).toBe(false);
	});

	test("a source error is reported before a capture error", async () => {
		write("defs/helper.md", "---\ndescription: 3\nbogus: true\n---\nx\n");
		const failing: BuildStampPolicy = {
			...policy(),
			capture: () => {
				throw new Error("no revision");
			},
		};
		const def = definition({
			roster: ["helper"],
			stamps: { helper: failing },
		});
		await expect(
			publish({ definition: def, build: recordingBuilder({}) }),
		).rejects.toBeInstanceOf(AgentSourceError);
		await expect(
			compileAgent({
				definition: def,
				file: "defs/helper.md",
				outFile: "out/helper",
				build: recordingBuilder({}),
			}),
		).rejects.toBeInstanceOf(AgentSourceError);
		addAgent("defs/helper.md");
		await expect(
			publish({ definition: def, build: recordingBuilder({}) }),
		).rejects.toThrow("no revision");
		expect(existsSync(join(root, "out"))).toBe(false);
	});

	test("version text comes after dispatch and before parsing", async () => {
		addAgent("defs/helper.md");
		write(
			"defs/helper.ts",
			"export async function dispatch(_argv: string[]) {}\n",
		);
		const entries: Record<string, string> = {};
		await publish({
			definition: definition({
				roster: ["helper"],
				stamps: { helper: policy() },
			}),
			build: recordingBuilder(entries),
		});
		const entry = entries.helper ?? "";
		const dispatch = entry.indexOf("await dispatchAndExit(");
		const version = entry.indexOf("const versioned = resolveVersion(");
		const parse = entry.indexOf("const cli = resolveCli(");
		expect(dispatch).toBeGreaterThan(0);
		expect(version).toBeGreaterThan(dispatch);
		expect(parse).toBeGreaterThan(version);
	});

	test("the generated entry prints the policy's line for --version", () => {
		addAgent("defs/helper.md");
		const file = write(
			"entry.ts",
			generateEntry(
				{
					id: "helper",
					file: "defs/helper.md",
					spec: {
						id: "helper",
						description: "Fixture",
						backends: ["claude"],
						promptMode: "append",
						mode: "interactive",
						initialPrompt: "{{args}}",
						systemPrompt: "Body",
						flags: {},
					},
				},
				"helper revision=unknown",
			),
		);
		const run = (args: string[]) =>
			spawnSync(process.execPath, [file, ...args], {
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, PATH: "/nonexistent" },
			});
		const version = run(["--version"]);
		expect(version.status).toBe(0);
		expect(version.stdout).toBe("helper revision=unknown\n");
		expect(run(["--version", "x"]).status).not.toBe(0);
	});
});

describe("O16 recheck over two origins", () => {
	const V2 = "troupe-agent-source-v2";

	function origins() {
		write("framework/package.json", "{}\n");
		write("framework/lib/run.ts", "export const run = 1;\n");
		write("package/package.json", "{}\n");
		write("package/tools/check", "#!/bin/sh\n");
		chmodSync(join(root, "package/tools/check"), 0o755);
		addAgent("defs/helper.md");
		write("out/helper", "previous\n");
	}

	const inputs = (): SourceInputDefinition[] => [
		{
			origin: "framework/troupe",
			root: join(root, "framework"),
			files: ["package.json"],
			trees: [{ dir: "lib" }],
		},
		{
			origin: "package/consumer",
			root: join(root, "package"),
			files: ["package.json"],
			trees: [{ dir: "tools" }],
			executables: (path) => path.startsWith("tools/"),
		},
	];

	const twoOrigins: BuildStampPolicy = {
		capture: () => {
			const combined = combineSourceInputs(V2, inputs().map(readSourceInputs));
			return {
				manifest: combined.manifest,
				provenance: {
					origins: combined.origins.map((origin) => ({ ...origin })),
				},
			};
		},
		recheck: () =>
			combineSourceInputs(V2, inputs().map(readSourceInputs)).manifest,
		versionLine: (id, stamp) => `${id} source=${stamp.manifest.source}`,
	};

	async function publishWhile(change?: () => void) {
		return publish({
			definition: definition({
				roster: ["helper"],
				stamps: { helper: twoOrigins },
			}),
			build: async (request) => {
				change?.();
				writeFileSync(request.outFile, "new\n");
			},
		});
	}

	const changes: [string, () => void][] = [
		[
			"a framework file",
			() => write("framework/lib/run.ts", "export const run = 2;\n"),
		],
		["a package file", () => write("package/package.json", '{"x":1}\n')],
		[
			"a bound tool's executable status",
			() => chmodSync(join(root, "package/tools/check"), 0o644),
		],
		[
			"a restage of the framework folder",
			() => {
				rmSync(join(root, "framework/lib"), { recursive: true });
				write("framework/lib/run.ts", "export const run = 1;\n");
				write("framework/lib/added.ts", "export {};\n");
			},
		],
	];

	for (const [what, change] of changes) {
		test(`changing ${what} during the build refuses publication`, async () => {
			origins();
			await expect(publishWhile(change)).rejects.toThrow(
				"helper source changed during the build",
			);
			expect(readFileSync(join(root, "out/helper"), "utf8")).toBe("previous\n");
			expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual(
				[],
			);
		});
	}

	test("an unchanged build publishes and keeps unknown revisions unknown", async () => {
		origins();
		const result = await publishWhile();
		expect(readFileSync(join(root, "out/helper"), "utf8")).toBe("new\n");
		const stamp = result.stamps?.helper;
		expect(stamp?.manifest.entries.map((entry) => entry.path)).toContain(
			"package/consumer/tools/check",
		);
		expect(stamp?.provenance.origins).toEqual([
			expect.objectContaining({
				origin: "framework/troupe",
				revision: "unknown",
			}),
			expect.objectContaining({
				origin: "package/consumer",
				revision: "unknown",
			}),
		]);
	});
});
