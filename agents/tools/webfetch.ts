/**
 * tools:webfetch — Print-mode WebFetch utility for external agent systems
 *
 * The extension half of `webfetch.md` (D-016). `prepare` turns the declared
 * flags and positionals into the task prompt, or exits early with the
 * `--describe` document or the missing-URL `ERROR:` line on stdout. `finish`
 * rewrites the captured print result into the documented payload contract:
 * the agent's stdout on success, otherwise a single `ERROR:` line on stdout
 * with a non-zero exit. The turn cap and the tool rules are static Claude
 * arguments and settings in the declaration (D-037). The declaration opts
 * out of backend passthrough, so tokens after `--` arrive here as
 * positionals and never reach Claude (D-039).
 *
 * Usage:
 *   tools:webfetch <url> [prompt...]
 *   tools:webfetch --url <url> --prompt "extract the pricing tiers"
 *   tools:webfetch --describe                # print self-documentation
 *   tools:webfetch                           # same as --describe
 */

import type {
	FinishResult,
	PrepareContext,
	PrepareResult,
	RunResult,
} from "../../lib/agent-format/types";

export const USAGE_DOC = `# tools:webfetch

Print-mode wrapper around Claude Code's WebFetch tool. Invoke it as a one-shot
sub-process from agents or automation that lack native WebFetch or MCP access.
The process writes its payload to stdout and exits.

## Synopsis

    tools:webfetch <url> [prompt...]
    tools:webfetch --url <url> --prompt "<what to extract>"
    tools:webfetch --describe

## Inputs

- **URL** (required for fetch mode): the page to retrieve. First positional
  argument, or \`--url\`.
- **Prompt** (optional): natural-language instruction describing what to pull
  from the page. Remaining positionals are joined, or \`--prompt\`.
- **--raw**: best-effort raw page text. HTML is still converted to markdown by
  Claude Code's WebFetch path, and some pages may still be truncated or
  summarized.
- **--model <name>**: Claude model (default \`haiku\`). Use \`sonnet\` or
  \`opus\` for denser extraction from complex pages.
- **--**: everything after a standalone \`--\` is taken as positional
  arguments (the URL, then prompt words), even when it starts with \`-\`.
  Nothing is passed to the underlying Claude CLI.

## Output

- stdout contains only the requested content. No preamble, no status lines,
  no markdown decoration unless your prompt explicitly asks for it.
- On failure, stdout begins with \`ERROR: <reason>\` and the process exits
  non-zero.
- Content that could not be located on the page is reported as \`UNKNOWN\`.

## Modes (implied by the prompt)

- **Summary (default)**: tight factual summary of the page's main content.
- **Extraction**: \`"list the CLI flags"\`, \`"extract the pricing table"\`,
  \`"give me the API endpoints"\` — returns only the extracted items.
- **Q&A**: \`"does this library support streaming?"\` — direct answer.
- **Raw**: \`--raw\` or prompts like \`"give me the raw text"\`. Best effort
  only; not a byte-for-byte dump.

## Prompting Tips

- Ask for one narrow thing: a table, flag list, answer, section, or code
  example.
- Prefer extraction prompts over "summarize everything on this site".
- If you need a direct answer, ask the question explicitly.
- If the page is likely authenticated, private, or GitHub-native, prefer a
  specialized tool instead of WebFetch.

## Examples

    tools:webfetch https://docs.bun.sh/cli
    tools:webfetch https://example.com/pricing "list the tiers and monthly cost"
    tools:webfetch --url https://api.example.com/docs --prompt "enumerate endpoints" --model sonnet
    tools:webfetch https://news.site/article --raw

## Limitations

- Follows one URL per call. Loop externally for multiple URLs.
- Under the hood, Claude Code's WebFetch usually fetches the page, converts
  HTML to markdown, and applies a small model to the result.
- Cannot execute JavaScript. Pages requiring JS rendering return \`ERROR:\`.
- Respects robots / paywalls; blocked fetches return \`ERROR:\`.
- Authenticated or private URLs often fail; GitHub URLs are usually better via
  \`gh\`.
- Cross-host redirects may require a second fetch to the redirect target.
- No caching between calls. Repeated fetches re-hit the origin.
- Only the \`WebFetch\` tool is permitted in the inner agent — no file IO,
  no shell, no search.

## Exit codes

- \`0\` — success, payload on stdout.
- \`64\` — usage error (missing URL).
- \`2\` — invalid option, backend or working directory; the message is on
  stderr, nothing on stdout.
- non-zero otherwise — fetch or agent failure (see stdout \`ERROR:\` line).
`;

const ERROR_PREFIX = "ERROR: ";

export type WebfetchRequest = {
	mode: "run";
	url: string;
	userPrompt: string;
	raw: boolean;
};

export type WebfetchInput =
	| WebfetchRequest
	| {
			mode: "describe" | "usage-error";
			stdout: string;
			exitCode: number;
	  };

/**
 * The legacy argument rules over the runner's parsed flags and positionals:
 * `--describe`, or no URL, prompt or positional at all, prints the usage
 * document; the URL is `--url`, else the first positional; the prompt is
 * `--prompt`, else the remaining positionals.
 */
export function resolveWebfetchInput(
	flags: Readonly<Record<string, string | boolean>>,
	args: readonly string[],
): WebfetchInput {
	const wantsDescribe =
		flags.describe === true ||
		(args.length === 0 &&
			typeof flags.url !== "string" &&
			typeof flags.prompt !== "string");

	if (wantsDescribe) {
		return {
			mode: "describe",
			stdout: USAGE_DOC,
			exitCode: 0,
		};
	}

	const url =
		typeof flags.url === "string" && flags.url.length > 0 ? flags.url : args[0];

	if (!url) {
		return {
			mode: "usage-error",
			stdout:
				"ERROR: missing URL. Run `tools:webfetch --describe` for usage.\n",
			exitCode: 64,
		};
	}

	const promptFromFlag =
		typeof flags.prompt === "string" ? flags.prompt.trim() : "";
	const promptFromPositionals =
		typeof flags.url === "string"
			? args.join(" ").trim()
			: args.slice(1).join(" ").trim();

	return {
		mode: "run",
		url,
		userPrompt: promptFromFlag || promptFromPositionals,
		raw: flags.raw === true,
	};
}

export function buildTaskPrompt({
	raw,
	url,
	userPrompt,
}: WebfetchRequest): string {
	if (raw) {
		return `Call WebFetch on this URL and return the closest available raw page text with no commentary. Treat this as best-effort raw text: the underlying tool may convert HTML to markdown, truncate large pages, or summarize some content. If WebFetch reports a redirect to a different host, call WebFetch once more with the redirect URL. If the page is authenticated, private, blocked, or unavailable, return a single ERROR line instead of guessing.\n\nURL: ${url}`;
	}

	if (userPrompt) {
		return `Call WebFetch on this URL using a narrow extraction-oriented prompt that matches the caller's request. If WebFetch reports a redirect to a different host, call WebFetch once more with the redirect URL and the same intent. If the page is authenticated, private, blocked, clearly truncated, or otherwise insufficient to answer reliably, return ERROR or UNKNOWN rather than guessing.\n\nURL: ${url}\n\nCaller request:\n${userPrompt}`;
	}

	return `Call WebFetch on this URL and emit a concise factual summary of the page's main content. If WebFetch reports a redirect to a different host, call WebFetch once more with the redirect URL. If the page is authenticated, private, blocked, or unavailable, return a single ERROR line. No preamble.\n\nURL: ${url}`;
}

function startsWithError(stdout: string | undefined): boolean {
	return stdout?.trimStart().startsWith(ERROR_PREFIX) === true;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
	return value
		?.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

export function formatErrorLine(reason: string): string {
	const line = firstNonEmptyLine(reason)
		?.replace(/^ERROR:\s*/u, "")
		.trim();
	return `${ERROR_PREFIX}${line && line.length > 0 ? line : "web fetch failed"}\n`;
}

/** The backend's captured print result as the payload contract. */
export function normalizeRunResult(result: RunResult): FinishResult {
	if (result.exitCode === 0) {
		if (startsWithError(result.stdout)) {
			return {
				stdout: result.stdout,
				exitCode: 1,
			};
		}

		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: 0,
		};
	}

	if (startsWithError(result.stdout)) {
		return {
			stdout: result.stdout,
			exitCode: result.exitCode || 1,
		};
	}

	const reason =
		firstNonEmptyLine(result.stderr) ??
		firstNonEmptyLine(result.stdout) ??
		`web fetch failed with exit code ${result.exitCode}`;

	return {
		stdout: formatErrorLine(reason),
		exitCode: result.exitCode || 1,
	};
}

/** Early exits for usage; otherwise the task prompt for the backend. */
export function prepare(ctx: PrepareContext): PrepareResult {
	const input = resolveWebfetchInput(ctx.flags, ctx.args);
	if (input.mode !== "run") {
		return {
			exit: { message: input.stdout, code: input.exitCode, stream: "stdout" },
		};
	}
	return { initialPrompt: buildTaskPrompt(input) };
}

/**
 * A failure before the backend ran (prepare, interpolation, adapter, spawn)
 * becomes `ERROR: <message>` with exit 1, as a thrown runtime error did in
 * the legacy launcher; a backend result goes through `normalizeRunResult`.
 */
export function finish(result: RunResult): FinishResult {
	if (result.failure && result.failure.stage !== "backend") {
		return {
			stdout: formatErrorLine(result.failure.message),
			exitCode: 1,
		};
	}
	return normalizeRunResult(result);
}
