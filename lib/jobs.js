// Where the money meets the work: reserve before running, settle on what was
// actually spent.
//
// The charge is NOT the estimate. After a run, pricing the same job again
// reports what is *still* unpaid, so
//
//     charge = estimate_before - estimate_after
//
// is exactly what the providers were asked to do — derived from the pipeline's
// own cache, not from parsing log lines or trusting an exit code. A run that
// produced three of four animations bills for three. A run that died after the
// keyframe bills for the keyframe.
//
// One known bias, deliberately in the customer's favour: a clip that was paid
// for but whose download was interrupted still reads as unpaid, so we
// under-charge and absorb it. The pipeline's pay-once cache means the retry
// resumes that same provider job instead of buying a second one, so the money
// is not lost twice.
//
// The ledger ref is a fresh uuid rather than the queue's job id, because queue
// ids restart with the process and a ledger ref must be unique forever.

const crypto = require('crypto');

class Jobs {
  constructor({ queue, ledger, pipeline, workspaces, onEvent = () => {} }) {
    this.queue = queue;
    this.ledger = ledger;
    this.pipeline = pipeline;
    this.workspaces = workspaces;
    this.onEvent = onEvent;
    queue.run = (job, onLog) => this.#execute(job, onLog);
  }

  // Prices a job without reserving anything, for a "this will cost N" preview.
  async quote(userId, body) {
    const workspace = this.workspaces.dirFor(userId);
    const args = this.pipeline.args({ ...body, sprite: body.sprite || body.id });
    return this.pipeline.estimate(workspace, args);
  }

  async submit(userId, body) {
    const sprite = body.sprite || body.id;
    if (!this.workspaces.character(userId, sprite)) {
      const err = new Error(`No character "${sprite}" in this workspace`);
      err.code = 'NO_SUCH_CHARACTER';
      throw err;
    }
    const workspace = this.workspaces.dirFor(userId);
    const args = this.pipeline.args({ ...body, sprite });

    // Price first: a job nobody can pay for should never reach the queue.
    const before = await this.pipeline.estimate(workspace, args);
    if (before.credits === 0) {
      const err = new Error('Everything requested is already generated');
      err.code = 'NOTHING_TO_DO';
      err.plan = before.plan;
      throw err;
    }

    // Reserve before enqueueing: the queue starts jobs synchronously, so the
    // hold has to exist before the work can possibly begin.
    const ref = crypto.randomUUID();
    this.ledger.reserve(ref, userId, before.credits);

    try {
      return this.queue.enqueue({
        user: userId, sprite, ref, args, workspace,
        anims: body.anims || [],
        estimate: before.credits,
        plan: before.plan
      });
    } catch (e) {
      // Nothing ran, so the hold must not linger.
      this.ledger.release(ref);
      throw e;
    }
  }

  async #execute(job, onLog) {
    onLog(`$ generate-sprites.js ${job.args.join(' ')}\n`);
    const result = await this.pipeline.run(job.workspace, job.args, onLog, kill => { job.kill = kill; });

    let charge = job.estimate;
    let measured = false;
    try {
      const after = await this.pipeline.estimate(job.workspace, job.args);
      // Clamp: a definition edited mid-run could price higher afterwards, and
      // a negative charge would be a credit nobody paid for.
      charge = Math.max(0, job.estimate - after.credits);
      measured = true;
      job.remaining = after.credits;
    } catch (e) {
      // Could not tell what was spent. Charge the quote and mark it for review
      // rather than guessing in either direction silently.
      onLog(`\n[billing] could not re-price after the run (${e.message}); charging the estimate\n`);
    }

    this.ledger.settle(job.ref, charge);
    job.charged = charge;
    job.billingMeasured = measured;
    onLog(`\n[billing] ${charge} credits of ${job.estimate} reserved${measured ? '' : ' (unmeasured)'}\n`);
    this.onEvent({ type: 'settled', job: job.id, user: job.user, charge, measured });

    return result;
  }

  balance(userId) { return this.ledger.balance(userId); }
  list(userId) { return this.queue.list(userId).map(j => this.#publicJob(j)); }

  get(userId, id) {
    const job = this.queue.get(id);
    if (!job || job.user !== userId) return null;
    return this.#publicJob(job);
  }

  cancel(userId, id) {
    const job = this.queue.get(id);
    if (!job || job.user !== userId) return null;
    // A cancelled-while-queued job never ran, so its hold goes straight back.
    const wasQueued = job.status === 'queued';
    this.queue.cancel(id);
    if (wasQueued) {
      try { this.ledger.release(job.ref); } catch { /* already settled */ }
    }
    return this.#publicJob(job);
  }

  #publicJob(job) {
    const { kill, workspace, args, log, ...rest } = job;
    return { ...rest, log: log.slice(-20000) };
  }
}

module.exports = { Jobs };
