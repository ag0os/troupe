import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Finding, FindingLevel } from "./check";
import { decodedLinkTarget } from "./check-links";
import type { Config } from "./config";
import { daysBetween, localDate, monthOf } from "./dates";
import {
	type ModuleCatalog,
	moduleCatalog,
	resolveModules,
} from "./module-resolution";
import {
	closedDate,
	frontmatter,
	journalChain,
	journalDuplicateHeadings,
	journalMisorderedHeadings,
	journalOrphans,
	journalSections,
	journalTimeSlips,
	proseLines,
	read,
} from "./text";
import type { Workspace } from "./tree";

const STATES = ["todo", "in-progress", "done"] as const;

function linkTargets(file: string): Set<string> {
	const targets = new Set<string>();
	for (const { line } of proseLines(read(file))) {
		for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
			const target = decodedLinkTarget(match[1]?.split("#")[0] ?? "");
			if (target && !/^[a-z]+:/i.test(target)) {
				targets.add(resolve(dirname(file), target));
			}
		}
	}
	return targets;
}

/** What an item's STATUS and measurement notes say about its pull requests. */
export type ItemRecord = {
	prs: number[];
	shas: string[];
	repo?: string;
	done: boolean;
	/** STATUS's `## Outcome` section, when it has one. */
	outcome?: string;
};

/** Where a landing was found, so a later source (gh) can stand in for the files. */
export type Landed = { by: string; pr?: number; sha?: string; date?: string };
export type LandedSource = (record: ItemRecord) => Landed | undefined;

const NOTE_NAME = /^(?:[tT]\d+-)?measurements\.md$/;
const PR_TOKEN = /\b(?:PR|pull\s+request|as)\s*#(\d+)\b/gi;
const MERGE_SHA =
	/\b(?:merged|merge\s+commit|main\s+at)(?:\s+(?:as|at|in))?[\s:(`]+([0-9a-f]{7,40})\b/gi;
const SHA = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const DASHES = String.fromCodePoint(0x2013, 0x2014);
const STATUS_LABEL = new RegExp(`\\bstatus\\b[\\s*_]*[:${DASHES}](.*)`, "i");
const NOT_LANDED_LABELLED =
	/\b(?:not landed|parked|blocked|abandoned|not pushed|no merge commit or pr yet)\b/i;
const NOT_LANDED_HEAD =
	/\b(?:not landed|not pushed|no merge commit or pr yet)\b/i;

function mergeShas(text: string): string[] {
	return [...text.matchAll(MERGE_SHA)]
		.map((match) => match[1]?.toLowerCase() ?? "")
		.filter((sha) => /\d/.test(sha));
}

/** A note's first 40 lines, and its head: those before the first `##` heading. */
function noteHead(text: string): { lines: string[]; head: string[] } {
	const lines = proseLines(text)
		.filter(({ n }) => n <= 40)
		.map(({ line }) => line);
	const section = lines.findIndex((line) => /^##\s/.test(line));
	return { lines, head: section < 0 ? lines : lines.slice(0, section) };
}

/** Read an item's PR numbers, merge SHAs and repo from its STATUS and notes. */
export function itemRecord(
	status: string | undefined,
	notes: string[],
): ItemRecord {
	const prose = [status ?? "", ...notes].map((text) =>
		proseLines(text)
			.map(({ line }) => line)
			.join("\n"),
	);
	const prs = new Set<number>();
	const shas = new Set<string>();
	for (const text of prose) {
		for (const match of text.matchAll(PR_TOKEN)) prs.add(Number(match[1]));
		for (const sha of mergeShas(text)) shas.add(sha);
	}
	const repo =
		notes
			.flatMap((note) => noteHead(note).head)
			.map(
				(line) => line.match(/^[\s>*_-]*repo[\s*_]*:[\s*_]*`?([^`\s]+)/i)?.[1],
			)
			.find(Boolean) ??
		status?.match(/github\.com\/([\w.-]+\/[\w-]+(?:\.[\w-]+)*)/)?.[1];
	const lines = status?.split(/\r?\n/) ?? [];
	const start = lines.findIndex((line) => /^##\s+Outcome\b/.test(line));
	const end = lines.findIndex((line, n) => n > start && /^#{1,2}\s/.test(line));
	const outcome =
		start < 0
			? undefined
			: lines
					.slice(start + 1, end < 0 ? undefined : end)
					.join("\n")
					.trim();
	return {
		prs: [...prs],
		shas: [...shas],
		...(repo ? { repo } : {}),
		done: frontmatter(status ?? "")?.state?.split(/[\s(]/)[0] === "done",
		...(outcome === undefined ? {} : { outcome }),
	};
}

/** The file-only source: STATUS is done and its Outcome says the work landed. */
export function landedInFiles(record: ItemRecord): Landed | undefined {
	if (!record.done || record.outcome === undefined) return undefined;
	const outcome = record.outcome;
	const landed = outcome
		.split("\n")
		.some(
			(line) =>
				/(?<!\bnot\s+)\bmerged\b/i.test(line) ||
				/\bfast-forwarded to main\b/i.test(line) ||
				(/\blive\b/i.test(line) && SHA.test(line)) ||
				(/#\d+\b/.test(line) && DATE.test(line)),
		);
	if (!landed) return undefined;
	const pr =
		outcome.match(/merged as #(\d+)/i)?.[1] ??
		outcome.match(/#(\d+)\b/)?.[1] ??
		record.prs[0];
	const sha = outcome.match(SHA)?.[0]?.toLowerCase();
	const date = outcome.match(DATE)?.[0];
	return {
		by: "STATUS",
		...(pr === undefined ? {} : { pr: Number(pr) }),
		...(sha ? { sha } : {}),
		...(date ? { date } : {}),
	};
}

function hasRawLog(dir: string, inLogDir = false): boolean {
	return readdirSync(dir, { withFileTypes: true }).some((entry) =>
		entry.isDirectory()
			? hasRawLog(
					join(dir, entry.name),
					inLogDir || entry.name === "logs" || entry.name === "runs",
				)
			: entry.isFile() && (inLogDir || /\.(?:log|jsonl)$/.test(entry.name)),
	);
}

/** The record rules belong to the software method: on when it loads. */
function loadsSoftware(catalog: ModuleCatalog): boolean {
	try {
		return resolveModules(catalog).selected.some(
			(module) =>
				module.metadata?.provides === "software" ||
				module.metadata?.name === "software",
		);
	} catch {
		return false;
	}
}

/** Check one workspace's work items, archive index, journal and outbox. */
export function checkWork(
	workspace: Workspace,
	config: Config,
	today: Date,
	catalog: ModuleCatalog = moduleCatalog(workspace.dir, undefined, true),
	landedSource: LandedSource = landedInFiles,
): Finding[] {
	const findings: Finding[] = [];
	const add = (
		level: FindingLevel,
		code: string,
		path: string,
		message: string,
		line?: number,
	) => {
		findings.push({
			level,
			code,
			file: relative(workspace.state, path) || ".",
			...(line === undefined ? {} : { line }),
			message,
		});
	};

	const records = loadsSoftware(catalog);
	const checkRecord = (
		state: (typeof STATES)[number],
		slug: string,
		itemDir: string,
	) => {
		if (state === "todo") return;
		const status = join(itemDir, "STATUS.md");
		const notes = readdirSync(itemDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && NOTE_NAME.test(entry.name))
			.map((entry) => entry.name)
			.sort();
		const texts = notes.map((name) => read(join(itemDir, name)));
		const record = itemRecord(
			existsSync(status) ? read(status) : undefined,
			texts,
		);
		if (!record.prs.length && !record.shas.length) return;
		if (state === "done" && record.done) {
			if (!notes.length)
				add(
					"warn",
					"record-note-missing",
					itemDir,
					`done item ${slug} names ${record.prs.length ? `PR ${record.prs.map((n) => `#${n}`).join(", ")}` : `merge ${record.shas[0]}`} and has no measurements.md`,
				);
			else if (!hasRawLog(itemDir))
				add(
					"warn",
					"record-logs-missing",
					itemDir,
					`done item ${slug} has a measurement note and no raw log beside it`,
				);
		}
		const landed = landedSource(record);
		notes.forEach((name, index) => {
			const { lines, head } = noteHead(texts[index] ?? "");
			const notLanded =
				lines.some((line) =>
					NOT_LANDED_LABELLED.test(line.match(STATUS_LABEL)?.[1] ?? ""),
				) || head.some((line) => NOT_LANDED_HEAD.test(line));
			if (!notLanded) return;
			const headSha = mergeShas(head.join("\n"))[0];
			const says = landed
				? `${landed.by} says merged${landed.pr !== undefined ? ` as #${landed.pr}` : landed.sha ? ` at ${landed.sha}` : ""}${landed.date ? ` on ${landed.date}` : ""}`
				: headSha && `its head names merge ${headSha}`;
			if (says)
				add(
					"warn",
					"record-note-stale",
					join(itemDir, name),
					`${slug}/${name} says not landed; ${says}`,
				);
		});
	};

	const current = join(workspace.state, "CURRENT.md");
	const workDir = join(workspace.state, "work");
	const items = new Map<string, (typeof STATES)[number]>();
	for (const state of STATES) {
		const dir = join(workDir, state);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (!entry.isDirectory()) continue;
			const slug = entry.name;
			const itemDir = join(dir, slug);
			const priorState = items.get(slug);
			if (priorState) {
				add(
					"error",
					"item-duplicate",
					itemDir,
					`also exists in work/${priorState}/`,
				);
			}
			items.set(slug, state);
			if (records) checkRecord(state, slug, itemDir);

			if (state !== "done") {
				for (const report of readdirSync(itemDir, { withFileTypes: true })) {
					if (!report.isFile() || !report.name.endsWith("report.md")) continue;
					const path = join(itemDir, report.name);
					if (
						!proseLines(read(path)).some(({ line }) =>
							/^## Discoveries(?:[ \t]+#+)?[ \t]*\r?$/.test(line),
						)
					) {
						add(
							"warn",
							"report-no-discoveries",
							path,
							"report needs a ## Discoveries heading",
						);
					}
				}
			}

			const status = join(itemDir, "STATUS.md");
			if (!existsSync(status)) {
				add("warn", "item-no-status", itemDir, "work item has no STATUS.md");
				continue;
			}
			const metadata = frontmatter(read(status));
			const declared = metadata?.state?.split(/[\s(]/)[0];
			if (!declared) {
				add(
					"info",
					"item-no-state",
					status,
					"no `state` frontmatter (pre-standard)",
				);
			} else if (declared !== state) {
				add(
					"error",
					"item-state-mismatch",
					status,
					`frontmatter says \`${metadata?.state}\` but the item is in work/${state}/`,
				);
			}

			if (state === "done") {
				if (metadata?.state && !metadata.closed) {
					add(
						"info",
						"item-no-closed",
						status,
						"done without a `closed:` date",
					);
				}
				const { date, approximate } = closedDate(itemDir);
				const age = daysBetween(date, today);
				if (age > config.windows.doneDays) {
					add(
						"warn",
						"item-archive-due",
						itemDir,
						`closed ${age} days ago${approximate ? " (by file date)" : ""}; archive it (shepherd tool archive)`,
					);
				}
			}
		}
	}

	if (existsSync(current)) {
		const text = read(current);
		for (const [slug, state] of items) {
			if (state !== "done" && !text.includes(slug)) {
				add(
					"warn",
					"item-unlisted",
					current,
					`work/${state}/${slug} is not mentioned in CURRENT.md`,
				);
			}
		}
	}

	const archiveDir = join(workspace.state, "archive");
	const archiveIndex = join(archiveDir, "INDEX.md");
	if (existsSync(archiveDir)) {
		const archived = readdirSync(archiveDir, { withFileTypes: true })
			.filter(
				(month) => month.isDirectory() && /^\d{4}-\d{2}$/.test(month.name),
			)
			.flatMap((month) =>
				readdirSync(join(archiveDir, month.name), { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(archiveDir, month.name, entry.name)),
			);
		if (archived.length > 0 && !existsSync(archiveIndex)) {
			add(
				"warn",
				"archive-index-missing",
				archiveIndex,
				`${archived.length} archived items but no archive/INDEX.md`,
			);
		}
		if (existsSync(archiveIndex)) {
			const linked = new Set(
				[...linkTargets(archiveIndex)].map((target) =>
					target.endsWith(".md") ? dirname(target) : target,
				),
			);
			for (const item of archived) {
				if (!linked.has(item)) {
					add(
						"warn",
						"archive-unlisted",
						item,
						"not listed in archive/INDEX.md",
					);
				}
			}
		}
	}

	for (const { file, reason, line } of journalChain(workspace.state)
		.unreadable) {
		if (line !== undefined)
			add(
				"warn",
				"journal-fence-unclosed",
				join(workspace.state, file),
				reason,
				line,
			);
	}

	const journal = join(workspace.state, "journal.md");
	if (existsSync(journal)) {
		const text = read(journal);
		for (const slip of journalTimeSlips(text)) {
			add(
				"warn",
				"journal-time-backwards",
				journal,
				`${slip.count} time steps backwards by more than 5 minutes under ${slip.day}`,
				slip.firstLine,
			);
		}
		for (const duplicate of journalDuplicateHeadings(text)) {
			add(
				"warn",
				"journal-heading-duplicate",
				journal,
				`duplicate heading ${duplicate.day}`,
				duplicate.lines[0],
			);
		}
		for (const heading of journalMisorderedHeadings(text)) {
			add(
				"warn",
				"journal-heading-order",
				journal,
				`${heading.day} is earlier than ${heading.previous}; a rotation would reorder the chain`,
				heading.line,
			);
		}
		const orphans = journalOrphans(text);
		if (orphans.length) {
			add(
				"warn",
				"journal-orphans",
				journal,
				`${orphans.length} bullets before the first heading; a rotation would reorder the chain`,
				orphans[0]?.line,
			);
		}
		const thisMonth = monthOf(today);
		const older = journalSections(text).days.filter(
			(day) => day.date.slice(0, 7) < thisMonth,
		);
		if (older.length > 0) {
			add(
				"warn",
				"journal-rotation-due",
				journal,
				`${older.length} day sections from before ${thisMonth}; rotate them to archive/journal/ (shepherd tool archive)`,
			);
		}

		let heading: string | undefined;
		let misfiled = 0;
		let firstMisfiled: number | undefined;
		for (const { n, line } of proseLines(text)) {
			const headingMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
			if (headingMatch?.[1]) heading = headingMatch[1];
			const bullet = line.match(/^- (?:\*\*)?(\d{4}-\d{2}-\d{2})/);
			if (heading && bullet?.[1] && bullet[1] > heading) {
				misfiled++;
				firstMisfiled ??= n;
			}
		}
		if (misfiled > 0) {
			add(
				"info",
				"journal-misfiled",
				journal,
				`${misfiled} bullets dated later than the heading they sit under (one heading per day)`,
				firstMisfiled,
			);
		}
	}

	const pending = join(workspace.state, "pending.md");
	if (existsSync(pending)) {
		for (const { n, line } of proseLines(read(pending))) {
			if (!line.startsWith("- ")) continue;
			const date = line.match(/^- (\d{4}-\d{2}-\d{2})(?=\b)/)?.[1];
			if (!date) {
				add(
					"info",
					"pending-no-date",
					pending,
					"pending bullet needs a leading YYYY-MM-DD",
					n,
				);
			} else {
				const age = daysBetween(localDate(date), today);
				if (age > config.windows.pendingDays) {
					add(
						"warn",
						"pending-stale",
						pending,
						`${date}, ${age} days ago, past the ${config.windows.pendingDays}-day pending window`,
						n,
					);
				}
			}
		}
	}

	const outbox = join(workspace.state, "outbox");
	if (existsSync(outbox)) {
		for (const file of readdirSync(outbox).filter(
			(file) => file.endsWith(".md") && file !== "README.md",
		)) {
			add(
				"info",
				"outbox-item",
				join(outbox, file),
				"outbox item waiting for the master",
			);
		}
	}

	return findings;
}
