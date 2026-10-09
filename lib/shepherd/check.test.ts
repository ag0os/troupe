import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorkspace, type Finding } from "./check";
import { FIXED_PATHS } from "./checkpoint";
import {
	type Config,
	DEFAULT_MARKS,
	DEFAULT_START,
	DEFAULT_WINDOWS,
} from "./config";
import { contentHash } from "./current-prev";
import { LockError, lockStatus, unlockState, withStateLock } from "./lock";
import { fakeToolEnv, type MakeTreeOptions, makeTree } from "./test-support";
import { discoverTree } from "./tree";

const TODAY = new Date(2026, 9, 5);
const MEMORY = `---
name: note
description: A note
type: reference
---
Text
`;
const cleanFiles = {
	"root/.shepherd/charter.md": "A charter",
	"root/.shepherd/CURRENT.md": "Updated: 2026-10-05\nCurrent work",
};
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function config(overrides: Partial<Config> = {}): Config {
	return {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS },
		start: { ...DEFAULT_START },
		codex: {},
		problems: [],
		...overrides,
	};
}

function fixture(
	files: Record<string, string> = {},
	options: MakeTreeOptions = {},
) {
	const result = makeTree({ ...cleanFiles, ...files }, options);
	cleanups.push(result.cleanup);
	const root = join(result.root, "root");
	const tree = discoverTree(root);
	return { root, tree, workspace: tree.root };
}

function finding(findings: Finding[], code: string): Finding {
	const match = findings.find((candidate) => candidate.code === code);
	if (!match) throw new Error(`missing ${code}: ${JSON.stringify(findings)}`);
	return match;
}

describe("checkWorkspace", () => {
	test("reports config-invalid for a problem in this workspace", () => {
		const { workspace, tree } = fixture();
		const file = join(workspace.state, "config.json");
		const findings = checkWorkspace(
			workspace,
			tree,
			config({
				problems: [
					{ file, key: "marks.extra", problem: "unknown key" },
					{ file: "/elsewhere/config.json", key: "x", problem: "unknown key" },
				],
			}),
			TODAY,
		);

		expect(finding(findings, "config-invalid")).toEqual({
			level: "error",
			code: "config-invalid",
			file: "config.json",
			message: "marks.extra: unknown key",
		});
		expect(
			findings.filter(({ code }) => code === "config-invalid"),
		).toHaveLength(1);
	});

	test("reports charter-missing", () => {
		const files = { ...cleanFiles };
		delete (files as Partial<typeof cleanFiles>)["root/.shepherd/charter.md"];
		const { root, cleanup } = makeTree(files);
		cleanups.push(cleanup);
		const tree = discoverTree(join(root, "root"));

		expect(
			finding(
				checkWorkspace(tree.root, tree, config(), TODAY),
				"charter-missing",
			),
		).toMatchObject({
			level: "info",
			file: "charter.md",
		});
	});

	test("reports charter-over-mark", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/charter.md": "one two three",
		});
		const settings = config({ marks: { ...DEFAULT_MARKS, charter: 2 } });

		expect(
			finding(
				checkWorkspace(workspace, tree, settings, TODAY),
				"charter-over-mark",
			).message,
		).toContain("3 words, past the 2-word review mark");
	});

	test("reports current-missing", () => {
		const { root, cleanup } = makeTree({
			"root/.shepherd/charter.md": "A charter",
		});
		cleanups.push(cleanup);
		const tree = discoverTree(join(root, "root"));

		expect(
			finding(
				checkWorkspace(tree.root, tree, config(), TODAY),
				"current-missing",
			),
		).toMatchObject({
			level: "error",
			file: "CURRENT.md",
			message: "CURRENT.md is missing",
		});
	});

	test("reports current-over-mark", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/CURRENT.md": "Updated: 2026-10-05\nLots of words",
		});
		const settings = config({ marks: { ...DEFAULT_MARKS, current: 2 } });

		expect(
			finding(
				checkWorkspace(workspace, tree, settings, TODAY),
				"current-over-mark",
			).message,
		).toContain("5 words, past the 2-word review mark");
	});

	test("reports current-no-updated", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/CURRENT.md": "Current work",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"current-no-updated",
			),
		).toMatchObject({
			level: "info",
			file: "CURRENT.md",
		});
	});

	test("reports current-stale only after the configured window", () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = "America/Argentina/Buenos_Aires";
		const { workspace, tree } = fixture({
			"root/.shepherd/CURRENT.md": "Updated: 2026-09-27",
		});
		try {
			expect(
				checkWorkspace(workspace, tree, config(), new Date(2026, 9, 4)).some(
					({ code }) => code === "current-stale",
				),
			).toBeFalse();
			expect(
				finding(
					checkWorkspace(workspace, tree, config(), new Date(2026, 9, 5)),
					"current-stale",
				),
			).toMatchObject({
				level: "warn",
				message: "last updated 2026-09-27, 8 days ago",
			});
		} finally {
			if (previousTimezone === undefined) delete process.env.TZ;
			else process.env.TZ = previousTimezone;
		}
	});

	test("reports handoff-file", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/HANDOFF.md": "Old handoff",
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "handoff-file"),
		).toMatchObject({
			level: "info",
			file: "HANDOFF.md",
		});
	});

	test("reports shared-over-mark for a workspace with a descendant", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/integrations/one.md": "one two",
			"root/.shepherd/integrations/two.md": "three four",
			"root/child/.shepherd/charter.md": "Child",
			"root/child/.shepherd/CURRENT.md": "Updated: 2026-10-05",
		});
		const settings = config({ marks: { ...DEFAULT_MARKS, shared: 3 } });

		expect(
			finding(
				checkWorkspace(workspace, tree, settings, TODAY),
				"shared-over-mark",
			),
		).toMatchObject({
			level: "warn",
			file: "integrations",
		});
	});

	test("reports both kinds of module-duplicate", () => {
		const { root, cleanup } = makeTree(
			{
				...cleanFiles,
				"root/.shepherd/integrations/rules.md": "Inherited",
				"root/same/.shepherd/charter.md": "Same",
				"root/same/.shepherd/CURRENT.md": "Updated: 2026-10-05",
				"root/copy/.shepherd/charter.md": "Copy",
				"root/copy/.shepherd/CURRENT.md": "Updated: 2026-10-05",
				"root/copy/.shepherd/integrations/rules.md": "A copy",
			},
			{
				symlinks: {
					"root/same/.shepherd/integrations/rules.md":
						"root/.shepherd/integrations/rules.md",
				},
			},
		);
		cleanups.push(cleanup);
		const tree = discoverTree(join(root, "root"));
		const same = tree.workspaces.find(({ name }) => name === "same");
		const copy = tree.workspaces.find(({ name }) => name === "copy");
		if (!same || !copy) throw new Error("missing child fixtures");

		expect(
			finding(checkWorkspace(same, tree, config(), TODAY), "module-duplicate")
				.message,
		).toContain("same file");
		expect(
			finding(checkWorkspace(copy, tree, config(), TODAY), "module-duplicate")
				.message,
		).toContain("both load");
	});

	test("reports broken-symlink anywhere under state", () => {
		const { workspace, tree } = fixture(
			{},
			{
				symlinks: { "root/.shepherd/docs/missing.md": "does-not-exist" },
			},
		);

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"broken-symlink",
			),
		).toMatchObject({
			level: "error",
			file: "docs/missing.md",
		});
	});

	test("reports a dangling work item symlink without crashing", () => {
		const { workspace, tree } = fixture(
			{},
			{
				symlinks: {
					"root/.shepherd/work/done/missing": "does-not-exist",
				},
			},
		);

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"broken-symlink",
			),
		).toMatchObject({ file: "work/done/missing" });
	});

	test("keeps malformed percent escapes literal in the docs index", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/INDEX.md": "[Listed](bad%ZZ.md)",
			"root/.shepherd/docs/bad%ZZ.md": "Listed",
		});

		expect(
			checkWorkspace(workspace, tree, config(), TODAY).filter(
				({ code }) => code === "doc-unlisted",
			),
		).toEqual([]);
	});

	test("reports memory-index-missing", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/memories/note.md": MEMORY,
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-index-missing",
			),
		).toMatchObject({
			level: "error",
			file: "MEMORY.md",
		});
	});

	test("reports memory-index-dangling with its line", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "# Index\n\n[Missing](memories/missing.md)\n",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-index-dangling",
			),
		).toEqual({
			level: "error",
			code: "memory-index-dangling",
			file: "MEMORY.md",
			line: 3,
			message: "index points at missing memories/missing.md",
		});
	});

	test("reports memory-unlisted", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "# Index\n",
			"root/.shepherd/memories/note.md": MEMORY,
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-unlisted",
			),
		).toMatchObject({
			level: "error",
			file: "memories/note.md",
		});
	});

	test("reports memory-no-frontmatter", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": "No metadata",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"memory-no-frontmatter",
			),
		).toMatchObject({
			level: "warn",
			file: "memories/note.md",
		});
	});

	test("reports one memory-frontmatter-key finding per missing key", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": "---\nname: note\n---\nText",
		});
		const findings = checkWorkspace(workspace, tree, config(), TODAY).filter(
			({ code }) => code === "memory-frontmatter-key",
		);

		expect(findings.map(({ message }) => message)).toEqual([
			"frontmatter lacks `description`",
			"frontmatter lacks `type`",
		]);
	});

	test("reports memory-type", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": MEMORY.replace("reference", "other"),
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "memory-type")
				.message,
		).toContain("type `other`");
	});

	test("reports memory-name", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": MEMORY.replace(
				"name: note",
				"name: other",
			),
		});

		expect(
			finding(checkWorkspace(workspace, tree, config(), TODAY), "memory-name")
				.message,
		).toContain("doesn't match the filename");
	});

	test("reports docs-index-missing", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/guide.md": "Guide",
		});

		expect(
			finding(
				checkWorkspace(workspace, tree, config(), TODAY),
				"docs-index-missing",
			),
		).toEqual({
			level: "warn",
			code: "docs-index-missing",
			file: "docs/INDEX.md",
			message: "1 docs but no docs/INDEX.md",
		});
	});

	test("reports doc-unlisted unless a parent README is indexed", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/INDEX.md": "[Area](area/README.md)",
			"root/.shepherd/docs/area/README.md": "Area",
			"root/.shepherd/docs/area/listed-by-folder.md": "Covered",
			"root/.shepherd/docs/loose.md": "Loose",
		});
		const findings = checkWorkspace(workspace, tree, config(), TODAY).filter(
			({ code }) => code === "doc-unlisted",
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			level: "warn",
			file: "docs/loose.md",
			message: "not listed in docs/INDEX.md",
		});
	});

	test("reports only checkpoint-missing for a clean workspace with an action trigger", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/MEMORY.md": "[Note](memories/note.md)",
			"root/.shepherd/memories/note.md": MEMORY,
			"root/.shepherd/docs/INDEX.md":
				"[Guide](guide.md) before deploying, read this",
			"root/.shepherd/docs/guide.md": "Guide",
		});

		expect(
			checkWorkspace(workspace, tree, config(), TODAY).map(({ code }) => code),
		).toEqual(["checkpoint-missing"]);
	});
});

function checkpointFiles(
	baseline: string | null = null,
): Record<string, string> {
	return {
		"root/.shepherd/checkpoint.json": JSON.stringify({
			schema: 1,
			revision: 1,
			written: TODAY.toISOString(),
			snapshot: "checkpoints/1-CURRENT.md",
			journal: { from: null, to: null, count: 0 },
			files: Object.fromEntries(
				FIXED_PATHS.map((path) => [
					path,
					path === "CURRENT.md" && baseline !== null
						? contentHash(baseline)
						: null,
				]),
			),
			evidence: {},
		}),
		...(baseline === null
			? {}
			: { "root/.shepherd/checkpoints/1-CURRENT.md": baseline }),
	};
}

describe("staged workspace findings", () => {
	test("checkpoint-missing supplies reconciliation steps only when absent", () => {
		for (const present of [false, true]) {
			const { workspace, tree } = fixture(present ? checkpointFiles() : {});
			const matches = checkWorkspace(workspace, tree, config(), TODAY).filter(
				({ code }) => code === "checkpoint-missing",
			);
			expect(matches).toHaveLength(present ? 0 : 1);
			if (!present)
				expect(matches[0]).toEqual({
					level: "info",
					code: "checkpoint-missing",
					file: "checkpoint.json",
					message:
						"run `shepherd tool start`, reconcile, then `shepherd tool checkpoint`",
				});
		}
	});

	test("checkpoint-invalid reports bad JSON and missing or mismatched snapshots", () => {
		for (const mode of ["json", "missing", "mismatch", "valid"]) {
			const files = checkpointFiles("Keep this warning");
			if (mode === "json") files["root/.shepherd/checkpoint.json"] = "{";
			if (mode === "missing")
				delete files["root/.shepherd/checkpoints/1-CURRENT.md"];
			if (mode === "mismatch")
				files["root/.shepherd/checkpoints/1-CURRENT.md"] = "Other";
			const { workspace, tree } = fixture(files);
			const matches = checkWorkspace(workspace, tree, config(), TODAY).filter(
				({ code }) => code === "checkpoint-invalid",
			);
			expect(matches).toHaveLength(mode === "valid" ? 0 : 1);
			if (mode !== "valid")
				expect(matches[0]).toMatchObject({
					level: "error",
					file: "checkpoint.json",
				});
			if (mode === "missing" || mode === "mismatch")
				expect(matches[0]?.message).toBe("snapshot missing or does not match");
		}
	});

	test("lock-stale distinguishes both locks and ignores live owners", () => {
		for (const which of ["state", "unlock"]) {
			for (const mode of ["dead", "live", "malformed", "missing"]) {
				const { workspace, tree, root } = fixture();
				const path = join(workspace.state, `.${which}.lock`);
				mkdirSync(path);
				if (mode !== "missing")
					writeFileSync(
						join(path, "owner"),
						mode === "malformed"
							? "bad"
							: JSON.stringify({ pid: 42, started: TODAY.toISOString() }),
					);
				const env = fakeToolEnv({
					home: root,
					alivePids: mode === "live" ? [42] : [],
				});
				const matches = checkWorkspace(
					workspace,
					tree,
					config(),
					TODAY,
					root,
					env,
				).filter(({ code }) => code === "lock-stale");
				expect(matches).toHaveLength(mode === "live" ? 0 : 1);
				if (mode !== "live") {
					expect(matches[0]).toMatchObject({
						level: "error",
						file: `.${which}.lock`,
					});
					expect(matches[0]?.message).toContain(
						which === "state"
							? "run `shepherd tool unlock` when no Shepherd of this workspace is live"
							: `rm -r ${path}`,
					);
				}
			}
		}
	});

	test("lock-stale default probe recognizes the current process", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/.state.lock/owner": JSON.stringify({
				pid: process.pid,
				started: TODAY.toISOString(),
			}),
		});
		expect(
			checkWorkspace(workspace, tree, config(), TODAY).some(
				({ code }) => code === "lock-stale",
			),
		).toBeFalse();
	});

	test("current-older-than-journal requires over fifteen minutes and no checkpoint", () => {
		for (const [time, present, expected] of [
			["10:16", false, true],
			["10:15", false, false],
			["10:16", true, false],
		] as const) {
			const { workspace, tree } = fixture({
				"root/.shepherd/CURRENT.md": "# Current\nUpdated: 2026-10-05 10:00",
				"root/.shepherd/journal.md": `## 2026-10-05\n- ${time} Change\n- Untimed tail`,
				...(present ? checkpointFiles() : {}),
			});
			const matches = checkWorkspace(workspace, tree, config(), TODAY).filter(
				({ code }) => code === "current-older-than-journal",
			);
			expect(matches).toHaveLength(expected ? 1 : 0);
			if (expected) {
				expect(matches[0]).toMatchObject({
					level: "warn",
					file: "CURRENT.md",
					line: 2,
				});
				expect(matches[0]?.message).toContain("2026-10-05 10:00");
				expect(matches[0]?.message).toContain(`2026-10-05 ${time}`);
			}
		}
	});

	test("current-line-dropped reports baseline lines and nearest preservation text only with a baseline", () => {
		const baseline =
			"# Current\nUpdated: 2026-10-05\n- Never deploy without checking the database migration first";
		for (const present of [true, false]) {
			const { workspace, tree } = fixture({
				...(present ? checkpointFiles(baseline) : {}),
				"root/.shepherd/docs/guide.md":
					"Never deploy without checking the database migration carefully",
			});
			const matches = checkWorkspace(workspace, tree, config(), TODAY).filter(
				({ code }) => code === "current-line-dropped",
			);
			expect(matches).toHaveLength(present ? 1 : 0);
			if (present) {
				expect(matches[0]).toMatchObject({
					level: "warn",
					file: "CURRENT.md",
					line: 3,
				});
				expect(matches[0]?.message).toContain(
					"Never deploy without checking the database migration first",
				);
				expect(matches[0]?.message).toContain("nearest: docs/guide.md:1");
			}
		}
	});

	test("doc-trigger-missing flags topic-only links and ignores trigger words in link labels and fences", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/INDEX.md":
				"[Before](guide.md) deployment topic\n[Guide](guide.md) before deploying, read this\n[Guide](guide.md) BEFORE deploying\n[Guide](guide.md) beforehand\n```\n[Guide](guide.md) topic\n```",
			"root/.shepherd/docs/guide.md": "Guide",
		});
		expect(
			checkWorkspace(workspace, tree, config(), TODAY)
				.filter(({ code }) => code === "doc-trigger-missing")
				.map(({ level, file, line }) => ({ level, file, line })),
		).toEqual([
			{ level: "warn", file: "docs/INDEX.md", line: 1 },
			{ level: "warn", file: "docs/INDEX.md", line: 4 },
		]);
	});

	test("current-over-mark uses the diet wording only above 600 words", () => {
		for (const count of [600, 601]) {
			const { workspace, tree } = fixture({
				"root/.shepherd/CURRENT.md": Array(count).fill("word").join(" "),
			});
			const matches = checkWorkspace(workspace, tree, config(), TODAY).filter(
				({ code }) => code === "current-over-mark",
			);
			expect(matches).toHaveLength(count === 600 ? 0 : 1);
			if (count === 601) {
				expect(matches[0]).toMatchObject({ level: "info", file: "CURRENT.md" });
				expect(matches[0]?.message).toContain(
					"standing how-tos go to a doc with an action-named index line; standing rules to the charter; keep what is costly on first misuse",
				);
			}
		}
	});
});

describe("T9 fix round 1", () => {
	test("files at either lock path are malformed stale locks and do not abort checking", () => {
		for (const which of ["state", "unlock"] as const) {
			const { workspace, tree, root } = fixture({
				[`root/.shepherd/.${which}.lock`]: "malformed lock",
			});
			const env = fakeToolEnv({ home: root });
			expect(lockStatus(workspace.state, env, which)).toEqual({
				status: "stale",
			});
			const findings = checkWorkspace(
				workspace,
				tree,
				config(),
				TODAY,
				root,
				env,
			);
			expect(finding(findings, "lock-stale")).toMatchObject({
				level: "error",
				file: `.${which}.lock`,
			});
			expect(finding(findings, "checkpoint-missing")).toMatchObject({
				level: "info",
			});
		}
	});

	test("a writer rejects a file lock with the stale message and unlock clears the file", async () => {
		const { workspace, root } = fixture({
			"root/.shepherd/.state.lock": "malformed lock",
		});
		const env = fakeToolEnv({ home: root });
		const action = withStateLock(workspace.state, env, () => {
			throw new Error("writer must not run");
		});
		await expect(action).rejects.toBeInstanceOf(LockError);
		await expect(action).rejects.toThrow("stale lock");
		expect(await unlockState(workspace.state, env)).toMatchObject({
			code: 0,
			outcome: "cleared",
			text: "cleared stale lock left by pid unknown",
		});
		expect(existsSync(join(workspace.state, ".state.lock"))).toBeFalse();
		expect(existsSync(join(workspace.state, ".unlock.lock"))).toBeFalse();
	});

	test("a file unlock lock returns the stale-unlock recovery message", async () => {
		const { workspace, root } = fixture({
			"root/.shepherd/.unlock.lock": "malformed lock",
		});
		const result = await unlockState(
			workspace.state,
			fakeToolEnv({ home: root }),
		);
		expect(result).toMatchObject({ code: 1, outcome: "stale-unlock" });
		expect(result.text).toContain(
			`rm -r ${join(workspace.state, ".unlock.lock")}`,
		);
	});

	test("lock probe exceptions become findings and checking continues for both locks", () => {
		const owner = JSON.stringify({ pid: 42, started: TODAY.toISOString() });
		const { workspace, tree, root } = fixture({
			"root/.shepherd/.state.lock/owner": owner,
			"root/.shepherd/.unlock.lock/owner": owner,
		});
		const env = fakeToolEnv({ home: root });
		env.pidAlive = () => {
			throw new Error("probe failed");
		};
		const findings = checkWorkspace(
			workspace,
			tree,
			config(),
			TODAY,
			root,
			env,
		);
		const locks = findings.filter(({ code }) => code === "lock-stale");
		expect(locks.map(({ file }) => file)).toEqual([
			".state.lock",
			".unlock.lock",
		]);
		for (const lock of locks)
			expect(lock.message).toContain("could not inspect lock: probe failed");
		expect(finding(findings, "checkpoint-missing")).toMatchObject({
			level: "info",
		});
	});

	test("doc triggers recognize defined reference links and exclude inline code spans", () => {
		const { workspace, tree } = fixture({
			"root/.shepherd/docs/INDEX.md": [
				"[Guide][guide] deployment topic",
				"[Guide][guide] before deploying, read this",
				"[Guide] deployment topic",
				"[Guide] when deploying, read this",
				"[Guide][] deployment topic",
				"[Unknown] deployment topic",
				"`[Guide](guide.md)` deployment topic",
				"``[Guide][guide] `example` `` deployment topic",
				"[Guide](guide.md) `before` deployment topic",
				"`[Code](guide.md)` [Guide](guide.md) before deploying",
				"[guide]: guide.md",
				"```",
				"[Unknown]: guide.md",
				"```",
				"`[Other]: guide.md`",
				"[Other] deployment topic",
			].join("\n"),
			"root/.shepherd/docs/guide.md": "Guide",
		});
		expect(
			checkWorkspace(workspace, tree, config(), TODAY)
				.filter(({ code }) => code === "doc-trigger-missing")
				.map(({ line }) => line),
		).toEqual([1, 3, 5, 9]);
	});
});
