// Scheduler tests. No processes are spawned: the runner is a promise the test
// resolves by hand, so ordering is deterministic rather than timing-dependent.

const { Queue } = require('../lib/queue');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// A runner whose jobs finish only when the test says so.
function manualRunner() {
  const started = [];
  const finishers = new Map();
  const run = (job, onLog) => {
    started.push(job.id);
    onLog(`running ${job.user}/${job.sprite}\n`);
    return new Promise(resolve => finishers.set(job.id, resolve));
  };
  return {
    run,
    started,
    // Finishing is async in the scheduler, so settle the microtask queue.
    async finish(id, ok = true) {
      finishers.get(id)({ ok });
      finishers.delete(id);
      await new Promise(r => setImmediate(r));
    }
  };
}

const ids = jobs => jobs.map(j => j.id);

(async () => {
  console.log('\nworker limit');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 2, perUser: 10 });
    for (let i = 0; i < 4; i++) q.enqueue({ user: 'u' + i, sprite: 's' });
    eq('only `workers` jobs start', r.started, ['1', '2']);
    await r.finish('1');
    eq('a freed slot starts the next job', r.started, ['1', '2', '3']);
    await r.finish('2');
    await r.finish('3');
    eq('the queue drains', r.started, ['1', '2', '3', '4']);
  }

  console.log('\nper-user limit');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 8, perUser: 2 });
    q.enqueue({ user: 'u1', sprite: 'a' });
    q.enqueue({ user: 'u1', sprite: 'b' });
    q.enqueue({ user: 'u1', sprite: 'c' });
    eq('one user cannot exceed their cap', r.started, ['1', '2']);
    await r.finish('1');
    eq('finishing one lets the third in', r.started, ['1', '2', '3']);
  }

  console.log('\none user cannot starve another (no head-of-line blocking)');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 4, perUser: 1 });
    q.enqueue({ user: 'hog', sprite: 'a' });
    q.enqueue({ user: 'hog', sprite: 'b' });
    q.enqueue({ user: 'hog', sprite: 'c' });
    q.enqueue({ user: 'someone-else', sprite: 'a' });
    eq('the blocked user does not stall the queue behind them', r.started, ['1', '4']);
  }

  console.log('\nper-character lock');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 8, perUser: 8 });
    q.enqueue({ user: 'u1', sprite: 'hero' });
    q.enqueue({ user: 'u1', sprite: 'hero' });   // same character — must wait
    q.enqueue({ user: 'u1', sprite: 'villain' });
    eq('two runs never touch one character at once', r.started, ['1', '3']);
    await r.finish('1');
    eq('the second run starts once the first releases the character', r.started, ['1', '3', '2']);
  }

  console.log('\nthe lock is per user, not global');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 8, perUser: 8 });
    q.enqueue({ user: 'u1', sprite: 'hero' });
    q.enqueue({ user: 'u2', sprite: 'hero' });   // different workspace, no race
    eq('two users may generate a same-named character together', r.started, ['1', '2']);
  }

  console.log('\noutcomes');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 4, perUser: 4 });
    const a = q.enqueue({ user: 'u1', sprite: 'a' });
    const b = q.enqueue({ user: 'u1', sprite: 'b' });
    await r.finish(a.id, true);
    await r.finish(b.id, false);
    eq('a successful run is done', q.get(a.id).status, 'done');
    eq('a failed run is failed', q.get(b.id).status, 'failed');
    ok('the log is captured', /running u1\/a/.test(q.get(a.id).log));
    ok('timestamps are recorded', q.get(a.id).startedAt > 0 && q.get(a.id).finishedAt > 0);
  }

  console.log('\na thrown runner is a failure, not a crash');
  {
    const q = new Queue({ run: () => { throw new Error('provider exploded'); }, workers: 1, perUser: 1 });
    const j = q.enqueue({ user: 'u1', sprite: 'a' });
    await new Promise(r => setImmediate(r));
    eq('the job fails', q.get(j.id).status, 'failed');
    ok('the reason reaches the log', /provider exploded/.test(q.get(j.id).log));
    const k = q.enqueue({ user: 'u1', sprite: 'b' });
    await new Promise(r => setImmediate(r));
    ok('the slot was released', k.status !== 'queued');
  }

  console.log('\ncancellation');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 1, perUser: 1 });
    const running = q.enqueue({ user: 'u1', sprite: 'a' });
    const waiting = q.enqueue({ user: 'u1', sprite: 'b' });
    eq('a queued job is cancelled outright', (q.cancel(waiting.id), q.get(waiting.id).status), 'cancelled');
    let killed = false;
    q.get(running.id).kill = () => { killed = true; };
    q.cancel(running.id);
    ok('a running job is asked to stop', killed);
    await r.finish(running.id, true);
    eq('an operator cancel wins over a late success', q.get(running.id).status, 'cancelled');
  }

  console.log('\ncancelling a queued job frees nothing it never held');
  {
    const r = manualRunner();
    const q = new Queue({ run: r.run, workers: 1, perUser: 1 });
    q.enqueue({ user: 'u1', sprite: 'a' });
    const second = q.enqueue({ user: 'u1', sprite: 'b' });
    const third = q.enqueue({ user: 'u1', sprite: 'c' });
    q.cancel(second.id);
    await r.finish('1');
    eq('the next uncancelled job runs', r.started, ['1', '3']);
    eq('the cancelled one never started', q.get(second.id).status, 'cancelled');
    ok('ids stay stable', third.id === '3');
  }

  console.log('\nbookkeeping');
  {
    const r = manualRunner();
    const changes = [];
    const q = new Queue({ run: r.run, workers: 2, perUser: 2, onChange: j => changes.push(`${j.id}:${j.status}`) });
    q.enqueue({ user: 'u1', sprite: 'a' });
    await r.finish('1');
    eq('every transition is announced', changes, ['1:queued', '1:running', '1:done']);
    q.enqueue({ user: 'u2', sprite: 'b' });
    eq('listing is newest-first', ids(q.list()), ['2', '1']);
    eq('listing filters by user', ids(q.list('u1')), ['1']);
    eq('stats count by status', q.stats(), { workers: 2, perUser: 2, queued: 0, running: 1, done: 1, failed: 0, cancelled: 0 });
  }

  console.log('\nbad jobs are refused');
  {
    const q = new Queue({ run: () => Promise.resolve({ ok: true }) });
    for (const [label, job] of [['without a user', { sprite: 's' }], ['without a sprite', { user: 'u' }]]) {
      try { q.enqueue(job); ok('a job ' + label + ' is refused', false, 'no throw'); }
      catch (e) { ok('a job ' + label + ' is refused', /needs a/.test(e.message)); }
    }
    try { new Queue({}); ok('a queue without a runner is refused', false, 'no throw'); }
    catch (e) { ok('a queue without a runner is refused', /needs a run/.test(e.message)); }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
