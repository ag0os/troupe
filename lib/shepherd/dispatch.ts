import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DispatchResult } from "../agent-format/types";
import { userConfigFile } from "./config";
import { PACKAGE_CONTRACT } from "./module-format";
import { moduleCatalog, resolveModules } from "./module-resolution";
import {
	type PackageLocation,
	packageLocations,
	packageModules,
} from "./package-resolution";
import { isToolCommand } from "./tool";
import { findEnclosingWorkspace, STATE_DIR } from "./workspace";

export type PackageDispatchContext = {
	cwd: string;
	env: Readonly<Record<string, string | undefined>>;
	/** The locations for an enclosing workspace; the defaults otherwise. */
	locations?: (enclosing: string | undefined) => readonly PackageLocation[];
};

function refuse(message: string): DispatchResult {
	return {
		exit: { message: `shepherd: ${message}\n`, code: 2, stream: "stderr" },
	};
}

function isWorkspace(dir: string): boolean {
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

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Route `shepherd tool <package> <tool> [args...]` (docs/PACKAGES.md). Any
 * argv that is not a package run is left to the CLI parser: one whose first
 * word is not `tool`, whose second is a core command, or whose second no
 * location holds. A package run is described for the runner to spawn, or
 * refused with one `shepherd:` line and exit 2; dispatch never runs it.
 */
export function dispatchPackageTool(
	argv: readonly string[],
	ctx: PackageDispatchContext,
): DispatchResult | undefined {
	const [command, name, tool] = argv;
	if (command !== "tool" || name === undefined || isToolCommand(name))
		return undefined;
	const workspace = authorizingWorkspace(ctx.cwd, ctx.env);
	const enclosing = workspace ? findEnclosingWorkspace(workspace) : undefined;
	const locations = ctx.locations?.(enclosing) ?? packageLocations(enclosing);
	const holders = packageModules(locations, true).filter(
		(m) => m.package?.name === name,
	);
	const held = holders[0]?.package;
	if (!held) return undefined;
	if (!workspace)
		return refuse(
			`no workspace for package "${name}": SHEPHERD_WORKSPACE names none and no ${STATE_DIR}/ is found from ${ctx.cwd} upward`,
		);
	if (holders.length > 1)
		return refuse(
			`package "${name}" is found in ${holders.length} locations: ${holders.map((m) => m.package?.dir).join(", ")}`,
		);
	const problems = holders[0]?.problems ?? [];
	if (problems.length)
		return refuse(
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
		return refuse(
			`package "${name}" is not named on this workspace's Modules: line; its tools are unavailable here`,
		);
	const tools = Object.keys(held.tools);
	const listed = tools.join(", ") || "none";
	if (tool === undefined)
		return refuse(
			`package "${name}" needs a tool: shepherd tool ${name} <tool> [args]; tools: ${listed}`,
		);
	if (!Object.hasOwn(held.tools, tool))
		return refuse(
			`package "${name}" declares no tool "${tool}"; tools: ${listed}`,
		);
	const file = join(held.dir, "tools", tool);
	if (!existsSync(file))
		return refuse(`package "${name}" tool "${tool}" is missing: ${file}`);
	if (!executable(file))
		return refuse(
			`package "${name}" tool "${tool}" is not executable: ${file}`,
		);
	const home = ctx.env.HOME || homedir();
	return {
		exec: {
			file,
			args: argv.slice(3),
			cwd: ctx.cwd,
			env: {
				SHEPHERD_CONTRACT: String(PACKAGE_CONTRACT),
				SHEPHERD_PACKAGE: name,
				SHEPHERD_PACKAGE_DIR: held.dir,
				SHEPHERD_TOOL: tool,
				SHEPHERD_WORKSPACE: workspace,
				SHEPHERD_STATE_DIR: join(workspace, STATE_DIR),
				SHEPHERD_CONFIG_DIR: dirname(
					userConfigFile({ home, env: ctx.env as NodeJS.ProcessEnv }),
				),
			},
		},
	};
}
