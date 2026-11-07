import { basename, dirname, relative, resolve } from "node:path";
import { isWithin } from "./path-within";

/**
 * Convert an agent source path to its namespaced binary name, relative to
 * the declaration root (`<cwd>/agents` unless given).
 * - Outside the declaration root: plain filename
 * - agents/foo.ts → foo
 * - agents/tasks/manager.ts → tasks:manager
 * - agents/design/diagram/all.ts → design:diagram:all
 * - agents/design/diagram/all.md → design:diagram:all
 */
export function toBinaryName(
	filePath: string,
	cwd = process.cwd(),
	declarationRoot = resolve(cwd, "agents"),
): string {
	const base = basename(filePath).replace(/\.(tsx?|md)$/, "");

	const relativePath = relative(declarationRoot, filePath);
	if (!isWithin(declarationRoot, filePath) || relativePath === filePath) {
		return base;
	}

	const dir = dirname(relativePath);
	if (dir === ".") return base;

	return `${dir.split("/").join(":")}:${base}`;
}
