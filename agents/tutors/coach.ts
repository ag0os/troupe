/**
 * COACH: one dynamic tutor, many subject packs.
 *
 * Composes a session prompt from three layers:
 *   1. student.md  — who is being coached
 *   2. core.md     — how coaching works (modes, state, debrief, pressure)
 *   3. <pack>.md   — what this subject is (stance, axis, bank, seeds)
 *
 * ## What lives where
 *
 * The binary carries *mechanism* plus *seeds*; a training root carries
 * *content*. The rule that decides which: **does using the tool change this
 * file?** If yes it must live in the root, because anything a session mutates
 * but the binary owns goes stale silently at the next compile boundary.
 *
 *   - Compiled, never mutated: this code, core.md, coordinator.md.
 *   - Compiled as a seed, then owned by the root: student.md, the packs.
 *
 * So `.coach/student.md` wins over the built-in scaffold, and once
 * `.coach/packs/` exists it *is* the roster — add a subject by writing a file,
 * retire one by deleting it. Built-ins seed a fresh root and nothing more;
 * they are not a floor the root has to subtract from. `--init` copies the
 * seeds in so a root can start from the full set and prune.
 *
 * Each subject keeps its own state in .coach/<slug>/, so several subjects can
 * share one training root without clobbering each other.
 *
 * Coordinator mode also composes self-gated capability modules (built-in, plus
 * .coach/integrations/*.md read at launch) so it can act on the program rather
 * than only describe it.
 *
 * The declaration is `coach.md`; this extension's `prepare` does the
 * composition at launch (D-016). The training root is the framework's
 * working directory, so `--cwd` and `--show-prompt` are framework flags, and
 * backend flags such as `--resume` follow `--` (D-028).
 *
 * Usage:
 *   tutors:coach                        # coordinator: what to train today
 *   tutors:coach rails                  # open the Rails coach
 *   tutors:coach coding "ts drill"      # open with an initial message
 *   tutors:coach --list                 # print the roster and exit
 *   tutors:coach --init                 # seed .coach/ with student + packs
 *   tutors:coach rails --show-prompt    # print composed prompt, don't spawn
 *   tutors:coach rails --cwd ~/training # train against a fixed root
 *   tutors:coach rails -- --resume <id> # backend flags follow `--`
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	PrepareContext,
	PrepareResult,
} from "../../lib/agent-format/types";
import coordinatorDoc from "../../system-prompts/coach/coordinator.md" with {
	type: "text",
};
import coreDoc from "../../system-prompts/coach/core.md" with { type: "text" };
import herdrIntegration from "../../system-prompts/coach/integrations/herdr.md" with {
	type: "text",
};
import codingPack from "../../system-prompts/coach/packs/coding.md" with {
	type: "text",
};
import dataModelingPack from "../../system-prompts/coach/packs/data-modeling.md" with {
	type: "text",
};
import railsPack from "../../system-prompts/coach/packs/rails.md" with {
	type: "text",
};
import systemDesignPack from "../../system-prompts/coach/packs/system-design.md" with {
	type: "text",
};
import testingPack from "../../system-prompts/coach/packs/testing.md" with {
	type: "text",
};
import tsReactPack from "../../system-prompts/coach/packs/ts-react.md" with {
	type: "text",
};
import studentScaffold from "../../system-prompts/coach/student.md" with {
	type: "text",
};

/** Seeds for a fresh training root — not a floor every root inherits. */
function builtInPacks(): string[] {
	return [
		codingPack,
		dataModelingPack,
		railsPack,
		systemDesignPack,
		testingPack,
		tsReactPack,
	];
}

/**
 * Every coach owns `.coach/`: its own state directory, and the student profile
 * it is told to keep current. Scoped so training files never prompt while
 * everything outside stays gated. Subject packs add to this; they never
 * replace it.
 */
const BASE_ALLOW = ["Read(.coach/**)", "Write(.coach/**)", "Edit(.coach/**)"];

/**
 * Capability modules for the coordinator, each self-gated by an availability
 * check it declares itself, so the same prompt degrades cleanly wherever the
 * capability is absent. Subject coaches don't get these — a session teaches,
 * it doesn't coordinate.
 *
 * `herdr` is pre-approved so launching a staged session doesn't prompt;
 * destructive Herdr commands are forbidden by the module instead.
 */
function builtInIntegrations(): string[] {
	return [herdrIntegration];
}
const COORDINATOR_EXTRA_ALLOW = ["Bash(herdr:*)"];

type Pack = {
	slug: string;
	name: string;
	scope: string;
	session: string;
	allow: string[];
	body: string;
	local: boolean;
};

/** Where a warning goes: stderr when executing, nowhere in preview (D-012). */
type Warn = (message: string) => void;

/**
 * Minimal frontmatter reader: flat `key: value` pairs between `---` fences.
 * Deliberately not YAML — packs only ever carry scalar metadata. This is the
 * pack's own runtime content contract, separate from the agent declaration.
 */
function parsePack(raw: string, local: boolean): Pack | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	const frontmatter = match?.[1];
	if (!match || frontmatter === undefined) return null;

	const meta = new Map<string, string>();
	for (const line of frontmatter.split(/\r?\n/)) {
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		meta.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
	}

	const slug = meta.get("slug");
	if (!slug) return null;

	return {
		slug,
		name: meta.get("name") ?? slug,
		scope: meta.get("scope") ?? "",
		session: meta.get("session") ?? "",
		allow: (meta.get("allow") ?? "")
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean),
		body: raw.slice(match[0].length).trim(),
		local,
	};
}

/** The built-in seeds, paired with the raw text `--init` needs to write out. */
function builtInEntries(): { pack: Pack; raw: string }[] {
	return builtInPacks()
		.map((raw) => ({
			raw,
			pack: parsePack(raw, false),
		}))
		.filter((entry): entry is { pack: Pack; raw: string } =>
			Boolean(entry.pack),
		);
}

function bySlug(a: Pack, b: Pack): number {
	return a.slug.localeCompare(b.slug);
}

function packsDir(root: string): string {
	return join(root, ".coach", "packs");
}

/**
 * The roster, resolved.
 *
 * A root that has `.coach/packs/` owns its roster outright — that directory is
 * the whole list, so a subject is retired by deleting its file. Built-ins are
 * only the seed for a root that has none; treating them as a permanent floor
 * is what made retired subjects impossible to remove without a recompile.
 */
function loadPacks(root: string, warn: Warn): Pack[] {
	const localDir = packsDir(root);
	if (!existsSync(localDir)) {
		return builtInEntries()
			.map((entry) => entry.pack)
			.sort(bySlug);
	}

	const packs = new Map<string, Pack>();
	for (const file of readdirSync(localDir)) {
		if (!file.endsWith(".md")) continue;
		try {
			const pack = parsePack(readFileSync(join(localDir, file), "utf8"), true);
			if (pack) packs.set(pack.slug, pack);
		} catch (error) {
			warn(`Skipping unreadable pack ${file}: ${error}`);
		}
	}

	// An empty or all-unreadable directory is a half-made root, not a deliberate
	// empty roster. Fall back rather than offering the student nothing.
	if (packs.size === 0) {
		return builtInEntries()
			.map((entry) => entry.pack)
			.sort(bySlug);
	}

	return [...packs.values()].sort(bySlug);
}

/**
 * Workspace-local capability modules, appended after the built-ins so a
 * training root can extend or override the coordinator without a recompile.
 */
function loadLocalIntegrations(
	root: string,
	warn: Warn,
): { name: string; body: string }[] {
	const dir = join(root, ".coach", "integrations");
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort()
			.map((file) => ({
				name: file,
				body: readFileSync(join(dir, file), "utf8"),
			}));
	} catch (error) {
		warn(`Skipping unreadable integrations directory: ${error}`);
		return [];
	}
}

function studentPath(root: string): string {
	return join(root, ".coach", "student.md");
}

/**
 * The student profile is the one document a session is expected to rewrite, so
 * the root's copy always wins and the compiled one is only a scaffold. The
 * provenance line matters as much as the text: without a path, a coach told to
 * "update this file" has no file to update.
 */
function loadStudent(root: string, warn: Warn): string {
	const path = studentPath(root);
	let doc = studentScaffold;
	let local = false;

	if (existsSync(path)) {
		try {
			doc = readFileSync(path, "utf8");
			local = true;
		} catch (error) {
			warn(`Falling back to the built-in student scaffold: ${error}`);
		}
	}

	const provenance = local
		? `_This profile is \`.coach/student.md\` in the training root. When the student corrects anything in it, edit that file — it is authoritative, and this text is only a copy of it._`
		: `_No \`.coach/student.md\` exists in this training root yet, so this is the built-in scaffold. Treat it as a starting guess, write it to \`.coach/student.md\` once it is right, and edit that file from then on._`;

	return `${doc.trim()}\n\n${provenance}`;
}

/**
 * Seed a training root with the built-in student profile and pack set, and
 * return the report that `--init` prints.
 */
function initRoot(root: string): string {
	const dir = packsDir(root);
	mkdirSync(dir, { recursive: true });

	const written: string[] = [];
	const skipped: string[] = [];
	for (const { pack, raw } of builtInEntries()) {
		const dest = join(dir, `${pack.slug}.md`);
		if (existsSync(dest)) {
			skipped.push(pack.slug);
			continue;
		}
		writeFileSync(dest, raw, "utf8");
		written.push(pack.slug);
	}

	const student = studentPath(root);
	const studentWritten = !existsSync(student);
	if (studentWritten) writeFileSync(student, studentScaffold, "utf8");

	const lines = [`Seeded ${join(root, ".coach")}\n`];
	lines.push(
		`  student.md   ${studentWritten ? "written" : "kept (already present)"}`,
	);
	if (written.length) lines.push(`  packs written  ${written.join(", ")}`);
	if (skipped.length) lines.push(`  packs kept     ${skipped.join(", ")}`);
	lines.push(
		"\nThis directory is now the roster. Delete a pack file to retire the subject;\nadd one to create a subject. No recompile either way.",
	);
	return `${lines.join("\n")}\n`;
}

function renderRoster(packs: Pack[]): string {
	const rows = packs.map(
		(pack) =>
			`| \`tutors:coach ${pack.slug}\` | ${pack.name}${pack.local ? " *(local)*" : ""} | ${pack.scope} | ${pack.session} |`,
	);

	return [
		"# The roster",
		"",
		"These are the coaches the student can launch. You do **not** launch them —",
		"the student does. You recommend.",
		"",
		"| Launch with | Subject | Covers | Typical session |",
		"| ----------- | ------- | ------ | --------------- |",
		...rows,
		"",
		"Each subject owns `.coach/<slug>/` and maintains its own continuity there.",
	].join("\n");
}

/** The roster as `--list` prints it. */
function printRoster(packs: Pack[]): string {
	const lines = ["Subjects:\n"];
	for (const pack of packs) {
		const tag = pack.local ? " (local)" : "";
		lines.push(`  tutors:coach ${pack.slug.padEnd(16)}${pack.name}${tag}`);
		if (pack.scope) lines.push(`  ${" ".repeat(29)}${pack.scope}`);
	}

	lines.push("\nRun `tutors:coach` with no subject to plan a session.");
	return `${lines.join("\n")}\n`;
}

export function prepare(ctx: PrepareContext): PrepareResult {
	const root = ctx.cwd;
	const warn: Warn = ctx.preview
		? () => {}
		: (message) => console.warn(message);

	if (ctx.flags.init === true) {
		// Preview writes nothing (D-012); its early exit is a diagnostic (D-030).
		if (ctx.preview) {
			return {
				exit: {
					message: `--init seeds ${join(root, ".coach")} when run; preview writes nothing.\n`,
					code: 0,
					stream: "stdout",
				},
			};
		}
		return { exit: { message: initRoot(root), code: 0, stream: "stdout" } };
	}

	const packs = loadPacks(root, warn);

	if (ctx.flags.list === true) {
		return { exit: { message: printRoster(packs), code: 0, stream: "stdout" } };
	}

	const requested = ctx.args[0];
	const pack = requested
		? packs.find((candidate) => candidate.slug === requested)
		: undefined;

	// A slug-shaped first argument that matches nothing is a typo, not a
	// message. Anything else (`coach "plan my week"`) goes to the coordinator.
	if (requested && !pack && /^[a-z0-9][a-z0-9-]*$/.test(requested)) {
		return {
			exit: {
				message: `Unknown subject: ${requested}\n\n${printRoster(packs)}`,
				code: 1,
				stream: "stderr",
			},
		};
	}

	const studentDoc = loadStudent(root, warn);
	const locals = pack ? [] : loadLocalIntegrations(root, warn);

	// With a subject: student + core + roster + pack. Without one: the
	// coordinator, which plans rather than teaches and so skips the core, but
	// gains the capability modules that let it act on the program.
	const systemPromptFragments = pack
		? [
				studentDoc,
				coreDoc,
				renderRoster(packs),
				`# This session's subject\n\nSlug: \`${pack.slug}\` — your state directory is \`.coach/${pack.slug}/\`.\n\n${pack.body}`,
			]
		: [
				studentDoc,
				renderRoster(packs),
				coordinatorDoc,
				...builtInIntegrations(),
				...locals.map((local) => local.body),
				[
					"# This training root",
					"",
					`- Root: \`${root}\``,
					`- State: \`${join(root, ".coach")}\``,
					`- Date: ${new Date().toISOString().slice(0, 10)}`,
					`- Local integrations loaded: ${locals.length ? locals.map((l) => l.name).join(", ") : "none"}`,
					"",
					`When you hand the student a launch command, append \`--cwd ${root}\` unless they will already be in that directory.`,
					"",
					"The roster is exactly `.coach/packs/*.md` once that directory exists: adding a subject means writing a pack file there, and retiring one means deleting it. Neither needs a recompile.",
				].join("\n"),
			];

	const initialPrompt = (pack ? ctx.args.slice(1) : ctx.args).join(" ").trim();

	// Every coach gets `.coach/` — its state directory and the student
	// profile it is told to keep current. Packs add to that, never replace it;
	// the coordinator instead gets what its capability modules need. These are
	// Claude rules: Codex does not emulate them, so none are returned there.
	if (ctx.backend !== "claude") {
		return { systemPromptFragments, initialPrompt };
	}
	return {
		systemPromptFragments,
		initialPrompt,
		extraAllowRules: {
			rules: pack
				? [...new Set([...BASE_ALLOW, ...pack.allow])]
				: [...BASE_ALLOW, ...COORDINATOR_EXTRA_ALLOW],
		},
	};
}
