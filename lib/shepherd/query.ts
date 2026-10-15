import { lstatSync } from "node:fs";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { localPath } from "./checkpoint";
import { type Config, loadConfig, splitConfigProblems } from "./config";
import { localDate, localTimestamp } from "./dates";
import {
	type CurrentItem,
	type CurrentItems,
	currentItems,
	type ParseProblem,
	type StatusProjection,
	statusProjection,
} from "./query-items";
import { readRecord, recordPath } from "./query-read";
import type { ToolEnv } from "./sessions";
import { STATUS_WORDS } from "./status-parse";
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

const COLLECTORS: Partial<
	Record<QueryName, (context: QueryContext) => Collected | Promise<Collected>>
> = {
	items: collectItems,
	item: collectItem,
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
	const observed = localTimestamp(toolEnv.clock());
	const collected = await collect({ request, toolEnv, config, target });
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
