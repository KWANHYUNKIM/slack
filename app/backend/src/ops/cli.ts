// entrypoint.sh가 호출하는 작은 CLI.
//   node dist/ops/cli.js database-url        -> DATABASE_URL 값을 출력
//   node dist/ops/cli.js classify-migrate    -> stdin의 migrate 출력을 읽어 retry | fatal 출력
import { buildDatabaseUrl } from './databaseUrl.js';
import { classifyMigrateOutput } from './migrateErrors.js';

const command = process.argv[2];

if (command === 'database-url') {
  try {
    process.stdout.write(buildDatabaseUrl(process.env));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
} else if (command === 'classify-migrate') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    process.stdout.write(classifyMigrateOutput(input));
  });
} else {
  console.error('usage: cli.js database-url | classify-migrate');
  process.exit(2);
}
