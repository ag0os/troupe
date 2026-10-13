import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_MARKS = {
	opening: 12_000,
	charter: 1_000,
	current: 600,
	shared: 1_500,
} as const;

export const DEFAULT_WINDOWS = {
	pendingDays: 14,
	doneDays: 30,
	currentStaleDays: 7,
} as const;

export const DEFAULT_HANDOFF_CEILINGS = {
	claude: 45,
	codex: 80,
	default: 45,
} as const;

export const DEFAULT_START = {
	journalWords: 1_500,
} as const;

export type Start = {
	journalWords: number;
};

export type Marks = {
	opening: number;
	charter: number;
	current: number;
	shared: number;
};

export type Windows = {
	pendingDays: number;
	doneDays: number;
	currentStaleDays: number;
};

export type CodexConfig = {
	home?: string;
	homeFile?: string;
	model?: string;
	effort?: string;
};

export type ConfigProblem = {
	file: string;
	key: string;
	problem: string;
};

export type Config = {
	marks: Marks;
	windows: Windows;
	start: Start;
	handoffCeilings: Record<string, number>;
	sessionPrefix?: string;
	codex: CodexConfig;
	problems: ConfigProblem[];
};

export type LoadConfigOptions = {
	home: string;
	env: Readonly<Record<string, string | undefined>>;
	/** Workspace paths ordered from the outermost workspace to the target. */
	workspaceChain: readonly string[];
};

export type ConfigProblemsByScope = {
	user: ConfigProblem[];
	workspace: ConfigProblem[];
};

const positiveInteger = z.number().int().positive();
const marksSchema = z.strictObject({
	opening: positiveInteger.optional(),
	charter: positiveInteger.optional(),
	current: positiveInteger.optional(),
	shared: positiveInteger.optional(),
});
const windowsSchema = z.strictObject({
	pendingDays: positiveInteger.optional(),
	doneDays: positiveInteger.optional(),
	currentStaleDays: positiveInteger.optional(),
});
const startSchema = z.strictObject({
	journalWords: positiveInteger.optional(),
});
const codexSchema = z
	.strictObject({
		home: z.string().min(1).optional(),
		homeFile: z.string().min(1).optional(),
		model: z.string().optional(),
		effort: z.string().optional(),
	})
	.refine((codex) => !(codex.home && codex.homeFile), {
		path: ["homeFile"],
		message: "cannot be used together with home",
	});
const handoffCeilingsSchema = z.record(
	z.string().min(1),
	z.number().positive().max(100),
);
const userSchema = z.strictObject({
	marks: marksSchema.optional(),
	windows: windowsSchema.optional(),
	start: startSchema.optional(),
	handoffCeilings: handoffCeilingsSchema.optional(),
	codex: codexSchema.optional(),
});
const workspaceSchema = z.strictObject({
	marks: marksSchema.optional(),
	windows: windowsSchema.optional(),
	start: startSchema.optional(),
	handoffCeilings: handoffCeilingsSchema.optional(),
	sessionPrefix: z
		.string()
		.regex(
			/^[A-Za-z][A-Za-z0-9-]*$/,
			"must start with a letter and contain only letters, digits, and hyphens",
		)
		.optional(),
});

type UserLayer = z.infer<typeof userSchema>;

function expandHome(path: string, home: string): string {
	return path === "~"
		? home
		: path.startsWith("~/")
			? join(home, path.slice(2))
			: path;
}

export function userConfigFile(
	options: Pick<LoadConfigOptions, "home" | "env">,
): string {
	const configHome = expandHome(
		options.env.XDG_CONFIG_HOME || join(options.home, ".config"),
		options.home,
	);
	return join(configHome, "shepherd", "config.json");
}

/** Split config diagnostics by the failure policy of their source file. */
export function splitConfigProblems(
	problems: readonly ConfigProblem[],
	options: Pick<LoadConfigOptions, "home" | "env">,
): ConfigProblemsByScope {
	const userFile = userConfigFile(options);
	const user: ConfigProblem[] = [];
	const workspace: ConfigProblem[] = [];
	for (const problem of problems) {
		(problem.file === userFile ? user : workspace).push(problem);
	}
	return { user, workspace };
}

function issueProblems(
	file: string,
	issues: z.core.$ZodIssue[],
): ConfigProblem[] {
	const problems: ConfigProblem[] = [];
	for (const issue of issues) {
		if (issue.code === "unrecognized_keys") {
			for (const key of issue.keys) {
				problems.push({
					file,
					key: [...issue.path, key].join("."),
					problem: "unknown key",
				});
			}
			continue;
		}
		problems.push({
			file,
			key: issue.path.join(".") || "config",
			problem: issue.message,
		});
	}
	return problems;
}

function readLayer<T>(
	file: string,
	schema: z.ZodType<T>,
	problems: ConfigProblem[],
): T | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		problems.push({
			file,
			key: "config",
			problem: error instanceof Error ? error.message : "could not read file",
		});
		return undefined;
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		problems.push({
			file,
			key: "config",
			problem: error instanceof Error ? error.message : "invalid JSON",
		});
		return undefined;
	}

	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		problems.push(...issueProblems(file, parsed.error.issues));
		return undefined;
	}
	return parsed.data;
}

function applyLayer(
	config: Pick<Config, "marks" | "windows" | "start" | "handoffCeilings">,
	layer: Pick<UserLayer, "marks" | "windows" | "start" | "handoffCeilings">,
): void {
	if (layer.marks) Object.assign(config.marks, layer.marks);
	if (layer.windows) Object.assign(config.windows, layer.windows);
	if (layer.start) Object.assign(config.start, layer.start);
	if (layer.handoffCeilings)
		Object.assign(config.handoffCeilings, layer.handoffCeilings);
}

export function loadConfig({
	home,
	env,
	workspaceChain,
}: LoadConfigOptions): Config {
	const config: Config = {
		marks: { ...DEFAULT_MARKS },
		windows: { ...DEFAULT_WINDOWS },
		start: { ...DEFAULT_START },
		handoffCeilings: { ...DEFAULT_HANDOFF_CEILINGS },
		codex: {},
		problems: [],
	};
	const userFile = userConfigFile({ home, env });
	const user = readLayer(userFile, userSchema, config.problems);
	if (user) {
		applyLayer(config, user);
		config.codex = { ...user.codex };
		if (config.codex.home)
			config.codex.home = expandHome(config.codex.home, home);
		if (config.codex.homeFile) {
			config.codex.homeFile = expandHome(config.codex.homeFile, home);
		}
	}

	for (const [index, workspace] of workspaceChain.entries()) {
		const file = join(workspace, ".shepherd", "config.json");
		const layer = readLayer(file, workspaceSchema, config.problems);
		if (!layer) continue;
		applyLayer(config, layer);
		if (index === workspaceChain.length - 1) {
			config.sessionPrefix = layer.sessionPrefix;
		}
	}

	return config;
}

/** Exact model, recognized family, known backend, then the fallback. */
export function handoffCeiling(
	config: Pick<Config, "handoffCeilings">,
	backend: string,
	model?: string,
): number {
	model ||= undefined;
	const ceilings = config.handoffCeilings;
	if (model !== undefined && Object.hasOwn(ceilings, model)) {
		return ceilings[model] as number;
	}
	const family = /^(claude|opus|sonnet|haiku)(-|$)/.test(model ?? "")
		? "claude"
		: /^(gpt|codex)(-|$)/.test(model ?? "")
			? "codex"
			: backend === "claude" || backend === "codex"
				? backend
				: "default";
	return ceilings[family] ?? DEFAULT_HANDOFF_CEILINGS[family];
}
