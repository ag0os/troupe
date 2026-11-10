import { relative } from "node:path";
import type { Finding, FindingLevel } from "./check";
import type { Workspace } from "./tree";

/**
 * Collect one workspace's findings, naming each file relative to its state
 * directory and leaving line out when none is given.
 */
export function findingCollector(workspace: Workspace): {
	findings: Finding[];
	add: (
		level: FindingLevel,
		code: string,
		path: string,
		message: string,
		line?: number,
	) => void;
} {
	const findings: Finding[] = [];
	const add = (
		level: FindingLevel,
		code: string,
		path: string,
		message: string,
		line?: number,
	) => {
		findings.push({
			level,
			code,
			file: relative(workspace.state, path) || ".",
			...(line === undefined ? {} : { line }),
			message,
		});
	};
	return { findings, add };
}
