import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { moduleFindings } from "./check-modules";
import { moduleCatalog } from "./module-resolution";
import { fakeToolEnv, MAIL_TOOLS, makeTree, packageText } from "./test-support";
import { runTool } from "./tool";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A base location holding a complete mail package, and a workspace naming it. */
function setup() {
	const tree = makeTree({ "ws/.shepherd/charter.md": "Modules: mail\n" });
	cleanups.push(tree.cleanup);
	const root = realpathSync(tree.root);
	const base = join(root, "base");
	const put = (path: string, text: string, mode = 0o644) => {
		const file = join(base, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
		chmodSync(file, mode);
		return file;
	};
	put("mail/MODULE.md", packageText("mail", MAIL_TOOLS));
	put("mail/tools/unread", "#!/bin/sh\n", 0o755);
	put("mail/tools/send", "#!/bin/sh\n", 0o755);
	put("mail/guides/triage.md", "# Triage\n");
	const findings = () =>
		moduleFindings(
			moduleCatalog(join(root, "ws"), undefined, true, [
				{ dir: base, layer: "builtin" },
			]),
			join(root, "ws/.shepherd"),
		).filter((f) => f.code.startsWith("package-"));
	return { root, base, put, findings };
}

describe("tool check validates packages (O17)", () => {
	test("a complete package has no package findings but a missing requirement", () => {
		const { findings, base } = setup();
		const missing = {
			level: "warn" as const,
			code: "package-requires-missing",
			file: join(base, "mail/MODULE.md"),
			message: 'tool "unread" requires "hey", which is not on PATH',
		};
		expect(findings()).toEqual(Bun.which("hey") ? [] : [missing]);
	});

	test("package-contract", () => {
		const { put, findings, base } = setup();
		put(
			"mail/MODULE.md",
			packageText("mail", MAIL_TOOLS, "b\n", "contract: 2\n"),
		);
		expect(findings()).toEqual([
			expect.objectContaining({
				level: "error",
				code: "package-contract",
				file: join(base, "mail/MODULE.md"),
			}),
		]);
	});

	test("package-tool-missing and package-tool-not-executable", () => {
		const { put, findings, base } = setup();
		put("mail/tools/unread", "#!/bin/sh\n", 0o644);
		rmSync(join(base, "mail/tools/send"));
		const found = findings().filter((f) => f.level === "error");
		expect(found).toEqual([
			{
				level: "error",
				code: "package-tool-not-executable",
				file: join(base, "mail/tools/unread"),
				message: 'declared tool "unread" is not executable',
			},
			{
				level: "error",
				code: "package-tool-missing",
				file: join(base, "mail/tools/send"),
				message: 'declared tool "send" has no file',
			},
		]);
	});

	test("package-tool-undeclared is info: the file is never run", () => {
		const { put, findings, base } = setup();
		put("mail/tools/extra", "#!/bin/sh\n", 0o755);
		expect(findings()).toContainEqual({
			level: "info",
			code: "package-tool-undeclared",
			file: join(base, "mail/tools/extra"),
			message: "tools/extra is not declared in MODULE.md; it is never run",
		});
	});

	test("package-guide-missing", () => {
		const { findings, base } = setup();
		rmSync(join(base, "mail/guides/triage.md"));
		expect(findings()).toContainEqual({
			level: "error",
			code: "package-guide-missing",
			file: join(base, "mail/guides/triage.md"),
			message: 'declared guide "triage" has no file',
		});
	});

	test("package-requires-missing looks on PATH only", () => {
		const { put, findings, base } = setup();
		put(
			"mail/MODULE.md",
			packageText(
				"mail",
				"tools:\n  unread:\n    description: List\n    access: read\n    requires: [no-such-binary-for-shepherd]\n",
			),
		);
		expect(findings()).toContainEqual({
			level: "warn" as const,
			code: "package-requires-missing",
			file: join(base, "mail/MODULE.md"),
			message:
				'tool "unread" requires "no-such-binary-for-shepherd", which is not on PATH',
		});
	});

	test("package-name-reserved", () => {
		const { put, findings, base } = setup();
		put("check/MODULE.md", packageText("check"));
		expect(findings()).toContainEqual(
			expect.objectContaining({
				level: "error",
				code: "package-name-reserved",
				file: join(base, "check/MODULE.md"),
			}),
		);
	});

	test("package-duplicate, once per location, with absolute paths", () => {
		const { root, put, base } = setup();
		put("mail/tools/extra", "", 0o644);
		const other = join(root, "other");
		mkdirSync(join(other, "mail"), { recursive: true });
		writeFileSync(join(other, "mail/MODULE.md"), packageText("mail"));
		const found = moduleFindings(
			moduleCatalog(join(root, "ws"), undefined, true, [
				{ dir: base, layer: "builtin" },
				{ dir: other, layer: "inherited" },
			]),
			join(root, "ws/.shepherd"),
		).filter((f) => f.code === "package-duplicate");
		expect(found.map((f) => [f.level, f.file])).toEqual([
			["error", join(base, "mail/MODULE.md")],
			["error", join(other, "mail/MODULE.md")],
		]);
	});

	test("check exits 1 on a package error", async () => {
		const tree = makeTree({
			"parent/.shepherd/charter.md": "",
			"parent/.shepherd/packages/mail/MODULE.md": packageText(
				"mail",
				MAIL_TOOLS,
			),
			"parent/ws/.shepherd/charter.md": "Modules: mail\n",
			"parent/ws/.shepherd/CURRENT.md": "Updated: 2026-10-05\n",
		});
		cleanups.push(tree.cleanup);
		const cwd = join(realpathSync(tree.root), "parent/ws");
		const result = await runTool(
			["check"],
			{ json: true },
			fakeToolEnv({ home: join(tree.root, "home"), cwd }),
		);
		expect(result.code).toBe(1);
		expect(result.text).toContain('"code": "package-tool-missing"');
	});
});
