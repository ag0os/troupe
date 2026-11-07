// The evaluator Stop and recheck share: the changed scope against the base,
// then changed ordinary tests, lint, the Contract tests the scope selects and
// adopted floors, in that order, under one deadline. Stop stops at the first
// failure; recheck runs every phase and adds exhale. Changed system tests are
// a designed skip: named, never run here, never a failure by themselves.
import { lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContract } from "../contract.d/parse";
import { hookGit } from "./git";
import { adopted, checkFile } from "./health";
import { type Manifest, SENTINEL } from "./manifest";
import { argPath, excludedBy, matches } from "./paths";
import { firstLines, runBounded } from "./run";

export type Check = {
	check: string;
	status: "pass" | "fail" | "could-not-run" | "skipped";
	files: string[];
	lines: string[];
	why: string;
};

export type Evaluation = {
	scope: string[];
	excluded: string[];
	systemTests: string[];
	checks: Check[];
	failure: Check | null;
};

const DIFF = ["--no-ext-diff", "--no-textconv", "--no-renames", "-z"];

function nul(text: string): string[] {
	return text.split("\0").filter((p) => p !== "");
}

/** Every path changed between the base and the worktree, untracked included. */
export function changedScope(m: Manifest): string[] {
	const diff = hookGit(m.repo, ["diff", "--name-only", ...DIFF, m.base, "--"]);
	if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
	const untracked = hookGit(m.repo, [
		"ls-files",
		"-z",
		"--others",
		"--exclude-standard",
	]);
	if (!untracked.ok)
		throw new Error(`git ls-files failed: ${untracked.stderr.trim()}`);
	return [...new Set([...nul(diff.stdout), ...nul(untracked.stdout)])].sort();
}

function isFile(m: Manifest, rel: string): boolean {
	try {
		return lstatSync(join(m.repo, rel)).isFile();
	} catch {
		return false;
	}
}

type Component = { covers: string[]; tests: string[] };

function readComponent(text: string, where: string): Component {
	const doc = parseContract(text);
	if (doc.frontMatter === "absent") return { covers: [], tests: [] };
	if (!doc.fields) throw new Error(`${where} has front matter it cannot read`);
	const list = (key: string) => {
		const v = doc.fields?.get(key)?.value;
		return Array.isArray(v) ? v : [];
	};
	return { covers: list("covers"), tests: list("tests") };
}

/** Components at the base and in the worktree, by Contract file. */
function components(
	m: Manifest,
): Map<string, { base?: Component; now?: Component }> {
	const out = new Map<string, { base?: Component; now?: Component }>();
	const isContract = (name: string) =>
		name.endsWith(".md") && name !== "README.md";
	const listed = hookGit(m.repo, [
		"ls-tree",
		"-z",
		"--name-only",
		`${m.base}:docs/contracts`,
	]);
	if (listed.ok)
		for (const name of nul(listed.stdout).filter(isContract)) {
			const show = hookGit(m.repo, [
				"show",
				`${m.base}:docs/contracts/${name}`,
			]);
			if (!show.ok)
				throw new Error(`cannot read docs/contracts/${name} at the base`);
			out.set(name, {
				base: readComponent(show.stdout, `docs/contracts/${name} at the base`),
			});
		}
	let names: string[] = [];
	try {
		names = readdirSync(join(m.repo, "docs/contracts")).filter(isContract);
	} catch {
		// No Contract directory in the worktree.
	}
	for (const name of names) {
		const rel = `docs/contracts/${name}`;
		if (!isFile(m, rel)) continue;
		const entry = out.get(name) ?? {};
		entry.now = readComponent(readFileSync(join(m.repo, rel), "utf8"), rel);
		out.set(name, entry);
	}
	return out;
}

/** The Contract tests the scope selects, plus the manifest's fallback paths. */
export function contractTests(m: Manifest, scope: string[]): string[] {
	const selected: string[] = [];
	for (const { base, now } of components(m).values()) {
		const covers = [...(base?.covers ?? []), ...(now?.covers ?? [])];
		if (scope.some((p) => covers.some((c) => matches(c, p))))
			selected.push(...((now ?? base)?.tests ?? []));
	}
	if (m.contract_tests !== SENTINEL) selected.push(...m.contract_tests);
	return [...new Set(selected)];
}

function gate(argv: string[], files: string[]): string[] {
	return argv.flatMap((a) => (a === "{files}" ? files.map(argPath) : [a]));
}

async function run(
	m: Manifest,
	check: string,
	argv: string[],
	files: string[],
	deadline: number,
	budget: string,
	env?: Record<string, string | undefined>,
): Promise<Check> {
	const ran = await runBounded(argv, m.repo, deadline, env);
	const base = { check, files, lines: [] as string[], why: "" };
	if (ran.kind === "exited")
		return ran.code === 0
			? { ...base, status: "pass" }
			: {
					...base,
					status: "fail",
					lines: firstLines(ran.output),
					why: `${argv[0]} exited ${ran.code}`,
				};
	if (ran.kind === "timeout")
		return {
			...base,
			status: "could-not-run",
			lines: firstLines(ran.output),
			why: `${argv[0]} did not finish within the ${budget} budget`,
		};
	return { ...base, status: "could-not-run", why: ran.why };
}

export async function evaluate(
	m: Manifest,
	options: {
		deadline: number;
		budget: string;
		all: boolean;
		exhale: boolean;
		scopeOnly?: boolean;
	},
): Promise<Evaluation> {
	const { deadline, budget } = options;
	const scope = changedScope(m);
	const out: Evaluation = {
		scope,
		excluded: scope.filter((p) => excludedBy(m.repo, p, m.excluded) !== null),
		systemTests: [],
		checks: [],
		failure: null,
	};
	const present = scope.filter((p) => isFile(m, p));
	const test = m.gates.test;
	const isSystem = (p: string) =>
		(test?.system ?? []).some((s) => matches(s, p));
	const changedTests = test
		? present.filter((p) => test.include.some((i) => matches(i, p)))
		: [];
	out.systemTests.push(...changedTests.filter(isSystem));
	if (options.scopeOnly) return out;
	const record = (c: Check): boolean => {
		out.checks.push(c);
		if ((c.status === "fail" || c.status === "could-not-run") && !out.failure)
			out.failure = c;
		return out.failure !== null && !options.all;
	};
	// The budget covers scope collection and selection too: a phase that
	// cannot start in time is an inability, and nothing after it runs.
	const spent = (check: string): boolean => {
		if (Date.now() < deadline) return false;
		record({
			check,
			status: "could-not-run",
			files: [],
			lines: [],
			why: `the evaluation budget was spent before ${check} started`,
		});
		return true;
	};
	const ran = new Set<string>();

	// Changed ordinary tests.
	if (spent("tests")) return out;
	const ordinary = changedTests.filter((p) => !isSystem(p));
	if (test && ordinary.length) {
		const c = await run(
			m,
			"tests",
			gate(test.argv, ordinary),
			ordinary,
			deadline,
			budget,
		);
		if (c.status === "pass") for (const p of ordinary) ran.add(p);
		if (record(c)) return out;
	}

	// Lint on changed files.
	if (spent("lint")) return out;
	const lint = m.gates.lint;
	const linted = lint
		? present.filter((p) => lint.include.some((i) => matches(i, p)))
		: [];
	if (
		lint &&
		linted.length &&
		record(
			await run(m, "lint", gate(lint.argv, linted), linted, deadline, budget),
		)
	)
		return out;

	// Contract tests.
	if (spent("contracts")) return out;
	if (scope.length) {
		let selected: string[];
		try {
			selected = contractTests(m, scope);
		} catch (error) {
			if (
				record({
					check: "contracts",
					status: "could-not-run",
					files: [],
					lines: [],
					why: (error as Error).message,
				})
			)
				return out;
			selected = [];
		}
		const missing = selected.filter((p) => !isFile(m, p));
		const system = selected.filter((p) => isFile(m, p) && isSystem(p));
		for (const p of system)
			if (!out.systemTests.includes(p)) out.systemTests.push(p);
		const todo = selected.filter(
			(p) => isFile(m, p) && !isSystem(p) && !ran.has(p),
		);
		if (missing.length) {
			if (
				record({
					check: "contracts",
					status: "could-not-run",
					files: missing,
					lines: [],
					why: `selected tests are missing: ${missing.join(", ")}`,
				})
			)
				return out;
		} else if (todo.length) {
			const c = test
				? await run(
						m,
						"contracts",
						gate(test.argv, todo),
						todo,
						deadline,
						budget,
					)
				: {
						check: "contracts",
						status: "could-not-run" as const,
						files: todo,
						lines: [],
						why: "no test gate to run Contract tests with",
					};
			if (record(c)) return out;
		}
	}

	// Adopted floors on changed files.
	if (spent("floors")) return out;
	for (const stack of m.health.stacks) {
		const files = present.filter((p) =>
			stack.extensions.some((e) => p.endsWith(e)),
		);
		if (!files.length) continue;
		const name = `floors ${stack.argv[0]}`;
		if (!adopted(m, stack)) {
			record({
				check: name,
				status: "skipped",
				files,
				lines: [],
				why: "metrics not adopted: no committed todo floor",
			});
			continue;
		}
		for (const f of files) {
			const r = await checkFile(m, stack, f, deadline);
			const c: Check =
				r.kind === "clean"
					? { check: name, status: "pass", files: [f], lines: [], why: "" }
					: r.kind === "findings"
						? {
								check: name,
								status: "fail",
								files: [f],
								lines: r.lines,
								why: "findings over the floor",
							}
						: {
								check: name,
								status: "could-not-run",
								files: [f],
								lines: [],
								why:
									r.kind === "timeout"
										? `did not finish within the ${budget} budget`
										: r.why,
							};
			if (record(c)) return out;
		}
	}

	// Exhale: recheck only.
	if (!options.exhale) {
		record({
			check: "exhale",
			status: "skipped",
			files: [],
			lines: [],
			why: "exhale deferred to step 6",
		});
		return out;
	}
	if (!m.health.recheck.length || !scope.length) {
		record({
			check: "exhale",
			status: "skipped",
			files: [],
			lines: [],
			why: scope.length ? "exhale not adopted" : "empty scope",
		});
		return out;
	}
	if (spent("exhale")) return out;
	const cache = mkdtempSync(join(tmpdir(), "builder-hooks-exhale-"));
	for (const template of m.health.recheck) {
		const argv = template.map((a) =>
			a === "{base}" ? m.base : a === "{cache}" ? cache : a,
		);
		const c = await run(m, "exhale", argv, [], deadline, budget, {
			...process.env,
			XDG_CACHE_HOME: cache,
		});
		if (record(c)) return out;
	}
	return out;
}
