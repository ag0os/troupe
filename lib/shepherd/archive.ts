import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ArchivedItem, rewriteArchiveReferences } from "./archive-rewrite";
import type { Config } from "./config";
import { dayOf, daysBetween, monthOf } from "./dates";
import { closedDate, journalSections, read, summaryLine } from "./text";
import type { Workspace, WorkspaceTree } from "./tree";

export type ArchiveMoveStatus = "planned" | "moved" | "skipped";

type ArchiveMoveBase = {
	kind: "journal" | "item";
	from: string;
	to: string;
	detail: string;
	status: ArchiveMoveStatus;
};

export type JournalArchiveMove = ArchiveMoveBase & {
	kind: "journal";
	month: string;
	days: string[];
};

export type ItemArchiveMove = ArchiveMoveBase & {
	kind: "item";
	slug: string;
	month: string;
	day: string;
	age: number;
	approximate: boolean;
};

export type ArchiveMove = JournalArchiveMove | ItemArchiveMove;

export type ArchiveWorkspacePlan = {
	name: string;
	state: string;
	moves: ArchiveMove[];
};

export type ArchivePlan = {
	applied: boolean;
	doneDays: number;
	workspaces: ArchiveWorkspacePlan[];
	rewrittenFiles: string[];
};

function journalMoves(workspace: Workspace, today: Date): JournalArchiveMove[] {
	const journal = join(workspace.state, "journal.md");
	if (!existsSync(journal)) return [];

	const currentMonth = monthOf(today);
	const byMonth = new Map<string, string[]>();
	for (const section of journalSections(read(journal)).days) {
		const month = section.date.slice(0, 7);
		if (month >= currentMonth) continue;
		byMonth.set(month, [...(byMonth.get(month) ?? []), section.body]);
	}

	return [...byMonth].map(([month, days]) => ({
		kind: "journal",
		from: "journal.md",
		to: `archive/journal/${month}.md`,
		detail: `${days.length} day(s) of ${month}`,
		status: "planned",
		month,
		days,
	}));
}

function itemMoves(
	workspace: Workspace,
	doneDays: number,
	today: Date,
): ItemArchiveMove[] {
	const done = join(workspace.state, "work", "done");
	if (!existsSync(done)) return [];

	const moves: ItemArchiveMove[] = [];
	for (const slug of readdirSync(done).sort()) {
		const item = join(done, slug);
		if (!statSync(item).isDirectory()) continue;
		const { date, approximate } = closedDate(item);
		const age = daysBetween(date, today);
		if (age <= doneDays) continue;
		const month = monthOf(date);
		const day = dayOf(date);
		const to = `archive/${month}/${slug}`;
		moves.push({
			kind: "item",
			from: `work/done/${slug}`,
			to,
			detail: `closed ${day}${approximate ? ", by file date" : ""}, ${age} days`,
			status: existsSync(join(workspace.state, to)) ? "skipped" : "planned",
			slug,
			month,
			day,
			age,
			approximate,
		});
	}
	return moves;
}

/** Inspect the selected workspaces and describe every archive operation. */
export function planArchive(
	workspaces: readonly Workspace[],
	config: Config,
	today: Date,
): ArchivePlan {
	return {
		applied: false,
		doneDays: config.windows.doneDays,
		rewrittenFiles: [],
		workspaces: workspaces.map((workspace) => ({
			name: workspace.name,
			state: workspace.state,
			moves: [
				...journalMoves(workspace, today),
				...itemMoves(workspace, config.windows.doneDays, today),
			],
		})),
	};
}

function indexHeader(doneDays: number): string {
	return `# Archive index\n\nClosed work moved out of \`work/done/\` after ${doneDays} days, one line per item in the order archived: date closed (\`~\` when taken from the file date), item, outcome.\n\n`;
}

function applyJournalMoves(workspace: ArchiveWorkspacePlan): void {
	const moves = workspace.moves.filter(
		(move): move is JournalArchiveMove => move.kind === "journal",
	);
	if (!moves.length) return;

	const archive = join(workspace.state, "archive", "journal");
	mkdirSync(archive, { recursive: true });
	for (const move of moves) {
		const target = join(workspace.state, move.to);
		const heading = existsSync(target) ? "" : `# Journal ${move.month}\n\n`;
		appendFileSync(
			target,
			`${heading}${move.days.map((body) => body.trimEnd()).join("\n\n")}\n`,
		);
		move.status = "moved";
	}

	const journal = join(workspace.state, "journal.md");
	const { preamble, days } = journalSections(read(journal));
	const movedMonths = new Set(moves.map(({ month }) => month));
	const keep = days
		.filter(({ date }) => !movedMonths.has(date.slice(0, 7)))
		.map(({ body }) => body.trimEnd());
	writeFileSync(
		journal,
		`${preamble.trimEnd() || "# Journal"}\n\n${keep.join("\n\n")}${keep.length ? "\n" : ""}`,
	);
}

function applyItemMoves(
	workspace: ArchiveWorkspacePlan,
	doneDays: number,
): void {
	const lines: string[] = [];
	for (const move of workspace.moves) {
		if (move.kind !== "item" || move.status === "skipped") continue;
		const source = join(workspace.state, move.from);
		const target = join(workspace.state, move.to);
		if (existsSync(target)) {
			move.status = "skipped";
			continue;
		}
		mkdirSync(join(workspace.state, "archive", move.month), {
			recursive: true,
		});
		const summary = summaryLine(source);
		renameSync(source, target);
		move.status = "moved";
		const statusLink = existsSync(join(target, "STATUS.md"))
			? `${move.month}/${move.slug}/STATUS.md`
			: `${move.month}/${move.slug}/`;
		lines.push(
			`- ${move.day}${move.approximate ? "~" : ""} [${move.slug}](${statusLink}): ${summary}`,
		);
	}

	if (!lines.length) return;
	const index = join(workspace.state, "archive", "INDEX.md");
	if (!existsSync(index)) writeFileSync(index, indexHeader(doneDays));
	appendFileSync(index, `${lines.join("\n")}\n`);
}

/** Perform a previously built plan and return it with final move statuses. */
export function applyArchive(
	plan: ArchivePlan,
	tree: WorkspaceTree,
): ArchivePlan {
	const applied: ArchivePlan = {
		...plan,
		applied: true,
		workspaces: plan.workspaces.map((workspace) => ({
			...workspace,
			moves: workspace.moves.map((move) => ({ ...move })),
		})),
	};
	for (const workspace of applied.workspaces) {
		applyJournalMoves(workspace);
		applyItemMoves(workspace, applied.doneDays);
	}
	const moves: ArchivedItem[] = applied.workspaces.flatMap((workspace) =>
		workspace.moves.flatMap((move) =>
			move.kind === "item" && move.status === "moved"
				? [
						{
							workspace: workspace.name,
							slug: move.slug,
							month: move.month,
							from: join(workspace.state, move.from),
							to: join(workspace.state, move.to),
						},
					]
				: [],
		),
	);
	applied.rewrittenFiles = rewriteArchiveReferences(tree.workspaces, moves);
	return applied;
}

/** Exit 1 exactly when at least one operation could not be performed. */
export function archiveExitCode(plan: ArchivePlan): 0 | 1 {
	return plan.workspaces.some((workspace) =>
		workspace.moves.some(({ status }) => status === "skipped"),
	)
		? 1
		: 0;
}

function moveCount(workspace: ArchiveWorkspacePlan): number {
	return workspace.moves.filter(({ status }) => status !== "skipped").length;
}

/** Render an archive dry run or applied plan in the human CLI format. */
export function renderArchive(plan: ArchivePlan): string {
	const lines: string[] = [];
	for (const workspace of plan.workspaces) {
		const count = moveCount(workspace);
		const nothing = workspace.moves.length === 0;
		lines.push(
			"",
			`${workspace.name}: ${nothing ? "nothing to archive" : `${count} move(s)${plan.applied ? "" : " (dry run)"}`}`,
		);
		for (const move of workspace.moves) {
			if (move.status === "skipped" && move.kind === "item") {
				lines.push(`  skip ${move.slug}: ${move.to} already exists`);
			} else if (move.kind === "journal") {
				lines.push(`  journal: ${move.detail} -> ${move.to}`);
			} else {
				lines.push(`  ${move.from} -> ${move.to}  (${move.detail})`);
			}
		}
	}
	const moves = plan.workspaces.reduce(
		(count, workspace) => count + moveCount(workspace),
		0,
	);
	if (!plan.applied && moves) {
		lines.push("", "Dry run. Add --apply to move.");
	}
	if (
		plan.applied &&
		plan.workspaces.some((workspace) =>
			workspace.moves.some(
				(move) => move.kind === "item" && move.status === "moved",
			),
		)
	) {
		lines.push(
			"",
			`Rewrote references in ${plan.rewrittenFiles.length} file(s):`,
			...plan.rewrittenFiles.map((file) => `  ${file}`),
		);
	}
	return lines.join("\n");
}
