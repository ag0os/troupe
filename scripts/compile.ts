#!/usr/bin/env bun
/**
 * Build one roster agent into bin/ through the shared compiler.
 *
 * Usage:
 *   bun compile <roster-name | agents/<path>.md | agents/<path>.ts>
 */

import {
	abortOnSignals,
	describePublishFailure,
	PartialPublishError,
	publish,
	resolveAgentName,
} from "./agent-compiler";

const root = process.cwd();
const rest = process.argv.slice(2);
const input = rest[0];
if (!input || rest.length > 1) {
	console.error("Usage: bun compile <roster-name | agent source>");
	process.exit(1);
}

const name = resolveAgentName(root, input);
const signals = abortOnSignals();
try {
	await publish({
		root,
		only: name,
		signal: signals.signal,
		log: () => {},
		warn: (line) => console.error(line),
	});
	console.log(`✓ Compiled ${name} → bin/${name}`);
} catch (failure) {
	if (signals.signal.aborted && !(failure instanceof PartialPublishError)) {
		console.error(`Interrupted; ${name} not compiled, bin/ left untouched.`);
		process.exit(signals.exitCode());
	}
	console.error(describePublishFailure(failure));
	console.error(`✗ ${name} failed`);
	process.exit(signals.signal.aborted ? signals.exitCode() : 1);
}
