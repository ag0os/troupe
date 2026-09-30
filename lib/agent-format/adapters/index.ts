import { BACKENDS, type Backend } from "../types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { BackendAdapter } from "./types";

export { claudeAdapter } from "./claude";
export { codexAdapter } from "./codex";
export type * from "./types";

/** One adapter per backend id; a new backend adds one module and one entry (D-002). */
export const ADAPTERS: Readonly<Record<Backend, BackendAdapter>> = {
	claude: claudeAdapter,
	codex: codexAdapter,
};

/** The adapter for a backend id, or an error naming the known ids. */
export function adapterFor(id: string): BackendAdapter {
	if (!(BACKENDS as readonly string[]).includes(id)) {
		throw new Error(`unknown backend "${id}" (known: ${BACKENDS.join(", ")})`);
	}
	return ADAPTERS[id as Backend];
}
