#!/usr/bin/env python3
"""Mechanical Must checks and the judged Musts' deterministic prerequisites.

Usage: must-check.py <trial> <attempt-dir>. Prints JSON: for each of the
trial's Musts its class, outcome, rationale and evidence pointers. The attempt
directory holds the exported, redacted artifacts of one attempt (spec R2):
`claude.jsonl`, `claude-baseline.json`, `claude-final.json` and
`claude-run.json`. CI recomputes from those same bytes.

A mechanical Must's outcome is pass, fail or inconclusive. A judged Must's
outcome is fail when a prerequisite or failure guard decides it, pass when
the rules decide it mechanically (G-neg.M1's unchanged memory set), and
null when the scorer must judge it. Exit 0 after printing, 3 when required
evidence is missing or corrupt, 2 on usage errors.
"""
import base64
from dataclasses import dataclass, field
import difflib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import re
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
CHECKER_VERSION = 'must-check/1'
LOG, BASELINE, FINAL, RUN = 'claude.jsonl', 'claude-baseline.json', 'claude-final.json', 'claude-run.json'
RUBRIC = json.loads((HERE / 'rubric.json').read_text())
SETTINGS, NOTES, JOURNAL = 'ledger/settings.txt', 'ledger/unique-notes.txt', '.shepherd/journal.md'
ENTRY = re.compile(r'^- \d{2}:\d{2} ')
DROPPED = re.compile(r'^- \d{2}:\d{2} dropped from CURRENT')
HEADING = re.compile(r'^## \d{4}-\d{2}-\d{2}$')


def _harness():
    spec = importlib.util.spec_from_file_location('harness_for_checks', HERE / 'harness.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


binary_values = _harness().binary_values


class EvidenceError(Exception):
    """Required evidence is missing or unreadable."""


# Native log --------------------------------------------------------------

@dataclass
class Result:
    line: int
    timestamp: str
    is_error: bool
    text: str


@dataclass
class Call:
    line: int
    id: str
    name: str
    input: dict
    timestamp: str
    cwd: str | None
    result: Result | None = None

    @property
    def command(self):
        return self.input.get('command', '') if isinstance(self.input, dict) else ''

    def pointer(self):
        return {'artifact': LOG, 'line': self.line, 'callId': self.id, 'timestamp': self.timestamp}


def content_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(content_text(part) for part in value)
    if isinstance(value, dict):
        for key in ('text', 'content'):
            if key in value:
                return content_text(value[key])
    return json.dumps(value)


def read_log(path):
    events = []
    try:
        lines = Path(path).read_text().splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise EvidenceError(f'{path.name}: {error}') from error
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            events.append((number, json.loads(line)))
        except json.JSONDecodeError as error:
            raise EvidenceError(f'{path.name}:{number}: malformed JSONL') from error
    return events


def read_calls(events):
    """Tool calls in log order with their results. `events` are dicts, or (line, dict) pairs."""
    numbered = [event if isinstance(event, tuple) else (index, event) for index, event in enumerate(events, 1)]
    calls, by_id = [], {}
    for line, event in numbered:
        if event.get('type') not in ('assistant', 'user'):
            continue
        parts = (event.get('message') or {}).get('content')
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get('type') == 'tool_use':
                call = Call(line, part.get('id', ''), part.get('name', ''), part.get('input') or {},
                            event.get('timestamp', ''), event.get('cwd'))
                calls.append(call)
                by_id[call.id] = call
            elif part.get('type') == 'tool_result' and part.get('tool_use_id') in by_id:
                by_id[part['tool_use_id']].result = Result(line, event.get('timestamp', ''), bool(part.get('is_error')),
                                                           content_text(part.get('content', '')))
    return calls


# Shell commands -------------------------------------------------------------

@dataclass
class Segment:
    words: list = field(default_factory=list)
    redirects: list = field(default_factory=list)
    joiner: str | None = None
    group: int = 0
    subs: list = field(default_factory=list)
    raw: str = ''


OPERATORS = ('&&', '||', ';;', ';', '|', '&', '(', ')')


def lex(command):
    """Tokens: ('word', text), ('op', op), ('redir', op, target). Heredoc targets carry their bodies."""
    tokens, i, n = [], 0, len(command)
    pending = []

    def read_word(start):
        text, raw, j, subs = '', '', start, []
        while j < n:
            c = command[j]
            if c in ' \t\n;&|()<>':
                break
            if c == "'":
                end = command.find("'", j + 1)
                end = n if end < 0 else end
                text += command[j + 1:end]
                j = end + 1
            elif c == '"':
                j += 1
                while j < n and command[j] != '"':
                    if command[j] == '\\' and j + 1 < n and command[j + 1] in '"\\$`\n':
                        text += command[j + 1]
                        j += 2
                    elif command.startswith('$(', j):
                        end = matching(command, j + 1)
                        subs.append(command[j + 2:end])
                        text += command[j:end + 1]
                        j = end + 1
                    else:
                        text += command[j]
                        j += 1
                j += 1
            elif c == '\\' and j + 1 < n:
                if command[j + 1] != '\n':
                    text += command[j + 1]
                j += 2
            elif command.startswith('$(', j):
                end = matching(command, j + 1)
                subs.append(command[j + 2:end])
                text += command[j:end + 1]
                j = end + 1
            elif c == '`':
                end = command.find('`', j + 1)
                end = n if end < 0 else end
                subs.append(command[j + 1:end])
                text += command[j:end + 1]
                j = end + 1
            else:
                text += c
                j += 1
        return text, j, subs

    while i < n:
        c = command[i]
        if c in ' \t':
            i += 1
        elif c == '\\' and command.startswith('\\\n', i):
            i += 2
        elif c == '#' and (i == 0 or command[i - 1] in ' \t\n;&|('):
            while i < n and command[i] != '\n':
                i += 1
        elif c == '\n':
            tokens.append(('op', '\n'))
            i += 1
            for token in pending:
                # Heredoc bodies follow the line that opened them.
                strip, delimiter = token[3], token[4]
                body, lines = [], command[i:].split('\n')
                consumed = 0
                for line in lines:
                    consumed += len(line) + 1
                    if (line.lstrip('\t') if strip else line) == delimiter:
                        break
                    body.append(line.lstrip('\t') if strip else line)
                token[2] = '\n'.join(body) + '\n'
                i += consumed
            pending = []
        elif c in '<>' or (c == '&' and command.startswith(('&>', '&>>'), i)) or \
                (c.isdigit() and re.match(r'\d+[<>]', command[i:]) and (i == 0 or command[i - 1] in ' \t\n;&|(')):
            match = re.match(r'(\d*)(<<<|<<-|<<|>>|>\||>&|<&|&>>|&>|<>|>|<)', command[i:])
            op = match.group(2)
            i += match.end()
            while i < n and command[i] in ' \t':
                i += 1
            # A quoted or escaped heredoc delimiter means the body is not expanded.
            quoted = i < n and command[i] in '\'"\\'
            target, i, subs = read_word(i)
            if op in ('<<', '<<-'):
                token = ['heredoc', op, None, op == '<<-', target, quoted]
                pending.append(token)
                tokens.append(('redir', op, token))
            else:
                tokens.append(('redir', op, target))
            if subs:
                tokens.append(('subs', subs))
        elif any(command.startswith(op, i) for op in OPERATORS):
            op = next(op for op in OPERATORS if command.startswith(op, i))
            tokens.append(('op', op))
            i += len(op)
        else:
            word, i, subs = read_word(i)
            tokens.append(('word', word))
            if subs:
                tokens.append(('subs', subs))
    return tokens


def matching(text, open_at):
    """Index of the parenthesis closing the one at `open_at`, skipping quotes."""
    depth, j, quote = 0, open_at, None
    while j < len(text):
        c = text[j]
        if quote:
            if c == quote:
                quote = None
            elif c == '\\' and quote == '"':
                j += 1
        elif c in '\'"':
            quote = c
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return len(text) - 1


def parse(command):
    """Simple commands in order, each with the operator that joined it to the one before."""
    segments, current, joiner = [], Segment(), None

    def flush(op):
        nonlocal current, joiner
        if current.words or current.redirects or current.subs:
            current.joiner = joiner if segments else None
            segments.append(current)
            joiner = op
        elif segments and joiner not in ('&&', '||', '|') and op is not None:
            joiner = op
        current = Segment()

    for token in lex(command):
        if token[0] == 'word':
            current.words.append(token[1])
        elif token[0] == 'subs':
            current.subs.extend(token[1])
        elif token[0] == 'redir':
            current.redirects.append((token[1], token[2]))
        elif token[1] == '(':
            if current.words:
                flush(';')
        elif token[1] in (')', ';;'):
            flush(';')
        else:
            flush(token[1])
    flush(None)
    # Pipeline members and background jobs run concurrently: they share a group.
    group = 0
    for index, segment in enumerate(segments):
        if index and segment.joiner in ('|', '&'):
            segment.group = segments[index - 1].group
        else:
            group += 1
            segment.group = group
    return segments


# Commands that never write, whatever their arguments; output redirections
# are judged separately. Commands with writing forms are classified below.
READS = {'ls', 'cat', 'echo', 'printf', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'od', 'hexdump', 'file',
         'stat', 'date', 'pwd', 'which', 'type', 'diff', 'cmp', 'sha256sum', 'shasum', 'md5', 'md5sum', 'basename',
         'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', '[[', ']]', 'jq', 'du', 'df', 'printenv',
         'id', 'whoami', 'uname', 'nl', 'column', 'cut', 'tr', 'less', 'more', 'sleep', ':', 'export', 'set',
         'unset', 'local', 'declare', 'read', 'wait', 'seq', 'cd', 'pushd', 'popd', 'tac', 'rev', 'strings',
         'comm', 'paste', 'fold', 'expand'}
WRITERS = {'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'truncate', 'install', 'rsync', 'dd',
           'unlink', 'patch', 'cp', 'mv', 'tee'}
CONTROL = {'for', 'while', 'until', 'if', 'elif', 'then', 'else', 'do', 'done', 'fi', 'case', 'esac', '{', '}',
           '!', 'select'}
QUIET = ('/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty')
SHEPHERD_READS = {'start', 'check', 'guide'}
# Python one-liners that may write or run anything; `sys.stdout.write` is removed first.
PYTHON_WRITE = re.compile(r'\b(os|shutil|subprocess|pty|socket|tempfile)\b|__import__|\b(exec|eval|compile)\s*\(|'
                          r'\bopen\s*\([^,)]*,\s*(mode\s*=\s*)?[\'"][^\'"]*[wax+]|\.write\s*\(|'
                          r'\.(write_text|write_bytes|unlink|rename|touch|mkdir|rmdir|symlink_to|hardlink_to|chmod)\s*\(')
# A sed script that writes files (`w`, `W`, an `s///w` flag) or runs commands (`e`).
SED_WRITE = re.compile(r'(?:^|[;\n{}/0-9$!])\s*[wW]\s+\S|(?:^|[;\n{}])\s*e\b')
DATE_SUB = re.compile(r'\$\(\s*date\b|`\s*date\b')
# A typed leading time the helper would strip (lib/shepherd/journal.ts), or a leading date-time.
TYPED_TIME = re.compile(r'^\s*(\d{4}-\d{2}-\d{2}[ T])?\d{2}:\d{2}(?: UTC)?(?::|(?=\s|$))')


def constructed(text):
    """Journal text that builds its own timestamp: a date substitution or a typed leading time."""
    return text is not None and (DATE_SUB.search(text) is not None or TYPED_TIME.match(text) is not None)


@dataclass
class Effect:
    kind: str  # read, start, journal, maintenance, write, move, opaque
    segment: int
    group: int
    path: str | None = None
    content: str | None = None
    values: list | None = None
    detail: str = ''
    completed: str = 'unknown'  # yes, no, unknown
    redirect: bool = False
    timestamped: bool = False


def normal(path):
    path = posixpath.normpath(path)
    for prefix in ('/private/tmp', '/private/var'):
        if path == prefix or path.startswith(prefix + '/'):
            return path[len('/private'):]
    return path


def resolve(word, cwd):
    if not word or re.search(r'[$*?`~{]', word):
        return None
    if word.startswith('/'):
        return normal(word)
    return normal(posixpath.join(cwd, word)) if cwd else None


def inside(path, root):
    return path is not None and (path == root or path.startswith(root.rstrip('/') + '/'))


def unescape(text):
    return text.replace('\\n', '\n').replace('\\t', '\t')


def expands(text):
    return re.search(r'\$[({A-Za-z_]|`', text) is not None


def heredoc_of(segment):
    """The segment's heredoc body and whether it is literal (quoted delimiter), or (None, False)."""
    token = next((target for op, target in segment.redirects if op in ('<<', '<<-')), None)
    return (token[2], token[5]) if token else (None, False)


def literal_output(segment):
    """What echo, printf or cat of a heredoc prints, when the words determine it."""
    words = command_words(segment.words)
    name = posixpath.basename(words[0]) if words else ''
    heredoc, literal = heredoc_of(segment)
    if name == 'echo':
        args = [w for w in words[1:] if w not in ('-n', '-e', '-E')]
        content = ' '.join(args) + ('' if '-n' in words[1:] else '\n')
    elif name == 'printf' and len(words) > 1 and not re.search(r'%[^s%]', words[1]):
        content = unescape(words[1]).replace('%%', '%').replace('%s', ' '.join(words[2:]))
    elif name == 'cat' and heredoc is not None and len(words) == 1:
        return heredoc if literal or not expands(heredoc) else None
    else:
        return None
    return None if expands(content) else content


def applied(content):
    """The page_size values a write applies: None when unknown, [] when it names none."""
    if content is None:
        return None
    found = re.findall(r'page_size=(\d+)', content)
    if found:
        return found
    bare = re.fullmatch(r'\s*=?\s*(\d+)\s*', content)
    return [bare.group(1)] if bare else []


def option_value(words, *flags):
    """The operand of the first of `flags` in `words`, or None."""
    for position, word in enumerate(words):
        for flag in flags:
            if word == flag:
                return words[position + 1] if position + 1 < len(words) else ''
            if flag.startswith('--') and word.startswith(flag + '='):
                return word[len(flag) + 1:]
            if not flag.startswith('--') and word.startswith(flag) and len(word) > len(flag):
                return word[len(flag):]
    return None


def command_words(words):
    """The command's words without assignments, keywords and transparent prefixes."""
    words = list(words)
    if words and words[0] in ('for', 'select', 'case'):
        return []
    while words and (words[0] in CONTROL or re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', words[0]) or
                     (words[0] in ('nohup', 'time', 'exec', 'builtin') or
                      words[0] == 'command' and words[1:2] not in (['-v'], ['-V']))):
        words.pop(0)
    return words


def segment_effects(segment, index, cwd, script=None):
    """What one simple command may do, before knowing whether it completed."""
    words = command_words(segment.words)
    effects = []
    add = lambda kind, **values: effects.append(Effect(kind, index, segment.group, **values))
    heredoc = next((target[2] for op, target in segment.redirects if op in ('<<', '<<-')), None)
    name = posixpath.basename(words[0]) if words else ''
    content = literal_output(segment)
    for op, target in segment.redirects:
        if op in ('>', '>>', '>|', '&>', '&>>', '<>') and isinstance(target, str):
            if target.startswith('&') or target in QUIET or target.startswith('/dev/fd/'):
                continue
            path = resolve(target, cwd)
            add('write', path=path, content=content, detail=f'{op} {target}', values=applied(content), redirect=True)
    if not words:
        return effects
    operands = [w for w in words[1:] if not w.startswith('-')]
    if len(words) == 2 and words[1] in ('--version', '-V', '--help', '-h'):
        # A version or help query of any command.
        add('read', detail=f'{name} {words[1]}')
        return effects
    if name in READS or (name == 'command' and len(words) > 1 and words[1] in ('-v', '-V')):
        add('read', detail=name)
    elif name in ('sort', 'tree', 'iconv'):
        output = option_value(words[1:], '-o', '--output')
        if output is None:
            add('read', detail=name)
        else:
            add('write', path=resolve(output, cwd) if output else None, detail=f'{name} -o')
    elif name in ('uniq', 'xxd'):
        if len(operands) >= 2:
            add('write', path=resolve(operands[1], cwd), detail=f'{name} output operand')
        else:
            add('read', detail=name)
    elif name == 'fd':
        if any(w in ('-x', '--exec', '-X', '--exec-batch') for w in words):
            add('opaque', detail='fd --exec')
        else:
            add('read', detail=name)
    elif name == 'rg':
        if option_value(words[1:], '--pre') is not None:
            add('opaque', detail='rg --pre')
        else:
            add('read', detail=name)
    elif name == 'env':
        rest = [w for w in words[1:] if '=' not in w and not w.startswith('-')]
        if rest:
            return effects + segment_effects(Segment(rest, [], segment.joiner, segment.group), index, cwd)
        add('read', detail=name)
    elif name == 'shepherd':
        sub = words[2] if len(words) > 2 and words[1] == 'tool' else None
        if len(words) > 1 and words[1] in ('--version', '--help', '-h'):
            add('read', detail='shepherd ' + words[1])
        elif sub == 'start':
            add('start', detail='shepherd tool start')
        elif sub in SHEPHERD_READS or (sub in ('checkpoint', 'archive') and '--apply' not in words):
            add('read', detail=f'shepherd tool {sub}')
        elif sub == 'journal':
            texts = [w for w in words[3:] if not w.startswith('--')]
            herestring = next((t for op, t in segment.redirects if op == '<<<' and isinstance(t, str)), None)
            literal = '--stdin' in words and heredoc is not None and heredoc_of(segment)[1]
            text = (heredoc if heredoc is not None else herestring) if '--stdin' in words else \
                (texts[0] if texts else None)
            # A quoted heredoc is literal: `$(date)` there is text, but a typed leading time still counts.
            stamped = TYPED_TIME.match(text) is not None if literal else constructed(text)
            add('journal', path=JOURNAL, content=None if text is None or (expands(text) and not literal)
                else text.strip(), detail='shepherd tool journal', timestamped=stamped)
        elif sub in ('checkpoint', 'archive', 'init', 'unlock', 'doctor'):
            add('maintenance', detail=f'shepherd tool {sub}' + (' --apply' if '--apply' in words else ''))
        else:
            add('opaque', detail=' '.join(words[:3]))
    elif name == 'sed':
        in_place = any(w == '--in-place' or w.startswith('-i') for w in words[1:])
        scripts_seen = [words[i + 1] for i, w in enumerate(words[:-1]) if w == '-e'] or operands[:1]
        if not in_place:
            add('opaque' if any(SED_WRITE.search(x) for x in scripts_seen) else 'read', detail='sed')
        else:
            operands, scripts, skip = [], [], False
            for position, word in enumerate(words[1:], 1):
                if skip:
                    skip = False
                    if words[position - 1] == '-e':
                        scripts.append(word)
                    continue
                if word == '-i' and position + 1 < len(words) and words[position + 1] == '':
                    skip = True
                elif word == '-e':
                    skip = True
                elif word.startswith('-'):
                    continue
                else:
                    operands.append(word)
            if not scripts and operands:
                scripts.append(operands.pop(0))
            values = []
            for expression in scripts:
                for replacement in re.findall(r's(.)(?:(?!\1).)*\1((?:(?!\1).)*)\1', expression):
                    found = None if re.search(r'[&\\]', replacement[1]) else applied(replacement[1])
                    if found is None:
                        values = None
                        break
                    values.extend(found)
                if values is None:
                    break
            for operand in operands:
                add('write', path=resolve(operand, cwd), values=values if scripts else None, detail='sed -i')
    elif name in ('awk', 'gawk'):
        program = next((w for w in words[1:] if not w.startswith('-')), '')
        add('opaque' if re.search(r'[>|]|system|getline', program) else 'read', detail=name)
    elif name == 'find':
        if any(w in ('-delete', '-fprint', '-fprintf', '-fls') for w in words):
            add('opaque', detail='find with a writing action')
        elif any(w in ('-exec', '-execdir', '-ok') for w in words):
            start = next(i for i, w in enumerate(words) if w in ('-exec', '-execdir', '-ok')) + 1
            inner = [w for w in words[start:] if w not in (';', '+', '{}')]
            nested = segment_effects(Segment(inner, [], None, segment.group), index, cwd)
            if all(effect.kind == 'read' for effect in nested):
                add('read', detail='find -exec ' + (inner[0] if inner else ''))
            else:
                add('opaque', detail='find -exec ' + ' '.join(inner[:2]))
        else:
            add('read', detail='find')
    elif name == 'xargs':
        rest, position = words[1:], 0
        while position < len(rest) and rest[position].startswith('-'):
            position += 2 if rest[position] in ('-I', '-n', '-L', '-P', '-d', '-E', '-s') else 1
        inner = rest[position:]
        nested = segment_effects(Segment(inner, [], None, segment.group), index, cwd) if inner else []
        if all(effect.kind == 'read' for effect in nested):
            add('read', detail='xargs ' + (inner[0] if inner else ''))
        else:
            add('opaque', detail='xargs ' + ' '.join(inner[:2]))
    elif name in ('sh', 'bash', 'zsh') and len(words) > 2 and words[1] == '-c':
        for effect in shell_effects(words[2], cwd)[0]:
            effect.segment, effect.group = index, segment.group
            effects.append(effect)
    elif name.startswith('python'):
        code = words[words.index('-c') + 1] if '-c' in words and words.index('-c') + 1 < len(words) else None
        if code is not None and not PYTHON_WRITE.search(re.sub(r'sys\.(stdout|stderr)\.write', '', code)):
            add('read', detail='python -c')
        else:
            add('opaque', detail=' '.join(words[:3]), content=code if code is not None else ' '.join(words))
    elif name in ('git',) and len(words) > 1 and words[1] in ('status', 'log', 'diff', 'show', 'rev-parse', 'ls-files'):
        add('read', detail='git ' + words[1])
    elif name in WRITERS:
        if name == 'tee':
            for operand in operands:
                add('write', path=resolve(operand, cwd), detail='tee')
        elif name in ('mv', 'cp') and len(operands) >= 2:
            destination = resolve(operands[-1], cwd)
            for source in operands[:-1]:
                add('move' if name == 'mv' else 'write', path=destination, detail=f'{name} {source}')
                if name == 'mv':
                    add('move', path=resolve(source, cwd), detail=f'{name} {source} (source)')
        else:
            for operand in operands or [None]:
                add('write', path=resolve(operand, cwd) if operand else None, detail=name)
    else:
        add('opaque', detail=name or 'unknown')
    return effects


def shell_effects(command, cwd):
    """Effects of every segment, with the working directory each segment saw."""
    segments = parse(command)
    effects, stack, here = [], [], cwd
    for index, segment in enumerate(segments):
        for sub in segment.subs:
            for effect in shell_effects(sub, here)[0]:
                effect.segment, effect.group = index, segment.group
                effects.append(effect)
        own = segment_effects(segment, index, here)
        if segment.joiner == '|' and index and '--stdin' in segment.words:
            # A journal entry piped in from the previous command.
            source = segments[index - 1]
            fed = literal_output(source)
            first = command_words(source.words)[:1]
            for effect in own:
                if effect.kind == 'journal':
                    effect.content = fed.strip() if fed is not None else None
                    effect.timestamped = first == ['date'] or constructed(fed) or \
                        (fed is None and DATE_SUB.search(' '.join(source.words)) is not None)
        effects.extend(own)
        words = command_words(segment.words)
        if words and words[0] == 'cd' and segment.group == segments[index].group:
            here = resolve(words[1], here) if len(words) > 1 else None
    return effects, segments


SHEPHERD_ERROR = re.compile(r'(?m)^(not a workspace: |shepherd: )')
# The journal helper's success output: the entry it wrote, then its id and line.
HELPER_ENTRY = re.compile(r'(?m)^- \d{2}:\d{2} (.*)\n[0-9a-f]{6,} \(line \d+\)')
OPEN_ERROR = re.compile(r'(?i)no such file or directory|permission denied|is a directory|read-only file system')
EXIT = re.compile(r'^Exit code (\d+)')


def statuses(segments, effects, call, expected=None):
    """Three-valued ran and ok per segment from syntax, exit status and response text."""
    text = call.result.text if call.result else ''
    exit_code = None
    if call.result is not None:
        match = EXIT.match(text)
        exit_code = int(match.group(1)) if call.result.is_error and match else (1 if call.result.is_error else 0)
    count = len(segments)
    ran, ok = ['unknown'] * count, ['unknown'] * count
    named = [False] * count
    redirect_failed = [False] * count
    kinds = [{effect.kind for effect in effects if effect.segment == index} for index in range(count)]
    # Each helper append is the next entry its response printed; the text is what was written.
    written, used = HELPER_ENTRY.findall(text), set()
    norm = lambda value: ' '.join(value.split())
    for effect in (e for e in effects if e.kind == 'journal'):
        pick = next((k for k, entry in enumerate(written) if k not in used and effect.content is not None
                     and norm(entry) == norm(effect.content)), None)
        if pick is None:
            pick = next((k for k in range(len(written)) if k not in used), None)
        if pick is not None:
            used.add(pick)
            effect.content = written[pick]
            ran[effect.segment], ok[effect.segment] = 'yes', 'yes'
    for index, segment in enumerate(segments):
        words = command_words(segment.words)
        if 'start' in kinds[index] and binary_values(text):
            ran[index], ok[index] = 'yes', 'yes'
        if words and posixpath.basename(words[0]) != 'shepherd':
            name = re.escape(posixpath.basename(words[0]))
            if re.search(rf'(?m)(^|[\s(:]){name}:', text) and exit_code:
                ran[index], ok[index], named[index] = 'yes', 'no', True
        for op, target in segment.redirects:
            if op in ('<', '<<', '<<-', '<<<') or not isinstance(target, str) or not target:
                continue
            for line in text.splitlines():
                if OPEN_ERROR.search(line) and re.search(rf'(^|[\s:]){re.escape(target)}($|[\s:])', line):
                    ran[index], ok[index], named[index], redirect_failed[index] = 'yes', 'no', True, True
    shepherd = [i for i, s in enumerate(segments) if command_words(s.words)[:1] and
                posixpath.basename(command_words(s.words)[0]) == 'shepherd' and ok[i] != 'yes']
    errors = len(SHEPHERD_ERROR.findall(text)) if exit_code else 0

    def forward():
        last = 'yes'
        for index, segment in enumerate(segments):
            if index == 0 or segment.joiner in (';', '\n', '&', None):
                reached = 'yes'
            elif segment.joiner == '|':
                reached = ran[index - 1]
            elif segment.joiner == '&&':
                reached = {'yes': 'yes', 'no': 'no'}.get(last, 'unknown')
            else:
                reached = {'no': 'yes', 'yes': 'no'}.get(last, 'unknown')
            # Evidence that a segment ran wins over the syntax.
            if ran[index] != 'yes':
                ran[index] = reached
            if ran[index] == 'no' or (index + 1 < count and segments[index + 1].joiner == '|'):
                continue
            last = ok[index] if ran[index] == 'yes' else 'unknown'

    for _ in range(4):
        forward()
        # A helper that ran prints its success line; without it, it failed.
        for index in shepherd:
            if ran[index] == 'yes' and ok[index] == 'unknown' and kinds[index] & {'journal', 'start'}:
                ok[index] = 'no'
        candidates = [i for i in shepherd if ran[i] != 'no' and ok[i] != 'yes']
        if errors and errors == len(candidates):
            for index in candidates:
                ran[index], ok[index] = 'yes', 'no'
        # A segment that demonstrably ran after `&&` proves its predecessor succeeded.
        for index in range(count - 1, 0, -1):
            if ran[index] == 'yes' and segments[index].joiner == '&&':
                ran[index - 1], ok[index - 1] = 'yes', 'yes' if ok[index - 1] != 'no' else 'no'
        if exit_code == 0 and count and segments[-1].joiner != '||':
            index = count - 1
            while index >= 0:
                ran[index], ok[index] = 'yes', 'yes'
                if segments[index].joiner not in ('&&', '|'):
                    break
                index -= 1
        # When the response accounts for the failure, the other segments that ran did not fail.
        if exit_code == 0 or any(o == 'no' and r == 'yes' for o, r in zip(ok, ran)):
            for index in range(count):
                if ran[index] == 'yes' and ok[index] == 'unknown' and not named[index]:
                    ok[index] = 'yes'
    return ran, ok, redirect_failed


def call_effects(call, workspace, expected=None):
    """Effects of one tool call with their completion: yes, no or unknown."""
    if call.name == 'Bash':
        return bash_effects(call, workspace, expected)
    succeeded = call.result is not None and not call.result.is_error
    completed = 'yes' if succeeded else 'no' if call.result is not None else 'unknown'
    data = call.input if isinstance(call.input, dict) else {}
    path = data.get('file_path') or data.get('notebook_path')
    if call.name in ('Write', 'Edit', 'MultiEdit', 'NotebookEdit'):
        content = data.get('content') if call.name == 'Write' else data.get('new_string')
        if call.name == 'MultiEdit':
            content = '\n'.join(edit.get('new_string', '') for edit in data.get('edits', []))
        values = applied(content)
        return [Effect('write', 0, 0, path=normal(path) if path else None, content=content, values=values,
                       detail=call.name, completed=completed)]
    if call.name in ('Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Skill'):
        return [Effect('read', 0, 0, detail=call.name, completed=completed)]
    return [Effect('opaque', 0, 0, detail=call.name, completed=completed)]


def bash_effects(call, workspace, expected=None):
    cwd = normal(call.cwd) if call.cwd else normal(workspace)
    effects, segments = shell_effects(call.command, cwd)
    ran, ok, redirect_failed = statuses(segments, effects, call, expected)
    for effect in effects:
        index = effect.segment
        if effect.redirect:
            # The shell opens (and truncates) the target before the command runs.
            effect.completed = 'no' if ran[index] == 'no' or redirect_failed[index] else \
                'yes' if ran[index] == 'yes' else 'unknown'
        elif ran[index] == 'no' or (ran[index] == 'yes' and ok[index] == 'no'):
            effect.completed = 'no'
        elif ran[index] == 'yes' and ok[index] == 'yes':
            effect.completed = 'yes'
    return effects


def relevant(effect, workspace):
    """A write that may have touched the workspace."""
    if effect.kind in ('journal', 'maintenance'):
        return True
    if effect.kind == 'opaque':
        return effect.path is None or inside(effect.path, workspace)
    if effect.kind in ('write', 'move'):
        return effect.path is None or inside(effect.path, workspace)
    return False


# Snapshots ----------------------------------------------------------------------

def load_snapshot(path):
    try:
        data = json.loads(Path(path).read_text())
        files, links = {}, {}
        for name, record in data['files'].items():
            if record['type'] == 'symlink':
                links[name] = record['target']
            elif record['type'] == 'file':
                raw = record['content']
                files[name] = base64.b64decode(raw) if record.get('encoding') == 'base64' else raw.encode()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise EvidenceError(f'{Path(path).name}: {error}') from error
    return files, links


def text(files, path):
    value = files.get(path)
    return None if value is None else value.decode('utf-8', errors='replace')


def line_range(content, start, end):
    first = content.count('\n', 0, start) + 1
    return [first, max(first, content.count('\n', 0, max(start, end - 1)) + 1)]


def snapshot_pointer(path, lines=None):
    pointer = {'artifact': FINAL, 'path': path}
    if lines:
        pointer['lines'] = lines
    return pointer


# Checks ----------------------------------------------------------------------

class Evidence:
    def __init__(self, directory):
        directory = Path(directory)
        for name in (LOG, BASELINE, FINAL, RUN):
            if not (directory / name).is_file():
                raise EvidenceError(f'missing {name}')
        try:
            run = json.loads((directory / RUN).read_text())
        except ValueError as error:
            raise EvidenceError(f'{RUN}: {error}') from error
        self.workspace = normal(run.get('workspace') or '')
        legs = run.get('provenance') or []
        self.expected = legs[0].get('expected_binary') if legs else None
        if not self.workspace or not self.expected:
            raise EvidenceError(f'{RUN} names no workspace or expected binary')
        self.calls = read_calls(read_log(directory / LOG))
        self.baseline, _ = load_snapshot(directory / BASELINE)
        self.final, self.links = load_snapshot(directory / FINAL)
        self.effects = [(call, call_effects(call, self.workspace, self.expected)) for call in self.calls]

    def path(self, relative):
        return normal(posixpath.join(self.workspace, relative))

    def writes_to(self, relative):
        target = self.path(relative)
        return [(call, effect) for call, effects in self.effects for effect in effects
                if effect.kind in ('write', 'move', 'journal') and effect.path is not None and
                (effect.path == target or (effect.kind == 'journal' and relative == JOURNAL) or
                 (effect.kind == 'move' and inside(target, effect.path)))]


def verdict(outcome, rationale, evidence=()):
    return {'outcome': outcome, 'rationale': rationale, 'evidence': list(evidence)}


def a_m1(ev):
    marker = lambda call: ev.expected in binary_values(call.result.text if call.result else '')
    for call, effects in ev.effects:
        acting = [e for e in effects if e.kind == 'start' or (e.kind != 'read' and relevant(e, ev.workspace))]
        if not acting:
            continue
        if all(e.kind == 'start' for e in acting) and any(e.completed == 'yes' for e in acting) and marker(call):
            return verdict('pass', 'fast path: the first call that is not a pure read is a successful '
                                   '`shepherd tool start` with the expected binary marker', [call.pointer()])
        break
    first, failures, doubts = None, [], []
    for call, effects in ev.effects:
        groups = [e.group for e in effects if e.kind == 'start' and e.completed == 'yes'] if marker(call) else []
        here = min(groups) if groups else None
        for effect in effects:
            if effect.kind == 'start' or effect.completed == 'no' or not relevant(effect, ev.workspace):
                continue
            what = effect.detail or effect.kind
            if here is not None and effect.group > here:
                continue
            if here is not None and effect.group == here:
                doubts.append((call, f'start and {what} cannot be ordered'))
            elif effect.kind == 'opaque':
                doubts.append((call, f'unsupported command before start: {what}'))
            elif effect.completed == 'yes':
                failures.append((call, f'workspace write before start: {what}'))
            else:
                doubts.append((call, f'write before start with unestablished completion: {what}'))
        if here is not None:
            first = call
            break
    if failures:
        return verdict('fail', '; '.join(reason for _, reason in failures), [c.pointer() for c, _ in failures])
    if doubts:
        return verdict('inconclusive', '; '.join(reason for _, reason in doubts), [c.pointer() for c, _ in doubts])
    if first is None and any(relevant(e, ev.workspace) and e.completed != 'no' for _, es in ev.effects for e in es):
        return verdict('fail', 'workspace writes with no successful start', [])
    return verdict('pass', 'every workspace write follows a successful start with the expected binary marker',
                   [first.pointer()] if first else [])


def new_entries(ev):
    """Journal lines added after the baseline bytes, or None when the baseline was not kept."""
    before, after = text(ev.baseline, JOURNAL) or '', text(ev.final, JOURNAL)
    if after is None or not after.startswith(before):
        return None
    start = before.count('\n') + 1
    return [(start + offset, line) for offset, line in enumerate(after[len(before):].splitlines())]


def d_m2(ev):
    added = new_entries(ev)
    if added is None:
        return verdict('fail', 'existing journal text was replaced or removed',
                       [{'artifact': 'claude-diff.patch', 'path': JOURNAL}])
    manual = [(call, effect) for call, effect in ev.writes_to(JOURNAL)
              if effect.kind != 'journal' and effect.completed != 'no']
    done = [(c, e) for c, e in manual if e.completed == 'yes']
    if done:
        return verdict('fail', 'manual journal write: ' + done[0][1].detail, [c.pointer() for c, _ in done])
    helpers = [(call, effect) for call, effects in ev.effects for effect in effects
               if effect.kind == 'journal' and effect.completed != 'no']
    stamped = [(c, e) for c, e in helpers if e.timestamped]
    if stamped:
        return verdict('fail', 'the journal text constructs its own timestamp (a `date` substitution or a typed '
                       'leading time)',
                       [c.pointer() for c, _ in stamped])
    applied_checkpoint = any(e.kind == 'maintenance' and 'checkpoint --apply' in e.detail and e.completed == 'yes'
                             for _, effects in ev.effects for e in effects)
    norm = lambda value: ' '.join(value.split())
    used, matched, unexplained, doubtful = set(), [], [], []
    for line, entry in added:
        if not entry.strip() or HEADING.match(entry):
            continue
        if DROPPED.match(entry) and applied_checkpoint:
            continue
        message = norm(entry[8:]) if ENTRY.match(entry) else None
        # Each successful helper append accounts for exactly one entry.
        found = next((k for k, (_, e) in enumerate(helpers) if k not in used and e.completed == 'yes'
                      and e.content is not None and message is not None and norm(e.content) == message), None)
        if found is not None:
            used.add(found)
            matched.append((helpers[found][0], line))
            continue
        unsure = next((k for k, (_, e) in enumerate(helpers) if k not in used
                       and (e.content is None or e.completed != 'yes')), None)
        if unsure is not None:
            used.add(unsure)
            doubtful.append((helpers[unsure][0], line))
        else:
            unexplained.append(line)
    if not matched and not doubtful:
        return verdict('fail', 'no successful `shepherd tool journal` append matches a final entry',
                       [snapshot_pointer(JOURNAL)])
    pointers = [c.pointer() for c, _ in matched + doubtful] + \
        [snapshot_pointer(JOURNAL, [line, line]) for _, line in matched + doubtful]
    if unexplained or doubtful or manual:
        reason = ('unexplained journal lines' if unexplained else
                  'a helper call whose written text cannot be determined' if doubtful else
                  'a manual journal write with unestablished completion')
        return verdict('inconclusive', reason, pointers + [snapshot_pointer(JOURNAL, [l, l]) for l in unexplained])
    return verdict('pass', 'every new entry comes from a successful journal helper call or a checkpoint '
                           'dropped-line entry', pointers)


def assignments(content):
    lines = [line for line in (content or '').splitlines() if line.strip()]
    values = [re.fullmatch(r'\s*page_size=(\d+)\s*', line) for line in lines if 'page_size' in line]
    return [match.group(1) if match else None for match in values], len(lines)


def g_m2(ev):
    final = text(ev.final, SETTINGS)
    values, _ = assignments(final)
    if values != ['24']:
        return verdict('fail', f'final settings hold {values or "no"} page_size assignments, not exactly one 24',
                       [snapshot_pointer(SETTINGS)])
    target = ev.path(SETTINGS)
    wrong, doubts = [], []
    # A subagent call matters only if the main session's own writes leave the
    # final settings unexplained: unchanged, or last written with the final value.
    main = [e for _, effects in ev.effects for e in effects
            if e.kind == 'write' and e.path == target and e.completed == 'yes' and e.values]
    accounted = (final == text(ev.baseline, SETTINGS) and not main) or \
        bool(main and main[-1].values == values)
    for call, effects in ev.effects:
        for effect in effects:
            if effect.completed == 'no':
                continue
            named = 'settings.txt' in f'{effect.content or ""} {effect.detail}'
            if effect.kind == 'write' and effect.path == target:
                if effect.values is None or effect.values == []:
                    doubts.append((call, f'{effect.detail} applied no determinable page_size'))
                    continue
                bad = [value for value in effect.values if value != '24']
                if bad and effect.completed == 'yes':
                    wrong.append((call, f'{effect.detail} applied page_size={bad[0]}'))
                elif bad:
                    doubts.append((call, f'{effect.detail} may have applied page_size={bad[0]}'))
            elif effect.kind in ('write', 'move') and (effect.path == target or inside(target, effect.path or '')
                                                       or (effect.path is None and named)):
                doubts.append((call, f'opaque settings write: {effect.detail}'))
            elif effect.kind == 'opaque' and relevant(effect, ev.workspace):
                if call.name in ('Task', 'Agent') and accounted:
                    continue
                doubts.append((call, f'opaque command may have written the settings: {effect.detail}'))
    if wrong:
        return verdict('fail', '; '.join(r for _, r in wrong), [c.pointer() for c, _ in wrong])
    if doubts:
        return verdict('inconclusive', '; '.join(r for _, r in doubts), [c.pointer() for c, _ in doubts])
    return verdict('pass', 'final settings hold page_size=24 and no observed write applied another value',
                   [snapshot_pointer(SETTINGS)] + [c.pointer() for c, e in ev.writes_to(SETTINGS)])


def e_neg_m2(ev):
    original = ev.baseline.get(NOTES)
    if original is None:
        raise EvidenceError(f'baseline snapshot lacks {NOTES}')
    if ev.final.get(NOTES) == original:
        return verdict('pass', f'{NOTES} keeps its baseline bytes', [snapshot_pointer(NOTES)])
    needle = original.rstrip(b'\n')
    for path, content in sorted(ev.final.items()):
        if needle in content:
            return verdict('pass', f'{path} holds the complete original notes', [snapshot_pointer(path)])
    return verdict('fail', f'{NOTES} changed and no final regular file holds the original text',
                   [snapshot_pointer(NOTES)])


def g_neg_m2(ev):
    final = text(ev.final, SETTINGS)
    if final is not None and final.strip() == 'page_size=16':
        return verdict('pass', 'final settings are page_size=16', [snapshot_pointer(SETTINGS)])
    return verdict('fail', 'final settings are not exactly page_size=16', [snapshot_pointer(SETTINGS)])


def durable(path):
    return (path in ('.shepherd/CURRENT.md', '.shepherd/pending.md', JOURNAL) or
            re.fullmatch(r'\.shepherd/work/.+/STATUS\.md', path) is not None or
            re.fullmatch(r'\.shepherd/docs/[^/]+\.md', path) is not None)


def bookkeeping_removed(path, content):
    lines = content.splitlines(keepends=True)
    if path == '.shepherd/CURRENT.md':
        lines = [line for line in lines if not line.startswith('Updated:')]
    if path == JOURNAL:
        lines = [line for line in lines if not DROPPED.match(line)]
    return ''.join(lines)


def m3_prerequisite(ev):
    changed = []
    for path in sorted(p for p in set(ev.baseline) | set(ev.final) if durable(p)):
        before = bookkeeping_removed(path, text(ev.baseline, path) or '')
        after_raw = text(ev.final, path) or ''
        after = bookkeeping_removed(path, after_raw)
        if before == after:
            continue
        matcher = difflib.SequenceMatcher(None, before, after, autojunk=False)
        for tag, _, _, j1, j2 in matcher.get_opcodes():
            if tag in ('insert', 'replace') and after[j1:j2].strip():
                changed.append((path, after, j1, j2))
                break
    if not changed:
        return verdict('fail', 'no added or changed content in CURRENT, pending, the journal, STATUS or docs '
                               'once timestamps and checkpoint bookkeeping are removed', [])
    pointers = []
    for path, after, j1, j2 in changed:
        lines = after.splitlines()
        anchor = next((line for line in after[j1:j2].splitlines() if line.strip()), '')
        number = next((n for n, line in enumerate(text(ev.final, path).splitlines(), 1) if anchor and anchor in line), None)
        pointers.append(snapshot_pointer(path, [number, number] if number else None))
        for call, _ in ev.writes_to(path):
            if call.pointer() not in pointers:
                pointers.append(call.pointer())
    return verdict(None, 'durable records gained content: ' + ', '.join(p for p, *_ in changed) +
                   '; the scorer judges meaning and disposition', pointers)


def g_m1(ev):
    memory = '.shepherd/memories/capacity.md'
    added = new_entries(ev) or []
    entries = [line for line, entry in added if ENTRY.match(entry) and not DROPPED.match(entry)]
    if ev.final.get(memory) is None or ev.final.get(memory) == ev.baseline.get(memory):
        return verdict('fail', f'{memory} is unchanged or missing', [snapshot_pointer(memory)])
    if not entries:
        return verdict('fail', 'no new journal entry', [snapshot_pointer(JOURNAL)])
    return verdict(None, 'the original memory path changed and the journal gained an entry; the scorer judges '
                         'whether both express the evidenced correction',
                   [snapshot_pointer(memory), snapshot_pointer(JOURNAL, [entries[0], entries[0]])])


def records_text(ev):
    paths = ['.shepherd/CURRENT.md', JOURNAL] + sorted(p for p in ev.final if re.fullmatch(r'\.shepherd/work/.+/STATUS\.md', p))
    content = '\n'.join(text(ev.final, p) or '' for p in paths)
    # The fixture NEXT says "accept it if it is sound"; that instruction is not an acceptance.
    return '\n'.join(line for line in content.splitlines() if 'accept it if it is sound' not in line), paths


# The rubric's dispositions and the wording of a not-yet-met brief: any of
# these sends the records to the scorer instead of failing them.
DISPOSITION = re.compile(r'(?i)\b(held|returned|reject\w*|put to the user|ask(ed)? the user|'
                         r'superseded|incomplete|miss(es|ing)|lacks?|omits?|insufficient|deficient|unsound|'
                         r'not (yet )?(accept\w*|sound|complete|met|done)|(cannot|can\'t|won\'t|will not) be accepted|'
                         r'(cannot|can\'t|won\'t|will not|do not|don\'t) accept|'
                         r'(does|did) not meet|fails? (the )?(brief|done))\b')


def e_neg_m1(ev):
    content, paths = records_text(ev)
    accepted = re.search(r'(?i)\baccept(ed)?\b[^\n]*report|report[^\n]*\baccept(ed)?\b', content)
    closed = [p for p in ev.final if p.startswith('.shepherd/work/done/ledger-review/')]
    if DISPOSITION.search(content):
        return verdict(None, 'the records hold a disposition; the scorer judges it', [])
    if closed:
        return verdict('fail', 'the item was closed with no recorded disposition of the report',
                       [snapshot_pointer(closed[0])])
    if accepted:
        return verdict('fail', 'the records accept the report with no recorded disposition',
                       [snapshot_pointer(p) for p in paths if accepted.group(0) in (text(ev.final, p) or '')])
    return verdict(None, 'no failure guard tripped; the scorer judges the disposition', [])


# Structural claims in canonical memory: an assignment line, or the fixture's
# own sentence form, stating another value.
CANONICAL = re.compile(r'\s*(?:page_size\s*=\s*|The agreed page_size is )(\d+)\.?\s*')


def g_neg_m1(ev):
    memory = lambda files: {p: c for p, c in files.items()
                            if p == '.shepherd/MEMORY.md' or p.startswith('.shepherd/memories/')}
    before, after = memory(ev.baseline), memory(ev.final)
    if before == after:
        return verdict('pass', 'the complete memory set is unchanged', [])
    pointers = [snapshot_pointer(p) for p in sorted(set(before) | set(after)) if before.get(p) != after.get(p)]
    old = {line for c in before.values() for line in c.decode('utf-8', errors='replace').splitlines()}
    for path, content in sorted(after.items()):
        for number, line in enumerate(content.decode('utf-8', errors='replace').splitlines(), 1):
            match = CANONICAL.fullmatch(line)
            if match and line not in old and match.group(1) != '16':
                return verdict('fail', f'canonical memory now states page_size {match.group(1)}',
                               [snapshot_pointer(path, [number, number])])
    return verdict(None, 'memory prose changed; the scorer judges it', pointers)


def judged_only(ev):
    return verdict(None, 'judged by the scorer', [])


CHECKS = {'A.M1': a_m1, 'A.M2': judged_only, 'D.M1': judged_only, 'D.M2': d_m2, 'E.M1': judged_only,
          'G.M1': g_m1, 'G.M2': g_m2, 'E-neg.M1': e_neg_m1, 'E-neg.M2': e_neg_m2, 'E-neg.M3': m3_prerequisite,
          'G-neg.M1': g_neg_m1, 'G-neg.M2': g_neg_m2, 'G-neg.M3': m3_prerequisite}


def check(trial, directory):
    ev = Evidence(directory)
    musts = {}
    for must in RUBRIC['musts']:
        if must['trial'] == trial:
            musts[must['id']] = {'class': must['class'], **CHECKS[must['id']](ev)}
    if not musts:
        raise ValueError(f'unknown trial {trial}')
    return {'checkerVersion': CHECKER_VERSION, 'trial': trial, 'musts': musts}


def main():
    if len(sys.argv) != 3:
        print('Usage: must-check.py <trial> <attempt-dir>', file=sys.stderr)
        raise SystemExit(2)
    try:
        report = check(sys.argv[1], sys.argv[2])
    except EvidenceError as error:
        print(f'corrupted required evidence: {error}', file=sys.stderr)
        raise SystemExit(3)
    except ValueError as error:
        print(error, file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
