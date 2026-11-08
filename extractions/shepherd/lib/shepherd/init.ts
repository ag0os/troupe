import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { renderTemplate, TEMPLATES } from "./guides";

export type InitEntry = { path: string; status: "created" | "kept" };
export type InitFailure = { path: string; error: string };
export type InitResult = {
	root: string;
	state: string;
	master: boolean;
	entries: InitEntry[];
	created: string[];
	kept: string[];
	failed: InitFailure | null;
};

type InitOptions = { master: boolean };

function targets(master: boolean): { path: string; text?: string }[] {
	return [
		...TEMPLATES.filter((template) => !template.master),
		...["work/todo/", "work/in-progress/", "work/done/"].map((path) => ({
			path,
		})),
		...(master ? TEMPLATES.filter((template) => template.master) : []),
	];
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function resultFor(root: string, master: boolean): InitResult {
	return {
		root,
		state: join(root, ".shepherd"),
		master,
		entries: [],
		created: [],
		kept: [],
		failed: null,
	};
}

function record(
	result: InitResult,
	path: string,
	status: InitEntry["status"],
): void {
	result.entries.push({ path, status });
	result[status].push(path);
}

/** Inspect the ordered targets without writing anything. Created means missing. */
export function planInit(root: string, { master }: InitOptions): InitResult {
	const result = resultFor(root, master);
	for (const { path } of targets(master)) {
		record(
			result,
			path,
			present(join(result.state, path.replace(/\/$/, ""))) ? "kept" : "created",
		);
	}
	return result;
}

function createDirectory(path: string): InitEntry["status"] {
	if (present(path)) {
		const stat = lstatSync(path);
		if (!stat.isSymbolicLink() && !stat.isDirectory())
			throw new Error("a file is in the way");
		return "kept";
	}
	mkdirSync(dirname(path), { recursive: true });
	try {
		mkdirSync(path);
		return "created";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const stat = lstatSync(path);
		if (!stat.isSymbolicLink() && !stat.isDirectory())
			throw new Error("a file is in the way");
		return "kept";
	}
}

function createFile(path: string, text: string): InitEntry["status"] {
	if (present(path)) return "kept";
	mkdirSync(dirname(path), { recursive: true });
	let fd: number;
	try {
		fd = openSync(path, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "kept";
		throw error;
	}
	try {
		writeFileSync(fd, text);
	} finally {
		closeSync(fd);
	}
	return "created";
}

/** Create missing entries in order, preserving existing paths and completed writes. */
export function applyInit(
	root: string,
	{ master, now }: InitOptions & { now: Date },
): InitResult {
	const result = resultFor(root, master);
	for (const { path, text } of targets(master)) {
		try {
			const target = join(result.state, path.replace(/\/$/, ""));
			const status =
				text === undefined
					? createDirectory(target)
					: createFile(target, renderTemplate(text, now));
			record(result, path, status);
		} catch (error) {
			result.failed = {
				path,
				error: error instanceof Error ? error.message : String(error),
			};
			break;
		}
	}
	return result;
}

export function renderInit(result: InitResult): string {
	const lines = [
		`Initialized ${result.state} (${result.master ? "workspace, shared layer" : "workspace"})`,
		...result.entries.map(
			({ path, status }) => `  ${status.padEnd(7)} ${path}`,
		),
	];
	if (result.failed) {
		lines.push(`  failed  ${result.failed.path}: ${result.failed.error}`);
	} else {
		lines.push(
			"Next: launch `shepherd` here and run the init conversation; `shepherd tool guide charter` has the questions and the charter's shape.",
		);
	}
	return lines.join("\n");
}

export function initJson(result: InitResult) {
	return {
		schema: 1,
		command: "init",
		root: result.root,
		state: result.state,
		master: result.master,
		created: result.created,
		kept: result.kept,
		failed: result.failed,
	};
}

export function initExitCode(result: InitResult): 0 | 1 {
	return result.failed ? 1 : 0;
}
