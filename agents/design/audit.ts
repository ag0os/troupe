/**
 * DESIGN-AUDIT: Comprehensive design system/site styling audit
 *
 * Scans the current project for design-related constructs (tokens, variables,
 * themes, layouts, patterns, utilities, packages, and more) and writes a
 * navigable audit to ai/design-audit/ without changing app code.
 *
 * Usage:
 *   design:audit                     # full audit
 *   design:audit "auth, marketing"   # optional focus filters
 *
 * The system prompt and the expectations include live in `audit.md`. This
 * extension computes the audit directory, creates it outside preview, and
 * hands the banners to the runner (D-016, D-019).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	PrepareContext,
	PrepareResult,
} from "../../lib/agent-format/types";

export function prepare(ctx: PrepareContext): PrepareResult {
	const targetProject = ctx.cwd;
	const auditDir = join(targetProject, "ai", "design-audit");

	// Ensure output directory exists; never in preview (D-012)
	let directoryMessage = `✅ Created/verified directory: ${auditDir}`;
	if (!ctx.preview) {
		try {
			mkdirSync(auditDir, { recursive: true });
		} catch (error) {
			const failure = `Failed to create audit directory: ${error}`;
			// Print mode has no banner to carry the failure, so it stops here.
			if (ctx.mode === "print") {
				return { exit: { message: `${failure}\n`, code: 1, stream: "stderr" } };
			}
			directoryMessage = failure;
		}
	}

	// Optional free-form focus filter(s)
	const focus = ctx.args.join(", ");

	// Build the user task prompt (system prompt contains the persona/contract)
	const userPrompt =
		`Conduct a comprehensive design system audit of the project at ${targetProject}.

Output directory: ${auditDir}

Instructions:
1. Examine all design-related constructs (tokens, variables, themes, layouts, utilities, components, packages).
2. Identify real file anchors for each finding (paths + line ranges + short snippets).
3. Write ONLY into ${auditDir} following the system prompt's output contract.
${focus ? `4. Prioritize focus areas: ${focus}.` : ""}`.trim();

	// Print mode's stdout is the payload, so the runner refuses banners there.
	if (ctx.mode === "print") return { initialPrompt: userPrompt };
	return {
		initialPrompt: userPrompt,
		beforeRunMessages: [
			directoryMessage,
			"🔎 Starting design system audit...",
			`📁 Project: ${targetProject}`,
			`🗂️  Output: ${auditDir}`,
		],
		afterRunMessages: [
			"\n✨ Design audit complete!",
			`📁 Reports saved to: ${auditDir}`,
		],
	};
}
