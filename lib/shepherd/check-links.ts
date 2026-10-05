import { existsSync, readdirSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { Finding, FindingLevel } from "./check";
import { mdFiles, proseLines, read, walk } from "./text";
import type { Workspace, WorkspaceTree } from "./tree";

const STATES = ["todo", "in-progress", "done"] as const;
const ITEM_REFERENCE =
	/(?:(?:((?:~\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/\.shepherd\/))?work\/(todo|in-progress|done)\/([A-Za-z0-9_-]+)/g;

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
	);
}

function decoded(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

function liveFiles(workspace: Workspace): {
	files: string[];
	doneStatus: Set<string>;
} {
	const files = [
		"CURRENT.md",
		"MEMORY.md",
		"HANDOFF.md",
		"charter.md",
		"work/README.md",
		"archive/INDEX.md",
	]
		.map((file) => join(workspace.state, file))
		.filter((file) => existsSync(file));
	files.push(
		...mdFiles(join(workspace.state, "memories")),
		...mdFiles(join(workspace.state, "docs")),
		...walk(join(workspace.state, "integrations"), (file) =>
			file.endsWith(".md"),
		),
	);

	const doneStatus = new Set<string>();
	for (const state of STATES) {
		const dir = join(workspace.state, "work", state);
		if (!existsSync(dir)) continue;
		for (const slug of readdirSync(dir).sort()) {
			const status = join(dir, slug, "STATUS.md");
			if (!existsSync(status)) continue;
			files.push(status);
			if (state === "done") doneStatus.add(status);
		}
	}
	return { files, doneStatus };
}

function findItem(stateDir: string, slug: string): string | undefined {
	for (const state of STATES) {
		if (existsSync(join(stateDir, "work", state, slug))) {
			return `work/${state}/`;
		}
	}
	const archive = join(stateDir, "archive");
	if (!existsSync(archive)) return undefined;
	for (const month of readdirSync(archive).sort()) {
		if (/^\d{4}-\d{2}$/.test(month) && existsSync(join(archive, month, slug))) {
			return `archive/${month}/`;
		}
	}
	return undefined;
}

function referencedWorkspace(
	prefix: string | undefined,
	workspace: Workspace,
	tree: WorkspaceTree,
	home: string | undefined,
): Workspace | undefined {
	if (!prefix) return workspace;
	const workspacePath = prefix;
	if (workspacePath.startsWith("~/")) {
		if (!home) return undefined;
		const state = join(home, workspacePath.slice(2), ".shepherd");
		return tree.workspaces.find((candidate) => candidate.state === state);
	}
	if (workspacePath.startsWith("/")) {
		const state = join(workspacePath, ".shepherd");
		return tree.workspaces.find((candidate) => candidate.state === state);
	}
	return tree.workspaces.find((candidate) => candidate.name === workspacePath);
}

/** Check links and path references in one workspace's live files. */
export function checkLinks(
	workspace: Workspace,
	tree: WorkspaceTree,
	home?: string,
): Finding[] {
	const findings: Finding[] = [];
	const add = (
		level: FindingLevel,
		code: string,
		path: string,
		message: string,
		line: number,
	) => {
		findings.push({
			level,
			code,
			file: relative(workspace.state, path) || ".",
			line,
			message,
		});
	};

	const { files, doneStatus } = liveFiles(workspace);
	const memoryNames = new Set(
		mdFiles(join(workspace.state, "memories")).map((file) =>
			basename(file, ".md"),
		),
	);
	const documentNames = new Set(
		mdFiles(workspace.state).map((file) => basename(file, ".md")),
	);

	for (const file of files) {
		const level: FindingLevel = doneStatus.has(file) ? "info" : "error";
		for (const { n, line } of proseLines(read(file))) {
			for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
				const source = match[1];
				if (!source) continue;
				const target = decoded(source.split("#")[0] ?? "");
				if (!target || /^[a-z]+:/i.test(target)) continue;
				const resolved = target.startsWith("~/")
					? home
						? join(home, target.slice(2))
						: undefined
					: target.startsWith("/")
						? target
						: resolve(dirname(file), target);
				if (
					resolved &&
					isWithin(tree.root.dir, resolved) &&
					!existsSync(resolved)
				) {
					add(
						level,
						"link-broken",
						file,
						`link to ${source} does not resolve`,
						n,
					);
				}
			}

			for (const match of line.matchAll(/`(\.{1,2}\/[^`\s]+)`/g)) {
				const source = match[1];
				if (!source || /[<>*]/.test(source)) continue;
				const resolved = resolve(dirname(file), source);
				if (isWithin(tree.root.dir, resolved) && !existsSync(resolved)) {
					add(level, "path-broken", file, `path ${source} does not resolve`, n);
				}
			}

			for (const match of line
				.replace(/`[^`]*`/g, "")
				.matchAll(/\[\[([^\]]+)\]\]/g)) {
				const name = match[1];
				if (name && !memoryNames.has(name) && !documentNames.has(name)) {
					add(
						level,
						"wikilink-broken",
						file,
						`[[${name}]] matches no memory or doc`,
						n,
					);
				}
			}

			for (const match of line.matchAll(ITEM_REFERENCE)) {
				const referenced = referencedWorkspace(match[1], workspace, tree, home);
				const state = match[2];
				const slug = match[3];
				if (!referenced || !state || !slug) continue;
				if (existsSync(join(referenced.state, "work", state, slug))) continue;
				const movedTo = findItem(referenced.state, slug);
				add(
					level,
					"item-ref-broken",
					file,
					`work/${state}/${slug} does not exist${movedTo ? ` (now in ${movedTo})` : ""}`,
					n,
				);
			}
		}
	}

	return findings;
}
