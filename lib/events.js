// Append-only event log, one JSON object per line.
//
// Credits are money, so nothing here is ever mutated: balances are derived by
// replaying events. That makes every number answerable — "why is my balance
// 318?" has a literal answer — and makes a bug recoverable, because the
// history survives the code that got it wrong.
//
// Durability is plain appendFileSync. A crash can lose the event being
// written but cannot corrupt the ones before it, since each line is complete
// before the next is appended. It is not fsync'd per write and not replicated:
// put the file on a snapshotted volume, and move to Postgres once there is
// enough revenue to be worth protecting properly.

const fs = require('fs');
const path = require('path');

class EventLog {
  constructor(file) {
    this.file = file;
    this.events = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) return;

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let event;
      try { event = JSON.parse(lines[i]); } catch {
        // Starting with a half-readable ledger would silently under-report
        // what customers are owed. Refuse, and make a human look.
        throw new Error(`${file}:${i + 1} is not valid JSON — refusing to start on a damaged ledger`);
      }
      this.events.push(event);
    }
  }

  append(event) {
    const stored = { seq: this.events.length + 1, ts: new Date().toISOString(), ...event };
    fs.appendFileSync(this.file, JSON.stringify(stored) + '\n');
    this.events.push(stored);
    return stored;
  }

  // Events of one type, newest last. Small volumes only — this is a scan.
  ofType(type) { return this.events.filter(e => e.type === type); }
}

module.exports = { EventLog };
