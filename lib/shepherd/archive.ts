import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type ArchivedItem, rewriteArchiveReferences } from "./archive-rewrite";
import type { Config } from "./config";
import { dayOf, daysBetween, monthOf } from "./dates";
import {
	closedDate,
	journalChain,
	journalEntries,
	journalFenceProblem,
	journalSections,
	read,
	summaryLine,
	symlinkComponent,
} from "./text";
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
	doneDays: number;
	moves: ArchiveMove[];
};

export type ArchivePlan = {
	applied: boolean;
	workspaces: ArchiveWorkspacePlan[];
	rewrittenFiles: string[];
	skippedRewrites?: { file: string; reason: string }[];
};

type ConfigSource = Config | ((workspace: Workspace) => Config);

function configFor(source: ConfigSource, workspace: Workspace): Config {
	return typeof source === "function" ? source(workspace) : source;
}

function unsafeFile(path: string, display: string): string | undefined {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return `${display} is a symlink`;
		if (!stat.isFile()) return `${display} is not a regular file`;
		return undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return `${display} cannot be inspected`;
	}
}

function unsafeComponent(state: string, file: string): string | undefined {
	try {
		const linked = symlinkComponent(state, file);
		return linked ? `${linked} is a symlink` : undefined;
	} catch {
		return `${file} cannot be inspected`;
	}
}

function unsafeDestination(state: string, file: string): string | undefined {
	return unsafeComponent(state, file) ?? unsafeFile(join(state, file), file);
}

function journalMoves(workspace: Workspace, today: Date): JournalArchiveMove[] {
	const journal = join(workspace.state, "journal.md");
	const problem = unsafeFile(journal, "journal.md");
	if (problem && problem !== "journal.md is a symlink")
		return [
			{
				kind: "journal",
				from: "journal.md",
				to: "journal.md",
				detail: problem,
				status: "skipped",
				month: "",
				days: [],
			},
		];
	if (!existsSync(journal)) return [];

	const currentMonth = monthOf(today);
	const byMonth = new Map<string, string[]>();
	for (const section of journalSections(read(journal)).days) {
		const month = section.date.slice(0, 7);
		if (month >= currentMonth) continue;
		byMonth.set(month, [...(byMonth.get(month) ?? []), section.body]);
	}

	return [...byMonth]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([month, days]) => ({
			kind: "journal",
			from: "journal.md",
			to: `archive/journal/${month}.md`,
			detail: problem ?? `${days.length} day(s) of ${month}`,
			status: problem ? "skipped" : "planned",
			month,
			days,
		}));
}

function buildJournalTexts(
	texts: ReadonlyMap<string, string>,
	moves: readonly JournalArchiveMove[],
): Map<string, string> {
	const built = new Map(texts);
	for (const move of moves) {
		const existing = built.get(move.to) ?? `# Journal ${move.month}\n\n`;
		built.set(
			move.to,
			`${existing}${existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"}${move.days.map((body) => body.trimEnd()).join("\n\n")}\n`,
		);
	}
	const journal = texts.get("journal.md");
	if (journal === undefined)
		throw new Error("missing journal text for journal.md");
	const { preamble, days } = journalSections(journal);
	const movedMonths = new Set(moves.map(({ month }) => month));
	const keep = days
		.filter(({ date }) => !movedMonths.has(date.slice(0, 7)))
		.map(({ body }) => body.trimEnd());
	built.set(
		"journal.md",
		`${preamble.trimEnd() || "# Journal"}\n\n${keep.join("\n\n")}${keep.length ? "\n" : ""}`,
	);
	return built;
}

function journalTexts(state: string): {
	texts: Map<string, string>;
	problem?: string;
} {
	const texts = new Map<string, string>();
	const chain = journalChain(state);
	if (chain.unreadable.length) {
		return {
			texts,
			problem: chain.unreadable
				.map(({ file, reason }) => `${file} ${reason}`)
				.join("; "),
		};
	}
	for (const file of chain.files) {
		const problem = unsafeFile(join(state, file), file);
		if (problem) return { texts, problem };
		try {
			texts.set(file, read(join(state, file)));
		} catch {
			return { texts, problem: `${file} cannot be read` };
		}
	}
	return { texts };
}

function skipJournalMoves(moves: JournalArchiveMove[], problem: string): void {
	for (const move of moves) {
		move.status = "skipped";
		move.detail = problem;
	}
}

function chainTexts(texts: ReadonlyMap<string, string>): string[] {
	const files = [...texts.keys()]
		.filter((file) => file !== "journal.md")
		.sort();
	files.push("journal.md");
	return files.flatMap((file) =>
		journalEntries(texts.get(file) ?? "").map(({ text }) => text),
	);
}

function simulatedFenceProblem(
	texts: ReadonlyMap<string, string>,
): string | undefined {
	for (const [file, text] of texts) {
		const problem = journalFenceProblem(text);
		if (problem) return `${file} ${problem.reason}`;
	}
	return undefined;
}

function checkJournalSequence(state: string, moves: ArchiveMove[]): void {
	const pending = moves.filter(
		(move): move is JournalArchiveMove =>
			move.kind === "journal" && move.status === "planned",
	);
	if (!pending.length) return;
	const { texts, problem } = journalTexts(state);
	if (problem) {
		skipJournalMoves(pending, problem);
		return;
	}
	const before = chainTexts(texts);
	const accepted: JournalArchiveMove[] = [];
	for (const move of pending) {
		const simulated = buildJournalTexts(texts, [...accepted, move]);
		const fenceProblem = simulatedFenceProblem(simulated);
		if (fenceProblem) {
			move.status = "skipped";
			move.detail = fenceProblem;
			continue;
		}
		const after = chainTexts(simulated);
		if (
			before.length === after.length &&
			before.every((text, i) => text === after[i])
		) {
			accepted.push(move);
			continue;
		}
		const later = [...texts.keys()]
			.sort()
			.find(
				(file) =>
					file.startsWith("archive/journal/") &&
					file > move.to &&
					journalEntries(texts.get(file) ?? "").length > 0,
			);
		const orphans =
			journalEntries(journalSections(texts.get("journal.md") ?? "").preamble)
				.length > 0;
		const cause = orphans
			? "would move entries without a heading"
			: later
				? `would place its entries after ${later}`
				: "would reorder the journal chain";
		move.status = "skipped";
		move.detail = `rotating ${move.month} ${cause}; give orphans a heading, put sections in order, or leave the stray month in place (a heading fix changes no id)`;
	}
}

function itemMoves(
	workspace: Workspace,
	doneDays: number,
	today: Date,
): ItemArchiveMove[] {
	const done = join(workspace.state, "work", "done");
	if (!existsSync(done)) return [];

	const moves: ItemArchiveMove[] = [];
	for (const entry of readdirSync(done, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!entry.isDirectory()) continue;
		const slug = entry.name;
		const item = join(done, slug);
		const { date, approximate } = closedDate(item);
		const age = daysBetween(date, today);
		if (age <= doneDays) continue;
		const month = monthOf(date);
		const day = dayOf(date);
		const to = `archive/${month}/${slug}`;
		const targetExists = existsSync(join(workspace.state, to));
		moves.push({
			kind: "item",
			from: `work/done/${slug}`,
			to,
			detail: targetExists
				? `${to} already exists`
				: `closed ${day}${approximate ? ", by file date" : ""}, ${age} days`,
			status: targetExists ? "skipped" : "planned",
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
	configs: ConfigSource,
	today: Date,
): ArchivePlan {
	return {
		applied: false,
		rewrittenFiles: [],
		workspaces: workspaces.map((workspace) => {
			const config = configFor(configs, workspace);
			const moves: ArchiveMove[] = [
				...journalMoves(workspace, today),
				...itemMoves(workspace, config.windows.doneDays, today),
			];
			for (const move of moves) {
				const problem =
					unsafeComponent(workspace.state, move.to) ??
					(move.kind === "journal"
						? unsafeFile(join(workspace.state, move.to), move.to)
						: undefined);
				if (problem) {
					move.status = "skipped";
					move.detail = problem;
				}
			}
			const indexProblem = moves.some(
				(move) => move.kind === "item" && move.status === "planned",
			)
				? unsafeDestination(workspace.state, "archive/INDEX.md")
				: undefined;
			if (indexProblem) {
				for (const move of moves) {
					if (move.kind === "item" && move.status === "planned") {
						move.status = "skipped";
						move.detail = indexProblem;
					}
				}
			}
			checkJournalSequence(workspace.state, moves);
			return {
				name: workspace.name,
				state: workspace.state,
				doneDays: config.windows.doneDays,
				moves,
			};
		}),
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

	const pending = moves.filter(({ status }) => status !== "skipped");
	if (!pending.length) return;
	const { texts: original, problem } = journalTexts(workspace.state);
	if (problem || !original.has("journal.md")) {
		skipJournalMoves(
			pending,
			problem ?? "journal.md is missing from journal texts",
		);
		return;
	}
	const temporary = "journal.md.tmp";
	const temporaryProblem = unsafeDestination(workspace.state, temporary);
	if (temporaryProblem) {
		skipJournalMoves(pending, temporaryProblem);
		return;
	}
	const archive = join(workspace.state, "archive", "journal");
	for (const move of pending) {
		const target = join(workspace.state, move.to);
		const problem =
			unsafeDestination(workspace.state, move.to) ??
			(existsSync(target) && !original.has(move.to)
				? `${move.to} is missing from journal texts`
				: undefined);
		if (problem) skipJournalMoves([move], problem);
	}
	const accepted = pending.filter(({ status }) => status !== "skipped");
	if (!accepted.length) return;
	const texts = buildJournalTexts(original, accepted);
	const fenceProblem = simulatedFenceProblem(texts);
	if (fenceProblem) {
		skipJournalMoves(accepted, fenceProblem);
		return;
	}
	mkdirSync(archive, { recursive: true });
	for (const move of accepted) {
		const text = texts.get(move.to);
		if (text === undefined)
			throw new Error(`missing journal text for ${move.to}`);
		const existing = original.get(move.to);
		if (existing === undefined) {
			writeFileSync(join(workspace.state, move.to), text, { flag: "wx" });
		} else {
			appendFileSync(
				join(workspace.state, move.to),
				text.slice(existing.length),
			);
		}
		move.status = "moved";
	}
	const journal = texts.get("journal.md");
	if (journal === undefined)
		throw new Error("missing journal text for journal.md");
	writeFileSync(join(workspace.state, temporary), journal);
	renameSync(
		join(workspace.state, temporary),
		join(workspace.state, "journal.md"),
	);
}

function applyItemMoves(workspace: ArchiveWorkspacePlan): void {
	const pending = workspace.moves.filter(
		(move): move is ItemArchiveMove =>
			move.kind === "item" && move.status !== "skipped",
	);
	if (!pending.length) return;
	const indexProblem = unsafeDestination(workspace.state, "archive/INDEX.md");
	if (indexProblem) {
		for (const move of pending) {
			move.status = "skipped";
			move.detail = indexProblem;
		}
		return;
	}

	const lines: string[] = [];
	for (const move of workspace.moves) {
		if (move.kind !== "item" || move.status === "skipped") continue;
		const source = join(workspace.state, move.from);
		const target = join(workspace.state, move.to);
		const problem = unsafeComponent(workspace.state, move.to);
		if (problem) {
			move.status = "skipped";
			move.detail = problem;
			continue;
		}
		if (existsSync(target)) {
			move.status = "skipped";
			move.detail = `${move.to} already exists`;
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
	if (!existsSync(index)) writeFileSync(index, indexHeader(workspace.doneDays));
	appendFileSync(index, `${lines.join("\n")}\n`);
}

/** Perform a previously built plan and return it with final move statuses. */
export function applyArchive(
	plan: ArchivePlan,
	tree: WorkspaceTree,
	home?: string,
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
		applyItemMoves(workspace);
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
	const skippedRewrites: { file: string; reason: string }[] = [];
	applied.rewrittenFiles = rewriteArchiveReferences(
		tree.workspaces,
		moves,
		home,
		(file, reason) => skippedRewrites.push({ file, reason }),
	);
	if (skippedRewrites.length) applied.skippedRewrites = skippedRewrites;
	return applied;
}

/** Exit 1 exactly when at least one operation could not be performed. */
export function archiveExitCode(plan: ArchivePlan): 0 | 1 {
	return plan.skippedRewrites?.length ||
		plan.workspaces.some((workspace) =>
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
			if (move.status === "skipped") {
				lines.push(
					`  skip ${move.kind === "item" ? move.slug : "journal"}: ${move.detail}`,
				);
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
	for (const { file, reason } of plan.skippedRewrites ?? []) {
		lines.push(`  skip rewrite ${file}: ${reason}`);
	}
	return lines.join("\n");
}
