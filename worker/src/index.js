/**
 * Blendibox Comex API — Cloudflare Worker
 * -------------------------------------------------------------
 * Backend do site Blendibox Sourcing (GitHub Pages).
 *
 *  Dados de mercado (públicos):
 *   GET  /api/comexstat                 -> proxy do Comex Stat (MDIC) + CORS + cache
 *
 *  Autenticação (usuários da equipe):
 *   POST /api/auth/register  {name,email,password[,code]}  -> cria conta, retorna token
 *   POST /api/auth/login     {email,password}              -> retorna token
 *   POST /api/auth/forgot    {email}                       -> envia e-mail de recuperação (Resend)
 *   POST /api/auth/reset     {token,password}              -> redefine a senha
 *   GET  /api/auth/me        (Bearer)                      -> dados do usuário logado
 *
 *  Fornecedores (exigem Bearer token de um usuário logado):
 *   GET/POST /api/suppliers,  DELETE /api/suppliers?id=...
 *
 *  Bindings (wrangler.toml):
 *   KV            : KV Namespace (usuários, sessões, tokens de reset e fornecedores)
 *  Secrets:
 *   RESEND_API_KEY  (wrangler secret put RESEND_API_KEY)   -> envio de e-mail
 *   SIGNUP_CODE     (opcional) exige código no cadastro para travar o acesso
 *  Vars:
 *   ALLOWED_ORIGIN  origem do site (ex.: https://usuario.github.io) ou "*"
 *   FROM_EMAIL      remetente verificado no Resend (ex.: "Blendibox <no-reply@seudominio.com>")
 *   APP_URL         URL do site p/ montar o link de reset (ex.: https://usuario.github.io/repo/)
 */

const COMEX_URL = "https://api-comexstat.mdic.gov.br/general?language=pt";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias
const RESET_TTL = 60 * 60; // 1 hora

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname;
      if (p === "/" || p === "") return json({ ok: true, service: "blendibox-comex-api" }, 200, cors);
      if (p === "/api/comexstat") return await handleComex(url, cors);

      if (p === "/api/auth/register") return await handleRegister(request, env, cors);
      if (p === "/api/auth/login") return await handleLogin(request, env, cors);
      if (p === "/api/auth/forgot") return await handleForgot(request, env, cors);
      if (p === "/api/auth/reset") return await handleReset(request, env, cors);
      if (p === "/api/auth/me") return await handleMe(request, env, cors);

      if (p === "/api/suppliers") return await handleSuppliers(request, url, env, cors);
      if (p === "/api/data") return await handleData(request, url, env, cors);
      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      return json({ error: "server_error", detail: String(err && err.message || err) }, 500, cors);
    }
  },
};

/* ------------------------------------------------- utils */
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
  let allow = "*";
  if (!allowed.includes("*")) allow = allowed.includes(origin) ? origin : (allowed[0] || "*");
  else if (origin) allow = origin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors || {}),
  });
}
async function readJson(request) { try { return await request.json(); } catch (e) { return null; } }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
const bufToHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
function hexToBuf(hex) { const a = new Uint8Array(hex.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16); return a; }
function randHex(bytes) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return bufToHex(a); }
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* PBKDF2 (Web Crypto) */
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return { salt: bufToHex(salt), hash: bufToHex(bits) };
}
function timingEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------------------------- auth */
async function createSession(env, user) {
  const token = randHex(32);
  await env.KV.put("session:" + token, JSON.stringify({ email: user.email, name: user.name }), { expirationTtl: SESSION_TTL });
  return token;
}
async function getUserFromRequest(request, env) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const raw = await env.KV.get("session:" + m[1]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function handleRegister(request, env, cors) {
  const b = await readJson(request);
  if (!b) return json({ error: "bad_json" }, 400, cors);
  const name = String(b.name || "").trim();
  const email = normEmail(b.email);
  const password = String(b.password || "");
  if (env.SIGNUP_CODE && String(b.code || "") !== env.SIGNUP_CODE) return json({ error: "bad_code" }, 403, cors);
  if (!name) return json({ error: "name_required" }, 400, cors);
  if (!validEmail(email)) return json({ error: "bad_email" }, 400, cors);
  if (password.length < 6) return json({ error: "weak" }, 400, cors);
  const exists = await env.KV.get("user:" + email);
  if (exists) return json({ error: "exists" }, 409, cors);
  const { salt, hash } = await hashPassword(password);
  const user = { email, name, salt, hash, createdAt: Date.now() };
  await env.KV.put("user:" + email, JSON.stringify(user));
  const token = await createSession(env, user);
  return json({ ok: true, token, name, email }, 200, cors);
}

async function handleLogin(request, env, cors) {
  const b = await readJson(request);
  if (!b) return json({ error: "bad_json" }, 400, cors);
  const email = normEmail(b.email);
  const password = String(b.password || "");
  const raw = await env.KV.get("user:" + email);
  if (!raw) return json({ error: "invalid" }, 401, cors);
  const user = JSON.parse(raw);
  const { hash } = await hashPassword(password, user.salt);
  if (!timingEqual(hash, user.hash)) return json({ error: "invalid" }, 401, cors);
  const token = await createSession(env, user);
  return json({ ok: true, token, name: user.name, email }, 200, cors);
}

async function handleForgot(request, env, cors) {
  const b = await readJson(request);
  if (!b) return json({ error: "bad_json" }, 400, cors);
  const email = normEmail(b.email);
  // sempre responde ok (não revela se o e-mail existe)
  if (validEmail(email)) {
    const raw = await env.KV.get("user:" + email);
    if (raw) {
      const token = randHex(24);
      await env.KV.put("reset:" + token, email, { expirationTtl: RESET_TTL });
      await sendResetEmail(env, email, token);
    }
  }
  return json({ ok: true }, 200, cors);
}

async function handleReset(request, env, cors) {
  const b = await readJson(request);
  if (!b) return json({ error: "bad_json" }, 400, cors);
  const token = String(b.token || "");
  const password = String(b.password || "");
  if (password.length < 6) return json({ error: "weak" }, 400, cors);
  const email = token ? await env.KV.get("reset:" + token) : null;
  if (!email) return json({ error: "invalid_token" }, 400, cors);
  const raw = await env.KV.get("user:" + email);
  if (!raw) return json({ error: "invalid_token" }, 400, cors);
  const user = JSON.parse(raw);
  const { salt, hash } = await hashPassword(password);
  user.salt = salt; user.hash = hash;
  await env.KV.put("user:" + email, JSON.stringify(user));
  await env.KV.delete("reset:" + token);
  return json({ ok: true }, 200, cors);
}

async function handleMe(request, env, cors) {
  const user = await getUserFromRequest(request, env);
  if (!user) return json({ error: "unauthorized" }, 401, cors);
  return json({ ok: true, name: user.name, email: user.email }, 200, cors);
}

async function sendResetEmail(env, email, token) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL) return; // sem config de e-mail, apenas não envia
  const base = (env.APP_URL || "").replace(/\/+$/, "") + "/";
  const link = base + "#reset=" + token;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#141b34">
      <h2 style="color:#2a4bd0">Blendibox Sourcing</h2>
      <p>Você pediu para redefinir sua senha. O link abaixo vale por 1 hora:</p>
      <p><a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:11px 18px;border-radius:10px;text-decoration:none">Redefinir senha</a></p>
      <p style="font-size:12px;color:#667">Se você não pediu isso, ignore este e-mail.</p>
      <p style="font-size:11px;color:#99a;word-break:break-all">${link}</p>
    </div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [email], subject: "Redefinir senha — Blendibox Sourcing", html }),
  });
}

/* ------------------------------------------------- Comex Stat proxy */
async function handleComex(url, cors) {
  const p = url.searchParams;
  const flow = p.get("flow") === "export" ? "export" : "import";
  const ncm = (p.get("ncm") || "42022220").replace(/\D/g, "").slice(0, 8);
  const from = p.get("from") || "2023-01";
  const to = p.get("to") || "2024-12";
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return json({ error: "bad_period" }, 400, cors);
  if (ncm.length < 2) return json({ error: "bad_ncm" }, 400, cors);

  const metrics = flow === "import" ? ["metricFOB", "metricKG", "metricCIF"] : ["metricFOB", "metricKG"];
  const body = { flow, monthDetail: false, period: { from, to }, filters: [{ filter: "ncm", values: [ncm] }], details: ["ncm", "country"], metrics };

  const cacheKey = new Request("https://cache.blendibox/" + flow + "/" + ncm + "/" + from + "/" + to);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return json(await hit.json(), 200, Object.assign({ "X-Cache": "HIT" }, cors));

  const upstream = await fetch(COMEX_URL, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) });
  if (!upstream.ok) return json({ error: "comex_upstream", status: upstream.status }, 502, cors);
  const raw = await upstream.json();
  const list = (raw && raw.data && raw.data.list) || [];
  const out = {
    ok: true, flow, ncm, from, to, count: list.length,
    list: list.map((r) => ({ ncm: r.coNcm || ncm, descricao: r.ncm || "", year: r.year, country: r.country, fob: num(r.metricFOB), kg: num(r.metricKG), cif: num(r.metricCIF) })),
  };
  await cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" } }));
  return json(out, 200, Object.assign({ "X-Cache": "MISS" }, cors));
}

/* ------------------------------------------------- Fornecedores (exigem login) */
async function handleSuppliers(request, url, env, cors) {
  if (!env.KV) return json({ error: "kv_not_bound" }, 500, cors);
  const user = await getUserFromRequest(request, env);
  if (!user) return json({ error: "unauthorized" }, 401, cors);

  if (request.method === "GET") {
    const listing = await env.KV.list({ prefix: "sup:" });
    const items = await Promise.all(listing.keys.map(async (k) => {
      const v = await env.KV.get(k.name);
      try { return JSON.parse(v); } catch (e) { return null; }
    }));
    const clean = items.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ ok: true, list: clean }, 200, cors);
  }

  if (request.method === "POST") {
    const body = await readJson(request);
    if (!body || !body.name || !String(body.name).trim()) return json({ error: "name_required" }, 400, cors);
    const id = (body._id && /^[\w-]{1,64}$/.test(body._id)) ? body._id : ("s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
    body._id = id;
    if (!body.createdAt) body.createdAt = Date.now();
    body.updatedAt = Date.now();
    body.updatedBy = user.name || user.email;
    await env.KV.put("sup:" + id, JSON.stringify(body));
    return json({ ok: true, id, item: body }, 200, cors);
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[\w-]{1,64}$/.test(id)) return json({ error: "bad_id" }, 400, cors);
    await env.KV.delete("sup:" + id);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "method_not_allowed" }, 405, cors);
}

/* ------------------------------------------------- Dados de fabricação (materiais, modelos, movimentações) */
const COL_PREFIX = { materials: "mat:", models: "mod:", movements: "mov:" };
async function handleData(request, url, env, cors) {
  if (!env.KV) return json({ error: "kv_not_bound" }, 500, cors);
  const user = await getUserFromRequest(request, env);
  if (!user) return json({ error: "unauthorized" }, 401, cors);
  const col = url.searchParams.get("col");
  const pref = COL_PREFIX[col];
  if (!pref) return json({ error: "bad_collection" }, 400, cors);

  if (request.method === "GET") {
    const listing = await env.KV.list({ prefix: pref });
    const items = await Promise.all(listing.keys.map(async (k) => {
      const v = await env.KV.get(k.name);
      try { return JSON.parse(v); } catch (e) { return null; }
    }));
    const clean = items.filter(Boolean).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    return json({ ok: true, list: clean }, 200, cors);
  }
  if (request.method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ error: "bad_json" }, 400, cors);
    const id = (body._id && /^[\w-]{1,64}$/.test(body._id)) ? body._id : (col.slice(0, 3) + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
    body._id = id;
    if (!body.createdAt) body.createdAt = Date.now();
    body.updatedAt = Date.now();
    body.updatedBy = user.name || user.email;
    await env.KV.put(pref + id, JSON.stringify(body));
    return json({ ok: true, id, item: body }, 200, cors);
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[\w-]{1,64}$/.test(id)) return json({ error: "bad_id" }, 400, cors);
    await env.KV.delete(pref + id);
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "method_not_allowed" }, 405, cors);
}
