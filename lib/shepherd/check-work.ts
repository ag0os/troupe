import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Finding, FindingLevel } from "./check";
import { decodedLinkTarget } from "./check-links";
import type { Config } from "./config";
import { daysBetween, monthOf } from "./dates";
import {
	closedDate,
	frontmatter,
	journalSections,
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

/** Check one workspace's work items, archive index, journal and outbox. */
export function checkWork(
	workspace: Workspace,
	config: Config,
	today: Date,
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

	const journal = join(workspace.state, "journal.md");
	if (existsSync(journal)) {
		const text = read(journal);
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
