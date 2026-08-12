import { resolve } from 'node:path';
import { verifyPublicHistory } from './lib/public-export.mjs';

const repository = resolve(process.argv[2] ?? '.');

try {
  const result = await verifyPublicHistory(repository);
  console.log(`verify-public-history: OK — ${result.commits.length} commit(s), root ${result.roots[0]}`);
} catch (error) {
  console.error(`verify-public-history: FAIL — ${error.message}`);
  process.exit(1);
}
