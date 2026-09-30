/**
 * `${env:NAME}` and `${cmd:...}` references inside MCP string values (D-026).
 *
 * Command text is split shell-style into argv and later run without a shell,
 * so anything that only a shell could honor is rejected here.
 */

export type Interpolation =
	| { kind: "env"; name: string; raw: string }
	| { kind: "cmd"; argv: string[]; raw: string };

export type ScanResult =
	| { ok: true; references: Interpolation[] }
	| { ok: false; error: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Builtins that only exist inside a shell, so argv cannot execute them. */
const SHELL_BUILTINS = new Set([
	"export",
	"cd",
	"source",
	".",
	"eval",
	"exec",
	"alias",
	"unset",
	"set",
	"ulimit",
	"umask",
	"trap",
]);

/** Find every `${env:...}` / `${cmd:...}` reference in `value`. */
export function scanInterpolations(value: string): ScanResult {
	const references: Interpolation[] = [];
	let index = 0;
	while (true) {
		const start = findReferenceStart(value, index);
		if (start === -1) return { ok: true, references };
		const kind = value.startsWith("${env:", start) ? "env" : "cmd";
		const bodyStart = start + "${xxx:".length;
		if (kind === "env") {
			const end = value.indexOf("}", bodyStart);
			if (end === -1) return { ok: false, error: "unterminated ${env:...}" };
			const name = value.slice(bodyStart, end);
			if (!ENV_NAME.test(name)) {
				return { ok: false, error: `invalid environment name "${name}"` };
			}
			references.push({ kind, name, raw: value.slice(start, end + 1) });
			index = end + 1;
			continue;
		}
		const end = findCommandEnd(value, bodyStart);
		if (end === -1) return { ok: false, error: "unterminated ${cmd:...}" };
		const split = splitCommandText(value.slice(bodyStart, end));
		if (!split.ok) return split;
		references.push({
			kind,
			argv: split.argv,
			raw: value.slice(start, end + 1),
		});
		index = end + 1;
	}
}

function findReferenceStart(value: string, from: number): number {
	const env = value.indexOf("${env:", from);
	const cmd = value.indexOf("${cmd:", from);
	if (env === -1) return cmd;
	if (cmd === -1) return env;
	return Math.min(env, cmd);
}

/** Index of the first unquoted, unescaped `}` at or after `from`. */
function findCommandEnd(value: string, from: number): number {
	let quote: "'" | '"' | null = null;
	for (let i = from; i < value.length; i++) {
		const char = value[i];
		if (quote === "'") {
			if (char === "'") quote = null;
			continue;
		}
		if (char === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "}") return i;
	}
	return -1;
}

export type SplitResult =
	| { ok: true; argv: [string, ...string[]] }
	| { ok: false; error: string };

/**
 * Split command text into argv honoring single quotes, double quotes and
 * backslash escapes. Pipes, redirection, command separators, globbing,
 * expansion and environment assignments need a shell and are errors.
 */
export function splitCommandText(text: string): SplitResult {
	const argv: string[] = [];
	let current = "";
	let inToken = false;
	const fail = (reason: string): SplitResult => ({
		ok: false,
		error: `\${cmd:...} ${reason}; commands run without a shell`,
	});

	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string;
		if (char === " " || char === "\t") {
			if (inToken) argv.push(current);
			current = "";
			inToken = false;
			continue;
		}
		if (char === "\n" || char === "\r") return fail("contains a line break");
		if (char === "'") {
			const close = text.indexOf("'", i + 1);
			if (close === -1) return fail("has an unterminated single quote");
			current += text.slice(i + 1, close);
			inToken = true;
			i = close;
			continue;
		}
		if (char === '"') {
			let closed = false;
			for (i++; i < text.length; i++) {
				const inner = text[i] as string;
				if (inner === '"') {
					closed = true;
					break;
				}
				if (inner === "$" || inner === "`") {
					return fail(`uses "${inner}" expansion inside double quotes`);
				}
				if (inner === "\\" && i + 1 < text.length) {
					const next = text[i + 1] as string;
					if ('"\\$`'.includes(next)) {
						current += next;
						i++;
						continue;
					}
				}
				current += inner;
			}
			if (!closed) return fail("has an unterminated double quote");
			inToken = true;
			continue;
		}
		if (char === "\\") {
			if (i + 1 >= text.length) return fail("ends with a dangling backslash");
			current += text[i + 1];
			inToken = true;
			i++;
			continue;
		}
		if ("|&;<>()".includes(char)) {
			return fail(`uses the shell operator "${char}"`);
		}
		if (char === "$" || char === "`") {
			return fail(`uses "${char}" expansion`);
		}
		if ("*?[{}".includes(char)) {
			return fail(`uses the glob or brace character "${char}"`);
		}
		if (!inToken && (char === "~" || char === "#")) {
			return fail(`starts a word with "${char}"`);
		}
		if (char === "~" && text[i - 1] === "=") {
			return fail('uses "=~" tilde expansion');
		}
		current += char;
		inToken = true;
	}
	if (inToken) argv.push(current);

	const [first, ...rest] = argv;
	if (first === undefined) return fail("is empty");
	if (ASSIGNMENT.test(first))
		return fail("starts with an environment assignment");
	if (SHELL_BUILTINS.has(first))
		return fail(`runs the shell builtin "${first}"`);
	return { ok: true, argv: [first, ...rest] };
}
