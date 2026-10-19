// contract: the software package's Contract tool. Run by ../contract, which
// records the caller's directory in CONTRACT_TARGET_CWD. Read only: it reads
// the worktree and git objects and writes nothing but its report.
import { analyze, type Finding } from "./lint";
import { repositoryRoot, ToolError } from "./repo";

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

function parse(argv: string[]): Options | "help" {
	if (argv.includes("--help") || argv.includes("-h")) return "help";
	const [command, ...rest] = argv;
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
	if (argv.includes("--json")) {
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
		const analysis = analyze(top, cwd, options.files);
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
