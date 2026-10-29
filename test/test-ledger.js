// Ledger tests. These are the money tests: if one of them goes red, someone
// is being over- or under-charged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventLog } = require('../lib/events');
const { Ledger } = require('../lib/ledger');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const throws = (label, fn, re) => {
  try { fn(); ok(label, false, 'did not throw'); }
  catch (e) { ok(label, re.test(e.message), `threw "${e.message}"`); }
};

function freshLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ledger-'));
  return { dir, file: path.join(dir, 'events.jsonl') };
}

console.log('\nbalances');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  eq('empty account is all zero', l.balance('u1'), { granted: 0, spent: 0, held: 0, available: 0 });
  l.grant('u1', 500, { source: 'test' });
  eq('grant raises granted and available', l.balance('u1'), { granted: 500, spent: 0, held: 0, available: 500 });
  l.reserve('job1', 'u1', 39);
  eq('reserve holds without spending', l.balance('u1'), { granted: 500, spent: 0, held: 39, available: 461 });
  l.settle('job1', 35);
  eq('settling under returns the remainder', l.balance('u1'), { granted: 500, spent: 35, held: 0, available: 465 });
}

console.log('\nreservations cannot oversell');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 50);
  l.reserve('a', 'u1', 40);
  throws('a second job cannot reserve the same credits', () => l.reserve('b', 'u1', 40), /Not enough credits/);
  eq('available reflects only the open hold', l.balance('u1').available, 10);
  l.reserve('b', 'u1', 10);
  eq('the remainder is still reservable', l.balance('u1').available, 0);
  throws('nothing left to reserve', () => l.reserve('c', 'u1', 1), /Not enough credits/);
}

console.log('\ninsufficient credits is identifiable');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 5);
  try { l.reserve('a', 'u1', 39); fail++; console.log('  FAIL expected a throw'); }
  catch (e) {
    ok('carries a machine-readable code', e.code === 'INSUFFICIENT_CREDITS');
    eq('reports what was needed', [e.need, e.available], [39, 5]);
  }
}

console.log('\nrefs are single-use');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 500);
  l.reserve('job1', 'u1', 39);
  throws('a ref cannot be reserved twice', () => l.reserve('job1', 'u1', 39), /already been reserved/);
  l.settle('job1', 39);
  throws('a settled ref cannot be reserved again', () => l.reserve('job1', 'u1', 39), /already been reserved/);
  throws('a settled ref cannot be settled again', () => l.settle('job1', 39), /already closed/);
  throws('a settled ref cannot be released', () => l.release('job1'), /already closed/);
  throws('an unknown ref cannot be settled', () => l.settle('nope', 1), /no open reservation/);
  eq('the double-settle attempts changed nothing', l.balance('u1'), { granted: 500, spent: 39, held: 0, available: 461 });
}

console.log('\nrelease returns the whole hold');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 100);
  l.reserve('job1', 'u1', 60);
  l.release('job1');
  eq('a released job costs nothing', l.balance('u1'), { granted: 100, spent: 0, held: 0, available: 100 });
}

console.log('\noverspend is recorded, not hidden');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 50);
  l.reserve('job1', 'u1', 40);
  l.settle('job1', 55);   // the provider really was paid 55
  eq('the real spend is recorded even past the balance', l.balance('u1'), { granted: 50, spent: 55, held: 0, available: -5 });
  throws('a negative account cannot start new work', () => l.reserve('job2', 'u1', 1), /Not enough credits/);
}

console.log('\naccounts are isolated');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 100);
  l.grant('u2', 7);
  l.reserve('j1', 'u1', 50);
  eq('u1 holds do not touch u2', l.balance('u2'), { granted: 7, spent: 0, held: 0, available: 7 });
  throws('u2 cannot spend u1 credits', () => l.reserve('j2', 'u2', 50), /Not enough credits/);
}

console.log('\nbad input is rejected');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  throws('fractional grants', () => l.grant('u1', 1.5), /positive integer/);
  throws('zero grants', () => l.grant('u1', 0), /positive integer/);
  throws('negative grants', () => l.grant('u1', -5), /positive integer/);
  l.grant('u1', 100);
  throws('fractional reservations', () => l.reserve('j', 'u1', 0.5), /positive integer/);
  l.reserve('j', 'u1', 10);
  throws('negative settlements', () => l.settle('j', -1), /non-negative integer/);
  eq('a zero settlement is legal (nothing was spent)', (l.settle('j', 0), l.balance('u1')), { granted: 100, spent: 0, held: 0, available: 100 });
}

console.log('\nstate survives a restart');
{
  const { file } = freshLog();
  const a = new Ledger(new EventLog(file));
  a.grant('u1', 500);
  a.grant('u2', 120);
  a.reserve('j1', 'u1', 39);
  a.settle('j1', 35);
  a.reserve('j2', 'u1', 70);      // still open across the restart
  a.reserve('j3', 'u2', 20);
  a.release('j3');

  const b = new Ledger(new EventLog(file));   // fresh process, same file
  eq('u1 replays identically', b.balance('u1'), a.balance('u1'));
  eq('u2 replays identically', b.balance('u2'), a.balance('u2'));
  eq('the open hold is still open', b.balance('u1').held, 70);
  throws('a reserved ref is still taken after a restart', () => b.reserve('j1', 'u1', 5), /already been reserved/);
  b.settle('j2', 70);
  eq('the restored hold can still be settled', b.balance('u1'), { granted: 500, spent: 105, held: 0, available: 395 });
}

console.log('\nhistory is auditable');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 100, { source: 'stripe:pi_123' });
  l.reserve('j1', 'u1', 40);
  l.settle('j1', 22);
  const h = l.history('u1');
  eq('every movement is on the record', h.map(e => e.type), ['grant', 'reserve', 'settle']);
  eq('the grant keeps its provenance', h[0].meta.source, 'stripe:pi_123');
  eq('the settle records what was reserved', h[2].meta.reserved, 40);
  ok('events are sequenced', h.every((e, i) => e.seq === i + 1));
  ok('events are timestamped', h.every(e => !isNaN(Date.parse(e.ts))));
}

console.log('\na damaged ledger refuses to load');
{
  const { file } = freshLog();
  const l = new Ledger(new EventLog(file));
  l.grant('u1', 100);
  fs.appendFileSync(file, '{"type":"grant","user":"u1","amount":5\n');   // truncated
  throws('a half-written line is fatal, not ignored', () => new Ledger(new EventLog(file)), /refusing to start on a damaged ledger/);
}

console.log('\nunknown event types are fatal');
{
  const { file } = freshLog();
  fs.writeFileSync(file, JSON.stringify({ seq: 1, ts: new Date().toISOString(), type: 'transmute', user: 'u1', amount: 1 }) + '\n');
  throws('an unrecognised event stops the replay', () => new Ledger(new EventLog(file)), /Unknown ledger event type/);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
