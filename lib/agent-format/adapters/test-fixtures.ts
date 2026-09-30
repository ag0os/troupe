import { mcpSecretEnvName } from "../command-text";
import type { AgentSpec, Backend } from "../types";
import type { Invocation, ResolvedHeaderValue, ResolvedValue } from "./types";

export function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		id: "test:agent",
		description: "Test agent",
		backends: ["claude", "codex"],
		promptMode: "append",
		mode: "interactive",
		initialPrompt: "{{args}}",
		systemPrompt: "SYSTEM",
		flags: {},
		...overrides,
	};
}

export function invocation(
	backend: Backend,
	overrides: Partial<Invocation> = {},
): Invocation {
	const agent = overrides.spec ?? spec();
	return {
		spec: agent,
		backend,
		mode: agent.mode,
		systemPrompt: agent.systemPrompt,
		initialPrompt: "",
		cwd: "/work",
		flags: {},
		mcp: {},
		passthrough: [],
		insideGitWorktree: true,
		...overrides,
	};
}

export function literal(text: string): ResolvedValue {
	return { actual: text, display: text };
}

/** An interpolated header value under its generated D-029 variable name. */
export function secret(
	actual: string,
	server: string,
	header: string,
): ResolvedHeaderValue {
	return {
		actual,
		display: "<redacted>",
		secretEnv: mcpSecretEnvName(server, header),
	};
}

/** Flags every adapter could emit for policy the user config should own (D-004). */
export const POLICY_TOKENS = [
	"--strict-mcp-config",
	"--setting-sources",
	"--permission-mode",
	"--dangerously-skip-permissions",
	"--model",
	"--effort",
	"--mcp-config",
	"--settings",
	"-m",
	"-s",
	"-a",
	"--sandbox",
	"--ask-for-approval",
	"--dangerously-bypass-approvals-and-sandbox",
	"--ignore-user-config",
];
