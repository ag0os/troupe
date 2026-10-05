import {
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const STATE_DIR = ".shepherd";

/**
 * Child workspaces are looked for this many levels below the launch
 * directory. The walk runs on every launch, and a launch in a home directory
 * or a large repository must stay fast.
 */
export const CHILD_DEPTH = 3;

export type Module = { name: string; body: string; path: string };

/**
 * Capability modules in a workspace's integrations dir: workspace-local ones
 * for the launch directory, inherited ones for an enclosing workspace.
 */
export function loadIntegrations(root: string): Module[] {
	const dir = join(root, STATE_DIR, "integrations");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => ({
			name: file,
			body: readFileSync(join(dir, file), "utf8"),
			path: realpathSync(join(dir, file)),
		}));
}

/**
 * The nearest parent directory that is itself a Shepherd workspace. Its
 * modules apply to every workspace beneath it, which is how a group of
 * workspaces shares one layer of conventions without copying it.
 */
export function findEnclosingWorkspace(cwd: string): string | undefined {
	for (let dir = dirname(cwd); dir !== dirname(dir); dir = dirname(dir)) {
		if (existsSync(join(dir, STATE_DIR))) return dir;
	}
	return undefined;
}

/**
 * The workspace charter is the agreed mission and way of working, written
 * during the init conversation. Absence means the workspace is uninitiated
 * and core.md tells Shepherd to run init before substantial work.
 */
export function loadCharter(cwd: string): string | undefined {
	const path = join(cwd, STATE_DIR, "charter.md");
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * The optional built-in modules a charter asks for on a line of its own,
 * `Modules: software`. Declared, not inferred: nothing on disk says what a
 * workspace's work is.
 */
export function declaredModules(charter: string | undefined): Set<string> {
	const line = charter?.match(/^[ \t]*(?:[-*][ \t]+)?\**Modules:\**(.*)$/im);
	return new Set(line?.[1]?.toLowerCase().match(/[a-z][a-z-]*/g) ?? []);
}

/**
 * Workspaces beneath the launch directory, as paths relative to it. A
 * directory with its own .shepherd/ is one, and the walk does not look
 * inside it: what sits below belongs to that workspace. Hidden directories,
 * node_modules and symlinks are not entered.
 */
export function findChildWorkspaces(cwd: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, prefix: string, depth: number) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(dir, entry.name);
			const name = `${prefix}${entry.name}`;
			if (existsSync(join(path, STATE_DIR))) found.push(name);
			else if (depth < CHILD_DEPTH) walk(path, `${name}/`, depth + 1);
		}
	};
	walk(cwd, "", 1);
	return found.sort();
}
