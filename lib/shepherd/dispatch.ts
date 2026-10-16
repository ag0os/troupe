import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DispatchResult } from "../agent-format/types";
import { userConfigFile } from "./config";
import { PACKAGE_CONTRACT } from "./module-format";
import { authorizingWorkspace, packageAccess } from "./package-access";
import type { PackageLocation } from "./package-resolution";
import { isToolCommand } from "./tool";
import { STATE_DIR } from "./workspace";

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
	const access = packageAccess(
		name,
		workspace,
		"tools",
		ctx.cwd,
		ctx.locations,
	);
	if (access.kind === "absent") return undefined;
	if (access.kind === "refused" || !workspace)
		return refuse(access.kind === "refused" ? access.message : "");
	const held = access.record;
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
