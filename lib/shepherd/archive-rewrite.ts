import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { mdFiles, read, walk } from "./text";
import type { Workspace } from "./tree";

const STATES = ["todo", "in-progress", "done"] as const;

export interface ArchivedItem {
	workspace: string;
	slug: string;
	month: string;
	from: string;
	to: string;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function liveFiles(workspace: Workspace): string[] {
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

	for (const state of STATES) {
		const dir = join(workspace.state, "work", state);
		if (!existsSync(dir)) continue;
		for (const slug of readdirSync(dir).sort()) {
			const status = join(dir, slug, "STATUS.md");
			if (existsSync(status)) files.push(status);
		}
	}
	return files;
}

function rewriteFile(
	file: string,
	target: Workspace,
	moves: readonly ArchivedItem[],
	home?: string,
): boolean {
	const before = read(file);
	let text = before;
	for (const move of moves) {
		const slug = escapeRegExp(move.slug);
		const end = "(?![A-Za-z0-9_-])";
		const workspaceDir = dirname(dirname(dirname(dirname(move.from))));
		text = text.replace(
			new RegExp(
				`(?<![A-Za-z0-9._-])((?:~\\/|\\/)?[A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)*)/\\.shepherd/work/done/${slug}${end}`,
				"g",
			),
			(all, reference: string) => {
				const resolves = reference.startsWith("~/")
					? home !== undefined &&
						resolve(home, reference.slice(2)) === workspaceDir
					: reference.startsWith("/")
						? resolve(reference) === workspaceDir
						: reference === move.workspace ||
							resolve(dirname(file), reference) === workspaceDir;
				return resolves
					? `${reference}/.shepherd/archive/${move.month}/${move.slug}`
					: all;
			},
		);
		if (target.name !== move.workspace) continue;
		text = text.replace(
			new RegExp(`(?<![A-Za-z0-9_-])\\.shepherd/work/done/${slug}${end}`, "g"),
			`.shepherd/archive/${move.month}/${move.slug}`,
		);
		text = text.replace(
			new RegExp(`((?:\\.{1,2}/)+)((?:work/)?done/${slug})${end}`, "g"),
			(all, dots: string, rest: string) => {
				const old = resolve(dirname(file), dots + rest);
				if (old !== move.from) return all;
				const fresh = relative(dirname(file), move.to);
				return fresh.startsWith(".") ? fresh : `./${fresh}`;
			},
		);
		text = text.replace(
			new RegExp(`(?<![A-Za-z0-9_./-])work/done/${slug}${end}`, "g"),
			`archive/${move.month}/${move.slug}`,
		);
	}
	if (text === before) return false;
	writeFileSync(file, text);
	return true;
}

/** Rewrite live references to moved items throughout the workspace tree. */
export function rewriteArchiveReferences(
	workspaces: readonly Workspace[],
	moves: readonly ArchivedItem[],
	home?: string,
): string[] {
	if (moves.length === 0) return [];
	const rewritten: string[] = [];
	for (const workspace of workspaces) {
		for (const file of liveFiles(workspace)) {
			if (rewriteFile(file, workspace, moves, home)) rewritten.push(file);
		}
	}
	return rewritten;
}
