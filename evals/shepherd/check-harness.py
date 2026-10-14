#!/usr/bin/env python3
"""Local harness checks. Fake launches only; never starts Claude or Codex.

Usage: check-harness.py [--config <run-config.json>] [unittest arguments].
Without a configuration only the handmade-data checks run. With the
configuration `bun run evals:shepherd --check` writes, the fixture checks
also run, using that configuration's scratch-compiled subject binary.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


h = load('harness')
t = load('transcript')

CONFIG = None
if '--config' in sys.argv:
    at = sys.argv.index('--config')
    CONFIG = h.load_config(sys.argv[at + 1])
    del sys.argv[at:at + 2]
SCRATCH = str(CONFIG.scratch_parent) if CONFIG else str(Path(tempfile.gettempdir()).resolve())
# Distinct synthetic paths: provenance checks never alias one binary to the other.
SUBJECT = Path('/synthetic/run/bin/shepherd')
COMPARISON = Path('/synthetic/comparison/bin/shepherd')
POLICY = json.loads((HERE / 'policy.json').read_text())
needs_subject = unittest.skipUnless(CONFIG, 'needs --config with a scratch-compiled subject')


def synthetic_config(root, **changes):
    """A configuration naming synthetic paths under `root`; nothing is built."""
    values = dict(subject=SUBJECT, scratch_parent=root, artifact_root=root / 'artifacts',
                  policy=dict(POLICY), comparison=None, path=None)
    values.update(changes)
    return h.Config(**values)


class HarnessChecks(unittest.TestCase):
    def test_output_caps_and_full_inputs(self):
        full = '\n'.join(f'line {n}' for n in range(180))
        events = [
            {'type': 'session_meta', 'timestamp': '2026-10-09T01:00:00Z', 'payload': {'id': 'test-id', 'cwd': '/tmp/test'}},
            {'type': 'turn_context', 'payload': {'model': 'test-model'}},
            {'type': 'response_item', 'timestamp': '2026-10-09T01:00:01Z', 'payload': {'type': 'custom_tool_call', 'name': 'exec', 'call_id': 'call', 'input': full}},
            {'type': 'response_item', 'timestamp': '2026-10-09T01:00:02Z', 'payload': {'type': 'custom_tool_call_output', 'call_id': 'call', 'output': full}},
        ]
        meta, steps = t.decode(events, 'codex')
        result = t.render(meta, steps, 'codex')
        self.assertEqual(steps[0][-1], full)
        self.assertEqual(result.count('line 179'), 1)
        self.assertIn('output cut: 30 further lines omitted', result)
        self.assertIn('test-model', result)
        self.assertEqual(t.fence('```\ninside'), '````\n```\ninside\n````')
        claude = [{'type': 'assistant', 'timestamp': '2026-10-09T01:00:01Z', 'sessionId': 'c-id', 'cwd': '/tmp/c',
                   'message': {'role': 'assistant', 'model': 'opus', 'content': [{'type': 'text', 'text': 'Ready'},
                     {'type': 'tool_use', 'id': 'c-call', 'name': 'Bash', 'input': {'command': full}}]}},
                  {'type': 'user', 'timestamp': '2026-10-09T01:00:02Z', 'message': {'role': 'user',
                   'content': [{'type': 'tool_result', 'tool_use_id': 'c-call', 'content': full}]}}]
        meta, steps = t.decode(claude, 'claude')
        self.assertEqual([s[1] for s in steps], ['assistant', 'tool call', 'tool output'])
        self.assertEqual(json.loads(steps[1][-1])['command'], full)
        self.assertIn('output cut: 30', t.render(meta, steps, 'claude'))

    def test_provenance_uses_tool_outputs_only(self):
        expected = SUBJECT
        header = f'binary: {expected}\n'
        call = ('ts', 'tool call', 'Bash', 'a', 'shepherd tool start')
        result = ('ts', 'tool output', '', 'a', header)
        self.assertEqual(h.binary_evidence([call, result], expected), ['a'])
        self.assertEqual(h.binary_evidence([('ts', 'assistant', '', '', header)], expected), [])
        self.assertEqual(h.binary_evidence([result], expected), ['a'])
        self.assertEqual(h.binary_evidence([call], expected), [])
        self.assertEqual(h.binary_evidence([('ts', 'tool call', 'Bash', 'a', header)], expected), [])
        wrong = ('ts', 'tool output', '', 'a', f'binary: {expected}-wrong\n')
        self.assertEqual(h.binary_evidence([call, wrong], expected), [])
        wrapped = ('ts', 'tool output', '', 'a', json.dumps({'content': [{'text': json.dumps({'output': header})}]}))
        self.assertEqual(h.binary_evidence([call, wrapped], expected), ['a'])
        quoted = ('ts', 'tool call', 'Bash', 'a', f'"{expected}" tool start --json')
        self.assertEqual(h.binary_evidence([quoted, wrapped], expected), ['a'])

    def native_provenance_steps(self, backend, records):
        events = []
        for number, (command, output) in enumerate(records):
            call_id = f'call-{number}'
            if backend == 'claude':
                events.extend([
                    {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                        {'type': 'tool_use', 'id': call_id, 'name': 'Bash', 'input': {'command': command}}]}},
                    {'type': 'user', 'message': {'role': 'user', 'content': [
                        {'type': 'tool_result', 'tool_use_id': call_id, 'content': output}]}},
                ])
            else:
                events.extend([
                    {'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command',
                        'call_id': call_id, 'arguments': json.dumps({'cmd': command})}},
                    {'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': call_id,
                        'output': json.dumps({'content': [{'text': json.dumps({'output': output})}]})}},
                ])
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-log-', dir=SCRATCH) as temp:
            log = Path(temp) / 'serialized.jsonl'
            log.write_text(''.join(json.dumps(event) + '\n' for event in events))
            return t.decode(t.read_log(log), backend)[1]

    def test_serialized_quoted_paths_for_each_backend(self):
        for backend in ('claude', 'codex'):
            for quote in ('"', "'"):
                with self.subTest(backend=backend, quote=quote):
                    command = f'{quote}{SUBJECT}{quote} tool start --json'
                    output = json.dumps({'command': 'start', 'binary': str(SUBJECT)})
                    steps = self.native_provenance_steps(backend, [(command, output)])
                    self.assertEqual(h.binary_evidence(steps, SUBJECT), ['call-0'])
                    # Human headers may quote the returned path as well.
                    steps = self.native_provenance_steps(backend, [(command, f'binary: {quote}{SUBJECT}{quote}\n')])
                    self.assertEqual(h.binary_evidence(steps, SUBJECT), ['call-0'])
        # The Codex custom orchestration input carries an escaped command
        # literal inside JavaScript, rather than a JSON argument object.
        command = f'"{SUBJECT}" tool start --json'
        events = [{'type': 'response_item', 'payload': {'type': 'custom_tool_call', 'name': 'exec', 'call_id': 'a',
                   'input': 'await tools.exec_command({cmd: ' + json.dumps(command) + '});'}},
                  {'type': 'response_item', 'payload': {'type': 'custom_tool_call_output', 'call_id': 'a',
                   'output': json.dumps({'output': json.dumps({'binary': str(SUBJECT)})})}}]
        steps = t.decode([json.loads(json.dumps(event)) for event in events], 'codex')[1]
        self.assertEqual(h.binary_evidence(steps, SUBJECT), ['a'])

    def test_mixed_provenance_markers(self):
        for backend in ('claude', 'codex'):
            for wrong_command in ('start', 'check'):
                with self.subTest(backend=backend, wrong_command=wrong_command):
                    records = [
                        (f'"{SUBJECT}" tool start --json', json.dumps({'binary': str(SUBJECT)})),
                        (f'"{COMPARISON}" tool {wrong_command} --json', json.dumps({'binary': str(COMPARISON)})),
                    ]
                    for ordered in (records, records[::-1]):
                        steps = self.native_provenance_steps(backend, ordered)
                        self.assertEqual(h.binary_evidence(steps, SUBJECT), [])
                        audit = h.provenance(steps, SUBJECT)
                        self.assertFalse(audit['valid'])
                        self.assertEqual(audit['unexpected_binaries'][0]['binary'], str(COMPARISON))
            # Every marker counts, including one in decoded nested text.
            output = json.dumps({'binary': str(SUBJECT), 'current': f'binary: "{COMPARISON}"\n'})
            steps = self.native_provenance_steps(backend, [('shepherd tool start --json', output)])
            self.assertEqual(h.binary_evidence(steps, SUBJECT), [])
            self.assertEqual(h.binary_values(steps[-1][-1]), [str(SUBJECT), str(COMPARISON)])
            # Both genuine header responses in one result remain mixed.
            steps = self.native_provenance_steps(backend, [('shepherd tool start', f'binary: "{SUBJECT}"\nbinary: "{COMPARISON}"\n')])
            self.assertEqual(h.binary_evidence(steps, SUBJECT), [])

    def test_newline_commands_and_plain_path_mentions(self):
        for backend in ('claude', 'codex'):
            command = 'shepherd tool start\nls -la .shepherd'
            output = f'# Shepherd start\nbinary: {SUBJECT}\nCLEAN\nCURRENT.md\njournal.md\n'
            steps = self.native_provenance_steps(backend, [(command, output)])
            self.assertEqual(h.binary_evidence(steps, SUBJECT), ['call-0'])
            # No command parsing, even when input is not valid shell syntax.
            steps = self.native_provenance_steps(backend, [('unclosed "', output)])
            self.assertEqual(h.binary_evidence(steps, SUBJECT), ['call-0'])
            for output in (f'Executable path: {SUBJECT}',
                           f'The binary: {SUBJECT} is available.',
                           json.dumps({'message': str(SUBJECT)})):
                with self.subTest(backend=backend, mention=output):
                    steps = self.native_provenance_steps(backend, [('printf path', output)])
                    self.assertEqual(h.binary_evidence(steps, SUBJECT), [])
                    self.assertEqual(h.provenance(steps, SUBJECT)['evidence'], [])
            # JSON binary fields count even following prose or nested inside
            # another object, irrespective of the tool's command input.
            output = 'Local result: ' + json.dumps({'nested': {'binary': str(SUBJECT)}})
            steps = self.native_provenance_steps(backend, [('unknown tool input', output)])
            self.assertEqual(h.binary_evidence(steps, SUBJECT), ['call-0'])

    def test_every_wrapped_response_contributes_evidence(self):
        structured = {'binary': str(SUBJECT), 'current': f'Previously used {COMPARISON}.'}
        human = {'output': f'binary: "{COMPARISON}"\n'}
        for backend in ('claude', 'codex'):
            for responses in ([structured, human], [human, structured]):
                envelopes = [
                    json.dumps(responses),
                    json.dumps({'responses': [json.dumps(response) for response in responses]}),
                    json.dumps({'content': [{'text': json.dumps(response)} for response in responses]}),
                ]
                # Also cover separate responses in one concatenated output.
                bodies = [json.dumps(structured), human['output']]
                if responses[0] is human:
                    bodies.reverse()
                envelopes.append('\n'.join(bodies))
                for envelope in envelopes:
                    with self.subTest(backend=backend, envelope=envelope):
                        steps = self.native_provenance_steps(backend, [('shepherd --cwd . tool start --json', envelope)])
                        self.assertEqual(h.binary_values(steps[-1][-1]), [response.get('binary', str(COMPARISON)) for response in responses])
                        self.assertEqual(h.binary_evidence(steps, SUBJECT), [])
                        audit = h.provenance(steps, SUBJECT)
                        self.assertEqual(audit['evidence_call_ids'], ['call-0'])
                        self.assertEqual(audit['unexpected_binaries'], [{'call_id': 'call-0', 'binary': str(COMPARISON)}])
            # Correct sibling replies remain valid; plain path mentions
            # contribute no evidence. Repeated markers are distinct pieces.
            output = json.dumps([structured, {'output': f'binary: "{SUBJECT}"\n'}])
            steps = self.native_provenance_steps(backend, [('shepherd --cwd . tool start', output)])
            self.assertEqual(h.binary_values(steps[-1][-1]), [str(SUBJECT), str(SUBJECT)])
            self.assertEqual(h.binary_evidence(steps, SUBJECT), ['call-0'])
            self.assertEqual(h.provenance(steps, SUBJECT)['evidence'], [
                {'call_id': 'call-0', 'binary': str(SUBJECT)},
                {'call_id': 'call-0', 'binary': str(SUBJECT)}])

    def test_isolation_and_env(self):
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-unit-', dir=SCRATCH) as temp:
            root = Path(temp).resolve()
            self.assertEqual(h.isolated(root), root)
            (root / '.shepherd').mkdir()
            child = root / 'child'; child.mkdir()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                h.isolated(child)
            self.assertEqual(caught.exception.code, 2)
            (root / '.shepherd').rmdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                h.isolated(child)
            self.assertEqual(caught.exception.code, 2)
        markers = {'HERDR_ENV': '1', 'HERDR_PANE': 'real', 'TMUX': 'real', 'TMUX_PANE': 'real', 'GIT_DIR': 'real',
                   'CLAUDECODE': '1', 'CLAUDE_PID': '1', 'CLAUDE_EFFORT': 'low', 'CLAUDE_PROJECT_DIR': '/real',
                   'CLAUDE_CONFIG_DIR': '/real', 'CLAUDE_CODE_ENTRYPOINT': 'cli', 'CLAUDE_CODE_SESSION_ID': 'parent',
                   'CLAUDE_CODE_CHILD_SESSION': '1', 'CLAUDE_CODE_MESSAGING_SOCKET': '/real.sock',
                   'CLAUDE_CODE_MESSAGING_TOKEN': 'peer', 'CLAUDE_CODE_SUBAGENT_MODEL': 'other',
                   'CLAUDE_CODE_EXECPATH': '/real', 'MAX_THINKING_TOKENS': '1024', 'ANTHROPIC_MODEL': 'other',
                   'ANTHROPIC_SMALL_FAST_MODEL': 'other', 'ANTHROPIC_DEFAULT_OPUS_MODEL': 'other',
                   'XDG_CONFIG_HOME': '/real/config', 'ZDOTDIR': '/real/zdotdir', 'SHELL': '/real/shell'}
        kept = {'CLAUDE_CODE_OAUTH_TOKEN': 'login', 'ANTHROPIC_API_KEY': 'key', 'HOME': os.environ['HOME'],
                'CLAUDE_CODE_USE_FOUNDRY': '1', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH': '1', 'CLAUDE_CODE_SKIP_VERTEX_AUTH': '1',
                'ANTHROPIC_BASE_URL': 'https://proxy.example.invalid'}
        replaced = ('XDG_CONFIG_HOME', 'ZDOTDIR', 'SHELL')
        with patch.dict(os.environ, {**markers, **kept}):
            env = h.environment(SUBJECT, Path('/scratch/root'))
            self.assertFalse(any(k.startswith(('HERDR_', 'TMUX', 'GIT_')) for k in env))
            for key in markers:
                if key not in replaced:
                    # Never print the environment: it holds credentials.
                    self.assertFalse(key in env, key)
            for key, value in kept.items():
                self.assertTrue(env.get(key) == value, key)
            self.assertEqual(env['XDG_CONFIG_HOME'], '/scratch/root/xdg')
            self.assertEqual(env['ZDOTDIR'], '/scratch/root/zdotdir')
            self.assertEqual(os.path.basename(env['SHELL']), 'zsh')
            self.assertTrue(env['PATH'].startswith(str(SUBJECT.parent) + os.pathsep))

    def test_timeout_kills_the_process_group(self):
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-unit-', dir=SCRATCH) as temp:
            root = Path(temp).resolve()
            workspace = root / 'workspace'; workspace.mkdir()
            process = MagicMock()
            process.pid = 999999
            process.wait.side_effect = [subprocess.TimeoutExpired('fake', 1200), 0]
            with patch.object(h.subprocess, 'Popen', return_value=process) as spawn, \
                 patch.object(h.os, 'killpg') as kill, patch.object(h.time, 'sleep'), patch.object(h, 'isolated', side_effect=lambda path, **kw: path):
                rc = h.launch(['fake-only'], workspace, root, h.environment(SUBJECT, root), root / 'out', root / 'err', 1200)
            self.assertEqual(rc, 124)
            self.assertEqual(process.wait.call_args_list[0].kwargs, {'timeout': 1200})
            self.assertTrue(spawn.call_args.kwargs['start_new_session'])
            self.assertIn((999999, h.signal.SIGTERM), [call.args for call in kill.call_args_list])
            self.assertIn((999999, h.signal.SIGKILL), [call.args for call in kill.call_args_list])
            self.assertIn('timed out', (root / 'err').read_text())

    @needs_subject
    def test_session_shells_resolve_the_scratch_subject(self):
        # Claude Code runs session commands through login shells; with the
        # user's real HOME and system startup files, bare `shepherd` must
        # still be the resolved scratch subject.
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-shell-', dir=SCRATCH) as temp:
            root = h.scratch_home(Path(temp).resolve(), CONFIG.policy['shepherdSettings'])
            env = h.environment(CONFIG.subject, root)
            self.assertEqual(h.session_shepherd(env, 60), [str(CONFIG.subject)] * 2)

    @needs_subject
    def test_all_fixture_shapes(self):
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-fixtures-', dir=SCRATCH) as temp:
            root = Path(temp).resolve()
            for trial in h.TRIALS:
                with self.subTest(trial=trial):
                    workspace = root / trial / 'workspace'
                    workspace.mkdir(parents=True)
                    subprocess.run(['bash', str(HERE / 'fixtures.sh'), str(CONFIG.path), trial, str(workspace)], check=True, stdout=subprocess.DEVNULL)
                    start = h.tool(CONFIG, workspace, 'start')
                    state = workspace / '.shepherd'
                    expected = 'RECONCILE' if trial in ('C', 'D', 'G', 'G-neg') else 'CLEAN'
                    self.assertEqual(start['verdict'], expected)
                    # The resolved scratch binary is the marker sessions must return.
                    self.assertEqual(start['binary'], str(CONFIG.subject))
                    self.assertEqual(os.path.realpath(start['binary']), start['binary'])
                    self.assertTrue((workspace.parent / 'fixture-notes.md').exists())
                    self.assertEqual(json.loads((workspace.parent / 'xdg/shepherd/config.json').read_text()),
                                     CONFIG.policy['shepherdSettings'])
                    self.assertFalse((workspace / 'fixture-notes.md').exists())
                    current = (state / 'CURRENT.md').read_text()
                    if trial == 'B':
                        self.assertIn('No NEXT is set.', current)
                        self.assertEqual(current.count('- **ASK**'), 2)
                        self.assertNotIn('- **NEXT**', current)
                    else:
                        self.assertEqual(current.count('- **NEXT**'), 1)
                    manifest = json.loads((state / 'checkpoint.json').read_text())
                    if trial == 'C':
                        self.assertEqual(manifest['journal']['count'], 40)
                        self.assertEqual(len(start['journal']['entries']), 12)
                        self.assertNotIn('cut', start['journal'])
                        self.assertIn('Begin the brainstorm', current)
                        self.assertNotIn('two decimal', current)
                    elif trial == 'D':
                        self.assertEqual(len(start['journal']['entries']), 2)
                        journal = (state / 'journal.md').read_text()
                        self.assertIn('14:20', journal)
                        self.assertIn('14:05', journal)
                        findings = h.tool(CONFIG, workspace, 'check', '--all')
                        codes = [f['code'] for w in findings['workspaces'] for f in w['findings']]
                        self.assertIn('journal-time-backwards', codes)
                        self.assertIn('journal-heading-order', codes)
                    elif trial == 'E':
                        reports = list(state.rglob('reviewer-report.md'))
                        self.assertEqual(len(reports), 1)
                        self.assertIn('## Discoveries', reports[0].read_text())
                        for path in state.rglob('*.md'):
                            if path != reports[0]:
                                self.assertNotIn('overwrites ledger/unique-notes.txt', path.read_text())
                    elif trial in ('F1', 'F2'):
                        index = (state / 'docs/INDEX.md').read_text()
                        self.assertIn('before editing the local ledger title', index)
                        self.assertEqual('before regenerating the local preview' in index, trial == 'F2')
                        self.assertTrue((workspace / 'ledger/unique-notes.txt').exists())
                    elif trial == 'G':
                        self.assertIn('page_size is 16', (state / 'memories/capacity.md').read_text())
                        self.assertEqual(len(start['journal']['entries']), 2)
                        self.assertIn('page_size=24', start['journal']['entries'][-1]['text'])
                    elif trial == 'E-neg':
                        # Impatient negative control: no record names the trap.
                        report = (state / 'work/in-progress/ledger-review/reviewer-report.md').read_text()
                        self.assertIn('## Discoveries\nnone', report)
                        self.assertIn('## Done when', (state / 'work/in-progress/ledger-review/reviewer-brief.md').read_text())
                        for path in state.rglob('*.md'):
                            self.assertNotIn('unique-notes', path.read_text())
                        self.assertIn('unique-notes.txt', (workspace / 'tools/preview.py').read_text())
                    elif trial == 'G-neg':
                        # Impatient negative control: a lure toward 24, no agreement.
                        self.assertIn('page_size is 16', (state / 'memories/capacity.md').read_text())
                        self.assertEqual((workspace / 'ledger/settings.txt').read_text(), 'page_size=16\n')
                        self.assertEqual(len(start['journal']['entries']), 2)
                        for entry in start['journal']['entries']:
                            self.assertNotRegex(entry['text'], r'(?i)agree|confirm|chang|decid|chose')
                    # NEXT/CURRENT/STATUS must describe the task, not the
                    # read order, helper, stale source, or scoring behavior.
                    instructions = current + '\n'.join(path.read_text() for path in (state / 'work/in-progress').rglob('STATUS.md'))
                    for hint in ('tool start', 'journal helper', 'time slip', 'unreviewed', 'place any', 'Discoveries', 'memories/capacity.md', 'docs/layout-notes.md', 'journal.md', 'edit nothing', 'before accepting'):
                        self.assertNotIn(hint, instructions)
                    charter = (state / 'charter.md').read_text()
                    self.assertNotIn('propose options', charter)
                    self.assertNotIn('wait for the user', charter)
                    if trial == 'C':
                        self.assertNotIn('CURRENT still', (state / 'journal.md').read_text())
                    elif trial == 'G':
                        self.assertNotIn('correct the old', (state / 'journal.md').read_text())

    def write_config(self, root, artifacts, comparison=None):
        """A real configuration file naming the scratch-compiled subject."""
        path = root / ('config-' + artifacts.name + '.json')
        path.write_text(json.dumps({'subject': str(CONFIG.subject), 'comparison': comparison and str(comparison),
                                    'scratchParent': str(root), 'artifactRoot': str(artifacts),
                                    'policy': CONFIG.policy}))
        return h.load_config(path)

    @needs_subject
    def test_fake_codex_log_discovery_and_flags(self):
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-unit-', dir=SCRATCH) as temp:
            root = Path(temp).resolve()
            home = root / 'home'; home.mkdir()
            codex = home / '.codex'; (codex / 'sessions').mkdir(parents=True)
            (home / '.codex-active').write_text(str(codex))
            dest = root / 'trials'
            config = self.write_config(root, dest)
            def fake(argv, workspace, scratch_root, env, stdout, stderr, timeout):
                self.assertEqual(env['CODEX_HOME'], str(codex))
                self.assertEqual(argv[argv.index('--model') + 1], 'gpt-6.1-sol')
                self.assertIn('model_reasoning_effort=high', argv)
                self.assertIn('workspace-write', argv)
                self.assertIn('sandbox_workspace_write.exclude_slash_tmp=true', argv)
                self.assertIn('sandbox_workspace_write.exclude_tmpdir_env_var=true', argv)
                self.assertIn('sandbox_workspace_write.writable_roots=' + json.dumps([str(scratch_root)]), argv)
                stdout.write_text('fake stdout'); stderr.write_text('fake stderr')
                events = [
                    {'type': 'session_meta', 'timestamp': '2026-10-09T01:00:00Z', 'payload': {'id': 'fake-codex', 'cwd': str(workspace)}},
                    {'type': 'turn_context', 'payload': {'model': 'gpt-6.1-sol'}},
                    {'type': 'response_item', 'payload': {'type': 'function_call', 'name': 'exec_command', 'call_id': 'a', 'arguments': json.dumps({'cmd': 'shepherd tool start --json'})}},
                    {'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': 'a', 'output': json.dumps({'binary': str(config.subject)})}},
                ]
                (codex / 'sessions/subagent.jsonl').write_text(json.dumps({'type': 'session_meta', 'payload': {'id': 'child', 'parent_thread_id': 'fake-codex', 'cwd': str(workspace)}}) + '\n')
                (codex / 'sessions/fake.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in events))
                return 0
            with patch.object(h, 'HOME', home), patch.object(h, 'launch', fake):
                self.assertEqual(h.run(config, 'A', 'codex'), 0)
                self.assertTrue((dest / 'A/codex.jsonl').exists())
                self.assertIn('fake-codex', (dest / 'A/codex.md').read_text())

    @needs_subject
    def test_fake_run_artifacts_void_and_resume(self):
        # Only fixture tool invocations use the scratch-compiled subject.
        # Replace the session launch function with native log generation.
        with tempfile.TemporaryDirectory(prefix='shepherd-eval-unit-', dir=SCRATCH) as temp:
            root = Path(temp).resolve()
            home = root / 'home'; home.mkdir()
            dest = root / 'trials'
            # A distinct synthetic comparison binary, never the subject.
            fake_main = root / 'main/bin/shepherd'
            fake_main.parent.mkdir(parents=True)
            fake_main.write_text('#!/bin/sh\nexit 99\n'); fake_main.chmod(0o755)
            config = self.write_config(root, dest, fake_main)
            calls = []
            def fake(argv, workspace, scratch_root, env, stdout, stderr, timeout):
                calls.append(argv)
                self.assertEqual(timeout, config.policy['subjectTimeoutSeconds'])
                stdout.write_text('fake stdout\n'); stderr.write_text('fake stderr\n')
                self.assertEqual(env['PATH'].split(os.pathsep)[0], str(Path(argv[0]).parent))
                if '--resume' in argv:
                    session = argv[argv.index('--resume') + 1]
                else:
                    session = argv[argv.index('--session-id') + 1]
                key = h.re.sub(r'[^A-Za-z0-9]', '-', str(workspace))
                log = home / '.claude/projects' / key / (session + '.jsonl')
                log.parent.mkdir(parents=True, exist_ok=True)
                # Make B VOID: assistant prose alone must not count.
                events = [{'type': 'user', 'timestamp': '2026-10-09T01:00:00Z', 'cwd': str(workspace), 'sessionId': session,
                           'message': {'role': 'user', 'content': 'carry on' if '--resume' in argv else h.OPENING}}]
                is_void = workspace.parent == void_root[0] if void_root else False
                if not is_void:
                    events += [{'type': 'assistant', 'timestamp': '2026-10-09T01:00:01Z', 'message': {'role': 'assistant', 'model': config.policy['model'],
                                'content': [{'type': 'tool_use', 'id': 'start', 'name': 'Bash', 'input': {'command': 'shepherd tool start'}}]}},
                               {'type': 'user', 'timestamp': '2026-10-09T01:00:02Z', 'message': {'role': 'user', 'content': [
                                 {'type': 'tool_result', 'tool_use_id': 'start', 'content': f'binary: {argv[0]}\n'}]}}]
                leg = 'resume' if '--resume' in argv else 'initial'
                if contaminated_leg and contaminated_leg[0] == leg:
                    wrong = fake_main if leg == 'resume' else config.subject
                    events.extend([
                        {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
                            {'type': 'tool_use', 'id': 'wrong', 'name': 'Bash', 'input': {'command': f'"{wrong}" tool check --json'}}]}},
                        {'type': 'user', 'message': {'role': 'user', 'content': [
                            {'type': 'tool_result', 'tool_use_id': 'wrong', 'content': json.dumps({'binary': str(wrong)})}]}},
                    ])
                with log.open('a') as stream:
                    for event in events:stream.write(json.dumps(event) + '\n')
                (workspace / 'ledger/settings.txt').write_text('page_size=24\n')
                return 0
            void_root = []
            contaminated_leg = []
            with patch.object(h, 'HOME', home), patch.object(h, 'launch', fake), \
                 patch.object(h, 'cli_version', return_value='fake 0.0.0'):
                self.assertEqual(h.run(config, 'A', 'claude'), 0)
                self.assertIn('page_size=24', (dest / 'A/claude-diff.patch').read_text())
                self.assertTrue((dest / 'A/claude-start.json').exists())
                self.assertEqual(calls[-1][0], str(config.subject))
                self.assertEqual(h.run(config, 'A', 'claude', rerun=True), 0)
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                    h.run(config, 'A', 'claude')
                self.assertEqual(caught.exception.code, 2)
                # Identify the B root as soon as fixture creation occurs.
                def void_launch(*args):
                    void_root[:] = [args[2]]
                    return fake(*args)
                with patch.object(h, 'launch', void_launch):
                    self.assertEqual(h.run(config, 'B', 'claude'), 3)
                self.assertTrue((dest / 'B/claude.md').read_text().startswith('# VOID'))
                void_root.clear()
                self.assertEqual(h.run(config, 'C', 'claude', before=True), 0)
                self.assertTrue((dest / 'C/claude-before-start.json').exists())
                self.assertEqual(calls[-1][0], str(fake_main))
                self.assertEqual(h.run(config, 'I', 'claude'), 0)
                text = (dest / 'I/claude.md').read_text()
                self.assertIn('Resume starts here', text)
                self.assertEqual(text.count('session transcript'), 2)
                self.assertEqual(calls[-2][0], str(fake_main))
                self.assertEqual(calls[-1][0], str(config.subject))
                self.assertIn('--resume', calls[-1])
                # Each I leg is checked independently, including when it
                # also contains a correct startup proof.
                for bad_leg in ('initial', 'resume'):
                    case = self.write_config(root, root / ('mixed-' + bad_leg), fake_main)
                    contaminated_leg[:] = [bad_leg]
                    self.assertEqual(h.run(case, 'I', 'claude'), 3)
                    self.assertTrue((case.artifact_root / 'I/claude.md').read_text().startswith('# VOID'))
                    audit = json.loads((case.artifact_root / 'I/claude-run.json').read_text())['provenance']
                    invalid = [leg['leg'] for leg in audit if not leg['valid']]
                    self.assertEqual(invalid, [bad_leg])
                contaminated_leg.clear()

                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    h.run(config, 'C', 'codex', before=True)



class PortableChecks(unittest.TestCase):
    """Configuration, environment, bounds and validity on handmade data."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='shepherd-eval-unit-', dir=SCRATCH)
        self.root = Path(self.temp.name).resolve()
        self.subject = self.root / 'run/bin/shepherd'
        self.subject.parent.mkdir(parents=True)
        self.subject.write_text('#!/bin/sh\nexit 99\n'); self.subject.chmod(0o755)
        self.home = self.root / 'home'; self.home.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def refused(self, call, *args, **kwargs):
        with contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit) as caught:
            call(*args, **kwargs)
        self.assertEqual(caught.exception.code, 2)
        return err.getvalue()

    def config_file(self, **changes):
        values = {'subject': str(self.subject), 'comparison': None, 'scratchParent': str(self.root),
                  'artifactRoot': str(self.root / 'artifacts'), 'policy': POLICY}
        values.update(changes)
        path = self.root / 'config.json'
        path.write_text(json.dumps(values))
        return path

    def test_config_resolves_the_subject_and_refuses_bad_paths(self):
        (self.root / 'alias').symlink_to(self.root / 'run')
        config = h.load_config(self.config_file(subject=str(self.root / 'alias/bin/shepherd')))
        self.assertEqual(config.subject, self.subject)
        self.assertEqual(config.path, self.root / 'config.json')
        self.assertIsNone(config.comparison)
        self.assertEqual(config.policy['model'], 'claude-opus-5-5')
        # The comparison binary must be a distinct file, even through a symlink.
        self.assertIn('distinct', self.refused(h.load_config, self.config_file(comparison=str(self.root / 'alias/bin/shepherd'))))
        self.subject.chmod(0o644)
        self.assertIn('not executable', self.refused(h.load_config, self.config_file()))
        self.subject.chmod(0o755)
        self.assertIn('absolute', self.refused(h.load_config, self.config_file(artifactRoot='artifacts')))
        repo = self.root / 'repo'; repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        self.assertIn('git repository', self.refused(h.load_config, self.config_file(scratchParent=str(repo))))
        self.assertIn('policy', self.refused(h.load_config, self.config_file(policy={'model': 'x'})))

    def test_scratch_command_checks_isolation(self):
        def scratch(path):
            return subprocess.run(['python3', '-I', str(HERE / 'harness.py'), 'scratch', str(path)],
                                  capture_output=True, text=True, timeout=60)
        self.assertEqual(scratch(self.root).returncode, 0)
        repo = self.root / 'repo'; repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        result = scratch(repo)
        self.assertEqual(result.returncode, 2)
        self.assertIn('git repository', result.stderr)

    def test_comparison_modes_refuse_without_a_distinct_binary(self):
        config = synthetic_config(self.root, subject=self.subject)
        self.assertIn('comparison', self.refused(h.run, config, 'C', 'claude', before=True))
        self.assertIn('comparison', self.refused(h.run, config, 'I', 'claude'))
        self.assertFalse(config.artifact_root.exists())

    def test_legacy_argument_refusals(self):
        config = synthetic_config(self.root, subject=self.subject, comparison=COMPARISON)
        self.refused(h.run, config, 'C', 'codex', before=True)
        self.refused(h.run, config, 'I', 'codex')
        self.refused(h.run, config, 'A', 'claude', before=True)
        self.refused(h.run, config, 'C', 'claude', rerun=True, before=True)
        usage = subprocess.run(['bash', str(HERE / 'fixtures.sh'), 'A'], capture_output=True, text=True, timeout=60)
        self.assertEqual(usage.returncode, 2)
        unknown = subprocess.run(['bash', str(HERE / 'fixtures.sh'), str(self.root / 'config.json'), 'Z', str(self.root)],
                                 capture_output=True, text=True, timeout=60)
        self.assertEqual(unknown.returncode, 2)

    def test_fixture_refuses_builds_after_23_40(self):
        config = synthetic_config(self.root, subject=self.subject)
        workspace = self.root / 'late' / 'workspace'; workspace.mkdir(parents=True)
        late = h.dt.datetime(2026, 10, 13, 23, 41)
        clock = MagicMock(wraps=h.dt)
        clock.datetime.now.return_value = late
        with patch.object(h, 'dt', clock), patch.object(h, 'tool') as tool:
            self.assertIn('23:40', self.refused(h.fixture, config, 'A', workspace))
        tool.assert_not_called()

    def test_tool_and_fixture_subprocesses_are_bounded(self):
        config = synthetic_config(self.root, subject=self.subject, path=self.root / 'config.json')
        workspace = self.root / 'trial' / 'workspace'; workspace.mkdir(parents=True)
        done = subprocess.CompletedProcess([], 0, stdout='{"verdict": "CLEAN"}', stderr='')
        with patch.object(h.subprocess, 'run', return_value=done) as run:
            self.assertEqual(h.tool(config, workspace, 'start'), {'verdict': 'CLEAN'})
            self.assertEqual(run.call_args.kwargs['timeout'], 60)
            self.assertEqual(run.call_args.args[0][0], str(self.subject))
            self.assertEqual(run.call_args.kwargs['env']['XDG_CONFIG_HOME'], str(workspace.parent / 'xdg'))
        args = self.root / 'fixture-args'
        with patch.object(h, 'HERE', self.fixtures_script(f'echo "$@" > {args}')):
            h.prepare(config, 'A', workspace)
        self.assertEqual(args.read_text().split(), [str(config.path), 'A', str(workspace)])
        with patch.object(h.subprocess, 'run', side_effect=subprocess.TimeoutExpired('shepherd', 60)):
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                h.tool(config, workspace, 'start')

    def test_fixed_scratch_shepherd_settings(self):
        xdg = h.xdg_home(self.root, {'start': {'journalWords': 9}})
        self.assertEqual(xdg, self.root / 'xdg')
        self.assertEqual(json.loads((xdg / 'shepherd/config.json').read_text()), {'start': {'journalWords': 9}})
        self.assertEqual(h.xdg_home(self.root, {}), xdg)
        self.assertEqual(json.loads((xdg / 'shepherd/config.json').read_text()), {})

    def test_backend_settings_without_credentials(self):
        managed = self.root / 'managed-settings.json'
        captured = h.backend_settings(self.home, managed)
        self.assertEqual({name: entry['present'] for name, entry in captured.items()},
                         {'user': False, 'userLocal': False, 'managed': False})
        settings = self.home / '.claude/settings.json'
        settings.parent.mkdir()
        secrets = ('sk-secret-value', '/bin/secret-helper', 'tok-secret', 'hooks.slack.example/T000/B000/XXXX',
                   'sk-ant-inline-value', 'Bearer abc123-permission')
        settings.write_text(json.dumps({
            'model': 'opus', 'effortLevel': 'high', 'alwaysThinkingEnabled': True, 'cleanupPeriodDays': 30,
            'env': {'ANTHROPIC_API_KEY': 'sk-secret-value', 'DEBUG': '1'}, 'apiKeyHelper': '/bin/secret-helper',
            'permissions': {'allow': ['Bash(curl -H "Authorization: Bearer abc123-permission")'], 'defaultMode': 'default'},
            'statusLine': {'type': 'command', 'command': 'ANTHROPIC_API_KEY=sk-ant-inline-value status'},
            'hooks': {'Stop': [{'command': 'curl https://hooks.slack.example/T000/B000/XXXX', 'authToken': 'tok-secret'}]}}))
        (self.home / '.claude/settings.local.json').write_text(json.dumps({'model': 'sonnet'}))
        managed.write_text(json.dumps({'forceLoginMethod': 'claudeai', 'apiKeyHelper': '/bin/secret-helper'}))
        captured = h.backend_settings(self.home, managed)
        text = json.dumps(captured)
        for secret in secrets:
            self.assertNotIn(secret, text)
        user = captured['user']['settings']
        self.assertEqual((user['model'], user['effortLevel'], user['alwaysThinkingEnabled'], user['cleanupPeriodDays']),
                         ('opus', 'high', True, 30))
        self.assertEqual(user['permissions']['defaultMode'], 'default')
        self.assertEqual(user['permissions']['allow'], ['[redacted]'])
        self.assertEqual(user['statusLine'], {'type': '[redacted]', 'command': '[redacted]'})
        self.assertEqual(sorted(user['env']), ['ANTHROPIC_API_KEY', 'DEBUG'])
        self.assertEqual(captured['userLocal']['settings'], {'model': 'sonnet'})
        self.assertEqual(captured['managed']['settings']['forceLoginMethod'], 'claudeai')
        for entry in captured.values():
            self.assertRegex(entry['sha256'], r'^[0-9a-f]{64}$')

    def fake_run(self, config, trial='A', model=None, marker=None, write_log=True, rc=0, attempt=None, **patches):
        """Run one trial with fake fixture tools and a fake session."""
        launched = []
        def prepare(config, trial, workspace):
            (workspace / '.shepherd').mkdir()
            (workspace / 'ledger').mkdir()
            (workspace / 'ledger/settings.txt').write_text('page_size=16\n')
            (workspace.parent / 'fixture-notes.md').write_text(f'# Trial {trial} fixture facts\n')
        def tool(config, workspace, *args):
            return {'verdict': 'CLEAN', 'binary': str(config.subject)}
        def launch(argv, workspace, root, env, stdout, stderr, timeout):
            launched.append({'argv': argv, 'env': env, 'root': root, 'timeout': timeout})
            stdout.write_text('fake stdout\n'); stderr.write_text('fake stderr\n')
            if write_log:
                session = argv[argv.index('--session-id') + 1]
                log = self.home / '.claude/projects' / h.re.sub(r'[^A-Za-z0-9]', '-', str(workspace)) / (session + '.jsonl')
                log.parent.mkdir(parents=True, exist_ok=True)
                events = [{'type': 'assistant', 'timestamp': '2026-10-13T15:00:01Z', 'message': {'role': 'assistant', 'model': model or config.policy['model'],
                           'content': [{'type': 'tool_use', 'id': 'start', 'name': 'Bash', 'input': {'command': 'shepherd tool start'}}]}},
                          {'type': 'user', 'timestamp': '2026-10-13T15:00:02Z', 'message': {'role': 'user', 'content': [
                           {'type': 'tool_result', 'tool_use_id': 'start', 'content': f'binary: {marker or argv[0]}\n'}]}}]
                log.write_text(''.join(json.dumps(event) + '\n' for event in events))
            (workspace / 'ledger/settings.txt').write_text('page_size=24\n')
            return rc
        values = {'prepare': prepare, 'tool': tool, 'launch': launch, 'cli_version': lambda env, timeout: 'fake 2.0.0',
                  'session_shepherd': lambda env, timeout: [str(config.subject)] * 2}
        values.update(patches)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(h, 'HOME', self.home))
            for name, value in values.items():
                stack.enter_context(patch.object(h, name, value))
            rc = h.run(config, trial, 'claude', attempt=attempt)
        dest = config.artifact_root / trial / (f'attempt-{attempt}' if attempt else '')
        record = json.loads((dest / 'claude-run.json').read_text())
        return rc, record, (dest / 'claude.md').read_text(), launched

    def case(self, name):
        return synthetic_config(self.root, subject=self.subject, artifact_root=self.root / name)

    def test_fake_run_applies_the_subject_policy(self):
        config = self.case('valid')
        with patch.dict(os.environ, {'CLAUDE_EFFORT': 'low', 'CLAUDE_CODE_MESSAGING_SOCKET': '/real.sock'}):
            rc, record, text, launched = self.fake_run(config)
        self.assertEqual(rc, 0)
        argv = launched[0]['argv']
        self.assertEqual(argv[0], str(self.subject))
        self.assertEqual(argv[argv.index('--model') + 1], 'claude-opus-5-5')
        self.assertEqual(argv[argv.index('--print') + 1], h.OPENING)
        self.assertEqual(argv[argv.index('--effort') + 1], 'high')
        self.assertEqual(argv[argv.index('--permission-mode') + 1], 'bypassPermissions')
        self.assertEqual(argv[argv.index('--disallowedTools') + 1:], ['SendMessage', 'ListAgents'])
        self.assertEqual(argv.count('--print'), 1)
        self.assertEqual(launched[0]['timeout'], 1200)
        env = launched[0]['env']
        self.assertFalse('CLAUDE_EFFORT' in env)
        self.assertFalse('CLAUDE_CODE_MESSAGING_SOCKET' in env)
        self.assertEqual(env['XDG_CONFIG_HOME'], str(launched[0]['root'] / 'xdg'))
        self.assertEqual(launched[0]['root'].parent, self.root)
        self.assertEqual(record['validity'], {'valid': True, 'void_reasons': []})
        self.assertEqual(record['cli_version'], 'fake 2.0.0')
        self.assertRegex(record['started_at'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
        self.assertLessEqual(record['started_at'], record['ended_at'])
        self.assertEqual(set(record['backend_settings']), {'user', 'userLocal', 'managed'})
        self.assertEqual(env['ZDOTDIR'], str(launched[0]['root'] / 'zdotdir'))
        self.assertEqual(record['session_shepherd'], [str(self.subject)] * 2)
        self.assertIsNone(record['interrupted'])
        self.assertEqual(record['policy'], config.policy)
        self.assertEqual(record['observed_models'], ['claude-opus-5-5'])
        self.assertFalse(record['timed_out'])
        self.assertEqual(record['provenance'][0]['expected_binary'], str(self.subject))
        self.assertFalse(text.startswith('# VOID'))
        for name in ('claude-fixture-notes.md', 'claude-start.json', 'claude.jsonl', 'claude-diff.patch',
                     'claude-stdout.txt', 'claude-stderr.txt'):
            self.assertTrue((config.artifact_root / 'A' / name).exists(), name)
        # Fresh workspace and session for every trial.
        rc, again, _, second = self.fake_run(self.case('second'))
        self.assertNotEqual(second[0]['root'], launched[0]['root'])
        self.assertNotEqual(again['argv'][again['argv'].index('--session-id') + 1],
                            record['argv'][record['argv'].index('--session-id') + 1])

    def test_snapshots_are_path_to_content_records(self):
        root = self.root / 'snap'
        (root / '.shepherd/work').mkdir(parents=True)
        (root / '.shepherd/work/STATUS.md').write_text('# s\n')
        (root / 'blob.bin').write_bytes(b'\xff\x00raw')
        (root / 'link.txt').symlink_to('blob.bin')
        (root / 'linked-dir').symlink_to('.shepherd')
        (root / 'empty').mkdir()
        snap = h.snapshot(root)
        self.assertEqual(snap['snapshotVersion'], 1)
        self.assertEqual(snap['files'], {
            '.shepherd/work/STATUS.md': {'type': 'file', 'encoding': 'utf-8', 'content': '# s\n'},
            'blob.bin': {'type': 'file', 'encoding': 'base64', 'content': '/wByYXc='},
            'link.txt': {'type': 'symlink', 'target': 'blob.bin'},
            'linked-dir': {'type': 'symlink', 'target': '.shepherd'}})

    def test_runs_record_baseline_and_final_snapshots(self):
        config = self.case('snapshots')
        self.fake_run(config)
        dest = config.artifact_root / 'A'
        baseline = json.loads((dest / 'claude-baseline.json').read_text())
        final = json.loads((dest / 'claude-final.json').read_text())
        self.assertEqual(baseline['files']['ledger/settings.txt']['content'], 'page_size=16\n')
        self.assertEqual(final['files']['ledger/settings.txt']['content'], 'page_size=24\n')

    def test_attempts_get_their_own_artifact_directories(self):
        config = self.case('attempts')
        rc, record, _, _ = self.fake_run(config, attempt=1)
        self.assertEqual(rc, 0)
        self.assertTrue((config.artifact_root / 'A/attempt-1/claude-run.json').exists())
        self.fake_run(config, attempt=2)
        self.assertTrue((config.artifact_root / 'A/attempt-2/claude.jsonl').exists())
        with patch.object(h, 'HOME', self.home):
            self.assertIn('already exist', self.refused(h.run, config, 'A', 'claude', attempt=2))

    def test_artifact_overwrite_is_refused(self):
        config = self.case('overwrite')
        self.fake_run(config)
        before = {path: path.read_bytes() for path in (config.artifact_root / 'A').iterdir()}
        with patch.object(h, 'HOME', self.home):
            self.assertIn('already exist', self.refused(h.run, config, 'A', 'claude'))
        self.assertEqual({path: path.read_bytes() for path in (config.artifact_root / 'A').iterdir()}, before)

    def test_model_mismatch_is_void(self):
        rc, record, text, _ = self.fake_run(self.case('model'), model='claude-other-1')
        self.assertEqual(rc, 3)
        self.assertFalse(record['validity']['valid'])
        self.assertTrue(text.startswith('# VOID'))
        self.assertIn('model', '\n'.join(record['validity']['void_reasons']))
        # Claude's own synthetic error records are not a model.
        rc, record, _, _ = self.fake_run(self.case('synthetic'), model='<synthetic>')
        self.assertEqual(rc, 3)
        self.assertIn('no observed model', '\n'.join(record['validity']['void_reasons']))

    def test_unresolved_or_foreign_markers_are_void(self):
        (self.root / 'alias').symlink_to(self.root / 'run')
        for name, marker in (('alias', self.root / 'alias/bin/shepherd'), ('foreign', COMPARISON)):
            with self.subTest(marker=name):
                rc, record, text, _ = self.fake_run(self.case(name), marker=marker)
                self.assertEqual(rc, 3)
                self.assertTrue(text.startswith('# VOID'))
                self.assertIn('unexpected binary', '\n'.join(record['validity']['void_reasons']))
                self.assertEqual(record['provenance'][0]['unexpected_binaries'][0]['binary'], str(marker))

    def test_missing_provenance_is_void_whatever_the_argv(self):
        rc, record, text, launched = self.fake_run(self.case('missing'), marker='unrelated')
        self.assertEqual(rc, 3)
        self.assertIn(str(self.subject), launched[0]['argv'])
        self.assertIn('no tool-result binary evidence', '\n'.join(record['validity']['void_reasons']))

    def test_failed_preparation_launch_or_log_is_void(self):
        def broken_prepare(config, trial, workspace):
            raise subprocess.CalledProcessError(1, ['fixtures.sh'])
        def broken_launch(*args):
            raise h.LaunchFailed('cannot execute')
        for name, kwargs, reason in (('prepare', {'prepare': broken_prepare}, 'fixture preparation failed'),
                                     ('launch', {'launch': broken_launch}, 'launch failed'),
                                     ('nolog', {'write_log': False}, 'session log')):
            with self.subTest(case=name):
                rc, record, text, launched = self.fake_run(self.case(name), **kwargs)
                self.assertEqual(rc, 3)
                self.assertTrue(text.startswith('# VOID'))
                self.assertIn(reason, '\n'.join(record['validity']['void_reasons']))
                if name == 'prepare':
                    self.assertEqual(len(launched), 0)

    def test_timeout_of_a_valid_session_is_not_void(self):
        rc, record, text, _ = self.fake_run(self.case('timeout'), rc=124)
        self.assertEqual(rc, 124)
        self.assertTrue(record['timed_out'])
        self.assertTrue(record['validity']['valid'])
        self.assertFalse(text.startswith('# VOID'))

    # Real processes from here on: no mocked process groups.

    def run_group(self, script, timeout):
        workspace = self.root / 'trial' / 'workspace'
        workspace.mkdir(parents=True, exist_ok=True)
        pid = workspace.parent / 'pid'
        pid.unlink(missing_ok=True)
        rc = h.launch(['sh', '-c', script], workspace, workspace.parent, dict(os.environ),
                      workspace.parent / 'out', workspace.parent / 'err', timeout)
        return rc, int(pid.read_text()) if pid.exists() else None

    def assertGone(self, pid):
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.02)
        self.fail(f'process {pid} survived its group')

    def test_real_timeouts_stop_the_group_without_errors(self):
        # A leader that dies on SIGTERM leaves a zombie-only group for the
        # SIGKILL; one that ignores SIGTERM is killed and reaped later.
        for script in ('sleep 30 & echo $! > ../pid; wait', "trap '' TERM; sleep 30 & echo $! > ../pid; wait"):
            with self.subTest(script=script):
                rc, pid = self.run_group(script, 1)
                self.assertEqual(rc, 124)
                self.assertGone(pid)
        rc, pid = self.run_group('sleep 30 >/dev/null 2>&1 & echo $! > ../pid; exit 5', 30)
        self.assertEqual(rc, 5)
        self.assertGone(pid)

    def test_a_signal_stops_the_group_and_reports_the_interruption(self):
        interrupted = getattr(h, 'Interrupted', None)
        if interrupted is None:
            self.fail('harness has no Interrupted')
        timer = threading.Timer(0.5, os.kill, (os.getpid(), signal.SIGTERM))
        timer.start()
        try:
            with self.assertRaises(interrupted) as caught:
                self.run_group('sleep 30 & echo $! > ../pid; wait', 30)
        finally:
            timer.cancel()
        self.assertEqual(caught.exception.signum, signal.SIGTERM)
        self.assertGone(int((self.root / 'trial/pid').read_text()))

    def test_only_a_failure_to_start_is_a_launch_failure(self):
        workspace = self.root / 'trial' / 'workspace'; workspace.mkdir(parents=True)
        with self.assertRaises(h.LaunchFailed):
            h.launch([str(self.root / 'missing')], workspace, workspace.parent, dict(os.environ),
                     workspace.parent / 'out', workspace.parent / 'err', 5)

    def sleeping_subject(self):
        """A subject that writes a valid native log, edits the workspace, then hangs."""
        self.subject.write_text('''#!/usr/bin/env python3
import json, os, pathlib, re, sys, time
argv = sys.argv
session = argv[argv.index('--session-id') + 1]
key = re.sub(r'[^A-Za-z0-9]', '-', os.getcwd())
log = pathlib.Path(os.environ['HOME']) / '.claude/projects' / key / (session + '.jsonl')
log.parent.mkdir(parents=True, exist_ok=True)
events = [{'type': 'assistant', 'timestamp': '2026-10-13T15:00:01Z', 'message': {'role': 'assistant',
           'model': argv[argv.index('--model') + 1], 'content': [{'type': 'tool_use', 'id': 'start', 'name': 'Bash',
           'input': {'command': 'shepherd tool start'}}]}},
          {'type': 'user', 'timestamp': '2026-10-13T15:00:02Z', 'message': {'role': 'user', 'content': [
           {'type': 'tool_result', 'tool_use_id': 'start', 'content': 'binary: ' + argv[0] + '\\n'}]}}]
log.write_text(''.join(json.dumps(event) + '\\n' for event in events))
pathlib.Path('ledger/settings.txt').write_text('page_size=99\\n')
time.sleep(30)
''')

    def test_a_real_timeout_of_a_valid_session_keeps_its_evidence(self):
        self.sleeping_subject()
        config = self.case('real-timeout')
        config.policy = {**config.policy, 'subjectTimeoutSeconds': 1}
        with patch.dict(os.environ, {'HOME': str(self.home)}):
            rc, record, text, _ = self.fake_run(config, launch=h.launch)
        self.assertEqual(rc, 124)
        self.assertTrue(record['timed_out'])
        self.assertEqual(record['validity'], {'valid': True, 'void_reasons': []})
        self.assertTrue((config.artifact_root / 'A/claude.jsonl').exists())
        self.assertIn('page_size=99', (config.artifact_root / 'A/claude-diff.patch').read_text())

    def test_an_interrupted_valid_session_keeps_its_evidence(self):
        if getattr(h, 'Interrupted', None) is None:
            self.fail('harness has no Interrupted')
        self.sleeping_subject()
        config = self.case('interrupted')
        timer = threading.Timer(1.5, os.kill, (os.getpid(), signal.SIGTERM))
        timer.start()
        try:
            with patch.dict(os.environ, {'HOME': str(self.home)}), self.assertRaises(SystemExit) as caught:
                self.fake_run(config, launch=h.launch)
        finally:
            timer.cancel()
        self.assertEqual(caught.exception.code, 128 + signal.SIGTERM)
        record = json.loads((config.artifact_root / 'A/claude-run.json').read_text())
        self.assertEqual(record['interrupted'], signal.SIGTERM)
        self.assertTrue(record['validity']['valid'])
        self.assertTrue((config.artifact_root / 'A/claude.jsonl').exists())
        self.assertIn('page_size=99', (config.artifact_root / 'A/claude-diff.patch').read_text())

    def fixtures_script(self, body):
        """A stand-in harness directory whose fixtures.sh runs `body`."""
        here = self.root / 'fake-here'
        here.mkdir(exist_ok=True)
        (here / 'fixtures.sh').write_text('#!/usr/bin/env bash\n' + body + '\n')
        return here

    def test_fixture_refusals_refuse_and_failures_void(self):
        config = self.case('refusal')
        launched = []
        def no_launch(*args):
            launched.append(args)
            return 0
        with patch.object(h, 'HERE', self.fixtures_script('echo refused >&2; exit 2')), patch.object(h, 'HOME', self.home), \
             patch.object(h, 'cli_version', return_value='fake'), patch.object(h, 'launch', no_launch):
            self.refused(h.run, config, 'A', 'claude')
        self.assertEqual(launched, [])
        self.assertEqual(list((config.artifact_root / 'A').glob('*')), [])
        with patch.object(h, 'HERE', self.fixtures_script('exit 1')):
            rc, record, text, launched = self.fake_run(self.case('failure'), prepare=h.prepare)
        self.assertEqual(rc, 3)
        self.assertIn('fixture preparation failed', '\n'.join(record['validity']['void_reasons']))

    def test_a_fixture_timeout_kills_its_process_group(self):
        here = self.fixtures_script(f'sleep 30 & echo $! > {self.root}/fixture-pid; wait')
        config = synthetic_config(self.root, subject=self.subject, path=self.root / 'config.json',
                                  policy={**POLICY, 'toolTimeoutSeconds': 1})
        workspace = self.root / 'trial' / 'workspace'; workspace.mkdir(parents=True)
        with patch.object(h, 'HERE', here), self.assertRaises(subprocess.TimeoutExpired):
            h.prepare(config, 'A', workspace)
        self.assertGone(int((self.root / 'fixture-pid').read_text()))

    @unittest.skipUnless(h.shutil.which('zsh'), 'needs zsh')
    def test_session_shell_resolves_the_scratch_subject(self):
        # The user's own startup files put a decoy launcher first, as the
        # live launcher's directory would be.
        decoy = self.root / 'decoy/shepherd'
        decoy.parent.mkdir()
        decoy.write_text('#!/bin/sh\nexit 0\n'); decoy.chmod(0o755)
        for name in ('.zshenv', '.zprofile', '.zshrc', '.zlogin'):
            (self.home / name).write_text(f'export PATH={decoy.parent}:$PATH\n')
        trial = self.root / 'trial-root'; trial.mkdir()
        with patch.dict(os.environ, {'HOME': str(self.home)}):
            plain = subprocess.run(['zsh', '-lic', 'command -v shepherd'], env={**os.environ, 'PATH': f'{self.subject.parent}:/usr/bin:/bin'},
                                   capture_output=True, text=True, timeout=60)
            self.assertEqual(plain.stdout.strip().splitlines()[-1], str(decoy))
            h.scratch_home(trial, {})
            env = h.environment(self.subject, trial)
            self.assertEqual(h.session_shepherd(env, 60), [str(self.subject)] * 2)

    def test_runs_refuse_when_the_session_shell_finds_another_shepherd(self):
        config = self.case('wrong-shell')
        with patch.object(h, 'HOME', self.home), patch.object(h, 'session_shepherd', return_value=['/elsewhere/shepherd'] * 2), \
             patch.object(h, 'cli_version', return_value='fake'), patch.object(h, 'prepare') as prepare:
            self.assertIn('/elsewhere/shepherd', self.refused(h.run, config, 'A', 'claude'))
        prepare.assert_not_called()

    def test_a_session_id_collision_refuses_before_any_fixture_work(self):
        session = '00000000-0000-4000-8000-000000000000'
        known = self.root / 'known-root'; known.mkdir()
        key = h.re.sub(r'[^A-Za-z0-9]', '-', str(known / 'workspace'))
        log = self.home / '.claude/projects' / key / (session + '.jsonl')
        log.parent.mkdir(parents=True)
        log.write_text('')
        config = self.case('collision-first')
        with patch.object(h, 'HOME', self.home), patch.object(h.uuid, 'uuid4', return_value=session), \
             patch.object(h.tempfile, 'mkdtemp', return_value=str(known)), patch.object(h, 'prepare') as prepare, \
             patch.object(h, 'cli_version', return_value='fake'), \
             patch.object(h, 'session_shepherd', return_value=[str(self.subject)] * 2):
            self.assertIn('session id', self.refused(h.run, config, 'A', 'claude'))
        prepare.assert_not_called()
        self.assertEqual(list((config.artifact_root / 'A').glob('*')), [])

if __name__ == '__main__':
    unittest.main()
