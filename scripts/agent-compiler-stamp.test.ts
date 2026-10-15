import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import { join, resolve } from "node:path";
import { AgentSourceError } from "../lib/agent-format/errors";
import { installFakeClis, readRecords } from "../lib/agent-format/fake-cli";
import {
	type Builder,
	compileAgent,
	generateEntry,
	loadAgentDefinition,
	publish,
	ROSTER,
	startWatcher,
} from "./agent-compiler";
import {
	type BuildProvenance,
	buildManifest,
	gitStamp,
	readWorktreeSource,
	type StampSource,
	versionLine,
} from "./shepherd-source";
import {
	git,
	initShepherdRepo,
	SHEPHERD_DECLARATION,
	testGit,
	writeAt,
} from "./shepherd-source-fixture";

let root: string;
let scratch: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-stamp-")));
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-stamp-scratch-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
});

const fixed: BuildProvenance = {
	revision: "0123456789abcdef0123456789abcdef01234567",
	dirty: true,
	sourceDirty: false,
	manifest: buildManifest([
		{ path: "agents/shepherd.md", content: new TextEncoder().encode("x") },
	]),
};
const fixedLine = versionLine(fixed);

function fixedStamp(seen: string[] = []): StampSource {
	return {
		capture: (at) => {
			seen.push(`capture ${at}`);
			return fixed;
		},
		recheck: (at) => {
			seen.push(`recheck ${at}`);
			return fixed.manifest;
		},
	};
}

/** Writes a placeholder binary and keeps every entry it was given. */
function fakeBuilder(entries: Record<string, string> = {}, during = () => {}) {
	const build: Builder = async ({ entry, outFile }) => {
		entries[outFile.split("/").pop() ?? ""] = readFileSync(entry, "utf8");
		during();
		writeFileSync(outFile, "fake binary");
	};
	return { build, entries };
}

/** The environment without inherited Git routing variables. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	return { ...env, ...extra };
}

function run(
	argv: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
) {
	const child = Bun.spawnSync(argv, {
		cwd: options.cwd ?? scratch,
		env: options.env ?? cleanEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

function leftovers(dir: string): string[] {
	return readdirSync(dir).filter(
		(name) =>
			name.startsWith(".troupe-build-") || name.startsWith(".agent-build-"),
	);
}

/** The generated entry for `file` under `root`, written beside it. */
async function entryFor(file: string, provenance?: BuildProvenance) {
	const agent = await loadAgentDefinition(root, file);
	const entry = join(root, `${agent.id}-entry.ts`);
	writeFileSync(entry, generateEntry(agent, provenance));
	return entry;
}

describe("version output (1.3)", () => {
	test("shepherd --version prints the stamp without a workspace, Git or backend", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const entry = await entryFor("agents/shepherd.md", fixed);
		const empty = join(scratch, "empty-path");
		mkdirSync(empty);
		const nowhere = join(scratch, "nowhere");
		mkdirSync(nowhere);
		expect(
			run([process.execPath, entry, "--version"], {
				cwd: nowhere,
				env: cleanEnv({ PATH: empty }),
			}),
		).toEqual({ code: 0, stdout: `${fixedLine}\n`, stderr: "" });
		expect(readdirSync(nowhere)).toEqual([]);
	});

	test("mixed version invocations are usage errors", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const entry = await entryFor("agents/shepherd.md", fixed);
		for (const args of [
			["--version", "--print"],
			["--print", "--version"],
			["--version", "--version"],
			["tool", "start", "--version"],
			["--version", "--", "x"],
			["--version", "--help"],
		]) {
			const result = run([process.execPath, entry, ...args]);
			expect({ args, code: result.code, stdout: result.stdout }).toEqual({
				args,
				code: 2,
				stdout: "",
			});
			expect(result.stderr).toContain("--version");
		}
	});

	test("-- --version stays backend passthrough", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const entry = await entryFor("agents/shepherd.md", fixed);
		const bin = join(scratch, "fake-bin");
		mkdirSync(bin);
		installFakeClis(bin);
		const record = join(scratch, "records.jsonl");
		const result = run(
			[process.execPath, entry, "--print", "--", "--version"],
			{
				env: cleanEnv({
					PATH: `${bin}:${process.env.PATH}`,
					FAKE_RECORD: record,
					FAKE_SCENARIO: "ok",
					TMPDIR: scratch,
				}),
			},
		);
		expect(result.stdout).not.toContain("revision=");
		const [launch] = readRecords(record);
		expect(launch?.name).toBe("claude");
		expect(launch?.argv.at(-1)).toBe("--version");
	});

	test("other agents keep their behavior, given a stamp or not", async () => {
		writeAt(root, "agents/plain.md", SHEPHERD_DECLARATION);
		for (const provenance of [undefined, fixed]) {
			const entry = await entryFor("agents/plain.md", provenance);
			expect(readFileSync(entry, "utf8")).not.toContain("revision=");
			const result = run([process.execPath, entry, "--version"]);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain('unknown option "--version"');
		}
	});
});

describe("compiler paths (1.2)", () => {
	test("compileAgent stamps a Shepherd binary that prints its version", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const outFile = join(scratch, "shepherd");
		const agent = await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile,
			stamp: fixedStamp(),
		});
		expect(agent.provenance).toEqual(fixed);
		expect(run([outFile, "--version"])).toEqual({
			code: 0,
			stdout: `${fixedLine}\n`,
			stderr: "",
		});
	}, 120_000);

	test("publish stamps Shepherd's entry and returns the provenance", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const { build, entries } = fakeBuilder();
		const result = await publish({
			root,
			outDir: scratch,
			only: "shepherd",
			stamp: fixedStamp(),
			build,
		});
		expect(result.provenance).toEqual(fixed);
		expect(entries.shepherd).toContain(JSON.stringify(fixedLine));
		expect(readdirSync(scratch)).toEqual(["shepherd"]);
	});

	test("publish, compileAgent and the watcher embed the same stamp", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		writeAt(root, "agents/plain.md", SHEPHERD_DECLARATION);
		const roster = ["plain", "shepherd"];
		const published = fakeBuilder();
		await publish({
			root,
			outDir: scratch,
			roster,
			stamp: fixedStamp(),
			build: published.build,
		});
		const compiled = fakeBuilder();
		await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile: join(scratch, "single"),
			stamp: fixedStamp(),
			build: compiled.build,
		});
		const watched = fakeBuilder();
		const watcher = startWatcher({
			root,
			outDir: scratch,
			roster,
			stamp: fixedStamp(),
			build: watched.build,
			watch: () => ({ close() {} }),
		});
		await watcher.queue.request();
		watcher.close();

		const stamped = [
			published.entries.shepherd,
			compiled.entries.binary,
			watched.entries.shepherd,
		];
		for (const text of stamped)
			expect(text).toContain(JSON.stringify(fixedLine));
		expect(new Set(stamped).size).toBe(1);
		expect(published.entries.plain).not.toContain("revision=");
		expect(watched.entries.plain).not.toContain("revision=");
	});

	test("provenance is captured before temporary build files exist and rechecked before publication", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const seen: string[] = [];
		const stamp: StampSource = {
			capture: (at) => {
				seen.push(`capture ${leftovers(scratch).length}`);
				return fixedStamp(seen).capture(at);
			},
			recheck: (at) => {
				seen.push(`recheck ${existsSync(join(scratch, "out", "shepherd"))}`);
				return fixedStamp(seen).recheck(at);
			},
		};
		const { build } = fakeBuilder({}, () => seen.push("build"));
		mkdirSync(join(scratch, "out"));
		await publish({
			root,
			outDir: join(scratch, "out"),
			only: "shepherd",
			stamp,
			build,
		});
		expect(seen).toEqual([
			"capture 0",
			`capture ${root}`,
			"build",
			"recheck false",
			`recheck ${root}`,
		]);
	});

	test("provenance is captured before the declaration is read", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const stamp: StampSource = {
			capture: () => {
				writeAt(
					root,
					"agents/shepherd.md",
					SHEPHERD_DECLARATION.replace("Shepherd body", "Captured body"),
				);
				return fixed;
			},
			recheck: () => fixed.manifest,
		};
		const published = fakeBuilder();
		await publish({
			root,
			outDir: scratch,
			only: "shepherd",
			stamp,
			build: published.build,
		});
		expect(published.entries.shepherd).toContain("Captured body");

		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const compiled = fakeBuilder();
		await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile: join(scratch, "single"),
			stamp,
			build: compiled.build,
		});
		expect(compiled.entries.binary).toContain("Captured body");
	});

	for (const via of ["publish", "compileAgent"] as const) {
		test(`${via} publishes nothing when aborted while the source recheck runs`, async () => {
			writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
			const controller = new AbortController();
			const stamp: StampSource = {
				capture: () => fixed,
				recheck: async () => {
					controller.abort(new Error("interrupted"));
					await Bun.sleep(0);
					return fixed.manifest;
				},
			};
			const outDir = join(scratch, "bin");
			mkdirSync(outDir);
			const { build } = fakeBuilder();
			const signal = controller.signal;
			const attempt =
				via === "publish"
					? publish({ root, outDir, only: "shepherd", stamp, build, signal })
					: compileAgent({
							root,
							file: "agents/shepherd.md",
							outFile: join(outDir, "shepherd"),
							stamp,
							build,
							signal,
						});
			await expect(attempt).rejects.toThrow("interrupted");
			expect(readdirSync(outDir)).toEqual([]);
			expect(leftovers(scratch)).toEqual([]);
		});
	}

	test("a source error is reported before a missing Git revision", async () => {
		writeAt(root, "agents/shepherd.md", "---\nbackends: [nope]\n---\n");
		const { build } = fakeBuilder();
		await expect(
			publish({ root, outDir: scratch, only: "shepherd", build }),
		).rejects.toBeInstanceOf(AgentSourceError);
		await expect(
			compileAgent({
				root,
				file: "agents/shepherd.md",
				outFile: join(scratch, "shepherd"),
				build,
			}),
		).rejects.toBeInstanceOf(AgentSourceError);
	});

	test("a Shepherd build without a Git revision fails and publishes nothing", async () => {
		writeAt(root, "agents/shepherd.md", SHEPHERD_DECLARATION);
		const { build } = fakeBuilder();
		await expect(
			publish({ root, outDir: join(scratch, "bin"), only: "shepherd", build }),
		).rejects.toThrow("Git");
		await expect(
			compileAgent({
				root,
				file: "agents/shepherd.md",
				outFile: join(scratch, "shepherd"),
				build,
			}),
		).rejects.toThrow("Git");
		expect(readdirSync(scratch)).toEqual([]);
		expect(leftovers(root)).toEqual([]);
	});

	test("other agents build without Git or a stamp", async () => {
		writeAt(root, "agents/plain.md", SHEPHERD_DECLARATION);
		const { build } = fakeBuilder();
		const result = await publish({
			root,
			outDir: scratch,
			roster: ["plain"],
			build,
		});
		expect(result.provenance).toBeUndefined();
		expect(readdirSync(scratch)).toEqual(["plain"]);
	});
});

describe("source mutation during the build (1.6)", () => {
	for (const via of ["publish", "compileAgent"] as const) {
		test(`${via} refuses publication when the Shepherd source changes`, async () => {
			initShepherdRepo(root);
			const outDir = join(scratch, "bin");
			mkdirSync(outDir);
			const { build } = fakeBuilder({}, () =>
				writeAt(root, "lib/shepherd/tool.ts", "export const tool = 2;\n"),
			);
			const attempt =
				via === "publish"
					? publish({
							root,
							outDir,
							only: "shepherd",
							stamp: gitStamp(testGit),
							build,
						})
					: compileAgent({
							root,
							file: "agents/shepherd.md",
							outFile: join(outDir, "shepherd"),
							stamp: gitStamp(testGit),
							build,
						});
			await expect(attempt).rejects.toThrow("source changed");
			expect(readdirSync(outDir)).toEqual([]);
			expect(leftovers(scratch)).toEqual([]);
		});
	}

	test("an unchanged source publishes with the captured provenance", async () => {
		const revision = initShepherdRepo(root);
		const { build } = fakeBuilder();
		const result = await publish({
			root,
			outDir: scratch,
			only: "shepherd",
			stamp: gitStamp(testGit),
			build,
		});
		expect(result.provenance).toMatchObject({
			revision,
			dirty: false,
			sourceDirty: false,
			manifest: readWorktreeSource(root, { git: testGit }),
		});
	});
});

describe("scratch-only builds (2.3, 8.1)", () => {
	test("an explicit outDir publishes nowhere else and leaves the repository clean", async () => {
		initShepherdRepo(root);
		const { build } = fakeBuilder();
		const outDir = join(scratch, "run", "bin");
		mkdirSync(outDir, { recursive: true });
		await publish({
			root,
			outDir,
			only: "shepherd",
			stamp: gitStamp(testGit),
			build,
		});
		await compileAgent({
			root,
			file: "agents/shepherd.md",
			outFile: join(outDir, "single"),
			stamp: gitStamp(testGit),
			build,
		});
		expect(readdirSync(outDir).sort()).toEqual(["shepherd", "single"]);
		expect(readdirSync(join(scratch, "run"))).toEqual(["bin"]);
		expect(existsSync(join(root, "bin"))).toBe(false);
		expect(
			git(root, "status", "--porcelain", "--untracked-files=all", "--ignored"),
		).toBe("");
	});
});

/**
 * The scripts take no stamp or builder, so a native build would be the only
 * positive check. Outside Git, both must instead stop at publish's provenance
 * capture before building anything. The compile-all signal tests in
 * agent-compiler-publish.test.ts need a Git fixture for the same reason.
 */
describe("package scripts reach Shepherd's provenance (1.2)", () => {
	const repo = resolve(import.meta.dir, "..");

	for (const [script, args] of [
		["compile.ts", ["shepherd"]],
		["compile-all.ts", []],
	] as const) {
		test(`${[script, ...args].join(" ")} fails without a Git revision and writes nothing`, () => {
			for (const id of ROSTER) {
				writeAt(
					root,
					`agents/${id.split(":").join("/")}.md`,
					SHEPHERD_DECLARATION,
				);
			}
			const result = run(
				[process.execPath, join(repo, "scripts", script), ...args],
				{ cwd: root },
			);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("is not in a Git repository");
			expect(result.stderr).toContain("Nothing published");
			expect(readdirSync(root)).toEqual(["agents"]);
		});
	}
});
