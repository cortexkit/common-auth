"""Summarize phase traces captured by load-probe, retaining every run's status."""
import json
import statistics
import sys
from pathlib import Path

results = []
for name in sys.argv[1:]:
    path = Path(name)
    records = [json.loads(line) for line in path.read_text().splitlines()]
    runs = []
    for record in records:
        if 'run' not in record:
            continue
        traces = []
        for line in record['output'].splitlines():
            for label in ('Stale elections failure phases ', 'Check quotas failure phases '):
                if line.startswith(label):
                    traces.append(json.loads(line[len(label):]))
        if not traces:
            raise ValueError(f'No phase trace: {name}, run {record["run"]}')
        events = traces[-1]['events']
        item = {key: record[key] for key in ('run', 'code', 'durationMs')}
        item['bodyMs'] = events[-1]['ms']
        if 'elections' in name:
            starts = {event['round']: event['ms'] for event in events if event['phase'] == 'round-start'}
            costs = [event['ms'] - starts[event['round']] for event in events if event['phase'] == 'round-end']
            item.update(rounds=len(costs), roundMeanMs=statistics.mean(costs), roundMedianMs=statistics.median(costs), roundMaxMs=max(costs))
        else:
            # Preserve the complete, small quota trace so readers can check
            # poll, write, read, render, and final print intervals independently.
            item['events'] = events
        runs.append(item)
    summary = records[-1]
    assert summary['runs'] == len(runs)
    assert summary['failures'] == sum(run['code'] != 0 for run in runs)
    results.append({'file': path.name, 'summary': summary, 'runs': runs})
print(json.dumps(results, indent=2))
