#!/usr/bin/env python3
"""Suppress each observer rejection handler and test rebuilt children on the VM."""
import json
from pathlib import Path
import re
import shlex
import subprocess

HOST = 'tester@2.28.133.11'
ROOT = '/home/tester/common-auth-contended-revision-bg052d'
ENV = 'export PATH="$HOME/rt/bun-1.4.2:$HOME/rt/node-v24.16.0-linux-x64/bin:$PATH"'
REPORT = Path('research/load-probe/rejection-controls.json')


def stat():
    return subprocess.check_output(['git', 'diff', '--stat'], text=True).strip()


def send(path):
    archive = subprocess.run(['tar', '-cf', '-', str(path)], capture_output=True, check=True)
    subprocess.run(['ssh', '-o', 'BatchMode=yes', HOST, f'tar -x -C {ROOT}'], input=archive.stdout, check=True)


def remote(command):
    return subprocess.run(['ssh', '-o', 'BatchMode=yes', HOST, f'cd {ROOT} && {ENV} && {command}'], text=True, capture_output=True, timeout=120)


assert not stat(), 'save the complete implementation in the Git index first'
records = []
for seam, path, kinds in [
    ('store', Path('src/store/refresh-lock.ts'), ['contended', 'acquired', 'released']),
    ('fs', Path('src/fs/refresh-file-lock.ts'), ['contended']),
]:
    assert not stat()
    live = path.read_text()
    old = 'void Promise.resolve(result).catch(() => {})'
    assert live.count(old) == 1
    path.write_text(live.replace(old, 'void Promise.resolve(result) // NON-VACUITY BREAK'))
    during = stat()
    assert during
    try:
        send(path)
        build = remote('bun run build')
        assert build.returncode == 0, build.stdout + build.stderr
        for runtime in ['Bun', 'Node 24 strict']:
            for kind in kinds:
                name = f'built {seam} lock absorbs rejected {kind} observer promises under {runtime}'
                result = remote('bun test test/store/lock-events.test.ts -t ' + shlex.quote(re.escape(name)))
                output = result.stdout + result.stderr
                failures = [line for line in output.splitlines() if line.startswith('(fail)')]
                outcome = 'reddened' if result.returncode and len(failures) == 1 and name in failures[0] else 'undefended'
                records.append({
                    'control': f'remove {seam} returned-thenable rejection absorption',
                    'expected_red': name,
                    'captured_output': '\n'.join(failures)[:400],
                    'applied_evidence': f'{path}: during {during}; after checkout and touch empty; VM dist rebuilt from the mutant',
                    'outcome': outcome,
                    'exit_code': result.returncode,
                    'child_exit_assertion_failed': 'Expected: 0' in output and 'Received: 1' in output,
                })
                print(name, result.returncode, outcome, flush=True)
    finally:
        subprocess.run(['git', 'checkout', '--', str(path)], check=True)
        path.touch()
        assert not stat(), stat()
        send(path)
        restored = remote('bun run build')
        assert restored.returncode == 0, restored.stdout + restored.stderr
    REPORT.write_text(json.dumps(records, indent=2) + '\n')
    subprocess.run(['git', 'add', str(REPORT)], check=True)
    assert not stat(), stat()
