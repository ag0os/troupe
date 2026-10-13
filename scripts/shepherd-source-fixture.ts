/**
 * Temporary Git repositories holding a minimal Shepherd source set, for the
 * provenance and compiler tests. Git runs without the user's global or system
 * configuration, so a personal ignore file cannot change what a test sees.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGitRunner, SOURCE_FILES } from "./shepherd-source";

export const TEST_GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export const testGit = createGitRunner(TEST_GIT_ENV);

/** Run Git in `root`, throwing on a nonzero exit; returns stdout. */
export function git(root: string, ...args: string[]): string {
	const result = testGit(args, root);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return new TextDecoder().decode(result.stdout);
}

export function writeAt(root: string, path: string, text: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** A Shepherd declaration the compiler accepts. */
export const SHEPHERD_DECLARATION =
	"---\ndescription: Fixture Shepherd\nbackends: [claude, codex]\n---\nShepherd body\n";

/** A side-effect-free extension, so the declaration builds with it. */
export const SHEPHERD_EXTENSION =
	"export function prepare() {\n\treturn {};\n}\n";

/**
 * Write every individually required source file plus one file in each
 * recursive selection, then `git init` and commit. Returns the revision.
 */
export function initShepherdRepo(
	root: string,
	extra: Record<string, string> = {},
): string {
	const files: Record<string, string> = {};
	for (const path of SOURCE_FILES) files[path] = `${path}\n`;
	Object.assign(files, {
		"agents/shepherd.md": SHEPHERD_DECLARATION,
		"agents/shepherd.ts": SHEPHERD_EXTENSION,
		"package.json": "{}\n",
		"tsconfig.json": "{}\n",
		"system-prompts/shepherd/core.md": "Core prompt\n",
		"lib/shepherd/tool.ts": "export const tool = 1;\n",
		"lib/agent-format/run.ts": "export const run = 1;\n",
		...extra,
	});
	for (const [path, text] of Object.entries(files)) writeAt(root, path, text);
	git(root, "init", "-q", "-b", "main");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "fixture");
	return git(root, "rev-parse", "HEAD").trim();
}
