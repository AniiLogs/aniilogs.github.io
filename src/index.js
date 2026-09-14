const DISCORD_API = "https://discord.com/api/v10";
const SESSION_COOKIE = "__Host-aniilogs_session";
const OAUTH_COOKIE = "__Host-aniilogs_oauth";
const OAUTH_LIFETIME_SECONDS = 10 * 60;
const AUTH_HANDOFF_LIFETIME_SECONDS = 5 * 60;
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SHARE_LIFETIME_SECONDS = 3 * 60 * 60;
const SHARE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_PROGRESS_BYTES = 512 * 1024;
const CONTENT_RELEASE = "3509129";
const CONTENT_PATH_PREFIX = `/api/content/releases/${CONTENT_RELEASE}/`;

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

function configuredPublicSiteOrigin(env) {
  const value = String(env?.PUBLIC_SITE_ORIGIN || "").replace(/\/+$/u, "");
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

export function safeClientReturnTo(value, request, env) {
  const apiOrigin = new URL(request.url).origin;
  const publicOrigin = configuredPublicSiteOrigin(env) || apiOrigin;
  try {
    const parsed = new URL(String(value || "/"), publicOrigin);
    if (parsed.origin !== publicOrigin) return `${publicOrigin}/`;
    return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return `${publicOrigin}/`;
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

function securityHeaders(headers = new Headers(), localPreview = false) {
  const localContentOrigin = localPreview ? " http://127.0.0.1:8788" : "";
  headers.set("content-security-policy", [
    "default-src 'self'",
    "base-uri 'none'",
    `connect-src 'self' https://api.github.com https://aniilogs-api.pages.dev${localContentOrigin}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `img-src 'self' data: https://aniilogs-api.pages.dev https://cdn.discordapp.com https://worldx-website-cdn.aniimo.com${localContentOrigin}`,
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

function validContentKey(pathname) {
  if (!pathname.startsWith(CONTENT_PATH_PREFIX)) return null;
  let key;
  try {
    key = decodeURIComponent(pathname.slice(CONTENT_PATH_PREFIX.length));
  } catch {
    return null;
  }
  if (!key || key.startsWith("/") || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return `releases/${CONTENT_RELEASE}/${key}`;
}

async function getReleaseContent(request, env) {
  if (!env.CONTENT) return json({ error: "Content storage is unavailable." }, 503);
  const key = validContentKey(new URL(request.url).pathname);
  if (!key) return json({ error: "Not found" }, 404);
  const object = request.method === "HEAD" ? await env.CONTENT.head(key) : await env.CONTENT.get(key);
  if (!object) return json({ error: "Not found" }, 404);
  const headers = securityHeaders(new Headers());
  object.writeHttpMetadata?.(headers);
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  if (Number.isFinite(object.size)) headers.set("content-length", String(object.size));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function oauthConfigured(env) {
  return Boolean(
    env.DISCORD_CLIENT_ID
    && env.DISCORD_CLIENT_SECRET
    && env.SESSION_SECRET
    && configuredPublicSiteOrigin(env)
    && env.DB,
  );
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
    returnTo: safeClientReturnTo(url.searchParams.get("return_to"), request, env),
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
  const url = new URL(request.url);
  const failureLocation = (status, returnTo = "/") => {
    const destination = new URL(safeClientReturnTo(returnTo, request, env));
    destination.searchParams.set("auth", status);
    destination.hash = "";
    return destination.toString();
  };
  if (!oauthConfigured(env)) {
    return redirect(failureLocation("unavailable"), [clearCookie(OAUTH_COOKIE)]);
  }
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const stored = await readSignedValue(parseCookies(request.headers.get("cookie"))[OAUTH_COOKIE], env.SESSION_SECRET);
  if (url.searchParams.get("error")) {
    return redirect(failureLocation("cancelled", stored?.returnTo), [clearCookie(OAUTH_COOKIE)]);
  }
  const now = Math.floor(Date.now() / 1000);
  if (!stored || stored.state !== state || Number(stored.expiresAt) <= now || !code) {
    return redirect(failureLocation("invalid", stored?.returnTo), [clearCookie(OAUTH_COOKIE)]);
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

    const rawHandoff = randomToken(48);
    const handoffHash = await sha256(rawHandoff);
    await env.DB.prepare(
      "INSERT INTO auth_handoffs (handoff_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(handoffHash, String(user.id), now, now + AUTH_HANDOFF_LIFETIME_SECONDS).run();
    await env.DB.prepare("DELETE FROM auth_handoffs WHERE expires_at <= ?").bind(now).run();
    const destination = new URL(safeClientReturnTo(stored.returnTo, request, env));
    destination.hash = `aniilogs_auth=${encodeURIComponent(rawHandoff)}`;
    return redirect(destination.toString(), [clearCookie(OAUTH_COOKIE)]);
  } catch (error) {
    console.error("Discord sign-in failed", error);
    return redirect(failureLocation("failed", stored.returnTo), [clearCookie(OAUTH_COOKIE)]);
  }
}

async function currentAccount(request, env) {
  if (!env.DB) return null;
  const authorization = request.headers.get("authorization") || "";
  const bearerMatch = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/u);
  const rawSession = bearerMatch?.[1] || parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
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

export function sameOriginWrite(request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return origin === new URL(request.url).origin && (!site || site === "same-origin");
}

export function browserWriteAllowed(request, env) {
  if (sameOriginWrite(request)) return true;
  const origin = request.headers.get("origin") || "";
  return Boolean(origin && origin === configuredPublicSiteOrigin(env));
}

function corsResponse(request, env, response) {
  const url = new URL(request.url);
  if (url.pathname.startsWith(CONTENT_PATH_PREFIX) && (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS")) {
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-max-age", "86400");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const origin = request.headers.get("origin") || "";
  if (!origin || origin !== configuredPublicSiteOrigin(env)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function exchangeAuthHandoff(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const rawHandoff = String(body.handoff || "");
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(rawHandoff)) return json({ error: "Invalid sign-in handoff." }, 400);
  const handoffHash = await sha256(rawHandoff);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, expires_at AS expiresAt FROM auth_handoffs WHERE handoff_hash = ? LIMIT 1",
  ).bind(handoffHash).first();
  if (!row || Number(row.expiresAt) <= now) {
    if (row) await env.DB.prepare("DELETE FROM auth_handoffs WHERE handoff_hash = ?").bind(handoffHash).run();
    return json({ error: "Sign-in handoff expired or was already used." }, 401);
  }
  const consumed = await env.DB.prepare("DELETE FROM auth_handoffs WHERE handoff_hash = ?")
    .bind(handoffHash)
    .run();
  if (Number(consumed.meta?.changes || 0) !== 1) {
    return json({ error: "Sign-in handoff expired or was already used." }, 401);
  }
  const rawSession = randomToken(48);
  await env.DB.prepare(
    "INSERT INTO sessions (session_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(await sha256(rawSession), String(row.discordId), now, now + SESSION_LIFETIME_SECONDS).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  return json({ token: rawSession, expiresAt: now + SESSION_LIFETIME_SECONDS });
}

async function logout(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const authorization = request.headers.get("authorization") || "";
  const rawSession = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/u)?.[1]
    || parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (rawSession && env.DB) {
    await env.DB.prepare("DELETE FROM sessions WHERE session_hash = ?")
      .bind(await sha256(rawSession))
      .run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
}

async function readJsonBody(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new RangeError("Request body is too large.");
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) throw new RangeError("Request body is too large.");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new TypeError("Request body must be valid JSON.");
  }
}

export function progressPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tracking = value.tracking;
  const completed = value.completed;
  const preferences = value.preferences;
  if (!Array.isArray(tracking) || tracking.length > 5000) return null;
  if (!Array.isArray(completed) || completed.length > 15000) return null;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return null;
  if (completed.some((entry) => typeof entry !== "string" || entry.length > 240)) return null;
  if (tracking.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) return null;
  return { schemaVersion: 1, tracking, completed, preferences };
}

async function getProgress(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const row = await env.DB.prepare(
    "SELECT revision, data_json AS dataJson, updated_at AS updatedAt FROM progress_snapshots WHERE discord_id = ?",
  ).bind(account.discordId).first();
  if (!row) return json({ revision: 0, progress: null, updatedAt: null });
  try {
    return json({ revision: Number(row.revision), progress: JSON.parse(row.dataJson), updatedAt: Number(row.updatedAt) });
  } catch {
    return json({ error: "Stored progress is invalid." }, 500);
  }
}

async function putProgress(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  let body;
  try {
    body = await readJsonBody(request, MAX_PROGRESS_BYTES);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const progress = progressPayload(body.progress);
  if (!progress) return json({ error: "Progress payload has an invalid shape." }, 400);
  const encoded = JSON.stringify(progress);
  if (encoder.encode(encoded).byteLength > MAX_PROGRESS_BYTES) {
    return json({ error: "Progress payload is too large." }, 413);
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO progress_snapshots (discord_id, revision, data_json, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET
       revision = progress_snapshots.revision + 1,
       data_json = excluded.data_json,
       updated_at = excluded.updated_at`,
  ).bind(account.discordId, encoded, now, now).run();
  const row = await env.DB.prepare(
    "SELECT revision, updated_at AS updatedAt FROM progress_snapshots WHERE discord_id = ?",
  ).bind(account.discordId).first();
  return json({ ok: true, revision: Number(row.revision), updatedAt: Number(row.updatedAt) });
}

function shareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => SHARE_ALPHABET[byte % SHARE_ALPHABET.length]).join("");
}

export function validShareSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.m !== "string" || !value.m || value.m.length > 80) return false;
  if (!Array.isArray(value.g) || value.g.length < 1 || value.g.length > 5000) return false;
  return value.g.every((group) => (
    Array.isArray(group) && group.length >= 1 && group.length <= 3
    && typeof group[0] === "string" && group[0].length <= 160
    && (group[1] === undefined || group[1] === "s" || group[1] === "x")
    && (group[2] === undefined || (
      Array.isArray(group[2]) && group[2].length <= 20000
      && group[2].every((id) => typeof id === "string" && id.length <= 240)
    ))
  ));
}

async function createMapShare(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Sign in with Discord to create a short link." }, 401);
  let body;
  try {
    body = await readJsonBody(request, 24576);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  if (body.version !== 1 || !validShareSelection(body.selection)) {
    return json({ error: "Shared pin selection is invalid." }, 400);
  }
  const selectionJson = JSON.stringify(body.selection);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM map_shares WHERE expires_at <= ?").bind(now).run();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = shareId();
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO map_shares
       (share_id, creator_discord_id, selection_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, account.discordId, selectionJson, now, now + SHARE_LIFETIME_SECONDS).run();
    if (Number(result.meta?.changes || 0) === 1) return json({ id, expiresAt: now + SHARE_LIFETIME_SECONDS }, 201);
  }
  return json({ error: "Could not allocate a share ID." }, 503);
}

async function getMapShare(id, env) {
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{8}$/u.test(id)) {
    return json({ error: "Share not found." }, 404);
  }
  const row = await env.DB.prepare(
    "SELECT selection_json AS selectionJson, expires_at AS expiresAt FROM map_shares WHERE share_id = ?",
  ).bind(id).first();
  if (!row) return json({ error: "Share not found." }, 404);
  const now = Math.floor(Date.now() / 1000);
  if (Number(row.expiresAt) <= now) {
    await env.DB.prepare("DELETE FROM map_shares WHERE share_id = ?").bind(id).run();
    return json({ error: "Share expired." }, 410);
  }
  return json({ selection: JSON.parse(row.selectionJson), expiresAt: Number(row.expiresAt) });
}

async function ownProfile(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const row = await env.DB.prepare(
    "SELECT display_name AS displayName, bio, is_public AS isPublic, updated_at AS updatedAt FROM profiles WHERE discord_id = ?",
  ).bind(account.discordId).first();
  return json({ profile: { ...row, isPublic: Number(row?.isPublic || 0) === 1 } });
}

async function updateOwnProfile(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  let body;
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const displayName = String(body.displayName || "").trim();
  const bio = String(body.bio || "").trim();
  if (!displayName || displayName.length > 80 || bio.length > 500) {
    return json({ error: "Profile fields are invalid." }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE profiles SET display_name = ?, bio = ?, is_public = 0, updated_at = ? WHERE discord_id = ?",
  ).bind(displayName, bio || null, now, account.discordId).run();
  return json({ ok: true, profile: { displayName, bio: bio || null, isPublic: false, updatedAt: now } });
}

async function deleteOwnAccount(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  let body;
  try {
    body = await readJsonBody(request, 512);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  if (body.confirmation !== "DELETE") {
    return json({ error: "Type DELETE to confirm account deletion." }, 400);
  }

  const discordId = account.discordId;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_handoffs WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM map_shares WHERE creator_discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM progress_snapshots WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM profiles WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM sessions WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM users WHERE discord_id = ?").bind(discordId),
  ]);
  return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
}

async function api(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: securityHeaders() });
  if (url.pathname.startsWith(CONTENT_PATH_PREFIX) && (request.method === "GET" || request.method === "HEAD")) {
    return getReleaseContent(request, env);
  }
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, discordLoginConfigured: oauthConfigured(env) });
  }
  if (url.pathname === "/api/auth/discord/start" && request.method === "GET") {
    return startDiscordLogin(request, env);
  }
  if (url.pathname === "/api/auth/discord/callback" && request.method === "GET") {
    return completeDiscordLogin(request, env);
  }
  if (url.pathname === "/api/auth/exchange" && request.method === "POST") {
    return exchangeAuthHandoff(request, env);
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const account = await currentAccount(request, env);
    return account ? json({ authenticated: true, account }) : json({ authenticated: false });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    return logout(request, env);
  }
  if (url.pathname === "/api/progress" && request.method === "GET") return getProgress(request, env);
  if (url.pathname === "/api/progress" && request.method === "PUT") return putProgress(request, env);
  if (url.pathname === "/api/profile" && request.method === "GET") return ownProfile(request, env);
  if (url.pathname === "/api/profile" && request.method === "PATCH") return updateOwnProfile(request, env);
  if (url.pathname === "/api/account" && request.method === "DELETE") return deleteOwnAccount(request, env);
  if (url.pathname === "/api/v1/shares" && request.method === "POST") return createMapShare(request, env);
  const shareMatch = url.pathname.match(/^\/api\/v1\/shares\/([^/]+)$/u);
  if (shareMatch && request.method === "GET") return getMapShare(shareMatch[1], env);
  return json({ error: "Not found" }, 404);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return corsResponse(request, env, await api(request, env));
  const asset = await env.ASSETS.fetch(request);
  const headers = securityHeaders(new Headers(asset.headers), url.hostname === "127.0.0.1" || url.hostname === "localhost");
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
