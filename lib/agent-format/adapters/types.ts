import type { AgentMode, AgentSpec, Backend } from "../types";

/**
 * A launch value with its redacted twin. Adapters put `actual` in `argv`
 * and `display` in `displayArgv`.
 */
export interface ResolvedValue {
	actual: string;
	/** Redacted form for preview and diagnostics. */
	display: string;
}

/** An MCP HTTP header value, the only leaf that may be a secret (D-029). */
export interface ResolvedHeaderValue extends ResolvedValue {
	/**
	 * Set when the value came from `${env:...}`/`${cmd:...}` interpolation:
	 * the runner exports `actual` into the child's environment under this
	 * name, which must equal `mcpSecretEnvName(server, header)`, and the
	 * adapter emits a reference, never the value.
	 */
	secretEnv?: string;
}

export interface ResolvedStdioMcpServer {
	command: ResolvedValue;
	args?: ResolvedValue[];
	env?: Record<string, ResolvedValue>;
	cwd?: ResolvedValue;
}

export interface ResolvedHttpMcpServer {
	url: ResolvedValue;
	headers?: Record<string, ResolvedHeaderValue>;
}

export type ResolvedMcpServer = ResolvedStdioMcpServer | ResolvedHttpMcpServer;

export interface ExtraAllowRules {
	rules: string[];
	additionalDirectories?: string[];
}

/** Everything an adapter needs, already resolved by the runner. */
export interface Invocation {
	spec: Readonly<AgentSpec>;
	backend: Backend;
	/** Effective mode after `--print`. */
	mode: AgentMode;
	/** Compiled body plus prepared fragments; empty emits no prompt flag. */
	systemPrompt: string;
	/** Rendered initial prompt; empty places no prompt. */
	initialPrompt: string;
	cwd: string;
	/** Framework `--model` override; otherwise the spec's model for the backend applies. */
	model?: string;
	flags: Readonly<Record<string, string | boolean>>;
	extraAllowRules?: ExtraAllowRules;
	mcp: Record<string, ResolvedMcpServer>;
	/** Verbatim tail after the user's `--`; always empty when the spec opts out (D-039). */
	passthrough: readonly string[];
	/** Probed by the runner in `cwd`; Codex exec skips the Git check only when false. */
	insideGitWorktree: boolean;
}

/** Resources the runner creates before `build`, or fakes in preview. */
export interface ResourceNeeds {
	/** Text to write to an owner-only temp file. */
	promptFile?: string;
	/** A unique clean directory exported as `TMPDIR`. */
	tmpDir?: boolean;
}

/** Real paths at launch, stable placeholders in preview. */
export interface ResourcePaths {
	promptFile?: string;
	tmpDir?: string;
}

export interface CommandPlan {
	executable: string;
	/** Arguments after `executable`. */
	argv: string[];
	/** `argv` with redacted values, for preview. */
	displayArgv: string[];
	/** Directory the runner spawns the backend in (`Invocation.cwd`). */
	cwd: string;
	stdin: "inherit" | "ignore";
	stdout: "inherit" | "pipe";
	stderr: "inherit" | "pipe";
	/** Additions to the inherited environment only. */
	env: Record<string, string>;
}

export type Emission = { stream: "stdout" | "stderr"; text: string };

/** Maps complete stream lines to ordered emissions; throws on malformed input. */
export interface StreamDecoder {
	line(text: string): Emission[];
	end(): Emission[];
}

export interface BackendAdapter {
	readonly id: Backend;
	resources(inv: Invocation): ResourceNeeds;
	build(inv: Invocation, paths: ResourcePaths): CommandPlan;
	decoder(): StreamDecoder;
}
