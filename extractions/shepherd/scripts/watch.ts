#!/usr/bin/env bun
/**
 * Watch the package's agents/ and system-prompts/ and rebuild Shepherd into
 * bin/ through Troupe's compiler on any change, one rebuild at a time.
 */

import { startWatcher } from "troupe/compiler";
import { PACKAGE_ROOT, shepherdDefinition } from "./shepherd-definition";

const rest = process.argv.slice(2);
if (rest.length > 0) {
	console.error(`Unknown arguments: ${rest.join(" ")}`);
	process.exit(1);
}

const controller = new AbortController();
const watcher = startWatcher({
	definition: shepherdDefinition(PACKAGE_ROOT),
	signal: controller.signal,
	log: (line) => console.log(line),
	warn: (line) => console.error(line),
});
console.log(`Watching ${watcher.roots.join(", ")}...`);
void watcher.queue.request();

let stopping = false;
const stop = (code: number) => async () => {
	// Stay subscribed so a repeated signal cannot skip the build cleanup.
	if (stopping) return;
	stopping = true;
	console.log("\nStopping watcher...");
	watcher.close();
	controller.abort();
	await watcher.queue.idle();
	process.exit(code);
};
process.on("SIGINT", stop(130));
process.on("SIGTERM", stop(143));
process.on("SIGHUP", stop(129));
