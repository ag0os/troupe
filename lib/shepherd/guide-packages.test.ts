import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { packageLocations, packageModules } from "./package-resolution";
import { fakeToolEnv, MAIL_TOOLS, makeTree, packageText } from "./test-support";
import { runTool } from "./tool";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const TRIAGE = "# Triage\n\nOldest first, then by sender.\n";

function workspace(charter: string) {
	const tree = makeTree({
		"parent/.shepherd/charter.md": "",
		"parent/.shepherd/packages/mail/MODULE.md": packageText("mail", MAIL_TOOLS),
		"parent/.shepherd/packages/mail/guides/triage.md": TRIAGE,
		"parent/ws/.shepherd/charter.md": charter,
	});
	cleanups.push(tree.cleanup);
	const cwd = join(realpathSync(tree.root), "parent/ws");
	return fakeToolEnv({ home: join(tree.root, "home"), cwd });
}

/** A working directory outside any workspace, authorized by SHEPHERD_WORKSPACE. */
function outside(charter: string) {
	const inside = workspace(charter);
	const tree = makeTree({ "repo/README.md": "" });
	cleanups.push(tree.cleanup);
	return fakeToolEnv({
		home: inside.home,
		cwd: join(realpathSync(tree.root), "repo"),
		env: { SHEPHERD_WORKSPACE: inside.cwd },
	});
}

const guide = (args: string[], env: ReturnType<typeof workspace>) =>
	runTool(["guide", ...args], {}, env);

describe("tool guide reaches packages (O18, O3)", () => {
	test("the list adds the selected packages' guides", async () => {
		const listed = await guide([], workspace("Modules: mail\n"));
		expect(listed).toMatchObject({ code: 0, stream: "stdout" });
		expect(listed.text).toEndWith(
			"tools: generic traps in Claude Code delegates, the Codex CLI and the shell\nmail triage: How to triage the inbox, in order\n",
		);
		expect(await guide(["mail"], workspace("Modules: mail\n"))).toEqual({
			text: "mail triage: How to triage the inbox, in order\n",
			code: 0,
			stream: "stdout",
		});
	});

	test("a package guide prints whole", async () => {
		expect(
			await guide(["mail", "triage"], workspace("Modules: mail\n")),
		).toEqual({
			text: TRIAGE,
			code: 0,
			stream: "stdout",
		});
	});

	test("an unselected package's guides are neither listed nor printed", async () => {
		const env = workspace("Modules: other\n");
		expect((await guide([], env)).text).not.toContain("mail triage");
		const refusal = {
			text: `shepherd: package "mail" is not selected by this workspace's Modules: line; its guides are unavailable here; if the line names it, see Module problems in the session header\n`,
			code: 2,
			stream: "stderr" as const,
		};
		expect(await guide(["mail"], env)).toEqual(refusal);
		expect(await guide(["mail", "triage"], env)).toEqual(refusal);
	});

	test("an unknown package and an undeclared guide are refused", async () => {
		const env = workspace("Modules: mail\n");
		expect(await guide(["nosuch", "x"], env)).toEqual({
			text: 'shepherd: no package named "nosuch"\n',
			code: 2,
			stream: "stderr",
		});
		expect(await guide(["mail", "send"], env)).toEqual({
			text: 'shepherd: package "mail" declares no guide "send"; guides: triage\n',
			code: 2,
			stream: "stderr",
		});
		const tooMany = await guide(["mail", "triage", "x"], env);
		expect(tooMany).toMatchObject({ code: 2, stream: "stderr" });
		expect(tooMany.text).toContain("shepherd tool guide <package> [<guide>]");
	});

	test("guides follow SHEPHERD_WORKSPACE from a directory outside it (S4, D11)", async () => {
		const env = outside("Modules: mail\n");
		expect((await guide([], env)).text).toContain(
			"mail triage: How to triage the inbox, in order",
		);
		expect(await guide(["mail", "triage"], env)).toEqual({
			text: TRIAGE,
			code: 0,
			stream: "stdout",
		});
		expect((await guide(["mail"], outside("Modules: other\n"))).code).toBe(2);
	});
});

describe("software's guides are declared, listed and readable (O5)", () => {
	function softwareWorkspace() {
		const tree = makeTree({ "ws/.shepherd/charter.md": "Modules: software\n" });
		cleanups.push(tree.cleanup);
		return fakeToolEnv({
			home: join(tree.root, "home"),
			cwd: join(realpathSync(tree.root), "ws"),
		});
	}
	const LISTED =
		"software build: the shape table's Contract timing and Checks rows, steps 3 to 5 and the skills rule; read before briefing a builder\nsoftware check: steps 6 and 7\nsoftware ship: step 8, the grants' journal and a parked task\n";
	const build = () => {
		const software = packageModules(packageLocations(undefined)).find(
			(m) => m.package?.name === "software",
		);
		return readFileSync(
			join(software?.package?.dir ?? "", "guides/build.md"),
			"utf8",
		);
	};

	test("the list ends with build, check and ship", async () => {
		const env = softwareWorkspace();
		expect((await guide([], env)).text).toEndWith(LISTED);
		expect(await guide(["software"], env)).toEqual({
			text: LISTED,
			code: 0,
			stream: "stdout",
		});
	});

	test("a guide prints whole, also from outside the workspace", async () => {
		const env = softwareWorkspace();
		expect(await guide(["software", "build"], env)).toEqual({
			text: build(),
			code: 0,
			stream: "stdout",
		});
		const tree = makeTree({ "repo/README.md": "" });
		cleanups.push(tree.cleanup);
		const away = fakeToolEnv({
			home: env.home,
			cwd: join(realpathSync(tree.root), "repo"),
			env: { SHEPHERD_WORKSPACE: env.cwd },
		});
		expect(await guide(["software", "build"], away)).toEqual({
			text: build(),
			code: 0,
			stream: "stdout",
		});
	});
});
