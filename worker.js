/**
 * worker.js – simple chat proxy with daily quota + CORS
 *
 * Bindings required:
 *   Secret: OPENAI_API_KEY
 *   KV:     CHAT_QUOTA
 */

const DAILY_LIMIT  = 100_000;                  // tokens per UTC day
const ALLOWED_ORIGINS = [
  'https://cgenereux.github.io',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://localhost',
  'http://127.0.0.1'
];
const ALLOWED_USERS = new Set(['curtis','maryla']);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Figure allowed origin dynamically
    const origin = req.headers.get('Origin') || '';
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin':  allowOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Vary': 'Origin',
        },
      });
    }

    // Simple health and root checks for easier debugging
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return new Response('OK', { status: 200, headers: corsHeaders(allowOrigin, 'text/plain') });
    }

    // Admin: allow user (requires ADMIN_CODE)
    if (req.method === 'POST' && url.pathname === '/admin/allow-user') {
      const admin = req.headers.get('x-admin-code') || '';
      if (!env.ADMIN_CODE || admin !== env.ADMIN_CODE) {
        return json({ error: 'Unauthorized' }, 401, allowOrigin);
      }
      const { username } = await req.json();
      if (!username) return json({ error: 'Missing username' }, 400, allowOrigin);
      await env.USERS.put(`allowed:${username}`, '1');
      return json({ ok: true }, 200, allowOrigin);
    }

    // Auth endpoints
    if (url.pathname.startsWith('/auth/')) {
      // Register (first time set password) for allowed usernames only
      if (req.method === 'POST' && url.pathname === '/auth/register') {
        const raw = await req.text();
        let data; try { data = JSON.parse(raw || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400, allowOrigin); }
        const username = (data.username || '').trim().toLowerCase();
        const password = data.password || '';
        if (!username || !password) return json({ error: 'Missing fields' }, 400, allowOrigin);
        const allowed = ALLOWED_USERS.has(username) || (await env.USERS.get(`allowed:${username}`));
        if (!allowed) return json({ error: 'Not allowed' }, 403, allowOrigin);
        const existing = await env.USERS.get(`user:${username}`, 'json');
        if (existing) return json({ error: 'Already registered' }, 409, allowOrigin);
        const { saltB64, hashB64 } = await hashPassword(password);
        await env.USERS.put(`user:${username}`, JSON.stringify({ username, saltB64, hashB64, createdAt: Date.now() }));
        const token = randomToken();
        const ttl = 30 * 24 * 3600;
        await env.SESSIONS.put(`session:${token}`, JSON.stringify({ username, exp: Date.now() + ttl * 1000 }), { expirationTtl: ttl });
        return json({ token, username }, 200, allowOrigin);
      }

      // Login
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const raw = await req.text();
        let data; try { data = JSON.parse(raw || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400, allowOrigin); }
        const username = (data.username || '').trim().toLowerCase();
        const password = data.password || '';
        if (!username || !password) return json({ error: 'Missing fields' }, 400, allowOrigin);
        const user = await env.USERS.get(`user:${username}`, 'json');
        if (!user) return json({ error: 'Invalid credentials' }, 401, allowOrigin);
        const ok = await verifyPassword(password, user.saltB64, user.hashB64);
        if (!ok) return json({ error: 'Invalid credentials' }, 401, allowOrigin);
        const token = randomToken();
        const ttl = 30 * 24 * 3600;
        await env.SESSIONS.put(`session:${token}`, JSON.stringify({ username, exp: Date.now() + ttl * 1000 }), { expirationTtl: ttl });
        return json({ token, username }, 200, allowOrigin);
      }

      // Logout
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        const token = bearerToken(req.headers.get('Authorization'));
        if (token) await env.SESSIONS.delete(`session:${token}`);
        return json({ ok: true }, 200, allowOrigin);
      }

      // Me
      if (req.method === 'GET' && url.pathname === '/auth/me') {
        const username = await requireAuth(req, env);
        if (!username) return json({ error: 'Unauthorized' }, 401, allowOrigin);
        return json({ username }, 200, allowOrigin);
      }
    }

    // Conversations storage (KV-backed). Optional if CONVERSATIONS binding exists.
    if (url.pathname.startsWith('/conversations')) {
      const username = await requireAuth(req, env);
      if (!username) return json({ error: 'Unauthorized' }, 401, allowOrigin);
      if (!env.CONVERSATIONS) {
        return json({ error: 'Persistence not configured' }, 501, allowOrigin);
      }

      const keyFor = (id) => `conv:${username}:${id}`;

      // GET /conversations -> list ids and titles
      if (req.method === 'GET' && url.pathname === '/conversations') {
        const list = await env.CONVERSATIONS.list({ prefix: `conv:${username}:` });
        const items = [];
        for (const k of list.keys) {
          try {
            const c = await env.CONVERSATIONS.get(k.name, 'json');
            if (c && c.id) items.push({ id: c.id, title: c.title, updatedAt: c.updatedAt || c.createdAt });
          } catch (_) {}
        }
        return json({ items }, 200, allowOrigin);
      }

      // GET /conversations/:id -> load
      if (req.method === 'GET' && url.pathname.startsWith('/conversations/')) {
        const id = url.pathname.split('/').pop();
        const obj = await env.CONVERSATIONS.get(keyFor(id), 'json');
        if (!obj) return json({ error: 'Not found' }, 404, allowOrigin);
        return json(obj, 200, allowOrigin);
      }

      // POST /conversations/:id -> save
      if (req.method === 'POST' && url.pathname.startsWith('/conversations/')) {
        const id = url.pathname.split('/').pop();
        const bodyTxt = await req.text();
        try {
          const conv = JSON.parse(bodyTxt || '{}');
          if (!conv || conv.id !== id) return json({ error: 'Invalid payload' }, 400, allowOrigin);
          const withMeta = { ...conv, username, updatedAt: Date.now() };
          await env.CONVERSATIONS.put(keyFor(id), JSON.stringify(withMeta));
          return json({ ok: true }, 200, allowOrigin);
        } catch (e) {
          return json({ error: 'Invalid JSON' }, 400, allowOrigin);
        }
      }

      // DELETE /conversations/:id -> delete
      if (req.method === 'DELETE' && url.pathname.startsWith('/conversations/')) {
        const id = url.pathname.split('/').pop();
        await env.CONVERSATIONS.delete(keyFor(id));
        return json({ ok: true }, 200, allowOrigin);
      }

      return json({ error: 'Not found' }, 404, allowOrigin);
    }

    // Proxy chat requests to OpenAI
    if (req.method === 'POST') {
      // Quota check
      const today = new Date().toISOString().slice(0, 10);
      const used  = +(await env.CHAT_QUOTA.get(today)) || 0;
      if (used >= DAILY_LIMIT) {
        return new Response('Site quota exhausted for today', {
          status: 429,
          headers: corsHeaders(allowOrigin, 'text/plain')
        });
      }

      // Forward to OpenAI
      let upstream, text;
      try {
        upstream = await fetch(
          'https://api.openai.com/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: await req.text(),
          }
        );
        text = await upstream.text();
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Upstream request failed', details: String(err) }), {
          status: 502,
          headers: corsHeaders(allowOrigin)
        });
      }

      // Update quota (best‐effort)
      try {
        const j = JSON.parse(text);
        const tokens = j.usage?.total_tokens || 0;
        await env.CHAT_QUOTA.put(today, String(used + tokens), { expirationTtl: 172800 });
      } catch (_) {
        // ignore parsing errors
      }

      // Return with CORS and safe headers only
      return new Response(text, {
        status: upstream.status,
        headers: corsHeaders(allowOrigin, 'application/json')
      });
    }

    // Fallback
    return new Response('Not found', {
      status: 404,
      headers: corsHeaders(allowOrigin, 'text/plain')
    });
  }
};

// Helpers
function json(obj, status = 200, origin = ALLOWED_ORIGINS[0]) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: corsHeaders(origin)
  });
}

function corsHeaders(origin, contentType = 'application/json') {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin'
  };
}

// Auth helpers
function bearerToken(authHeader) {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireAuth(req, env) {
  const token = bearerToken(req.headers.get('Authorization'));
  if (!token) return null;
  const s = await env.SESSIONS.get(`session:${token}`, 'json');
  return s?.username || null;
}

const PBKDF2_ITERS = 100_000; // Cloudflare Workers cap ~100k
async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' }, key, 256);
  const hash = new Uint8Array(bits);
  return { saltB64: b64(salt), hashB64: b64(hash) };
}

async function verifyPassword(password, saltB64, hashB64) {
  const enc = new TextEncoder();
  const salt = b64dec(saltB64);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' }, key, 256);
  const hash = b64(new Uint8Array(bits));
  return hash === hashB64;
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function b64(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}

function b64dec(str) {
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
