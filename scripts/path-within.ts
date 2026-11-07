import { isAbsolute, relative, sep } from "node:path";

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
