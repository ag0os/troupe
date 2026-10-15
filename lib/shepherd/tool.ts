import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	applyArchive,
	archiveExitCode,
	planArchive,
	renderArchive,
} from "./archive";
import { checkWorkspace, type Finding, type FindingLevel } from "./check";
import { runCheckpoint } from "./checkpoint-command";
import {
	type Config,
	type ConfigProblem,
	loadConfig,
	splitConfigProblems,
} from "./config";
import { contextTiers, renderContextTable } from "./context";
import { dayOf, localDate } from "./dates";
import { doctorExitCode, doctorJson, renderDoctor, runDoctor } from "./doctor";
import { GUIDES } from "./guides";
import { applyInit, initExitCode, initJson, renderInit } from "./init";
import { runJournal } from "./journal";
import {
	LockError,
	type LockOptions,
	LockReleaseError,
	unlockState,
	withStateLocks,
} from "./lock";
import { runQuery } from "./query";
import { runningSessions, type ToolEnv } from "./sessions";
import { runStart } from "./start";
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
	notice?: string;
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
	"shepherd tool doctor [--json]",
	"shepherd tool start      [--budget <words>] [--json]",
	"shepherd tool journal    (<text> | --stdin) [--json]",
	"shepherd tool checkpoint [--apply --token <token>] [--session <name>] [--accept-dropped <reason>] [--json]",
	"shepherd tool unlock     [--json]",
	"shepherd tool query items [NEXT|SCHEDULED|WAITING|ASK|CANDIDATE] [--all] [--json]",
	"shepherd tool query item <slug> [--json]",
	"shepherd tool query sessions [--all] [--json]",
	"shepherd tool query autonomy [--all] [--json]",
	"shepherd tool query journal [--since <id|YYYY-MM-DD>] [--max <n|all>] [--all] [--json]",
	"shepherd tool query checkpoint [--all] [--json]",
].join("\n");

const CHECK_FLAGS = new Set(["all", "status", "context", "json", "today"]);
const ARCHIVE_FLAGS = new Set(["recursive", "apply", "json", "today"]);
const DOCTOR_FLAGS = new Set(["json"]);
const INIT_FLAGS = new Set(["master", "json"]);
const COMMAND_FLAGS = {
	check: CHECK_FLAGS,
	archive: ARCHIVE_FLAGS,
	guide: new Set<string>(),
	init: INIT_FLAGS,
	doctor: DOCTOR_FLAGS,
	start: new Set(["budget", "json"]),
	journal: new Set(["stdin", "json"]),
	checkpoint: new Set(["apply", "token", "session", "accept-dropped", "json"]),
	unlock: new Set(["json"]),
	query: new Set(["json", "since", "max", "all"]),
};
type ToolCommand = keyof typeof COMMAND_FLAGS;
const FLAG_OWNERS: Record<string, string> = {
	all: "tool check and tool query",
	status: "tool check",
	context: "tool check",
	master: "tool init",
	json: "tool check, tool archive, tool init, tool doctor, tool start, tool journal, tool checkpoint, tool unlock and tool query",
	today: "tool check and tool archive",
	apply: "tool archive and tool checkpoint",
	recursive: "tool archive",
	budget: "tool start",
	stdin: "tool journal",
	token: "tool checkpoint",
	session: "tool checkpoint",
	"accept-dropped": "tool checkpoint",
	since: "tool query journal",
	max: "tool query journal",
};
const LEVELS: FindingLevel[] = ["error", "warn", "info"];

/** Whether a positional names a Shepherd maintenance command. */
export function isToolCommand(
	command: string | undefined,
): command is ToolCommand {
	return command !== undefined && Object.hasOwn(COMMAND_FLAGS, command);
}

export function result(
	text: string,
	code: number,
	stream: "stdout" | "stderr" = "stdout",
): ToolResult {
	return { text: text.endsWith("\n") ? text : `${text}\n`, code, stream };
}

export function usage(): ToolResult {
	return result(USAGE, 2, "stderr");
}

function flagName(name: string): string {
	return name === "name" ? "--name" : `--${name}`;
}

function invalidFlag(
	command: ToolCommand,
	flags: ToolFlags,
): string | undefined {
	const allowed = COMMAND_FLAGS[command];
	for (const [name, value] of Object.entries(flags)) {
		if (value === false || value === undefined || allowed.has(name)) continue;
		if (name === "name") return "shepherd: --name applies only to launches";
		const owner = FLAG_OWNERS[name];
		if (owner) return `shepherd: ${flagName(name)} applies only to ${owner}`;
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

export function treeError(cwd: string, error: unknown): ToolResult {
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
	toolEnv: ToolEnv,
) {
	return workspaces.map((workspace) => {
		const config = configs.get(workspace.dir);
		if (!config) throw new Error(`missing config for ${workspace.dir}`);
		const findings = checkWorkspace(
			workspace,
			tree,
			config,
			today,
			home,
			toolEnv,
		);
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
			return contextTiers(workspace, workspaceConfig, undefined, toolEnv);
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
		toolEnv,
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

export function archiveJson(plan: ReturnType<typeof planArchive>) {
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
		skippedRewrites: plan.skippedRewrites ?? [],
	};
}

async function runArchive(
	selectors: string[],
	flags: ToolFlags,
	toolEnv: ToolEnv,
	tree: WorkspaceTree,
	configs: ReadonlyMap<string, Config>,
	today: Date,
	lockOptions: LockOptions = {},
): Promise<ToolResult> {
	const scope = flags.recursive === true ? "archive-recursive" : "archive";
	const workspaces = selectWorkspaces(tree, selectors, scope);
	const plan = () =>
		planArchive(
			workspaces,
			(workspace) => {
				const config = configs.get(workspace.dir);
				if (!config) throw new Error(`missing config for ${workspace.dir}`);
				return config;
			},
			today,
		);
	let planned: ReturnType<typeof planArchive>;
	let releaseError: LockReleaseError | undefined;
	try {
		planned =
			flags.apply === true
				? await withStateLocks(
						[tree.root.state, ...tree.workspaces.map(({ state }) => state)],
						toolEnv,
						() => applyArchive(plan(), tree, toolEnv.home),
						lockOptions,
					)
				: plan();
	} catch (error) {
		if (error instanceof LockError) {
			const workspace = tree.workspaces.find(
				({ state }) => state === error.state,
			);
			return result(
				`${workspace?.name ?? error.state}: ${error.message}`,
				1,
				"stderr",
			);
		}
		if (!(error instanceof LockReleaseError)) throw error;
		planned = error.result as ReturnType<typeof planArchive>;
		releaseError = error;
	}
	const code = releaseError ? 1 : archiveExitCode(planned);
	const text =
		flags.json === true
			? JSON.stringify(
					{
						...envelope(tree, today, "archive"),
						...archiveJson(planned),
						...(releaseError ? { releaseError: releaseError.message } : {}),
					},
					null,
					2,
				)
			: renderArchive(planned).replaceAll(`${toolEnv.home}/`, "~/");
	return result(
		releaseError && flags.json !== true
			? `${text}\n${releaseError.message}`
			: text,
		code,
	);
}

/** Run a Shepherd maintenance command without launching an agent backend. */
export async function runTool(
	args: readonly string[],
	flags: ToolFlags,
	toolEnv: ToolEnv,
	archiveLockOptions: LockOptions = {},
	readStdin: () => Promise<string> = () => Bun.stdin.text(),
): Promise<ToolResult> {
	const command = args[0];
	if (!isToolCommand(command)) return usage();
	const badFlag = invalidFlag(command, flags);
	if (badFlag) return result(badFlag, 2, "stderr");
	if (command === "query") return runQuery(args.slice(1), flags, toolEnv);
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
	if (command === "doctor") {
		if (args.length > 1) return usage();
		const diagnosed = runDoctor(toolEnv);
		return result(
			flags.json === true
				? JSON.stringify(doctorJson(diagnosed), null, 2)
				: renderDoctor(diagnosed),
			doctorExitCode(diagnosed),
		);
	}
	if (command === "journal") {
		if (flags.stdin === true ? args.length !== 1 : args.length !== 2)
			return usage();
	} else if (
		["start", "checkpoint", "unlock"].includes(command) &&
		args.length > 1
	) {
		return usage();
	}
	if (
		command === "start" &&
		flags.budget !== undefined &&
		(typeof flags.budget !== "string" ||
			!/^\d+$/.test(flags.budget) ||
			!Number.isSafeInteger(Number(flags.budget)))
	) {
		return result(
			"shepherd: --budget must be a non-negative integer",
			2,
			"stderr",
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
		if (command === "journal") {
			const journal = await runJournal(
				homeWorkspace.state,
				flags.stdin === true ? await readStdin() : (args[1] ?? ""),
				toolEnv,
				flags.json === true,
				{ lock: archiveLockOptions },
			);
			return {
				...journal,
				...result(journal.text, journal.code, journal.stream),
			};
		}
		if (command === "checkpoint") {
			const checkpoint = await runCheckpoint(
				homeWorkspace,
				toolEnv,
				{
					apply: flags.apply === true,
					token: typeof flags.token === "string" ? flags.token : undefined,
					session:
						typeof flags.session === "string" ? flags.session : undefined,
					acceptDropped:
						typeof flags["accept-dropped"] === "string"
							? flags["accept-dropped"]
							: undefined,
					json: flags.json === true,
				},
				{ lock: archiveLockOptions },
			);
			return result(checkpoint.text, checkpoint.code, checkpoint.stream);
		}
		if (command === "unlock") {
			const unlocked = await unlockState(
				homeWorkspace.state,
				toolEnv,
				archiveLockOptions,
			);
			const { outcome, pid, code } = unlocked;
			return result(
				flags.json === true
					? JSON.stringify({
							outcome,
							...(pid === undefined ? {} : { pid }),
							code,
						})
					: unlocked.text,
				code,
			);
		}
		const config = configForWorkspace(homeWorkspace, tree, toolEnv);
		const userProblems = splitConfigProblems(config.problems, toolEnv).user;
		if (userProblems.length > 0) {
			return result(
				userProblems.map(configProblemLine).join("\n"),
				2,
				"stderr",
			);
		}
		if (command === "start") {
			const started = runStart(homeWorkspace, tree, toolEnv, config, {
				budget:
					typeof flags.budget === "string" ? Number(flags.budget) : undefined,
				json: flags.json === true,
				today,
			});
			return result(started.text, started.code);
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
			: await runArchive(
					args.slice(1),
					flags,
					toolEnv,
					tree,
					configs,
					today,
					archiveLockOptions,
				);
	} catch (error) {
		if (error instanceof WorkspaceTreeError) {
			return treeError(toolEnv.cwd, error);
		}
		throw error;
	}
}
