// Credit accounting.
//
// 1 credit = $0.01 of provider spend — the same unit generate-sprites.js
// prints, so a plan's "~39 credits" IS the charge. Credits are integers on
// purpose: money in floats is a bug waiting for a rounding boundary.
//
// Three phases, because a sprite's true cost is only known after the run:
//
//   reserve(ref, user, estimate)   holds credits, so two jobs queued at the
//                                  same time cannot both spend the same balance
//   settle(ref, actual)            the hold becomes a spend of `actual`; any
//                                  unspent remainder returns to available
//   release(ref)                   the hold is cancelled, nothing was spent
//
//   available = granted - spent - held
//
// A job may only start against `available`, never `granted`. That is what
// stops one customer queueing ten jobs against one job's worth of credits.
//
// `ref` is the job id, and a ref may be reserved exactly once. That makes
// every phase idempotent-by-rejection: a double settle throws instead of
// double-charging, which is the failure mode worth being loud about.

const { invalid } = require('./errors');

const POSITIVE_INT = n => Number.isInteger(n) && n > 0;

class Ledger {
  constructor(log) {
    this.log = log;
    this.accounts = new Map();   // user -> { granted, spent }
    this.holds = new Map();      // open ref -> { user, amount }
    this.closedRefs = new Set(); // settled or released
    for (const e of log.events) this.#apply(e);
  }

  // Replay and live writes go through the same function, so a restart can
  // never disagree with the process that wrote the events.
  #apply(e) {
    const acct = this.#account(e.user);
    switch (e.type) {
      case 'grant':
        acct.granted += e.amount;
        break;
      case 'reserve':
        this.holds.set(e.ref, { user: e.user, amount: e.amount });
        break;
      case 'settle':
        this.holds.delete(e.ref);
        this.closedRefs.add(e.ref);
        acct.spent += e.amount;
        break;
      case 'release':
        this.holds.delete(e.ref);
        this.closedRefs.add(e.ref);
        break;
      default:
        throw new Error(`Unknown ledger event type "${e.type}" at seq ${e.seq}`);
    }
  }

  #account(user) {
    if (!this.accounts.has(user)) this.accounts.set(user, { granted: 0, spent: 0 });
    return this.accounts.get(user);
  }

  #write(event) {
    const stored = this.log.append(event);
    this.#apply(stored);
    return stored;
  }

  balance(user) {
    const { granted, spent } = this.#account(user);
    let held = 0;
    for (const h of this.holds.values()) if (h.user === user) held += h.amount;
    return { granted, spent, held, available: granted - spent - held };
  }

  // Credits bought, comped or refunded. `meta` carries the why (a Stripe
  // payment id, a coupon, "launch promo") so support can answer for it later.
  grant(user, amount, meta = {}) {
    if (!POSITIVE_INT(amount)) throw invalid('grant amount must be a positive integer');
    return this.#write({ type: 'grant', user, amount, meta });
  }

  reserve(ref, user, amount) {
    if (!POSITIVE_INT(amount)) throw invalid('reserve amount must be a positive integer');
    if (this.holds.has(ref) || this.closedRefs.has(ref)) throw new Error(`ref "${ref}" has already been reserved`);
    const { available } = this.balance(user);
    if (amount > available) {
      const err = new Error(`Not enough credits: need ${amount}, have ${available}`);
      err.code = 'INSUFFICIENT_CREDITS';
      err.need = amount;
      err.available = available;
      throw err;
    }
    return this.#write({ type: 'reserve', user, ref, amount });
  }

  // `actual` may legitimately exceed the reservation — the provider was paid,
  // so the ledger records it even though that can push an account negative.
  // Pretending otherwise would hide real spend. reserve() refuses to start new
  // work while available is short, so a negative account cannot keep digging.
  settle(ref, actual) {
    const hold = this.holds.get(ref);
    if (!hold) {
      throw new Error(this.closedRefs.has(ref)
        ? `ref "${ref}" is already closed`
        : `ref "${ref}" has no open reservation`);
    }
    if (!Number.isInteger(actual) || actual < 0) throw invalid('settle amount must be a non-negative integer');
    return this.#write({ type: 'settle', user: hold.user, ref, amount: actual, meta: { reserved: hold.amount } });
  }

  release(ref) {
    const hold = this.holds.get(ref);
    if (!hold) {
      throw new Error(this.closedRefs.has(ref)
        ? `ref "${ref}" is already closed`
        : `ref "${ref}" has no open reservation`);
    }
    return this.#write({ type: 'release', user: hold.user, ref, amount: 0, meta: { reserved: hold.amount } });
  }

  // Every movement on one account, for a billing page or a support question.
  history(user) {
    return this.log.events.filter(e => e.user === user);
  }
}

module.exports = { Ledger };
