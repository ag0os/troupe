import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { frontmatter } from "./text";
import type { Workspace } from "./tree";
import { findEnclosingWorkspace, STATE_DIR } from "./workspace";

export type ItemState =
	| "live"
	| "done"
	| "done-no-outcome"
	| "archived"
	| "missing";
export type DroppedInput = {
	current: string;
	baseline: string;
	items: Record<string, ItemState>;
	destinations: Record<string, string>;
};
export type Disposition =
	| { kind: "accounted"; path: string }
	| { kind: "exempt"; reason: string }
	| { kind: "unaccounted" };
type Nearest = { path: string; line: number; percent: number };
export type DroppedCandidate = {
	line: number;
	text: string;
	normalized: string;
	disposition: Disposition;
	nearest?: Nearest;
};
export type DroppedResult = {
	candidates: DroppedCandidate[];
	accounted: { line: number; text: string; foundIn: string }[];
	unaccounted: { line: number; text: string; nearest?: Nearest }[];
};

function normalize(line: string): string {
	return line
		.trim()
		.replace(/\s+/g, " ")
		.replace(/^(?:[-*+]|\d+\.)\s+/, "")
		.replace(/\*\*/g, "")
		.toLowerCase();
}

function fencedLines(text: string): { text: string; fenced: boolean }[] {
	let fence: string | undefined;
	return text.split("\n").map((text) => {
		const marker = text.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
		const wasFenced = fence !== undefined;
		if (marker?.[1] !== undefined) {
			if (fence === undefined) fence = marker[1];
			else if (
				marker[1][0] === fence[0] &&
				marker[1].length >= fence.length &&
				!marker[2]?.trim()
			)
				fence = undefined;
		}
		return { text, fenced: wasFenced || fence !== undefined };
	});
}

function itemEntries(text: string): { lines: number[]; slug: string }[] {
	const entries: { lines: number[]; slug: string }[] = [];
	const lines = fencedLines(text);
	let inItems = false;
	for (let index = 0; index < lines.length; index++) {
		const { text: line, fenced } = lines[index] ?? { text: "", fenced: false };
		if (fenced) continue;
		if (/^## /.test(line)) inItems = /^## Items\s*$/.test(line);
		if (!inItems || !/^[-*+]\s+/.test(line)) continue;
		const entryLines = [index];
		while (/^[ \t]/.test(lines[index + 1]?.text ?? ""))
			entryLines.push(++index);
		const entry = entryLines.map((n) => lines[n]?.text).join("\n");
		for (const match of entry.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const target = match[1] ?? "";
			if (!target.endsWith("STATUS.md")) continue;
			entries.push({ lines: entryLines, slug: basename(dirname(target)) });
			break;
		}
	}
	return entries;
}

const stopwords = new Set(
	"the this that with from before after when then into also have been were their about which what does your do not no is to of and a an in on it at".split(
		" ",
	),
);

function contentWords(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
			(word) => !stopwords.has(word),
		),
	);
}

/** Compare a certified CURRENT with frozen current text and destinations. */
export function droppedLines(input: DroppedInput): DroppedResult {
	const result: DroppedResult = {
		candidates: [],
		accounted: [],
		unaccounted: [],
	};
	const current = new Set(input.current.split("\n").map(normalize));
	const exemptions = new Map<number, string>();
	for (const entry of itemEntries(input.baseline)) {
		const state = input.items[entry.slug];
		if (state === "live" || state === "done" || state === "archived") {
			for (const line of entry.lines)
				exemptions.set(line, `item ${state} ${entry.slug}`);
		}
	}
	const destinations = Object.keys(input.destinations)
		.sort()
		.flatMap((path) =>
			(input.destinations[path] ?? "").split("\n").map((text, index) => ({
				path,
				line: index + 1,
				normalized: normalize(text),
				words: contentWords(text),
			})),
		);
	let liveSessions = false;
	fencedLines(input.baseline).forEach(({ text, fenced }, index) => {
		if (!fenced && /^## /.test(text))
			liveSessions = /^## Live sessions\s*$/.test(text);
		const normalized = normalize(text);
		if (
			liveSessions ||
			(!fenced && /^ {0,3}#{1,6}(?:\s|$)/.test(text)) ||
			(!fenced && /^Updated:/.test(text)) ||
			!/\p{L}/u.test(text) ||
			current.has(normalized)
		)
			return;
		const line = index + 1;
		const reason = exemptions.get(index);
		const found = destinations.find(
			(destination) =>
				destination.path !== "journal.md" &&
				destination.normalized === normalized,
		);
		const disposition: Disposition = reason
			? { kind: "exempt", reason }
			: found
				? { kind: "accounted", path: found.path }
				: { kind: "unaccounted" };
		const candidate: DroppedCandidate = { line, text, normalized, disposition };
		result.candidates.push(candidate);
		if (disposition.kind === "accounted") {
			result.accounted.push({ line, text, foundIn: disposition.path });
		} else if (disposition.kind === "unaccounted") {
			const words = contentWords(text);
			let best = 0;
			for (const destination of destinations) {
				const shared = [...words].filter((word) =>
					destination.words.has(word),
				).length;
				if (shared <= best) continue;
				best = shared;
				candidate.nearest = {
					path: destination.path,
					line: destination.line,
					percent: Math.floor((shared / words.size) * 100),
				};
			}
			result.unaccounted.push(
				candidate.nearest
					? { line, text, nearest: candidate.nearest }
					: { line, text },
			);
		}
	});
	return result;
}

/** Hash candidate normalization and explicit dispositions in baseline order. */
export function droppedDigest(result: DroppedResult): string {
	const lines = result.candidates.map(({ normalized, disposition }) => {
		const value =
			disposition.kind === "accounted"
				? `accounted:${disposition.path}`
				: disposition.kind === "exempt"
					? `exempt:${disposition.reason}`
					: "unaccounted";
		return `${normalized}\t${value}`;
	});
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** SHA256 of the supplied bytes or UTF8 text, with its algorithm prefix. */
export function contentHash(content: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function markdownFiles(dir: string, recursive: boolean): string[] {
	if (!isDirectory(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.flatMap((entry) => {
				const path = join(dir, entry.name);
				if (recursive && entry.isDirectory()) return markdownFiles(path, true);
				return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
			})
			.sort();
	} catch {
		return [];
	}
}

function itemState(state: string, slug: string): ItemState {
	if (
		["todo", "in-progress"].some((bucket) =>
			isDirectory(join(state, "work", bucket, slug)),
		)
	)
		return "live";
	const done = join(state, "work/done", slug);
	if (isDirectory(done)) {
		try {
			const status = join(done, "STATUS.md");
			if (!lstatSync(status).isFile()) return "done-no-outcome";
			const text = readFileSync(status, "utf8");
			const body = text.replace(/^---\n[\s\S]*?\n---/, "");
			return frontmatter(text)?.state === "done" &&
				fencedLines(body).some(
					({ text, fenced }) => !fenced && /^## Outcome[ \t]*\r?$/.test(text),
				)
				? "done"
				: "done-no-outcome";
		} catch {
			return "done-no-outcome";
		}
	}
	const archive = join(state, "archive");
	if (
		isDirectory(archive) &&
		readdirSync(archive).some(
			(bucket) =>
				isDirectory(join(archive, bucket)) &&
				isDirectory(join(archive, bucket, slug)),
		)
	)
		return "archived";
	return "missing";
}

/** Read item states and the live preservation and suggestion destinations. */
export function readDroppedSources(
	workspace: Workspace,
	baseline: string,
): {
	items: DroppedInput["items"];
	destinations: DroppedInput["destinations"];
} {
	const items: DroppedInput["items"] = {};
	for (const { slug } of itemEntries(baseline))
		try {
			items[slug] = itemState(workspace.state, slug);
		} catch {
			items[slug] = "missing";
		}
	const destinations: DroppedInput["destinations"] = {};
	const paths = markdownFiles(join(workspace.state, "docs"), true);
	for (const dir of ["memories", "integrations", "outbox"])
		paths.push(...markdownFiles(join(workspace.state, dir), false));
	for (const bucket of ["todo", "in-progress"])
		paths.push(
			...markdownFiles(join(workspace.state, "work", bucket), true).filter(
				(path) => basename(path) === "STATUS.md",
			),
		);
	for (const file of ["pending.md", "charter.md", "journal.md"]) {
		const path = join(workspace.state, file);
		try {
			if (lstatSync(path).isFile()) paths.push(path);
		} catch {}
	}
	for (const path of paths.sort()) {
		try {
			if (lstatSync(path).isFile())
				destinations[relative(workspace.state, path).split(sep).join("/")] =
					readFileSync(path, "utf8");
		} catch {}
	}
	const enclosing = findEnclosingWorkspace(workspace.dir);
	if (enclosing) {
		for (const path of markdownFiles(
			join(enclosing, STATE_DIR, "shared"),
			false,
		)) {
			try {
				if (lstatSync(path).isFile())
					destinations[`enclosing:shared/${basename(path)}`] = readFileSync(
						path,
						"utf8",
					);
			} catch {}
		}
	}
	return { items, destinations };
}

/** Read only a regular certified snapshot beneath checkpoints. */
export function readBaseline(
	state: string,
	snapshot: string,
	expected: string | null,
):
	| { status: "none" }
	| { status: "ok"; text: string; hash: string }
	| { status: "lost"; reason: string } {
	if (expected === null) return { status: "none" };
	const lost = {
		status: "lost",
		reason: "snapshot missing or does not match",
	} as const;
	const path = resolve(state, snapshot);
	const inside = relative(resolve(state), path);
	if (isAbsolute(snapshot) || !inside.startsWith(`checkpoints${sep}`))
		return lost;
	try {
		let component = resolve(state);
		for (const part of inside.split(sep)) {
			component = join(component, part);
			if (lstatSync(component).isSymbolicLink()) return lost;
		}
		if (!lstatSync(path).isFile()) return lost;
		const bytes = readFileSync(path);
		const hash = contentHash(bytes);
		return hash === expected
			? { status: "ok", text: bytes.toString("utf8"), hash }
			: lost;
	} catch {
		return lost;
	}
}
