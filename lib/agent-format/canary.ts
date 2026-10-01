/**
 * The Codex developer-message canary (B-010, ACC-003, D-003). A compiled
 * agent whose body is a unique canary is previewed with `--backend codex`;
 * the argv the Codex adapter produced is handed to the real
 * `codex debug prompt-input`, which renders the model-visible input list
 * locally (no model call, no network). The canary must arrive as its own
 * developer-role input item, nowhere else, with Codex's base developer
 * items still present.
 *
 * prompt-input renders only the input list, not the model instructions, so
 * a replaced base (`base_instructions`, `model_instructions_file`) is
 * invisible to it; only the argv guard catches that.
 */
import { type CliIo, parseCli } from "./cli";
import { previewAgent } from "./run";
import { materializeAgentSpec, parseAgentMarkdown } from "./schema";
import type { AgentSpec } from "./types";

export const CANARY_AGENT_FILE = "agents/canary/codex.md";
/** Sent as the initial prompt, so the adapter's `-- <prompt>` is exercised too. */
export const CANARY_USER_PROMPT = "troupe canary user prompt";

/** Multi-line, quoted and non-ASCII, so TOML escaping must round-trip exactly. */
export function canaryText(nonce: string): string {
	return `TROUPE-CANARY-${nonce}\nSecond line with "quotes", a backslash \\ and é.`;
}

/** The canary declaration compiled like any agent; Claude is listed first. */
export function canaryAgent(canary: string): AgentSpec {
	const markdown = `---\ndescription: Codex developer-message canary\nbackends: [claude, codex]\n---\n${canary}\n`;
	return materializeAgentSpec(parseAgentMarkdown(CANARY_AGENT_FILE, markdown), {
		id: "canary:codex",
		includes: [],
	});
}

/**
 * The Codex argv (without the executable) that the binary would launch for
 * `--backend codex <prompt>`, taken from the runner's preview, which builds
 * it with the Codex adapter. The canary declares no MCP, so the displayed
 * argv is the launched argv.
 */
export async function canaryArgv(
	spec: Readonly<AgentSpec>,
	cwd: string,
): Promise<string[]> {
	const outcome = parseCli(spec, ["--backend", "codex", CANARY_USER_PROMPT], {
		cwd,
	});
	if (outcome.kind !== "run") throw new Error("expected a run outcome");
	let stdout = "";
	let stderr = "";
	const io: Pick<CliIo, "stdout" | "stderr" | "isDirectory"> = {
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		isDirectory: () => true,
	};
	const code = await previewAgent(spec, {}, outcome.invocation, io);
	if (code !== 0) throw new Error(`canary preview failed: ${stderr}`);
	const lines = stdout.trimEnd().split("\n");
	const argv: unknown = JSON.parse(lines[lines.length - 1] ?? "");
	if (
		!Array.isArray(argv) ||
		!argv.every((token) => typeof token === "string") ||
		argv[0] !== "codex"
	) {
		throw new Error(`canary preview did not end in a codex argv: ${stdout}`);
	}
	return argv.slice(1);
}

/** One `input_text` item of the prompt-input list, with its message role. */
export interface PromptText {
	role: string;
	text: string;
}

/** Flatten `codex debug prompt-input` JSON into role-tagged text items. */
export function promptTexts(json: string): PromptText[] {
	const list: unknown = JSON.parse(json);
	if (!Array.isArray(list)) {
		throw new Error("codex debug prompt-input did not print a JSON list");
	}
	const texts: PromptText[] = [];
	for (const item of list) {
		if (!isRecord(item) || item.type !== "message") continue;
		if (typeof item.role !== "string" || !Array.isArray(item.content)) {
			throw new Error(
				`malformed prompt-input message: ${JSON.stringify(item)}`,
			);
		}
		for (const part of item.content) {
			if (isRecord(part) && typeof part.text === "string") {
				texts.push({ role: item.role, text: part.text });
			}
		}
	}
	return texts;
}

/**
 * Why the canary run does not show correct delivery; empty when it does.
 * The canary must be one whole developer item (a substring of a larger
 * text does not count) and must appear in no other item of any role, and
 * every developer item of the baseline run must still be there.
 */
export function canaryProblems(
	run: readonly PromptText[],
	baseline: readonly PromptText[],
	canary: string,
): string[] {
	const problems: string[] = [];
	const developer = run.filter((item) => item.role === "developer");
	const exact = developer.filter((item) => item.text === canary).length;
	if (exact !== 1) {
		problems.push(
			`expected the canary as exactly one developer item, found ${exact}`,
		);
	}
	const copies = run.filter((item) => item.text.includes(canary));
	let whole = false;
	for (const item of copies) {
		if (!whole && item.role === "developer" && item.text === canary) {
			whole = true;
			continue;
		}
		problems.push(`the canary also appears in a ${item.role} item`);
	}
	const base = baseline
		.filter((item) => item.role === "developer")
		.map((item) => item.text);
	if (base.length === 0) {
		problems.push("the baseline run has no developer items to preserve");
	}
	const kept = new Set(developer.map((item) => item.text));
	const lost = base.filter((text) => !kept.has(text));
	if (lost.length > 0) {
		const named = lost.map((text) => JSON.stringify(text.slice(0, 120)));
		problems.push(
			`${lost.length} base developer item(s) are missing: ${named.join(", ")}`,
		);
	}
	if (
		!run.some(
			(item) => item.role === "user" && item.text === CANARY_USER_PROMPT,
		)
	) {
		problems.push("the initial prompt did not arrive as a user item");
	}
	return problems;
}

export interface PromptInputOptions {
	/** The `codex` executable to run. */
	codex: string;
	cwd: string;
	env: Record<string, string | undefined>;
}

/** Run `codex debug prompt-input <args>` and return its role-tagged items. */
export async function promptInput(
	args: readonly string[],
	options: PromptInputOptions,
): Promise<PromptText[]> {
	const child = Bun.spawn([options.codex, "debug", "prompt-input", ...args], {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(
			`codex debug prompt-input exited ${code}: ${stderr.trim() || stdout.trim()}`,
		);
	}
	return promptTexts(stdout);
}

/**
 * Run several prompt-inputs one after another against the same home. Each
 * run (re)installs the bundled system skills into `$CODEX_HOME/skills`,
 * and a concurrent run can list that directory mid-install and render a
 * partial skills item. Separate homes would not help: the skills item
 * embeds the home path.
 */
export async function promptInputs(
	argvs: readonly (readonly string[])[],
	options: PromptInputOptions,
): Promise<PromptText[][]> {
	const results: PromptText[][] = [];
	for (const args of argvs) results.push(await promptInput(args, options));
	return results;
}

export interface CanaryResult {
	canary: string;
	argv: string[];
	items: PromptText[];
}

/** Config keys that replace Codex's base model instructions (D-003: never in append). */
const BASE_REPLACING_KEYS = [
	"base_instructions",
	"model_instructions_file",
	"experimental_instructions_file",
];

/**
 * Why an append-mode Codex argv is wrong; empty when it is right. It must
 * set `developer_instructions` and nothing that replaces the base model
 * instructions, which prompt-input cannot show.
 */
export function appendArgvProblems(argv: readonly string[]): string[] {
	const configs = argv.filter((_, i) => argv[i - 1] === "-c");
	const key = (value: string) => value.split("=", 1)[0] ?? "";
	const problems: string[] = [];
	if (!configs.some((value) => key(value) === "developer_instructions")) {
		problems.push("the codex argv has no developer_instructions");
	}
	for (const value of configs) {
		if (BASE_REPLACING_KEYS.includes(key(value))) {
			problems.push(`the codex argv sets ${key(value)}`);
		}
	}
	return problems;
}

/**
 * The whole canary: compile, preview on Codex, check the argv carries
 * `developer_instructions` and nothing that replaces the base (D-003), then
 * compare the rendered input against a baseline without the agent. Throws
 * with every problem found; an installed Codex never passes silently.
 */
export async function runCanary(
	options: PromptInputOptions & { nonce?: string },
): Promise<CanaryResult> {
	const canary = canaryText(options.nonce ?? crypto.randomUUID());
	const spec = canaryAgent(canary);
	const argv = await canaryArgv(spec, options.cwd);
	const problems = appendArgvProblems(argv);
	const [baseline = [], items = []] = await promptInputs(
		[["--", CANARY_USER_PROMPT], argv],
		options,
	);
	problems.push(...canaryProblems(items, baseline, spec.systemPrompt));
	if (problems.length > 0) {
		throw new Error(`Codex canary failed:\n- ${problems.join("\n- ")}`);
	}
	return { canary: spec.systemPrompt, argv, items };
}

/** `codex` on `path`, or null when it is absent and the canary must skip. */
export function findCodex(path: string | undefined): string | null {
	return Bun.which("codex", { PATH: path ?? "" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
