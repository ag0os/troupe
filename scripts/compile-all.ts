#!/usr/bin/env bun
/**
 * Rebuild the whole roster through the shared compiler and prune orphans.
 *
 * Every binary is built into a temporary directory beside bin/ and renamed
 * into place only after all builds succeed; a failure leaves bin/ untouched.
 * Pruning removes every bin/ entry outside the roster except binaries owned
 * by other `compile:*` package scripts.
 *
 * Usage:
 *   bun run compile:all
 *   bun run compile:all --dry-run    # report what would change, write nothing
 *   bun run compile:all --no-prune   # rebuild only, leave orphans alone
 */

import {
	abortOnSignals,
	describePublishFailure,
	PartialPublishError,
	publish,
} from "./agent-compiler";

const rest = process.argv.slice(2);
const unknown = rest.filter(
	(arg) => arg !== "--dry-run" && arg !== "--no-prune",
);
if (unknown.length > 0) {
	console.error(
		`Unknown arguments: ${unknown.join(" ")} (--dry-run, --no-prune)`,
	);
	process.exit(1);
}
const dryRun = rest.includes("--dry-run");

const signals = abortOnSignals();
console.log(`${dryRun ? "[dry run] " : ""}compiling the roster → bin/`);
try {
	const result = await publish({
		root: process.cwd(),
		dryRun,
		prune: !rest.includes("--no-prune"),
		signal: signals.signal,
		log: (line) => console.log(`  ${line}`),
		warn: (line) => console.error(line),
	});
	console.log(
		dryRun
			? `\n${result.built.length} would be built, ${result.pruned.length} would be pruned.`
			: `\n${result.built.length} built, ${result.pruned.length} pruned.`,
	);
} catch (failure) {
	if (signals.signal.aborted && !(failure instanceof PartialPublishError)) {
		console.error("\nInterrupted; nothing published, bin/ left untouched.");
		process.exit(signals.exitCode());
	}
	console.error(`\n${describePublishFailure(failure)}`);
	process.exit(signals.signal.aborted ? signals.exitCode() : 1);
}
