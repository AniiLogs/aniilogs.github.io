const DISCORD_API = "https://discord.com/api/v10";
const SESSION_COOKIE = "__Host-aniilogs_session";
const OAUTH_COOKIE = "__Host-aniilogs_oauth";
const OAUTH_LIFETIME_SECONDS = 10 * 60;
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

export function parseCookies(header) {
  const cookies = {};
  for (const item of String(header || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

export function safeReturnTo(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  try {
    const parsed = new URL(path, "https://aniilogs.invalid");
    return parsed.origin === "https://aniilogs.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlText(value) {
  return base64Url(encoder.encode(value));
}

function decodeBase64UrlText(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function randomToken(byteLength = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function signedValue(payload, secret) {
  const body = base64UrlText(JSON.stringify(payload));
  return `${body}.${await hmac(body, secret)}`;
}

async function readSignedValue(value, secret) {
  const [body, signature, ...extra] = String(value || "").split(".");
  if (!body || !signature || extra.length) return null;
  const expected = await hmac(body, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    return JSON.parse(decodeBase64UrlText(body));
  } catch {
    return null;
  }
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function securityHeaders(headers = new Headers()) {
  headers.set("content-security-policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: https://cdn.discordapp.com",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "));
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return headers;
}

function json(body, status = 200, headers = {}) {
  const responseHeaders = securityHeaders(new Headers(headers));
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function redirect(location, cookies = []) {
  const headers = securityHeaders(new Headers({ location, "cache-control": "no-store" }));
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 302, headers });
}

function oauthConfigured(env) {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SESSION_SECRET && env.DB);
}

function redirectUri(request) {
  return `${new URL(request.url).origin}/api/auth/discord/callback`;
}

function discordAvatarUrl(user) {
  if (!user?.id || !user?.avatar) return null;
  const extension = String(user.avatar).startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

async function startDiscordLogin(request, env) {
  if (!oauthConfigured(env)) {
    return json({ error: "Discord sign-in is awaiting deployment credentials." }, 503);
  }
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const state = randomToken();
  const stateCookie = await signedValue({
    state,
    returnTo: safeReturnTo(url.searchParams.get("return_to")),
    expiresAt: now + OAUTH_LIFETIME_SECONDS,
  }, env.SESSION_SECRET);
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("redirect_uri", redirectUri(request));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "consent");
  return redirect(authorize.toString(), [cookie(OAUTH_COOKIE, stateCookie, OAUTH_LIFETIME_SECONDS)]);
}

async function exchangeDiscordCode(request, env, code) {
  const form = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(request),
  });
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) throw new Error(`Discord token exchange failed: ${response.status}`);
  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Discord identity lookup failed: ${response.status}`);
  return response.json();
}

async function completeDiscordLogin(request, env) {
  if (!oauthConfigured(env)) return redirect("/?auth=unavailable", [clearCookie(OAUTH_COOKIE)]);
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return redirect("/?auth=cancelled", [clearCookie(OAUTH_COOKIE)]);
  }
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const stored = await readSignedValue(parseCookies(request.headers.get("cookie"))[OAUTH_COOKIE], env.SESSION_SECRET);
  const now = Math.floor(Date.now() / 1000);
  if (!stored || stored.state !== state || Number(stored.expiresAt) <= now || !code) {
    return redirect("/?auth=invalid", [clearCookie(OAUTH_COOKIE)]);
  }

  try {
    const token = await exchangeDiscordCode(request, env, code);
    const user = await fetchDiscordUser(token.access_token);
    if (!/^\d{5,30}$/u.test(String(user.id || "")) || !String(user.username || "").trim()) {
      throw new Error("Discord returned an invalid user identity");
    }
    await env.DB.prepare(
      `INSERT INTO users (
        discord_id, discord_username, discord_global_name, discord_avatar_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        discord_username = excluded.discord_username,
        discord_global_name = excluded.discord_global_name,
        discord_avatar_hash = excluded.discord_avatar_hash,
        updated_at = excluded.updated_at`,
    ).bind(
      String(user.id),
      String(user.username).slice(0, 80),
      user.global_name ? String(user.global_name).slice(0, 80) : null,
      user.avatar ? String(user.avatar).slice(0, 128) : null,
      now,
      now,
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at)
       VALUES (?, ?, NULL, 0, ?, ?)`,
    ).bind(
      String(user.id),
      String(user.global_name || user.username).slice(0, 80),
      now,
      now,
    ).run();

    const rawSession = randomToken(48);
    const sessionHash = await sha256(rawSession);
    await env.DB.prepare(
      "INSERT INTO sessions (session_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(sessionHash, String(user.id), now, now + SESSION_LIFETIME_SECONDS).run();
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
    return redirect(safeReturnTo(stored.returnTo), [
      clearCookie(OAUTH_COOKIE),
      cookie(SESSION_COOKIE, rawSession, SESSION_LIFETIME_SECONDS),
    ]);
  } catch (error) {
    console.error("Discord sign-in failed", error);
    return redirect("/?auth=failed", [clearCookie(OAUTH_COOKIE)]);
  }
}

async function currentAccount(request, env) {
  if (!env.DB) return null;
  const rawSession = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!rawSession) return null;
  const sessionHash = await sha256(rawSession);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT
      users.discord_id AS discordId,
      users.discord_username AS discordUsername,
      users.discord_global_name AS discordGlobalName,
      users.discord_avatar_hash AS discordAvatarHash,
      profiles.display_name AS displayName,
      profiles.is_public AS isPublic,
      sessions.expires_at AS expiresAt
    FROM sessions
    JOIN users ON users.discord_id = sessions.discord_id
    LEFT JOIN profiles ON profiles.discord_id = users.discord_id
    WHERE sessions.session_hash = ? AND sessions.expires_at > ?
    LIMIT 1`,
  ).bind(sessionHash, now).first();
  if (!row) return null;
  return {
    discordId: String(row.discordId),
    username: String(row.discordUsername),
    globalName: row.discordGlobalName ? String(row.discordGlobalName) : null,
    avatarUrl: discordAvatarUrl({ id: row.discordId, avatar: row.discordAvatarHash }),
    displayName: row.displayName ? String(row.displayName) : null,
    profilePublic: Number(row.isPublic) === 1,
    sessionExpiresAt: Number(row.expiresAt),
  };
}

function sameOriginWrite(request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return (!origin || origin === new URL(request.url).origin) && (!site || site === "same-origin");
}

async function logout(request, env) {
  if (!sameOriginWrite(request)) return json({ error: "Cross-origin request denied." }, 403);
  const rawSession = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (rawSession && env.DB) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_hash = ?")
      .bind(await sha256(rawSession))
      .run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
}

async function api(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, discordLoginConfigured: oauthConfigured(env) });
  }
  if (url.pathname === "/api/auth/discord/start" && request.method === "GET") {
    return startDiscordLogin(request, env);
  }
  if (url.pathname === "/api/auth/discord/callback" && request.method === "GET") {
    return completeDiscordLogin(request, env);
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const account = await currentAccount(request, env);
    return account ? json({ authenticated: true, account }) : json({ authenticated: false });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return logout(request, env);
  }
  return json({ error: "Not found" }, 404);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return api(request, env);
  const asset = await env.ASSETS.fetch(request);
  const headers = securityHeaders(new Headers(asset.headers));
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env).catch((error) => {
      console.error("AniiLogs request failed", error);
      return json({ error: "Service temporarily unavailable" }, 503);
    });
  },
};
