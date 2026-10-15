import {
	type BigIntStats,
	type Dirent,
	lstatSync,
	readdirSync,
	readFileSync,
} from "node:fs";
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

export type Mark = {
	state: string;
	relative: string;
	kind: RecordKind | "listing";
	view: string;
};

let marks: Map<string, Mark> | undefined;

/** Keep the first view of a path while a collection pass is recorded. */
function mark(
	state: string,
	relative: string,
	kind: Mark["kind"],
	view: string,
): void {
	const key = `${kind}:${join(state, relative)}`;
	if (marks && !marks.has(key)) marks.set(key, { state, relative, kind, view });
}

function checkPath(
	state: string,
	relative: string,
	kind: RecordKind,
): { checked: CheckedPath; view: string } {
	const unsafe = (file: string, reason: string) => ({
		checked: { status: "unsafe", file, reason } as const,
		view: `unsafe ${file}: ${reason}`,
	});
	if (!localPath(relative)) return unsafe(relative, "is not a local path");
	const absent = { checked: { status: "missing" } as const, view: "missing" };
	const parts = relative.split("/");
	let view = "";
	for (const [index, part] of parts.entries()) {
		const component = [...parts.slice(0, index), part].join("/");
		let stat: BigIntStats;
		try {
			stat = lstatSync(join(state, component), { bigint: true });
		} catch (error) {
			if (missing(error)) return absent;
			return unsafe(
				component,
				error instanceof Error ? error.message : String(error),
			);
		}
		if (stat.isSymbolicLink()) return unsafe(component, "is a symlink");
		const last = index === parts.length - 1;
		if (!last && !stat.isDirectory()) {
			return unsafe(component, "is not a directory");
		}
		if (last && (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
			return unsafe(
				component,
				`is not a ${kind === "file" ? "regular file" : "directory"}`,
			);
		}
		view = `${stat.size} ${stat.ino} ${stat.mtimeNs}`;
	}
	return { checked: { status: "ok", path: join(state, relative) }, view };
}

/**
 * Check a path below state before anything reads it: a local relative path
 * whose every component is lstat'ed, refusing a symlink anywhere, a middle
 * component that is not a directory and a final component of the wrong kind.
 */
export function recordPath(
	state: string,
	relative: string,
	kind: RecordKind = "file",
): CheckedPath {
	const { checked, view } = checkPath(state, relative, kind);
	mark(state, relative, kind, view);
	return checked;
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

export type RecordDir =
	| { status: "ok"; entries: Dirent[] }
	| { status: "missing" }
	| { status: "unsafe"; file: string; reason: string };

function listing(entries: Dirent[]): string {
	return entries
		.map(({ name }) => name)
		.sort()
		.join("\n");
}

/** Enumerate a directory below state through recordPath. */
export function readRecordDir(state: string, relative: string): RecordDir {
	const checked = recordPath(state, relative, "directory");
	if (checked.status !== "ok") return checked;
	try {
		const entries = readdirSync(checked.path, { withFileTypes: true });
		mark(state, relative, "listing", listing(entries));
		return { status: "ok", entries };
	} catch (error) {
		if (missing(error)) return { status: "missing" };
		return {
			status: "unsafe",
			file: relative,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Run one collection pass, keeping the first view of every path it checks
 * through recordPath (size, inode and mtime in nanoseconds) and of every
 * directory it enumerates (the listing). Passes do not nest.
 */
export function recorded<T>(run: () => T): { value: T; marks: Mark[] } {
	marks = new Map();
	try {
		const value = run();
		return { value, marks: [...marks.values()] };
	} finally {
		marks = undefined;
	}
}

/** The paths whose view differs now from the one a pass recorded. */
export function changedPaths(recorded: readonly Mark[]): string[] {
	const changed = recorded.filter(({ state, relative, kind, view }) => {
		if (kind !== "listing")
			return checkPath(state, relative, kind).view !== view;
		const listed = readRecordDir(state, relative);
		return (
			(listed.status === "ok" ? listing(listed.entries) : listed.status) !==
			view
		);
	});
	return [...new Set(changed.map(({ relative }) => relative))];
}
