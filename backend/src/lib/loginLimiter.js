// Caps failed login attempts so a public backend can't be used to guess
// passwords. bcrypt at cost 12 already makes each guess slow, but nothing
// limited how many guesses one client could make.
//
// In-memory and per process: fine for the single backend instance this
// runs as today. Running several instances would need a shared store
// (e.g. Redis) or the limits multiply by the instance count.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_ACCOUNT = 5; // per (ip, username)
const MAX_FAILURES_PER_IP = 30; // across all usernames, stops spraying

const failures = new Map(); // key -> { count, resetAt }

function bump(key, now) {
  const entry = failures.get(key);

  if (!entry || entry.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  entry.count++;
}

function blockedFor(key, limit, now) {
  const entry = failures.get(key);

  if (!entry || entry.resetAt <= now || entry.count < limit)
    return 0;

  return entry.resetAt - now;
}

function keys(ip, username) {
  return { account: `acct:${ip}:${String(username).toLowerCase()}`, ip: `ip:${ip}` };
}

// Returns milliseconds until the caller may try again, or 0 if allowed.
function retryAfterMs(ip, username, now = Date.now()) {
  const k = keys(ip, username);

  return Math.max(blockedFor(k.account, MAX_FAILURES_PER_ACCOUNT, now), blockedFor(k.ip, MAX_FAILURES_PER_IP, now));
}

function recordFailure(ip, username, now = Date.now()) {
  const k = keys(ip, username);

  bump(k.account, now);
  bump(k.ip, now);
}

function recordSuccess(ip, username) {
  failures.delete(keys(ip, username).account);
}

// Expired entries would otherwise accumulate for every IP that ever failed.
setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of failures)
    if (entry.resetAt <= now) failures.delete(key);
}, WINDOW_MS).unref();

module.exports = { retryAfterMs, recordFailure, recordSuccess, MAX_FAILURES_PER_ACCOUNT, MAX_FAILURES_PER_IP };
