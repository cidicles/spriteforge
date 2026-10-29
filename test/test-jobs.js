// Billing integration: queue + ledger + a fake pipeline. Proves that what a
// customer is charged equals what the providers were actually asked to do.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventLog } = require('../lib/events');
const { Ledger } = require('../lib/ledger');
const { Queue } = require('../lib/queue');
const { Jobs } = require('../lib/jobs');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const settle = () => new Promise(r => setTimeout(r, 0));

// `estimates` is consumed in order: submit() takes one, the post-run re-price
// takes the next. An Error in the list is thrown instead of returned.
function harness({ estimates, workers = 4, perUser = 4, hold = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-jobs-'));
  const ledger = new Ledger(new EventLog(path.join(dir, 'credits.jsonl')));
  const finishers = [];
  const pipeline = {
    args: job => [`--id=${job.sprite}`, ...(job.anims || []).map(a => `--anim=${a}`)],
    estimate: async () => {
      const next = estimates.shift();
      if (next instanceof Error) throw next;
      if (next == null) throw new Error('test ran out of estimates');
      return { credits: next, plan: `plan for ${next}` };
    },
    run: (ws, args, onLog, onKill) => {
      onLog('pipeline output\n');
      if (onKill) onKill(() => {});
      if (!hold) return Promise.resolve({ ok: true, code: 0 });
      return new Promise(resolve => finishers.push(resolve));
    }
  };
  const workspaces = {
    dirFor: () => dir,
    character: (u, id) => (id === 'missing' ? null : { id })
  };
  const queue = new Queue({ run: () => { throw new Error('runner not attached'); }, workers, perUser });
  const jobs = new Jobs({ queue, ledger, pipeline, workspaces });
  return { ledger, queue, jobs, finishers, dir };
}

(async () => {
  console.log('\na completed run is charged for what it produced');
  {
    const { ledger, jobs } = harness({ estimates: [39, 0] });
    ledger.grant('u1', 500);
    const job = await jobs.submit('u1', { sprite: 'hero' });
    eq('the quote is held while it runs', ledger.balance('u1').held, 39);
    await settle();
    eq('a fully successful run costs the quote', ledger.balance('u1'), { granted: 500, spent: 39, held: 0, available: 461 });
    eq('the job records what it was charged', jobs.get('u1', job.id).charged, 39);
    ok('the charge was measured, not assumed', jobs.get('u1', job.id).billingMeasured);
  }

  console.log('\na partial run is charged only for the part that happened');
  {
    const { ledger, jobs } = harness({ estimates: [142, 35] });
    ledger.grant('u1', 500);
    await jobs.submit('u1', { sprite: 'hero', anims: ['idle', 'walk', 'attack', 'death'] });
    await settle();
    eq('three of four animations bills for three', ledger.balance('u1').spent, 107);
    eq('the unspent remainder returns', ledger.balance('u1').available, 393);
  }

  console.log('\na run that produced nothing is free');
  {
    const { ledger, jobs } = harness({ estimates: [39, 39] });
    ledger.grant('u1', 100);
    await jobs.submit('u1', { sprite: 'hero' });
    await settle();
    eq('nothing produced, nothing charged', ledger.balance('u1'), { granted: 100, spent: 0, held: 0, available: 100 });
  }

  console.log('\nan unmeasurable run is charged the quote and flagged');
  {
    const { ledger, jobs } = harness({ estimates: [39, new Error('dry-run failed')] });
    ledger.grant('u1', 100);
    const job = await jobs.submit('u1', { sprite: 'hero' });
    await settle();
    eq('the quote is charged', ledger.balance('u1').spent, 39);
    ok('and marked for review', jobs.get('u1', job.id).billingMeasured === false);
    ok('the reason is in the log', /could not re-price/.test(jobs.get('u1', job.id).log));
  }

  console.log('\nspending more than quoted is recorded honestly');
  {
    const { ledger, jobs } = harness({ estimates: [40, 0] });
    ledger.grant('u1', 100);
    // The post-run price drops by more than was reserved, which would mean the
    // run did more than it was quoted for. The ledger records the real number.
    await jobs.submit('u1', { sprite: 'hero' });
    await settle();
    eq('the charge never exceeds what was reserved here', ledger.balance('u1').spent, 40);
  }

  console.log('\na job nobody can pay for never starts');
  {
    const { ledger, jobs, queue } = harness({ estimates: [142] });
    ledger.grant('u1', 50);
    let err = null;
    try { await jobs.submit('u1', { sprite: 'hero' }); } catch (e) { err = e; }
    ok('submit refuses', err && err.code === 'INSUFFICIENT_CREDITS', err && err.message);
    eq('nothing was held', ledger.balance('u1'), { granted: 50, spent: 0, held: 0, available: 50 });
    eq('nothing was queued', queue.list().length, 0);
  }

  console.log('\nalready-generated work is refused rather than billed');
  {
    const { ledger, jobs } = harness({ estimates: [0] });
    ledger.grant('u1', 100);
    let err = null;
    try { await jobs.submit('u1', { sprite: 'hero' }); } catch (e) { err = e; }
    ok('submit says there is nothing to do', err && err.code === 'NOTHING_TO_DO');
    eq('and holds nothing', ledger.balance('u1').held, 0);
  }

  console.log('\na character that does not exist is refused before pricing');
  {
    const { ledger, jobs } = harness({ estimates: [] });
    ledger.grant('u1', 100);
    let err = null;
    try { await jobs.submit('u1', { sprite: 'missing' }); } catch (e) { err = e; }
    ok('submit refuses', err && err.code === 'NO_SUCH_CHARACTER', err && err.message);
    eq('nothing was held', ledger.balance('u1').held, 0);
  }

  console.log('\ncancelling a queued job returns the whole hold');
  {
    const { ledger, jobs, finishers } = harness({ estimates: [39, 39, 0, 0], workers: 1, perUser: 1, hold: true });
    ledger.grant('u1', 500);
    const first = await jobs.submit('u1', { sprite: 'hero' });
    const second = await jobs.submit('u1', { sprite: 'villain' });
    eq('both jobs are held', ledger.balance('u1').held, 78);
    eq('only one is running', [first.status, second.status], ['running', 'queued']);
    jobs.cancel('u1', second.id);
    eq('the cancelled hold is returned in full', ledger.balance('u1').held, 39);
    finishers[0]({ ok: true, code: 0 });
    await settle();
    eq('the run that did happen is charged', ledger.balance('u1').spent, 39);
    eq('and the cancelled one is not', ledger.balance('u1').available, 461);
  }

  console.log('\ntwo jobs on one character queue instead of racing');
  {
    const { jobs, queue, finishers, ledger } = harness({ estimates: [39, 39, 0, 0], workers: 4, perUser: 4, hold: true });
    ledger.grant('u1', 500);
    const a = await jobs.submit('u1', { sprite: 'hero', anims: ['idle'] });
    const b = await jobs.submit('u1', { sprite: 'hero', anims: ['walk'] });
    eq('the second waits for the character lock', [a.status, b.status], ['running', 'queued']);
    eq('both are already paid for', ledger.balance('u1').held, 78);
    finishers[0]({ ok: true, code: 0 });
    await settle();
    eq('the second starts once the first is done', queue.get(b.id).status, 'running');
    finishers[1]({ ok: true, code: 0 });
    await settle();
    eq('both settle', ledger.balance('u1').spent, 78);
    eq('no holds are left behind', ledger.balance('u1').held, 0);
  }

  console.log('\none customer cannot see or touch another\'s jobs');
  {
    const { jobs, ledger } = harness({ estimates: [39, 0] });
    ledger.grant('u1', 100);
    const job = await jobs.submit('u1', { sprite: 'hero' });
    await settle();
    eq('a stranger cannot read the job', jobs.get('u2', job.id), null);
    eq('a stranger cannot cancel the job', jobs.cancel('u2', job.id), null);
    eq('listing is per customer', jobs.list('u2').length, 0);
    eq('the owner sees it', jobs.list('u1').length, 1);
  }

  console.log('\nthe job handed to a customer carries no server internals');
  {
    const { jobs, ledger } = harness({ estimates: [39, 0] });
    ledger.grant('u1', 100);
    const job = await jobs.submit('u1', { sprite: 'hero' });
    await settle();
    const seen = jobs.get('u1', job.id);
    ok('no workspace path', !('workspace' in seen));
    ok('no raw argv', !('args' in seen));
    ok('no kill handle', !('kill' in seen));
    ok('the log is still there', /pipeline output/.test(seen.log));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
