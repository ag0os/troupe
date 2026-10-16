import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { runDispatch } from "../agent-format/run";
import type { AgentSpec, DispatchResult } from "../agent-format/types";
import { composeFragments } from "./compose";
import { dispatchPackageTool } from "./dispatch";
import type { PackageLocation } from "./package-resolution";
import { MAIL_TOOLS, packageText } from "./test-support";

const repo = resolve(import.meta.dir, "../..");
const pinnedSoftware = readFileSync(
	join(
		repo,
		"agents/__fixtures__/shepherd-module-matrix/builtin-bodies/software.md.txt",
	),
	"utf8",
);

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-dispatch-")));
	cleanups.push(dir);
	return dir;
}

function write(path: string, text: string, mode?: number) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	if (mode !== undefined) chmodSync(path, mode);
}

/** A mail package whose tools leave a marker if they ever run. */
function mailFixture(charter = "Modules: mail\n") {
	const root = scratch();
	const base = join(root, "base");
	const marker = join(root, "ran");
	write(join(base, "mail/MODULE.md"), packageText("mail", MAIL_TOOLS));
	write(
		join(base, "mail/tools/unread"),
		`#!/bin/sh\ntouch "${marker}"\n`,
		0o755,
	);
	write(join(base, "mail/tools/send"), `#!/bin/sh\ntouch "${marker}"\n`, 0o755);
	write(
		join(base, "mail/tools/undeclared"),
		`#!/bin/sh\ntouch "${marker}"\n`,
		0o755,
	);
	write(join(root, "ws/.shepherd/charter.md"), charter);
	mkdirSync(join(root, "ws/sub"), { recursive: true });
	const locations = (enclosing: string | undefined): PackageLocation[] => [
		{ dir: base, layer: "builtin" },
		...(enclosing
			? [
					{
						dir: join(enclosing, ".shepherd/packages"),
						layer: "inherited" as const,
					},
				]
			: []),
	];
	return { root, base, marker, ws: join(root, "ws"), locations };
}

function dispatch(
	argv: string[],
	cwd: string,
	locations: (enclosing: string | undefined) => PackageLocation[],
	env: Record<string, string> = {},
) {
	return dispatchPackageTool(argv, {
		cwd,
		env: { HOME: "/home/fixture", ...env },
		locations,
	});
}

const spec = { id: "shepherd" } as AgentSpec;

/** Run a description the way the runner does, capturing its refusal text. */
async function execute(result: DispatchResult | undefined) {
	let stderr = "";
	const code = await runDispatch(spec, { dispatch: () => result }, ["tool"], {
		cwd: "/",
		env: { PATH: process.env.PATH },
		stdout: () => {},
		stderr: (text) => {
			stderr += text;
		},
	});
	return { code, stderr };
}

describe("dispatch routes only package runs (O11)", () => {
	test("core commands, unknown packages and other argv fall through", () => {
		const { ws, locations } = mailFixture();
		for (const argv of [
			[],
			["hello"],
			["tool"],
			["tool", "check"],
			["tool", "guide", "mail"],
			["tool", "nosuch", "x"],
			["--cwd", ws, "tool", "mail", "unread"],
		])
			expect(dispatch(argv, ws, locations)).toBeUndefined();
	});

	test("every argument after the tool is passed unchanged", () => {
		const { ws, base, locations } = mailFixture();
		const result = dispatch(
			["tool", "mail", "unread", "--base", "main", "--json", "-h"],
			ws,
			locations,
		);
		expect(result).toEqual({
			exec: {
				file: join(base, "mail/tools/unread"),
				args: ["--base", "main", "--json", "-h"],
				cwd: ws,
				env: {
					SHEPHERD_CONTRACT: "1",
					SHEPHERD_PACKAGE: "mail",
					SHEPHERD_PACKAGE_DIR: join(base, "mail"),
					SHEPHERD_TOOL: "unread",
					SHEPHERD_WORKSPACE: ws,
					SHEPHERD_STATE_DIR: join(ws, ".shepherd"),
					SHEPHERD_CONFIG_DIR: "/home/fixture/.config/shepherd",
				},
			},
		});
		const xdg = dispatch(["tool", "mail", "unread"], ws, locations, {
			XDG_CONFIG_HOME: "/xdg",
		});
		expect(xdg && "exec" in xdg ? xdg.exec.env.SHEPHERD_CONFIG_DIR : "").toBe(
			"/xdg/shepherd",
		);
	});
});

describe("the runner executes the description (O12)", () => {
	test("argv, the caller's cwd and the SHEPHERD_* variables reach the tool; its code returns", async () => {
		const { ws, base, locations } = mailFixture();
		const record = join(ws, "sub/record.json");
		write(
			join(base, "mail/tools/unread"),
			`#!/bin/sh\nprintf '{"args":"%s","cwd":"%s","contract":"%s","package":"%s","dir":"%s","tool":"%s","workspace":"%s","state":"%s","config":"%s"}' "$*" "$(pwd -P)" "$SHEPHERD_CONTRACT" "$SHEPHERD_PACKAGE" "$SHEPHERD_PACKAGE_DIR" "$SHEPHERD_TOOL" "$SHEPHERD_WORKSPACE" "$SHEPHERD_STATE_DIR" "$SHEPHERD_CONFIG_DIR" > "${record}"\nexit 3\n`,
			0o755,
		);
		const cwd = join(ws, "sub");
		const { code } = await execute(
			dispatch(["tool", "mail", "unread", "a b", "--json"], cwd, locations),
		);
		expect(code).toBe(3);
		expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({
			args: "a b --json",
			cwd,
			contract: "1",
			package: "mail",
			dir: join(base, "mail"),
			tool: "unread",
			workspace: ws,
			state: join(ws, ".shepherd"),
			config: "/home/fixture/.config/shepherd",
		});
	});
});

describe("one rule gates seeing and running (O3)", () => {
	test("with the package named, dispatch runs and the header lists it; without, neither", async () => {
		for (const named of [true, false]) {
			const { ws, marker, base, locations } = mailFixture(
				named ? "Modules: mail\n" : "Modules: other\n",
			);
			const result = dispatch(["tool", "mail", "unread"], ws, locations);
			const header =
				composeFragments(
					ws,
					"claude-cli",
					undefined,
					[],
					new Date(),
					undefined,
					[{ dir: base, layer: "builtin" }],
				).at(-1) ?? "";
			expect(header.includes("- Package tools: mail unread (read)")).toBe(
				named,
			);
			const { code, stderr } = await execute(result);
			expect(code).toBe(named ? 0 : 2);
			expect(existsSync(marker)).toBe(named);
			if (!named)
				expect(stderr).toBe(
					`shepherd: package "mail" is not selected by this workspace's Modules: line; its tools are unavailable here; if the line names it, see Module problems in the session header\n`,
				);
		}
	});
});

describe("refusals run nothing and exit 2 (O13)", () => {
	const refused = async (
		result: DispatchResult | undefined,
		marker: string,
		message: string | RegExp,
	) => {
		const { code, stderr } = await execute(result);
		expect(code).toBe(2);
		expect(stderr.split("\n").filter(Boolean)).toHaveLength(1);
		if (typeof message === "string")
			expect(stderr).toBe(`shepherd: ${message}\n`);
		else expect(stderr).toMatch(message);
		expect(existsSync(marker)).toBe(false);
	};

	test("the charter does not name the package", async () => {
		const { ws, marker, locations } = mailFixture("# no modules line\n");
		await refused(
			dispatch(["tool", "mail", "unread"], ws, locations),
			marker,
			`package "mail" is not selected by this workspace's Modules: line; its tools are unavailable here; if the line names it, see Module problems in the session header`,
		);
	});

	test("the tool is not declared, though an executable file exists", async () => {
		const { ws, marker, locations } = mailFixture();
		await refused(
			dispatch(["tool", "mail", "undeclared"], ws, locations),
			marker,
			`package "mail" declares no tool "undeclared"; tools: unread, send`,
		);
		await refused(
			dispatch(["tool", "mail"], ws, locations),
			marker,
			`package "mail" needs a tool: shepherd tool mail <tool> [args]; tools: unread, send`,
		);
	});

	test("the declared file is missing or not executable", async () => {
		const { ws, base, marker, locations } = mailFixture();
		rmSync(join(base, "mail/tools/send"));
		chmodSync(join(base, "mail/tools/unread"), 0o644);
		await refused(
			dispatch(["tool", "mail", "send"], ws, locations),
			marker,
			`package "mail" tool "send" is missing: ${join(base, "mail/tools/send")}`,
		);
		await refused(
			dispatch(["tool", "mail", "unread"], ws, locations),
			marker,
			`package "mail" tool "unread" is not executable: ${join(base, "mail/tools/unread")}`,
		);
	});

	test("contract missing or not 1", async () => {
		const { ws, base, marker, locations } = mailFixture();
		for (const contract of ["contract: 2\n", ""]) {
			write(
				join(base, "mail/MODULE.md"),
				packageText("mail", MAIL_TOOLS, "body\n", contract),
			);
			await refused(
				dispatch(["tool", "mail", "unread"], ws, locations),
				marker,
				/^shepherd: package "mail" is excluded: .*MODULE\.md: package-contract: contract: (found 2|missing); this binary implements contract 1; package excluded\n$/,
			);
		}
	});

	test("the package name is found in two locations", async () => {
		const { root, base, marker, locations } = mailFixture();
		const parent = join(root, "parent");
		write(
			join(parent, ".shepherd/packages/mail/MODULE.md"),
			packageText("mail", MAIL_TOOLS),
		);
		write(join(parent, "child/.shepherd/charter.md"), "Modules: mail\n");
		await refused(
			dispatch(["tool", "mail", "unread"], join(parent, "child"), locations),
			marker,
			`package "mail" is found in 2 locations: ${join(base, "mail")}, ${join(parent, ".shepherd/packages/mail")}`,
		);
	});

	test("no workspace can be found", async () => {
		const { root, marker, locations } = mailFixture();
		const outside = join(root, "outside");
		mkdirSync(outside);
		await refused(
			dispatch(["tool", "mail", "unread"], outside, locations),
			marker,
			`no workspace for package "mail": SHEPHERD_WORKSPACE names none and no .shepherd/ is found from ${outside} upward`,
		);
	});
});

describe("the workspace that authorizes (O14, D11)", () => {
	test("SHEPHERD_WORKSPACE authorizes a run from a directory outside it", async () => {
		const { root, ws, marker, locations } = mailFixture();
		const repoDir = join(root, "elsewhere/repo");
		mkdirSync(repoDir, { recursive: true });
		const result = dispatch(["tool", "mail", "unread"], repoDir, locations, {
			SHEPHERD_WORKSPACE: ws,
		});
		expect(result && "exec" in result ? result.exec.cwd : "").toBe(repoDir);
		expect(
			result && "exec" in result ? result.exec.env.SHEPHERD_WORKSPACE : "",
		).toBe(ws);
		expect((await execute(result)).code).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(
			dispatch(["tool", "mail", "unread"], repoDir, locations),
		).toHaveProperty("exit");
	});

	test("a SHEPHERD_WORKSPACE that is not a workspace falls back to the walk up", () => {
		const { root, ws, locations } = mailFixture();
		const result = dispatch(
			["tool", "mail", "unread"],
			join(ws, "sub"),
			locations,
			{
				SHEPHERD_WORKSPACE: join(root, "not-a-workspace"),
			},
		);
		expect(
			result && "exec" in result ? result.exec.env.SHEPHERD_WORKSPACE : "",
		).toBe(ws);
	});
});

describe("extractable (O1, acceptance 6)", () => {
	test("a copy of the software package outside the repository composes and runs", () => {
		const outside = scratch();
		expect(relative(repo, outside).startsWith("..")).toBe(true);
		const location = join(outside, "location");
		cpSync(join(repo, "packages/software"), join(location, "software"), {
			recursive: true,
		});
		write(join(outside, "ws/.shepherd/charter.md"), "Modules: software\n");
		const ws = join(outside, "ws");
		const locations = (): PackageLocation[] => [
			{ dir: location, layer: "builtin" },
		];
		const fragments = composeFragments(
			ws,
			"claude-cli",
			undefined,
			[],
			new Date(),
			undefined,
			locations(),
		);
		expect(fragments.join("\n")).toContain(pinnedSoftware);
		expect(fragments.at(-1)).toContain(
			"- Package tools: software publish-check (read)",
		);
		const result = dispatch(
			["tool", "software", "publish-check", "--help"],
			ws,
			locations,
		);
		if (!result || !("exec" in result))
			throw new Error("expected an exec description");
		expect(result.exec.file).toBe(
			join(location, "software/tools/publish-check"),
		);
		const child = Bun.spawnSync([result.exec.file, ...result.exec.args], {
			cwd: result.exec.cwd,
			env: { ...process.env, ...result.exec.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode).toBe(0);
		expect(child.stdout.toString()).toContain("usage: publish-check");
	});

	test("no file under packages/ imports from Troupe's lib/", () => {
		const files = (dir: string): string[] =>
			readdirSync(dir).flatMap((name) => {
				const path = join(dir, name);
				return statSync(path).isDirectory() ? files(path) : [path];
			});
		const all = files(join(repo, "packages"));
		expect(all.length).toBeGreaterThan(2);
		for (const file of all)
			expect({
				file,
				imports:
					/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'][^"']*\blib\//.test(
						readFileSync(file, "utf8"),
					),
			}).toEqual({ file, imports: false });
	});
});
