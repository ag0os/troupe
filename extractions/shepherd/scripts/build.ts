#!/usr/bin/env bun
/**
 * Build Shepherd into the package's bin/ through Troupe's compiler. The
 * roster is `shepherd` alone, so both forms publish only `shepherd`.
 *
 * Usage:
 *   bun scripts/build.ts <shepherd | agents/shepherd.md>   (bun run compile)
 *   bun scripts/build.ts --all [--dry-run] [--no-prune]    (bun run compile:all)
 */

import {
	abortOnSignals,
	describePublishFailure,
	PartialPublishError,
	publish,
	resolveAgentName,
} from "troupe/compiler";
import { PACKAGE_ROOT, shepherdDefinition } from "./shepherd-definition";

const rest = process.argv.slice(2);
const all = rest[0] === "--all";
const flags = all ? rest.slice(1) : [];
const unknown = flags.filter(
	(arg) => arg !== "--dry-run" && arg !== "--no-prune",
);
if ((!all && rest.length !== 1) || unknown.length > 0) {
	console.error(
		"Usage: bun scripts/build.ts <shepherd | agents/shepherd.md> | --all [--dry-run] [--no-prune]",
	);
	process.exit(1);
}

const definition = shepherdDefinition(PACKAGE_ROOT);
const only = all
	? undefined
	: resolveAgentName(definition, rest[0] ?? "", process.cwd());
const dryRun = flags.includes("--dry-run");
const signals = abortOnSignals();
try {
	const result = await publish({
		definition,
		only,
		dryRun,
		prune: !flags.includes("--no-prune"),
		signal: signals.signal,
		log: (line) => console.log(`  ${line}`),
		warn: (line) => console.error(line),
	});
	console.log(
		dryRun
			? `${result.built.length} would be built, ${result.pruned.length} would be pruned.`
			: `${result.built.length} built into bin/, ${result.pruned.length} pruned.`,
	);
} catch (failure) {
	if (signals.signal.aborted && !(failure instanceof PartialPublishError)) {
		console.error("Interrupted; nothing published, bin/ left untouched.");
		process.exit(signals.exitCode());
	}
	console.error(describePublishFailure(failure));
	process.exit(signals.signal.aborted ? signals.exitCode() : 1);
}
