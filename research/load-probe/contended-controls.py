#!/usr/bin/env python3
"""Run isolated refusal controls against the implementation saved in the Git index."""
import json
from pathlib import Path
import re
import subprocess

CASES = [
    ('refresh', 'an extra lock held by a legacy holder makes the refresh wait and a rotation by that holder is the credential refreshed'),
    ('refresh', 'two rows with different known identities never overlap their provider calls'),
    ('refresh', 'adding an unknown-identity row waits for a running refresh while an api-key add does not'),
    ('refresh', 'a replace started in another process waits for a paused refresh, which persists first'),
    ('rows', 'a legacy save lock holder at the config path makes a library write wait and then succeed'),
    ('rows', 'a legacy config writer waits for the library store locks and neither write is lost'),
    ('rows', 'a legacy state writer waits for the library store locks and neither write is lost'),
    ('row-transition', 'an attributed disable and a concurrent merge of the provider state both land'),
    ('reorder', 'reorder takes extra locks before the store locks, waits on a held extra lock and completes once it is released'),
    ('remove-enable', 'a refresh holding the row lock across its provider call makes remove wait and cannot write a credential for the removed row'),
    ('account-keyed-refresh', 'an add for the same identity waits on the refreshing row lock and is stored disabled after the rotation commits'),
    ('account-keyed-refresh', 'an earlier row learning the identity disables the in-flight row, whose rotation still commits, and its own refresh re-keys and waits on the in-flight row lock'),
    ('account-keyed-refresh', 'refreshes of two accounts under the default provider lock never overlap'),
    ('credential-stamps', 'a credential swapped in while a strict rotate waits on the row lock is refused at the locked re-read'),
    ('attribution', 'a pull issued during a live replace captures the credential and its epoch in one locked read'),
    ('lock-events', 'contended events distinguish live owners from stale takeovers and successful attempts'),
    ('lock-events', 'throwing lock event observers cannot affect contention acquisition or release'),
    ('lock-events', 'lock event observer promises are not awaited'),
]
SOURCE = Path('src/fs/refresh-file-lock.ts')
OUTPUT = Path('research/load-probe/contended-controls.json')

def stat():
    return subprocess.check_output(['git', 'diff', '--stat'], text=True).strip()

assert not stat(), 'stage the complete live state before mutation'
live = SOURCE.read_text()
records = []
for control in ['bypass live-owner exclusion', 'remove contended emission']:
    assert not stat()
    if control == 'bypass live-owner exclusion':
        mutant = live.replace('if (await lockIsLive()) return contended()', 'if (false && (await lockIsLive())) return contended() // NON-VACUITY BREAK')
    else:
        mutant = live.replace('options.onContended?.()', 'void 0 // NON-VACUITY BREAK')
    assert mutant != live
    SOURCE.write_text(mutant)
    during = stat()
    assert during
    try:
        for stem, name in CASES:
            command = ['bun', 'test', f'test/store/{stem}.test.ts', '-t', re.escape(name)]
            result = subprocess.run(command, text=True, capture_output=True, timeout=90)
            output = result.stdout + result.stderr
            failures = [line for line in output.splitlines() if line.startswith('(fail)')]
            expected = [line for line in failures if name in line]
            outcome = 'reddened' if result.returncode and len(failures) == 1 and len(expected) == 1 else 'undefended'
            records.append({
                'control': control,
                'expected_red': name,
                'captured_output': ('\n'.join(failures) + '\n' + ('observed() cancellation: Expected observation was not received before test cancellation' if 'Expected observation was not received before test cancellation' in output else '')).strip()[:400],
                'applied_evidence': f'{SOURCE}: during {during}; after restore empty',
                'outcome': outcome,
                'exit_code': result.returncode,
                'cancelled_observation': 'Expected observation was not received before test cancellation' in output,
            })
            print(control, stem, name, result.returncode, outcome, flush=True)
            OUTPUT.write_text(json.dumps(records, indent=2) + '\n')
    finally:
        subprocess.run(['git', 'checkout', '--', str(SOURCE)], check=True)
        SOURCE.touch()
        # Stage the report separately so an empty diff proves the source was restored.
        subprocess.run(['git', 'add', str(OUTPUT)], check=True)
        assert not stat(), stat()
