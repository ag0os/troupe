import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { moduleCatalog, resolveModules } from "./module-resolution";
import {
	type PackageLocation,
	type PackageRecord,
	packageLocations,
	packageModules,
	selectedPackages,
} from "./package-resolution";
import { findEnclosingWorkspace, STATE_DIR } from "./workspace";

export function isWorkspace(dir: string): boolean {
	return existsSync(join(dir, STATE_DIR));
}

/**
 * The workspace whose charter authorizes a package run (D11):
 * `SHEPHERD_WORKSPACE` when it names a workspace, else the nearest directory
 * with `.shepherd/` from `cwd` upward. The variable decides nothing else. A
 * launcher variable is inherited by every process the session starts, nested
 * sessions and forks included, so it authorizes, and never identifies.
 */
export function authorizingWorkspace(
	cwd: string,
	env: Readonly<Record<string, string | undefined>>,
): string | undefined {
	const named = env.SHEPHERD_WORKSPACE;
	if (named && isAbsolute(named) && isWorkspace(named)) return resolve(named);
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (isWorkspace(dir)) return dir;
		if (dir === dirname(dir)) return undefined;
	}
}

export type PackageAccess =
	| { kind: "absent" }
	| { kind: "refused"; message: string }
	| { kind: "selected"; record: PackageRecord };

/**
 * The one rule that gates a package's text, tools and guides (O3): the
 * package `name` is usable from `workspace` only when exactly one location
 * holds it, it has no problems, and the workspace's charter selects it.
 * `absent` means no location holds the name.
 */
export function packageAccess(
	name: string,
	workspace: string | undefined,
	offering: "tools" | "guides",
	from: string,
	locate: (enclosing: string | undefined) => readonly PackageLocation[] = (
		enclosing,
	) => packageLocations(enclosing),
): PackageAccess {
	const enclosing = workspace ? findEnclosingWorkspace(workspace) : undefined;
	const locations = locate(enclosing);
	const holders = packageModules(locations, true).filter(
		(m) => m.package?.name === name,
	);
	const held = holders[0]?.package;
	const refused = (message: string): PackageAccess => ({
		kind: "refused",
		message,
	});
	if (!held) return { kind: "absent" };
	if (!workspace)
		return refused(
			`no workspace for package "${name}": SHEPHERD_WORKSPACE names none and no ${STATE_DIR}/ is found from ${from} upward`,
		);
	if (holders.length > 1)
		return refused(
			`package "${name}" is found in ${holders.length} locations: ${holders.map((m) => m.package?.dir).join(", ")}`,
		);
	const problems = holders[0]?.problems ?? [];
	if (problems.length)
		return refused(
			`package "${name}" is excluded: ${problems.map((p) => `${holders[0]?.source}: ${p.code}: ${p.message}`).join("; ")}`,
		);
	let selected: boolean;
	try {
		selected = resolveModules(
			moduleCatalog(workspace, enclosing, true, locations),
		).selected.some((m) => m.package?.name === name && m.body !== undefined);
	} catch {
		selected = false;
	}
	if (!selected)
		return refused(
			`package "${name}" is not named on this workspace's Modules: line; its ${offering} are unavailable here`,
		);
	return { kind: "selected", record: held };
}

/** The loadable packages `workspace` selects, from the default locations. */
export function selectedPackageRecords(workspace: string): PackageRecord[] {
	const enclosing = findEnclosingWorkspace(workspace);
	try {
		return selectedPackages(
			resolveModules(
				moduleCatalog(workspace, enclosing, true, packageLocations(enclosing)),
			).selected,
		);
	} catch {
		return [];
	}
}
