const DISCORD_API = "https://discord.com/api/v10";
const SESSION_COOKIE = "__Host-aniilogs_session";
const OAUTH_COOKIE = "__Host-aniilogs_oauth";
const DEV_PREVIEW_TICKET_SECONDS = 60;
const DEV_PREVIEW_COOKIE_SECONDS = 15 * 60;
const OAUTH_LIFETIME_SECONDS = 10 * 60;
const AUTH_HANDOFF_LIFETIME_SECONDS = 5 * 60;
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SHARE_LIFETIME_SECONDS = 3 * 60 * 60;
const SHARE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_PROGRESS_BYTES = 512 * 1024;
const CONTENT_RELEASE = "3535596";
const ASSET_FALLBACK_RELEASE = "3509129";
const CONTENT_PATH_PREFIX = `/api/content/releases/${CONTENT_RELEASE}/`;
const RELEASE_PATCH_KEY = `releases/${CONTENT_RELEASE}/data/release_patch.json.gz`;
const PUBLIC_RELEASE_DATA = new Set([
  "aniilog_data.json",
  "aniilog_media.json",
  "checklist_data.json",
  "itemlog_data.json",
  "map_site_data.json",
  "petmanual-artwork-manifest.remote.json",
  "rarity-manifest.remote.json",
  "team_builder_data.json",
]);
const PRIVATE_RELEASE_SEGMENTS = new Set([
  "qa", "private", "private-extract", "source", "src", "renderer", "shader", "shaders",
  "authored-runtime", "material-textures", "resources", "asset-bundles", "asset-packages",
  "game-files", "captures", "raw-captures",
]);
const TURNTABLE_FRAME_PATH = /^assets\/aniimo-turntables\/([0-9]+)\/(common|sparkling-(?:0[1-9]|1[0-2]))\/frame-([0-9]{3})\.(png|webp)$/u;

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

function developerPreviewBridgeSecret(env) {
  const secret = String(env.QA_BRIDGE_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

async function issueDeveloperPreviewTicket(request, env) {
  const secret = developerPreviewBridgeSecret(env);
  if (!secret || !env.DB) return json({ error: "Developer preview is unavailable." }, 503);
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account?.developerModeAvailable) return json({ error: "Developer access required." }, 403);
  const nonce = randomToken(32);
  const ticket = `${nonce}.${await hmac(`aniilogs-qa-preview-v1:${nonce}`, secret)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO auth_handoffs (handoff_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(await sha256(ticket), account.discordId, now, now + DEV_PREVIEW_TICKET_SECONDS).run();
  return json({
    ticket,
    launchUrl: "https://aniilogs-renderer-qa-3634150.pages.dev/qa/current3634150/redeem",
    expiresInSeconds: DEV_PREVIEW_TICKET_SECONDS,
  });
}

async function redeemDeveloperPreviewTicket(request, env) {
  const secret = developerPreviewBridgeSecret(env);
  if (!secret || !env.DB) return json({ error: "Developer preview is unavailable." }, 503);
  const authorization = request.headers.get("authorization") || "";
  const suppliedSecret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!constantTimeEqual(suppliedSecret, secret)) return json({ error: "Service authorization required." }, 403);
  const body = await readJsonBody(request, 2048);
  const ticket = String(body?.ticket || "");
  const [nonce, signature, ...extra] = ticket.split(".");
  if (!nonce || !signature || extra.length || !/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)
    || !constantTimeEqual(signature, await hmac(`aniilogs-qa-preview-v1:${nonce}`, secret))) {
    return json({ error: "Invalid or expired preview handoff." }, 403);
  }
  const ticketHash = await sha256(ticket);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, expires_at AS expiresAt FROM auth_handoffs WHERE handoff_hash = ? LIMIT 1",
  ).bind(ticketHash).first();
  if (!row || Number(row.expiresAt) <= now) return json({ error: "Invalid or expired preview handoff." }, 403);
  const consumed = await env.DB.prepare(
    "DELETE FROM auth_handoffs WHERE handoff_hash = ? AND expires_at > ?",
  ).bind(ticketHash, now).run();
  if (Number(consumed?.meta?.changes) !== 1) return json({ error: "Preview handoff already used." }, 403);
  const discordId = String(row.discordId);
  let developer = developerAccountAllowed(discordId, env);
  if (!developer) {
    developer = Boolean(await env.DB.prepare(
      "SELECT discord_id AS discordId FROM developer_roles WHERE discord_id = ? LIMIT 1",
    ).bind(discordId).first());
  }
  if (!developer) return json({ error: "Developer access revoked." }, 403);
  return json({ ok: true, discordId, maxSessionSeconds: DEV_PREVIEW_COOKIE_SECONDS });
}

function securityHeaders(headers = new Headers(), localPreview = false) {
  const localContentOrigin = localPreview ? " http://127.0.0.1:8788" : "";
  headers.set("content-security-policy", [
    "default-src 'self'",
    "base-uri 'none'",
    `connect-src 'self' blob: https://api.github.com https://aniilogs-api.pages.dev${localContentOrigin}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `img-src 'self' data: blob: https://aniilogs-api.pages.dev https://cdn.discordapp.com https://worldx-website-cdn.aniimo.com${localContentOrigin}`,
    `media-src 'self' https://aniilogs-api.pages.dev${localContentOrigin}`,
    "object-src 'none'",
    `script-src 'self' https://aniilogs-api.pages.dev${localContentOrigin}`,
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

function publicReleaseContentKey(key) {
  const relative = key.slice(`releases/${CONTENT_RELEASE}/`.length);
  const segments = relative.toLowerCase().split("/");
  if (segments.some((segment) => PRIVATE_RELEASE_SEGMENTS.has(segment)
    || /^(?:private|source|shader|renderer|asset-package|qa)[-_.]/u.test(segment)
    || segment.startsWith("."))) return false;

  if (segments[0] === "data") {
    const dataPath = segments.slice(1).join("/");
    return PUBLIC_RELEASE_DATA.has(dataPath)
      || /^(?:i18n|maps)\/[a-z0-9-]+\.json$/u.test(dataPath);
  }
  // The only reviewed files under media are finished Pet Manual captures.
  if (segments[0] === "media") {
    return /^media\/aniimo\/petmanual\/[0-9]+\/[\w-]+\.mp4$/u.test(segments.join("/"));
  }
  if (segments[0] !== "assets") return false;
  if (segments[1] === "aniimo-turntables") return TURNTABLE_FRAME_PATH.test(relative);
  return /\.(?:png|webp|jpe?g|mp4|glb)$/iu.test(relative);
}

async function approvedTurntableFrame(key, env) {
  const relative = key.slice(`releases/${CONTENT_RELEASE}/`.length);
  if (!relative.startsWith("assets/aniimo-turntables/")) return true;
  const match = TURNTABLE_FRAME_PATH.exec(relative);
  if (!match) return false;
  const [, formId, appearanceId, frameNumber, format] = match;
  const manifestKey = `releases/${CONTENT_RELEASE}/data/petmanual-artwork-manifest.remote.json`;
  const manifestObject = await env.CONTENT.get(manifestKey);
  if (!manifestObject) return false;
  let manifest;
  try {
    manifest = await new Response(manifestObject.body).json();
  } catch {
    return false;
  }
  if (manifest?.schema !== "aniilogs.private.petmanual-artwork-manifest.v1"
    || manifest.reviewStatus !== "approved"
    || String(manifest.sourcePackage ?? "") !== CONTENT_RELEASE) return false;
  const form = manifest.forms?.[formId];
  if (String(form?.formId ?? "") !== formId) return false;
  const variant = form.variants?.find?.((entry) => entry?.id === appearanceId);
  const expectedStyle = appearanceId === "common" ? null : Number(appearanceId.slice(-2));
  if (!variant || variant.renderVerified !== true
    || (expectedStyle === null ? variant.style != null : variant.style !== expectedStyle)
    || !/^[a-f0-9]{64}$/iu.test(String(variant.representativeHash || ""))) return false;
  const frames = variant.turntable;
  return frames?.renderVerified === true
    && frames.transparentBackground === true
    && frames.basePath === `./assets/aniimo-turntables/${formId}/${appearanceId}`
    && frames.format === format
    && Number.isInteger(frames.frameCount)
    && frames.frameCount >= 12
    && frames.frameCount <= 120
    && Number(frameNumber) < frames.frameCount;
}

async function getReleaseContent(request, env) {
  if (String(env.CONTENT_RELEASE_ENABLED || "").toLowerCase() !== "true") {
    return json({ error: "Release content is unavailable pending review." }, 404);
  }
  if (!env.CONTENT) return json({ error: "Content storage is unavailable." }, 503);
  const key = validContentKey(new URL(request.url).pathname);
  if (!key || !publicReleaseContentKey(key)) return json({ error: "Not found" }, 404);
  if (!await approvedTurntableFrame(key, env)) return json({ error: "Not found" }, 404);
  const read = (objectKey) => request.method === "HEAD" ? env.CONTENT.head(objectKey) : env.CONTENT.get(objectKey);
  let object = await read(key);
  const rootReleaseData = new RegExp(`^releases/${CONTENT_RELEASE}/data/[^/]+\\.json$`, "u");
  if (!object && request.method !== "HEAD" && rootReleaseData.test(key)) {
    object = await materializeReleaseData(key, env);
  }
  if (!object && key.startsWith(`releases/${CONTENT_RELEASE}/data/`)) {
    object = await read(key.replace(
      `releases/${CONTENT_RELEASE}/data/`,
      `releases/${ASSET_FALLBACK_RELEASE}/data/`,
    ));
  }
  if (!object && key.startsWith(`releases/${CONTENT_RELEASE}/assets/`)
    && !key.includes("/assets/aniimo-turntables/")) {
    object = await read(key.replace(
      `releases/${CONTENT_RELEASE}/assets/`,
      `releases/${ASSET_FALLBACK_RELEASE}/assets/`,
    ));
  }
  if (!object) return json({ error: "Not found" }, 404);
  const headers = securityHeaders(new Headers());
  object.writeHttpMetadata?.(headers);
  if (!headers.has("content-type")) {
    const extension = key.slice(key.lastIndexOf(".")).toLowerCase();
    const fallbackTypes = {
      ".json": "application/json; charset=utf-8",
      ".mp4": "video/mp4",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    headers.set("content-type", fallbackTypes[extension] || "application/octet-stream");
  }
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  if (Number.isFinite(object.size)) headers.set("content-length", String(object.size));
  headers.set(
    "cache-control",
    key.endsWith(".json")
      ? "public, max-age=60, must-revalidate"
      : "public, max-age=31536000, immutable",
  );
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

async function materializeReleaseData(key, env) {
  if (typeof env.CONTENT.put !== "function") return null;
  const filename = key.slice(key.lastIndexOf("/") + 1);
  const baselineKey = `releases/${ASSET_FALLBACK_RELEASE}/data/${filename}`;
  const [baselineObject, patchObject] = await Promise.all([
    env.CONTENT.get(baselineKey),
    env.CONTENT.get(RELEASE_PATCH_KEY),
  ]);
  if (!baselineObject || !patchObject) return null;

  const [payload, patch] = await Promise.all([
    new Response(baselineObject.body).json(),
    new Response(patchObject.body.pipeThrough(new DecompressionStream("gzip"))).json(),
  ]);
  if (patch.package_version !== Number(CONTENT_RELEASE)) return null;

  if (filename === "map_site_data.json") {
    payload.data_quality = { ...(payload.data_quality || {}), package_version: patch.package_version };
  } else {
    payload.package_version = patch.package_version;
  }
  if (filename === "itemlog_data.json") {
    for (const entry of payload.entries || []) {
      if (Object.hasOwn(patch.item_descriptions || {}, entry.item_id)) {
        entry.description = patch.item_descriptions[entry.item_id];
      }
      if (Object.hasOwn(patch.item_icons || {}, entry.item_id)) {
        entry.icon = patch.item_icons[entry.item_id];
      }
      if (Object.hasOwn(patch.item_rv_details || {}, entry.item_id)) {
        entry.rv_details = patch.item_rv_details[entry.item_id];
      }
      if (Object.hasOwn(patch.item_held_details || {}, entry.item_id)) {
        entry.held_item_details = patch.item_held_details[entry.item_id];
      }
      if (Object.hasOwn(patch.item_audit || {}, entry.item_id)) {
        Object.assign(entry, patch.item_audit[entry.item_id]);
      }
    }
    payload.generated_at_utc = patch.generated_at;
    payload.source_policy = "Current game files; every added description is resolved from the build 3535596 English localization archive.";
    payload.audit_status = "Build 3535596 names and descriptions validated; parameterized and genuinely absent descriptions remain blank.";
    payload.totals.items_with_descriptions = (payload.entries || []).filter((entry) => Boolean(entry.description)).length;
    payload.totals.items_without_descriptions = (payload.entries || []).length - payload.totals.items_with_descriptions;
    payload.totals.descriptions_added_in_3535596 = Object.keys(patch.item_descriptions || {}).length;
    payload.totals.icons_added_in_3535596 = Object.keys(patch.item_icons || {}).length;
    payload.totals.items_without_icons = (payload.entries || []).filter((entry) => !entry.icon).length;
    payload.totals.items_with_rv_details = Object.keys(patch.item_rv_details || {}).length;
    payload.totals.items_with_held_item_details = Object.keys(patch.item_held_details || {}).length;
    payload.totals.rv_level_unlock_items = (payload.entries || []).filter((entry) => entry.rv_details?.unlock_requirement?.rv_level).length;
    payload.totals.rv_components = (payload.entries || []).filter((entry) => entry.rv_details?.component).length;
    payload.totals.rv_production_unlock_items = (payload.entries || []).filter((entry) => entry.rv_details?.production_unlocks?.length).length;
    payload.totals.developer_only_items = (payload.entries || []).filter((entry) => entry.client_visibility?.status === "developer-only").length;
    payload.totals.player_facing_items = (payload.entries || []).length - payload.totals.developer_only_items;
    payload.totals.client_defined_items = (payload.entries || []).filter((entry) => entry.client_visibility?.reason !== "legacy-map-alias").length;
    payload.totals.items_with_client_source_references = (payload.entries || []).filter((entry) => entry.source_references?.length).length;
    payload.totals.items_with_unlock_references = (payload.entries || []).filter((entry) => entry.unlock_references?.length).length;
    payload.totals.items_with_map_targets = (payload.entries || []).filter((entry) => entry.map_targets?.length).length;
    payload.client_visibility_policy = patch.item_visibility_policy || "";
  }
  if (filename === "aniilog_data.json") {
    const byFormId = new Map((payload.entries || []).map((entry) => [String(entry.form_id), entry]));
    for (const entry of patch.aniimo_entries || []) byFormId.set(String(entry.form_id), entry);
    payload.entries = [...byFormId.values()];
    for (const entry of payload.entries || []) {
      if (Object.hasOwn(patch.aniimo_traits || {}, entry.form_id)) entry.traits = patch.aniimo_traits[entry.form_id];
      if (Object.hasOwn(patch.aniimo_abilities || {}, entry.form_id)) {
        const abilities = patch.aniimo_abilities[entry.form_id];
        entry.skills = abilities.skills || [];
        entry.ultimates = abilities.ultimates || [];
        entry.mobility_skills = abilities.mobility_skills || [];
      }
    }
    payload.generated_at = patch.generated_at;
    payload.publication_status = "private_reviewed";
    payload.data_quality = {
      ...(payload.data_quality || {}),
      trait_policy: "Exactly one trait per published form, joined to its assigned feature ID in build 3535596 pet_data; catalog-only traits are excluded.",
      trait_forms_reconciled: Object.keys(patch.aniimo_traits || {}).length,
      traits_without_icons: (payload.entries || []).flatMap((entry) => (entry.traits || [])
        .filter((trait) => !trait.icon)
        .map((trait) => ({ form_id: entry.form_id, trait_id: trait.trait_id }))),
      ability_descriptions_added_in_3535596: Object.keys(patch.aniimo_abilities || {}).length,
      abilities_without_descriptions: (payload.entries || []).flatMap((entry) => [
        ...(entry.skills || []).map((ability) => ({ form_id: entry.form_id, field: "skills", ability })),
        ...(entry.ultimates || []).map((ability) => ({ form_id: entry.form_id, field: "ultimates", ability })),
        ...(entry.mobility_skills || []).map((ability) => ({ form_id: entry.form_id, field: "mobility_skills", ability })),
      ].filter(({ ability }) => !ability.description).map(({ form_id, field, ability }) => ({ form_id, field, name: ability.name }))),
      entries_without_traits: (payload.entries || []).filter((entry) => !entry.traits?.length).map((entry) => entry.form_id),
      special_roster_policy: "Lunara, Fennelun, Helion, and Soleon are current-client special forms outside the ordinary country roster and are joined by stable form ID.",
    };
    payload.totals.entries = payload.entries.length;
    payload.totals.starter_special_forms = (patch.aniimo_entries || []).length;
    payload.totals.starter_special_families = 2;
  }
  if (filename === "aniilog_media.json") {
    const byFormId = new Map((payload.entries || []).map((entry) => [String(entry.form_id), entry]));
    for (const entry of patch.aniimo_media_entries || []) byFormId.set(String(entry.form_id), entry);
    payload.entries = [...byFormId.values()];
  }
  if (filename === "checklist_data.json") {
    payload.special_entries = patch.checklist_special_entries || [];
    payload.lumin_guides = patch.lumin_guides || [];
    payload.totals.special_entries = payload.special_entries.length;
  }

  const body = JSON.stringify(payload);
  await env.CONTENT.put(key, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return env.CONTENT.get(key);
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

export function developerAccountAllowed(discordId, env) {
  const allowedIds = String(env.DEVELOPER_DISCORD_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d{15,22}$/u.test(value));
  return allowedIds.includes(String(discordId || "")) || administratorAccountAllowed(discordId, env);
}

export function administratorAccountAllowed(discordId, env) {
  const allowedIds = String(env.ADMIN_DISCORD_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^\d{15,22}$/u.test(value));
  return allowedIds.includes(String(discordId || ""));
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
  const administrator = administratorAccountAllowed(row.discordId, env);
  let developer = developerAccountAllowed(row.discordId, env);
  if (!developer) {
    try {
      developer = Boolean(await env.DB.prepare(
        "SELECT discord_id AS discordId FROM developer_roles WHERE discord_id = ? LIMIT 1",
      ).bind(String(row.discordId)).first());
    } catch (error) {
      console.error("Could not read developer role", error);
    }
  }
  return {
    discordId: String(row.discordId),
    username: String(row.discordUsername),
    globalName: row.discordGlobalName ? String(row.discordGlobalName) : null,
    avatarUrl: discordAvatarUrl({ id: row.discordId, avatar: row.discordAvatarHash }),
    displayName: row.displayName ? String(row.displayName) : null,
    profilePublic: Number(row.isPublic) === 1,
    sessionExpiresAt: Number(row.expiresAt),
    developerModeAvailable: developer,
    developerAdminAvailable: administrator,
  };
}

async function updateDeveloperRole(request, env, discordId, enabled) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account?.developerAdminAvailable) return json({ error: "Developer administrator access required." }, 403);
  if (!/^\d{15,22}$/u.test(discordId)) return json({ error: "A valid Discord user ID is required." }, 400);
  if (administratorAccountAllowed(discordId, env)) {
    return json({ error: "Owner access is configured separately and cannot be changed here." }, 403);
  }
  const now = Math.floor(Date.now() / 1000);
  if (enabled) {
    await env.DB.prepare(
      `INSERT INTO developer_roles (discord_id, granted_by_discord_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET granted_by_discord_id = excluded.granted_by_discord_id`,
    ).bind(discordId, account.discordId, now).run();
  } else {
    await env.DB.prepare("DELETE FROM developer_roles WHERE discord_id = ?").bind(discordId).run();
  }
  return json({ ok: true, discordId, developer: enabled });
}

async function listDeveloperAccounts(request, env) {
  const account = await currentAccount(request, env);
  if (!account?.developerAdminAvailable) return json({ error: "Developer administrator access required." }, 403);
  const result = await env.DB.prepare(
    `SELECT users.discord_id AS discordId,
            users.discord_username AS discordUsername,
            users.discord_global_name AS discordGlobalName,
            developer_roles.discord_id AS grantedDeveloperId
       FROM users
       LEFT JOIN developer_roles ON developer_roles.discord_id = users.discord_id
      ORDER BY users.updated_at DESC, users.discord_id ASC
      LIMIT 201`,
  ).all();
  const rows = result?.results || [];
  return json({
    accounts: rows.slice(0, 200).map((row) => {
      const discordId = String(row.discordId);
      const developerAdminAvailable = administratorAccountAllowed(discordId, env);
      return {
        discordId,
        discordUsername: String(row.discordUsername),
        discordGlobalName: row.discordGlobalName ? String(row.discordGlobalName) : null,
        developerModeAvailable: Boolean(row.grantedDeveloperId)
          || developerAccountAllowed(discordId, env),
        developerAdminAvailable,
      };
    }),
    truncated: rows.length > 200,
  });
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
  const payload = { schemaVersion: 1, tracking, completed, preferences };
  if (value.completedChanges !== undefined) {
    const changes = completionChanges(value.completedChanges);
    if (!changes) return null;
    if (Object.keys(changes).length) payload.completedChanges = changes;
  }
  return payload;
}

const MAX_COMPLETION_CHANGES = 15000;

// The change log behind completion flags: { id: [1 = set | 0 = cleared, unix ms] }. It lets the website, other
// devices and the desktop app each change flags without a stale copy undoing a newer change.
export function completionChanges(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_COMPLETION_CHANGES) return null;
  const changes = {};
  for (const [id, change] of entries) {
    if (!id || id.length > 240 || !Array.isArray(change) || change.length !== 2) return null;
    if ((change[0] !== 0 && change[0] !== 1) || !Number.isSafeInteger(change[1]) || change[1] < 0) return null;
    changes[id] = [change[0], change[1]];
  }
  return changes;
}

// Newest change wins per flag. A flag listed as completed without a logged change counts as set at time 0, so any
// logged clear overrides it, and a flag missing from one side is not a clear.
export function mergeCompletion(...snapshots) {
  const latest = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    const changes = snapshot.completedChanges || {};
    for (const id of snapshot.completed || []) {
      if (!changes[id] && !latest.has(id)) latest.set(id, [1, 0]);
    }
    for (const [id, change] of Object.entries(changes)) {
      const prior = latest.get(id);
      if (!prior || change[1] > prior[1] || (change[1] === prior[1] && change[0] === 1)) latest.set(id, change);
    }
  }
  const completed = [...latest].filter(([, change]) => change[0] === 1).map(([id]) => id);
  const logged = [...latest].filter(([, change]) => change[1] > 0)
    .sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_COMPLETION_CHANGES);
  return { completed, completedChanges: Object.fromEntries(logged) };
}

function withCompletion(progress, completion) {
  const next = { ...progress, completed: completion.completed };
  delete next.completedChanges;
  if (Object.keys(completion.completedChanges).length) next.completedChanges = completion.completedChanges;
  return next;
}

async function storedProgressRow(env, discordId) {
  return env.DB.prepare(
    "SELECT revision, data_json AS dataJson, updated_at AS updatedAt FROM progress_snapshots WHERE discord_id = ?",
  ).bind(discordId).first();
}

// Read-modify-write of one account's snapshot, retried when another write lands in between.
async function updateProgress(env, discordId, change) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await storedProgressRow(env, discordId);
    let previous = null;
    if (row) {
      try {
        previous = progressPayload(JSON.parse(row.dataJson));
      } catch {
        previous = null;
      }
    }
    const next = change(previous);
    const encoded = JSON.stringify(next);
    if (encoder.encode(encoded).byteLength > MAX_PROGRESS_BYTES) return { error: "Progress payload is too large.", status: 413 };
    const now = Math.floor(Date.now() / 1000);
    const result = row
      ? await env.DB.prepare(
        "UPDATE progress_snapshots SET revision = revision + 1, data_json = ?, updated_at = ? WHERE discord_id = ? AND revision = ?",
      ).bind(encoded, now, discordId, Number(row.revision)).run()
      : await env.DB.prepare(
        `INSERT INTO progress_snapshots (discord_id, revision, data_json, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?) ON CONFLICT(discord_id) DO NOTHING`,
      ).bind(discordId, encoded, now, now).run();
    if (Number(result?.meta?.changes) === 1) {
      const saved = await storedProgressRow(env, discordId);
      return { progress: next, revision: Number(saved.revision), updatedAt: Number(saved.updatedAt) };
    }
  }
  return { error: "Progress changed during the save. Try again.", status: 409 };
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
  // Only the explicit owner mode endpoint may change this server-owned flag; an old tab's stale value is ignored.
  delete progress.preferences.developerMode;
  const saved = await updateProgress(env, account.discordId, (previous) => {
    const next = withCompletion(progress, mergeCompletion(previous, progress));
    const developerMode = previous?.preferences?.developerMode;
    if (typeof developerMode === "boolean") next.preferences = { ...next.preferences, developerMode };
    return next;
  });
  if (saved.error) return json({ error: saved.error }, saved.status);
  return json({ ok: true, revision: saved.revision, updatedAt: saved.updatedAt });
}

// Completion flags for the desktop app (desktop token) or the website (session): read them, or set and clear some.
async function getCompletion(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const row = await storedProgressRow(env, account.discordId);
  let progress = null;
  try {
    progress = row ? progressPayload(JSON.parse(row.dataJson)) : null;
  } catch {
    progress = null;
  }
  return json({ revision: Number(row?.revision || 0), completed: progress?.completed || [] });
}

function completionIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5000) return null;
  const ids = value.map((id) => (typeof id === "string" ? id.trim() : ""));
  return ids.every((id) => id && id.length <= 240) ? ids : null;
}

async function patchCompletion(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 256 * 1024);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const set = completionIds(body?.set);
  const clear = completionIds(body?.clear);
  if (!set || !clear || !(set.length + clear.length)) {
    return json({ error: "Send set and/or clear as lists of completion ids." }, 400);
  }
  const now = Date.now();
  const changes = Object.fromEntries([...clear.map((id) => [id, [0, now]]), ...set.map((id) => [id, [1, now]])]);
  const saved = await updateProgress(env, account.discordId, (previous) => withCompletion(
    previous || { schemaVersion: 1, tracking: [], completed: [], preferences: {} },
    mergeCompletion(previous, { completed: [], completedChanges: changes }),
  ));
  if (saved.error) return json({ error: saved.error }, saved.status);
  return json({ ok: true, revision: saved.revision, set: set.length, cleared: clear.length });
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
    "SELECT display_name AS displayName, bio, is_public AS isPublic, public_id AS publicId, updated_at AS updatedAt FROM profiles WHERE discord_id = ?",
  ).bind(account.discordId).first();
  const isPublic = Number(row?.isPublic || 0) === 1;
  return json({ profile: { ...row, isPublic, publicId: isPublic ? row?.publicId || null : null } });
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
  if (body.isPublic !== undefined && typeof body.isPublic !== "boolean") {
    return json({ error: "isPublic must be true or false." }, 400);
  }
  // Private by default: a profile only becomes public when its owner sends isPublic: true, and editing the name or
  // bio never changes its visibility. A public profile gets a random id for its link (never the Discord id).
  const current = await env.DB.prepare("SELECT is_public AS isPublic, public_id AS publicId FROM profiles WHERE discord_id = ?")
    .bind(account.discordId).first();
  const isPublic = typeof body.isPublic === "boolean" ? body.isPublic : Number(current?.isPublic || 0) === 1;
  const publicId = current?.publicId || (isPublic ? shareId() + shareId().slice(0, 4) : null);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE profiles SET display_name = ?, bio = ?, is_public = ?, public_id = ?, updated_at = ? WHERE discord_id = ?",
  ).bind(displayName, bio || null, isPublic ? 1 : 0, publicId, now, account.discordId).run();
  return json({ ok: true, profile: { displayName, bio: bio || null, isPublic, publicId: isPublic ? publicId : null, updatedAt: now } });
}

// ---------------------------------------------------------------- profile overview
// Everything the owner's profile gathers: linked characters, leaderboard standing and collection progress.
// Profiles are private, so this is only ever the signed-in owner's own overview.

// Parsed once per content bucket binding for the life of the isolate.
const checklistCache = new WeakMap();

// The release checklist gives the totals and Lumen amounts; without it the overview still counts flags.
async function releaseChecklist(env) {
  if (String(env.CONTENT_RELEASE_ENABLED || "").toLowerCase() !== "true" || !env.CONTENT) return null;
  if (checklistCache.has(env.CONTENT)) return checklistCache.get(env.CONTENT);
  try {
    const key = `releases/${CONTENT_RELEASE}/data/checklist_data.json`;
    const object = await env.CONTENT.get(key)
      || await materializeReleaseData(key, env)
      || await env.CONTENT.get(`releases/${ASSET_FALLBACK_RELEASE}/data/checklist_data.json`);
    if (!object) return null;
    const checklist = await new Response(object.body).json();
    checklistCache.set(env.CONTENT, checklist);
    return checklist;
  } catch (error) {
    console.error("Could not read the release checklist", error);
    return null;
  }
}

function completionQuantity(state) {
  const value = Number(state?.quantity ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

// Collection progress from completion flags: Aniilog standard/sparkling, special records, Lumens and map pins.
export function collectionSummary(completedIds, checklist = null) {
  const completed = new Set(completedIds || []);
  const flagged = (pattern) => [...completed].filter((id) => pattern.test(id)).length;
  const summary = {
    aniilog: {
      standard: flagged(/^aniimo:[^:]+:standard$/u),
      sparkling: flagged(/^aniimo:[^:]+:sparkling$/u),
      forms: null,
      special: flagged(/^aniimo-special:[^:]+:recorded$/u),
      specialTotal: null,
    },
    lumens: { sources: flagged(/^amber:.+:collected$/u), sourceTotal: null, collected: null, total: null },
    pins: { collected: flagged(/^pin:.+:collected$/u) },
  };
  if (!checklist || !Array.isArray(checklist.entries)) return summary;
  const forms = checklist.entries.filter((entry) => entry?.category === "aniimo" && entry.counts_toward_total !== false);
  summary.aniilog.forms = forms.length;
  summary.aniilog.specialTotal = Array.isArray(checklist.special_entries) ? checklist.special_entries.length : null;
  const seen = new Set();
  const lumens = { sources: 0, sourceTotal: 0, collected: 0, total: 0 };
  for (const entry of checklist.entries) {
    if (entry?.category !== "ambers") continue;
    for (const state of entry.completion_states || []) {
      const id = String(state?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      lumens.sourceTotal += 1;
      lumens.total += completionQuantity(state);
      if (completed.has(id)) {
        lumens.sources += 1;
        lumens.collected += completionQuantity(state);
      }
    }
  }
  summary.lumens = lumens;
  return summary;
}

// The owner's best entry on each board (as the board shows it) and its position among every player on that board.
// Interlink boss boards rank per boss, Egg Heist per season, the rest across everyone.
async function boardStandings(env, discordId, kind) {
  const sortKey = LEADERBOARD_DEFAULT_SORT[kind];
  const order = LEADERBOARD_SORTS[sortKey];
  const orderBy = (prefix) => (sortKey === "standing"
    ? ["rank_tier", "stars", "score"].map((column) => `COALESCE(${prefix}${column}, 0) ${order}`).join(", ")
    : `${prefix}${sortKey} ${order}`);
  const where = ["s.kind = ?", "s.status = 'visible'"];
  if (sortKey === "standing") where.push("(s.rank_tier IS NOT NULL OR s.score IS NOT NULL)");
  else where.push(`s.${sortKey} IS NOT NULL`);
  if (sortKey === "clear_time_s") where.push("COALESCE(s.cleared, 1) = 1");
  const group = kind === "interlink_run" || kind === "interlink_best" ? "boss_id" : kind === "eggheist_season" ? "cycle" : "";
  const partition = group ? `s.discord_id, s.${group}` : "s.discord_id";
  const { results } = await env.DB.prepare(
    `WITH best AS (
       SELECT s.*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${orderBy("s.")}, s.created_at ASC) AS playerRank
       FROM leaderboard_submissions s WHERE ${where.join(" AND ")}
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY ${group || "kind"} ORDER BY ${orderBy("")}, created_at ASC) AS position,
         COUNT(*) OVER (PARTITION BY ${group || "kind"}) AS players
       FROM best WHERE playerRank = 1
     )
     SELECT ranked.*, gc.character_name AS characterName FROM ranked
     LEFT JOIN game_characters gc ON gc.game_uid = ranked.game_uid AND gc.discord_id = ranked.discord_id
     WHERE ranked.discord_id = ?
     ORDER BY ${kind === "eggheist_season" ? "cycle DESC" : group ? "boss_name, boss_id" : "position"}`,
  ).bind(kind, discordId).all();
  return (results || []).map((row) => ({
    position: Number(row.position),
    players: Number(row.players),
    submissionId: row.submission_id,
    character: row.characterName || null,
    gameUid: row.game_uid,
    cycle: row.cycle,
    boss: row.boss_id == null ? null : { id: row.boss_id, name: row.boss_name, level: row.boss_level },
    score: row.score,
    seasonRank: row.rank_tier == null ? null : { tier: row.rank_tier, subtier: row.rank_subtier, name: row.rank_name },
    stars: row.stars,
    clearTimeS: row.clear_time_s,
    floors: row.floors,
    partySize: row.party_size,
    playedAt: row.played_at,
  }));
}

async function ownProfileOverview(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const [profile, characters, progressRow] = await Promise.all([
    env.DB.prepare(
      "SELECT display_name AS displayName, bio, is_public AS isPublic FROM profiles WHERE discord_id = ?",
    ).bind(account.discordId).first(),
    env.DB.prepare(
      `SELECT game_uid AS gameUid, character_name AS name, last_seen_at AS lastSeenAt
       FROM game_characters WHERE discord_id = ? ORDER BY last_seen_at DESC`,
    ).bind(account.discordId).all(),
    storedProgressRow(env, account.discordId),
  ]);
  let completed = [];
  try {
    completed = progressRow ? progressPayload(JSON.parse(progressRow.dataJson))?.completed || [] : [];
  } catch {
    completed = [];
  }
  // Board positions follow the leaderboard gate: hidden while leaderboards are a preview the owner can't read.
  let leaderboards = null;
  if (leaderboardAllowed(account, env)) {
    const kinds = Object.keys(LEADERBOARD_KINDS);
    const standings = await Promise.all(kinds.map((kind) => boardStandings(env, account.discordId, kind)));
    leaderboards = Object.fromEntries(kinds.map((kind, index) => [kind, standings[index]]));
    leaderboards.interlinkSeason = await interlinkSeasonStanding(env, account.discordId);
  }
  return json({
    profile: {
      displayName: profile?.displayName || account.globalName || account.username,
      bio: profile?.bio || null,
      avatarUrl: account.avatarUrl,
      isPublic: Number(profile?.isPublic || 0) === 1,
    },
    characters: characters.results || [],
    leaderboards,
    collection: collectionSummary(completed, await releaseChecklist(env)),
    progressUpdatedAt: progressRow ? Number(progressRow.updatedAt) : null,
  });
}

// A profile its owner made public: name, about, characters, board standing and collection progress. No Discord
// identity (id, username, avatar). Private or unknown ids are a plain 404.
async function publicProfile(request, env, publicId) {
  const profile = await env.DB.prepare(
    "SELECT discord_id AS discordId, bio FROM profiles WHERE public_id = ? AND is_public = 1",
  ).bind(publicId).first();
  if (!profile) return json({ error: "Profile not found." }, 404);
  const [characters, progressRow] = await Promise.all([
    env.DB.prepare("SELECT character_name AS name FROM game_characters WHERE discord_id = ? AND character_name IS NOT NULL ORDER BY last_seen_at DESC")
      .bind(profile.discordId).all(),
    storedProgressRow(env, profile.discordId),
  ]);
  let completed = [];
  try {
    completed = progressRow ? progressPayload(JSON.parse(progressRow.dataJson))?.completed || [] : [];
  } catch {
    completed = [];
  }
  let leaderboards = null;
  if (leaderboardPublic(env)) {
    const kinds = Object.keys(LEADERBOARD_KINDS);
    const standings = await Promise.all(kinds.map((kind) => boardStandings(env, profile.discordId, kind)));
    leaderboards = Object.fromEntries(kinds.map((kind, index) => [kind, standings[index].map(({ gameUid, ...entry }) => entry)]));
    leaderboards.interlinkSeason = await interlinkSeasonStanding(env, profile.discordId);
  }
  return json({
    profile: { displayName: characters.results?.[0]?.name || "Pathfinder", bio: profile.bio || null, avatarUrl: null, isPublic: true },
    characters: (characters.results || []).map((row) => ({ name: row.name })),
    leaderboards,
    collection: collectionSummary(completed, await releaseChecklist(env)),
  });
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
  if (env.EVIDENCE) {
    const { results } = await env.DB.prepare(
      "SELECT evidence_key AS evidenceKey FROM leaderboard_submissions WHERE discord_id = ? AND evidence_key IS NOT NULL",
    ).bind(discordId).all();
    for (const row of results || []) await env.EVIDENCE.delete(row.evidenceKey);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_handoffs WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM leaderboard_tokens WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM leaderboard_submissions WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM game_characters WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM map_shares WHERE creator_discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM progress_snapshots WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM profiles WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM sessions WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM users WHERE discord_id = ?").bind(discordId),
  ]);
  return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
}

// ---------------------------------------------------------------- leaderboards
// Holo-Battle Interlink and Holo-Battle Sim records submitted by the desktop meter, which reads the game's own
// result screens. Gated: until LEADERBOARD_PUBLIC is "true", only developer accounts can submit or read.

// Interlink (boss rush) weeks from the game client data (bossrush cycle table, region 1 times): which three bosses
// each week has and the season it belongs to. Regenerate when a game patch adds weeks.
const INTERLINK_CYCLES = Object.freeze([
  {"id":"1","season":0,"start":1760644800,"end":1769155199,"level":36,"bosses":[{"id":"80000095","name":"Alpha Geoclaw"},{"id":"80000096","name":"Alpha Minespine"},{"id":"80000097","name":"Alpha Tubster"}]},
  {"id":"1000","season":0,"start":1769630400,"end":1770278399,"level":36,"bosses":[{"id":"80000095","name":"Alpha Geoclaw"},{"id":"80000096","name":"Alpha Minespine"},{"id":"80000097","name":"Alpha Tubster"}]},
  {"id":"1001","season":0,"start":1770235200,"end":1770623999,"level":36,"bosses":[{"id":"80000098","name":"Alpha Scorchhowl"},{"id":"80000096","name":"Alpha Minespine"},{"id":"80000097","name":"Alpha Tubster"}]},
  {"id":"1002","season":1,"start":1770580800,"end":1775375999,"level":60,"bosses":[{"id":"80000095","name":"Alpha Geoclaw"},{"id":"80000096","name":"Alpha Minespine"},{"id":"80000097","name":"Alpha Tubster"}]},
  {"id":"1003","season":0,"start":1775332800,"end":1782806399,"level":36,"bosses":[{"id":"80000099","name":"Alpha Irisal"},{"id":"80000097","name":"Alpha Tubster"},{"id":"80000101","name":"Alpha Bouldus"}]},
  {"id":"2000","season":116,"start":1783540800,"end":1784534399,"level":60,"bosses":[{"id":"80000099","name":"Alpha Irisal"},{"id":"80000097","name":"Alpha Tubster"},{"id":"80000101","name":"Alpha Bouldus"}]},
  {"id":"2001","season":116,"start":1784145600,"end":1785139199,"level":60,"bosses":[{"id":"80000098","name":"Alpha Scorchhowl"},{"id":"80000096","name":"Alpha Minespine"},{"id":"80000102","name":"Alpha Panpanta"}]},
  {"id":"2002","season":116,"start":1784750400,"end":1785743999,"level":60,"bosses":[{"id":"80000099","name":"Alpha Irisal"},{"id":"80000097","name":"Alpha Tubster"},{"id":"80000101","name":"Alpha Bouldus"}]},
  {"id":"3000","season":1,"start":1790193600,"end":1790582399,"level":1,"bosses":[{"id":"80000099","name":"Alpha Irisal"},{"id":"80000097","name":"Alpha Tubster"},{"id":"80000101","name":"Alpha Bouldus"}]},
  {"id":"3001","season":1,"start":1790798400,"end":1791187199,"level":1,"bosses":[{"id":"80000098","name":"Alpha Scorchhowl"},{"id":"80000096","name":"Alpha Minespine"},{"id":"80000103","name":"Alpha Luminelle"}]},
  {"id":"3002","season":1,"start":1791403200,"end":1791791999,"level":1,"bosses":[{"id":"80000104","name":"Alpha Blazen"},{"id":"80000105","name":"Omega Sherro"},{"id":"80000106","name":"Alpha Grizbo"}]},
  {"id":"3003","season":1,"start":1792008000,"end":1792396799,"level":1,"bosses":[{"id":"80000099","name":"Alpha Irisal"},{"id":"80000102","name":"Alpha Panpanta"},{"id":"80000108","name":"Alpha Rookey"}]},
  {"id":"3005","season":1,"start":1792612800,"end":1793001599,"level":1,"bosses":[{"id":"80000109","name":"Omega Sherro"},{"id":"80000107","name":"Omega Infergon"},{"id":"80000100","name":"Omega Tucking"}]},
]);

const LEADERBOARD_TOKEN_PREFIX = "alb_";
const MAX_SUBMISSION_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const EVIDENCE_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
const LEADERBOARD_KINDS = Object.freeze({
  interlink_run: "interlink",
  interlink_week: "interlink",
  interlink_best: "interlink",
  sim_run: "sim",
  eggheist_season: "eggheist",
});
const LEADERBOARD_MODES = Object.freeze(["interlink", "sim", "eggheist"]);
// Sortable columns and their natural direction (lower clear time is better).
const LEADERBOARD_SORTS = Object.freeze({
  standing: "DESC",
  score: "DESC",
  stars: "DESC",
  clear_time_s: "ASC",
  team_dps: "DESC",
  meter_dps: "DESC",
  meter_damage: "DESC",
  floors: "DESC",
  party_size: "ASC",
  boss_level: "DESC",
  played_at: "DESC",
});
const LEADERBOARD_DEFAULT_SORT = Object.freeze({
  interlink_run: "score",
  interlink_week: "score",
  interlink_best: "score",
  sim_run: "clear_time_s",
  eggheist_season: "standing",
});

export function leaderboardPublic(env) {
  return String(env?.LEADERBOARD_PUBLIC || "").toLowerCase() === "true";
}

async function accountIsDeveloper(discordId, env) {
  if (developerAccountAllowed(discordId, env)) return true;
  try {
    return Boolean(await env.DB.prepare(
      "SELECT discord_id AS discordId FROM developer_roles WHERE discord_id = ? LIMIT 1",
    ).bind(String(discordId)).first());
  } catch (error) {
    console.error("Could not read developer role", error);
    return false;
  }
}

function bearerToken(request) {
  return (request.headers.get("authorization") || "").match(/^Bearer ([A-Za-z0-9_-]{32,256})$/u)?.[1] || "";
}

// The desktop app authenticates with a leaderboard token; the website with its normal session.
async function leaderboardAccount(request, env) {
  if (!env.DB) return null;
  const raw = bearerToken(request);
  if (raw.startsWith(LEADERBOARD_TOKEN_PREFIX)) {
    const tokenHash = await sha256(raw);
    const row = await env.DB.prepare(
      `SELECT leaderboard_tokens.discord_id AS discordId
       FROM leaderboard_tokens
       JOIN users ON users.discord_id = leaderboard_tokens.discord_id
       WHERE leaderboard_tokens.token_hash = ? AND leaderboard_tokens.revoked_at IS NULL
       LIMIT 1`,
    ).bind(tokenHash).first();
    if (!row) return null;
    await env.DB.prepare("UPDATE leaderboard_tokens SET last_used_at = ? WHERE token_hash = ?")
      .bind(Math.floor(Date.now() / 1000), tokenHash).run();
    const discordId = String(row.discordId);
    return { discordId, viaToken: true, developerModeAvailable: await accountIsDeveloper(discordId, env) };
  }
  const account = await currentAccount(request, env);
  return account ? { ...account, viaToken: false } : null;
}

function leaderboardAllowed(account, env) {
  return leaderboardPublic(env) || Boolean(account?.developerModeAvailable);
}

function gatedResponse(account) {
  return account
    ? json({ error: "Leaderboards are in developer preview." }, 403)
    : json({ error: "Authentication required." }, 401);
}

async function leaderboardStatus(request, env) {
  const account = await leaderboardAccount(request, env);
  return json({
    public: leaderboardPublic(env),
    authenticated: Boolean(account),
    canRead: leaderboardAllowed(account, env),
    canSubmit: Boolean(account) && leaderboardAllowed(account, env),
    canModerate: Boolean(account?.developerModeAvailable),
    evidenceStorage: Boolean(env.EVIDENCE),
  });
}

async function createLeaderboardToken(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  let body;
  try {
    body = await readJsonBody(request, 1024);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const label = String(body.label || "Desktop meter").trim().slice(0, 60) || "Desktop meter";
  const raw = `${LEADERBOARD_TOKEN_PREFIX}${randomToken(36)}`;
  const tokenHash = await sha256(raw);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO leaderboard_tokens (token_hash, discord_id, label, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, account.discordId, label, now).run();
  return json({ token: raw, tokenId: tokenHash.slice(0, 12), label, createdAt: now }, 201);
}

async function listLeaderboardTokens(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const { results } = await env.DB.prepare(
    `SELECT token_hash AS tokenHash, label, created_at AS createdAt, last_used_at AS lastUsedAt
     FROM leaderboard_tokens WHERE discord_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(account.discordId).all();
  return json({
    tokens: (results || []).map((row) => ({
      tokenId: String(row.tokenHash).slice(0, 12),
      label: row.label,
      createdAt: Number(row.createdAt),
      lastUsedAt: row.lastUsedAt == null ? null : Number(row.lastUsedAt),
    })),
  });
}

async function revokeLeaderboardToken(request, env, tokenId) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!/^[A-Za-z0-9_-]{12}$/u.test(tokenId)) return json({ error: "Token not found." }, 404);
  const result = await env.DB.prepare(
    `UPDATE leaderboard_tokens SET revoked_at = ?
     WHERE discord_id = ? AND substr(token_hash, 1, 12) = ? AND revoked_at IS NULL`,
  ).bind(Math.floor(Date.now() / 1000), account.discordId, tokenId).run();
  if (Number(result.meta?.changes || 0) < 1) return json({ error: "Token not found." }, 404);
  return json({ ok: true });
}

function boundedInteger(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

function boundedNumber(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

function boundedText(value, maxLength, pattern = null) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength || (pattern && !pattern.test(text))) return undefined;
  return text;
}

// Validates and normalizes one desktop submission. Returns { record } or { error }.
export function leaderboardSubmission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Submission must be an object." };
  const kind = String(value.kind || "");
  const mode = LEADERBOARD_KINDS[kind];
  if (!mode) return { error: "Unknown submission kind." };
  const boss = value.boss && typeof value.boss === "object" ? value.boss : {};
  const rank = value.rank && typeof value.rank === "object" ? value.rank : {};
  const record = {
    kind,
    mode,
    clientRunId: boundedText(value.clientRunId, 120, /^[A-Za-z0-9_.:-]+$/u),
    gameUid: boundedText(value.gameUid, 24, /^\d+$/u),
    cycle: boundedText(value.cycle, 24, /^[A-Za-z0-9_.-]+$/u),
    bossId: boundedText(boss.id, 24, /^[A-Za-z0-9_-]+$/u),
    bossName: boundedText(boss.name, 80),
    bossLevel: boundedInteger(boss.level, 1, 200),
    score: boundedInteger(value.score, 0, 1e9),
    rankTier: boundedInteger(rank.tier, 1, 7),
    rankSubtier: boundedInteger(rank.subtier, 1, 10),
    rankName: boundedText(rank.name, 40),
    stars: boundedInteger(value.stars, 0, 10000),
    clearTimeS: boundedNumber(value.clearTimeS, 0, 7 * 24 * 3600),
    cleared: value.cleared === undefined || value.cleared === null ? null : (value.cleared ? 1 : 0),
    floors: boundedInteger(value.floors, 0, 100),
    teamDps: boundedInteger(value.teamDps, 0, 1e12),
    meterDps: boundedInteger(value.meterDps, 0, 1e12),
    meterDamage: boundedInteger(value.meterDamage, 0, 1e15),
    partySize: boundedInteger(value.partySize, 1, 4),
    clientVersion: boundedText(value.clientVersion, 40),
    playedAt: boundedInteger(value.playedAt, 1.5e9, 4e9),
  };
  const bad = Object.entries(record).find(([, field]) => field === undefined);
  if (bad) return { error: `Field ${bad[0]} is invalid.` };
  if (!record.clientRunId) return { error: "clientRunId is required." };

  const players = value.players ?? [];
  if (!Array.isArray(players) || players.length > 4) return { error: "players must be a list of up to 4." };
  const cleanPlayers = [];
  for (const player of players) {
    if (!player || typeof player !== "object" || Array.isArray(player)) return { error: "Each player must be an object." };
    const clean = {
      name: boundedText(player.name, 40),
      stat: boundedText(player.stat, 60),
      value: boundedInteger(player.value, 0, 1e15),
      avgDps: boundedInteger(player.avgDps, 0, 1e12),
      breakValue: boundedInteger(player.breakValue, 0, 1e15),
      damageTaken: boundedInteger(player.damageTaken, 0, 1e15),
      heal: boundedInteger(player.heal, 0, 1e15),
      ai: player.ai === undefined ? null : Boolean(player.ai),
    };
    if (Object.values(clean).some((field) => field === undefined)) return { error: "A player field is invalid." };
    cleanPlayers.push(clean);
  }

  const buffs = value.buffs ?? [];
  if (!Array.isArray(buffs) || buffs.length > 64) return { error: "buffs must be a list of up to 64." };
  const cleanBuffs = [];
  for (const buff of buffs) {
    if (!buff || typeof buff !== "object" || Array.isArray(buff)) return { error: "Each buff must be an object." };
    const clean = {
      name: boundedText(buff.name, 80),
      id: boundedText(buff.id, 24, /^[A-Za-z0-9_-]+$/u),
      floor: boundedInteger(buff.floor, 0, 100),
      level: boundedInteger(buff.level, 0, 100),
    };
    if (Object.values(clean).some((field) => field === undefined) || !clean.name) return { error: "A buff field is invalid." };
    cleanBuffs.push(clean);
  }

  let extraJson = null;
  if (value.extra !== undefined && value.extra !== null) {
    if (typeof value.extra !== "object" || Array.isArray(value.extra)) return { error: "extra must be an object." };
    extraJson = JSON.stringify(value.extra);
    if (encoder.encode(extraJson).byteLength > 8192) return { error: "extra is too large." };
  }
  record.playersJson = cleanPlayers.length ? JSON.stringify(cleanPlayers) : null;
  record.buffsJson = cleanBuffs.length ? JSON.stringify(cleanBuffs) : null;
  record.extraJson = extraJson;
  if (record.partySize === null && cleanPlayers.length) record.partySize = cleanPlayers.length;
  return { record };
}

async function readSubmissionRequest(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    return { body: await readJsonBody(request, MAX_SUBMISSION_BYTES), evidence: null };
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_SUBMISSION_BYTES + MAX_EVIDENCE_BYTES + 4096) throw new RangeError("Request body is too large.");
  const form = await request.formData();
  const text = String(form.get("submission") || "");
  if (encoder.encode(text).byteLength > MAX_SUBMISSION_BYTES) throw new RangeError("Submission is too large.");
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new TypeError("Submission must be valid JSON.");
  }
  const file = form.get("evidence");
  if (!file || typeof file === "string") return { body, evidence: null };
  if (!EVIDENCE_TYPES[file.type]) throw new TypeError("Evidence must be a JPEG, PNG or WebP image.");
  if (file.size > MAX_EVIDENCE_BYTES) throw new RangeError("Evidence image is too large.");
  return { body, evidence: file };
}

async function submitLeaderboardRecord(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  // Session-cookie writes must come from the site; bearer tokens can't be sent by another site automatically.
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let parsed;
  try {
    parsed = await readSubmissionRequest(request);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const { record, error } = leaderboardSubmission(parsed.body);
  if (error) return json({ error }, 400);
  if (record.gameUid) {
    const owner = await env.DB.prepare(
      "SELECT discord_id AS discordId FROM game_characters WHERE game_uid = ? LIMIT 1",
    ).bind(record.gameUid).first();
    if (owner && owner.discordId !== account.discordId) {
      return json({ error: "This character is linked to another account." }, 409);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare(
    `SELECT submission_id AS submissionId, evidence_key AS evidenceKey FROM leaderboard_submissions
     WHERE discord_id = ? AND kind = ? AND client_run_id = ? LIMIT 1`,
  ).bind(account.discordId, record.kind, record.clientRunId).first();
  const submissionId = existing?.submissionId || randomToken(12);
  let evidenceKey = existing?.evidenceKey || null;
  if (parsed.evidence && env.EVIDENCE) {
    evidenceKey = `evidence/${account.discordId}/${submissionId}.${EVIDENCE_TYPES[parsed.evidence.type]}`;
    await env.EVIDENCE.put(evidenceKey, parsed.evidence.stream(), {
      httpMetadata: { contentType: parsed.evidence.type },
    });
  }
  await env.DB.prepare(
    `INSERT INTO leaderboard_submissions (
      submission_id, discord_id, mode, kind, client_run_id, game_uid, cycle, boss_id, boss_name, boss_level,
      score, rank_tier, rank_subtier, rank_name, stars, clear_time_s, cleared, floors, team_dps, meter_dps, meter_damage, party_size,
      players_json, buffs_json, extra_json, evidence_key, client_version, played_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id, kind, client_run_id) DO UPDATE SET
      game_uid = excluded.game_uid, cycle = excluded.cycle, boss_id = excluded.boss_id,
      boss_name = excluded.boss_name, boss_level = excluded.boss_level, score = excluded.score,
      rank_tier = excluded.rank_tier, rank_subtier = excluded.rank_subtier, rank_name = excluded.rank_name,
      stars = excluded.stars, clear_time_s = excluded.clear_time_s, cleared = excluded.cleared,
      floors = excluded.floors, team_dps = excluded.team_dps, meter_dps = excluded.meter_dps,
      meter_damage = excluded.meter_damage, party_size = excluded.party_size,
      players_json = excluded.players_json, buffs_json = excluded.buffs_json, extra_json = excluded.extra_json,
      evidence_key = excluded.evidence_key, client_version = excluded.client_version,
      played_at = excluded.played_at, updated_at = excluded.updated_at`,
  ).bind(
    submissionId, account.discordId, record.mode, record.kind, record.clientRunId, record.gameUid, record.cycle,
    record.bossId, record.bossName, record.bossLevel, record.score, record.rankTier, record.rankSubtier, record.rankName, record.stars, record.clearTimeS,
    record.cleared, record.floors, record.teamDps, record.meterDps, record.meterDamage, record.partySize,
    record.playersJson, record.buffsJson, record.extraJson, evidenceKey, record.clientVersion,
    record.playedAt, now, now,
  ).run();
  return json({
    ok: true,
    submissionId,
    updated: Boolean(existing),
    evidenceStored: Boolean(parsed.evidence && env.EVIDENCE),
  }, existing ? 200 : 201);
}

// ---------------------------------------------------------------- linked game characters
async function listCharacters(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const { results } = await env.DB.prepare(
    `SELECT game_uid AS gameUid, character_name AS name, source, linked_at AS linkedAt, last_seen_at AS lastSeenAt
     FROM game_characters WHERE discord_id = ? ORDER BY last_seen_at DESC`,
  ).bind(account.discordId).all();
  return json({ characters: results || [] });
}

// Claims a character for the signed-in account. The desktop meter calls this with the UID it reads from the game's
// own log ("meter"); the website can add one by hand ("manual"). A UID linked to another account is refused.
async function linkCharacter(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 1024);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const gameUid = boundedText(body.gameUid, 24, /^\d+$/u);
  const name = boundedText(body.name, 40);
  if (!gameUid) return json({ error: "A numeric game UID is required." }, 400);
  if (name === undefined) return json({ error: "Character name is invalid." }, 400);
  const source = account.viaToken && body.source !== "manual" ? "meter" : "manual";
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare(
    "SELECT discord_id AS discordId FROM game_characters WHERE game_uid = ? LIMIT 1",
  ).bind(gameUid).first();
  if (existing && existing.discordId !== account.discordId) {
    return json({ error: "This character is already linked to another account. Ask a developer if it is yours." }, 409);
  }
  if (existing) {
    await env.DB.prepare(
      `UPDATE game_characters SET character_name = COALESCE(?, character_name), last_seen_at = ?,
         source = CASE WHEN ? = 'meter' THEN 'meter' ELSE source END
       WHERE game_uid = ?`,
    ).bind(name, now, source, gameUid).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(gameUid, account.discordId, name, source, now, now).run();
  }
  return json({ ok: true, gameUid, name, source, linked: !existing }, existing ? 200 : 201);
}

async function unlinkCharacter(request, env, gameUid) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const result = await env.DB.prepare(
    "DELETE FROM game_characters WHERE game_uid = ? AND (discord_id = ? OR ? = 1)",
  ).bind(gameUid, account.discordId, account.developerModeAvailable ? 1 : 0).run();
  if (Number(result.meta?.changes || 0) < 1) return json({ error: "Character not found." }, 404);
  return json({ ok: true });
}

// Developers settle disputes: move a UID to the account that really owns it.
async function reassignCharacter(request, env, gameUid) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account?.developerModeAvailable) return json({ error: "Developer access required." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 512);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const discordId = String(body.discordId || "");
  if (!/^\d{15,22}$/u.test(discordId)) return json({ error: "A valid Discord user ID is required." }, 400);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at)
     VALUES (?, ?, NULL, 'manual', ?, ?)
     ON CONFLICT(game_uid) DO UPDATE SET discord_id = excluded.discord_id, linked_at = excluded.linked_at`,
  ).bind(gameUid, discordId, now, now).run();
  return json({ ok: true, gameUid, discordId });
}

// Builds the WHERE clause shared by entries and facets from query parameters (all values are bound).
function leaderboardFilters(params, { includeHidden = false } = {}) {
  const where = [];
  const binds = [];
  const kind = String(params.get("kind") || "");
  if (LEADERBOARD_KINDS[kind]) {
    where.push("s.kind = ?");
    binds.push(kind);
  } else {
    const mode = LEADERBOARD_MODES.includes(params.get("mode")) ? params.get("mode") : "interlink";
    where.push("s.mode = ?");
    binds.push(mode);
  }
  if (!includeHidden) where.push("s.status = 'visible'");
  const exact = [["cycle", "s.cycle"], ["boss", "s.boss_id"], ["uid", "s.game_uid"]];
  for (const [name, column] of exact) {
    const value = String(params.get(name) || "").trim();
    if (value && value.length <= 40) {
      where.push(`${column} = ?`);
      binds.push(value);
    }
  }
  const integers = [["level", "s.boss_level"], ["party", "s.party_size"]];
  for (const [name, column] of integers) {
    const value = Number(params.get(name));
    if (params.get(name) && Number.isInteger(value)) {
      where.push(`${column} = ?`);
      binds.push(value);
    }
  }
  if (params.get("cleared") === "1") where.push("s.cleared = 1");
  const ranges = [["minScore", "s.score >= ?"], ["maxTime", "s.clear_time_s <= ?"], ["minFloors", "s.floors >= ?"]];
  for (const [name, clause] of ranges) {
    const value = Number(params.get(name));
    if (params.get(name) && Number.isFinite(value)) {
      where.push(clause);
      binds.push(value);
    }
  }
  const player = String(params.get("player") || "").trim().slice(0, 40);
  if (player) {
    where.push(`(gc.character_name LIKE ? ESCAPE '\\' OR s.players_json LIKE ? ESCAPE '\\')`);
    const like = `%${player.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
    binds.push(like, like);
  }
  const buff = String(params.get("buff") || "").trim().slice(0, 80);
  if (buff) {
    where.push("s.buffs_json LIKE ? ESCAPE '\\'");
    binds.push(`%"name":"${JSON.stringify(buff).slice(1, -1).replace(/[\\%_]/gu, (character) => `\\${character}`)}"%`);
  }
  return { where, binds, kind };
}

function parseJsonColumn(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Party members are matched to accounts by character name (names are unique in the game). Only members whose owner
// made their profile public get a link; everyone else, and AI teammates, show as plain names.
// Who a run belongs to, by in-game name: the linked character, else the 1P name from the result screen.
function firstPlayerName(playersJson) {
  const players = parseJsonColumn(playersJson);
  const name = Array.isArray(players) ? players[0]?.name : null;
  return name ? String(name).slice(0, 40) : null;
}

async function partyProfiles(env, rows) {
  const names = new Set();
  for (const row of rows) {
    for (const player of parseJsonColumn(row.players_json) || []) {
      if (player?.name && !player.ai) names.add(String(player.name).toLowerCase());
    }
  }
  if (!names.size) return new Map();
  const list = [...names].slice(0, 200);
  const { results } = await env.DB.prepare(
    `SELECT lower(gc.character_name) AS name, p.public_id AS publicId FROM game_characters gc
     JOIN profiles p ON p.discord_id = gc.discord_id
     WHERE p.is_public = 1 AND p.public_id IS NOT NULL AND lower(gc.character_name) IN (${list.map(() => "?").join(", ")})`,
  ).bind(...list).all();
  return new Map((results || []).map((row) => [row.name, row.publicId]));
}

function withProfiles(players, profiles) {
  if (!Array.isArray(players)) return players;
  return players.map((player) => {
    const publicId = player?.name && !player.ai ? profiles.get(String(player.name).toLowerCase()) : null;
    return publicId ? { ...player, profileId: publicId } : player;
  });
}

// ---------------------------------------------------------------- Interlink weeks and seasons
// Interlink runs weekly: each week (cycle) has three bosses, and a player's week score is their best score on each
// of them added up; a season adds up its weeks. A player's best on a boss is the highest score from any of their
// result-screen runs or battle-prep bests for that week. Every past week stays viewable.

function interlinkCycle(id) {
  return INTERLINK_CYCLES.find((cycle) => cycle.id === String(id)) || null;
}

function currentInterlinkCycle(now = Math.floor(Date.now() / 1000)) {
  const started = INTERLINK_CYCLES.filter((cycle) => cycle.start <= now);
  return started.length ? started[started.length - 1] : INTERLINK_CYCLES[INTERLINK_CYCLES.length - 1];
}

// Best score per player per (week, boss), with each player's in-game name and public profile id (if public).
async function interlinkBests(env, cycles) {
  if (!cycles.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT s.discord_id AS discordId, s.cycle, s.boss_id AS bossId, MAX(s.boss_name) AS bossName,
       MAX(s.score) AS score, MAX(s.stars) AS stars,
       (SELECT character_name FROM game_characters gc WHERE gc.discord_id = s.discord_id AND gc.character_name IS NOT NULL
        ORDER BY gc.last_seen_at DESC LIMIT 1) AS player,
       (SELECT CASE WHEN p.is_public = 1 THEN p.public_id END FROM profiles p WHERE p.discord_id = s.discord_id) AS profileId,
       MIN(s.created_at) AS firstAt
     FROM leaderboard_submissions s
     WHERE s.status = 'visible' AND s.kind IN ('interlink_run', 'interlink_best') AND s.score IS NOT NULL
       AND s.boss_id IS NOT NULL AND s.cycle IN (${cycles.map(() => "?").join(", ")})
     GROUP BY s.discord_id, s.cycle, s.boss_id`,
  ).bind(...cycles).all();
  return results || [];
}

function ranked(rows, key) {
  return rows.sort((a, b) => b[key] - a[key] || a.firstAt - b.firstAt).map((row, index) => ({ rank: index + 1, ...row }));
}

function publicCycle(cycle) {
  return cycle ? { id: cycle.id, season: cycle.season, start: cycle.start, end: cycle.end, bosses: cycle.bosses } : null;
}

// One player's standing in an Interlink season (score, stars, weeks played, rank among everyone), for profiles.
async function interlinkSeasonStanding(env, discordId, season = currentInterlinkCycle().season) {
  const cycles = INTERLINK_CYCLES.filter((cycle) => cycle.season === season).map((cycle) => cycle.id);
  const totals = new Map();
  for (const row of await interlinkBests(env, cycles)) {
    const player = totals.get(row.discordId) || { total: 0, stars: 0, weeks: new Set(), firstAt: row.firstAt };
    player.total += Number(row.score) || 0; player.stars += Number(row.stars) || 0; player.weeks.add(row.cycle);
    player.firstAt = Math.min(player.firstAt, row.firstAt);
    totals.set(row.discordId, player);
  }
  const mine = totals.get(discordId);
  if (!mine) return { season, total: 0, stars: 0, weeks: 0, rank: null, players: totals.size };
  const rank = 1 + [...totals.values()].filter((p) => p.total > mine.total || (p.total === mine.total && p.firstAt < mine.firstAt)).length;
  return { season, total: mine.total, stars: mine.stars, weeks: mine.weeks.size, rank, players: totals.size };
}

async function interlinkBoards(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!leaderboardAllowed(account, env)) return gatedResponse(account);
  const params = new URL(request.url).searchParams;
  const own = (discordId) => Boolean(account && discordId === account.discordId);
  const weeks = INTERLINK_CYCLES.map(publicCycle);
  const seasonParam = params.get("season");
  if (seasonParam !== null) {
    // Season standings: every week of the season added up.
    const season = Number(seasonParam);
    const cycles = INTERLINK_CYCLES.filter((cycle) => cycle.season === season).map((cycle) => cycle.id);
    if (!cycles.length) return json({ error: "Unknown season." }, 404);
    const players = new Map();
    for (const row of await interlinkBests(env, cycles)) {
      const player = players.get(row.discordId) || { discordId: row.discordId, player: row.player || "Pathfinder",
        profileId: row.profileId || null, total: 0, stars: 0, weeks: new Set(), bosses: 0, firstAt: row.firstAt };
      player.total += Number(row.score) || 0; player.stars += Number(row.stars) || 0;
      player.weeks.add(row.cycle); player.bosses += 1;
      player.firstAt = Math.min(player.firstAt, row.firstAt);
      players.set(row.discordId, player);
    }
    const standings = ranked([...players.values()], "total").map(({ discordId, weeks: played, firstAt, ...row }) => ({
      ...row, weeks: played.size, own: own(discordId),
    }));
    return json({ season, weeks: weeks.filter((week) => week.season === season), standings });
  }
  // One week: the three boss boards and the week total.
  const cycle = interlinkCycle(params.get("cycle")) || currentInterlinkCycle();
  const rows = await interlinkBests(env, [cycle.id]);
  const bossIds = cycle.bosses.map((boss) => boss.id);
  for (const row of rows) {                                  // a boss the table doesn't list (newer game data)
    if (!bossIds.includes(String(row.bossId))) { bossIds.push(String(row.bossId)); }
  }
  const bosses = bossIds.map((id) => {
    const listed = cycle.bosses.find((boss) => boss.id === id);
    const entries = ranked(rows.filter((row) => String(row.bossId) === id).map((row) => ({ ...row })), "score")
      .map(({ discordId, cycle: _c, bossId, bossName, firstAt, ...row }) => ({ ...row, player: row.player || "Pathfinder", own: own(discordId) }));
    return { id, name: listed?.name || rows.find((row) => String(row.bossId) === id)?.bossName || id, entries };
  });
  const totals = new Map();
  for (const row of rows) {
    const player = totals.get(row.discordId) || { discordId: row.discordId, player: row.player || "Pathfinder",
      profileId: row.profileId || null, total: 0, stars: 0, scores: {}, bossStars: {}, firstAt: row.firstAt };
    player.total += Number(row.score) || 0; player.stars += Number(row.stars) || 0; player.scores[row.bossId] = row.score;
    player.bossStars[row.bossId] = row.stars;
    player.firstAt = Math.min(player.firstAt, row.firstAt);
    totals.set(row.discordId, player);
  }
  const week = ranked([...totals.values()], "total").map(({ discordId, firstAt, ...row }) => ({ ...row, own: own(discordId) }));
  return json({ cycle: publicCycle(cycle), current: currentInterlinkCycle().id, weeks, bosses, week });
}

async function leaderboardEntries(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!leaderboardAllowed(account, env)) return gatedResponse(account);
  const params = new URL(request.url).searchParams;
  const moderator = Boolean(account?.developerModeAvailable);
  const { where, binds, kind } = leaderboardFilters(params, { includeHidden: moderator && params.get("hidden") === "1" });
  if (params.get("mine") === "1" && account) {
    where.push("s.discord_id = ?");
    binds.push(account.discordId);
  }
  const sortKey = Object.hasOwn(LEADERBOARD_SORTS, params.get("sort") || "")
    ? params.get("sort")
    : LEADERBOARD_DEFAULT_SORT[kind] || "score";
  const natural = LEADERBOARD_SORTS[sortKey];
  const order = params.get("order") === "asc" ? "ASC" : params.get("order") === "desc" ? "DESC" : natural;
  // Clear-time boards only rank finished runs; values the board sorts on must be present.
  // "standing" (Egg Heist season) orders by rank tier, then Emperor stars, then rank points.
  const orderBy = (prefix) => (sortKey === "standing"
    ? ["rank_tier", "stars", "score"].map((column) => `COALESCE(${prefix}${column}, 0) ${order}`).join(", ")
    : `${prefix}${sortKey} ${order}`);
  if (sortKey === "standing") where.push("(s.rank_tier IS NOT NULL OR s.score IS NOT NULL)");
  else where.push(`s.${sortKey} IS NOT NULL`);
  if (sortKey === "clear_time_s") where.push("COALESCE(s.cleared, 1) = 1");
  const limit = Math.min(Math.max(Number.parseInt(params.get("limit") || "50", 10) || 50, 1), 200);
  const offset = Math.min(Math.max(Number.parseInt(params.get("offset") || "0", 10) || 0, 0), 100000);
  // One row per player (their best on each boss) unless every submission is requested.
  const bestPerPlayer = params.get("best") !== "0";
  const partition = kind === "interlink_run" || kind === "interlink_best" ? "s.discord_id, s.boss_id"
    : kind === "eggheist_season" ? "s.discord_id, s.cycle" : "s.discord_id";
  const base = `
    SELECT s.*, gc.character_name AS characterName,
      (SELECT character_name FROM game_characters WHERE discord_id = s.discord_id AND character_name IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1) AS anyCharacter, CASE WHEN p.is_public = 1 THEN p.public_id END AS profileId,
      ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${orderBy("s.")}, s.created_at ASC) AS playerRank
    FROM leaderboard_submissions s
    JOIN users u ON u.discord_id = s.discord_id
    LEFT JOIN profiles p ON p.discord_id = s.discord_id
    LEFT JOIN game_characters gc ON gc.game_uid = s.game_uid AND gc.discord_id = s.discord_id
    WHERE ${where.join(" AND ")}`;
  const filtered = bestPerPlayer ? `SELECT * FROM (${base}) WHERE playerRank = 1` : base;
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM (${filtered})`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT * FROM (${filtered}) ORDER BY ${orderBy("")}, created_at ASC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();
  const profiles = await partyProfiles(env, results || []);
  return json({
    kind,
    sort: sortKey,
    order: order.toLowerCase(),
    bestPerPlayer,
    total: Number(countRow?.total || 0),
    offset,
    limit,
    entries: (results || []).map((row, index) => ({
      rank: offset + index + 1,
      submissionId: row.submission_id,
      player: row.characterName || firstPlayerName(row.players_json) || row.anyCharacter || "Pathfinder",
      character: row.characterName || null,
      own: Boolean(account && row.discord_id === account.discordId),
      kind: row.kind,
      mode: row.mode,
      cycle: row.cycle,
      boss: { id: row.boss_id, name: row.boss_name, level: row.boss_level },
      score: row.score,
      seasonRank: row.rank_tier == null ? null : { tier: row.rank_tier, subtier: row.rank_subtier, name: row.rank_name },
      stars: row.stars,
      clearTimeS: row.clear_time_s,
      cleared: row.cleared == null ? null : Boolean(row.cleared),
      floors: row.floors,
      teamDps: row.team_dps,
      meterDps: row.meter_dps,
      meterDamage: row.meter_damage,
      partySize: row.party_size,
      profileId: row.profileId || null,
      players: withProfiles(parseJsonColumn(row.players_json), profiles),
      buffs: parseJsonColumn(row.buffs_json),
      extra: parseJsonColumn(row.extra_json),
      hasEvidence: Boolean(row.evidence_key),
      status: row.status,
      playedAt: row.played_at,
      submittedAt: row.created_at,
    })),
  });
}

// Distinct values present in the data, for the page's filter menus.
async function leaderboardFacets(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!leaderboardAllowed(account, env)) return gatedResponse(account);
  const params = new URL(request.url).searchParams;
  const mode = LEADERBOARD_MODES.includes(params.get("mode")) ? params.get("mode") : "interlink";
  const all = async (sql) => (await env.DB.prepare(sql).bind(mode).all()).results || [];
  const visible = "FROM leaderboard_submissions WHERE mode = ? AND status = 'visible'";
  const [cycles, bosses, levels, parties, kinds, buffRows] = await Promise.all([
    all(`SELECT cycle AS value, COUNT(*) AS count ${visible} AND cycle IS NOT NULL GROUP BY cycle ORDER BY cycle DESC`),
    all(`SELECT boss_id AS id, MAX(boss_name) AS name, COUNT(*) AS count ${visible} AND boss_id IS NOT NULL GROUP BY boss_id ORDER BY name`),
    all(`SELECT boss_level AS value, COUNT(*) AS count ${visible} AND boss_level IS NOT NULL GROUP BY boss_level ORDER BY boss_level DESC`),
    all(`SELECT party_size AS value, COUNT(*) AS count ${visible} AND party_size IS NOT NULL GROUP BY party_size ORDER BY party_size`),
    all(`SELECT kind AS value, COUNT(*) AS count ${visible} GROUP BY kind`),
    mode === "sim" ? all(`SELECT buffs_json AS buffs ${visible} AND buffs_json IS NOT NULL LIMIT 2000`) : Promise.resolve([]),
  ]);
  const buffCounts = new Map();
  for (const row of buffRows) {
    for (const buff of parseJsonColumn(row.buffs) || []) {
      if (buff?.name) buffCounts.set(buff.name, (buffCounts.get(buff.name) || 0) + 1);
    }
  }
  return json({
    mode,
    cycles,
    bosses,
    levels,
    partySizes: parties,
    kinds,
    buffs: [...buffCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    sorts: Object.keys(LEADERBOARD_SORTS),
  });
}

async function moderateSubmission(request, env, submissionId) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account?.developerModeAvailable) return json({ error: "Developer access required." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 512);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  if (body.status !== "visible" && body.status !== "hidden") return json({ error: "status must be visible or hidden." }, 400);
  const result = await env.DB.prepare(
    "UPDATE leaderboard_submissions SET status = ?, updated_at = ? WHERE submission_id = ?",
  ).bind(body.status, Math.floor(Date.now() / 1000), submissionId).run();
  if (Number(result.meta?.changes || 0) < 1) return json({ error: "Submission not found." }, 404);
  return json({ ok: true, submissionId, status: body.status });
}

async function deleteSubmission(request, env, submissionId) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, evidence_key AS evidenceKey FROM leaderboard_submissions WHERE submission_id = ?",
  ).bind(submissionId).first();
  if (!row) return json({ error: "Submission not found." }, 404);
  if (row.discordId !== account.discordId && !account.developerModeAvailable) {
    return json({ error: "You can only delete your own submissions." }, 403);
  }
  await env.DB.prepare("DELETE FROM leaderboard_submissions WHERE submission_id = ?").bind(submissionId).run();
  if (row.evidenceKey && env.EVIDENCE) await env.EVIDENCE.delete(row.evidenceKey);
  return json({ ok: true });
}

// Screenshot evidence: visible to the submitter and to developers only.
async function submissionEvidence(request, env, submissionId) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, evidence_key AS evidenceKey FROM leaderboard_submissions WHERE submission_id = ?",
  ).bind(submissionId).first();
  if (!row?.evidenceKey || !env.EVIDENCE) return json({ error: "Evidence not found." }, 404);
  if (row.discordId !== account.discordId && !account.developerModeAvailable) {
    return json({ error: "Evidence is visible to its submitter and developers only." }, 403);
  }
  const object = await env.EVIDENCE.get(row.evidenceKey);
  if (!object) return json({ error: "Evidence not found." }, 404);
  const headers = securityHeaders(new Headers());
  object.writeHttpMetadata?.(headers);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { status: 200, headers });
}

async function api(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: securityHeaders() });
  if (url.pathname === '/api/dev-preview/source-model-uid/mode' || url.pathname === '/api/dev-preview/source-model-uid/authorize') return sourceUidApiV56306(request, env);
  if (url.pathname === "/api/dev-preview/ticket" && request.method === "POST") {
    return issueDeveloperPreviewTicket(request, env);
  }
  if (url.pathname === "/api/dev-preview/redeem" && request.method === "POST") {
    return redeemDeveloperPreviewTicket(request, env);
  }
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
  if (url.pathname === "/api/progress/completed" && request.method === "GET") return getCompletion(request, env);
  if (url.pathname === "/api/progress/completed" && request.method === "PATCH") return patchCompletion(request, env);
  if (url.pathname === "/api/profile" && request.method === "GET") return ownProfile(request, env);
  if (url.pathname === "/api/profile" && request.method === "PATCH") return updateOwnProfile(request, env);
  if (url.pathname === "/api/profile/overview" && request.method === "GET") return ownProfileOverview(request, env);
  const publicProfileMatch = url.pathname.match(/^\/api\/profiles\/([A-Za-z0-9]{8,24})$/u);
  if (publicProfileMatch && request.method === "GET") return publicProfile(request, env, publicProfileMatch[1]);
  if (url.pathname === "/api/account" && request.method === "DELETE") return deleteOwnAccount(request, env);
  if (url.pathname === "/api/admin/developers" && request.method === "GET") {
    return listDeveloperAccounts(request, env);
  }
  const developerRoleMatch = url.pathname.match(/^\/api\/admin\/developers\/(\d{15,22})$/u);
  if (developerRoleMatch && request.method === "PUT") {
    return updateDeveloperRole(request, env, developerRoleMatch[1], true);
  }
  if (developerRoleMatch && request.method === "DELETE") {
    return updateDeveloperRole(request, env, developerRoleMatch[1], false);
  }
  if (url.pathname === "/api/leaderboard/status" && request.method === "GET") return leaderboardStatus(request, env);
  if (url.pathname === "/api/leaderboard/entries" && request.method === "GET") return leaderboardEntries(request, env);
  if (url.pathname === "/api/leaderboard/interlink" && request.method === "GET") return interlinkBoards(request, env);
  if (url.pathname === "/api/leaderboard/facets" && request.method === "GET") return leaderboardFacets(request, env);
  if (url.pathname === "/api/leaderboard/submissions" && request.method === "POST") return submitLeaderboardRecord(request, env);
  if (url.pathname === "/api/leaderboard/tokens" && request.method === "GET") return listLeaderboardTokens(request, env);
  if (url.pathname === "/api/leaderboard/tokens" && request.method === "POST") return createLeaderboardToken(request, env);
  const leaderboardTokenMatch = url.pathname.match(/^\/api\/leaderboard\/tokens\/([^/]+)$/u);
  if (leaderboardTokenMatch && request.method === "DELETE") return revokeLeaderboardToken(request, env, leaderboardTokenMatch[1]);
  const submissionMatch = url.pathname.match(/^\/api\/leaderboard\/submissions\/([A-Za-z0-9_-]{8,40})(\/evidence)?$/u);
  if (submissionMatch && !submissionMatch[2] && request.method === "PATCH") return moderateSubmission(request, env, submissionMatch[1]);
  if (submissionMatch && !submissionMatch[2] && request.method === "DELETE") return deleteSubmission(request, env, submissionMatch[1]);
  if (submissionMatch && submissionMatch[2] && request.method === "GET") return submissionEvidence(request, env, submissionMatch[1]);
  if (url.pathname === "/api/leaderboard/characters" && request.method === "GET") return listCharacters(request, env);
  if (url.pathname === "/api/leaderboard/characters" && request.method === "POST") return linkCharacter(request, env);
  const characterMatch = url.pathname.match(/^\/api\/leaderboard\/characters\/(\d{1,24})$/u);
  if (characterMatch && request.method === "DELETE") return unlinkCharacter(request, env, characterMatch[1]);
  const characterAdminMatch = url.pathname.match(/^\/api\/admin\/characters\/(\d{1,24})$/u);
  if (characterAdminMatch && request.method === "PUT") return reassignCharacter(request, env, characterAdminMatch[1]);
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
// UID authorization only; no inventory, asset catalog or renderer code.
const sourceUidApiV56306=(()=>{
// Generic UID-purpose authorization; existing preview/auth routes unchanged.
// Uses the ORIGINAL account/role/progress/body/origin implementations supplied
// by the API integration. No new table, public asset path, token or auth cache.
const sourceModelUidPurposeV56300 = 'aniilogs-dev-source-model-uid';
const sourceModelUidModePathV56300 = '/api/dev-preview/source-model-uid/mode';
const sourceModelUidAuthorizePathV56300 = '/api/dev-preview/source-model-uid/authorize';
const idPattern = /^\d{15,22}$/u;
const sameSecret = (a,b) => {
  if (a.length !== b.length) return false;
  let difference=0;
  for (let i=0;i<a.length;i++) difference|=a.charCodeAt(i)^b.charCodeAt(i);
  return difference===0;
};
function createSourceModelUidAuthApiV56300({
  currentAccount, developerAccountAllowed, progressPayload, readJsonBody,
  browserWriteAllowed, json,
}={}) {
  for (const fn of [currentAccount,developerAccountAllowed,progressPayload,
    readJsonBody,browserWriteAllowed,json]) {
    if (typeof fn!=='function') throw Error('Original API owner dependency required');
  }
  const denied=(status,message)=>json({authorized:false,
    purpose:sourceModelUidPurposeV56300,error:message},status);
  async function storedProgress(env,discordId) {
    return env.DB.prepare('SELECT revision, data_json AS dataJson, updated_at AS updatedAt FROM progress_snapshots WHERE discord_id = ?')
      .bind(discordId).first();
  }
  function decodeProgress(row) {
    if (!row) return null;
    const value=progressPayload(JSON.parse(row.dataJson));
    if (!value) throw Error('Invalid original progress row');
    return value;
  }
  async function authorizeIdentity(discordId,env) {
    if (!idPattern.test(discordId)) return denied(403,'Developer authorization required.');
    if (!env?.DB) return denied(503,'Source model authorization unavailable.');
    // No decision cache: query the live existing role authority on EVERY read.
    let developer=developerAccountAllowed(discordId,env);
    if (!developer) developer=Boolean(await env.DB.prepare(
      'SELECT discord_id AS discordId FROM developer_roles WHERE discord_id = ? LIMIT 1')
      .bind(discordId).first());
    if (!developer) return denied(403,'Developer authorization required.');
    const row=await storedProgress(env,discordId),progress=decodeProgress(row);
    // Missing, false, strings, numbers and unacknowledged local UI state deny.
    if (progress?.preferences?.developerMode!==true)
      return denied(403,'Developer mode must be enabled.');
    return json({authorized:true,purpose:sourceModelUidPurposeV56300,
      discordId,developerRole:true,devModeEnabled:true,
      serverDevModeRevision:Number(row.revision)});
  }
  async function authorize(request,env) {
    const secret=typeof env?.QA_BRIDGE_SECRET==='string'?env.QA_BRIDGE_SECRET:'';
    const header=request.headers.get('authorization')||'';
    if (secret.length<32) return denied(503,'Source model authorization unavailable.');
    if (!header.startsWith('Bearer ')||!sameSecret(header.slice(7),secret))
      return denied(403,'Service authorization required.');
    const body=await readJsonBody(request,256);
    if (!body||Object.keys(body).length!==1||typeof body.discordId!=='string')
      return denied(400,'Exact authenticated subject required.');
    return authorizeIdentity(body.discordId,env);
  }
  async function syncMode(request,env) {
    if (!browserWriteAllowed(request,env)) return denied(403,'Cross-origin request denied.');
    const account=await currentAccount(request,env);
    if (!account) return denied(401,'Authentication required.');
    const body=await readJsonBody(request,128);
    if (!body||Object.keys(body).length!==1||typeof body.enabled!=='boolean')
      return denied(400,'Exact developer mode boolean required.');
    // Revocation/off remains available to any authenticated owner. It cannot
    // grant access after a developer role is removed.
    if (body.enabled&&!account.developerModeAvailable)
      return denied(403,'Developer authorization required.');
    const discordId=account.discordId;
    if (!idPattern.test(discordId)) return denied(403,'Authenticated owner required.');
    const row=await storedProgress(env,discordId);
    const previous=decodeProgress(row)||{schemaVersion:1,tracking:[],completed:[],preferences:{}};
    const next={...previous,preferences:{...previous.preferences,developerMode:body.enabled}};
    const encoded=JSON.stringify(next),now=Math.floor(Date.now()/1000);
    if(new TextEncoder().encode(encoded).byteLength>512*1024)
      return denied(413,'Original progress size limit exceeded.');
    let changed;
    if (row) {
      if (!Number.isSafeInteger(Number(row.revision))) return denied(503,'Stored progress is invalid.');
      changed=await env.DB.prepare('UPDATE progress_snapshots SET revision = revision + 1, data_json = ?, updated_at = ? WHERE discord_id = ? AND revision = ?')
        .bind(encoded,now,discordId,Number(row.revision)).run();
    } else {
      changed=await env.DB.prepare('INSERT OR IGNORE INTO progress_snapshots (discord_id, revision, data_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?)')
        .bind(discordId,encoded,now,now).run();
    }
    if (Number(changed?.meta?.changes)!==1) return denied(409,'Progress changed; retry developer mode sync.');
    const confirmed=await storedProgress(env,discordId),progress=decodeProgress(confirmed);
    if (progress?.preferences?.developerMode!==body.enabled)
      return denied(409,'Developer mode acknowledgement changed.');
    return json({ok:true,purpose:sourceModelUidPurposeV56300,
      devModeEnabled:body.enabled,serverDevModeRevision:Number(confirmed.revision)});
  }
  return async function sourceModelUidAuthApiV56300(request,env) {
    const path=new URL(request.url).pathname;
    if (![sourceModelUidModePathV56300,sourceModelUidAuthorizePathV56300].includes(path))
      return denied(404,'Not found.');
    if (request.method!=='POST') return denied(405,'Method not allowed.');
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return denied(415,'Unsupported media type.');
    try {
      return path===sourceModelUidModePathV56300?await syncMode(request,env):await authorize(request,env);
    } catch (error) {
      return denied(error instanceof RangeError?413:error instanceof TypeError?400:503,
        'Source model authorization unavailable.');
    }
  };
}

return createSourceModelUidAuthApiV56300({currentAccount,developerAccountAllowed,progressPayload,readJsonBody,browserWriteAllowed,json});
})();
