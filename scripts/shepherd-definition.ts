/**
 * The build definition Shepherd's tests load and plan with, for this layout:
 * the repository's legacy definition (the fixed roster, both framework
 * directories, `bin/`). The extracted package has its own module at the same
 * path, so the tests that import it are byte equal in both trees.
 */

import type { AgentBuildDefinition } from "../lib/entries/compiler";
import { legacyDefinition } from "./agent-compiler";

export function shepherdDefinition(root: string): AgentBuildDefinition {
	return legacyDefinition(root);
}
