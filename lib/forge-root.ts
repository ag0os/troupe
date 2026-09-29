/**
 * Utility for resolving the troupe installation directory.
 *
 * This is critical for hooks and other resources that need to be found
 * regardless of which directory an agent is run from.
 */

import { dirname, resolve } from "node:path";

/**
 * Resolves the troupe root directory.
 *
 * - When compiled: uses process.execPath (binary in bin/) and goes up one level
 * - When running via bun: uses import.meta.dir and goes up one level from lib/
 *
 * @returns Absolute path to the troupe root directory
 */
export function getForgeRoot(): string {
	// Check if running as compiled binary by looking for bun's virtual filesystem
	const isCompiled = import.meta.dir.startsWith("/$bunfs");

	if (isCompiled) {
		// Compiled binary: process.execPath is /path/to/troupe/bin/<agent-name>
		// Go up one level from bin/ to get forge root
		return resolve(dirname(process.execPath), "..");
	}

	// Running via bun: import.meta.dir is /path/to/troupe/lib
	// Go up one level to get forge root
	return resolve(import.meta.dir, "..");
}
