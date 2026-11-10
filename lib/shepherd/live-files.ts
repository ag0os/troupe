import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mdFiles, walk } from "./text";
import type { Workspace } from "./tree";

const STATES = ["todo", "in-progress", "done"] as const;

/**
 * A workspace's live record files, the ones link checks read and archiving
 * rewrites, in a fixed order; doneStatus holds the done items' STATUS files.
 */
export function liveFiles(workspace: Workspace): {
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
