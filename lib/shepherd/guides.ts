import charter from "../../system-prompts/shepherd/guides/charter.md" with {
	type: "text",
};
import memory from "../../system-prompts/shepherd/guides/memory.md" with {
	type: "text",
};
import tools from "../../system-prompts/shepherd/guides/tools.md" with {
	type: "text",
};
import archiveIndex from "../../system-prompts/shepherd/templates/archive-INDEX.md" with {
	type: "text",
};
import current from "../../system-prompts/shepherd/templates/CURRENT.md" with {
	type: "text",
};
import docsIndex from "../../system-prompts/shepherd/templates/docs-INDEX.md" with {
	type: "text",
};
import integrationsShared from "../../system-prompts/shepherd/templates/integrations-shared.md" with {
	type: "text",
};
import journal from "../../system-prompts/shepherd/templates/journal.md" with {
	type: "text",
};
import memoryIndex from "../../system-prompts/shepherd/templates/MEMORY.md" with {
	type: "text",
};
import statusTemplate from "../../system-prompts/shepherd/templates/STATUS-template.md" with {
	type: "text",
};
import sharedMachine from "../../system-prompts/shepherd/templates/shared-machine.md" with {
	type: "text",
};
import sharedRoster from "../../system-prompts/shepherd/templates/shared-roster.md" with {
	type: "text",
};
import sharedTools from "../../system-prompts/shepherd/templates/shared-tools.md" with {
	type: "text",
};
import sharedUser from "../../system-prompts/shepherd/templates/shared-user.md" with {
	type: "text",
};
import { dayOf } from "./dates";

export const GUIDES = [
	{
		name: "charter",
		purpose: "the init conversation's questions and the charter's shape",
		text: charter,
	},
	{
		name: "memory",
		purpose: "the memory file format and what each type holds",
		text: memory,
	},
	{
		name: "tools",
		purpose:
			"generic traps in Claude Code delegates, the Codex CLI and the shell",
		text: tools,
	},
] as const;

/** Target paths are relative to .shepherd/; master adds the shared layer. */
export const TEMPLATES = [
	{ path: "CURRENT.md", master: false, text: current },
	{ path: "MEMORY.md", master: false, text: memoryIndex },
	{ path: "journal.md", master: false, text: journal },
	{ path: "docs/INDEX.md", master: false, text: docsIndex },
	{ path: "docs/STATUS-template.md", master: false, text: statusTemplate },
	{ path: "archive/INDEX.md", master: false, text: archiveIndex },
	{ path: "shared/user.md", master: true, text: sharedUser },
	{ path: "shared/machine.md", master: true, text: sharedMachine },
	{ path: "shared/roster.md", master: true, text: sharedRoster },
	{ path: "shared/tools.md", master: true, text: sharedTools },
	{ path: "integrations/shared.md", master: true, text: integrationsShared },
] as const;

export function renderTemplate(text: string, now: Date): string {
	const date = dayOf(now);
	const pad = (value: number) => String(value).padStart(2, "0");
	const updated = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
	return text.replaceAll("{{updated}}", updated).replaceAll("{{date}}", date);
}
