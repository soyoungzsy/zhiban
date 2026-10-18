import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export function accessAllowed(req, key) {
  if (!key) return true; // Startup separately refuses paid services without a key.
  const supplied = req.headers['x-zh-key'];
  if (typeof supplied !== 'string' || supplied.length > 1024) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(key));
}

// Forwarded headers are untrusted input. Shared proxies deliberately share a limit.
export const clientAddress = req => req.socket?.remoteAddress || 'unknown';

export function positiveLimit(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

// A durable, fail-closed daily cap, shared by workers using the same directory.
// Every provider attempt must reserve separately, before the network request.
export function reserveDaily(file, limit, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('usage-ledger-unavailable'); }
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const day = now.toISOString().slice(0, 10);
    let current = { day, used: 0 };
    if (fs.existsSync(file)) {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(current.day) || !Number.isSafeInteger(current.used) || current.used < 0) throw new Error('invalid-ledger');
      if (current.day > day) throw new Error('clock-moved-backwards');
      if (current.day < day) current = { day, used: 0 };
    }
    if (current.used >= limit) return false;
    const out = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(out, JSON.stringify({ day, used: current.used + 1 }));
      fs.fsyncSync(out);
    } finally { fs.closeSync(out); }
    fs.renameSync(temp, file);
    return true;
  } catch { throw new Error('usage-ledger-unavailable'); }
  finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.rmSync(lock, { force: true });
  }
}
