import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { checkLinks } from "./check-links";
import { checkWork } from "./check-work";
import type { Config } from "./config";
import { contextTiers } from "./context";
import { daysBetween, localDate } from "./dates";
import { frontmatter, mdFiles, proseLines, read, words, wordsIn } from "./text";
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
			const target = decodeURIComponent(match[1]?.split("#")[0] ?? "");
			if (target && !/^[a-z]+:/i.test(target)) {
				targets.add(resolve(dirname(file), target));
			}
		}
	}
	return targets;
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
				`${count} words, past the ${config.marks.current}-word review mark: check for closed items and duplicated facts; move live warnings up, never drop them`,
			);
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
	const tiers = contextTiers(workspace, config, (message) => {
		promptProblem = message;
	});
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
