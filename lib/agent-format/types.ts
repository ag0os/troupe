export const BACKENDS = ["claude", "codex"] as const;
export type Backend = (typeof BACKENDS)[number];

export const PROMPT_MODES = ["append", "replace"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

export const AGENT_MODES = ["interactive", "print", "stream"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const ACCESS_LEVELS = ["read-only", "workspace-write", "full"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

/** Framework flags every binary owns; declarations may not reuse them. */
export const FRAMEWORK_OPTIONS = {
	backend: { takesValue: true },
	cwd: { takesValue: true },
	model: { takesValue: true },
	print: { takesValue: false },
	"show-prompt": { takesValue: false },
	help: { takesValue: false },
} as const;
export type FrameworkOption = keyof typeof FRAMEWORK_OPTIONS;

/** Short framework flags; declarations may not reuse these letters. */
export const FRAMEWORK_SHORTS = { h: "help" } as const satisfies Record<
	string,
	FrameworkOption
>;

export type NativeArg = string | { flag: string };

export type FlagSpec =
	| { type: "boolean"; description: string; short?: string; default?: boolean }
	| { type: "string"; description: string; short?: string; default?: string }
	| {
			type: "enum";
			description: string;
			short?: string;
			values: string[];
			default?: string;
	  };

export type StdioMcpServer = {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
};
export type HttpMcpServer = { url: string; headers?: Record<string, string> };
export type McpServer = StdioMcpServer | HttpMcpServer;

export interface Effort {
	claude?: "low" | "medium" | "high" | "max";
	codex?: "minimal" | "low" | "medium" | "high";
}

export interface NativeDeclarations {
	claude?: { args?: NativeArg[]; settings?: Record<string, unknown> };
	codex?: { args?: NativeArg[]; config?: Record<string, unknown> };
}

/** The frontmatter of an `agents/<ns>/<name>.md` declaration. */
export interface AgentSource {
	description: string;
	backends: [Backend, ...Backend[]];
	promptMode?: PromptMode;
	mode?: AgentMode;
	initialPrompt?: string;
	includes?: string[];
	flags?: Record<string, FlagSpec>;
	model?: Partial<Record<Backend, string>>;
	effort?: Effort;
	access?: Access;
	mcp?: Record<string, McpServer>;
	native?: NativeDeclarations;
}

/** The compiled, backend-neutral spec embedded in each binary. */
export interface AgentSpec {
	id: string;
	description: string;
	backends: [Backend, ...Backend[]];
	promptMode: PromptMode;
	mode: AgentMode;
	initialPrompt: string;
	systemPrompt: string;
	flags: Record<string, FlagSpec>;
	model?: Partial<Record<Backend, string>>;
	effort?: Effort;
	access?: Access;
	mcp?: Record<string, McpServer>;
	native?: NativeDeclarations;
}

export interface CommandRequest {
	argv: [string, ...string[]];
	cwd?: string;
	env?: Record<string, string>;
}

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface PrepareContext {
	readonly flags: Readonly<Record<string, string | boolean>>;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly backend: Backend;
	/** Effective mode after `--print`, not `spec.mode`. */
	readonly mode: AgentMode;
	/** True under `--show-prompt`. */
	readonly preview: boolean;
	readonly spec: Readonly<AgentSpec>;
	readonly signal: AbortSignal;
	readonly runCommand: (request: CommandRequest) => Promise<CommandResult>;
}

export type PrepareResult =
	| {
			systemPromptFragments?: string[];
			initialPrompt?: string;
			extraAllowRules?: { rules: string[]; additionalDirectories?: string[] };
			cwd?: string;
			flagOverrides?: Record<string, string | boolean>;
			beforeRunMessages?: string[];
			afterRunMessages?: string[];
	  }
	| { exit: { message: string; code: number; stream: "stdout" | "stderr" } };

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	failure?: {
		stage: "prepare" | "interpolation" | "adapter" | "spawn" | "backend";
		message: string;
	};
}

export interface FinishResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

export type Prepare = (
	ctx: PrepareContext,
) => PrepareResult | Promise<PrepareResult>;

export type Finish = (
	result: RunResult,
	ctx: PrepareContext,
) => FinishResult | Promise<FinishResult>;

/** Names a sibling extension may export for the generated entry to import. */
export const EXTENSION_EXPORTS = ["prepare", "finish"] as const;
export type ExtensionExport = (typeof EXTENSION_EXPORTS)[number];
