import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCatalog, BoundedFD, canonicalValue, requireValue, runtimeRequired } from './custody.js';
import { verifyCatalog } from './verify.js';

/** Explicit finite analyzer entrypoint. No actor or catalog-activation command exists. */
export function main(args: readonly string[]): void {
  runtimeRequired();
  const [command, ...rest] = args;
  requireValue(command === 'run' || command === 'verify', 'Usage: run --input FILE --sources DIRECTORY --out NEW_DIRECTORY [--execution-identity FILE]; verify --directory DIRECTORY --manifest SHA256 [--final SHA256]');
  const allowed = command === 'run' ? ['--input', '--sources', '--out', '--execution-identity'] : ['--directory', '--manifest', '--final'];
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!, value = rest[index + 1];
    requireValue(allowed.includes(key) && value !== undefined && !values.has(key), 'Unknown, duplicate or missing CLI option');
    values.set(key, value);
  }
  const required = (key: string): string => { const value = values.get(key); requireValue(value, 'Missing CLI option: ' + key); return value; };
  if (command === 'verify') {
    process.stdout.write(JSON.stringify(verifyCatalog({ directory: required('--directory'),
      expectedManifestHash: required('--manifest'), expectedFinalHash: values.get('--final') })) + '\n');
    return;
  }
  let executionIdentity: unknown = null;
  const identityFile = values.get('--execution-identity');
  if (identityFile) {
    const input = new BoundedFD(path.resolve(identityFile), 32768, { bytes: 0, maximum: 32769 });
    try {
      const bytes = input.all(), pin = input.finish();
      executionIdentity = { schema: 'externally-supplied-execution-identity/v1',
        rawBytes: pin.bytes, rawSHA256: pin.sha256, value: canonicalValue(bytes) };
    } finally { input.close(); }
  }
  const result = analyzeCatalog({ inputFile: required('--input'), sourceRoot: required('--sources'),
    outputDirectory: required('--out'), executionIdentity });
  const verification = verifyCatalog({ directory: result.directory, expectedManifestHash: result.manifestHash,
    expectedFinalHash: result.finalHash, expectedPrefix: result.prefix });
  process.stdout.write(JSON.stringify({ scope: result.scope, directory: result.directory,
    manifestHash: result.manifestHash, finalHash: result.finalHash, prefix: result.prefix,
    outputBytes: result.outputBytes, admissionReadBytes: result.admissionReadBytes, sourceReadPasses: result.sourceReadPasses,
    verdict: result.result.verdict, complete: result.result.complete, searchExhausted: result.result.searchExhausted,
    artifactCompletion: result.artifactCompletion, counts: result.result.counts, verification,
    qualificationPending: true, liveQualified: false, publicationCapability: false }) + '\n');
  if (!result.result.complete || !result.artifactCompletion) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
