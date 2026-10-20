// Path matching for the guard and the evaluator. The guard compares an edit's
// lexical and symlink-resolved forms against each exclusion's, case folded,
// so a case variant or a symlink cannot reach an excluded file on a
// case-insensitive volume; on a case-sensitive one this can overmatch.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	resolve,
} from "node:path";
import { globRegex } from "../contract.d/lint";

const GLOB = /[*?[]/;

/** Resolve through every symlink that exists, keeping the missing suffix. */
export function resolveDeep(path: string, hops = 0): string {
	const tail: string[] = [];
	let head = path;
	for (;;) {
		try {
			if (lstatSync(head).isSymbolicLink() && hops < 40)
				return resolveDeep(
					join(resolve(dirname(head), readlinkSync(head)), ...tail),
					hops + 1,
				);
			return join(realpathSync(head), ...tail);
		} catch {
			const parent = dirname(head);
			if (parent === head) return path;
			tail.unshift(basename(head));
			head = parent;
		}
	}
}

function under(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** A path and its ancestors, for a glob that may name a directory. */
function prefixes(rel: string): string[] {
	const parts = rel.split("/");
	return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Whether a repository-relative path matches a positive glob or literal. */
export function matches(pattern: string, rel: string): boolean {
	const p = pattern.replace(/\/+$/, "");
	if (!GLOB.test(p)) return under(rel, p);
	const regex = globRegex(p);
	return prefixes(rel).some((r) => regex.test(r));
}

/**
 * The exclusion an edit of `file` (absolute, or relative to `repo`) falls
 * under, or null. Exclusions are repository-relative or absolute.
 */
export function excludedBy(
	repo: string,
	file: string,
	excluded: string[],
): string | null {
	const repoReal = resolveDeep(repo);
	const lexical = normalize(isAbsolute(file) ? file : join(repo, file));
	const forms = [lexical, resolveDeep(lexical)].map((f) => f.toLowerCase());
	const roots = [repo, repoReal].map((r) => r.toLowerCase());
	for (const e of excluded) {
		const pattern = e.replace(/\/+$/, "");
		if (GLOB.test(pattern)) {
			const regex = new RegExp(globRegex(pattern).source, "i");
			const hit = isAbsolute(pattern)
				? forms.some((f) =>
						prefixes(f.slice(1)).some((p) => regex.test(`/${p}`)),
					)
				: forms.some((f) =>
						roots.some(
							(r) =>
								f !== r &&
								under(f, r) &&
								prefixes(f.slice(r.length + 1)).some((p) => regex.test(p)),
						),
					);
			if (hit) return e;
			continue;
		}
		const lex = normalize(isAbsolute(pattern) ? pattern : join(repo, pattern));
		const targets = [
			lex,
			isAbsolute(pattern) ? lex : join(repoReal, pattern),
			resolveDeep(lex),
		].map((t) => t.toLowerCase());
		if (forms.some((f) => targets.some((t) => under(f, t)))) return e;
	}
	return null;
}

/** A repository-relative path as a checker argument: never an option. */
export function argPath(rel: string): string {
	return rel.startsWith("-") ? `./${rel}` : rel;
}
