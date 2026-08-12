import { censusCommitEvidencePaths } from './lib/census-commit-evidence.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--expected-provenance')) {
    throw new Error('invalid arguments');
  }
  const expectedProvenance = args[0] === '--expected-provenance' ? {
    event_name: process.env.GITHUB_EVENT_NAME,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    sha: process.env.GITHUB_SHA,
  } : undefined;
  const paths = await censusCommitEvidencePaths({ expectedProvenance });
  if (paths.length > 0) process.stdout.write(`${paths.join('\n')}\n`);
} catch {
  console.error('census commit evidence invalid');
  process.exitCode = 1;
}
