// install-skills: the software package's skill installer. Run by
// ../install-skills, which records the caller's directory in
// INSTALL_SKILLS_TARGET_CWD. It writes only inside each destination skill
// directory, creating the skills roots above it when they are missing.
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const USAGE = `usage: install-skills [--repo <dir>] [--json]
       install-skills --help

Installs every skill under the software package's skills/ directory for
Claude Code and Codex. Each skill directory is made to hold exactly the
source's files: changed files are rewritten, files no longer in the source
are removed, and nothing else under either skills root is touched.

Without --repo, user level:
  Claude Code  $HOME/.claude/skills/<skill>/
  Codex        <root>/skills/<skill>/, root being $CODEX_HOME when set,
               else the absolute path in $HOME/.codex-active when that
               file exists, else $HOME/.codex

With --repo <dir> (relative to the current directory), that repository:
  Claude Code  <dir>/.claude/skills/<skill>/
  Codex        <dir>/.agents/skills/<skill>/

Prints, per destination, the files it added, updated or removed, or that
it was already current.

--json    one JSON object on stdout

Exit: 0 installed or current, 2 usage or environment error.
`;

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class ToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

type Options = { repo?: string; json: boolean };
type Harness = "claude" | "codex";
type Destination = {
	harness: Harness;
	skill: string;
	path: string;
	status: "changed" | "current";
	added: string[];
	updated: string[];
	removed: string[];
};

function parse(argv: string[]): Options | "help" {
	const options: Options = { json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--help" || arg === "-h") return "help";
		if (arg === "--json") options.json = true;
		else if (arg === "--repo") {
			const value = argv[++i];
			if (value === undefined || value === "")
				throw new ToolError("usage", "--repo needs a directory");
			options.repo = value;
		} else throw new ToolError("usage", `unknown argument ${arg}; see --help`);
	}
	return options;
}

function home(): string {
	const value = process.env.HOME;
	if (!value || !isAbsolute(value))
		throw new ToolError("environment", "HOME is not an absolute path");
	return value;
}

/** Codex's home: $CODEX_HOME, else the path ~/.codex-active names, else ~/.codex. */
function codexRoot(): string {
	const env = process.env.CODEX_HOME;
	if (env) {
		if (!isAbsolute(env))
			throw new ToolError("environment", "CODEX_HOME is not an absolute path");
		return env;
	}
	const active = join(home(), ".codex-active");
	if (existsSync(active)) {
		const value = readFileSync(active, "utf8").trim();
		if (!isAbsolute(value))
			throw new ToolError(
				"environment",
				`${active} does not hold an absolute path`,
			);
		return value;
	}
	return join(home(), ".codex");
}

function roots(options: Options): Record<Harness, string> {
	if (options.repo !== undefined) {
		const repo = resolve(
			process.env.INSTALL_SKILLS_TARGET_CWD || process.cwd(),
			options.repo,
		);
		if (!existsSync(repo) || !statSync(repo).isDirectory())
			throw new ToolError("environment", `${repo} is not a directory`);
		return {
			claude: join(repo, ".claude/skills"),
			codex: join(repo, ".agents/skills"),
		};
	}
	return {
		claude: join(home(), ".claude/skills"),
		codex: join(codexRoot(), "skills"),
	};
}

/** Every entry below dir, relative, without following symlinks. */
function walk(dir: string, prefix = ""): { files: string[]; dirs: string[] } {
	const out = { files: [] as string[], dirs: [] as string[] };
	for (const name of readdirSync(dir).sort()) {
		const rel = prefix ? `${prefix}/${name}` : name;
		if (lstatSync(join(dir, name)).isDirectory()) {
			out.dirs.push(rel);
			const inner = walk(join(dir, name), rel);
			out.files.push(...inner.files);
			out.dirs.push(...inner.dirs);
		} else out.files.push(rel);
	}
	return out;
}

type Source = { name: string; dir: string; files: string[]; dirs: Set<string> };

function sources(): Source[] {
	const root = resolve(import.meta.dir, "../../skills");
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.sort()
		.filter((name) => lstatSync(join(root, name)).isDirectory())
		.map((name) => {
			const dir = join(root, name);
			if (!SKILL_NAME.test(name))
				throw new ToolError("source", `skill directory ${name} is misnamed`);
			const { files, dirs } = walk(dir);
			if (!files.includes("SKILL.md"))
				throw new ToolError("source", `skill ${name} has no SKILL.md`);
			for (const file of files)
				if (!lstatSync(join(dir, file)).isFile())
					throw new ToolError(
						"source",
						`${name}/${file} is not a regular file`,
					);
			return { name, dir, files, dirs: new Set(dirs) };
		});
}

/** Refuses a destination that exists as anything but a real directory. */
function checkDestination(path: string): void {
	if (!existsSync(path) && !isLink(path)) return;
	if (!lstatSync(path).isDirectory())
		throw new ToolError(
			"environment",
			`${path} exists and is not a directory; nothing was installed`,
		);
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function sameFile(path: string, content: Buffer): boolean {
	try {
		return lstatSync(path).isFile() && readFileSync(path).equals(content);
	} catch {
		return false;
	}
}

function install(source: Source, harness: Harness, path: string): Destination {
	const result: Destination = {
		harness,
		skill: source.name,
		path,
		status: "current",
		added: [],
		updated: [],
		removed: [],
	};
	mkdirSync(path, { recursive: true });
	const present = walk(path);
	const wanted = new Set(source.files);
	for (const file of present.files)
		if (!wanted.has(file)) {
			unlinkSync(join(path, file));
			result.removed.push(file);
		}
	for (const dir of present.dirs.slice().reverse())
		if (!source.dirs.has(dir)) {
			rmdirSync(join(path, dir));
			if (!present.files.some((file) => file.startsWith(`${dir}/`)))
				result.removed.push(`${dir}/`);
		}
	for (const file of source.files) {
		const from = join(source.dir, file);
		const to = join(path, file);
		const content = readFileSync(from);
		if (sameFile(to, content)) continue;
		const existed = existsSync(to) || isLink(to);
		mkdirSync(dirname(to), { recursive: true });
		const temp = `${to}.install-skills-${process.pid}`;
		writeFileSync(temp, content);
		chmodSync(temp, statSync(from).mode & 0o777);
		renameSync(temp, to);
		(existed ? result.updated : result.added).push(file);
	}
	if (result.added.length + result.updated.length + result.removed.length)
		result.status = "changed";
	return result;
}

function describe(d: Destination): string {
	if (d.status === "current")
		return `${d.harness} ${d.skill}: ${d.path} current`;
	const parts = (["added", "updated", "removed"] as const)
		.filter((kind) => d[kind].length > 0)
		.map((kind) => `${kind} ${d[kind].join(", ")}`);
	return `${d.harness} ${d.skill}: ${d.path} changed: ${parts.join("; ")}`;
}

function fail(json: boolean, error: ToolError): number {
	if (json)
		process.stdout.write(
			`${JSON.stringify({
				contract: 1,
				tool: "install-skills",
				status: "error",
				destinations: [],
				error: { code: error.code, message: error.message },
			})}\n`,
		);
	else process.stderr.write(`install-skills: ${error.message}\n`);
	return 2;
}

function main(argv: string[]): number {
	const json = argv.includes("--json");
	try {
		const options = parse(argv);
		if (options === "help") {
			process.stdout.write(USAGE);
			return 0;
		}
		const where = roots(options);
		const skills = sources();
		const plan = skills.flatMap((source) =>
			(["claude", "codex"] as const).map((harness) => ({
				source,
				harness,
				path: join(where[harness], source.name),
			})),
		);
		for (const { path } of plan) checkDestination(path);
		const destinations = plan.map(({ source, harness, path }) =>
			install(source, harness, path),
		);
		const changed = destinations.some((d) => d.status === "changed");
		if (options.json)
			process.stdout.write(
				`${JSON.stringify({
					contract: 1,
					tool: "install-skills",
					status: changed ? "changed" : "current",
					skills: skills.map((s) => s.name),
					destinations,
				})}\n`,
			);
		else if (destinations.length === 0)
			process.stdout.write("no skills to install\n");
		else process.stdout.write(`${destinations.map(describe).join("\n")}\n`);
		return 0;
	} catch (error) {
		if (error instanceof ToolError) return fail(json, error);
		throw error;
	}
}

process.exitCode = main(Bun.argv.slice(2));
