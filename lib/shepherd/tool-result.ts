import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR } from "./workspace";

export type ToolResult = {
	notice?: string;
	text: string;
	code: number;
	stream: "stdout" | "stderr";
};

const USAGE = [
	"shepherd tool check   [<workspace>...] [--all] [--status | --context] [--json] [--today YYYY-MM-DD]",
	"shepherd tool archive [<workspace>...] [--recursive] [--apply] [--json] [--today YYYY-MM-DD]",
	"shepherd tool guide [<name>]",
	"shepherd tool guide <package> [<guide>]",
	"shepherd tool <package> <tool> [args...]",
	"shepherd tool init [--master] [--json]",
	"shepherd tool doctor [--json]",
	"shepherd tool start      [--budget <words>] [--json]",
	"shepherd tool journal    (<text> | --stdin) [--json]",
	"shepherd tool checkpoint [--apply --token <token>] [--session <name>] [--accept-dropped <reason>] [--json]",
	"shepherd tool unlock     [--json]",
	"shepherd tool query items [NEXT|SCHEDULED|WAITING|ASK|CANDIDATE] [--all] [--json]",
	"shepherd tool query item <slug> [--json]",
	"shepherd tool query sessions [--all] [--json]",
	"shepherd tool query autonomy [--all] [--json]",
	"shepherd tool query journal [--since <id|YYYY-MM-DD>] [--max <n|all>] [--all] [--json]",
	"shepherd tool query checkpoint [--all] [--json]",
].join("\n");

export function result(
	text: string,
	code: number,
	stream: "stdout" | "stderr" = "stdout",
): ToolResult {
	return { text: text.endsWith("\n") ? text : `${text}\n`, code, stream };
}

export function usage(): ToolResult {
	return result(USAGE, 2, "stderr");
}

function enclosingWorkspace(cwd: string): string | undefined {
	for (
		let dir = dirname(resolve(cwd));
		dir !== dirname(dir);
		dir = dirname(dir)
	) {
		if (existsSync(join(dir, STATE_DIR))) return dir;
	}
	return undefined;
}

export function treeError(cwd: string, error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	const nearest = message.startsWith("not a workspace:")
		? enclosingWorkspace(cwd)
		: undefined;
	return result(
		nearest ? `${message}; the nearest one is ${nearest}, use --cwd` : message,
		2,
		"stderr",
	);
}
