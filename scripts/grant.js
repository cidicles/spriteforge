#!/usr/bin/env node
// Add credits to an account.
//
//   ADMIN_TOKEN=... node scripts/grant.js dev@example.com 500 "launch promo"
//
// This deliberately goes over HTTP to the running server rather than opening
// the ledger file directly. The ledger derives balances from an in-memory
// replay, so a second process appending to the same file would leave the
// server serving stale balances until it restarted — and "stale" here means
// "a customer's credits are missing". One writer, always.

const [email, amount, ...note] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://127.0.0.1:' + (process.env.PORT || 5180);
const TOKEN = process.env.ADMIN_TOKEN;

if (!email || !amount) {
  console.error('usage: ADMIN_TOKEN=... node scripts/grant.js <email> <credits> [note]');
  process.exit(1);
}
if (!TOKEN) {
  console.error('ADMIN_TOKEN is not set. It must match the one the server was started with.');
  process.exit(1);
}

const credits = Number(amount);
if (!Number.isInteger(credits) || credits <= 0) {
  console.error(`"${amount}" is not a positive whole number of credits.`);
  process.exit(1);
}

fetch(`${BASE}/api/admin/grant`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
  body: JSON.stringify({ email, credits, meta: note.length ? { note: note.join(' ') } : {} })
})
  .then(async res => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`Failed (${res.status}): ${body.error || 'unknown error'}`);
      process.exit(1);
    }
    console.log(`${body.user}: ${body.balance.available} credits available (${body.balance.granted} granted all time)`);
  })
  .catch(e => {
    console.error(`Could not reach ${BASE}: ${e.message}`);
    console.error('Is the server running?');
    process.exit(1);
  });
