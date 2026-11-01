import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as inventoryModule from './source-inventory.js';
import * as verifierModule from './namespace-verifier.js';
import { runFixture } from './fixture-runner.js';
import { projectPublicPacket } from './raw-ingress.js';
import { squareSpec } from './test-fixtures.js';

function raw(observedAt: number, cursor: number, atStop = false) {
  return { v: 1, epoch: 'controlled-cli', build: 'controlled-cli', cursor, latest: cursor, hasMore: false, frames: [],
    feed: { buses: [{ route_id: 100, bus_id: 7, bus_name: '#raw', observed_at: observedAt,
      lat: 41, lon: atStop ? -72.99 : -73, stationary: atStop, at_stop_id: atStop ? 100 : null }] } };
}
const ingest = (body: unknown, availableAt: number, status = 200) => ({ kind: 'ingest', availableAt,
  originalReceivedAt: availableAt, status, origin: 'public-current', rawBase64: Buffer.from(JSON.stringify(body)).toString('base64') });
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'encounter-cli-'));
  const inputFile = path.join(directory, 'commands.jsonl'), catalog = path.join(directory, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify(squareSpec()));
  return { directory, options: { inputFile, catalogFiles: [catalog], outputRoot: path.join(directory, 'new-namespace'),
    namespaceId: 'controlled-finite-cli' } };
}

describe('finite fixture CLI with durable independent verification', () => {
  it('persists a real positive proxy computation, closes and verifies its exact raw/command/result/checkpoint prefix', () => {
    const { directory, options } = setup();
    try {
      const first = raw(1000, 1), timing = { originalReceivedAt: 1100, availableAt: 1100 };
      const packet = projectPublicPacket(first, timing);
      const commands = [ingest(first, 1100), { kind: 'enroll', availableAt: 1100, opportunity: {
        id: 'controlled-promise', vehicle: { routeId: 100, busId: 7, busName: '#raw' }, stopId: 100,
        horizon: '0-2', forecastAt: 1100, availableAt: 1100, receiptHash: packet.receiptHash,
      } }, ingest(raw(26000, 2, true), 26100), ingest(raw(36000, 3, true), 36100)];
      fs.writeFileSync(options.inputFile, commands.map(value => JSON.stringify(value)).join('\n') + '\n');
      const receipt = runFixture(options);
      expect(receipt).toMatchObject({ completed: true, refused: false, fixtureMode: true,
        prospectiveQualified: false, physicalServiceTruth: false, publicationCapability: false,
        verification: { verified: true, completed: true, commands: 4, checkpointFiles: 1 } });
      expect(receipt.verification.events).toBeGreaterThanOrEqual(2);
      const checkpoint = fs.readdirSync(options.outputRoot).find(file => file.startsWith('checkpoint-'))!;
      const state = JSON.parse(fs.readFileSync(path.join(options.outputRoot, checkpoint), 'utf8'));
      expect(state.snapshot.enrollments.records['controlled-promise']).toMatchObject({ status: 'matched',
        arrivedAt: 26000, det: 24.9, availableAt: 36100 });
      expect(receipt.verification.actualClocks.createdAt).toBeGreaterThan(36100);
      expect(receipt.verification.fixtureClocks.lastAvailableAt).toBe(36100);
      expect(JSON.parse(fs.readFileSync(options.outputRoot + '.receipt.json', 'utf8')).expectedPrefix).toEqual(receipt.expectedPrefix);
      expect(() => runFixture(options)).toThrow();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains malformed raw bytes and seals a verifiable refused namespace without consuming later commands', () => {
    const { directory, options } = setup();
    try {
      const malformed = Buffer.from('{incomplete');
      fs.writeFileSync(options.inputFile, JSON.stringify({ ...ingest(null, 1100), rawBase64: malformed.toString('base64') })
        + '\n' + JSON.stringify({ kind: 'tick', availableAt: 1200 }) + '\n');
      const receipt = runFixture(options);
      expect(receipt).toMatchObject({ completed: false, refused: true,
        input: { commandsProvided: 2, commandsConsumed: 1 }, verification: { verified: true, refused: true, commands: 1 } });
      expect(fs.readFileSync(path.join(options.outputRoot, 'raw.bin'))).toEqual(malformed);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects incomplete source input before creating a namespace or pretending to have observed a packet', () => {
    const { directory, options } = setup();
    try {
      fs.writeFileSync(options.inputFile, JSON.stringify(ingest(raw(1000, 1), 1100)));
      expect(() => runFixture(options)).toThrow(/final LF/);
      expect(fs.existsSync(options.outputRoot)).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  for (const stage of ['inventory', 'verification'] as const) it(`refuses elapsed wall budget after ${stage} without a successful external receipt`, () => {
    const { directory, options } = setup();
    let now = 0;
    const timer = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const actualInventory = inventoryModule.inventoryRuntime, actualVerifier = verifierModule.verifyFixtureNamespace;
    const stageSpy = stage === 'inventory'
      ? vi.spyOn(inventoryModule, 'inventoryRuntime').mockImplementation((...args) => { const value = actualInventory(...args); now = 60001; return value; })
      : vi.spyOn(verifierModule, 'verifyFixtureNamespace').mockImplementation((...args) => { const value = actualVerifier(...args); now = 60001; return value; });
    try {
      fs.writeFileSync(options.inputFile, JSON.stringify(ingest(raw(1000, 1), 1100)) + '\n');
      expect(() => runFixture(options)).toThrow(/wall-clock deadline/);
      expect(fs.existsSync(options.outputRoot + '.receipt.json')).toBe(false);
      if (stage === 'inventory') expect(fs.existsSync(options.outputRoot)).toBe(false);
    } finally { stageSpy.mockRestore(); timer.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
