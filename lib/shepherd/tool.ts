import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	applyArchive,
	archiveExitCode,
	planArchive,
	renderArchive,
} from "./archive";
import { checkWorkspace, type Finding, type FindingLevel } from "./check";
import {
	type Config,
	type ConfigProblem,
	loadConfig,
	splitConfigProblems,
} from "./config";
import { contextTiers, renderContextTable } from "./context";
import { dayOf, localDate } from "./dates";
import { GUIDES } from "./guides";
import { applyInit, initExitCode, initJson, renderInit } from "./init";
import { runningSessions, type ToolEnv } from "./sessions";
import { renderStatus, statusJson, statusReport } from "./status-render";
import {
	discoverTree,
	selectWorkspaces,
	type Workspace,
	type WorkspaceTree,
	WorkspaceTreeError,
} from "./tree";
import { STATE_DIR } from "./workspace";

export type ToolResult = {
	text: string;
	code: number;
	stream: "stdout" | "stderr";
};

type ToolFlags = Readonly<Record<string, string | boolean>>;

const USAGE = [
	"shepherd tool check   [<workspace>...] [--all] [--status | --context] [--json] [--today YYYY-MM-DD]",
	"shepherd tool archive [<workspace>...] [--recursive] [--apply] [--json] [--today YYYY-MM-DD]",
	"shepherd tool guide [<name>]",
	"shepherd tool init [--master] [--json]",
].join("\n");

const CHECK_FLAGS = new Set(["all", "status", "context", "json", "today"]);
const ARCHIVE_FLAGS = new Set(["recursive", "apply", "json", "today"]);
const INIT_FLAGS = new Set(["master", "json"]);
const TOOL_FLAGS = new Set([...CHECK_FLAGS, ...ARCHIVE_FLAGS, ...INIT_FLAGS]);
const LEVELS: FindingLevel[] = ["error", "warn", "info"];

/** Whether a positional names a Shepherd maintenance command. */
export function isToolCommand(
	command: string | undefined,
): command is "check" | "archive" | "guide" | "init" {
	return (
		command === "check" ||
		command === "archive" ||
		command === "guide" ||
		command === "init"
	);
}

function result(
	text: string,
	code: number,
	stream: "stdout" | "stderr" = "stdout",
): ToolResult {
	return { text: text.endsWith("\n") ? text : `${text}\n`, code, stream };
}

function usage(): ToolResult {
	return result(USAGE, 2, "stderr");
}

function flagName(name: string): string {
	return name === "name" ? "--name" : `--${name}`;
}

function invalidFlag(
	command: "check" | "archive" | "guide" | "init",
	flags: ToolFlags,
): string | undefined {
	const allowed =
		command === "check"
			? CHECK_FLAGS
			: command === "archive"
				? ARCHIVE_FLAGS
				: command === "init"
					? INIT_FLAGS
					: new Set<string>();
	for (const [name, value] of Object.entries(flags)) {
		if (value === false || value === undefined || allowed.has(name)) continue;
		if (name === "name") return "shepherd: --name applies only to launches";
		if (TOOL_FLAGS.has(name)) {
			const owner =
				name === "master"
					? "tool init"
					: name === "json"
						? "tool check, tool archive and tool init"
						: name === "today"
							? "tool check and tool archive"
							: name === "apply" || name === "recursive"
								? "tool archive"
								: "tool check";
			return `shepherd: ${flagName(name)} applies only to ${owner}`;
		}
	}
	return undefined;
}

function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return (
		path === "" ||
		(!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
	);
}

function configForWorkspace(
	workspace: Workspace,
	tree: WorkspaceTree,
	toolEnv: ToolEnv,
): Config {
	return loadConfig({
		home: toolEnv.home,
		env: toolEnv.env,
		workspaceChain: tree.workspaces
			.filter((candidate) => isWithin(candidate.dir, workspace.dir))
			.sort((left, right) => left.dir.length - right.dir.length)
			.map(({ dir }) => dir),
	});
}

function configProblemLine(problem: ConfigProblem): string {
	return `shepherd: ${problem.file}: ${problem.key}: ${problem.problem}`;
}

function enclosingWorkspace(cwd: string): string | undefined {
	for (
		let dir = dirname(resolve(cwd));
		dir !== dirname(dir);
		dir = dirname(dir)
	) {
		if (existsSync(join(dir, STATE_DIR))) return dir;
	}
	return undefined;
}

function treeError(cwd: string, error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	const nearest = message.startsWith("not a workspace:")
		? enclosingWorkspace(cwd)
		: undefined;
	return result(
		nearest ? `${message}; the nearest one is ${nearest}, use --cwd` : message,
		2,
		"stderr",
	);
}

function todayFrom(flags: ToolFlags, fallback: Date): Date | ToolResult {
	if (typeof flags.today !== "string") return fallback;
	const today = localDate(flags.today);
	return Number.isNaN(today.getTime())
		? result(`shepherd: invalid --today: ${flags.today}`, 2, "stderr")
		: today;
}

type Counts = Record<FindingLevel, number>;

function counts(findings: readonly Finding[]): Counts {
	return {
		error: findings.filter(({ level }) => level === "error").length,
		warn: findings.filter(({ level }) => level === "warn").length,
		info: findings.filter(({ level }) => level === "info").length,
	};
}

function findingReports(
	workspaces: readonly Workspace[],
	tree: WorkspaceTree,
	configs: ReadonlyMap<string, Config>,
	today: Date,
	home: string,
) {
	return workspaces.map((workspace) => {
		const config = configs.get(workspace.dir);
		if (!config) throw new Error(`missing config for ${workspace.dir}`);
		const findings = checkWorkspace(workspace, tree, config, today, home);
		return {
			name: workspace.name,
			dir: workspace.dir,
			counts: counts(findings),
			findings,
		};
	});
}

function totals(reports: ReturnType<typeof findingReports>): Counts {
	return reports.reduce(
		(total, report) => ({
			error: total.error + report.counts.error,
			warn: total.warn + report.counts.warn,
			info: total.info + report.counts.info,
		}),
		{ error: 0, warn: 0, info: 0 },
	);
}

function renderFindings(
	reports: ReturnType<typeof findingReports>,
	showAll: boolean,
): string {
	const lines: string[] = [];
	for (const report of reports) {
		lines.push(
			"",
			`${report.name}  (${LEVELS.map((level) => `${report.counts[level]} ${level}`).join(", ")})`,
		);
		const shown = report.findings
			.filter(({ level }) => showAll || level !== "info")
			.sort(
				(left, right) =>
					LEVELS.indexOf(left.level) - LEVELS.indexOf(right.level) ||
					left.file.localeCompare(right.file),
			);
		for (const finding of shown) {
			lines.push(
				`  ${finding.level.toUpperCase().padEnd(5)} ${finding.file}${finding.line ? `:${finding.line}` : ""}  ${finding.message}`,
			);
		}
	}
	const total = totals(reports);
	lines.push(
		"",
		`${reports.length} workspaces: ${total.error} errors, ${total.warn} warnings, ${total.info} info${showAll ? "" : " (--all to show)"}`,
	);
	return lines.join("\n");
}

function envelope(
	tree: WorkspaceTree,
	today: Date,
	command: string,
	mode?: string,
) {
	return {
		schema: 1,
		command,
		...(mode ? { mode } : {}),
		root: tree.root.dir,
		today: dayOf(today),
	};
}

async function runCheck(
	selectors: string[],
	flags: ToolFlags,
	toolEnv: ToolEnv,
	tree: WorkspaceTree,
	config: Config,
	configs: ReadonlyMap<string, Config>,
	today: Date,
): Promise<ToolResult> {
	if (flags.status === true && flags.context === true) {
		return result(
			"shepherd: --status and --context cannot be used together",
			2,
			"stderr",
		);
	}
	const workspaces = selectWorkspaces(tree, selectors, "check");
	if (flags.context === true) {
		const rows = workspaces.map((workspace) => {
			const workspaceConfig = configs.get(workspace.dir);
			if (!workspaceConfig)
				throw new Error(`missing config for ${workspace.dir}`);
			return contextTiers(workspace, workspaceConfig);
		});
		return flags.json === true
			? result(
					JSON.stringify(
						{ ...envelope(tree, today, "check", "context"), workspaces: rows },
						null,
						2,
					),
					0,
				)
			: result(renderContextTable(rows), 0);
	}
	if (flags.status === true) {
		const report = statusReport(
			workspaces,
			tree,
			await runningSessions(toolEnv, config),
			toolEnv.home,
		);
		return flags.json === true
			? result(
					JSON.stringify(
						{
							...envelope(tree, today, "check", "status"),
							...statusJson(report),
						},
						null,
						2,
					),
					0,
				)
			: result(renderStatus(report, toolEnv.home, selectors.length === 0), 0);
	}
	const reports = findingReports(
		workspaces,
		tree,
		configs,
		today,
		toolEnv.home,
	);
	const total = totals(reports);
	return flags.json === true
		? result(
				JSON.stringify(
					{
						...envelope(tree, today, "check", "findings"),
						workspaces: reports,
						totals: total,
					},
					null,
					2,
				),
				total.error ? 1 : 0,
			)
		: result(renderFindings(reports, flags.all === true), total.error ? 1 : 0);
}

function archiveJson(plan: ReturnType<typeof planArchive>) {
	return {
		applied: plan.applied,
		workspaces: plan.workspaces.map((workspace) => ({
			name: workspace.name,
			moves: workspace.moves.map(({ kind, from, to, detail, status }) => ({
				kind,
				from,
				to,
				detail,
				status,
			})),
		})),
		rewrites: plan.rewrittenFiles,
	};
}

function runArchive(
	selectors: string[],
	flags: ToolFlags,
	toolEnv: ToolEnv,
	tree: WorkspaceTree,
	configs: ReadonlyMap<string, Config>,
	today: Date,
): ToolResult {
	const scope = flags.recursive === true ? "archive-recursive" : "archive";
	const workspaces = selectWorkspaces(tree, selectors, scope);
	const planned = planArchive(
		workspaces,
		(workspace) => {
			const config = configs.get(workspace.dir);
			if (!config) throw new Error(`missing config for ${workspace.dir}`);
			return config;
		},
		today,
	);
	const plan =
		flags.apply === true ? applyArchive(planned, tree, toolEnv.home) : planned;
	const code = archiveExitCode(plan);
	return flags.json === true
		? result(
				JSON.stringify(
					{ ...envelope(tree, today, "archive"), ...archiveJson(plan) },
					null,
					2,
				),
				code,
			)
		: result(renderArchive(plan).replaceAll(`${toolEnv.home}/`, "~/"), code);
}

/** Run a Shepherd maintenance command without launching an agent backend. */
export async function runTool(
	args: readonly string[],
	flags: ToolFlags,
	toolEnv: ToolEnv,
): Promise<ToolResult> {
	const command = args[0];
	if (!isToolCommand(command)) return usage();
	const badFlag = invalidFlag(command, flags);
	if (badFlag) return result(badFlag, 2, "stderr");
	if (command === "guide") {
		if (args.length > 2) return usage();
		const name = args[1];
		if (name === undefined) {
			return result(
				GUIDES.map((guide) => `${guide.name}: ${guide.purpose}`).join("\n"),
				0,
			);
		}
		const guide = GUIDES.find((guide) => guide.name === name);
		return guide
			? { text: guide.text, code: 0, stream: "stdout" }
			: result(
					`shepherd: no guide named "${name}"; guides: ${GUIDES.map((guide) => guide.name).join(", ")}`,
					2,
					"stderr",
				);
	}
	if (command === "init") {
		if (args.length > 1) return usage();
		const initialized = applyInit(toolEnv.cwd, {
			master: flags.master === true,
			now: toolEnv.now,
		});
		return result(
			flags.json === true
				? JSON.stringify(initJson(initialized), null, 2)
				: renderInit(initialized),
			initExitCode(initialized),
		);
	}
	const today = todayFrom(flags, toolEnv.now);
	if ("text" in today) return today;

	try {
		const tree = discoverTree(toolEnv.cwd);
		const homeWorkspace = tree.workspaces.find(
			(workspace) => workspace.dir === tree.home,
		);
		if (!homeWorkspace) throw new Error(`missing home workspace ${tree.home}`);
		const config = configForWorkspace(homeWorkspace, tree, toolEnv);
		const userProblems = splitConfigProblems(config.problems, toolEnv).user;
		if (userProblems.length > 0) {
			return result(
				userProblems.map(configProblemLine).join("\n"),
				2,
				"stderr",
			);
		}
		const configs = new Map(
			tree.workspaces.map((workspace) => [
				workspace.dir,
				workspace.dir === homeWorkspace.dir
					? config
					: configForWorkspace(workspace, tree, toolEnv),
			]),
		);
		return command === "check"
			? await runCheck(
					args.slice(1),
					flags,
					toolEnv,
					tree,
					config,
					configs,
					today,
				)
			: runArchive(args.slice(1), flags, toolEnv, tree, configs, today);
	} catch (error) {
		if (error instanceof WorkspaceTreeError) {
			return treeError(toolEnv.cwd, error);
		}
		throw error;
	}
}
