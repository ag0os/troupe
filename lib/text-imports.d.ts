// `troupe/text-imports`: Markdown files imported as text, as Bun bundles them
// (`import text from "./prompt.md" with { type: "text" }`).
declare module "*.md" {
	const content: string;
	export default content;
}
