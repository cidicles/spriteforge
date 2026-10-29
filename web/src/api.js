// The server requires this header on any write authenticated by a cookie.
// A cross-site form post cannot set it, and a cross-origin XHR that tries
// triggers a preflight the server never answers — so this one line is the
// CSRF defence.
const CSRF = { 'X-Requested-With': 'spriteforge' };

// aislop.cloud serves each project under a path prefix (/spriteforge/) and
// strips it before forwarding, so the server only ever sees /api/… while the
// browser must ask for /spriteforge/api/…. Resolving against document.baseURI
// gets that right at the root and under a prefix, with nothing to configure.
const API = new URL('./api/', document.baseURI).href.replace(/\/$/, '');

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { ...CSRF, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error((json && json.error) || `Something went wrong (${res.status})`);
    err.status = res.status;
    if (json) Object.assign(err, { code: json.code, need: json.need, available: json.available });
    throw err;
  }
  return json;
}

export const api = {
  config: () => call('GET', '/config'),
  me: () => call('GET', '/me'),
  signup: (email, password) => call('POST', '/auth/signup', { email, password }),
  login: (email, password) => call('POST', '/auth/login', { email, password }),
  logout: () => call('POST', '/auth/logout'),
  changePassword: (current, password) => call('POST', '/auth/password', { current, password }),

  presets: () => call('GET', '/presets'),
  characters: () => call('GET', '/characters'),
  saveCharacter: character => call('POST', '/characters', character),

  quote: request => call('POST', '/quote', request),
  submit: request => call('POST', '/jobs', request),
  jobs: () => call('GET', '/jobs'),
  job: id => call('GET', `/jobs/${id}`),
  cancel: id => call('DELETE', `/jobs/${id}`),

  balance: () => call('GET', '/balance'),
  history: () => call('GET', '/history'),
  createKey: label => call('POST', '/keys', { label }),
  revokeKey: id => call('DELETE', `/keys/${id}`),

  // `inline` previews in an <img>; without it the browser downloads the file.
  download: (character, anim, ext, inline) =>
    `${API}/download/${character}/${anim}.${ext}${inline ? '?inline=1' : ''}`
};
