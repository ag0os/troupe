/**
 * Export one attempt's scratch artifacts into the committed evidence tree
 * (spec 6.1, R2). Every text file is redacted first: the home directory,
 * the repository root and other host paths outside the run's scratch root
 * become an explicit marker, whole path token by token, within their lines,
 * so no line is added or removed and evidence line numbers still hold. Only
 * recognisable host paths are touched: sed addresses, prose and base64
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
const TOKEN = /[A-Za-z0-9._@%+=~/-]/;

// An absolute path starts after a non-path character, or right after a JSON
// escape such as `\n`, so paths inside encoded strings are found too.
const PATH =
	/(?:(?<![A-Za-z0-9._~/@%+=-])|(?<=\\[nrt"]))\/[A-Za-z0-9._@%+=~-]+(?:\/[A-Za-z0-9._@%+=~-]*)*/g;
const BASE64_RECORD = /"encoding":\s*"base64",\s*"content":\s*"[^"]*"/g;

function plain(path: string): string {
	return path.replace(/^\/private(?=\/(tmp|var)(\/|$))/, "");
}

export interface RedactionContext {
	/** The run's scratch directory; paths beneath it are provenance. */
	scratchRoot: string;
	/** Redacted wherever it appears, even before a space. */
	home: string;
	repoRoot?: string;
}

type Span = [number, number];

/** Occurrences of `prefix` that end at a path boundary, extended over the rest of the path token. */
function occurrences(text: string, prefix: string): Span[] {
	const spans: Span[] = [];
	if (!prefix || prefix === "/") return spans;
	for (
		let at = text.indexOf(prefix);
		at >= 0;
		at = text.indexOf(prefix, at + 1)
	) {
		let end = at + prefix.length;
		if (end < text.length && /[A-Za-z0-9._-]/.test(text[end] ?? "")) continue;
		while (end < text.length && TOKEN.test(text[end] ?? "")) end++;
		spans.push([at, end]);
	}
	return spans;
}

const overlaps = (spans: Span[], [a, b]: Span) =>
	spans.some(([c, d]) => a < d && c < b);

export function redactText(
	text: string,
	context: RedactionContext,
): { text: string; count: number } {
	const root = context.scratchRoot.replace(/\/$/, "");
	const spellings = new Set([root, plain(root), `/private${plain(root)}`]);
	const kept: Span[] = [...text.matchAll(BASE64_RECORD)].map((m) => [
		m.index,
		m.index + m[0].length,
	]);
	for (const spelling of spellings) kept.push(...occurrences(text, spelling));
	const redacted: Span[] = [];
	for (const prefix of [context.home, context.repoRoot ?? ""]) {
		for (const span of occurrences(text, prefix.replace(/\/$/, ""))) {
			if (!overlaps(kept, span) && !overlaps(redacted, span))
				redacted.push(span);
		}
	}
	for (const match of text.matchAll(PATH)) {
		const span: Span = [match.index, match.index + match[0].length];
		if (overlaps(kept, span) || overlaps(redacted, span)) continue;
		if (HOST.some((prefix) => `${match[0]}/`.startsWith(prefix)))
			redacted.push(span);
	}
	redacted.sort((x, y) => x[0] - y[0]);
	let out = "";
	let at = 0;
	for (const [start, end] of redacted) {
		out += `${text.slice(at, start)}${REDACTED}`;
		at = end;
	}
	return { text: out + text.slice(at), count: redacted.length };
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
	const redacted = text === undefined ? undefined : redactText(text, context);
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
	const artifacts = readdirSync(options.from)
		.filter((name) => statSync(join(options.from, name)).isFile())
		.sort()
		.map((name) =>
			writeArtifact(
				temp,
				name,
				readFileSync(join(options.from, name)),
				options,
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
