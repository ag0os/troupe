// contract: the software package's Contract tool. Run by ../contract, which
// records the caller's directory in CONTRACT_TARGET_CWD. Read only: it reads
// the worktree and git objects and writes nothing but its report.
import { diff } from "./diff";
import { type Analysis, analyze, type Finding } from "./lint";
import { PRODUCT, repositoryRoot, ToolError } from "./repo";

const COMMANDS = ["lint", "coverage", "map", "diff"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `usage: contract <command> [options]

  contract lint [file...] [--json]
  contract coverage [file...] [--line] [--json]
  contract map [--json]
  contract diff [--base <ref>] [--head <ref>] [--json]
  contract --help

Reads the Contract files under docs/contracts/ (README.md excluded) and the
"## Contract:" sections of the root PRODUCT.md, in the repository holding the
current directory. A file argument is relative to the current directory and
must be a Contract file or PRODUCT.md; the whole index is still read for
dependencies and obligation prefixes.

lint      check front matter, coverage line, obligations, proofs and the
          Decisions index; legacy files are accepted with warnings
coverage  count each component's obligations by proof and compare the
          coverage line; --line prints only the computed line for one
          component (exit 0 whenever a line is printed)
map       list components, what they cover, their dependencies and
          directory conflicts
diff      report Contract changes between the merge base of --base
          (default origin/HEAD, then main) and --head (default HEAD), read
          from committed trees only; PRODUCT.md sections are compared by
          name and ID only, so a section moved to a file shows as a removal
          and an addition

--json    one JSON object on stdout

Exit: 0 clean or warnings only, 1 error findings (diff never), 2 usage or
environment error.
`;

type Options = {
	command: Command;
	files: string[];
	json: boolean;
	line: boolean;
	base?: string;
	head?: string;
};

const HELP = ["--help", "-h"];
const VALUED = ["--base", "--head"];

/** Whether --json is given as a flag, not as the value of --base or --head. */
function wantsJson(argv: string[]): boolean {
	return argv.some(
		(arg, i) => arg === "--json" && !VALUED.includes(argv[i - 1] ?? ""),
	);
}

function parse(argv: string[]): Options | "help" {
	const [command, ...rest] = argv;
	if (HELP.includes(command ?? "")) return "help";
	if (command === undefined)
		throw new ToolError("usage", "a command is needed; see --help");
	if (!(COMMANDS as readonly string[]).includes(command))
		throw new ToolError("usage", `unknown command: ${command}; see --help`);
	const options: Options = {
		command: command as Command,
		files: [],
		json: false,
		line: false,
	};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string;
		const refused = () =>
			new ToolError("usage", `contract ${command} takes no ${arg}; see --help`);
		if (HELP.includes(arg)) return "help";
		if (arg === "--json") options.json = true;
		else if (arg === "--line") {
			if (command !== "coverage") throw refused();
			options.line = true;
		} else if (arg === "--base" || arg === "--head") {
			if (command !== "diff") throw refused();
			const value = rest[++i];
			if (value === undefined)
				throw new ToolError("usage", `${arg} needs a value; see --help`);
			options[arg === "--base" ? "base" : "head"] = value;
		} else if (arg.startsWith("-"))
			throw new ToolError("usage", `unknown option: ${arg}; see --help`);
		else if (command === "lint" || command === "coverage")
			options.files.push(arg);
		else
			throw new ToolError(
				"usage",
				`contract ${command} takes no file arguments: ${arg}`,
			);
	}
	return options;
}

export type Outcome = {
	findings: Finding[];
	result: Record<string, unknown>;
	/** Text printed before the findings and summary. */
	text: string;
	/** Overrides the exit the findings give (coverage --line, diff). */
	exit?: number;
	/** Replaces the whole text report (coverage --line). */
	stdout?: string;
};

function coverage(analysis: Analysis, line: boolean): Outcome {
	const components = [
		...(analysis.selected.has(PRODUCT) ? analysis.sections : []).map((s) => ({
			file: PRODUCT,
			component: s.name,
			format: "product",
			claimed: null,
			computed: {
				obligations: s.ids.length,
				test: 0,
				prEvidence: 0,
				mixed: 0,
				unproved: 0,
				retired: 0,
				unclassified: s.ids.length,
			},
			complete: false,
			computedLine: null as string | null,
		})),
		...analysis.files
			.filter((f) => analysis.selected.has(f.file))
			.map((f) => {
				const c = f.doc.coverage;
				const claimed = c.problem === "missing" ? null : c.claimed;
				return {
					file: f.file,
					component: f.component,
					format: f.format as string,
					claimed: claimed && {
						obligations: claimed.obligations,
						test: claimed.test,
						prEvidence: claimed.prEvidence,
						mixed: claimed.mixed,
						unproved: claimed.unproved,
						target: claimed.target,
					},
					computed: f.computed,
					complete: f.complete && f.computed.unclassified === 0,
					computedLine: f.computedLine,
				};
			}),
	].sort((a, b) =>
		a.file === b.file
			? a.component.localeCompare(b.component)
			: a.file < b.file
				? -1
				: 1,
	);
	const result = { components, complete: analysis.result.complete };
	if (line) {
		if (components.length !== 1)
			throw new ToolError(
				"usage",
				`coverage --line needs exactly one component; ${components.length} selected`,
			);
		const computedLine = components[0]?.computedLine ?? null;
		return {
			findings: analysis.findings,
			result: { ...result, computedLine },
			text: "",
			stdout: computedLine ? `${computedLine}\n` : "",
			exit: computedLine ? 0 : 1,
		};
	}
	const text = components
		.map((c) => {
			const n = c.computed;
			return `${c.component} (${c.file}): ${n.obligations} obligations; ${n.test} test, ${n.prEvidence} PR evidence, ${n.mixed} mixed, ${n.unproved} unproved, ${n.retired} retired, ${n.unclassified} unclassified; ${c.complete ? "complete" : "incomplete"}\n`;
		})
		.join("");
	return { findings: analysis.findings, result, text };
}

function map(analysis: Analysis): Outcome {
	const names = new Set(analysis.files.map((f) => f.component));
	const components = analysis.files.map((f) => ({
		component: f.component,
		file: f.file,
		format: f.format,
		covers: f.metadata?.covers ?? [],
		tests: f.metadata?.tests ?? [],
		dependsOn: f.metadata?.depends_on ?? [],
	}));
	const edges = components.flatMap((c) =>
		c.dependsOn
			.filter((d) => names.has(d))
			.map((to) => ({ from: c.component, to })),
	);
	const unresolvedEdges = components.flatMap((c) =>
		c.dependsOn
			.filter((d) => !names.has(d))
			.map((to) => ({ from: c.component, to })),
	);
	const gaps = [
		...analysis.sections.map((s) => `${PRODUCT} section "${s.name}"`),
		...analysis.files
			.filter((f) => f.format !== "canonical")
			.map((f) => `${f.file} (legacy, no metadata)`),
	];
	const text = [
		...components.flatMap((c) => [
			`${c.component} (${c.file})`,
			...(c.covers.length ? [`  covers: ${c.covers.join(", ")}`] : []),
			...(c.dependsOn.length
				? [
						`  depends on: ${c.dependsOn.map((d) => (names.has(d) ? d : `${d} (no Contract file)`)).join(", ")}`,
					]
				: []),
		]),
		...analysis.conflicts.map((c) =>
			c.kind === "duplicate"
				? `conflict: ${c.path} is claimed by ${c.components.join(" and ")}`
				: `conflict: ${c.path} (${c.components[0]}) contains ${c.other} (${c.components[1]})`,
		),
		...gaps.map((g) => `migration gap: ${g}`),
	]
		.map((l) => `${l}\n`)
		.join("");
	return {
		findings: analysis.findings,
		result: {
			components,
			edges,
			unresolvedEdges,
			directoryConflicts: analysis.conflicts,
			complete: analysis.result.complete,
		},
		text,
	};
}

function compareFindings(a: Finding, b: Finding): number {
	return (
		(a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
		(a.line ?? 0) - (b.line ?? 0) ||
		(a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
		(a.obligationId ?? "").localeCompare(b.obligationId ?? "") ||
		a.message.localeCompare(b.message)
	);
}

function findingLine(f: Finding): string {
	return `${f.file}${f.line ? `:${f.line}` : ""}: ${f.code}: ${f.message}`;
}

function report(options: Options, outcome: Outcome): number {
	const findings = [...outcome.findings].sort(compareFindings);
	const failing = findings.filter((f) => f.severity === "error").length;
	const status =
		findings.length === 0 ? "clean" : failing ? "findings" : "warnings";
	const exit = outcome.exit ?? (failing ? 1 : 0);
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({
				contract: 1,
				tool: "contract",
				command: options.command,
				status,
				findings,
				failing,
				result: outcome.result,
			})}\n`,
		);
		return exit;
	}
	const lines = findings.map(findingLine);
	if (outcome.stdout !== undefined) {
		process.stdout.write(outcome.stdout);
		if (lines.length) process.stderr.write(`${lines.join("\n")}\n`);
		return exit;
	}
	const summary = findings.length
		? `contract ${options.command}: ${findings.length} findings, ${failing} failing`
		: `contract ${options.command}: clean`;
	process.stdout.write(`${outcome.text}${[...lines, summary].join("\n")}\n`);
	return exit;
}

function fail(argv: string[], error: ToolError): number {
	if (wantsJson(argv)) {
		const command = (COMMANDS as readonly string[]).includes(argv[0] ?? "")
			? argv[0]
			: null;
		process.stdout.write(
			`${JSON.stringify({
				contract: 1,
				tool: "contract",
				command,
				status: "error",
				findings: [],
				failing: 0,
				result: { complete: false },
				error: { code: error.code, message: error.message },
			})}\n`,
		);
	} else process.stderr.write(`contract: ${error.message}\n`);
	return 2;
}

function main(argv: string[]): number {
	try {
		const options = parse(argv);
		if (options === "help") {
			process.stdout.write(USAGE);
			return 0;
		}
		const cwd = process.env.CONTRACT_TARGET_CWD || process.cwd();
		const top = repositoryRoot(cwd);
		if (options.command === "diff")
			return report(options, {
				findings: [],
				...diff(top, options.base, options.head),
				exit: 0,
			});
		const analysis = analyze(top, cwd, options.files);
		if (options.command === "coverage")
			return report(options, coverage(analysis, options.line));
		if (options.command === "map") return report(options, map(analysis));
		return report(options, {
			findings: analysis.findings,
			result: analysis.result,
			text: "",
		});
	} catch (error) {
		if (error instanceof ToolError) return fail(argv, error);
		throw error;
	}
}

process.exitCode = main(Bun.argv.slice(2));
