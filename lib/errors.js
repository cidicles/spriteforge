// Errors a customer caused.
//
// Everything else that reaches the top of a request is ours: it answers 500
// and its message is never echoed back. Keeping the two kinds apart is what
// stops a port scanner filling the error log with "[500] invalid animation
// name" — and stops a real fault hiding in that noise.

const invalid = message => Object.assign(new Error(message), { status: 400, code: 'INVALID' });

module.exports = { invalid };
