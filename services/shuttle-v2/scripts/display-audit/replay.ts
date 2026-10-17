import fs from 'node:fs';
import readline from 'node:readline';
import { auditDisplay, type AuditFeed } from './check';

const input = process.argv[2];
if (!input) throw new Error('Usage: tsx scripts/display-audit/replay.ts captures.jsonl');
const coverage: Record<string, number> = {};
const groups = new Map<string, { snapshots: number; example: unknown }>();
let snapshots = 0;
for await (const line of readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const { feed, receivedAt } = JSON.parse(line) as { feed: AuditFeed; receivedAt: number };
  const result = auditDisplay(feed, receivedAt);
  snapshots++;
  for (const [key, n] of Object.entries(result.coverage)) coverage[key] = (coverage[key] ?? 0) + n;
  const seen = new Set<string>();
  for (const finding of result.findings) {
    const key = `${finding.line}|${finding.bus}|${finding.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = groups.get(key) ?? { snapshots: 0, example: { at: new Date(receivedAt).toISOString(), ...finding } };
    group.snapshots++; groups.set(key, group);
  }
}
console.log(JSON.stringify({ scope: 'Feed-correlated display consistency; confirmed curb stands only; folded counts excluded', snapshots, coverage,
  groups: Object.fromEntries(groups) }, null, 2));
