import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

/**
 * Whether `child` is `parent` or lies beneath it. Only a leading `..` path
 * component means outside; a name that merely starts with two dots, such as
 * `..evidence`, is inside.
 */
export function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return (
		rel === "" ||
		(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
	);
}

/**
 * The realpath of `path`'s nearest existing ancestor, joined to the
 * components that do not exist yet. Boundaries and owned locations are
 * compared in these coordinates, so a symlink anywhere along a path, or an
 * absent path beneath one, is judged where it really leads.
 */
export function canonical(path: string, depth = 0): string {
	const absolute = resolve(path);
	const rest: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			// A dangling symlink is judged by where it points.
			const link = lstatSync(current, { throwIfNoEntry: false });
			if (link?.isSymbolicLink() && depth < 40) {
				const target = resolve(dirname(current), readlinkSync(current));
				return join(canonical(target, depth + 1), ...rest.reverse());
			}
			const parent = dirname(current);
			if (parent === current) return absolute;
			rest.push(basename(current));
			current = parent;
		}
	}
}
