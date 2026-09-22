#!/usr/bin/env python3
"""One-off immutable export of a closed day and its adjacent-day context."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('day')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    day = dt.date.fromisoformat(args.day)
    adjacent = day + dt.timedelta(days=1)
    args.output.mkdir(parents=True, exist_ok=False)
    script = Path(__file__).with_name('capture.py')
    results = []
    for date, role, extra in [(day, 'primary', []), (adjacent, 'adjacent-context', ['--allow-open-day'])]:
        directory = args.output / date.isoformat()
        result = subprocess.run([sys.executable, str(script), date.isoformat(), str(directory), *extra])
        results.append(dict(day=date.isoformat(), role=role, directory=directory.name, exitCode=result.returncode))
        (args.output / 'pair.json').write_text(json.dumps(dict(captures=results,
            note='Immutable evidence only; no outcome scoring or assertion of settled labels.'), indent=2) + '\n')
    raise SystemExit(0 if all(row['exitCode'] == 0 for row in results) else 1)


if __name__ == '__main__':
    main()
