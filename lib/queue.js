// Job scheduling for one shared pipeline.
//
// Two separate constraints, for two different reasons:
//
//   one job per (user, character)   Hard correctness. A character's
//     _work/state.json has exactly one writer; two runs on the same character
//     race over the paid-job cache and can pay twice for the same clip. The
//     local studio got this right by running one job at a time globally — that
//     is too strict once there are customers, but per character it still holds.
//
//   N jobs per user                 Fairness. Worker slots are finite and one
//     customer generating a twelve-animation cast must not starve everyone else.
//
// A blocked job must never stall the ones behind it, so the scheduler scans
// the whole queue for the first *eligible* job rather than looking only at the
// head. With per-user caps, head-of-line blocking is the default failure mode.
//
// `run` is injected: the scheduler is tested without spawning anything.

const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

class Queue {
  // run(job, onLog) -> Promise<{ ok: boolean, code?: number }>
  constructor({ run, workers = 4, perUser = 2, onChange = () => {} }) {
    if (typeof run !== 'function') throw new Error('Queue needs a run(job, onLog) function');
    this.run = run;
    this.workers = workers;
    this.perUser = perUser;
    this.onChange = onChange;
    this.jobs = new Map();
    this.order = [];      // job ids, enqueue order
    this.nextId = 1;
  }

  enqueue({ user, sprite, ...rest }) {
    if (!user) throw new Error('a job needs a user');
    if (!sprite) throw new Error('a job needs a sprite');
    const job = {
      id: String(this.nextId++),
      user, sprite, ...rest,
      status: 'queued', log: '', createdAt: Date.now()
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.onChange(job);
    this.#pump();
    return job;
  }

  get(id) { return this.jobs.get(id); }

  list(user) {
    const all = this.order.map(id => this.jobs.get(id)).reverse();
    return user ? all.filter(j => j.user === user) : all;
  }

  #queued() { return this.order.map(id => this.jobs.get(id)).filter(j => j.status === 'queued'); }
  #running() { return [...this.jobs.values()].filter(j => j.status === 'running'); }

  #eligible(job, running) {
    if (running.length >= this.workers) return false;
    if (running.filter(j => j.user === job.user).length >= this.perUser) return false;
    // The per-character lock: same user, same character, already in flight.
    return !running.some(j => j.user === job.user && j.sprite === job.sprite);
  }

  #pump() {
    // A runner that fails synchronously finishes its job inside #start, which
    // pumps again. The guard turns that recursion into another turn of the
    // loop below, which re-reads state anyway.
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Re-read `running` each iteration: starting one job changes eligibility
      // for every job after it.
      for (;;) {
        const running = this.#running();
        const next = this.#queued().find(j => this.#eligible(j, running));
        if (!next) return;
        this.#start(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  #start(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    this.onChange(job);
    const append = text => { job.log = (job.log + text).slice(-200000); };

    // Started synchronously, so a job is actually in flight the moment its
    // status says so. A runner that throws before returning a promise is just
    // a failed job.
    const failed = error => {
      append(`\n${error.message}\n`);
      this.#finish(job, 'failed', { ok: false, error: error.message });
    };
    let promise;
    try { promise = Promise.resolve(this.run(job, append)); }
    catch (error) { return failed(error); }
    promise.then(
      result => this.#finish(job, result && result.ok ? 'done' : 'failed', result),
      failed
    );
  }

  #finish(job, status, result) {
    // A cancel that landed while the runner was unwinding wins: the operator
    // asked for it and the runner was told to stop.
    job.status = job.cancelRequested ? 'cancelled' : status;
    job.finishedAt = Date.now();
    job.result = result;
    this.onChange(job);
    this.#pump();
  }

  // Cancelling a queued job drops it. Cancelling a running one asks the runner
  // to stop: safe mid-flight because the paid job id is already in state.json,
  // so resuming picks the same job up instead of paying for a new one.
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.onChange(job);
      this.#pump();
    } else if (job.status === 'running') {
      job.cancelRequested = true;
      if (job.kill) job.kill();
      this.onChange(job);
    }
    return job;
  }

  stats() {
    const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const j of this.jobs.values()) byStatus[j.status]++;
    return { workers: this.workers, perUser: this.perUser, ...byStatus };
  }
}

module.exports = { Queue, STATUSES };
