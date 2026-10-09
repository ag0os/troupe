import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { checkLinks, decodedLinkTarget } from "./check-links";
import { checkWork } from "./check-work";
import { readCheckpoint } from "./checkpoint";
import type { Config } from "./config";
import { contextTiers } from "./context";
import { droppedLines, readBaseline, readDroppedSources } from "./current-prev";
import { daysBetween, localDate } from "./dates";
import { lockStatus } from "./lock";
import type { ToolEnv } from "./sessions";
import { statusItems } from "./status-parse";
import {
	frontmatter,
	journalChain,
	mdFiles,
	proseLines,
	read,
	words,
	wordsIn,
} from "./text";
import type { Workspace, WorkspaceTree } from "./tree";

const MEMORY_TYPES = new Set(["user", "preference", "project", "reference"]);

export type FindingLevel = "error" | "warn" | "info";

export type Finding = {
	level: FindingLevel;
	code: string;
	file: string;
	line?: number;
	message: string;
};

function symlinksUnder(dir: string): string[] {
	const links: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) links.push(path);
		else if (stat.isDirectory()) links.push(...symlinksUnder(path));
	}
	return links;
}

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

function withoutInlineCode(line: string): string {
	const runs = [...line.matchAll(/`+/g)];
	let result = "";
	let offset = 0;
	for (let index = 0; index < runs.length; index++) {
		const start = runs[index];
		if (!start) continue;
		const closing = runs.findIndex(
			(run, n) => n > index && run[0].length === start[0].length,
		);
		if (closing < 0) continue;
		const end = runs[closing];
		if (!end) continue;
		result += `${line.slice(offset, start.index)} `;
		offset = end.index + end[0].length;
		index = closing;
	}
	return result + line.slice(offset);
}

function referenceLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function isBeneath(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function enclosingWorkspace(
	workspace: Workspace,
	tree: WorkspaceTree,
): Workspace | undefined {
	return tree.workspaces
		.filter((candidate) => isBeneath(candidate.dir, workspace.dir))
		.sort((left, right) => right.dir.length - left.dir.length)[0];
}

function integrationFiles(workspace: Workspace): string[] {
	const dir = join(workspace.state, "integrations");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => join(dir, file));
}

/** Check one workspace's state files, modules, memories and docs. */
export function checkWorkspace(
	workspace: Workspace,
	tree: WorkspaceTree,
	config: Config,
	today: Date,
	home?: string,
	toolEnv?: ToolEnv,
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

	const probe: ToolEnv = toolEnv ?? {
		cwd: workspace.dir,
		home: home ?? "",
		env: {},
		now: today,
		clock: () => today,
		runCommand: async () => {
			throw new Error("check does not run commands");
		},
		pidAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code !== "ESRCH";
			}
		},
	};
	for (const which of ["state", "unlock"] as const) {
		let status: ReturnType<typeof lockStatus>;
		let problem = "";
		try {
			status = lockStatus(workspace.state, probe, which);
		} catch (error) {
			status = { status: "stale" };
			problem = `; could not inspect lock: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (status.status === "stale") {
			add(
				"error",
				"lock-stale",
				join(workspace.state, `.${which}.lock`),
				`stale ${which} lock left by pid ${status.pid ?? "unknown"}${problem}; ${
					which === "state"
						? "run `shepherd tool unlock` when no Shepherd of this workspace is live"
						: `no unlock is running; run \`rm -r ${resolve(workspace.state, ".unlock.lock")}\``
				}`,
			);
		}
	}
	const checkpoint = readCheckpoint(workspace.state);
	const checkpointPath = join(workspace.state, "checkpoint.json");
	if (checkpoint.status === "none") {
		add(
			"info",
			"checkpoint-missing",
			checkpointPath,
			"run `shepherd tool start`, reconcile, then `shepherd tool checkpoint`",
		);
	} else if (checkpoint.status === "invalid") {
		add("error", "checkpoint-invalid", checkpointPath, checkpoint.reason);
	} else {
		const baseline = readBaseline(
			workspace.state,
			checkpoint.checkpoint.snapshot,
			checkpoint.checkpoint.files["CURRENT.md"] ?? null,
		);
		if (baseline.status === "lost") {
			add("error", "checkpoint-invalid", checkpointPath, baseline.reason);
		} else if (
			baseline.status === "ok" &&
			existsSync(join(workspace.state, "CURRENT.md"))
		) {
			const result = droppedLines({
				baseline: baseline.text,
				current: read(join(workspace.state, "CURRENT.md")),
				...readDroppedSources(workspace, baseline.text),
			});
			for (const dropped of result.unaccounted) {
				add(
					"warn",
					"current-line-dropped",
					join(workspace.state, "CURRENT.md"),
					`${dropped.text}${dropped.nearest ? `; nearest: ${dropped.nearest.path}:${dropped.nearest.line} (${dropped.nearest.percent}%)` : ""}`,
					dropped.line,
				);
			}
		}
	}

	const workspaceConfig = join(workspace.state, "config.json");
	for (const problem of config.problems) {
		if (problem.file !== workspaceConfig) continue;
		add(
			"error",
			"config-invalid",
			problem.file,
			`${problem.key}: ${problem.problem}`,
		);
	}

	const charter = join(workspace.state, "charter.md");
	if (!existsSync(charter)) {
		add(
			"info",
			"charter-missing",
			charter,
			"no charter: workspace is uninitiated",
		);
	} else {
		const count = words(read(charter));
		if (count > config.marks.charter) {
			add(
				"info",
				"charter-over-mark",
				charter,
				`${count} words, past the ${config.marks.charter}-word review mark: check for text core or shared modules already say, or procedures that could be a doc; keep everything a session needs`,
			);
		}
	}

	const current = join(workspace.state, "CURRENT.md");
	if (!existsSync(current)) {
		add("error", "current-missing", current, "CURRENT.md is missing");
	} else {
		const text = read(current);
		const count = words(text);
		if (count > config.marks.current) {
			add(
				"info",
				"current-over-mark",
				current,
				`${count} words, past the ${config.marks.current}-word review mark: check for closed items and duplicated facts; move live warnings up, never drop them; standing how-tos go to a doc with an action-named index line; standing rules to the charter; keep what is costly on first misuse`,
			);
		}
		if (checkpoint.status === "none") {
			const updated = text.match(
				/^Updated: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?=\s|$)/m,
			);
			const last = journalChain(workspace.state)
				.entries.filter((entry) => entry.day && entry.time)
				.at(-1);
			if (updated?.[1] && updated[2] && last?.day && last.time) {
				const timestamp = (day: string, time: string) => {
					const date = localDate(day);
					const [hour, minute] = time.split(":").map(Number);
					if (
						hour === undefined ||
						minute === undefined ||
						hour > 23 ||
						minute > 59
					)
						return NaN;
					date.setHours(hour, minute);
					return date.getTime();
				};
				if (
					timestamp(last.day, last.time) - timestamp(updated[1], updated[2]) >
					15 * 60_000
				) {
					add(
						"warn",
						"current-older-than-journal",
						current,
						`CURRENT updated ${updated[1]} ${updated[2]}; last journal entry ${last.day} ${last.time}`,
						text.slice(0, updated.index).split("\n").length,
					);
				}
			}
		}

		for (const item of statusItems(text)) {
			if (!item.known) {
				add(
					"warn",
					"status-word-unknown",
					current,
					`unknown status word \`${item.word}\``,
					item.line,
				);
			}
		}
		const updated = text.match(/^Updated:\s*(\d{4}-\d{2}-\d{2})/m);
		if (!updated?.[1]) {
			add(
				"info",
				"current-no-updated",
				current,
				"no `Updated: YYYY-MM-DD` line (tracking standard)",
			);
		} else {
			const age = daysBetween(localDate(updated[1]), today);
			if (age > config.windows.currentStaleDays) {
				add(
					"warn",
					"current-stale",
					current,
					`last updated ${updated[1]}, ${age} days ago`,
				);
			}
		}
	}

	const handoff = join(workspace.state, "HANDOFF.md");
	if (existsSync(handoff)) {
		add(
			"info",
			"handoff-file",
			handoff,
			"HANDOFF.md exists; the standard folds it into CURRENT.md",
		);
	}

	const integrations = integrationFiles(workspace);
	const hasDescendant = tree.workspaces.some((candidate) =>
		isBeneath(workspace.dir, candidate.dir),
	);
	const sharedWords = wordsIn(integrations);
	if (hasDescendant && sharedWords > config.marks.shared) {
		add(
			"warn",
			"shared-over-mark",
			join(workspace.state, "integrations"),
			`${sharedWords} words, past the ${config.marks.shared}-word mark; these modules load into every workspace beneath this one, so every word costs every session`,
		);
	}

	const enclosing = enclosingWorkspace(workspace, tree);
	if (enclosing) {
		const inherited = new Map(
			integrationFiles(enclosing).map((path) => [basename(path), path]),
		);
		for (const local of integrations) {
			const inheritedPath = inherited.get(basename(local));
			if (!inheritedPath || !existsSync(local) || !existsSync(inheritedPath)) {
				continue;
			}
			const sameFile = realpathSync(local) === realpathSync(inheritedPath);
			add(
				"info",
				"module-duplicate",
				local,
				sameFile
					? `local ${basename(local)} is the same file as the inherited module; it is skipped at launch`
					: `local ${basename(local)} has the same name as the inherited module; both load at launch`,
			);
		}
	}

	for (const link of symlinksUnder(workspace.state)) {
		if (!existsSync(link)) {
			add("error", "broken-symlink", link, "broken symlink");
		}
	}

	const memoryIndex = join(workspace.state, "MEMORY.md");
	const memoriesDir = join(workspace.state, "memories");
	const memoryFiles = existsSync(memoriesDir)
		? readdirSync(memoriesDir)
				.filter((file) => file.endsWith(".md"))
				.sort()
		: [];
	if (memoryFiles.length > 0 && !existsSync(memoryIndex)) {
		add(
			"error",
			"memory-index-missing",
			memoryIndex,
			"memories exist but MEMORY.md is missing",
		);
	}
	if (existsSync(memoryIndex)) {
		const indexed = new Set<string>();
		for (const { n, line } of proseLines(read(memoryIndex))) {
			for (const match of line.matchAll(/\]\((memories\/[^)#\s]+\.md)\)/g)) {
				const target = match[1];
				if (!target) continue;
				indexed.add(basename(target));
				if (!existsSync(join(workspace.state, target))) {
					add(
						"error",
						"memory-index-dangling",
						memoryIndex,
						`index points at missing ${target}`,
						n,
					);
				}
			}
		}
		for (const file of memoryFiles) {
			if (!indexed.has(file)) {
				add(
					"error",
					"memory-unlisted",
					join(memoriesDir, file),
					"memory not listed in MEMORY.md",
				);
			}
		}
	}
	for (const file of memoryFiles) {
		const path = join(memoriesDir, file);
		const metadata = frontmatter(read(path));
		if (!metadata) {
			add(
				"warn",
				"memory-no-frontmatter",
				path,
				"no frontmatter (name, description, type)",
			);
			continue;
		}
		for (const key of ["name", "description", "type"]) {
			if (!metadata[key]) {
				add(
					"warn",
					"memory-frontmatter-key",
					path,
					`frontmatter lacks \`${key}\``,
				);
			}
		}
		if (metadata.type && !MEMORY_TYPES.has(metadata.type)) {
			add(
				"warn",
				"memory-type",
				path,
				`type \`${metadata.type}\` is not one of user, preference, project, reference`,
			);
		}
		const expectedName = file.replace(/\.md$/, "");
		if (metadata.name && metadata.name !== expectedName) {
			add(
				"warn",
				"memory-name",
				path,
				`name \`${metadata.name}\` doesn't match the filename`,
			);
		}
	}

	const docsDir = join(workspace.state, "docs");
	const docsIndex = join(docsDir, "INDEX.md");
	const docs = mdFiles(docsDir).filter((path) => path !== docsIndex);
	if (docs.length > 0 && !existsSync(docsIndex)) {
		add(
			"warn",
			"docs-index-missing",
			docsIndex,
			`${docs.length} docs but no docs/INDEX.md`,
		);
	}
	if (existsSync(docsIndex)) {
		const lines = proseLines(read(docsIndex)).map(({ n, line }) => ({
			n,
			line: withoutInlineCode(line),
		}));
		const references = new Set(
			lines.flatMap(({ line }) => {
				const definition = line.match(/^ {0,3}\[([^\]]+)\]:\s*\S+/);
				return definition?.[1] ? [referenceLabel(definition[1])] : [];
			}),
		);
		for (const { n, line } of lines) {
			if (/^ {0,3}\[[^\]]+\]:/.test(line)) continue;
			const link = [
				...line.matchAll(/\[([^\]]+)\](?:\(([^)]+)\)|\[([^\]]*)\])?/g),
			].find(
				(match) =>
					match[2] !== undefined ||
					references.has(referenceLabel(match[3] || match[1] || "")),
			);
			if (
				link &&
				!/\b(before|when|after|if|while|once|during|until)\b/i.test(
					line.slice(link.index + link[0].length),
				)
			) {
				add(
					"warn",
					"doc-trigger-missing",
					docsIndex,
					"index link needs a trigger naming the moment to read",
					n,
				);
			}
		}
		const linked = linkTargets(docsIndex);
		for (const doc of docs) {
			let covered = linked.has(doc);
			for (
				let dir = dirname(doc);
				!covered && isBeneath(docsDir, dir);
				dir = dirname(dir)
			) {
				covered = linked.has(join(dir, "README.md"));
			}
			if (!covered) {
				add("warn", "doc-unlisted", doc, "not listed in docs/INDEX.md");
			}
		}
	}

	let promptProblem: string | undefined;
	const tiers = contextTiers(
		workspace,
		config,
		(message) => {
			promptProblem = message;
		},
		probe,
	);
	if (promptProblem) {
		add(
			"warn",
			"prompt-uncountable",
			workspace.state,
			`could not compose the prompt (${promptProblem}); the opening count uses the charter and readable local modules`,
		);
	}
	if (tiers.opens > config.marks.opening) {
		add(
			"warn",
			"opening-over-mark",
			workspace.state,
			`a session opens with ${tiers.opens} words (prompt ${tiers.loaded}, session-start files ${tiers.start}), past the ${config.marks.opening}-word mark; see shepherd tool check --context`,
		);
	}

	findings.push(...checkWork(workspace, config, today));
	findings.push(...checkLinks(workspace, tree, home));

	return findings;
}
