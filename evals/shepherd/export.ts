/**
 * Export one attempt's scratch artifacts into the committed evidence tree
 * (spec 6.1, R2). Every text file is redacted first, within its lines and to
 * a fixpoint, so no line is added or removed and evidence line numbers hold:
 * - the home directory, the repository root and other host paths outside
 *   the run's scratch root become an explicit marker, whole path token by
 *   token, including tokens written with JSON `\uXXXX` escapes;
 * - the home path's slug spelling becomes a marker everywhere, kept scratch
 *   paths included, and the account name where a long listing shows it;
 * - email addresses become markers numbered per address within the attempt;
 * - in the native log, every attachment off a short allow list, and every
 *   CLI-injected `isMeta` message, keeps its shape with its strings and keys
 *   as markers, so each line stays valid JSON; the prompt under test stays;
 * - in the run manifest, settings env values and plugin names.
 * Only recognisable host paths are touched: sed addresses, prose and base64
 * snapshot records keep their bytes. The mechanical checks and the scorer
 * packet then read the exported bytes, the same bytes CI recomputes from,
 * and artifact hashes are of those bytes.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Artifact } from "./schema";

export const REDACTED = "/[redacted]";
/** The home path's directory-name spelling, as in a Claude Code scratchpad. */
export const SLUG_MARKER = "[redacted-home]";
/** Numbered per distinct address within an attempt, so distinct names stay distinct. */
export const emailMarker = (n: number) => `[redacted-email-${n}]`;
export const ACCOUNT_MARKER = "[redacted-account]";
export const ENVIRONMENT_MARKER = "[redacted-environment]";
export const ENV_MARKER = "[redacted-env-value]";
/** What stands for every `PATH` entry outside the scratch root. */
export const PATH_MARKER = "[redacted-path]";

/** Top-level directories whose absolute paths describe the host. */
const HOST = [
	"/Users/",
	"/home/",
	"/root/",
	"/opt/",
	"/private/",
	"/var/",
	"/tmp/",
	"/Volumes/",
	"/mnt/",
	"/Applications/",
];
// A path character: ASCII path punctuation, any letter or digit, or a JSON
// `\uXXXX` escape, so a non-ASCII name written by Python's `ensure_ascii`
// stays one path token. The slug marker continues a token too, so a host
// path holding the home slug is still redacted whole.
const CHAR = String.raw`(?:[\p{L}\p{M}\p{N}._@%+=~-]|\\u[0-9a-fA-F]{4}|\[redacted-home\])`;
// A separator: a slash after any run of backslashes, as a tool that escapes
// slashes prints it (`\/`) and as each JSON layer around that output stores
// it (`\\/`, ...).
const SLASH = String.raw`\\*\/`;
// A leading separator starts its whole backslash run, never inside it, so
// matching stays linear in the run's length.
const RUN_START = String.raw`(?<!\\)`;
const TOKEN = new RegExp(`^(?:${CHAR}|${SLASH})`, "u");
// After a prefix, a path continues on any of these.
const CONTINUES = /^(?:[\p{L}\p{M}\p{N}._-]|\\u[0-9a-fA-F]{4})/u;
// A JSON escape directly before a token: `\n`, `\t`, `\b`, `\f` and the like,
// or a `\uXXXX` escape. The token starts after it, never at its letter.
const AFTER_ESCAPE = String.raw`(?<=\\[nrtbf"])|(?<=\\u[0-9a-fA-F]{4})`;

// An absolute path starts after a non-path character, or right after a JSON
// escape, so paths inside encoded strings are found too.
const PATH = new RegExp(
	`(?:(?<![A-Za-z0-9._~/@%+=-])|${AFTER_ESCAPE})${RUN_START}${SLASH}${CHAR}+(?:${SLASH}${CHAR}*)*`,
	"gu",
);
const EMAIL = new RegExp(
	String.raw`(?<!\\)(?:(?<![A-Za-z0-9._%+-])|${AFTER_ESCAPE})[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])`,
	"g",
);
const BASE64_RECORD = /"encoding":\s*"base64",\s*"content":\s*"[^"]*"/g;

function plain(path: string): string {
	return path.replace(/^\/private(?=\/(tmp|var)(\/|$))/, "");
}

/** The spelling Python's `json.dumps` gives a string with `ensure_ascii`. */
export function asciiEscaped(text: string): string {
	// Python escapes each UTF-16 code unit, so a surrogate pair is two escapes.
	return text.replace(/[^\p{ASCII}]/gu, (c) =>
		Array.from(
			{ length: c.length },
			(_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`,
		).join(""),
	);
}

export interface RedactionContext {
	/** The run's scratch directory; paths beneath it are provenance. */
	scratchRoot: string;
	/** Redacted wherever it appears, even before a space, and as a slug. */
	home: string;
	repoRoot?: string;
	/** Email marker numbers by address, shared by one attempt's artifacts. */
	emails?: Map<string, number>;
}

type Span = [number, number];

/**
 * Occurrences of `prefix`, each slash also matched after any run of
 * backslashes, that end at a path boundary, extended over the rest of the
 * path token.
 */
function occurrences(text: string, prefix: string): Span[] {
	const spans: Span[] = [];
	if (!prefix || prefix === "/") return spans;
	const pattern = new RegExp(
		RUN_START +
			prefix
				.split("/")
				.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join(SLASH),
		"g",
	);
	for (const found of text.matchAll(pattern)) {
		const at = found.index;
		let end = at + found[0].length;
		if (CONTINUES.test(text.slice(end, end + 6))) continue;
		// The longest token piece is the slug marker.
		for (
			let match = TOKEN.exec(text.slice(end, end + SLUG_MARKER.length));
			match;
			match = TOKEN.exec(text.slice(end, end + SLUG_MARKER.length))
		)
			end += match[0].length;
		spans.push([at, end]);
	}
	return spans;
}

const overlaps = (spans: Span[], [a, b]: Span) =>
	spans.some(([c, d]) => a < d && c < b);

/**
 * Spellings of a path: as given and as `ensure_ascii` JSON writes it.
 * `occurrences` also matches each with its slashes escaped at any depth.
 */
const spelled = (path: string) => [...new Set([path, asciiEscaped(path)])];

/**
 * The home path as a directory name: the Claude Code project slug turns
 * slashes, or every character outside ASCII letters and digits, into dashes.
 */
export function homeSlugs(home: string): string[] {
	const trimmed = home.replace(/\/$/, "");
	if (!trimmed) return [];
	return [
		...new Set(
			[
				trimmed.replaceAll("/", "-"),
				trimmed.replace(/[^A-Za-z0-9]/g, "-"),
			].flatMap(spelled),
		),
	];
}

const ENDS_NAME = /^(?:[\p{L}\p{M}\p{N}]|\\u[0-9a-fA-F]{4})/u;

/** Replace each whole occurrence of a home slug with the slug marker. */
function unslugged(
	text: string,
	home: string,
): { text: string; count: number } {
	let count = 0;
	for (const slug of homeSlugs(home)) {
		let out = "";
		let at = 0;
		for (
			let found = text.indexOf(slug);
			found >= 0;
			found = text.indexOf(slug, found + slug.length)
		) {
			const end = found + slug.length;
			if (ENDS_NAME.test(text.slice(end, end + 6))) continue;
			out += `${text.slice(at, found)}${SLUG_MARKER}`;
			at = end;
			count++;
		}
		text = out + text.slice(at);
	}
	return { text, count };
}

/**
 * The account name where a long listing shows a file's owner or group: after
 * the mode, the link count, and for the group the owner. A bare word
 * elsewhere is left alone; it may be ordinary text.
 */
function listingOwners(text: string, home: string): Span[] {
	const account = home.replace(/\/$/, "").split("/").at(-1) ?? "";
	if (account.length < 2) return [];
	const spans: Span[] = [];
	for (const name of spelled(account)) {
		const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const owner = new RegExp(
			String.raw`(?<=[-dlcbps][rwxsStT-]{9}[@+.]?[ \t]+\d+[ \t]+(?:\S+[ \t]+)?)${quoted}(?=[ \t])`,
			"g",
		);
		for (const match of text.matchAll(owner))
			spans.push([match.index, match.index + match[0].length]);
	}
	return spans;
}

function redactOnce(
	input: string,
	context: RedactionContext & { emails: Map<string, number> },
): { text: string; count: number } {
	// The slug goes first, everywhere, kept scratch paths included; the
	// scratch root is matched in its slug-redacted spelling.
	const slugged = unslugged(input, context.home);
	const text = slugged.text;
	const root = unslugged(context.scratchRoot, context.home).text.replace(
		/\/$/,
		"",
	);
	const spellings = new Set(
		[root, plain(root), `/private${plain(root)}`].flatMap(spelled),
	);
	const kept: Span[] = [...text.matchAll(BASE64_RECORD)].map((m) => [
		m.index,
		m.index + m[0].length,
	]);
	for (const spelling of spellings) kept.push(...occurrences(text, spelling));
	const redacted: [number, number, string][] = [];
	const spans = (): Span[] => redacted.map(([a, b]) => [a, b]);
	for (const prefix of [context.home, context.repoRoot ?? ""]) {
		for (const spelling of spelled(prefix.replace(/\/$/, ""))) {
			for (const span of occurrences(text, spelling)) {
				if (!overlaps(kept, span) && !overlaps(spans(), span))
					redacted.push([...span, REDACTED]);
			}
		}
	}
	for (const match of text.matchAll(PATH)) {
		const span: Span = [match.index, match.index + match[0].length];
		if (overlaps(kept, span) || overlaps(spans(), span)) continue;
		const path = match[0].replace(/\\+\//g, "/");
		if (HOST.some((prefix) => `${path}/`.startsWith(prefix)))
			redacted.push([...span, REDACTED]);
	}
	// The account name as the owner or group of a long listing (`ls -l`).
	for (const owner of listingOwners(text, context.home)) {
		if (!overlaps(spans(), owner)) redacted.push([...owner, ACCOUNT_MARKER]);
	}
	// An address is personal data even inside a kept scratch path.
	for (const match of text.matchAll(EMAIL)) {
		const span: Span = [match.index, match.index + match[0].length];
		if (overlaps(spans(), span)) continue;
		let n = context.emails.get(match[0]);
		if (n === undefined) {
			n = context.emails.size + 1;
			context.emails.set(match[0], n);
		}
		redacted.push([...span, emailMarker(n)]);
	}
	redacted.sort((x, y) => x[0] - y[0]);
	let out = "";
	let at = 0;
	for (const [start, end, marker] of redacted) {
		out += `${text.slice(at, start)}${marker}`;
		at = end;
	}
	return {
		text: out + text.slice(at),
		count: slugged.count + redacted.length,
	};
}

/**
 * Redact to a fixpoint: a replacement can expose a path start (an address
 * right before `/tmp/...`), and the packet, redacted again, must show the
 * archived line.
 */
export function redactText(
	text: string,
	context: RedactionContext,
): { text: string; count: number } {
	const scoped = { ...context, emails: context.emails ?? new Map() };
	let count = 0;
	for (let pass = 0; pass < 10; pass++) {
		const next = redactOnce(text, scoped);
		if (next.text === text) break;
		text = next.text;
		count += next.count;
	}
	return { text, count };
}

interface JsonString {
	start: number;
	end: number;
	value: string;
	key: boolean;
	/** Keys and indexes from the document's root to this string. */
	path: (string | number)[];
}

/** Every string token of one JSON document, or none if it does not parse. */
function jsonStrings(text: string): JsonString[] {
	try {
		JSON.parse(text);
	} catch {
		return [];
	}
	const found: JsonString[] = [];
	const stack: { at: string | number; object: boolean; key: boolean }[] = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const top = stack.at(-1);
		if (c === "{" || c === "[")
			stack.push({ at: c === "{" ? "" : 0, object: c === "{", key: c === "{" });
		else if (c === "}" || c === "]") stack.pop();
		else if (c === "," && top) {
			if (top.object) top.key = true;
			else top.at = Number(top.at) + 1;
		} else if (c === ":" && top) top.key = false;
		else if (c === '"') {
			let end = i + 1;
			while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			end++;
			const value: string = JSON.parse(text.slice(i, end));
			const key = top?.object === true && top.key;
			if (key && top) top.at = value;
			found.push({ start: i, end, value, key, path: stack.map((f) => f.at) });
			i = end - 1;
		}
	}
	return found;
}

/** Replace string tokens in place; markers never hold a quote or a newline. */
function replaceStrings(
	text: string,
	marker: (token: JsonString) => string | undefined,
): { text: string; count: number } {
	let out = "";
	let at = 0;
	let count = 0;
	for (const token of jsonStrings(text)) {
		const replacement = marker(token);
		if (replacement === undefined) continue;
		out += `${text.slice(at, token.start)}${JSON.stringify(replacement)}`;
		at = token.end;
		count++;
	}
	return { text: out + text.slice(at), count };
}

/**
 * Native log attachments that carry the session's own inputs, which the
 * rubric can need (the date it was told, a nudge it answered). Every other
 * attachment, a type a later CLI adds included, describes the user's
 * environment or the CLI's bookkeeping and is redacted: fail closed.
 */
export const SESSION_ATTACHMENTS = ["date", "silent_turn_reminder"];
/** The prompt under test, appended last to the system prompt by Shepherd. */
const PROMPT_UNDER_TEST = /^# Shepherd\n/;

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * One native log line. An attachment off the allow list keeps its `type`,
 * its field names and the entry's own fields (uuid, timestamps); every other
 * string and every key below its fields becomes a marker. A CLI-injected
 * `isMeta` user message keeps its role and block types only.
 */
function redactLogLine(line: string): { text: string; count: number } {
	let entry: {
		type?: unknown;
		isMeta?: unknown;
		attachment?: { type?: unknown; systemPrompt?: unknown };
	};
	try {
		entry = JSON.parse(line);
	} catch {
		return { text: line, count: 0 };
	}
	if (entry?.type === "user" && entry.isMeta === true)
		return replaceStrings(line, ({ key, path }) =>
			!key &&
			path[0] === "message" &&
			path[1] === "content" &&
			path.at(-1) !== "type"
				? ENVIRONMENT_MARKER
				: undefined,
		);
	if (entry?.type !== "attachment") return { text: line, count: 0 };
	const kind = entry.attachment?.type;
	if (SESSION_ATTACHMENTS.some((k) => k === kind))
		return { text: line, count: 0 };
	const prompt = entry.attachment?.systemPrompt;
	const last =
		kind === "prompt_snapshot" && Array.isArray(prompt)
			? prompt.length - 1
			: -1;
	let keys = 0;
	return replaceStrings(line, ({ key, path, value }) => {
		if (path[0] === "rendered") return key ? undefined : ENVIRONMENT_MARKER;
		if (path[0] !== "attachment" || path.length < 2) return undefined;
		if (key) return path.length > 2 ? `[redacted-key-${++keys}]` : undefined;
		if (path.length === 2 && path[1] === "type") return undefined;
		if (last >= 0 && path[1] === "systemPrompt" && path.length === 3)
			return path[2] === last && PROMPT_UNDER_TEST.test(value)
				? undefined
				: `[redacted-system-prompt sha256:${hex(value)}]`;
		return ENVIRONMENT_MARKER;
	});
}

/**
 * The run manifest's `PATH` copies, which keep only their scratch entries,
 * and its settings copies (already without string values, from the
 * harness): env values, and plugin and marketplace names, which are keys.
 */
function redactRunManifest(
	text: string,
	context: RedactionContext,
): { text: string; count: number } {
	// Both sides are compared slug-redacted, as text redaction compares them:
	// a recovered attempt's scratch root was recorded with the slug redacted.
	const base = unslugged(context.scratchRoot, context.home).text.replace(
		/\/$/,
		"",
	);
	const spellings = [base, plain(base), `/private${plain(base)}`];
	const scratch = (entry: string) => {
		const spelled = unslugged(entry, context.home).text;
		return spellings.some((s) => spelled === s || spelled.startsWith(`${s}/`));
	};
	const numbered = new Map<string, number>();
	return replaceStrings(text, ({ key, path, value }) => {
		const [root, file, settings, field] = path;
		if (
			!key &&
			path.length === 1 &&
			(root === "PATH" || root === "resume_PATH")
		) {
			const entries = value.split(":");
			const kept = entries.filter(scratch);
			return kept.length === entries.length
				? undefined
				: [...kept, PATH_MARKER].join(":");
		}
		if (root !== "backend_settings" || settings !== "settings")
			return undefined;
		if (path.length !== 5) return undefined;
		if (field === "env" && !key) return ENV_MARKER;
		const name =
			field === "enabledPlugins"
				? "plugin"
				: field === "extraKnownMarketplaces"
					? "marketplace"
					: undefined;
		if (!key || !name) return undefined;
		const scope = `${String(file)} ${name}`;
		const n = (numbered.get(scope) ?? 0) + 1;
		numbered.set(scope, n);
		return `[redacted-${name}-${n}]`;
	});
}

/** The structural redaction an artifact gets before its text redaction. */
function redactStructure(
	name: string,
	text: string,
	context: RedactionContext,
): { text: string; count: number } {
	if (name.endsWith(".jsonl")) {
		const lines = text.split("\n").map(redactLogLine);
		return {
			text: lines.map((line) => line.text).join("\n"),
			count: lines.reduce((sum, line) => sum + line.count, 0),
		};
	}
	if (name.endsWith("-run.json")) return redactRunManifest(text, context);
	return { text, count: 0 };
}

const TYPES: [RegExp, string][] = [
	[/\.jsonl$/, "native-log"],
	[/-run\.json$/, "run-manifest"],
	[/-(baseline|final)\.json$/, "snapshot"],
	[/-diff\.patch$/, "diff"],
	[/-stdout\.txt$/, "final-answer"],
	[/-stderr\.txt$/, "stderr"],
	[/-fixture-notes\.md$/, "fixture-notes"],
	[/-start\.json$/, "start"],
	[/^must-check\.json$/, "mechanical-checks"],
	[/^packet\.md$/, "scorer-packet"],
	[/^scorer-.*\.json$/, "scorer-output"],
	[/\.md$/, "transcript"],
];

export function artifactType(name: string): string {
	return TYPES.find(([pattern]) => pattern.test(name))?.[1] ?? "file";
}

function decode(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** Write one file into an exported attempt, redacted, and describe it. */
export function writeArtifact(
	dir: string,
	name: string,
	content: string | Uint8Array,
	context: RedactionContext,
): Artifact {
	const bytes =
		typeof content === "string" ? new TextEncoder().encode(content) : content;
	const text = decode(bytes);
	const structured =
		text === undefined ? undefined : redactStructure(name, text, context);
	const paths = structured && redactText(structured.text, context);
	const redacted = structured &&
		paths && { text: paths.text, count: structured.count + paths.count };
	const out =
		redacted === undefined ? bytes : new TextEncoder().encode(redacted.text);
	writeFileSync(join(dir, name), out, { flag: "wx" });
	return {
		path: name,
		sha256: createHash("sha256").update(out).digest("hex"),
		bytes: out.byteLength,
		type: artifactType(name),
		redactions: redacted?.count ?? 0,
	};
}

/**
 * Copy every regular file of `from` into the new directory `to`, redacted.
 * Refuses an existing destination so archived evidence is never replaced.
 */
export function exportAttempt(
	options: { from: string; to: string } & RedactionContext,
): Artifact[] {
	if (existsSync(options.to)) {
		throw new Error(`Exported attempt already exists: ${options.to}`);
	}
	// Copy into a temporary sibling and rename it into place when complete, so
	// an interrupted export never looks like a finished one.
	const temp = `${options.to}.tmp-${process.pid}-${Date.now()}`;
	mkdirSync(temp, { recursive: true });
	// One numbering of addresses across the attempt's artifacts.
	const context = { ...options, emails: options.emails ?? new Map() };
	const artifacts = readdirSync(options.from)
		.filter((name) => statSync(join(options.from, name)).isFile())
		.sort()
		.map((name) =>
			writeArtifact(
				temp,
				name,
				readFileSync(join(options.from, name)),
				context,
			),
		);
	renameSync(temp, options.to);
	return artifacts;
}

/**
 * Move an earlier, unrecorded export of `to` and any temporary siblings out
 * of the way, renamed `.partial`, so the attempt can be exported again.
 */
export function setAsidePartial(to: string): string[] {
	const parent = dirname(to);
	const name = basename(to);
	if (!existsSync(parent)) return [];
	const leftovers = readdirSync(parent)
		.filter((entry) => entry === name || entry.startsWith(`${name}.tmp-`))
		.sort((a, b) => (a === name ? -1 : b === name ? 1 : a < b ? -1 : 1));
	const moved: string[] = [];
	for (const entry of leftovers) {
		let target = join(parent, `${name}.partial`);
		for (let n = 2; existsSync(target); n++)
			target = join(parent, `${name}.partial-${n}`);
		renameSync(join(parent, entry), target);
		moved.push(target);
	}
	return moved;
}
