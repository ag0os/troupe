import { lstatSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import {
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
} from "./query-items";
import { readRecord, readRecordDir, recordPath } from "./query-read";
import type { ToolEnv } from "./sessions";
import { STATUS_WORDS } from "./status-parse";
import { journalChain } from "./text";
import { type ToolResult, treeError, usage } from "./tool";
import { enclosingWorkspace, type Workspace, WorkspaceTreeError } from "./tree";
import { STATE_DIR } from "./workspace";

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
	json: boolean;
};

type QueryContext = {
	request: QueryRequest;
	toolEnv: ToolEnv;
	config: Config;
	target: Workspace;
	observedAt: Date;
};

type Collected = {
	fields: Record<string, unknown>;
	problems: QueryProblem[];
	text: string[];
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JOURNAL_ID = /^[0-9a-f]{10}$/;
const DEFAULT_MAX = 50;

function output(
	text: string,
	code: number,
	stream: "stdout" | "stderr" = "stdout",
): ToolResult {
	return { text: text.endsWith("\n") ? text : `${text}\n`, code, stream };
}

function refuse(message: string): ToolResult {
	return output(`shepherd: ${message}`, 2, "stderr");
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
	const request: QueryRequest = {
		query,
		max: DEFAULT_MAX,
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

function isStateDir(dir: string): boolean {
	try {
		return lstatSync(join(dir, STATE_DIR)).isDirectory();
	} catch {
		return false;
	}
}

/** The launch workspace and its root by the ancestor walk, enumerating nothing. */
function resolveWorkspace(cwd: string): { target: Workspace; root: string } {
	const home = resolve(cwd);
	if (!isStateDir(home)) {
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

function collectItems({ request, target }: QueryContext): Collected {
	const current = readCurrent(target.state);
	const problems = [...current.problems];
	const items = (current.parsed?.items ?? [])
		.filter(({ word }) => request.word === undefined || word === request.word)
		.map((item) => {
			let status: { path: string; exists: boolean } | null = null;
			if (item.link !== null) {
				const checked = checkLink(target.state, item.link);
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
		});
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
	const entries: CurrentItem[] = (current.parsed?.items ?? []).filter(
		(item) => item.slug === slug,
	);
	const links = [...new Set(entries.map(({ link }) => link as string))];
	let resolved: "link" | "directory" | null = null;
	let dir: string | null = null;
	let candidates: string[] = [];

	if (links.length > 1) {
		candidates = links.map((link) => posix.dirname(posix.normalize(link)));
		problems.push(
			problem(
				"item-duplicate",
				"CURRENT.md",
				`${slug} links to ${candidates.length} different directories`,
			),
		);
	} else if (links.length === 1) {
		const checked = checkLink(target.state, links[0] as string);
		if ("unsafe" in checked) {
			problems.push(
				problem(
					"link-unsafe",
					"CURRENT.md",
					`link ${links[0]}: ${checked.unsafe}`,
					entries[0]?.line,
				),
			);
		} else {
			resolved = "link";
			dir = posix.dirname(checked.path);
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
		for (const section of status.sections) {
			text.push(`${"#".repeat(section.level)} ${section.heading}`);
			if (section.text) text.push(section.text);
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
	const checked = recordPath(target.state, "config.json");
	if (checked.status === "unsafe") {
		return {
			fields,
			problems: [unsafe(join(target.state, checked.file), checked.reason)],
			text: ["autonomy: off (config.json refused)"],
		};
	}
	const config =
		checked.status === "ok"
			? loadConfig({
					home: toolEnv.home,
					env: toolEnv.env,
					workspaceChain: [target.dir],
				})
			: undefined;
	const invalid = config
		? splitConfigProblems(config.problems, toolEnv).workspace
		: [];
	if (invalid.length > 0) {
		return {
			fields,
			problems: invalid.map((entry) =>
				problem("config-invalid", entry.file, `${entry.key}: ${entry.problem}`),
			),
			text: ["autonomy: off (config.json is invalid)"],
		};
	}
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

type Boundary = {
	state: "found" | "lost" | "null" | "none";
	position: number | null;
	file: string | null;
	line: number | null;
};

type Changed = {
	path: string;
	kind: "changed" | "appeared" | "removed" | "unsafe";
	reason?: string;
};

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

function collectCheckpoint({ target }: QueryContext): Collected {
	const problems: QueryProblem[] = [];
	const checked = recordPath(target.state, "checkpoint.json");
	let read: ReturnType<typeof readCheckpoint>;
	if (checked.status === "unsafe") {
		read = { status: "invalid", reason: `${checked.file} ${checked.reason}` };
		problems.push(unsafe(checked.file, checked.reason));
	} else if (checked.status === "missing") {
		read = { status: "none" };
	} else {
		read = readCheckpoint(target.state);
		if (read.status === "invalid") {
			problems.push(
				problem(
					"checkpoint-invalid",
					"checkpoint.json",
					`invalid checkpoint: ${read.reason}`,
				),
			);
		}
	}
	const checkpoint = read.status === "ok" ? read.checkpoint : undefined;
	let boundary: Boundary = {
		state: "none",
		position: null,
		file: null,
		line: null,
	};
	let chain: ReturnType<typeof journalChain> | undefined;
	let entriesSince: number | null = null;
	let changed: Changed[] | null = null;
	let compared: number | null = null;
	if (checkpoint) {
		chain = journalChain(target.state);
		for (const entry of chain.unreadable) {
			problems.push(
				problem(
					"journal-unreadable",
					entry.file,
					`${entry.file} ${entry.reason}`,
					entry.line,
				),
			);
		}
		const { entries } = chain;
		const { from, to } = checkpoint.journal;
		const fromIndex = entries.findIndex(({ id }) => id === from);
		const toIndex = entries.findIndex(({ id }) => id === to);
		const certified = entries[toIndex];
		if (from === null && to === null) {
			boundary = { state: "null", position: 0, file: null, line: null };
		} else if (
			from !== null &&
			fromIndex >= 0 &&
			certified &&
			toIndex >= fromIndex
		) {
			boundary = {
				state: "found",
				position: toIndex + 1,
				file: certified.file,
				line: certified.line,
			};
		} else {
			boundary = { state: "lost", position: null, file: null, line: null };
		}
		if (boundary.position !== null && chain.unreadable.length === 0) {
			entriesSince = entries
				.slice(boundary.position)
				.filter(({ day }) => day !== undefined).length;
		}

		const live = livePaths(target.state);
		const hashed = [
			...new Set([...Object.keys(checkpoint.files), ...live.paths]),
		];
		const hashes = hashPaths(target, hashed);
		const paths = [...new Set([...hashed, ...live.refused.keys()])].sort();
		compared = paths.length;
		changed = paths.flatMap((path): Changed[] => {
			const refused = live.refused.get(path);
			if (refused !== undefined) {
				return [{ path, kind: "unsafe", reason: refused }];
			}
			const before = checkpoint.files[path] ?? null;
			const after = hashes[path] ?? null;
			if (after?.startsWith("unsafe:")) {
				return [
					{ path, kind: "unsafe", reason: after.slice("unsafe:".length) },
				];
			}
			if (before === after) return [];
			return [
				{
					path,
					kind:
						after === null
							? "removed"
							: before === null
								? "appeared"
								: "changed",
				},
			];
		});
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

const COLLECTORS: Partial<
	Record<QueryName, (context: QueryContext) => Collected | Promise<Collected>>
> = {
	items: collectItems,
	item: collectItem,
	autonomy: collectAutonomy,
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
	return problems.some(({ code }) => code !== "source-unavailable") ? 1 : 0;
}

function problemLine(entry: QueryProblem): string {
	return `shepherd: ${entry.file}${entry.line === undefined ? "" : `:${entry.line}`}: ${entry.message}`;
}

/** Answer one read-only query about the launch workspace. */
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
		return output(
			userProblems
				.map(
					(entry) => `shepherd: ${entry.file}: ${entry.key}: ${entry.problem}`,
				)
				.join("\n"),
			2,
			"stderr",
		);
	}

	let resolved: { target: Workspace; root: string };
	try {
		resolved = resolveWorkspace(toolEnv.cwd);
	} catch (error) {
		if (error instanceof WorkspaceTreeError)
			return treeError(toolEnv.cwd, error);
		throw error;
	}
	const collect = COLLECTORS[request.query];
	if (!collect) return usage();

	const { target, root } = resolved;
	const clock = toolEnv.clock().getTime();
	const observedAt = new Date(Math.floor(clock / 1000) * 1000);
	const observed = localTimestamp(observedAt);
	const collected = await collect({
		request,
		toolEnv,
		config,
		target,
		observedAt,
	});
	const problems = unique(collected.problems);
	const code = exitCode(problems);
	if (request.json) {
		return output(
			JSON.stringify(
				{
					schema: 1,
					command: "query",
					query: request.query,
					root,
					observed,
					retried: false,
					scope: "workspace",
					workspace: {
						name: target.name,
						dir: target.dir,
						state: target.state,
					},
					problems,
					...collected.fields,
				},
				null,
				2,
			),
			code,
		);
	}
	return {
		...output(collected.text.join("\n"), code),
		...(problems.length > 0
			? { notice: problems.map(problemLine).join("\n") }
			: {}),
	};
}
