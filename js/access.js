// This optional family access password is entered by the user, never injected
// into HTML, persisted, or included in a URL. Provider keys stay on the server.
let key = '';
export function setAccessKey(value) {
  const next = typeof value === 'string' ? value.trim() : '';
  if (next && typeof location !== 'undefined' && location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('远程访问请先使用 HTTPS 安全网址，再填写口令。');
  key = next;
}
export function clearAccessKey() { key = ''; }
export function accessHeaders() { return key ? { 'x-zh-key': key } : {}; }
