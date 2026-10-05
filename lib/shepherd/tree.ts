import { type Dirent, lstatSync, readdirSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { CHILD_DEPTH, STATE_DIR } from "./workspace";

export interface Workspace {
	name: string;
	dir: string;
	state: string;
}

export interface WorkspaceTree {
	home: string;
	root: Workspace;
	workspaces: Workspace[];
}

export type WorkspaceScope = "check" | "archive" | "archive-recursive";

export class WorkspaceTreeError extends Error {
	readonly exitCode = 2;
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isWorkspace(path: string): boolean {
	return isDirectory(path) && isDirectory(join(path, STATE_DIR));
}

function enclosingWorkspace(path: string): string | undefined {
	for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
		if (isWorkspace(dir)) return dir;
	}
	return undefined;
}

function workspace(root: string, dir: string): Workspace {
	const path = relative(root, dir);
	return {
		name: path ? path.split(sep).join("/") : basename(root),
		dir,
		state: join(dir, STATE_DIR),
	};
}

function entries(path: string): Dirent[] {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Discover the outermost workspace and every workspace nested beneath it. */
export function discoverTree(cwd: string): WorkspaceTree {
	const home = resolve(cwd);
	if (!isWorkspace(home)) {
		throw new WorkspaceTreeError(`not a workspace: ${home}`);
	}

	let root = home;
	for (
		let enclosing = enclosingWorkspace(root);
		enclosing;
		enclosing = enclosingWorkspace(root)
	) {
		root = enclosing;
	}

	const found = [workspace(root, root)];
	const walk = (dir: string, depth: number): void => {
		for (const entry of entries(dir)) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = join(dir, entry.name);
			if (isWorkspace(child)) {
				found.push(workspace(root, child));
				walk(child, 1);
			} else if (depth < CHILD_DEPTH) {
				walk(child, depth + 1);
			}
		}
	};
	walk(root, 1);

	const [rootWorkspace, ...children] = found;
	if (!rootWorkspace) throw new Error("workspace discovery lost its root");
	children.sort((left, right) => left.name.localeCompare(right.name));
	return {
		home,
		root: rootWorkspace,
		workspaces: [rootWorkspace, ...children],
	};
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
	);
}

/** Apply selectors or the command's default workspace scope. */
export function selectWorkspaces(
	tree: WorkspaceTree,
	selectors: string[],
	scope: WorkspaceScope,
): Workspace[] {
	if (selectors.length > 0) {
		const selected = new Set(selectors);
		const unknown = selectors.filter(
			(name, index) =>
				selectors.indexOf(name) === index &&
				!tree.workspaces.some((candidate) => candidate.name === name),
		);
		if (unknown.length > 0) {
			throw new WorkspaceTreeError(
				`unknown workspace: ${unknown.join(", ")} (have: ${tree.workspaces.map(({ name }) => name).join(", ")})`,
			);
		}
		return tree.workspaces.filter(({ name }) => selected.has(name));
	}

	if (scope === "archive") {
		return tree.workspaces.filter(({ dir }) => dir === tree.home);
	}
	return tree.workspaces.filter(({ dir }) => isWithin(tree.home, dir));
}
