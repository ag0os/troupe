// The run's policy: the Shepherd's input to `prepare`, checked field by field,
// and the manifest `prepare` writes from it, which every hook reads back
// through the same checks. Unknown fields are refused, so no budget, role or
// command can be configured by a field this file does not name.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

export class ToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** The discovery sentinel for `contract_tests`. */
export const SENTINEL =
	"from docs/contracts/*.md whose covers intersects the diff";

export type FileGate = { argv: string[]; include: string[] };
export type TestGate = FileGate & { system: string[] };
export type Stack = {
	extensions: string[];
	argv: string[];
	format: "rubocop-json";
	floor: string | null;
};
export type Manifest = {
	role: "builder";
	repo: string;
	base: string;
	history_writes: boolean;
	excluded: string[];
	gates: { test?: TestGate; lint?: FileGate };
	contract_tests: typeof SENTINEL | string[];
	health: { stacks: Stack[]; recheck: string[][] };
	log: string;
};
/** What the Shepherd writes: the manifest less `log`, `base` any revision. */
export type Input = Omit<Manifest, "log">;

const INPUT_FIELDS = [
	"role",
	"repo",
	"base",
	"history_writes",
	"excluded",
	"gates",
	"contract_tests",
	"health",
];
const SHELLISH = /[$`|;&<>*?(){}[\]\\\n\r"'~!#]/;
const REPAIR = new Set([
	"-a",
	"-A",
	"-x",
	"--auto-correct",
	"--auto-correct-all",
	"--autocorrect",
	"--autocorrect-all",
	"--fix",
	"--fix-layout",
	"--write",
	"--auto-gen-config",
	"--regenerate-todo",
	"--update",
	"install",
	"update",
	"add",
	"fmt",
	"format",
]);
const SHELLS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"eval",
	"exec",
	"env",
	"xargs",
]);

function bad(message: string): never {
	throw new ToolError("manifest-invalid", message);
}

function object(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		bad(`${where} is not an object`);
	return value as Record<string, unknown>;
}

function only(o: Record<string, unknown>, keys: string[], where: string) {
	for (const key of Object.keys(o))
		if (!keys.includes(key)) bad(`${where} has an unknown field: ${key}`);
}

function strings(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
		bad(`${where} is not a list of strings`);
	return value as string[];
}

/** A repository-relative path: no absolute form, no `..`, no glob. */
function relativePath(path: string, where: string): string {
	if (
		path === "" ||
		isAbsolute(path) ||
		/[*?[]/.test(path) ||
		path.split("/").includes("..") ||
		/[\0\n\r]/.test(path)
	)
		bad(`${where}: ${JSON.stringify(path)} is not a repository-relative path`);
	return normalize(path);
}

/** A positive glob or literal, relative to the repository. */
function pattern(value: string, where: string): string {
	if (value === "" || /[\0\n\r]/.test(value)) bad(`${where} has an empty path`);
	if (value.startsWith("!")) bad(`${where}: ${value} is a negation`);
	if (/[{}]/.test(value)) bad(`${where}: ${value} uses brace expansion`);
	if (isAbsolute(value)) bad(`${where}: ${value} is not repository-relative`);
	return value;
}

/**
 * A command template: argv, no shell, one placeholder element per `slots`
 * name that must appear, no repair, install or formatting operation.
 */
function template(
	value: unknown,
	where: string,
	required: string[],
	allowed: string[] = required,
): string[] {
	const argv = strings(value, where);
	if (argv.length === 0) bad(`${where} is empty`);
	const program = argv[0] as string;
	if (/^\{[a-z]+\}$/.test(program))
		bad(`${where} runs a placeholder; the program is fixed`);
	const name = program.slice(program.lastIndexOf("/") + 1);
	if (SHELLS.has(name))
		bad(`${where} runs ${name}; templates take no shell or wrapper`);
	for (const arg of argv) {
		if (allowed.includes(arg)) continue;
		if (/^\{[a-z]+\}$/.test(arg))
			bad(`${where} has an unknown placeholder ${arg}`);
		if (SHELLISH.test(arg))
			bad(`${where} has shell syntax in ${JSON.stringify(arg)}`);
		if (
			REPAIR.has(arg.split("=")[0] as string) ||
			/^-[A-Za-z]*[aAx][A-Za-z]*$/.test(arg)
		)
			bad(`${where} repairs, formats or installs (${arg})`);
	}
	for (const slot of required)
		if (argv.filter((a) => a === slot).length !== 1)
			bad(`${where} needs ${slot} exactly once`);
	return argv;
}

function gates(value: unknown): Manifest["gates"] {
	const o = object(value, "gates");
	only(o, ["test", "lint"], "gates");
	const out: Manifest["gates"] = {};
	if (o.test !== undefined) {
		const t = object(o.test, "gates.test");
		only(t, ["argv", "include", "system"], "gates.test");
		out.test = {
			argv: template(t.argv, "gates.test.argv", ["{files}"]),
			include: strings(t.include, "gates.test.include").map((p) =>
				pattern(p, "gates.test.include"),
			),
			system: strings(t.system ?? [], "gates.test.system").map((p) =>
				pattern(p, "gates.test.system"),
			),
		};
	}
	if (o.lint !== undefined) {
		const l = object(o.lint, "gates.lint");
		only(l, ["argv", "include"], "gates.lint");
		out.lint = {
			argv: template(l.argv, "gates.lint.argv", ["{files}"]),
			include: strings(l.include, "gates.lint.include").map((p) =>
				pattern(p, "gates.lint.include"),
			),
		};
	}
	return out;
}

function health(value: unknown): Manifest["health"] {
	const o = object(value, "health");
	only(o, ["stacks", "recheck"], "health");
	const stacks = (
		Array.isArray(o.stacks) ? o.stacks : bad("health.stacks is not a list")
	).map((s: unknown, i: number) => {
		const where = `health.stacks[${i}]`;
		const st = object(s, where);
		only(st, ["extensions", "argv", "format", "floor"], where);
		const extensions = strings(st.extensions, `${where}.extensions`);
		if (
			extensions.length === 0 ||
			extensions.some((e) => !/^\.[A-Za-z0-9]+$/.test(e))
		)
			bad(`${where}.extensions are not file extensions`);
		if (st.format !== "rubocop-json")
			bad(`${where}.format is not one this tool reads (rubocop-json)`);
		if (st.floor !== null && typeof st.floor !== "string")
			bad(`${where}.floor is not a path or null`);
		return {
			extensions,
			argv: template(st.argv, `${where}.argv`, ["{file}"]),
			format: "rubocop-json" as const,
			floor:
				st.floor === null
					? null
					: relativePath(st.floor as string, `${where}.floor`),
		};
	});
	const recheck = (
		Array.isArray(o.recheck) ? o.recheck : bad("health.recheck is not a list")
	).map((t: unknown, i: number) =>
		template(t, `health.recheck[${i}]`, [], ["{base}", "{cache}"]),
	);
	return { stacks, recheck };
}

/** Check the fields both the input and the manifest carry. */
export function checkInput(value: unknown, manifest = false): Input {
	const o = object(value, manifest ? "the manifest" : "the input");
	only(
		o,
		manifest ? [...INPUT_FIELDS, "log"] : INPUT_FIELDS,
		manifest ? "the manifest" : "the input",
	);
	if (o.role !== "builder")
		bad(`role is ${JSON.stringify(o.role)}, not "builder"`);
	if (typeof o.repo !== "string" || o.repo === "") bad("repo is not a path");
	if (typeof o.base !== "string" || o.base === "")
		bad("base is not a revision");
	if (o.history_writes !== undefined && typeof o.history_writes !== "boolean")
		bad("history_writes is not true or false");
	let contract: Manifest["contract_tests"] = SENTINEL;
	if (o.contract_tests !== undefined && o.contract_tests !== SENTINEL) {
		if (!Array.isArray(o.contract_tests))
			bad(
				"contract_tests is neither the discovery sentinel nor a list of paths",
			);
		contract = [
			...new Set(
				strings(o.contract_tests, "contract_tests").map((p) =>
					relativePath(p, "contract_tests"),
				),
			),
		];
	}
	return {
		role: "builder",
		repo: o.repo,
		base: o.base,
		history_writes: o.history_writes !== false,
		excluded: strings(o.excluded ?? [], "excluded").map((p) =>
			pattern(p, "excluded"),
		),
		gates: gates(o.gates ?? {}),
		contract_tests: contract,
		health: health(o.health ?? { stacks: [], recheck: [] }),
	};
}

/**
 * Read the manifest `SHEPHERD_HOOK_MANIFEST` names: absolute, valid, with its
 * log beside it, so the run directory is the manifest's own directory.
 */
export function loadManifest(path: string | undefined): {
	manifest: Manifest;
	runDir: string;
} {
	if (!path) bad("SHEPHERD_HOOK_MANIFEST is not set");
	if (!isAbsolute(path)) bad("SHEPHERD_HOOK_MANIFEST is not an absolute path");
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		bad(
			`the manifest cannot be read (${(error as Error).message.split("\n")[0]})`,
		);
	}
	const input = checkInput(raw, true);
	const log = (raw as { log?: unknown }).log;
	const runDir = dirname(path);
	if (typeof log !== "string" || log !== `${runDir}/hooks.log`)
		bad("the manifest's log is not hooks.log beside it");
	if (!isAbsolute(input.repo)) bad("the manifest's repo is not absolute");
	let real: string;
	try {
		if (!statSync(input.repo).isDirectory()) throw new Error();
		real = realpathSync(input.repo);
	} catch {
		bad(`the manifest's repo ${input.repo} is not a directory`);
	}
	if (real !== input.repo)
		bad(`the manifest's repo ${input.repo} has moved to ${real}`);
	let runReal: string;
	try {
		runReal = realpathSync(runDir);
	} catch {
		bad(`the run directory ${runDir} cannot be resolved`);
	}
	if (runReal === real || runReal.startsWith(`${real}/`))
		throw new ToolError(
			"run-dir-inside",
			`the run directory ${runDir} resolves inside the repository`,
		);
	if (!/^[0-9a-f]{40,64}$/.test(input.base))
		bad("the manifest's base is not a commit id");
	return { manifest: { ...input, log }, runDir };
}
