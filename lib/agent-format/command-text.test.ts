import { describe, expect, test } from "bun:test";
import { scanInterpolations, splitCommandText } from "./command-text";

describe("splitCommandText", () => {
	test("keeps a double-quoted argument whole", () => {
		expect(
			splitCommandText(
				'op item get "Github CLI Token" --fields password --reveal',
			),
		).toEqual({
			ok: true,
			argv: [
				"op",
				"item",
				"get",
				"Github CLI Token",
				"--fields",
				"password",
				"--reveal",
			],
		});
	});

	test("honors single quotes and backslash escapes", () => {
		expect(splitCommandText('a \'b c\' d\\ e "f\\"g"')).toEqual({
			ok: true,
			argv: ["a", "b c", "d e", 'f"g'],
		});
	});

	test("tilde after = is literal when quoted, and builtins only matter as argv[0]", () => {
		expect(splitCommandText("op read 'a=~/x' cd")).toEqual({
			ok: true,
			argv: ["op", "read", "a=~/x", "cd"],
		});
	});

	test("shell metacharacters are literal inside quotes", () => {
		expect(splitCommandText("echo '$HOME | *' \"a;b\"")).toEqual({
			ok: true,
			argv: ["echo", "$HOME | *", "a;b"],
		});
	});

	test.each([
		"a | b",
		"a > f",
		"a < f",
		"a; b",
		"a && b",
		"a & b",
		"(a)",
		"echo $HOME",
		'echo "$HOME"',
		"echo `id`",
		"ls *.md",
		"ls a?",
		"ls [ab]",
		"echo {a,b}",
		"cat ~/x",
		"a # comment",
		"FOO=1 cmd",
		"FOO+=1 op read x",
		"op read a=~/x",
		"export X=1",
		"cd /tmp",
		"source ./env",
		". ./env",
		"eval op",
		"exec op",
		"alias x=y",
		"unset X",
		"set -e",
		"ulimit -n 1",
		"umask 077",
		"trap x EXIT",
		"a\nb",
		"",
		"   ",
		"'unterminated",
		'"unterminated',
		"trailing\\",
	])("rejects %p", (text) => {
		const result = splitCommandText(text);
		expect(result.ok).toBe(false);
	});
});

describe("scanInterpolations", () => {
	test("finds env and cmd references", () => {
		const result = scanInterpolations(
			'Bearer ${cmd:op read "a}b"} and ${env:TOKEN}',
		);
		expect(result).toEqual({
			ok: true,
			references: [
				{
					kind: "cmd",
					argv: ["op", "read", "a}b"],
					raw: '${cmd:op read "a}b"}',
				},
				{ kind: "env", name: "TOKEN", raw: "${env:TOKEN}" },
			],
		});
	});

	test("rejects bad env names and unterminated references", () => {
		expect(scanInterpolations("${env:1BAD}").ok).toBe(false);
		expect(scanInterpolations("${env:X").ok).toBe(false);
		expect(scanInterpolations("${cmd:op read").ok).toBe(false);
	});

	test("leaves other text alone", () => {
		expect(scanInterpolations("plain ${OTHER} text")).toEqual({
			ok: true,
			references: [],
		});
	});
});
