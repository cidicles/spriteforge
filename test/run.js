// Runs every suite in its own process, because test-http.js configures the
// server through environment variables at require time.

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = ['test-ledger.js', 'test-accounts.js', 'test-sessions.js', 'test-queue.js', 'test-jobs.js', 'test-http.js', 'test-demo.js'];

let failed = 0;
const summary = [];

for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const tally = out.match(/(\d+) passed, (\d+) failed/);
  const ok = r.status === 0;
  if (!ok) {
    failed++;
    process.stdout.write(out);          // only noisy suites get printed in full
  }
  summary.push(`${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(20)} ${tally ? `${tally[1]} checks` : 'no tally'}`);
}

console.log('\n' + summary.join('\n'));
console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
