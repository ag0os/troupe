import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localPath } from "./checkpoint";

export type RecordKind = "file" | "directory";

export type CheckedPath =
	| { status: "ok"; path: string }
	| { status: "missing" }
	| { status: "unsafe"; file: string; reason: string };

function missing(error: unknown): boolean {
	return ["ENOENT", "ENOTDIR"].includes(
		(error as NodeJS.ErrnoException).code ?? "",
	);
}

/**
 * Check a path below state before anything reads it: a local relative path
 * whose every component is lstat'ed, refusing a symlink anywhere and a final
 * component of the wrong kind.
 */
export function recordPath(
	state: string,
	relative: string,
	kind: RecordKind = "file",
): CheckedPath {
	if (!localPath(relative)) {
		return { status: "unsafe", file: relative, reason: "is not a local path" };
	}
	const parts = relative.split("/");
	for (const [index, part] of parts.entries()) {
		const component = [...parts.slice(0, index), part].join("/");
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(join(state, component));
		} catch (error) {
			if (missing(error)) return { status: "missing" };
			return {
				status: "unsafe",
				file: component,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		if (stat.isSymbolicLink()) {
			return { status: "unsafe", file: component, reason: "is a symlink" };
		}
		const last = index === parts.length - 1;
		if (!last && !stat.isDirectory()) return { status: "missing" };
		if (last && (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
			return {
				status: "unsafe",
				file: component,
				reason: `is not a ${kind === "file" ? "regular file" : "directory"}`,
			};
		}
	}
	return { status: "ok", path: join(state, relative) };
}

export type ReadRecord =
	| { status: "ok"; text: string }
	| { status: "missing" }
	| { status: "unsafe"; file: string; reason: string };

/** Read a record file below state through recordPath. */
export function readRecord(state: string, relative: string): ReadRecord {
	const checked = recordPath(state, relative);
	if (checked.status !== "ok") return checked;
	try {
		return { status: "ok", text: readFileSync(checked.path, "utf8") };
	} catch (error) {
		if (missing(error)) return { status: "missing" };
		return {
			status: "unsafe",
			file: relative,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
