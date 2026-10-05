import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface MakeTreeOptions {
	symlinks?: Record<string, string>;
	mtimes?: Record<string, Date | string | number>;
	prefix?: string;
}

export interface TreeFixture {
	root: string;
	cleanup: () => void;
}

/** Build an isolated filesystem tree for Shepherd tests. */
export function makeTree(
	files: Record<string, string>,
	options: MakeTreeOptions = {},
): TreeFixture {
	const root = mkdtempSync(join(tmpdir(), options.prefix ?? "shepherd-test-"));
	for (const [relative, content] of Object.entries(files)) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	for (const [relative, target] of Object.entries(options.symlinks ?? {})) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(join(root, target), path);
	}
	for (const [relative, value] of Object.entries(options.mtimes ?? {})) {
		const date = value instanceof Date ? value : new Date(value);
		utimesSync(join(root, relative), date, date);
	}
	return {
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
