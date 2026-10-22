// A lexical reading of a Bash command line, enough to find the git history
// writes and the file write targets in it without running anything. It splits simple commands on
// `;`, `&&`, `||`, `|`, `&`, newlines and parentheses, reads quotes and
// escapes, lifts the commands inside `$(...)`, backticks and process
// substitutions (nested in `${...}` and `$((...))` too) out as commands of
// their own, reads `find -exec` operands as a command, and skips heredoc
// bodies through their terminator. It does not follow configured aliases,
// functions, scripts, `sh -c` strings or heredoc bodies: that is the accepted
// lexical gap. Syntax it cannot place is Unclassifiable, which the guard
// refuses. A write target holding an expansion, a glob or a leading `~`, or
// written after a `cd`, is not read either; the guard says so.

/** What the reading cannot place; `what`, when set, holds an expansion. */
export class Unclassifiable extends Error {
	constructor(
		message: string,
		readonly what?: string,
	) {
		super(message);
	}
}

/** A word as read: `globs` holds the offsets of its unquoted `*`, `?`, `[`. */
export type Word = { text: string; dynamic: boolean; globs?: number[] };

/** Redirection operators that open their target for writing. */
const WRITES = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const META = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

class Lexer {
	i = 0;
	commands: Word[][] = [];
	/** Output redirection targets, in every nested list. */
	redirects: { word: Word; at: number }[] = [];
	heredocs: { delim: string; strip: boolean }[] = [];
	backticks = 0;

	constructor(readonly s: string) {}

	/** Read commands until `close` (consumed) or, with no `close`, the end. */
	list(close: ")" | "`" | null): void {
		const s = this.s;
		let words: Word[] = [];
		let target:
			| "redirect"
			| "write"
			| "duplicate"
			| "heredoc"
			| "heredoc-strip"
			| null = null;
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
					op === "<<"
						? "heredoc"
						: op === "<<-"
							? "heredoc-strip"
							: op === ">&"
								? "duplicate"
								: WRITES.has(op)
									? "write"
									: "redirect";
				continue;
			}
			const word = this.word();
			if (target) {
				// `>&2` duplicates a descriptor and `>&-` closes one.
				if (
					target === "write" ||
					(target === "duplicate" && !/^(\d+|-)$/.test(word.text))
				)
					this.redirects.push({ word, at: this.commands.length });
				if (target === "heredoc" || target === "heredoc-strip")
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

	/**
	 * Skip from an opening bracket to its partner; the content is dynamic.
	 * A command substitution met inside is lifted out as commands of its own.
	 * Quote state is tracked per expansion level: a double quote toggles this
	 * level's state, a nested `${` is read by its own call with its own
	 * state, and inside double quotes, enclosing or opened here, a single
	 * quote is a literal and brackets do not count, as Bash reads it.
	 */
	skipTo(open: string, closeCh: string, from: number, quoted = false): void {
		const s = this.s;
		let depth = 0;
		let inner = false;
		let j = from;
		while (j < s.length) {
			const ch = s[j];
			if (ch === "\\") {
				j += 2;
				continue;
			}
			if (ch === '"') {
				inner = !inner;
				j++;
				continue;
			}
			if (ch === "'" && !quoted && !inner) {
				const end = s.indexOf("'", j + 1);
				if (end < 0) break;
				j = end + 1;
				continue;
			}
			if (ch === "$" && s[j + 1] === "(" && s[j + 2] !== "(") {
				this.i = j + 2;
				this.list(")");
				j = this.i;
				continue;
			}
			if (ch === "$" && s[j + 1] === "{") {
				this.skipTo("{", "}", j + 1, quoted || inner);
				j = this.i;
				continue;
			}
			if (ch === "`") {
				this.i = j + 1;
				this.backtick();
				j = this.i;
				continue;
			}
			if (!inner && ch === open) depth++;
			else if (!inner && ch === closeCh && --depth === 0) {
				this.i = j + 1;
				return;
			}
			j++;
		}
		throw new Unclassifiable(`an unclosed ${open}`);
	}

	/** One `$`-expansion at this.i; returns its static text and whether it was dynamic. */
	dollar(quoted = false): Word {
		const s = this.s;
		const next = s[this.i + 1];
		if (next === "(" && s[this.i + 2] === "(") {
			this.skipTo("(", ")", this.i + 1, quoted);
			return { text: "", dynamic: true };
		}
		if (next === "(") {
			this.i += 2;
			this.list(")");
			return { text: "", dynamic: true };
		}
		if (next === "{") {
			this.skipTo("{", "}", this.i + 1, quoted);
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
		/** Where an unquoted glob character sits in `text`. */
		const globs: number[] = [];
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
				if (c === "*" || c === "?" || c === "[") globs.push(text.length);
				text += c;
				this.i++;
			}
		}
		return globs.length ? { text, dynamic, globs } : { text, dynamic };
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
				const w = this.dollar(true);
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

type Options = {
	flags: string[];
	valued: string[];
	/** Options whose value, if any, is attached with `=`. */
	optional?: string[];
	/** Operands the wrapper takes before the command. */
	operands?: number;
};

const WRAPPERS: Record<string, Options & { assignments?: boolean }> = {
	env: {
		flags: ["-i", "-0", "--ignore-environment", "--null"],
		valued: ["-u", "--unset", "-C", "--chdir"],
		assignments: true,
	},
	timeout: {
		flags: ["--preserve-status", "--foreground", "-v", "--verbose"],
		valued: ["-s", "--signal", "-k", "--kill-after"],
		operands: 1,
	},
	caffeinate: { flags: ["-d", "-i", "-m", "-s", "-u"], valued: ["-t", "-w"] },
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
	optional: ["--exec-path"],
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
	"revert",
	"pull",
	"send-pack",
]);
/** find's actions whose operands, up to `;` or `+`, are a command. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** find primaries that take one value, read as data. */
const FIND_VALUED = new Set(
	`-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname
	-newer -anewer -cnewer -user -group -uid -gid -perm -size -type -xtype -mtime
	-atime -ctime -mmin -amin -cmin -links -inum -samefile -maxdepth -mindepth
	-fstype -used -printf -fprint -fprint0 -fls -context -regextype -files0-from`.split(
		/\s+/,
	),
);
/** find primaries and operators that take no value. */
const FIND_BARE = new Set(
	`-print -print0 -ls -delete -prune -quit -true -false -empty -readable -writable
	-executable -depth -xdev -mount -follow -noleaf -ignore_readdir_race
	-noignore_readdir_race -daystart -nouser -nogroup -not -a -o -and -or
	( ) ! ,`.split(/\s+/),
);

/**
 * The commands a find expression's -exec, -execdir, -ok or -okdir run. The
 * expression is walked so a value such as -name's is never read as an
 * action; a primary it does not know is Unclassifiable.
 */
function findCommands(args: Word[]): {
	commands: { words: Word[]; execdir: boolean }[];
	paths: Word[];
	deletes: boolean;
} {
	const out: { words: Word[]; execdir: boolean }[] = [];
	let deletes = false;
	let k = 0;
	// -L follows symlinks, which may lead anywhere: the roots are unread.
	let follows = false;
	while (k < args.length && /^-[HLPEXsxd]+$/.test((args[k] as Word).text)) {
		if ((args[k] as Word).text.includes("L")) follows = true;
		k++;
	}
	const first = k;
	while (k < args.length) {
		const w = args[k] as Word;
		if (!w.dynamic && (w.text.startsWith("-") || FIND_BARE.has(w.text))) break;
		k++;
	}
	const paths =
		k > first ? args.slice(first, k) : [{ text: ".", dynamic: false }];
	for (; k < args.length; k++) {
		const w = args[k] as Word;
		if (w.dynamic)
			throw new Unclassifiable(
				"an unreadable find expression",
				"the find expression",
			);
		if (w.text === "-delete") deletes = true;
		// BSD's -depth takes a level; GNU's takes none.
		if (w.text === "-depth" && /^[-+]?\d+$/.test(args[k + 1]?.text ?? "")) {
			k++;
			continue;
		}
		if (FIND_BARE.has(w.text)) continue;
		if (FIND_VALUED.has(w.text) || /^-newer[aBcmt][aBcmt]$/.test(w.text)) {
			k++;
			continue;
		}
		if (w.text === "-fprintf") {
			k += 2;
			continue;
		}
		if (!FIND_EXEC.has(w.text))
			throw new Unclassifiable(`a find primary it cannot read: ${w.text}`);
		let end = k + 1;
		while (
			end < args.length &&
			!(
				!(args[end] as Word).dynamic &&
				[";", "+"].includes((args[end] as Word).text)
			)
		)
			end++;
		out.push({
			words: args.slice(k + 1, end),
			execdir: w.text === "-execdir" || w.text === "-okdir",
		});
		k = end;
	}
	const unreadRoots =
		follows || args.some((a) => a.text === "-files0-from" && !a.dynamic);
	return {
		commands: out,
		paths: unreadRoots ? [{ text: "", dynamic: true }] : paths,
		deletes,
	};
}

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
			throw new Unclassifiable(
				`an unreadable option to ${who}`,
				`an option to ${who}`,
			);
		const t = w.text;
		if (t === "--") return i + 1;
		if (!t.startsWith("-") || t === "-") return i;
		if (t.startsWith("--")) {
			const name = t.split("=")[0] as string;
			if (spec.valued.includes(name)) i += t.includes("=") ? 1 : 2;
			else if (spec.flags.includes(t) || spec.optional?.includes(name)) i++;
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

/** The value each of `names` takes among words[from..to), in order. */
function optionValues(
	words: Word[],
	from: number,
	to: number,
	short: string,
	long: string,
): Word[] {
	const out: Word[] = [];
	for (let k = from; k < to; k++) {
		const t = (words[k] as Word).text;
		if (t === long || t === short) {
			if (words[k + 1]) out.push(words[++k] as Word);
		} else if (t.startsWith(`${long}=`))
			out.push({
				text: t.slice(long.length + 1),
				dynamic: (words[k] as Word).dynamic,
			});
		else if (t.startsWith(short) && !t.startsWith("--") && t.length > 2)
			out.push({ text: t.slice(2), dynamic: (words[k] as Word).dynamic });
	}
	return out;
}

function shortCluster(
	words: Word[],
	letters: string,
	longs: string[],
): boolean {
	for (const w of words) {
		if (w.dynamic && (w.text === "" || w.text.startsWith("-")))
			throw new Unclassifiable("an unreadable git option", "a git option");
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

/** git's own commands, which an alias cannot shadow. */
const BUILTINS = new Set(
	`add am annotate apply archive bisect blame branch bundle cat-file check-ignore
	checkout cherry cherry-pick citool clean clone commit config count-objects
	describe diff difftool fetch filter-branch for-each-ref format-patch fsck gc
	grep gui help init instaweb log ls-files ls-remote ls-tree merge merge-base mv
	notes pull push range-diff rebase reflog remote repack replace request-pull
	reset restore rev-list rev-parse revert rm send-email send-pack shortlog show
	show-ref sparse-checkout stash status submodule subtree switch symbolic-ref tag
	update-index update-ref verify-commit worktree write-tree`.split(/\s+/),
);

/** git subcommands that publish history. */
const PUSHES = new Set(["push", "send-pack"]);

/**
 * The history write one git argument list makes, if any; with `push`, only
 * a push, and a known subcommand's arguments are not read. An alias the line
 * defines with `-c alias.<name>=` is read as its body; a shell alias is
 * Unclassifiable.
 */
function classifyGit(args: Word[], push: boolean, depth = 0): string | null {
	const i = consume(args, 0, GIT_GLOBAL, "git");
	const sub = args[i];
	if (!sub) return null;
	if (sub.dynamic)
		throw new Unclassifiable(
			"an unreadable git subcommand",
			"the git subcommand",
		);
	const rest = args.slice(i + 1);
	const name = sub.text;
	for (let k = 0; k < i; k++) {
		const t = (args[k] as Word).text;
		const value =
			t === "--config-env"
				? (args[k + 1]?.text ?? "")
				: t.startsWith("--config-env=")
					? t.slice(13)
					: "";
		if (value.toLowerCase().startsWith("alias."))
			throw new Unclassifiable("a git alias taken from the environment");
	}
	// Git folds the key's case, so `alias.P` defines `p`; an alias that
	// shadows a git command is ignored, as git ignores it.
	const alias = (
		BUILTINS.has(name) ? [] : optionValues(args, 0, i, "-c", "--config")
	)
		.filter((v) =>
			v.text.toLowerCase().startsWith(`alias.${name.toLowerCase()}=`),
		)
		.at(-1);
	if (alias) {
		if (alias.dynamic)
			throw new Unclassifiable("an unreadable git alias", "a git alias");
		const body = alias.text.slice(alias.text.indexOf("=") + 1).trim();
		if (body.startsWith("!"))
			throw new Unclassifiable("a git shell alias defined in the line");
		// Git unquotes the body; this reading splits on spaces only.
		if (/["'\\]/.test(body))
			throw new Unclassifiable("a git alias body with quotes or a backslash");
		if (depth > 4)
			throw new Unclassifiable("a git alias chain it cannot follow");
		const words = body
			.split(/\s+/)
			.filter(Boolean)
			.map((text) => ({ text, dynamic: false }));
		// The global options stay, so a chained alias is found again.
		return classifyGit(
			[...args.slice(0, i), ...words, ...rest],
			push,
			depth + 1,
		);
	}
	if (PUSHES.has(name)) return `git ${name}`;
	if (name === "subtree") {
		let k = 0;
		while (k < rest.length) {
			const w = rest[k] as Word;
			if (w.dynamic)
				throw new Unclassifiable(
					"an unreadable git subtree operation",
					"the git subtree operation",
				);
			if (!w.text.startsWith("-")) break;
			k += ["-P", "-m", "--prefix", "--message"].includes(w.text) ? 2 : 1;
		}
		return rest[k]?.text === "push" ? "git subtree push" : null;
	}
	if (push) return null;
	if (HISTORY.has(name)) return `git ${name}`;
	if (name === "stash") {
		const op = rest.find((w) => !w.text.startsWith("-") || w.dynamic);
		if (op?.dynamic)
			throw new Unclassifiable(
				"an unreadable git stash operation",
				"the git stash operation",
			);
		return op?.text === "drop" || op?.text === "clear"
			? `git stash ${op.text}`
			: null;
	}
	if (name === "reflog") {
		const op = rest.find((w) => !w.text.startsWith("-") || w.dynamic);
		if (op?.dynamic)
			throw new Unclassifiable(
				"an unreadable git reflog operation",
				"the git reflog operation",
			);
		return op?.text === "expire" ? "git reflog expire" : null;
	}
	if (name === "gc" && shortCluster(rest, "", ["--prune"]))
		return "git gc --prune";
	if (
		name === "branch" &&
		shortCluster(rest, "dDfmM", ["--delete", "--force", "--move"])
	)
		return "git branch (delete, force or move)";
	if (name === "checkout" && shortCluster(rest, "B", []))
		return "git checkout -B";
	if (name === "switch" && shortCluster(rest, "C", ["--force-create"]))
		return "git switch -C";
	return null;
}

/** The directory options of the wrappers that change it. */
const CHDIR: Record<string, [string, string]> = {
	env: ["-C", "--chdir"],
	sudo: ["-D", "--chdir"],
};

/**
 * The program one simple command runs, past keywords, assignments and
 * wrappers, with the directory a wrapper moved it to (relative, as
 * written; `dynamic` when it holds an expansion), or null when `command -v`
 * only looks it up.
 */
function program(
	words: Word[],
): { i: number; dir: Word | null; stdin: boolean } | null {
	let i = 0;
	let dir = null as Word | null;
	let stdin = false;
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
		if (w.dynamic)
			throw new Unclassifiable(
				"a command name it cannot read",
				"the command name",
			);
		const name = basename(w.text);
		if (name === "command") {
			// command's own options: -v and -V look a name up, -p runs it.
			i++;
			for (; i < words.length; i++) {
				const t = (words[i] as Word).text;
				if ((words[i] as Word).dynamic)
					throw new Unclassifiable(
						"an unreadable option to command",
						"an option to command",
					);
				if (t === "--") {
					i++;
					break;
				}
				if (!/^-[A-Za-z]+$/.test(t)) break;
				if (/[vV]/.test(t)) return null;
				if (!/^-p+$/.test(t))
					throw new Unclassifiable(
						`an option command takes that it cannot read: ${t}`,
					);
			}
			continue;
		}
		const wrapper = WRAPPERS[name];
		if (wrapper) {
			if (name === "xargs") stdin = true;
			const start = i + 1;
			i = consume(words, start, wrapper, name) + (wrapper.operands ?? 0);
			const chdir = CHDIR[name];
			if (chdir)
				for (const d of optionValues(words, start, i, ...chdir))
					dir =
						d.dynamic || dir?.dynamic
							? { text: "", dynamic: true }
							: {
									text:
										dir && !d.text.startsWith("/")
											? `${dir.text}/${d.text}`
											: d.text,
									dynamic: false,
								};
			if (wrapper.assignments)
				while (i < words.length && ASSIGNMENT.test((words[i] as Word).text))
					i++;
			continue;
		}
		return { i, dir, stdin };
	}
	return null;
}

/**
 * Every simple command a line runs: its own, and those its find commands
 * run, each with its program's index and wrapper directory.
 */
type Command = {
	words: Word[];
	i: number;
	dir: Word | null;
	/** Its operands come from stdin (under xargs). */
	stdin: boolean;
	/** The paths of the find that runs it, which its `{}` stands for. */
	under: Word[] | null;
	/** The paths a find's -delete removes from. */
	deletes: Word[] | null;
	/** Run by -execdir or -okdir: its operands are relative to `under`. */
	execdir: boolean;
};

function commandsOf(
	words: Word[],
	under: Word[] | null = null,
	execdir = false,
): Command[] {
	const head = program(words);
	if (!head) return [];
	const name = basename((words[head.i] as Word).text);
	if (name !== "find")
		return [{ words, ...head, under, deletes: null, execdir }];
	const found = findCommands(words.slice(head.i + 1));
	// A wrapper's directory moves find's roots as it moves any target.
	const dir = head.dir;
	const roots = found.paths.map((p) =>
		!dir || p.dynamic || p.text.startsWith("/")
			? p
			: dir.dynamic
				? { text: "", dynamic: true }
				: {
						text: `${dir.text}/${p.text}`,
						dynamic: false,
						globs: p.globs?.map((g) => g + dir.text.length + 1),
					},
	);
	return [
		{
			words,
			...head,
			dir: null,
			under,
			deletes: found.deletes ? roots : null,
			execdir,
		},
		...found.commands.flatMap((c) => commandsOf(c.words, roots, c.execdir)),
	];
}

/** Configuration the line hands git through the environment. */
const GIT_CONFIG = /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)\+?=/;

/** Builtins whose operands are assignments. */
const EXPORTS = new Set(["export", "declare", "typeset", "readonly", "local"]);

function lineCommands(source: string): Command[] {
	const all = simpleCommands(source);
	// Only an assignment sets configuration: one before the program (git's
	// prefix, env's assignments) or an export's operand, not any argument.
	for (const words of all) {
		const head = program(words);
		const name = head ? basename((words[head.i] as Word).text) : "";
		const assigned = [
			...words.slice(0, head ? head.i : words.length),
			...(head && EXPORTS.has(name) ? words.slice(head.i + 1) : []),
		];
		if (assigned.some((w) => GIT_CONFIG.test(w.text)))
			throw new Unclassifiable("git configuration set in the line");
	}
	return all.flatMap((words) => commandsOf(words));
}

/** The history write, or with `push` the push, one command makes. */
function classify(
	c: { words: Word[]; i: number },
	push: boolean,
): string | null {
	const name = basename((c.words[c.i] as Word).text);
	const args = c.words.slice(c.i + 1);
	if (name === "git") return classifyGit(args, push);
	// git's exec path holds each subcommand as git-<name>.
	const dashed = /^git-(.+)$/.exec(name);
	if (dashed)
		return classifyGit(
			[{ text: dashed[1] as string, dynamic: false }, ...args],
			push,
		);
	return null;
}

/** The first history write in a Bash command line, or null; throws Unclassifiable. */
export function historyWrite(source: string): string | null {
	for (const c of lineCommands(source)) {
		const found = classify(c, false);
		if (found) return found;
	}
	return null;
}

/** The first push in a Bash command line, or null; throws Unclassifiable. */
export function pushWrite(source: string): string | null {
	for (const c of lineCommands(source)) {
		const found = classify(c, true);
		if (found) return found;
	}
	return null;
}

/**
 * A path a command writes: `file` is the path itself, `tree` also everything
 * under it (a removal, a move's source, a recursive copy's destination).
 */
export type Target = {
	path: string;
	kind: "file" | "tree";
	/** Its last segment is a glob, for the guard to expand. */
	glob?: boolean;
};

type Writer = {
	/** Short options that take a value, attached or as the next word. */
	short: string;
	/** Long options that take a value, after `=` or as the next word. */
	long: string[];
	shape: "operands" | "trees" | "destination";
};

const COPYING = ["--target-directory", "--suffix"];
const WRITERS: Record<string, Writer> = {
	tee: { short: "", long: [], shape: "operands" },
	touch: {
		short: "tdrA",
		long: ["--reference", "--date", "--time"],
		shape: "operands",
	},
	truncate: { short: "sr", long: ["--size", "--reference"], shape: "operands" },
	unlink: { short: "", long: [], shape: "operands" },
	sed: {
		short: "efl",
		long: ["--expression", "--file", "--line-length"],
		shape: "operands",
	},
	rm: { short: "", long: [], shape: "trees" },
	rmdir: { short: "", long: [], shape: "trees" },
	mv: { short: "tS", long: COPYING, shape: "destination" },
	cp: { short: "tS", long: COPYING, shape: "destination" },
	ln: { short: "tS", long: COPYING, shape: "destination" },
	install: {
		short: "tSmogBf",
		long: [...COPYING, "--mode", "--owner", "--group", "--strip-program"],
		shape: "destination",
	},
};

/** Brace expansion, and the `{}` find and `xargs -I` replace. */
const BRACES = /\{[^{}]*(,|\.\.)[^{}]*\}|\{\}/;

/** A word the guard cannot resolve to paths; a last-segment glob it can. */
/** Whether a word holds an unquoted glob character, after `from`. */
const globbed = (w: Word, from = -1) => !!w.globs?.some((g) => g > from);

/**
 * A word the guard cannot resolve to paths: an expansion, a `~`, a brace, a
 * glob above the last segment or a character class. A last-segment glob it
 * expands; a quoted glob character is a literal.
 */
const unreadWord = (w: Word) =>
	w.dynamic ||
	w.text.startsWith("~") ||
	BRACES.test(w.text) ||
	(globbed(w) &&
		(/\[\[?:/.test(w.text) ||
			(w.globs as number[]).some((g) => g < w.text.lastIndexOf("/"))));

function target(path: string, kind: Target["kind"], glob: boolean): Target {
	return glob ? { path, kind, glob: true } : { path, kind };
}

/**
 * The paths one command writes through a known writer, relative to its
 * wrapper directory, and whether any it writes could not be read.
 */
function writeTargets(c: Command): {
	targets: Target[];
	unread: boolean;
} {
	const name = basename((c.words[c.i] as Word).text);
	const spec = WRITERS[name];
	if (!spec) return { targets: [], unread: false };
	const args = c.words.slice(c.i + 1);
	const operands: Word[] = [];
	let targetDir: Word | null = null;
	let suffix: Word | null = null;
	let inPlace = false;
	let recursive = false;
	let backup = false;
	let directories = false;
	let symbolic = false;
	let linking = false;
	for (let k = 0; k < args.length; k++) {
		const w = args[k] as Word;
		const t = w.text;
		if (t === "--" && !w.dynamic) {
			operands.push(...args.slice(k + 1));
			break;
		}
		if (w.dynamic || !t.startsWith("-") || t === "-") {
			operands.push(w);
			continue;
		}
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const opt = eq < 0 ? t : t.slice(0, eq);
			let value: Word | null =
				eq < 0 ? null : { text: t.slice(eq + 1), dynamic: false };
			if (spec.long.includes(opt) && !value) value = args[++k] ?? null;
			if (opt === "--target-directory") targetDir = value;
			if (opt === "--suffix") suffix = value;
			if (opt === "--in-place") {
				inPlace = true;
				suffix = value;
			}
			if (opt === "--recursive" || opt === "--archive") recursive = true;
			if (opt === "--backup") backup = true;
			if (opt === "--symbolic" || opt === "--symbolic-link") symbolic = true;
			if (opt === "--link") linking = true;
			if (opt === "--directory" && name === "install") directories = true;
			continue;
		}
		for (let j = 1; j < t.length; j++) {
			const ch = t[j] as string;
			const restText = t.slice(j + 1);
			if (name === "sed" && (ch === "i" || ch === "I")) {
				inPlace = true;
				if (restText) suffix = { text: restText, dynamic: false };
				else {
					// BSD sed's -i takes its suffix as the next word.
					const next = args[k + 1];
					if (next && (next.text === "" || next.text.startsWith(".")))
						suffix = args[++k] as Word;
				}
				break;
			}
			if (spec.short.includes(ch)) {
				const value: Word | null = restText
					? { text: restText, dynamic: false }
					: (args[++k] ?? null);
				if (ch === "t") targetDir = value;
				if (ch === "S" || (name === "install" && ch === "B")) suffix = value;
				break;
			}
			if (name === "cp" && "rRa".includes(ch)) recursive = true;
			if (ch === "b") backup = true;
			if (ch === "s") symbolic = true;
			if (name === "cp" && ch === "l") linking = true;
			if (name === "install" && ch === "d") directories = true;
		}
	}
	if (name === "sed" && !inPlace) return { targets: [], unread: false };
	// Operands from stdin are not on the line.
	let unread = c.stdin;
	const targets: Target[] = [];
	const add = (w: Word | string, kind: Target["kind"]) => {
		const word = typeof w === "string" ? { text: w, dynamic: false } : w;
		// -execdir runs in each found path's directory: its operands are
		// relative to paths under find's own, so those are the trees.
		if (c.execdir && c.under) {
			for (const p of c.under) put(p, "tree");
			return;
		}
		// find's `{}` stands for paths under its own: each is a tree then.
		if (c.under && word.text.includes("{}") && !word.dynamic) {
			for (const p of c.under) put(p, "tree");
			return;
		}
		put(word, kind);
	};
	const put = (word: Word, kind: Target["kind"]) => {
		if (unreadWord(word) || word.text === "" || c.dir?.dynamic) {
			unread = true;
			return;
		}
		const path =
			c.dir && !word.text.startsWith("/")
				? `${c.dir.text}/${word.text}`
				: word.text;
		targets.push(target(path, kind, globbed(word)));
		const tail = suffix ?? (backup ? { text: "~", dynamic: false } : null);
		if (tail && kind === "file") {
			if (tail.dynamic) unread = true;
			else targets.push(target(`${path}${tail.text}`, kind, globbed(word)));
		}
	};
	if (spec.shape === "operands" || directories)
		for (const o of operands) add(o, "file");
	else if (spec.shape === "trees") for (const o of operands) add(o, "tree");
	else {
		const sources = targetDir ? operands : operands.slice(0, -1);
		const dest = targetDir ?? operands.at(-1);
		if (dest) {
			add(dest, "file");
			const into = dest.text.replace(/\/+$/, "");
			if (!unreadWord(dest))
				for (const s of sources) {
					const base = basename(s.text.replace(/\/+$/, ""));
					// A recursive copy of a directory's contents (`src/`,
					// `src/.`) merges into the destination itself.
					const merges = s.text.endsWith("/") || base === "." || base === "..";
					// Where each found path lands is not on the line.
					if (c.under && s.text.includes("{}")) unread = true;
					else if (unreadWord(s)) unread = true;
					else if (recursive && merges) add(dest, "tree");
					else if (base && !merges)
						add(`${into}/${base}`, recursive ? "tree" : "file");
				}
		}
		if (name === "mv") for (const s of sources) add(s, "tree");
		// A link names its source's content by another path: writing
		// through it writes the source, so the source is a write. A
		// relative symbolic source resolves from the link's directory.
		// `cp -l` and `cp -s` link as ln does.
		if (name === "ln" || (name === "cp" && (linking || symbolic)))
			for (const s of sources) {
				add(s, "tree");
				if (symbolic && dest && !s.text.startsWith("/") && !unreadWord(s)) {
					// A destination without a slash may be an existing
					// directory: the link lands in it, or beside it.
					const into = dest.text.replace(/\/+$/, "");
					const beside =
						dest.text
							.slice(0, dest.text.lastIndexOf("/") + 1)
							.replace(/\/+$/, "") || ".";
					for (const linkDir of targetDir || dest.text.endsWith("/")
						? [into]
						: [beside, into])
						add(`${linkDir}/${s.text}`, "tree");
				}
			}
	}
	return { targets, unread };
}

/**
 * The paths a Bash command line writes by redirection or a known writer,
 * whether any write could not be read (an expansion, a glob, a `~`, a write
 * after `cd`), and the first Unclassifiable it met; what it read before
 * that is still reported.
 */
export function shellWrites(source: string): {
	targets: Target[];
	unread: boolean;
	error: Unclassifiable | null;
} {
	const lexer = new Lexer(source);
	let error: Unclassifiable | null = null;
	try {
		lexer.list(null);
	} catch (e) {
		if (!(e instanceof Unclassifiable)) throw e;
		error = e;
	}
	let unread = false;
	// The first command that changes directory; a write after it is
	// resolved against the wrong directory, so it is not read.
	let moved = Number.POSITIVE_INFINITY;
	const targets: Target[] = [];
	const found: { at: number; targets: Target[] }[] = [];
	for (const { word, at } of lexer.redirects)
		if (unreadWord(word)) unread = true;
		else
			found.push({ at, targets: [target(word.text, "file", globbed(word))] });
	lexer.commands.forEach((words, at) => {
		try {
			for (const c of commandsOf(words)) {
				const name = basename((c.words[c.i] as Word).text);
				if (["cd", "pushd", "popd"].includes(name)) moved = Math.min(moved, at);
				if (c.deletes)
					for (const p of c.deletes) {
						if (unreadWord(p)) unread = true;
						else
							found.push({ at, targets: [target(p.text, "tree", globbed(p))] });
					}
				const w = writeTargets(c);
				found.push({ at, targets: w.targets });
				unread ||= w.unread;
			}
		} catch (e) {
			if (!(e instanceof Unclassifiable)) throw e;
			error ??= e;
		}
	});
	for (const f of found) {
		targets.push(...f.targets);
		if (f.at > moved && f.targets.length) unread = true;
	}
	return { targets, unread, error };
}
