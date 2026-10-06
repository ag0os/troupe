import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { checkWorkspace } from "./check";
import { DEFAULT_MARKS, DEFAULT_WINDOWS } from "./config";
import { renderTemplate, TEMPLATES } from "./guides";
import {
	applyInit,
	initExitCode,
	initJson,
	planInit,
	renderInit,
} from "./init";
import { fakeToolEnv, type MakeTreeOptions, makeTree } from "./test-support";
import { discoverTree } from "./tree";

const NOW = new Date("2026-10-06T12:34:00Z");
const BASE = [
	"CURRENT.md",
	"MEMORY.md",
	"journal.md",
	"docs/INDEX.md",
	"docs/STATUS-template.md",
	"archive/INDEX.md",
	"work/todo/",
	"work/in-progress/",
	"work/done/",
];
const SHARED = [
	"shared/user.md",
	"shared/machine.md",
	"shared/roster.md",
	"shared/tools.md",
	"integrations/shared.md",
];
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(
	files: Record<string, string> = {},
	options: MakeTreeOptions = {},
) {
	const tree = makeTree(files, options);
	cleanups.push(tree.cleanup);
	const env = fakeToolEnv({ home: tree.root });
	return { root: tree.root, now: env.now };
}

describe("init", () => {
	for (const master of [false, true]) {
		test(`plans and creates a fresh ${master ? "master" : "workspace"} in table order`, () => {
			const { root, now } = fixture();
			const expected = master ? [...BASE, ...SHARED] : BASE;
			const plan = planInit(root, { master });
			expect(plan.created).toEqual(expected);
			expect(plan.kept).toEqual([]);
			expect(fs.readdirSync(root)).toEqual([]);
			const result = applyInit(root, { master, now });
			expect(result).toEqual(plan);
			expect(result.entries).toEqual(
				expected.map((path) => ({ path, status: "created" })),
			);
			expect(initExitCode(result)).toBe(0);
			for (const path of expected) {
				const stat = fs.lstatSync(join(root, ".shepherd", path));
				expect(path.endsWith("/") ? stat.isDirectory() : stat.isFile()).toBe(
					true,
				);
			}
			for (const template of TEMPLATES.filter(
				(item) => master || !item.master,
			)) {
				const text = fs.readFileSync(
					join(root, ".shepherd", template.path),
					"utf8",
				);
				expect(text).toBe(renderTemplate(template.text, now));
				expect(text).not.toMatch(/\{\{[^}]+\}\}/);
			}
			expect(fs.existsSync(join(root, ".shepherd/charter.md"))).toBe(false);
		});
	}

	test("a second run keeps all entries without any write operation", () => {
		const { root, now } = fixture();
		applyInit(root, { master: true, now });
		const mkdir = spyOn(fs, "mkdirSync");
		const open = spyOn(fs, "openSync");
		const write = spyOn(fs, "writeFileSync");
		try {
			const plan = planInit(root, { master: true });
			expect(plan.created).toEqual([]);
			expect(plan.kept).toEqual([...BASE, ...SHARED]);
			expect(renderInit(plan)).toContain("  kept    CURRENT.md");
			const result = applyInit(root, { master: true, now: NOW });
			expect(result).toEqual(plan);
			expect(mkdir).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		} finally {
			mkdir.mockRestore();
			open.mockRestore();
			write.mockRestore();
		}
	});

	test("fills a partial workspace while preserving CURRENT byte for byte", () => {
		const current = "An existing CURRENT\r\n\u0000leave it alone\n";
		const { root, now } = fixture({ ".shepherd/CURRENT.md": current });
		const before = fs.readFileSync(join(root, ".shepherd/CURRENT.md"));
		const result = applyInit(root, { master: false, now });
		expect(result.kept).toEqual(["CURRENT.md"]);
		expect(result.created).toEqual(BASE.slice(1));
		expect(fs.readFileSync(join(root, ".shepherd/CURRENT.md"))).toEqual(before);
	});

	test("keeps a dangling file symlink and a directory at a file target", () => {
		const { root, now } = fixture(
			{},
			{ symlinks: { ".shepherd/CURRENT.md": "missing" } },
		);
		fs.mkdirSync(join(root, ".shepherd/MEMORY.md"));
		expect(planInit(root, { master: false }).kept).toEqual([
			"CURRENT.md",
			"MEMORY.md",
		]);
		const result = applyInit(root, { master: false, now });
		expect(result.failed).toBeNull();
		expect(result.kept).toEqual(["CURRENT.md", "MEMORY.md"]);
		expect(
			fs.lstatSync(join(root, ".shepherd/CURRENT.md")).isSymbolicLink(),
		).toBe(true);
		expect(fs.existsSync(join(root, "missing"))).toBe(false);
		expect(fs.lstatSync(join(root, ".shepherd/MEMORY.md")).isDirectory()).toBe(
			true,
		);
	});

	test("keeps a dangling symlink at a required directory and completes", () => {
		const { root, now } = fixture(
			{},
			{
				symlinks: { ".shepherd/work/todo": "missing" },
			},
		);
		expect(planInit(root, { master: true }).kept).toEqual(["work/todo/"]);
		const result = applyInit(root, { master: true, now });
		expect(result.failed).toBeNull();
		expect(result.kept).toEqual(["work/todo/"]);
		expect(result.created).toEqual(
			[...BASE, ...SHARED].filter((path) => path !== "work/todo/"),
		);
		expect(
			fs.lstatSync(join(root, ".shepherd/work/todo")).isSymbolicLink(),
		).toBe(true);
		expect(fs.existsSync(join(root, "missing"))).toBe(false);
	});

	test("keeps a dangling directory symlink appearing just before mkdir", () => {
		const { root, now } = fixture();
		const target = join(root, ".shepherd/work/todo");
		const originalMkdir = fs.mkdirSync;
		const mkdir = spyOn(fs, "mkdirSync").mockImplementation(
			(...args: Parameters<typeof fs.mkdirSync>) => {
				if (args[0] === target) fs.symlinkSync("missing", target);
				return originalMkdir(...args);
			},
		);
		try {
			const result = applyInit(root, { master: true, now });
			expect(result.failed).toBeNull();
			expect(result.kept).toEqual(["work/todo/"]);
			expect(result.created).toEqual(
				[...BASE, ...SHARED].filter((path) => path !== "work/todo/"),
			);
			expect(fs.readlinkSync(target)).toBe("missing");
		} finally {
			mkdir.mockRestore();
		}
	});

	test("stops at a file blocking work/todo and reports only completed writes", () => {
		const { root, now } = fixture({ ".shepherd/work/todo": "blocked" });
		const result = applyInit(root, { master: true, now });
		expect(result.created).toEqual(BASE.slice(0, 6));
		expect(result.kept).toEqual([]);
		expect(result.entries).toHaveLength(6);
		expect(result.failed).toEqual({
			path: "work/todo/",
			error: "a file is in the way",
		});
		expect(initExitCode(result)).toBe(1);
		expect(initJson(result)).toEqual({
			schema: 1,
			command: "init",
			root,
			state: join(root, ".shepherd"),
			master: true,
			created: BASE.slice(0, 6),
			kept: [],
			failed: { path: "work/todo/", error: "a file is in the way" },
		});
		for (const path of result.created)
			expect(fs.statSync(join(root, ".shepherd", path)).isFile()).toBe(true);
		expect(fs.readFileSync(join(root, ".shepherd/work/todo"), "utf8")).toBe(
			"blocked",
		);
		expect(fs.existsSync(join(root, ".shepherd/work/in-progress"))).toBe(false);
		expect(fs.existsSync(join(root, ".shepherd/shared"))).toBe(false);
		expect(renderInit(result)).toContain(
			"  failed  work/todo/: a file is in the way",
		);
		expect(renderInit(result)).not.toContain("Next:");
	});

	test("stops on another filesystem error without rolling back", () => {
		const { root, now } = fixture({ ".shepherd/docs": "not a directory" });
		const result = applyInit(root, { master: false, now });
		expect(result.created).toEqual(BASE.slice(0, 3));
		expect(result.failed?.path).toBe("docs/INDEX.md");
		expect(result.failed?.error).toBeTruthy();
		expect(fs.existsSync(join(root, ".shepherd/archive"))).toBe(false);
	});

	test("writes through symlinked state and integration directories with a lexical header", () => {
		const { root, now } = fixture(
			{ "state/keep": "state", "modules/keep": "modules" },
			{
				symlinks: { ".shepherd": "state", "state/integrations": "modules" },
			},
		);
		const result = applyInit(root, { master: true, now });
		expect(result.created).toEqual([...BASE, ...SHARED]);
		expect(result.failed).toBeNull();
		expect(fs.readFileSync(join(root, "modules/shared.md"), "utf8")).toBe(
			renderTemplate(TEMPLATES[10].text, now),
		);
		expect(fs.existsSync(join(root, "state/CURRENT.md"))).toBe(true);
		expect(renderInit(result).split("\n")[0]).toBe(
			`Initialized ${root}/.shepherd (workspace, shared layer)`,
		);
		expect(initJson(result).state).toBe(join(root, ".shepherd"));
	});

	test("keeps symlinks to required work directories", () => {
		const { root, now } = fixture(
			{ "todo/keep": "existing" },
			{
				symlinks: { ".shepherd/work/todo": "todo" },
			},
		);
		const result = applyInit(root, { master: false, now });
		expect(result.failed).toBeNull();
		expect(result.kept).toEqual(["work/todo/"]);
		expect(
			fs.lstatSync(join(root, ".shepherd/work/todo")).isSymbolicLink(),
		).toBe(true);
	});

	test("master on an initialized workspace adds only the five shared files", () => {
		const { root, now } = fixture();
		applyInit(root, { master: false, now });
		const result = applyInit(root, { master: true, now: NOW });
		expect(result.created).toEqual(SHARED);
		expect(result.kept).toEqual(BASE);
		expect(result.failed).toBeNull();
	});

	test("keeps a file that appears after planning and before exclusive creation", () => {
		const { root, now } = fixture();
		expect(planInit(root, { master: false }).created).toEqual(BASE);
		const originalOpen = fs.openSync;
		const target = join(root, ".shepherd/CURRENT.md");
		const open = spyOn(fs, "openSync").mockImplementation(
			(...args: Parameters<typeof fs.openSync>) => {
				if (args[0] === target && args[1] === "wx")
					fs.writeFileSync(target, "concurrent writer");
				return originalOpen(...args);
			},
		);
		try {
			const result = applyInit(root, { master: false, now });
			expect(result.failed).toBeNull();
			expect(result.kept).toEqual(["CURRENT.md"]);
			expect(result.created).toEqual(BASE.slice(1));
			expect(fs.readFileSync(target, "utf8")).toBe("concurrent writer");
		} finally {
			open.mockRestore();
		}
	});

	test("renders the successful human and JSON reports", () => {
		const { root, now } = fixture();
		const result = applyInit(root, { master: false, now });
		expect(renderInit(result)).toBe(
			[
				`Initialized ${root}/.shepherd (workspace)`,
				...BASE.map((path) => `  created ${path}`),
				"Next: launch `shepherd` here and run the init conversation; `shepherd tool guide charter` has the questions and the charter's shape.",
			].join("\n"),
		);
		expect(initJson(result)).toEqual({
			schema: 1,
			command: "init",
			root,
			state: join(root, ".shepherd"),
			master: false,
			created: BASE,
			kept: [],
			failed: null,
		});
	});

	test("fresh workspace passes the checker with only charter-missing info", () => {
		const { root, now } = fixture();
		applyInit(root, { master: false, now });
		const tree = discoverTree(root);
		const config = {
			marks: { ...DEFAULT_MARKS },
			windows: { ...DEFAULT_WINDOWS },
			codex: {},
			problems: [],
		};
		const findings = checkWorkspace(tree.root, tree, config, now, root);
		expect(findings.map(({ level, code }) => ({ level, code }))).toEqual([
			{ level: "info", code: "charter-missing" },
		]);
	});

	test("fresh master and an initialized child pass the checker", () => {
		const { root, now } = fixture();
		applyInit(root, { master: true, now });
		const child = join(root, "child");
		applyInit(child, { master: false, now });
		fs.writeFileSync(
			join(child, ".shepherd/charter.md"),
			"Agreed: 2026-10-05\nA child workspace.",
		);
		const tree = discoverTree(root);
		expect(tree.workspaces).toHaveLength(2);
		const config = {
			marks: { ...DEFAULT_MARKS },
			windows: { ...DEFAULT_WINDOWS },
			codex: {},
			problems: [],
		};
		const findings = tree.workspaces.flatMap((workspace) =>
			checkWorkspace(workspace, tree, config, now, root),
		);
		expect(
			findings.filter(({ level }) => level === "error" || level === "warn"),
		).toEqual([]);
	});

	test("Updated uses local time near UTC midnight in a fresh TZ process", () => {
		const { root } = fixture();
		const script = `import { applyInit } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
applyInit(${JSON.stringify(root)}, { master: false, now: new Date("2026-10-06T01:23:00Z") });`;
		const child = Bun.spawnSync({
			cmd: [process.execPath, "-e", script],
			cwd: root,
			env: { HOME: root, TZ: "America/New_York" },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.stderr.toString()).toBe("");
		expect(child.exitCode).toBe(0);
		const text = fs.readFileSync(join(root, ".shepherd/CURRENT.md"), "utf8");
		expect(text).toContain("Updated: 2026-10-05 21:23");
		expect(text).not.toContain("2026-10-06 01:23");
	});
});
