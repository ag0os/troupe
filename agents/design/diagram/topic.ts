/**
 * Topic-focused event flow diagrams into ai/diagrams/.
 *
 * The system prompt lives in `topic.md`. This extension requires the topic
 * (the first positional), slugs it, computes the diagrams directory, creates
 * it outside preview, builds the task prompt and hands the banners to the
 * runner (D-016, D-019).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	PrepareContext,
	PrepareResult,
} from "../../../lib/agent-format/types";

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)+/g, "")
		.slice(0, 80);
}

export function prepare(ctx: PrepareContext): PrepareResult {
	// First positional is the required topic, the rest optional focus/filter details
	const [topic, ...rest] = ctx.args;
	const extraFocus = rest.join(" ");

	if (!topic) {
		return {
			exit: {
				message:
					"Missing required topic.\nUsage: design:diagram:topic <topic> [extra focus words]\n",
				code: 1,
				stream: "stderr",
			},
		};
	}

	const topicSlug = slugify(topic);
	const targetProject = ctx.cwd;
	const diagramsDir = join(targetProject, "ai", "diagrams");

	// Ensure output directory exists; never in preview (D-012)
	let directoryMessage = `✅ Created/verified directory: ${diagramsDir}`;
	if (!ctx.preview) {
		try {
			mkdirSync(diagramsDir, { recursive: true });
		} catch (error) {
			const failure = `Failed to create diagrams directory: ${error}`;
			// Print mode has no banner to carry the failure, so it stops here.
			if (ctx.mode === "print") {
				return { exit: { message: `${failure}\n`, code: 1, stream: "stderr" } };
			}
			directoryMessage = failure;
		}
	}

	// Build the user prompt
	const userPrompt = `Analyze the codebase at ${targetProject} and generate event flow diagrams ONLY for the specified topic.

Topic: ${topic}
${extraFocus ? `Extra focus: ${extraFocus}` : ""}

Target output directory: ${diagramsDir}

Instructions:
1. Identify flows, data paths, and interactions that are DIRECTLY related to the topic above.
2. Ignore unrelated flows. If the topic is ambiguous, choose the most relevant interpretation based on code patterns and file names.
3. Create one markdown file per distinct topic-relevant flow in ${diagramsDir}:
   - Filename prefix with the topic (e.g., ${topicSlug}-auth-login-flow.md)
   - Include a Mermaid diagram, overview, trigger points, key components, data flow, error scenarios.
4. Validate relevance: each output must clearly explain why it belongs to this topic (files, functions, or naming patterns matching the topic).
5. Provide thorough coverage of the topic but do NOT include unrelated areas.

Begin by locating files/functions whose names, routes, types, or documentation match the topic and follow all call/data paths from those anchors.`;

	// Print mode's stdout is the payload, so the runner refuses banners there.
	if (ctx.mode === "print") return { initialPrompt: userPrompt };
	return {
		initialPrompt: userPrompt,
		beforeRunMessages: [
			directoryMessage,
			"🎯 Starting topic-focused diagram generation...",
			`🏷️ Topic: ${topic} (slug: ${topicSlug})`,
			`📁 Target project: ${targetProject}`,
			`📊 Diagrams will be saved to: ${diagramsDir}`,
		],
		afterRunMessages: [
			"\n✨ Topic-focused diagram generation complete!",
			`📁 Diagrams saved to: ${diagramsDir}`,
		],
	};
}
