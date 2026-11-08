import { basename, join, posix, relative, resolve, sep } from "node:path";
import { callerSession } from "./caller";
import {
	type Changed,
	type Boundary as CheckpointBoundary,
	checkpointBoundary,
	classifyChanges,
	FIXED_PATHS,
	hashPaths,
	localPath,
	readCheckpoint,
} from "./checkpoint";
import {
	type Autonomy,
	autonomyUntil,
	type Config,
	loadConfig,
	splitConfigProblems,
} from "./config";
import { dayOf, localDate, localTimestamp } from "./dates";
import {
	type CurrentItem,
	type CurrentItems,
	currentItems,
	type ParseProblem,
	type StatusProjection,
	statusProjection,
	updatedName,
} from "./query-items";
import {
	changedPaths,
	readRecord,
	readRecordDir,
	recorded,
	recordPath,
} from "./query-read";
import { sessionPrefixFor } from "./session-name";
import { sessionView } from "./session-view";
import {
	type CodexIndex,
	claudeRegistry,
	codexAgents,
	codexIndex,
	type HerdrResult,
	herdrSessions,
	namedSessions,
	type RegistryResult,
	type ToolEnv,
} from "./sessions";
import { ownsDirectory } from "./status";
import {
	type ListedSession,
	listedSessions,
	STATUS_WORDS,
} from "./status-parse";
import { journalChain, journalFenceProblem } from "./text";
import { result, type ToolResult, treeError, usage } from "./tool";
import {
	discoverTree,
	enclosingWorkspace,
	isWorkspace,
	type Workspace,
	WorkspaceTreeError,
} from "./tree";
import { findChildWorkspaces, STATE_DIR } from "./workspace";

type ToolFlags = Readonly<Record<string, string | boolean>>;

export const QUERIES = [
	"items",
	"item",
	"sessions",
	"autonomy",
	"journal",
	"checkpoint",
] as const;
type QueryName = (typeof QUERIES)[number];

export type QueryProblem = {
	code: string;
	file: string;
	line?: number;
	message: string;
};

type Since = { kind: "id"; id: string } | { kind: "date"; day: string };

type QueryRequest = {
	query: QueryName;
	word?: string;
	slug?: string;
	since?: Since;
	max: number | "all";
	all: boolean;
	json: boolean;
};

type QueryContext = {
	request: QueryRequest;
	toolEnv: ToolEnv;
	config: Config;
	target: Workspace;
	observedAt: Date;
	sources?: SessionSources;
};

type Collected = {
	fields: Record<string, unknown>;
	problems: QueryProblem[];
	text: string[];
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JOURNAL_ID = /^[0-9a-f]{10}$/;
const DEFAULT_MAX = 50;

function refuse(message: string): ToolResult {
	return result(`shepherd: ${message}`, 2, "stderr");
}

function problem(
	code: string,
	file: string,
	message: string,
	line?: number,
): QueryProblem {
	return { code, file, ...(line === undefined ? {} : { line }), message };
}

function fromParse(file: string, parsed: ParseProblem): QueryProblem {
	return problem(parsed.code, file, parsed.message, parsed.line);
}

function unsafe(file: string, reason: string): QueryProblem {
	return problem("record-unsafe", file, `${file} ${reason}; refused`);
}

/** Validate the request with no filesystem call. */
function validate(
	args: readonly string[],
	flags: ToolFlags,
): QueryRequest | ToolResult {
	const [name, ...positionals] = args;
	if (!QUERIES.includes(name as QueryName)) return usage();
	const query = name as QueryName;
	for (const flag of ["since", "max"]) {
		if (query !== "journal" && flags[flag] !== undefined) {
			return refuse(`--${flag} applies only to tool query journal`);
		}
	}
	if (query === "item" && flags.all === true) {
		return refuse(
			"tool query item takes no --all; a slug names one workspace's item",
		);
	}
	const request: QueryRequest = {
		query,
		max: DEFAULT_MAX,
		all: flags.all === true,
		json: flags.json === true,
	};
	if (query === "items") {
		if (positionals.length > 1) return usage();
		const word = positionals[0];
		if (word !== undefined) {
			if (!(STATUS_WORDS as readonly string[]).includes(word)) {
				return refuse(
					`unknown status word ${word}; use one of ${STATUS_WORDS.join(", ")}`,
				);
			}
			request.word = word;
		}
	} else if (query === "item") {
		if (positionals.length !== 1) return usage();
		const slug = positionals[0] as string;
		if (!SLUG.test(slug)) return refuse(`invalid item slug: ${slug}`);
		request.slug = slug;
	} else if (positionals.length > 0) {
		return usage();
	}
	if (typeof flags.since === "string") {
		if (JOURNAL_ID.test(flags.since)) {
			request.since = { kind: "id", id: flags.since };
		} else if (!Number.isNaN(localDate(flags.since).getTime())) {
			request.since = { kind: "date", day: flags.since };
		} else {
			return refuse(
				`invalid --since: ${flags.since}; use a ten character journal id or YYYY-MM-DD`,
			);
		}
	}
	if (typeof flags.max === "string") {
		if (flags.max === "all") request.max = "all";
		else if (
			/^[1-9]\d*$/.test(flags.max) &&
			Number.isSafeInteger(Number(flags.max))
		) {
			request.max = Number(flags.max);
		} else {
			return refuse(
				`invalid --max: ${flags.max}; use a positive integer or all`,
			);
		}
	}
	return request;
}

/** The launch workspace and its root by the ancestor walk, enumerating nothing. */
function resolveWorkspace(cwd: string): { target: Workspace; root: string } {
	const home = resolve(cwd);
	if (!isWorkspace(home)) {
		throw new WorkspaceTreeError(`not a workspace: ${home}`);
	}
	let root = home;
	for (
		let enclosing = enclosingWorkspace(root);
		enclosing;
		enclosing = enclosingWorkspace(root)
	) {
		root = enclosing;
	}
	const name = relative(root, home).split(sep).join("/") || basename(root);
	return { target: { name, dir: home, state: join(home, STATE_DIR) }, root };
}

type CurrentRead = { parsed?: CurrentItems; problems: QueryProblem[] };

function readCurrent(state: string): CurrentRead {
	const read = readRecord(state, "CURRENT.md");
	if (read.status === "missing") {
		return {
			problems: [
				problem("current-missing", "CURRENT.md", "CURRENT.md is missing"),
			],
		};
	}
	if (read.status === "unsafe") {
		return { problems: [unsafe(read.file, read.reason)] };
	}
	const parsed = currentItems(read.text);
	return {
		parsed,
		problems: parsed.problems.map((parsed) => fromParse("CURRENT.md", parsed)),
	};
}

type LinkCheck =
	| { path: string; exists: boolean }
	| { unsafe: string; path: string };

function checkLink(state: string, link: string): LinkCheck {
	const path = posix.normalize(link);
	if (!localPath(path)) return { unsafe: "points outside .shepherd/", path };
	const checked = recordPath(state, path);
	if (checked.status === "unsafe") {
		return { unsafe: `${checked.file} ${checked.reason}`, path };
	}
	return { path, exists: checked.status === "ok" };
}

type ItemElement = CurrentItem & {
	status: { path: string; exists: boolean } | null;
};

/** An items element: the entry with its link checked, link-unsafe reported. */
function itemElement(
	state: string,
	item: CurrentItem,
	problems: QueryProblem[],
): ItemElement {
	let status: ItemElement["status"] = null;
	if (item.link !== null) {
		const checked = checkLink(state, item.link);
		if ("unsafe" in checked) {
			problems.push(
				problem(
					"link-unsafe",
					"CURRENT.md",
					`link ${item.link}: ${checked.unsafe}`,
					item.line,
				),
			);
		} else {
			status = checked;
		}
	}
	const { word, known, slug, link, text, raw, line, endLine } = item;
	return { word, known, slug, link, status, text, raw, line, endLine };
}

function collectItems({ request, target }: QueryContext): Collected {
	const current = readCurrent(target.state);
	const problems = [...current.problems];
	const items = (current.parsed?.items ?? [])
		.filter(({ word }) => request.word === undefined || word === request.word)
		.map((item) => itemElement(target.state, item, problems));
	const parsed = current.parsed;
	const noNext = parsed?.noNext ?? null;
	const text = items.map(
		(item) =>
			`CURRENT.md:${item.line} ${item.word}${item.slug === null ? "" : ` ${item.slug}`}  ${item.text}`,
	);
	if (noNext && !parsed?.items.some(({ word }) => word === "NEXT")) {
		text.push("no NEXT is set");
	}
	return {
		fields: {
			file: "CURRENT.md",
			updated: parsed?.updated ?? null,
			noNext,
			section: parsed?.section ?? null,
			items,
		},
		problems,
		text,
	};
}

function bucketOf(dir: string): string | null {
	return dir.match(/^work\/([^/]+)\//)?.[1] ?? null;
}

const BUCKETS = ["todo", "in-progress", "done"] as const;

function collectItem({ request, target }: QueryContext): Collected {
	const slug = request.slug as string;
	const current = readCurrent(target.state);
	const problems = [...current.problems];
	const entries = (current.parsed?.items ?? [])
		.filter((item) => item.slug === slug)
		.map((item) => itemElement(target.state, item, problems));
	const links = [
		...new Set(entries.map(({ link }) => posix.normalize(link as string))),
	];
	let resolved: "link" | "directory" | null = null;
	let dir: string | null = null;
	let candidates: string[] = [];

	if (links.length > 1) {
		candidates = links.map((link) => posix.dirname(link));
		problems.push(
			problem(
				"item-duplicate",
				"CURRENT.md",
				`${slug} links to ${candidates.length} different directories`,
			),
		);
	} else if (links.length === 1) {
		if (entries.every(({ status }) => status !== null)) {
			resolved = "link";
			dir = posix.dirname(links[0] as string);
			candidates = [dir];
		}
	} else {
		for (const bucket of BUCKETS) {
			const path = `work/${bucket}/${slug}`;
			const checked = recordPath(target.state, path, "directory");
			if (checked.status === "ok") candidates.push(path);
			else if (checked.status === "unsafe") {
				problems.push(unsafe(checked.file, checked.reason));
			}
		}
		if (candidates.length === 1) {
			resolved = "directory";
			dir = candidates[0] as string;
		} else if (candidates.length > 1) {
			problems.push(
				problem(
					"item-duplicate",
					"work",
					`${slug} exists in ${candidates.join(" and ")}`,
				),
			);
		} else if (!problems.some(({ code }) => code === "record-unsafe")) {
			problems.push(
				problem(
					"item-unknown",
					"work",
					`no item ${slug} in CURRENT.md or work/`,
				),
			);
		}
	}

	let status: (Omit<StatusProjection, "problems"> & { path: string }) | null =
		null;
	if (dir !== null) {
		const path = `${dir}/STATUS.md`;
		const read = readRecord(target.state, path);
		if (read.status === "missing") {
			problems.push(problem("status-missing", path, `${path} is missing`));
		} else if (read.status === "unsafe") {
			problems.push(unsafe(read.file, read.reason));
		} else {
			const { problems: parsed, ...projection } = statusProjection(read.text);
			problems.push(...parsed.map((entry) => fromParse(path, entry)));
			status = { path, ...projection };
		}
	}

	const text: string[] = [];
	if (status) {
		text.push(status.path);
		if (status.frontmatter?.raw) text.push(status.frontmatter.raw);
		const lines = status.raw.split("\n");
		for (const section of status.sections) {
			text.push(
				`${"#".repeat(section.level)} ${section.heading}`,
				...lines.slice(section.line, section.endLine),
			);
		}
	} else if (candidates.length > 1) {
		text.push(`candidates: ${candidates.join(", ")}`);
	}
	return {
		fields: {
			slug,
			entries,
			resolved,
			dir,
			state: dir === null ? null : bucketOf(`${dir}/`),
			candidates,
			status,
		},
		problems,
		text,
	};
}

type WorkspaceConfig =
	| { status: "ok"; config: Config | undefined }
	| { status: "refused"; problems: QueryProblem[] };

/** The workspace's own config.json, refused when symlinked or invalid. */
function workspaceConfig(toolEnv: ToolEnv, target: Workspace): WorkspaceConfig {
	const checked = recordPath(target.state, "config.json");
	if (checked.status === "unsafe") {
		return {
			status: "refused",
			problems: [unsafe(join(target.state, checked.file), checked.reason)],
		};
	}
	if (checked.status === "missing") return { status: "ok", config: undefined };
	const config = loadConfig({
		home: toolEnv.home,
		env: toolEnv.env,
		workspaceChain: [target.dir],
	});
	const invalid = splitConfigProblems(config.problems, toolEnv).workspace;
	if (invalid.length > 0) {
		return {
			status: "refused",
			problems: invalid.map((entry) =>
				problem("config-invalid", entry.file, `${entry.key}: ${entry.problem}`),
			),
		};
	}
	return { status: "ok", config };
}

type ListedEntry = ListedSession & { text: string };

type SessionSources = {
	claude: RegistryResult;
	herdr: HerdrResult;
	codex: CodexIndex | null;
};

/**
 * Each session source read once, the Codex indexes only when Herdr lists a
 * Codex agent; a caller filters one reading per workspace.
 */
async function readSessionSources(
	toolEnv: ToolEnv,
	config: Config,
): Promise<SessionSources> {
	const claude = claudeRegistry(toolEnv);
	const herdr = await herdrSessions(toolEnv);
	const codex =
		herdr.available &&
		(herdr.agents ?? []).some(({ agent }) => agent === "codex")
			? codexIndex(toolEnv, config)
			: null;
	return { claude, herdr, codex };
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function plural(count: number, word: string, many = `${word}s`): string {
	return `${count} ${count === 1 ? word : many}`;
}

function listedEntries(text: string): ListedEntry[] {
	const lines = text.split("\n");
	return listedSessions(text).map(
		({ name, line, retired, subagent, codex }) => ({
			name,
			line,
			text: (lines[line - 1] ?? "").replace(/^\s*(?:[-*]\s+)?/, ""),
			retired,
			subagent,
			codex,
		}),
	);
}

/** The sessions query for one workspace, from sources already read. */
function sessionsFrom(
	{ toolEnv, target, config }: QueryContext,
	sources: SessionSources,
): Collected {
	const problems: QueryProblem[] = [];
	let listed: ListedEntry[] = [];
	let currentText = "";
	const current = readRecord(target.state, "CURRENT.md");
	if (current.status === "missing") {
		problems.push(
			problem("current-missing", "CURRENT.md", "CURRENT.md is missing"),
		);
	} else if (current.status === "unsafe") {
		problems.push(unsafe(current.file, current.reason));
	} else {
		const fence = journalFenceProblem(current.text);
		if (fence) {
			problems.push(
				problem("fence-unclosed", "CURRENT.md", fence.reason, fence.line),
			);
		}
		listed = listedEntries(current.text);
		currentText = current.text;
	}

	const own = workspaceConfig(toolEnv, target);
	const hasChildren = findChildWorkspaces(target.dir).length > 0;
	let prefix: string | null = null;
	if (own.status === "ok") {
		prefix = sessionPrefixFor(
			target.dir,
			own.config?.sessionPrefix,
			hasChildren,
		);
	} else {
		problems.push(...own.problems);
	}

	const owned = (cwd: string | null) =>
		cwd !== null && ownsDirectory(target.dir, hasChildren, cwd);
	const listedAs = (name: string | null) => {
		const matches = listed.filter((entry) => entry.name === name);
		const entry = matches.find(({ retired }) => !retired) ?? matches[0];
		return entry ? { line: entry.line, retired: entry.retired } : null;
	};
	const prefixMatch = (name: string | null) =>
		prefix === null ? null : name?.startsWith(`${prefix}-`) === true;

	const { claude, herdr, codex } = sources;
	const byPid = claude.available
		? [...claude.sessions].sort((left, right) => left.pid - right.pid)
		: [];
	const registryNames = new Map<string, string>();
	for (const { sessionId, name } of byPid) {
		if (sessionId !== null && name !== null && !registryNames.has(sessionId)) {
			registryNames.set(sessionId, name);
		}
	}
	const registry = byPid
		.filter(({ cwd }) => owned(cwd))
		.map(({ name, sessionId, pid, file, cwd, status }) => ({
			name,
			sessionId,
			pid,
			file,
			cwd,
			status,
			listed: listedAs(name),
			prefixMatch: prefixMatch(name),
		}));
	const agents = herdr.available
		? (herdr.agents ?? []).flatMap((agent) => {
				const cwd = stringOrNull(agent.cwd);
				if (!owned(cwd)) return [];
				const kind = stringOrNull(agent.agent);
				const sessionId = stringOrNull(agent.agent_session?.value);
				const label = stringOrNull(agent.name);
				const threadName =
					kind === "codex" && sessionId !== null
						? codex?.names.get(sessionId)
						: undefined;
				const registryName =
					kind === "claude" && sessionId !== null
						? registryNames.get(sessionId)
						: undefined;
				const name =
					(kind === "claude" ? registryName : threadName) ?? label ?? null;
				return [
					{
						agent: kind,
						sessionId,
						label,
						cwd,
						status: stringOrNull(agent.agent_status),
						name,
						listed: listedAs(name),
						prefixMatch: prefixMatch(name),
					},
				];
			})
		: [];

	if (!claude.available) {
		problems.push(
			problem(
				"source-unavailable",
				join(toolEnv.home, ".claude", "sessions"),
				claude.reason,
			),
		);
	}
	if (!herdr.available) {
		problems.push(
			problem(
				"source-unavailable",
				"herdr agent list",
				`Herdr unavailable: ${herdr.reason}`,
			),
		);
	}
	if (codex) {
		for (const failure of codex.failures) {
			problems.push(
				problem(
					"source-unavailable",
					failure.home,
					`Codex index unavailable: ${failure.reason}`,
				),
			);
		}
		if (codex.homes.length === 0 && codex.failures.length === 0) {
			problems.push(
				problem(
					"source-unavailable",
					"session_index.jsonl",
					"no Codex home with a session index was found",
				),
			);
		}
	}

	const caller = callerSession(
		toolEnv,
		target,
		{
			...config,
			sessionPrefix:
				own.status === "ok" ? own.config?.sessionPrefix : config.sessionPrefix,
		},
		hasChildren,
	);
	const claudeRunning = namedSessions(claude);
	const codexRunning = codexAgents(herdr, codex?.names ?? new Map());
	const { read } = checkpointRecord(target.state);
	const drift =
		prefix === null
			? []
			: sessionView({
					listed,
					running: [
						...(claudeRunning.available ? claudeRunning.sessions : []),
						...(codexRunning.available ? codexRunning.sessions : []),
					],
					sources: { claude: claudeRunning, codex: codexRunning },
					workspace: { dir: target.dir, hasChildren, prefix },
					writer:
						read.status === "ok" ? (read.checkpoint.session ?? null) : null,
					updatedName: updatedName(currentText),
				}).drift;

	const marks = (name: string | null) => {
		const entry = listedAs(name);
		const match = prefixMatch(name);
		return `(${[
			entry === null
				? "unlisted"
				: entry.retired
					? "listed, retired"
					: "listed",
			...(match === null ? [] : [match ? "prefix" : "no prefix"]),
		].join(", ")})`;
	};
	const text = [
		`prefix: ${prefix ?? "unknown"}`,
		`caller: ${caller.name ?? "none"} (${caller.role})`,
		...listed.map((entry) => {
			const flags = (["retired", "subagent", "codex"] as const).filter(
				(flag) => entry[flag],
			);
			return `listed ${entry.name}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}  CURRENT.md:${entry.line}`;
		}),
		...registry.map(
			(entry) =>
				`claude ${entry.name ?? "(unnamed)"} pid ${entry.pid} ${entry.status ?? "?"} ${entry.cwd}  ${marks(entry.name)}`,
		),
		...agents.map(
			(agent) =>
				`herdr ${agent.agent ?? "?"} ${agent.name ?? "(unnamed)"} ${agent.status ?? "?"} ${agent.cwd}  ${marks(agent.name)}`,
		),
		claude.available
			? `claude registry: ${plural(registry.length, "session")}`
			: `claude registry: unavailable (${claude.reason})`,
		herdr.available
			? `herdr: ${plural(agents.length, "agent")}`
			: `herdr: unavailable (${herdr.reason})`,
		codex
			? `codex names: ${plural(codex.homes.length, "index", "indexes")} read${codex.failures.length > 0 ? `, ${codex.failures.length} failed` : ""}`
			: "codex names: not consulted",
		...drift.map(({ code, message }) => `drift ${code} ${message}`),
	];
	return {
		fields: {
			prefix,
			hasChildren,
			caller,
			drift,
			listed,
			claude: {
				available: claude.available,
				reason: claude.available ? null : claude.reason,
				sessions: registry,
			},
			herdr: {
				available: herdr.available,
				reason: herdr.available ? null : herdr.reason,
				agents,
			},
			codexNames: {
				consulted: codex !== null,
				homes: codex?.homes ?? [],
				failures: codex?.failures ?? [],
			},
		},
		problems,
		text,
	};
}

function collectSessions(context: QueryContext): Collected {
	if (!context.sources)
		throw new Error("sessions collected before its sources");
	return sessionsFrom(context, context.sources);
}

function collectAutonomy({
	toolEnv,
	target,
	observedAt,
}: QueryContext): Collected {
	const file = join(target.state, "config.json");
	const fields: {
		file: string;
		present: boolean | null;
		autonomy: Autonomy | null;
		active: boolean;
		expired: boolean | null;
	} = { file, present: null, autonomy: null, active: false, expired: null };
	const own = workspaceConfig(toolEnv, target);
	if (own.status === "refused") {
		const symlinked = own.problems.some(({ code }) => code === "record-unsafe");
		return {
			fields,
			problems: own.problems,
			text: [
				`autonomy: off (config.json ${symlinked ? "refused" : "is invalid"})`,
			],
		};
	}
	const { config } = own;
	const grant = config?.autonomy;
	if (!grant) {
		fields.present = false;
		return { fields, problems: [], text: ["autonomy: off (not set)"] };
	}
	const until =
		grant.until === undefined ? undefined : autonomyUntil(grant.until);
	fields.present = true;
	fields.autonomy = grant;
	if (until) {
		fields.expired =
			until.kind === "date"
				? dayOf(observedAt) > until.day
				: observedAt.getTime() >= until.time;
	}
	fields.active = grant.enabled && fields.expired !== true;
	const text = fields.active
		? `autonomy: active${grant.until === undefined ? "" : ` until ${grant.until}`} (config.json)`
		: grant.enabled
			? `autonomy: off (expired ${grant.until}, config.json)`
			: "autonomy: off (disabled in config.json)";
	return { fields, problems: [], text: [text] };
}

type Boundary =
	| CheckpointBoundary
	| { state: "none"; position: null; file: null; line: null };

/** Live covered paths, enumerating the buckets through the checked helper. */
function livePaths(state: string): {
	paths: string[];
	refused: Map<string, string>;
} {
	const paths: string[] = [...FIXED_PATHS];
	const refused = new Map<string, string>();
	for (const bucket of ["todo", "in-progress"]) {
		const listed = readRecordDir(state, `work/${bucket}`);
		if (listed.status === "unsafe") refused.set(listed.file, listed.reason);
		if (listed.status !== "ok") continue;
		for (const entry of listed.entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const path = `work/${bucket}/${entry.name}/STATUS.md`;
			if (recordPath(state, path).status !== "missing") paths.push(path);
		}
	}
	return { paths, refused };
}

type CheckpointRecord = {
	read: ReturnType<typeof readCheckpoint>;
	problems: QueryProblem[];
};

/** The checkpoint through the record check, with the problems it gives. */
function checkpointRecord(state: string): CheckpointRecord {
	const checked = recordPath(state, "checkpoint.json");
	if (checked.status === "unsafe") {
		return {
			read: { status: "invalid", reason: `${checked.file} ${checked.reason}` },
			problems: [unsafe(checked.file, checked.reason)],
		};
	}
	if (checked.status === "missing") {
		return { read: { status: "none" }, problems: [] };
	}
	const read = readCheckpoint(state);
	return {
		read,
		problems:
			read.status === "invalid"
				? [
						problem(
							"checkpoint-invalid",
							"checkpoint.json",
							`invalid checkpoint: ${read.reason}`,
						),
					]
				: [],
	};
}

type Chain = ReturnType<typeof journalChain>;

/**
 * The journal chain through journalChain, after recordPath has seen the
 * archive listing, each month and journal.md, so the pass records them.
 */
function readChain(state: string): Chain {
	const archive = readRecordDir(state, "archive/journal");
	if (archive.status === "ok") {
		for (const { name } of archive.entries) {
			if (/^\d{4}-\d{2}\.md$/.test(name)) {
				recordPath(state, `archive/journal/${name}`);
			}
		}
	}
	recordPath(state, "journal.md");
	return journalChain(state);
}

function chainProblems(chain: Chain): QueryProblem[] {
	return chain.unreadable.map((entry) =>
		problem(
			"journal-unreadable",
			entry.file,
			`${entry.file} ${entry.reason}`,
			entry.line,
		),
	);
}

function collectCheckpoint({ target }: QueryContext): Collected {
	const { read, problems } = checkpointRecord(target.state);
	const checkpoint = read.status === "ok" ? read.checkpoint : undefined;
	let boundary: Boundary = {
		state: "none",
		position: null,
		file: null,
		line: null,
	};
	let chain: Chain | undefined;
	let entriesSince: number | null = null;
	let changed: Changed[] | null = null;
	let compared: number | null = null;
	if (checkpoint) {
		chain = readChain(target.state);
		problems.push(...chainProblems(chain));
		const { entries } = chain;
		boundary = checkpointBoundary(entries, checkpoint.journal);
		if (boundary.position !== null && chain.unreadable.length === 0) {
			entriesSince = entries
				.slice(boundary.position)
				.filter(({ day }) => day !== undefined).length;
		}

		const live = livePaths(target.state);
		const hashed = [
			...new Set([...Object.keys(checkpoint.files), ...live.paths]),
		];
		for (const path of hashed) recordPath(target.state, path);
		const hashes = hashPaths(target, hashed);
		for (const [path, reason] of live.refused)
			hashes[path] = `unsafe:${reason}`;
		compared = Object.keys(hashes).length;
		changed = classifyChanges(checkpoint.files, hashes);
	}

	const text = [
		read.status === "none"
			? "no checkpoint"
			: read.status === "invalid"
				? `invalid checkpoint: ${read.reason}`
				: `revision ${read.checkpoint.revision} by ${read.checkpoint.session ?? "unknown"} at ${read.checkpoint.written}`,
		boundary.state === "found"
			? `boundary: found at ${boundary.file}:${boundary.line}`
			: `boundary: ${boundary.state}`,
	];
	if (changed) {
		text.push(
			`entries since: ${entriesSince ?? "unknown"}; compared: ${compared}; changed: ${changed.length}`,
			...changed.map(
				({ path, kind, reason }) =>
					`  ${kind} ${path}${reason === undefined ? "" : ` (${reason})`}`,
			),
		);
	}
	return {
		fields: {
			status: read.status,
			reason: read.status === "invalid" ? read.reason : null,
			revision: checkpoint?.revision ?? null,
			written: checkpoint?.written ?? null,
			session: checkpoint?.session ?? null,
			snapshot: checkpoint?.snapshot ?? null,
			journal: checkpoint
				? {
						from: checkpoint.journal.from,
						to: checkpoint.journal.to,
						count: checkpoint.journal.count,
					}
				: null,
			chain: chain
				? { files: chain.files, unreadable: chain.unreadable }
				: null,
			boundary,
			entriesSince,
			compared,
			changed,
		},
		problems,
		text,
	};
}

type SinceField = {
	kind:
		| "checkpoint"
		| "checkpoint-null"
		| "checkpoint-invalid"
		| "none"
		| "id"
		| "date";
	id: string | null;
	day: string | null;
	found: boolean | null;
	file: string | null;
	line: number | null;
};

function since(
	kind: SinceField["kind"],
	fields: Partial<Omit<SinceField, "kind">> = {},
): SinceField {
	return {
		kind,
		id: null,
		day: null,
		found: null,
		file: null,
		line: null,
		...fields,
	};
}

function at({ file, line }: { file: string; line: number }): string {
	return `${file}:${line}`;
}

function sinceLine({ kind, id, day, found }: SinceField): string {
	if (kind === "checkpoint") {
		return found
			? `[since checkpoint ${id}]`
			: `[checkpoint cursor ${id} lost; newest entries]`;
	}
	if (kind === "checkpoint-null") {
		return "[since the start; the checkpoint certifies no entries]";
	}
	if (kind === "checkpoint-invalid") {
		return "[checkpoint invalid; newest entries]";
	}
	if (kind === "none") return "[no checkpoint; newest entries]";
	if (kind === "id") return found ? `[since ${id}]` : `[cursor ${id} lost]`;
	return `[since ${day}]`;
}

function collectJournal({ request, target }: QueryContext): Collected {
	const problems: QueryProblem[] = [];
	const chain = readChain(target.state);
	const { entries } = chain;
	const missing =
		!chain.files.includes("journal.md") &&
		!chain.unreadable.some(({ file }) => file === "journal.md");
	if (missing) {
		problems.push(
			problem("journal-missing", "journal.md", "journal.md is missing"),
		);
	}
	problems.push(...chainProblems(chain));

	let cursor: SinceField;
	let matched = entries;
	const cursorLost = (file: string, message: string) =>
		problems.push(problem("cursor-lost", file, message));
	if (request.since?.kind === "id") {
		const { id } = request.since;
		const index = entries.findIndex((entry) => entry.id === id);
		const entry = entries[index];
		if (entry) {
			cursor = since("id", {
				id,
				found: true,
				file: entry.file,
				line: entry.line,
			});
			matched = entries.slice(index + 1);
		} else {
			cursor = since("id", { id, found: false });
			matched = [];
			cursorLost("journal.md", `journal id ${id} is not in the chain`);
		}
	} else if (request.since?.kind === "date") {
		const { day } = request.since;
		cursor = since("date", { day });
		matched = entries.filter(
			(entry) => entry.day !== undefined && entry.day >= day,
		);
	} else {
		const record = checkpointRecord(target.state);
		problems.push(...record.problems);
		if (record.read.status === "none") cursor = since("none");
		else if (record.read.status === "invalid") {
			cursor = since("checkpoint-invalid");
		} else {
			const { journal } = record.read.checkpoint;
			const boundary = checkpointBoundary(entries, journal);
			if (boundary.state === "null") cursor = since("checkpoint-null");
			else if (boundary.state === "found") {
				cursor = since("checkpoint", {
					id: journal.to,
					found: true,
					file: boundary.file,
					line: boundary.line,
				});
				matched = entries.slice(boundary.position ?? 0);
			} else {
				cursor = since("checkpoint", { id: journal.to, found: false });
				cursorLost(
					"checkpoint.json",
					`the checkpoint's journal cursors ${journal.from} to ${journal.to} are not in the chain in order`,
				);
			}
		}
	}

	const kept = request.max === "all" ? matched : matched.slice(-request.max);
	const omitted = matched.slice(0, matched.length - kept.length);
	const first = omitted[0];
	const last = omitted.at(-1);
	const truncated =
		first && last
			? { omitted: omitted.length, from: at(first), to: at(last) }
			: null;

	const text = [
		sinceLine(cursor),
		...kept.map((entry) => `${at(entry)} ${entry.id} ${entry.text}`),
	];
	if (kept.length === 0) text.push("no entries");
	if (truncated) {
		text.push(
			`${truncated.omitted} older ${truncated.omitted === 1 ? "entry" : "entries"} omitted: ${truncated.from} to ${truncated.to}`,
		);
	}
	return {
		fields: {
			journal: {
				status: missing ? "missing" : entries.length === 0 ? "empty" : "ok",
			},
			since: cursor,
			files: chain.files,
			unreadable: chain.unreadable,
			entries: kept.map(({ id, file, line, day, time, text }) => ({
				id,
				file,
				line,
				day: day ?? null,
				time: time ?? null,
				text,
			})),
			count: chain.unreadable.length === 0 ? matched.length : null,
			truncated,
		},
		problems,
		text,
	};
}

const COLLECTORS: Record<QueryName, (context: QueryContext) => Collected> = {
	items: collectItems,
	item: collectItem,
	sessions: collectSessions,
	autonomy: collectAutonomy,
	journal: collectJournal,
	checkpoint: collectCheckpoint,
};

function unique(problems: QueryProblem[]): QueryProblem[] {
	const seen = new Set<string>();
	return problems.filter((entry) => {
		const key = JSON.stringify(entry);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function exitCode(problems: readonly QueryProblem[]): number {
	return problems.some(
		({ code }) => code !== "source-unavailable" && code !== "entry-off-shape",
	)
		? 1
		: 0;
}

function problemLine(entry: QueryProblem, workspace?: string): string {
	return `shepherd: ${workspace === undefined ? "" : `${workspace}: `}${entry.file}${entry.line === undefined ? "" : `:${entry.line}`}: ${entry.message}`;
}

type Answer = Collected & { retried: boolean };

/**
 * Collect, then compare every recorded path; on a difference collect once
 * more, and report what changed again as collection-unstable.
 */
function collectStable(
	collect: (context: QueryContext) => Collected,
	context: QueryContext,
): Answer {
	const first = recorded(() => collect(context));
	if (changedPaths(first.marks).length === 0) {
		return { ...first.value, retried: false };
	}
	const second = recorded(() => collect(context));
	return {
		...second.value,
		problems: [
			...second.value.problems,
			...changedPaths(second.marks).map((path) =>
				problem(
					"collection-unstable",
					path,
					`${path} changed during collection, twice`,
				),
			),
		],
		retried: true,
	};
}

function observedNow(toolEnv: ToolEnv): Date {
	return new Date(Math.floor(toolEnv.clock().getTime() / 1000) * 1000);
}

function workspaceFields({ name, dir, state }: Workspace) {
	return { name, dir, state };
}

/** Answer one read-only query about the launch workspace, or the tree. */
export async function runQuery(
	args: readonly string[],
	flags: ToolFlags,
	toolEnv: ToolEnv,
): Promise<ToolResult> {
	const request = validate(args, flags);
	if ("code" in request) return request;

	const config = loadConfig({
		home: toolEnv.home,
		env: toolEnv.env,
		workspaceChain: [],
	});
	const userProblems = splitConfigProblems(config.problems, toolEnv).user;
	if (userProblems.length > 0) {
		return result(
			userProblems
				.map(
					(entry) => `shepherd: ${entry.file}: ${entry.key}: ${entry.problem}`,
				)
				.join("\n"),
			2,
			"stderr",
		);
	}

	let targets: Workspace[];
	let root: string;
	try {
		const resolved = resolveWorkspace(toolEnv.cwd);
		root = resolved.root;
		targets = [resolved.target];
		if (request.all) {
			if (root !== resolved.target.dir) {
				return refuse(
					`--all is allowed only from the root workspace; this one sits under ${root}`,
				);
			}
			targets = discoverTree(toolEnv.cwd).workspaces;
		}
	} catch (error) {
		if (error instanceof WorkspaceTreeError)
			return treeError(toolEnv.cwd, error);
		throw error;
	}
	const collect = COLLECTORS[request.query];

	const sourcesAt =
		request.query === "sessions" ? observedNow(toolEnv) : undefined;
	const sources = sourcesAt
		? await readSessionSources(toolEnv, config)
		: undefined;
	const answers = targets.map((target) => {
		const observedAt = sourcesAt ?? observedNow(toolEnv);
		const answer = collectStable(collect, {
			request,
			toolEnv,
			config,
			target,
			observedAt,
			sources,
		});
		const problems = unique(answer.problems);
		return {
			target,
			observed: localTimestamp(observedAt),
			answer: { ...answer, problems },
			code: exitCode(problems),
		};
	});
	const code = Math.max(...answers.map((entry) => entry.code));

	if (request.json) {
		const results = answers.map(({ target, observed, answer }) => ({
			workspace: workspaceFields(target),
			observed,
			retried: answer.retried,
			problems: answer.problems,
			...answer.fields,
		}));
		const head = { schema: 1, command: "query", query: request.query, root };
		const [only] = results;
		let json: Record<string, unknown> = {
			...head,
			scope: "all",
			workspaces: results,
		};
		if (!request.all && only) {
			const { workspace, observed, retried, ...rest } = only;
			json = {
				...head,
				observed,
				retried,
				scope: "workspace",
				workspace,
				...rest,
			};
		}
		return result(JSON.stringify(json, null, 2), code);
	}

	const notices = answers.flatMap(({ target, answer }) =>
		answer.problems.map((entry) =>
			problemLine(entry, request.all ? target.name : undefined),
		),
	);
	const text = request.all
		? answers
				.map(({ target, answer }) =>
					[
						target.name,
						...answer.text.flatMap((line) =>
							line.split("\n").map((part) => `  ${part}`),
						),
					].join("\n"),
				)
				.join("\n\n")
		: (answers[0]?.answer.text ?? []).join("\n");
	return {
		...result(text, code),
		...(notices.length > 0 ? { notice: notices.join("\n") } : {}),
	};
}
