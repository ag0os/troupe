// A lexical reading of a Bash command line, enough to find the git history
// writes in it without running anything. It splits simple commands on
// `;`, `&&`, `||`, `|`, `&`, newlines and parentheses, reads quotes and
// escapes, lifts the commands inside `$(...)`, backticks and process
// substitutions out as commands of their own, and skips heredoc bodies
// through their terminator. It does not follow aliases, functions, scripts,
// `sh -c` strings or heredoc bodies: that is the accepted lexical gap. Syntax
// it cannot place is Unclassifiable, which the guard refuses.

export class Unclassifiable extends Error {}

export type Word = { text: string; dynamic: boolean };

const META = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

class Lexer {
	i = 0;
	commands: Word[][] = [];
	heredocs: { delim: string; strip: boolean }[] = [];
	backticks = 0;

	constructor(readonly s: string) {}

	/** Read commands until `close` (consumed) or, with no `close`, the end. */
	list(close: ")" | "`" | null): void {
		const s = this.s;
		let words: Word[] = [];
		let target: "redirect" | "heredoc" | "heredoc-strip" | null = null;
		let depth = 0;
		const flush = () => {
			if (target) throw new Unclassifiable("a redirection with no target");
			if (words.length) this.commands.push(words);
			words = [];
		};
		while (true) {
			if (this.i >= s.length) {
				if (close)
					throw new Unclassifiable(
						close === ")" ? "an unclosed $( or (" : "an unclosed backtick",
					);
				if (depth) throw new Unclassifiable("an unclosed (");
				flush();
				if (this.heredocs.length)
					throw new Unclassifiable("an unterminated heredoc");
				return;
			}
			const c = s[this.i] as string;
			const next = s[this.i + 1];
			if (close === "`" && c === "`") {
				this.i++;
				flush();
				return;
			}
			if (c === " " || c === "\t") {
				this.i++;
				continue;
			}
			if (c === "\\" && next === "\n") {
				this.i += 2;
				continue;
			}
			if (c === "\n") {
				this.i++;
				flush();
				this.skipHeredocs();
				continue;
			}
			if (c === "#") {
				while (this.i < s.length && s[this.i] !== "\n") this.i++;
				continue;
			}
			if (c === "(") {
				this.i++;
				flush();
				depth++;
				continue;
			}
			if (c === ")") {
				this.i++;
				flush();
				if (depth > 0) depth--;
				else if (close === ")") return;
				else throw new Unclassifiable("an unmatched )");
				continue;
			}
			if (c === ";" || c === "|" || (c === "&" && next !== ">")) {
				this.i += next === c || (c === "|" && next === "&") ? 2 : 1;
				flush();
				continue;
			}
			if (c === "<" || c === ">" || c === "&") {
				if ((c === "<" || c === ">") && next === "(") {
					// A process substitution: its commands are commands.
					this.i += 2;
					this.list(")");
					if (target) target = null;
					continue;
				}
				if (target) throw new Unclassifiable("a redirection with no target");
				const op = /^(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/.exec(
					s.slice(this.i),
				)?.[0] as string;
				this.i += op.length;
				target =
					op === "<<" ? "heredoc" : op === "<<-" ? "heredoc-strip" : "redirect";
				continue;
			}
			const word = this.word();
			if (target) {
				if (target !== "redirect")
					this.heredocs.push({
						delim: word.text,
						strip: target === "heredoc-strip",
					});
				target = null;
				continue;
			}
			// A file descriptor number written against its redirection.
			if (
				/^\d+$/.test(word.text) &&
				!word.dynamic &&
				/[<>]/.test(s[this.i] ?? "")
			)
				continue;
			words.push(word);
		}
	}

	/** Skip each pending heredoc's body, through its terminator line. */
	skipHeredocs() {
		const s = this.s;
		for (const doc of this.heredocs) {
			let found = false;
			while (this.i < s.length) {
				let end = s.indexOf("\n", this.i);
				if (end < 0) end = s.length;
				let line = s.slice(this.i, end);
				this.i = Math.min(end + 1, s.length);
				if (doc.strip) line = line.replace(/^\t+/, "");
				if (line === doc.delim) {
					found = true;
					break;
				}
			}
			if (!found) throw new Unclassifiable("an unterminated heredoc");
		}
		this.heredocs = [];
	}

	/** Skip from an opening bracket to its partner; the content is dynamic. */
	skipTo(open: string, closeCh: string, from: number): void {
		const s = this.s;
		let depth = 0;
		for (let j = from; j < s.length; j++) {
			const ch = s[j];
			if (ch === "\\") j++;
			else if (ch === "'") {
				const end = s.indexOf("'", j + 1);
				if (end < 0) break;
				j = end;
			} else if (ch === open) depth++;
			else if (ch === closeCh && --depth === 0) {
				this.i = j + 1;
				return;
			}
		}
		throw new Unclassifiable(`an unclosed ${open}`);
	}

	/** One `$`-expansion at this.i; returns its static text and whether it was dynamic. */
	dollar(): Word {
		const s = this.s;
		const next = s[this.i + 1];
		if (next === "(" && s[this.i + 2] === "(") {
			this.skipTo("(", ")", this.i + 1);
			return { text: "", dynamic: true };
		}
		if (next === "(") {
			this.i += 2;
			this.list(")");
			return { text: "", dynamic: true };
		}
		if (next === "{") {
			this.skipTo("{", "}", this.i + 1);
			return { text: "", dynamic: true };
		}
		if (next !== undefined && /[A-Za-z_]/.test(next)) {
			this.i++;
			while (/[A-Za-z0-9_]/.test(s[this.i] ?? "")) this.i++;
			return { text: "", dynamic: true };
		}
		if (next !== undefined && /[@*#?$!0-9-]/.test(next)) {
			this.i += 2;
			return { text: "", dynamic: true };
		}
		this.i++;
		return { text: "$", dynamic: false };
	}

	word(): Word {
		const s = this.s;
		let text = "";
		let dynamic = false;
		const add = (w: Word) => {
			text += w.text;
			dynamic ||= w.dynamic;
		};
		while (this.i < s.length) {
			const c = s[this.i] as string;
			if (META.has(c)) break;
			if (c === "\\") {
				if (s[this.i + 1] === "\n") this.i += 2;
				else {
					text += s[this.i + 1] ?? "";
					this.i += 2;
				}
			} else if (c === "'") {
				const end = s.indexOf("'", this.i + 1);
				if (end < 0) throw new Unclassifiable("an unclosed single quote");
				text += s.slice(this.i + 1, end);
				this.i = end + 1;
			} else if (c === "$" && s[this.i + 1] === "'") {
				this.i += 2;
				text += this.ansi();
			} else if (c === "$" && s[this.i + 1] === '"') {
				this.i++;
			} else if (c === '"') {
				this.i++;
				add(this.doubleQuoted());
			} else if (c === "$") add(this.dollar());
			else if (c === "`") {
				// Inside a backtick substitution a backtick closes it.
				if (this.backticks > 0) break;
				this.i++;
				this.backtick();
				dynamic = true;
			} else {
				text += c;
				this.i++;
			}
		}
		return { text, dynamic };
	}

	doubleQuoted(): Word {
		const s = this.s;
		let text = "";
		let dynamic = false;
		while (true) {
			if (this.i >= s.length)
				throw new Unclassifiable("an unclosed double quote");
			const c = s[this.i] as string;
			if (c === '"') {
				this.i++;
				return { text, dynamic };
			}
			if (c === "\\") {
				const n = s[this.i + 1] ?? "";
				if (n === "\n") this.i += 2;
				else if ('$`"\\'.includes(n)) {
					text += n;
					this.i += 2;
				} else {
					text += c;
					this.i++;
				}
			} else if (c === "$") {
				const w = this.dollar();
				text += w.text;
				dynamic ||= w.dynamic;
			} else if (c === "`") {
				this.i++;
				this.backtick();
				dynamic = true;
			} else {
				text += c;
				this.i++;
			}
		}
	}

	backtick() {
		this.backticks++;
		try {
			this.list("`");
		} finally {
			this.backticks--;
		}
	}

	/** The body of a `$'...'` string, with its escapes decoded. */
	ansi(): string {
		const s = this.s;
		let text = "";
		const simple: Record<string, string> = {
			n: "\n",
			t: "\t",
			r: "\r",
			a: "\x07",
			b: "\b",
			e: "\x1b",
			E: "\x1b",
			f: "\f",
			v: "\v",
			"\\": "\\",
			"'": "'",
			'"': '"',
			"?": "?",
		};
		while (true) {
			if (this.i >= s.length) throw new Unclassifiable("an unclosed $' quote");
			const c = s[this.i] as string;
			if (c === "'") {
				this.i++;
				return text;
			}
			if (c !== "\\") {
				text += c;
				this.i++;
				continue;
			}
			const n = s[this.i + 1] ?? "";
			const hex = /^x([0-9A-Fa-f]{1,2})/.exec(s.slice(this.i + 1));
			const oct = /^([0-7]{1,3})/.exec(s.slice(this.i + 1));
			if (n in simple) {
				text += simple[n];
				this.i += 2;
			} else if (hex) {
				text += String.fromCharCode(Number.parseInt(hex[1] as string, 16));
				this.i += 1 + hex[0].length;
			} else if (oct) {
				text += String.fromCharCode(Number.parseInt(oct[1] as string, 8));
				this.i += 1 + oct[0].length;
			} else
				throw new Unclassifiable(`an escape it cannot read in $'...': \\${n}`);
		}
	}
}

/** Every simple command in `source`, nested substitutions included. */
export function simpleCommands(source: string): Word[][] {
	const lexer = new Lexer(source);
	lexer.list(null);
	return lexer.commands;
}

type Options = { flags: string[]; valued: string[] };

const WRAPPERS: Record<string, Options & { assignments?: boolean }> = {
	env: {
		flags: ["-i", "-0", "--ignore-environment", "--null"],
		valued: ["-u", "--unset", "-C", "--chdir"],
		assignments: true,
	},
	command: { flags: ["-p"], valued: [] },
	exec: { flags: ["-c", "-l"], valued: ["-a"] },
	builtin: { flags: [], valued: [] },
	time: { flags: ["-p"], valued: [] },
	nohup: { flags: [], valued: [] },
	nice: { flags: [], valued: ["-n", "--adjustment"] },
	sudo: {
		flags: [
			"-E",
			"-H",
			"-n",
			"-S",
			"-b",
			"-k",
			"-K",
			"-P",
			"-A",
			"--preserve-env",
			"--non-interactive",
			"--stdin",
			"--background",
		],
		valued: [
			"-u",
			"-g",
			"-h",
			"-p",
			"-C",
			"-D",
			"-r",
			"-t",
			"-U",
			"-T",
			"--user",
			"--group",
			"--host",
			"--prompt",
			"--chdir",
		],
	},
	xargs: {
		flags: [
			"-0",
			"-r",
			"-t",
			"-p",
			"-x",
			"-o",
			"--null",
			"--no-run-if-empty",
			"--verbose",
			"--interactive",
			"--exit",
			"--open-tty",
		],
		valued: [
			"-I",
			"-L",
			"-n",
			"-P",
			"-d",
			"-E",
			"-s",
			"-a",
			"--delimiter",
			"--max-args",
			"--max-procs",
			"--arg-file",
			"--replace",
			"--max-lines",
		],
	},
};

const GIT_GLOBAL: Options = {
	flags: [
		"-p",
		"-P",
		"--paginate",
		"--no-pager",
		"--bare",
		"--no-replace-objects",
		"--no-lazy-fetch",
		"--literal-pathspecs",
		"--glob-pathspecs",
		"--noglob-pathspecs",
		"--icase-pathspecs",
		"--no-optional-locks",
		"--no-advice",
		"--exec-path",
		"--html-path",
		"--man-path",
		"--info-path",
		"--version",
		"-v",
		"--help",
		"-h",
	],
	valued: [
		"-C",
		"-c",
		"--git-dir",
		"--work-tree",
		"--namespace",
		"--super-prefix",
		"--config-env",
		"--attr-source",
		"--list-cmds",
	],
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const SKIPPED = new Set([
	"!",
	"{",
	"}",
	"if",
	"then",
	"else",
	"elif",
	"do",
	"while",
	"until",
]);
const HISTORY = new Set([
	"commit",
	"push",
	"merge",
	"rebase",
	"tag",
	"reset",
	"cherry-pick",
	"update-ref",
	"am",
	"clean",
]);
/** Words that, after an unreadable command name, could make it a history write. */
const SUSPECT = new Set([...HISTORY, "stash", "branch", "checkout", "switch"]);

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Consume the options `spec` reads from words[i..]; return the index of the
 * first operand. Unknown options and unreadable option words are
 * Unclassifiable.
 */
function consume(words: Word[], i: number, spec: Options, who: string): number {
	while (i < words.length) {
		const w = words[i] as Word;
		if (w.dynamic && (w.text === "" || w.text.startsWith("-")))
			throw new Unclassifiable(`an unreadable option to ${who}`);
		const t = w.text;
		if (t === "--") return i + 1;
		if (!t.startsWith("-") || t === "-") return i;
		if (t.startsWith("--")) {
			const name = t.split("=")[0] as string;
			if (spec.valued.includes(name)) i += t.includes("=") ? 1 : 2;
			else if (spec.flags.includes(t)) i++;
			else
				throw new Unclassifiable(
					`an option ${who} takes that it cannot read: ${t}`,
				);
			continue;
		}
		if (who === "nice" && /^-\d+$/.test(t)) {
			i++;
			continue;
		}
		let step = 1;
		for (let k = 1; k < t.length; k++) {
			const opt = `-${t[k]}`;
			if (spec.valued.includes(opt)) {
				if (k === t.length - 1) step = 2;
				break;
			}
			if (!spec.flags.includes(opt))
				throw new Unclassifiable(
					`an option ${who} takes that it cannot read: ${t}`,
				);
		}
		i += step;
	}
	return i;
}

function shortCluster(
	words: Word[],
	letters: string,
	longs: string[],
): boolean {
	for (const w of words) {
		if (w.dynamic && (w.text === "" || w.text.startsWith("-")))
			throw new Unclassifiable("an unreadable git option");
		const t = w.text;
		if (t === "--") return false;
		if (longs.includes(t.split("=")[0] as string)) return true;
		if (
			/^-[A-Za-z]/.test(t) &&
			[...t.slice(1)].some((ch) => letters.includes(ch))
		)
			return true;
	}
	return false;
}

/** The history write one git argument list makes, if any. */
function classifyGit(args: Word[]): string | null {
	const i = consume(args, 0, GIT_GLOBAL, "git");
	const sub = args[i];
	if (!sub) return null;
	if (sub.dynamic) throw new Unclassifiable("an unreadable git subcommand");
	const rest = args.slice(i + 1);
	const name = sub.text;
	if (HISTORY.has(name)) return `git ${name}`;
	if (name === "stash") {
		const op = rest.find((w) => !w.text.startsWith("-") || w.dynamic);
		if (op?.dynamic)
			throw new Unclassifiable("an unreadable git stash operation");
		return op?.text === "drop" ? "git stash drop" : null;
	}
	if (name === "branch" && shortCluster(rest, "DfmM", ["--force", "--move"]))
		return "git branch (delete, force or move)";
	if (name === "checkout" && shortCluster(rest, "B", []))
		return "git checkout -B";
	if (name === "switch" && shortCluster(rest, "C", ["--force-create"]))
		return "git switch -C";
	return null;
}

/** The history write one simple command makes, if any. */
function classify(words: Word[]): string | null {
	let i = 0;
	while (i < words.length) {
		const w = words[i] as Word;
		if (!w.dynamic && SKIPPED.has(w.text)) {
			i++;
			continue;
		}
		if (ASSIGNMENT.test(w.text)) {
			i++;
			continue;
		}
		if (w.dynamic) {
			const rest = words.slice(i);
			if (
				/git/.test(w.text) ||
				rest.some((r) => !r.dynamic && SUSPECT.has(r.text))
			)
				throw new Unclassifiable(
					"a command name it cannot read before a git-like word",
				);
			return null;
		}
		const name = basename(w.text);
		const wrapper = WRAPPERS[name];
		if (wrapper) {
			if (
				name === "command" &&
				words.slice(i + 1).some((x) => /^-[A-Za-z]*[vV]/.test(x.text))
			)
				return null;
			i = consume(words, i + 1, wrapper, name);
			if (wrapper.assignments)
				while (i < words.length && ASSIGNMENT.test((words[i] as Word).text))
					i++;
			continue;
		}
		if (name === "git") return classifyGit(words.slice(i + 1));
		return null;
	}
	return null;
}

/** The first history write in a Bash command line, or null; throws Unclassifiable. */
export function historyWrite(source: string): string | null {
	for (const words of simpleCommands(source)) {
		const found = classify(words);
		if (found) return found;
	}
	return null;
}
