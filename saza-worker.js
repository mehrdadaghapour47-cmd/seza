// Saza: core.js (generated; part of a multi-file Worker)


// ---- utils ----
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const now = () => Math.floor(Date.now() / 1000);
export const enc = new TextEncoder();

export async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function otpCode() {
  return String(10000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90000));
}
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
export function normDigits(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

export const BASE = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
export function ok(data, status = 200, extra = {}) {
  return new Response(JSON.stringify({ success: true, data }), { status, headers: { ...BASE, ...extra } });
}
export function fail(status, code, message, extra = {}) {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), { status, headers: { ...BASE, ...extra } });
}

export function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
export function sessionCookie(value, maxAge) {
  return `sid=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
export function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function readJson(req, max = 20000) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > max) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'حجم درخواست زیاد است.');
  const text = await req.text();
  if (text.length > max) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'حجم درخواست زیاد است.');
  try {
    const v = JSON.parse(text || '{}');
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad');
    return v;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'درخواست نامعتبر است.');
  }
}

// Fixed-window rate limiter backed by D1. Returns true if the call is allowed.
export async function hitRate(env, key, limit, windowSec) {
  const w = Math.floor(now() / windowSec) * windowSec;
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ' +
    'ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count'
  ).bind(key, w).first();
  if (Math.random() < 0.01) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now() - 86400).run();
  }
  return row.count <= limit;
}

// ---- config ----
// Central configuration. Change prices, credits and costs HERE only.

// Feature catalogue. `enabled: false` = not built yet; API answers 501 and the UI shows "coming soon".
export const FEATURES = {
  chat:  { label: 'چت‌بات',         cost: 1,  maxInput: 2000, enabled: true  },
  image: { label: 'ساخت تصویر',     cost: 3,  maxInput: 500,  enabled: true  },
  video: { label: 'ساخت ویدئو',     cost: 10, maxInput: 500,  enabled: false },
  music: { label: 'ساخت موزیک',     cost: 5,  maxInput: 500,  enabled: false },
  edit:  { label: 'ویرایش هوشمند',  cost: 2,  maxInput: 500,  enabled: false },
};

// Paid plans (prices in Toman). Free plan credits come from env FREE_CREDITS.
export const PAID_PLANS = {
  basic: { name: 'پایه',    price_toman: 99000,  credits: 150 },
  pro:   { name: 'حرفه‌ای', price_toman: 249000, credits: 500 },
};

export function getPlans(env) {
  const free = Number.parseInt(env.FREE_CREDITS ?? '10', 10);
  return {
    free: { id: 'free', name: 'رایگان', price_toman: 0, credits: Number.isFinite(free) && free >= 0 ? free : 10 },
    ...Object.fromEntries(Object.entries(PAID_PLANS).map(([id, p]) => [id, { id, ...p }])),
  };
}

export function limits(env) {
  const n = (v, d) => { const x = Number.parseInt(v ?? '', 10); return Number.isFinite(x) && x > 0 ? x : d; };
  return {
    aiPerMinute: n(env.RATE_AI_PER_MIN, 6),   // AI requests per user per minute
    otpPerIp: 10,                              // OTP sends per IP per 10 minutes
    otpPerPhone: 3,                            // OTP sends per phone per 10 minutes
    aiTimeoutMs: n(env.AI_TIMEOUT_MS, 60000),
    sessionDays: 30,
  };
}

// ---- sms ----
// SMS adapter (Kavenegar verify/lookup). Needs KAVENEGAR_KEY + OTP_TEMPLATE.
export function smsConfigured(env) {
  return Boolean(env.KAVENEGAR_KEY && env.OTP_TEMPLATE);
}
export async function sendOtpSms(env, phone, code) {
  const url = `https://api.kavenegar.com/v1/${env.KAVENEGAR_KEY}/verify/lookup.json` +
    `?receptor=${encodeURIComponent(phone)}&token=${encodeURIComponent(code)}&template=${encodeURIComponent(env.OTP_TEMPLATE)}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// ---- ai ----
// AI provider layer. Frontend never sees keys; swap provider with AI_PROVIDER.
//   AI_PROVIDER=workers-ai (default)  -> Cloudflare Workers AI via the `AI` binding (no API key needed)
//   AI_PROVIDER=openai                -> any OpenAI-compatible API: AI_BASE_URL + AI_API_KEY
// Models: AI_TEXT_MODEL, AI_IMAGE_MODEL (defaults below).

export const DEFAULT_TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const NOT_CONFIGURED = () => new ApiError(503, 'AI_NOT_CONFIGURED', 'سرویس هوش مصنوعی هنوز راه‌اندازی نشده.');

export function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new ApiError(504, 'AI_TIMEOUT', 'پاسخ از هوش مصنوعی دیر رسید. دوباره امتحان کن.')), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export function mapProviderError(e) {
  if (e instanceof ApiError) return e;
  const status = e && (e.status || e.statusCode);
  const msg = String((e && e.message) || e || '');
  console.error('AI provider error:', status || '', msg.slice(0, 300));
  if (status === 429 || /rate.?limit|too many requests|capacity/i.test(msg)) {
    return new ApiError(429, 'AI_RATE_LIMIT', 'سرویس هوش مصنوعی الان شلوغه. چند لحظه بعد دوباره امتحان کن.');
  }
  if (/\b(401|403)\b|api.?key|unauthorized|permission|not authorized/i.test(msg) || status === 401 || status === 403) {
    return new ApiError(503, 'AI_NOT_CONFIGURED', 'سرویس هوش مصنوعی هنوز راه‌اندازی نشده.');
  }
  return new ApiError(502, 'AI_PROVIDER_ERROR', 'سرویس هوش مصنوعی در دسترس نیست. کمی بعد دوباره امتحان کن.');
}

export function extractText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  if (typeof r.response === 'string') return r.response;
  if (r.result && typeof r.result.response === 'string') return r.result.response;
  const c = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  if (typeof c === 'string') return c;
  if (typeof r.output_text === 'string') return r.output_text;
  return '';
}

export function sniffMime(b64) {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}
export function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- providers ----------
export async function openaiFetch(env, path, payload, ms) {
  if (!env.AI_API_KEY || !env.AI_BASE_URL) throw NOT_CONFIGURED();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(env.AI_BASE_URL.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!r.ok) { const err = new Error(`provider http ${r.status}`); err.status = r.status; throw err; }
    return await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError(504, 'AI_TIMEOUT', 'پاسخ از هوش مصنوعی دیر رسید. دوباره امتحان کن.');
    throw e;
  } finally { clearTimeout(t); }
}

export async function runText(env, messages, ms) {
  const provider = env.AI_PROVIDER || 'workers-ai';
  const model = env.AI_TEXT_MODEL || DEFAULT_TEXT_MODEL;
  let raw;
  if (provider === 'workers-ai') {
    if (!env.AI) throw NOT_CONFIGURED();
    raw = await withTimeout(env.AI.run(model, { messages, max_tokens: 1024 }), ms);
  } else if (provider === 'openai') {
    raw = await openaiFetch(env, '/chat/completions', { model: env.AI_TEXT_MODEL, messages, max_tokens: 1024 }, ms);
  } else {
    throw NOT_CONFIGURED();
  }
  const text = extractText(raw).trim();
  if (!text) throw new ApiError(502, 'AI_EMPTY_RESPONSE', 'هوش مصنوعی پاسخی نداد. دوباره امتحان کن.');
  return text;
}

export async function runImage(env, prompt, ms) {
  const provider = env.AI_PROVIDER || 'workers-ai';
  let b64 = '';
  if (provider === 'workers-ai') {
    if (!env.AI) throw NOT_CONFIGURED();
    const raw = await withTimeout(env.AI.run(env.AI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL, { prompt: prompt.slice(0, 2000) }), ms);
    if (raw && typeof raw.image === 'string') b64 = raw.image;
    else if (raw instanceof ReadableStream) b64 = bytesToB64(await new Response(raw).arrayBuffer());
    else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) b64 = bytesToB64(raw.buffer || raw);
  } else if (provider === 'openai') {
    const raw = await openaiFetch(env, '/images/generations', {
      model: env.AI_IMAGE_MODEL, prompt: prompt.slice(0, 2000), n: 1, response_format: 'b64_json',
    }, ms);
    b64 = (raw && raw.data && raw.data[0] && raw.data[0].b64_json) || '';
  } else {
    throw NOT_CONFIGURED();
  }
  if (typeof b64 !== 'string' || b64.length < 200 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
    throw new ApiError(502, 'AI_INVALID_RESPONSE', 'خروجی نامعتبر از هوش مصنوعی گرفتیم. دوباره امتحان کن.');
  }
  return { base64: b64.replace(/\s/g, ''), mime: sniffMime(b64) };
}

// ---------- public API ----------
export const CHAT_SYSTEM = 'You are a helpful assistant inside a Persian-language app. Reply in the same language as the user (default Persian), clearly and concisely.';

export async function runChat(env, input, ms) {
  const text = await runText(env, [{ role: 'system', content: CHAT_SYSTEM }, { role: 'user', content: input }], ms);
  return { kind: 'text', text };
}

export async function runImageGeneration(env, input, ms) {
  let prompt = input;
  if (/[\u0600-\u06FF]/.test(input)) {
    // Image models follow English best: translate/expand Persian ideas first. Falls back to the raw text if that step fails.
    try {
      prompt = (await runText(env, [
        { role: 'system', content: 'Turn the user idea into ONE detailed English image-generation prompt (max 60 words). Output only the prompt.' },
        { role: 'user', content: input },
      ], Math.min(ms, 20000))).slice(0, 1500);
    } catch { prompt = input; }
  }
  const img = await runImage(env, prompt, ms);
  return { kind: 'image', ...img, prompt };
}
// Saza: user.js (generated; part of a multi-file Worker)
import { ApiError, now, sha256, randomHex, otpCode, normDigits, ok, getCookie, sessionCookie, clientIp, readJson, hitRate, FEATURES, getPlans, limits, smsConfigured, sendOtpSms, mapProviderError, runChat, runImageGeneration } from './core.js';

// ---- auth ----

export const PHONE_RE = /^09\d{9}$/;

export function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name || null, plan: u.plan, credits: u.credits, created_at: u.created_at };
}

// ---------- OTP: send ----------
export async function sendOtp(req, env) {
  const body = await readJson(req);
  const phone = normDigits(body.phone).trim();
  if (!PHONE_RE.test(phone)) throw new ApiError(400, 'INVALID_PHONE', 'شماره موبایل معتبر نیست.');
  const L = limits(env);

  if (!(await hitRate(env, `otp-ip:${clientIp(req)}`, L.otpPerIp, 600))) {
    throw new ApiError(429, 'RATE_LIMITED', 'تعداد درخواست‌ها زیاد بود. چند دقیقه بعد دوباره امتحان کن.');
  }
  const recent = await env.DB.prepare('SELECT COUNT(*) AS c FROM otp_codes WHERE phone = ? AND created_at > ?')
    .bind(phone, now() - 600).first();
  if (recent.c >= L.otpPerPhone) {
    throw new ApiError(429, 'RATE_LIMITED', 'تعداد درخواست‌ها زیاد بود. چند دقیقه بعد دوباره امتحان کن.');
  }

  const sms = smsConfigured(env);
  const dev = env.DEV_MODE === '1';
  if (!sms && !dev) throw new ApiError(503, 'SMS_NOT_CONFIGURED', 'سرویس پیامک هنوز فعال نشده.');

  const code = otpCode();
  const hash = await sha256(`${code}:${phone}:${env.SESSION_SECRET || ''}`);
  await env.DB.prepare('INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES (?, ?, ?)')
    .bind(phone, hash, now() + 120).run();

  if (sms) {
    const sent = await sendOtpSms(env, phone, code);
    if (!sent) throw new ApiError(502, 'SMS_FAILED', 'ارسال پیامک انجام نشد. کمی بعد دوباره امتحان کن.');
    return ok({ sent: true, expires_in: 120 });
  }
  // DEV_MODE only: returns the code in the response so you can test without an SMS account.
  return ok({ sent: true, expires_in: 120, dev_code: code });
}

// ---------- OTP: verify (register-or-login) ----------
export async function verifyOtp(req, env) {
  const body = await readJson(req);
  const phone = normDigits(body.phone).trim();
  const code = normDigits(body.code).trim();
  if (!PHONE_RE.test(phone) || !/^\d{5}$/.test(code)) {
    throw new ApiError(400, 'INVALID_INPUT', 'اطلاعات واردشده معتبر نیست.');
  }
  const L = limits(env);

  const row = await env.DB.prepare(
    'SELECT id, code_hash, attempts FROM otp_codes WHERE phone = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1'
  ).bind(phone, now()).first();
  if (!row) throw new ApiError(400, 'CODE_EXPIRED', 'کد منقضی شده. کد جدید بگیر.');
  if (row.attempts >= 5) throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'تعداد تلاش‌ها زیاد بود. کد جدید بگیر.');

  await env.DB.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
  const hash = await sha256(`${code}:${phone}:${env.SESSION_SECRET || ''}`);
  if (hash !== row.code_hash) throw new ApiError(400, 'WRONG_CODE', 'کد اشتباهه.');

  // consume the code atomically (a code can only be used once)
  const used = await env.DB.prepare('UPDATE otp_codes SET used = 1 WHERE id = ? AND used = 0').bind(row.id).run();
  if (used.meta.changes !== 1) throw new ApiError(400, 'CODE_EXPIRED', 'کد منقضی شده. کد جدید بگیر.');

  const free = getPlans(env).free.credits;
  const ts = now();
  const ins = await env.DB.prepare(
    "INSERT INTO users (phone, credits, plan, created_at, updated_at) VALUES (?, ?, 'free', ?, ?) ON CONFLICT(phone) DO NOTHING"
  ).bind(phone, free, ts, ts).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  const isNew = ins.meta.changes === 1;
  if (isNew && free > 0) {
    await env.DB.prepare('INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)')
      .bind(user.id, free, 'signup_bonus').run();
  }
  if (user.is_blocked) throw new ApiError(403, 'ACCOUNT_BLOCKED', 'این حساب مسدود شده است.');

  const token = randomHex(32);
  const maxAge = 60 * 60 * 24 * L.sessionDays;
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), user.id, ts + maxAge).run();

  return ok({ is_new: isNew, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, maxAge) });
}

// ---------- session helpers ----------
export async function getUser(req, env) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const u = await env.DB.prepare(
    'SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?'
  ).bind(await sha256(token), now()).first();
  return u || null;
}
export async function requireUser(req, env) {
  const u = await getUser(req, env);
  if (!u) throw new ApiError(401, 'UNAUTHENTICATED', 'برای ادامه وارد شو.');
  if (u.is_blocked) throw new ApiError(403, 'ACCOUNT_BLOCKED', 'این حساب مسدود شده است.');
  return u;
}

export async function logout(req, env) {
  const token = getCookie(req, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return ok({ logged_out: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

export async function updateProfile(req, env, user) {
  const body = await readJson(req);
  const name = String(body.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim();
  if (name.length < 1 || name.length > 40) throw new ApiError(400, 'INVALID_NAME', 'اسم باید بین ۱ تا ۴۰ حرف باشه.');
  await env.DB.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').bind(name, now(), user.id).run();
  return ok({ user: publicUser({ ...user, name }) });
}

// ---- generate ----

// POST /api/ai/generate  { type, input }
export async function generate(req, env, user) {
  const body = await readJson(req);
  const type = String(body.type ?? '');
  const input = String(body.input ?? '').replace(/\u0000/g, '').trim();
  const feat = Object.prototype.hasOwnProperty.call(FEATURES, type) ? FEATURES[type] : null;

  if (!feat) throw new ApiError(400, 'INVALID_TYPE', 'نوع درخواست معتبر نیست.');
  if (!feat.enabled) throw new ApiError(501, 'FEATURE_UNAVAILABLE', 'این ابزار هنوز آماده نشده و به‌زودی اضافه می‌شود.');
  if (!input) throw new ApiError(400, 'EMPTY_INPUT', 'اول توضیح چیزی که می‌خوای رو بنویس.');
  if (input.length > feat.maxInput) {
    throw new ApiError(400, 'INPUT_TOO_LONG', `متن حداکثر ${feat.maxInput} حرف می‌تونه باشه.`);
  }

  const L = limits(env);
  if (!(await hitRate(env, `ai:${user.id}`, L.aiPerMinute, 60))) {
    throw new ApiError(429, 'RATE_LIMITED', 'درخواست‌هات خیلی سریع بود. یه دقیقه صبر کن.');
  }

  // Reserve credits atomically BEFORE calling the provider (prevents overspending with parallel requests).
  const cost = feat.cost;
  const ts = now();
  const reserve = await env.DB.prepare(
    'UPDATE users SET credits = credits - ?, updated_at = ? WHERE id = ? AND credits >= ?'
  ).bind(cost, ts, user.id, cost).run();
  if (reserve.meta.changes !== 1) {
    throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'اعتبار شما تمام شده است.');
  }

  const refund = async (code) => {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET credits = credits + ?, updated_at = ? WHERE id = ?').bind(cost, now(), user.id),
      env.DB.prepare('INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').bind(user.id, cost, `refund:${type}`),
      env.DB.prepare('INSERT INTO ai_usage (user_id, request_type, credits_used, status, error_code) VALUES (?, ?, 0, ?, ?)')
        .bind(user.id, type, 'failed', code),
    ]);
  };

  let result;
  try {
    result = type === 'image'
      ? await runImageGeneration(env, input, L.aiTimeoutMs)
      : await runChat(env, input, L.aiTimeoutMs);
  } catch (e) {
    const err = mapProviderError(e);
    try { await refund(err.code); } catch (e2) { console.error('refund failed', e2 && e2.message); }
    throw err;
  }

  const id = randomHex(12);
  const fileId = result.kind === 'image' ? randomHex(16) : null;
  try {
    const stmts = [];
    if (fileId) {
      stmts.push(env.DB.prepare('INSERT INTO files (id, user_id, mime, data) VALUES (?, ?, ?, ?)').bind(fileId, user.id, result.mime, result.base64));
    }
    stmts.push(
      env.DB.prepare('INSERT INTO generations (id, user_id, type, input, output, file_id, credits_used) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, user.id, type, input, result.kind === 'text' ? result.text : null, fileId, cost),
      env.DB.prepare('INSERT INTO ai_usage (user_id, request_type, credits_used, status) VALUES (?, ?, ?, ?)').bind(user.id, type, cost, 'success'),
      env.DB.prepare('INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').bind(user.id, -cost, `ai:${type}`),
    );
    await env.DB.batch(stmts);
  } catch (e) {
    console.error('save generation failed', e && e.message);
    try { await refund('SAVE_FAILED'); } catch {}
    throw new ApiError(500, 'SERVER_ERROR', 'ذخیره نتیجه انجام نشد. اعتبارت برگشت داده شد؛ دوباره امتحان کن.');
  }

  const left = await env.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  return ok({
    id, type, input,
    output: result.kind === 'text' ? result.text : null,
    file_url: fileId ? `/api/files/${fileId}` : null,
    credits_used: cost,
    credits_left: left.credits,
    created_at: ts,
  });
}

// GET /api/history
export async function history(req, env, user) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 50);
  const before = parseInt(url.searchParams.get('before') || '0', 10) || 0;
  const q = before
    ? env.DB.prepare('SELECT id, type, input, output, file_id, credits_used, created_at FROM generations WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?').bind(user.id, before, limit)
    : env.DB.prepare('SELECT id, type, input, output, file_id, credits_used, created_at FROM generations WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').bind(user.id, limit);
  const rows = (await q.all()).results || [];
  return ok({
    items: rows.map(r => ({
      id: r.id, type: r.type, input: r.input, output: r.output,
      file_url: r.file_id ? `/api/files/${r.file_id}` : null,
      credits_used: r.credits_used, created_at: r.created_at,
    })),
  });
}

// GET /api/usage
export async function usage(req, env, user) {
  const s = await env.DB.prepare(
    "SELECT COUNT(*) AS requests, COALESCE(SUM(credits_used),0) AS credits_used FROM ai_usage WHERE user_id = ? AND status = 'success'"
  ).bind(user.id).first();
  const month = await env.DB.prepare(
    "SELECT COUNT(*) AS requests FROM ai_usage WHERE user_id = ? AND status = 'success' AND created_at > ?"
  ).bind(user.id, now() - 30 * 86400).first();
  const fresh = await env.DB.prepare('SELECT credits, plan FROM users WHERE id = ?').bind(user.id).first();
  return ok({
    plan: fresh.plan, credits: fresh.credits,
    total_requests: s.requests, total_credits_used: s.credits_used, requests_last_30_days: month.requests,
  });
}

// GET /api/files/:id  (owner only)
export async function getFile(req, env, user, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new ApiError(404, 'NOT_FOUND', 'پیدا نشد.');
  const f = await env.DB.prepare('SELECT mime, data FROM files WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if (!f) throw new ApiError(404, 'NOT_FOUND', 'پیدا نشد.');
  const bin = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
  return new Response(bin, {
    headers: {
      'Content-Type': f.mime,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}
// Saza index.html part 1/2 (gzip + base64)
export const INDEX_1 = [
    "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",
];
// Saza static site part 2 (gzip + base64)
export const EMBEDDED_B = {
  "/admin.html": { type: "text/html; charset=utf-8", gz: true, data: [
    "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",
  ].join("") },
  "/sw.js": { type: "application/javascript; charset=utf-8", gz: true, data: [
    "H4sIAAAAAAACA4VTy27bMBC8+yu2J5FATB16q+ACRmA0BXwImgY5FD0w1MoiRJEqSct1E/97l5QcJC2SGDYk7gxnZx8uS7hBP2qFcHC+Q/8J5D",
    "BAaNGYHAngmsZoi0sdWgHr66+gpDEBpK3BxRY9OK932lLEHOQxwM5BpG+LYDEmCbFQzoYIl+vLqw2soAjyj1zmFMvxY1HN8M3VZrsl+EdRFhdQ",
    "lNrW+Fu0sTf52EurGwxRHPD+/D7x6LoI4674WS0WAU0jZF1vRrRxq0NEi54VZC+Sa+IjrD7DwwIAxUHqeGujNkxJ1WIQbkDLsksuyL9lKpFV0l",
    "sbw7JBPkOMJyynC50e7khL2x3jnFeLE/1eMSJV1KOM+JoTOgLMdjo8BjanS++Jf+1drwMKKibHRKNNJOEugR18WK1gLqCXwxSd1Wo0GJF15JDn",
    "LAD/VaKMJreBnlL3LPPeLqfBqNrntUyj9PiLBomCnnsaU/UE7L0hwOIBbr9tGcGCIjzhuoF87jG2rs6FFF823wt4fEy3xLRkOW6cklHT0KcYp3",
    "Rx7+1ZJbEHGVsrexQ0dh/DnY4tK0o56LLgZ8UzB1YpVynrXttp3Z4UqUdlSXZH2vLcxrz/zkMm59F5DIOzdc6Q25pbkkqZJ0eEc3PSZ6qTdq3j",
    "8DB3RbnhSG1JYWWcRcYreGclh31MOS7yXdo5OM36k/OkVeXIiQvqFjmaxjzL9vIfkwnzqTMvCC/+hPz5PvwFnJy7sDgEAAA=",
  ].join("") },
  "/manifest.webmanifest": { type: "application/manifest+json; charset=utf-8", gz: true, data: [
    "H4sIAAAAAAACA71Py07DMBC89yuscKSiucKvIFRtEpNadezIdhCh6hHIId9BoAcQBQ78yYb8DH6ktAe4Ilkrz8zO7uxqQkjEsuiMRLNo6oCAgj",
    "qIb9jhFrvA6oVUZv67llGdKlYaJsWP+Iwbghv86JuhxVdsif+84EPfEPdu+wa3Q/v1RPARO9LfW/xuaeu4s9/PoQ2zOYjcDb2EcRdTDirDx1wG",
    "bK5K8YMLdCpLeoAzpksOtWNsu8iAS0GDJBWjwsAuemmPVMBMEBNIl7mSlcjmqeTSLz6KIU7i09BgFrSgf2gslUJb9twCQla+umwq9cmcfKKvct",
    "8cFHZDnSECUe9ZU4dTWAE5nVnD8XXB93JZqVJqurN5ej39r5UF6CUknI57bb2YrCffmToRRFMCAAA=",
  ].join("") },
  "/icon.svg": { type: "image/svg+xml", gz: true, data: [
    "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",
  ].join("") },
};
// Saza index.html part 2/2 (gzip + base64)
export const INDEX_2 = [
    "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",
    "/9P4UXn9tzpQAA",
];
// Saza: saza-worker.js (generated; part of a multi-file Worker)
import { ApiError, now, safeEqual, ok, fail, clientIp, readJson, hitRate, FEATURES, PAID_PLANS, getPlans } from './core.js';
import { publicUser, sendOtp, verifyOtp, getUser, requireUser, logout, updateProfile, generate, history, usage, getFile } from './user.js';
import { INDEX_1 } from './site-a.js';
import { INDEX_2 } from './site-c.js';
import { EMBEDDED_B } from './site-b.js';

// ---- payment/zarinpal ----
// Zarinpal v4 adapter. Needs ZARINPAL_MERCHANT_ID (set ZARINPAL_SANDBOX=1 for sandbox).
// Amounts: we store Toman, Zarinpal expects Rial (x10).

export function zpHosts(env) {
  return env.ZARINPAL_SANDBOX === '1'
    ? { api: 'https://sandbox.zarinpal.com/pg/v4/payment', pay: 'https://sandbox.zarinpal.com/pg/StartPay' }
    : { api: 'https://payment.zarinpal.com/pg/v4/payment', pay: 'https://payment.zarinpal.com/pg/StartPay' };
}
export function paymentConfigured(env) {
  return Boolean(env.ZARINPAL_MERCHANT_ID);
}

export async function zpCall(env, path, payload) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`${zpHosts(env).api}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ merchant_id: env.ZARINPAL_MERCHANT_ID, ...payload }),
      signal: ctl.signal,
    });
    return await r.json();
  } catch (e) {
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'اتصال به درگاه پرداخت برقرار نشد. دوباره امتحان کن.');
  } finally { clearTimeout(t); }
}

export async function createPayment(env, { amountToman, description, callbackUrl, mobile }) {
  if (!paymentConfigured(env)) throw new ApiError(503, 'PAYMENT_NOT_CONFIGURED', 'پرداخت هنوز فعال نشده.');
  const res = await zpCall(env, 'request.json', {
    amount: amountToman * 10,
    callback_url: callbackUrl,
    description,
    metadata: { mobile },
  });
  const data = res && res.data;
  if (!data || data.code !== 100 || !data.authority) {
    console.error('zarinpal request failed', JSON.stringify(res && res.errors || res).slice(0, 300));
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'ساخت پرداخت انجام نشد. کمی بعد دوباره امتحان کن.');
  }
  return { authority: data.authority, url: `${zpHosts(env).pay}/${data.authority}` };
}

// Returns { ok, refId } — ok only for code 100 (first verify) or 101 (already verified).
export async function verifyPayment(env, { authority, amountToman }) {
  if (!paymentConfigured(env)) throw new ApiError(503, 'PAYMENT_NOT_CONFIGURED', 'پرداخت هنوز فعال نشده.');
  const res = await zpCall(env, 'verify.json', { amount: amountToman * 10, authority });
  const data = res && res.data;
  if (data && (data.code === 100 || data.code === 101)) return { ok: true, refId: String(data.ref_id ?? '') };
  return { ok: false, refId: null };
}

// ---- payment ----

// POST /api/payment/create { plan }
export async function payCreate(req, env, user) {
  const body = await readJson(req);
  const plan = String(body.plan ?? '');
  if (!Object.prototype.hasOwnProperty.call(PAID_PLANS, plan)) throw new ApiError(400, 'INVALID_PLAN', 'پلن معتبر نیست.');
  if (!(await hitRate(env, `pay:${user.id}`, 5, 600))) throw new ApiError(429, 'RATE_LIMITED', 'درخواست‌ها زیاد بود. چند دقیقه بعد امتحان کن.');
  const p = PAID_PLANS[plan];
  const callbackUrl = new URL('/api/payment/callback', req.url).toString();
  const pay = await createPayment(env, {
    amountToman: p.price_toman, description: `خرید پلن ${p.name}`, callbackUrl, mobile: user.phone,
  });
  await env.DB.prepare(
    "INSERT INTO payments (user_id, plan, amount_toman, credits, authority, status) VALUES (?, ?, ?, ?, ?, 'pending')"
  ).bind(user.id, plan, p.price_toman, p.credits, pay.authority).run();
  return ok({ payment_url: pay.url });
}

// Verifies with the gateway and credits the user exactly once (idempotent, atomic).
export async function verifyAndCredit(env, authority, onlyUserId = null) {
  const pay = await env.DB.prepare('SELECT * FROM payments WHERE authority = ?').bind(authority).first();
  if (!pay || (onlyUserId !== null && pay.user_id !== onlyUserId)) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'پرداخت پیدا نشد.');
  if (pay.credited === 1) return { status: 'paid', plan: pay.plan, credits: pay.credits, ref_id: pay.ref_id };

  const v = await verifyPayment(env, { authority, amountToman: pay.amount_toman });
  if (!v.ok) {
    await env.DB.prepare("UPDATE payments SET status = 'failed' WHERE authority = ? AND credited = 0").bind(authority).run();
    return { status: 'failed', plan: pay.plan, credits: 0, ref_id: null };
  }
  const ts = now();
  // One transaction: credit the user only if this payment hasn't been credited yet.
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET credits = credits + ?, plan = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM payments WHERE authority = ? AND credited = 0)'
    ).bind(pay.credits, pay.plan, ts, pay.user_id, authority),
    env.DB.prepare(
      'INSERT INTO credit_ledger (user_id, delta, reason) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM payments WHERE authority = ? AND credited = 0)'
    ).bind(pay.user_id, pay.credits, `payment:${pay.plan}`, authority),
    env.DB.prepare(
      "UPDATE payments SET status = 'paid', credited = 1, ref_id = ?, verified_at = ? WHERE authority = ? AND credited = 0"
    ).bind(v.refId, ts, authority),
  ]);
  return { status: 'paid', plan: pay.plan, credits: pay.credits, ref_id: v.refId };
}

// POST /api/payment/verify { authority }  (owner only)
export async function payVerify(req, env, user) {
  const body = await readJson(req);
  const authority = String(body.authority ?? '');
  if (!/^[A-Za-z0-9]{10,64}$/.test(authority)) throw new ApiError(400, 'INVALID_INPUT', 'اطلاعات پرداخت معتبر نیست.');
  return ok(await verifyAndCredit(env, authority, user.id));
}

// GET /api/payment/callback?Authority=...&Status=OK  (gateway redirect; browser lands here)
export async function payCallback(req, env) {
  const u = new URL(req.url);
  const authority = u.searchParams.get('Authority') || '';
  const status = u.searchParams.get('Status') || '';
  let dest = '/?pay=failed';
  try {
    if (/^[A-Za-z0-9]{10,64}$/.test(authority)) {
      if (status === 'OK') {
        const r = await verifyAndCredit(env, authority);
        dest = r.status === 'paid' ? '/?pay=ok' : '/?pay=failed';
      } else {
        await env.DB.prepare("UPDATE payments SET status = 'canceled' WHERE authority = ? AND credited = 0").bind(authority).run();
        dest = '/?pay=canceled';
      }
    }
  } catch (e) {
    console.error('payment callback error', e && e.message);
    dest = '/?pay=error';
  }
  return new Response(null, { status: 302, headers: { Location: dest, 'Cache-Control': 'no-store' } });
}

// ---- admin ----
// Admin API. Auth: header `X-Admin-Secret` must equal env ADMIN_SECRET (never hardcoded).

export async function requireAdmin(req, env) {
  if (!env.ADMIN_SECRET) throw new ApiError(503, 'ADMIN_NOT_CONFIGURED', 'پنل ادمین فعال نشده.');
  if (!(await hitRate(env, `admin-ip:${clientIp(req)}`, 30, 600))) throw new ApiError(429, 'RATE_LIMITED', 'تعداد تلاش‌ها زیاد بود.');
  const given = req.headers.get('X-Admin-Secret') || '';
  if (!given || !(await safeEqual(given, env.ADMIN_SECRET))) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', 'دسترسی مجاز نیست.');
}

export async function adminRoute(req, env, path) {
  await requireAdmin(req, env);
  const url = new URL(req.url);

  if (path === '/api/admin/users' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').replace(/[^0-9]/g, '').slice(0, 11);
    const rows = q
      ? (await env.DB.prepare('SELECT id, phone, name, plan, credits, is_blocked, created_at FROM users WHERE phone LIKE ? ORDER BY id DESC LIMIT 100').bind(`%${q}%`).all()).results
      : (await env.DB.prepare('SELECT id, phone, name, plan, credits, is_blocked, created_at FROM users ORDER BY id DESC LIMIT 100').all()).results;
    return ok({ users: rows });
  }

  if (path === '/api/admin/usage' && req.method === 'GET') {
    const rows = (await env.DB.prepare(
      'SELECT ai_usage.id, ai_usage.user_id, users.phone, ai_usage.request_type, ai_usage.credits_used, ai_usage.status, ai_usage.error_code, ai_usage.created_at ' +
      'FROM ai_usage JOIN users ON users.id = ai_usage.user_id ORDER BY ai_usage.id DESC LIMIT 100'
    ).all()).results;
    const totals = await env.DB.prepare(
      "SELECT COUNT(*) AS requests, COALESCE(SUM(credits_used),0) AS credits FROM ai_usage WHERE status = 'success'"
    ).first();
    return ok({ usage: rows, totals });
  }

  if (path === '/api/admin/payments' && req.method === 'GET') {
    const rows = (await env.DB.prepare(
      'SELECT payments.id, payments.user_id, users.phone, payments.plan, payments.amount_toman, payments.credits, payments.status, payments.ref_id, payments.created_at ' +
      'FROM payments JOIN users ON users.id = payments.user_id ORDER BY payments.id DESC LIMIT 100'
    ).all()).results;
    const totals = await env.DB.prepare("SELECT COALESCE(SUM(amount_toman),0) AS revenue_toman, COUNT(*) AS count FROM payments WHERE status = 'paid'").first();
    return ok({ payments: rows, totals });
  }

  const m = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (m && req.method === 'POST') {
    const id = Number(m[1]);
    const body = await readJson(req);
    const user = await env.DB.prepare('SELECT id, plan, credits FROM users WHERE id = ?').bind(id).first();
    if (!user) throw new ApiError(404, 'NOT_FOUND', 'کاربر پیدا نشد.');
    const stmts = [];
    const ts = now();

    if (body.plan !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(getPlans(env), String(body.plan))) throw new ApiError(400, 'INVALID_PLAN', 'پلن معتبر نیست.');
      stmts.push(env.DB.prepare('UPDATE users SET plan = ?, updated_at = ? WHERE id = ?').bind(String(body.plan), ts, id));
    }
    if (body.credits_delta !== undefined) {
      const d = Number(body.credits_delta);
      if (!Number.isInteger(d) || Math.abs(d) > 100000) throw new ApiError(400, 'INVALID_INPUT', 'مقدار اعتبار معتبر نیست.');
      stmts.push(
        env.DB.prepare('UPDATE users SET credits = MAX(0, credits + ?), updated_at = ? WHERE id = ?').bind(d, ts, id),
        env.DB.prepare('INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').bind(id, d, 'admin_adjust'),
      );
    }
    if (body.credits_set !== undefined) {
      const c = Number(body.credits_set);
      if (!Number.isInteger(c) || c < 0 || c > 1000000) throw new ApiError(400, 'INVALID_INPUT', 'مقدار اعتبار معتبر نیست.');
      stmts.push(
        env.DB.prepare('UPDATE users SET credits = ?, updated_at = ? WHERE id = ?').bind(c, ts, id),
        env.DB.prepare('INSERT INTO credit_ledger (user_id, delta, reason) VALUES (?, ?, ?)').bind(id, c - user.credits, 'admin_set'),
      );
    }
    if (body.blocked !== undefined) {
      stmts.push(env.DB.prepare('UPDATE users SET is_blocked = ?, updated_at = ? WHERE id = ?').bind(body.blocked ? 1 : 0, ts, id));
      if (body.blocked) stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
    }
    if (!stmts.length) throw new ApiError(400, 'INVALID_INPUT', 'تغییری ارسال نشده.');
    await env.DB.batch(stmts);
    const fresh = await env.DB.prepare('SELECT id, phone, name, plan, credits, is_blocked FROM users WHERE id = ?').bind(id).first();
    return ok({ user: fresh });
  }

  throw new ApiError(404, 'NOT_FOUND', 'پیدا نشد.');
}

// ---- index ----

export function sameOriginOrThrow(req) {
  // CSRF defence for cookie-authenticated writes: browsers always send Origin on cross-site POST.
  const origin = req.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(req.url).host) {
    throw new ApiError(403, 'BAD_ORIGIN', 'درخواست نامعتبر است.');
  }
}

export async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const write = m === 'POST' || m === 'PATCH' || m === 'DELETE';

  if (path.startsWith('/api/admin/')) return adminRoute(req, env, path);   // secret-header auth, no cookies
  if (write) sameOriginOrThrow(req);

  // ---- public ----
  if (path === '/api/plans' && m === 'GET') {
    const plans = getPlans(env);
    const user = await getUser(req, env);
    return ok({
      plans: Object.values(plans),
      features: Object.entries(FEATURES).map(([id, f]) => ({ id, label: f.label, cost: f.cost, enabled: f.enabled })),
      current_plan: user ? user.plan : null,
      payments_enabled: paymentConfigured(env),
    });
  }
  if (path === '/api/payment/callback' && m === 'GET') return payCallback(req, env);

  // ---- auth (phone OTP = register + login) ----
  if ((path === '/api/auth/otp/send' || path === '/api/otp/send') && m === 'POST') return sendOtp(req, env);
  if ((path === '/api/auth/otp/verify' || path === '/api/otp/verify') && m === 'POST') return verifyOtp(req, env);
  if ((path === '/api/auth/logout' || path === '/api/logout') && m === 'POST') return logout(req, env);

  // ---- private ----
  const user = await requireUser(req, env);
  if (path === '/api/me' && m === 'GET') return ok({ user: publicUser(user) });
  if (path === '/api/me' && m === 'PATCH') return updateProfile(req, env, user);
  if (path === '/api/ai/generate' && m === 'POST') return generate(req, env, user);
  if (path === '/api/usage' && m === 'GET') return usage(req, env, user);
  if (path === '/api/history' && m === 'GET') return history(req, env, user);
  if (path === '/api/payment/create' && m === 'POST') return payCreate(req, env, user);
  if (path === '/api/payment/verify' && m === 'POST') return payVerify(req, env, user);
  const f = path.match(/^\/api\/files\/([0-9a-f]+)$/);
  if (f && m === 'GET') return getFile(req, env, user, f[1]);

  throw new ApiError(404, 'NOT_FOUND', 'پیدا نشد.');
}

export const EMBEDDED = { '/index.html': { type: 'text/html; charset=utf-8', gz: true, data: [...INDEX_1, ...INDEX_2].join('') }, ...EMBEDDED_B };

async function serveEmbedded(url) {
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  const f = Object.prototype.hasOwnProperty.call(EMBEDDED, p) ? EMBEDDED[p] : null;
  if (!f) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0));
  const body = f.gz
    ? new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).body
    : bytes;
  return new Response(body, { headers: { 'Content-Type': f.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(req);
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      return await serveEmbedded(url);
    }
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.status, e.code, e.message);
      console.error('Unhandled error:', e && e.stack || e);
      return fail(500, 'SERVER_ERROR', 'خطای سرور. دوباره امتحان کن.');
    }
  },
};

