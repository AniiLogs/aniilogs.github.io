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
  "game-files", "captures", "raw-captures", "dev",
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
  if (!developer) developer = DEVELOPER_MODE_ROLES.has(await storedDeveloperRole(discordId, env) || "player");   // not a tester
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
  // Map icons for reward containers (source:clay_pot …) are named after their item ids, not source files.
  if (/^assets\/icons\/source_[a-z0-9_]+\.png$/u.test(segments.join("/"))) return true;
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
  // The desktop app's sign-in: it listens on 127.0.0.1:<app_port> and holds the secret behind app_challenge
  const appPort = Number.parseInt(url.searchParams.get("app_port") || "", 10);
  const appChallenge = url.searchParams.get("app_challenge") || "";
  const app = url.searchParams.has("app_port")
    ? (appPort >= 1024 && appPort <= 65535 && /^[A-Za-z0-9_-]{43}$/u.test(appChallenge) ? { port: appPort, challenge: appChallenge } : null)
    : undefined;
  if (app === null) return json({ error: "Invalid app sign-in request." }, 400);
  const stateCookie = await signedValue({
    state,
    returnTo: safeClientReturnTo(url.searchParams.get("return_to"), request, env),
    app: app || null,
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
    if (stored?.app?.port) return redirect(`http://127.0.0.1:${stored.app.port}/callback?error=cancelled`, [clearCookie(OAUTH_COOKIE)]);
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
      // Public by default (the owner picks Private or Custom in Edit profile), at a random link id
      `INSERT OR IGNORE INTO profiles (discord_id, display_name, bio, is_public, public_id, created_at, updated_at)
       VALUES (?, ?, NULL, 1, ?, ?, ?)`,
    ).bind(
      String(user.id),
      String(user.global_name || user.username).slice(0, 80),
      shareId() + shareId().slice(0, 4),
      now,
      now,
    ).run();

    const rawHandoff = randomToken(48);
    const handoffHash = await sha256(rawHandoff);
    const app = stored.app && Number.isInteger(stored.app.port) ? stored.app : null;
    await env.DB.prepare(
      "INSERT INTO auth_handoffs (handoff_hash, discord_id, created_at, expires_at, app_challenge) VALUES (?, ?, ?, ?, ?)",
    ).bind(handoffHash, String(user.id), now, now + AUTH_HANDOFF_LIFETIME_SECONDS, app ? app.challenge : null).run();
    await env.DB.prepare("DELETE FROM auth_handoffs WHERE expires_at <= ?").bind(now).run();
    if (app) return redirect(`http://127.0.0.1:${app.port}/callback?code=${encodeURIComponent(rawHandoff)}`, [clearCookie(OAUTH_COOKIE)]);
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

// Roles, lowest to highest: player, tester (the aLogs Beta Menu only), developer (Developer Mode), administrator,
// owner. The owner is the ADMIN_DISCORD_IDS secret; tester, developer and administrator are rows in developer_roles.
// Developer and above get the same Developer Mode access; a tester gets none of it. Managing roles is checked by
// permission name: whoever grants developers grants testers too.
const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(["roles.grant.developer", "roles.grant.administrator", "logs.read", "logs.clear", "beta.manage"]),
  administrator: Object.freeze(["roles.grant.developer", "logs.read"]),
  developer: Object.freeze([]),
  tester: Object.freeze([]),
  player: Object.freeze([]),
});
const GRANTABLE_ROLES = new Set(["tester", "developer", "administrator"]);
const STORED_ROLES = new Set(["tester", "developer", "administrator"]);
const DEVELOPER_MODE_ROLES = new Set(["developer", "administrator", "owner"]);
const BETA_ROLES = new Set(["tester", "developer", "administrator", "owner"]);

export function ownerAccountAllowed(discordId, env) {
  return administratorAccountAllowed(discordId, env);
}

// storedRole: the developer_roles row's role ("tester", "developer" or "administrator"), or null without a row.
export function accountRole(discordId, env, storedRole) {
  if (ownerAccountAllowed(discordId, env)) return "owner";
  if (storedRole === "administrator") return "administrator";
  if (storedRole === "developer" || developerAccountAllowed(discordId, env)) return "developer";
  if (storedRole === "tester") return "tester";
  return "player";
}

export function accountPermissions(role) {
  return [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.player)];
}

export function can(account, permission) {
  return Array.isArray(account?.permissions) && account.permissions.includes(permission);
}

// Until migration 0026 adds developer_roles.role, every row is a developer and no administrator can be stored.
function missingRoleColumn(error) {
  return /no such column:?\s*(?:developer_roles\.)?role\b|has no column named role\b/iu.test(String(error?.message || error));
}

async function storedDeveloperRole(discordId, env) {
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT discord_id AS discordId, role FROM developer_roles WHERE discord_id = ? LIMIT 1",
    ).bind(String(discordId)).first();
  } catch (error) {
    if (!missingRoleColumn(error)) throw error;
    row = await env.DB.prepare(
      "SELECT discord_id AS discordId FROM developer_roles WHERE discord_id = ? LIMIT 1",
    ).bind(String(discordId)).first();
  }
  return row ? (STORED_ROLES.has(row.role) ? row.role : "developer") : null;
}

async function accountRoleFields(discordId, env) {
  let stored = null;
  if (!ownerAccountAllowed(discordId, env)) {
    try {
      stored = await storedDeveloperRole(discordId, env);
    } catch (error) {
      console.error("Could not read developer role", error);
    }
  }
  const role = accountRole(discordId, env, stored);
  return { developerModeAvailable: DEVELOPER_MODE_ROLES.has(role), role, permissions: accountPermissions(role) };
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
  const { role, permissions } = await accountRoleFields(row.discordId, env);
  return {
    discordId: String(row.discordId),
    username: String(row.discordUsername),
    globalName: row.discordGlobalName ? String(row.discordGlobalName) : null,
    avatarUrl: discordAvatarUrl({ id: row.discordId, avatar: row.discordAvatarHash }),
    displayName: row.displayName ? String(row.displayName) : null,
    profilePublic: Number(row.isPublic) === 1,
    sessionExpiresAt: Number(row.expiresAt),
    developerModeAvailable: DEVELOPER_MODE_ROLES.has(role),
    developerAdminAvailable: role === "owner",
    role,
    permissions,
  };
}

// PUT grants `role` ("developer" unless the body asks for "tester" or "administrator"); DELETE removes the row. Administrators
// manage developers only: granting, changing or removing an administrator needs the owner's permission.
async function updateDeveloperRole(request, env, discordId, enabled) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!can(account, "roles.grant.developer")) return json({ error: "Role management access required." }, 403);
  if (!/^\d{15,22}$/u.test(discordId)) return json({ error: "A valid Discord user ID is required." }, 400);
  if (ownerAccountAllowed(discordId, env)) {
    return json({ error: "Owner access is configured separately and cannot be changed here." }, 403);
  }
  const body = enabled ? await readJsonBody(request, 256) : null;
  const role = enabled ? (body?.role ?? "developer") : null;
  if (enabled && !GRANTABLE_ROLES.has(role)) return json({ error: "Role must be tester, developer or administrator." }, 400);
  const current = await storedDeveloperRole(discordId, env);
  if ((role === "administrator" || current === "administrator") && !can(account, "roles.grant.administrator")) {
    return json({ error: "Only the owner can grant, change or remove the administrator role." }, 403);
  }
  const now = Math.floor(Date.now() / 1000);
  if (enabled) {
    try {
      await env.DB.prepare(
        `INSERT INTO developer_roles (discord_id, role, granted_by_discord_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET role = excluded.role, granted_by_discord_id = excluded.granted_by_discord_id`,
      ).bind(discordId, role, account.discordId, now).run();
    } catch (error) {
      if (!missingRoleColumn(error)) throw error;
      if (role !== "developer") return json({ error: `The ${role} role needs database migration 0026 first.` }, 503);
      await env.DB.prepare(
        `INSERT INTO developer_roles (discord_id, granted_by_discord_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET granted_by_discord_id = excluded.granted_by_discord_id`,
      ).bind(discordId, account.discordId, now).run();
    }
  } else {
    await env.DB.prepare("DELETE FROM developer_roles WHERE discord_id = ?").bind(discordId).run();
  }
  return json({ ok: true, discordId, developer: enabled, role: enabled ? role : "player" });
}

async function listDeveloperAccounts(request, env) {
  const account = await currentAccount(request, env);
  if (!can(account, "roles.grant.developer")) return json({ error: "Role management access required." }, 403);
  const accountList = (roleColumn) => env.DB.prepare(
    `SELECT users.discord_id AS discordId,
            users.discord_username AS discordUsername,
            users.discord_global_name AS discordGlobalName,
            developer_roles.discord_id AS grantedDeveloperId${roleColumn ? ", developer_roles.role AS grantedRole" : ""}
       FROM users
       LEFT JOIN developer_roles ON developer_roles.discord_id = users.discord_id
      ORDER BY users.updated_at DESC, users.discord_id ASC
      LIMIT 2001`,
  ).all();
  let result;
  try {
    result = await accountList(true);
  } catch (error) {
    if (!missingRoleColumn(error)) throw error;
    result = await accountList(false);
  }
  const rows = result?.results || [];
  return json({
    accounts: rows.slice(0, 2000).map((row) => {
      const discordId = String(row.discordId);
      const stored = row.grantedDeveloperId ? (STORED_ROLES.has(row.grantedRole) ? row.grantedRole : "developer") : null;
      const role = accountRole(discordId, env, stored);
      return {
        discordId,
        discordUsername: String(row.discordUsername),
        discordGlobalName: row.discordGlobalName ? String(row.discordGlobalName) : null,
        developerModeAvailable: DEVELOPER_MODE_ROLES.has(role),
        developerAdminAvailable: role === "owner",
        role,
      };
    }),
    truncated: rows.length > 2000,
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
  // the desktop app (its own origin) signs in and sends log reports from anywhere; both carry no browser cookie
  if (url.pathname.startsWith("/api/auth/app/") || url.pathname === "/api/logs/reports"
    || url.pathname === "/api/logs/beta" || url.pathname === "/api/beta/tests" || url.pathname.startsWith("/api/beta/tests/")) {
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-max-age", "600");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  // developers read and clear log reports from the aLogs app too (bearer token only, never a cookie)
  if (url.pathname === "/api/admin/log-reports" || url.pathname.startsWith("/api/admin/log-reports/")
    || url.pathname === "/api/profile/photos" || url.pathname.startsWith("/api/profile/photos/") || url.pathname.startsWith("/api/photos/")
    || url.pathname === "/api/account/preferences") {
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    headers.set("access-control-max-age", "600");
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
    "SELECT discord_id AS discordId, expires_at AS expiresAt, app_challenge AS appChallenge FROM auth_handoffs WHERE handoff_hash = ? LIMIT 1",
  ).bind(handoffHash).first();
  if (!row || Number(row.expiresAt) <= now || row.appChallenge) {
    if (row && !row.appChallenge) await env.DB.prepare("DELETE FROM auth_handoffs WHERE handoff_hash = ?").bind(handoffHash).run();
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

// The desktop app trades its one-time code (plus the secret behind its challenge) for a desktop token: the same kind
// players used to copy from the website, labelled so they can see and revoke it there.
async function exchangeAppSignIn(request, env) {
  let body;
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const code = String(body.code || "");
  const verifier = String(body.verifier || "");
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(code) || !/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) {
    return json({ error: "Invalid sign-in code." }, 400);
  }
  const handoffHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, expires_at AS expiresAt, app_challenge AS appChallenge FROM auth_handoffs WHERE handoff_hash = ? LIMIT 1",
  ).bind(handoffHash).first();
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  if (!row || !row.appChallenge || Number(row.expiresAt) <= now || row.appChallenge !== challenge) {
    return json({ error: "Sign-in code expired or was already used. Try signing in again." }, 401);
  }
  const consumed = await env.DB.prepare("DELETE FROM auth_handoffs WHERE handoff_hash = ?").bind(handoffHash).run();
  if (Number(consumed.meta?.changes || 0) !== 1) {
    return json({ error: "Sign-in code expired or was already used. Try signing in again." }, 401);
  }
  const label = `aLogs app (${String(body.device || "this PC").replace(/[^\w .-]/gu, "").slice(0, 40) || "this PC"})`;
  const raw = `${LEADERBOARD_TOKEN_PREFIX}${randomToken(36)}`;
  await env.DB.prepare(
    "INSERT INTO leaderboard_tokens (token_hash, discord_id, label, created_at) VALUES (?, ?, ?, ?)",
  ).bind(await sha256(raw), String(row.discordId), label, now).run();
  const user = await env.DB.prepare(
    "SELECT discord_username AS username, discord_global_name AS globalName FROM users WHERE discord_id = ? LIMIT 1",
  ).bind(String(row.discordId)).first();
  return json({ token: raw, account: { name: user?.globalName || user?.username || "Discord account" } });
}

// Who the app's token belongs to (for "Signed in as ..."), and signing the app out (revokes its token).
async function appAccount(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account?.viaToken) return json({ authenticated: false }, 401);
  const user = await env.DB.prepare(
    "SELECT discord_username AS username, discord_global_name AS globalName, discord_avatar_hash AS avatar FROM users WHERE discord_id = ? LIMIT 1",
  ).bind(account.discordId).first();
  const beta = await betaTester(account);
  const permissions = account.permissions || [];
  // beta and permissions sit inside account too: aLogs 0.1.28 RC43/RC44 read account.beta and account.permissions
  return json({
    authenticated: true,
    // avatarUrl: the Discord avatar for the app's account pill (null when the account has none)
    account: { name: user?.globalName || user?.username || "Discord account", avatarUrl: discordAvatarUrl({ id: account.discordId, avatar: user?.avatar }), beta, permissions },
    beta,
    permissions,
  });
}
async function appSignOut(request, env) {
  const raw = bearerToken(request);
  if (!raw.startsWith(LEADERBOARD_TOKEN_PREFIX)) return json({ error: "Authentication required." }, 401);
  await env.DB.prepare("UPDATE leaderboard_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(Math.floor(Date.now() / 1000), await sha256(raw)).run();
  return json({ ok: true });
}

// The app's own view of the website signs in with the app's account: a one-time handoff, put in the page's #fragment
// (never sent to a server), which the page redeems like after a normal sign-in.
async function appSiteHandoff(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account?.viaToken) return json({ error: "Authentication required." }, 401);
  const raw = randomToken(48);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO auth_handoffs (handoff_hash, discord_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(await sha256(raw), account.discordId, now, now + AUTH_HANDOFF_LIFETIME_SECONDS).run();
  return json({ handoff: raw });
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

// Where progress is kept: the account's own copy (a Discord id, as before) or one game character's copy
// ({ uid, discordId }, see progressScope), so characters on different servers keep their own checklists.
const progressTable = (scope) => (typeof scope === "string"
  ? { table: "progress_snapshots", key: "discord_id", id: scope, owner: scope }
  : { table: "character_progress", key: "game_uid", id: scope.uid, owner: scope.discordId });

async function storedProgressRow(env, scope) {
  const { table, key, id } = progressTable(scope);
  return env.DB.prepare(
    `SELECT revision, data_json AS dataJson, updated_at AS updatedAt FROM ${table} WHERE ${key} = ?`,
  ).bind(id).first();
}

// ?uid=<game UID>: that character's progress. It must be one of the account's linked characters; the first time, its
// copy starts as the account's progress, so nothing tracked before is lost. No uid: the account's progress.
async function progressScope(request, env, account) {
  const uid = new URL(request.url).searchParams.get("uid");
  if (!uid) return { scope: account.discordId };
  if (!/^\d{1,24}$/u.test(uid)) return { error: json({ error: "uid must be a game UID." }, 400) };
  const owned = await env.DB.prepare("SELECT 1 AS ok FROM game_characters WHERE game_uid = ? AND discord_id = ?")
    .bind(uid, account.discordId).first();
  if (!owned) return { error: json({ error: "That character isn't linked to this account." }, 404) };
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO character_progress (game_uid, discord_id, revision, data_json, created_at, updated_at)
     SELECT ?, ?, 1, COALESCE((SELECT data_json FROM progress_snapshots WHERE discord_id = ?),
       '{"schemaVersion":1,"tracking":[],"completed":[],"preferences":{}}'), ?, ?`,
  ).bind(uid, account.discordId, account.discordId, now, now).run();
  return { scope: { uid, discordId: account.discordId } };
}

// Read-modify-write of one account's snapshot, retried when another write lands in between.
async function updateProgress(env, scope, change) {
  const { table, key, id, owner } = progressTable(scope);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await storedProgressRow(env, scope);
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
        `UPDATE ${table} SET revision = revision + 1, data_json = ?, updated_at = ? WHERE ${key} = ? AND revision = ?`,
      ).bind(encoded, now, id, Number(row.revision)).run()
      : table === "progress_snapshots"
        ? await env.DB.prepare(
          `INSERT INTO progress_snapshots (discord_id, revision, data_json, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?) ON CONFLICT(discord_id) DO NOTHING`,
        ).bind(id, encoded, now, now).run()
        : await env.DB.prepare(
          `INSERT INTO character_progress (game_uid, discord_id, revision, data_json, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(game_uid) DO NOTHING`,
        ).bind(id, owner, encoded, now, now).run();
    if (Number(result?.meta?.changes) === 1) {
      const saved = await storedProgressRow(env, scope);
      return { progress: next, revision: Number(saved.revision), updatedAt: Number(saved.updatedAt) };
    }
  }
  return { error: "Progress changed during the save. Try again.", status: 409 };
}

async function getProgress(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const { scope, error } = await progressScope(request, env, account);
  if (error) return error;
  const row = await storedProgressRow(env, scope);
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
  const { scope, error } = await progressScope(request, env, account);
  if (error) return error;
  // Only the explicit owner mode endpoint may change this server-owned flag; an old tab's stale value is ignored.
  delete progress.preferences.developerMode;
  const saved = await updateProgress(env, scope, (previous) => {
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
  const { scope, error } = await progressScope(request, env, account);
  if (error) return error;
  const row = await storedProgressRow(env, scope);
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
  const { scope, error } = await progressScope(request, env, account);
  if (error) return error;
  const now = Date.now();
  const changes = Object.fromEntries([...clear.map((id) => [id, [0, now]]), ...set.map((id) => [id, [1, now]])]);
  const saved = await updateProgress(env, scope, (previous) => withCompletion(
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

// What a profile shows to others. Public: every part. Private: nothing (the page is "not found"). Custom: the parts
// its owner ticked. The owner always sees all of it. Online status keeps its own switch (Show my online status).
const PROFILE_PARTS = Object.freeze(["standings", "history", "collection", "photos", "about", "directory"]);
function profileVisibility(isPublic, prefsJson) {
  if (Number(isPublic) !== 1) return { mode: "private", parts: [] };
  let visibility = null;
  try { visibility = JSON.parse(prefsJson || "{}").visibility; } catch { visibility = null; }
  if (visibility?.mode !== "custom") return { mode: "public", parts: [...PROFILE_PARTS] };
  return { mode: "custom", parts: PROFILE_PARTS.filter((part) => (visibility.parts || []).includes(part)) };
}
// SQL: a profile that shows in Online now, Recently joined, the player search and the sitemap (alias p)
const LISTED_PROFILE = `(p.is_public = 1 AND p.public_id IS NOT NULL
  AND (COALESCE(json_extract(p.preferences_json, '$.visibility.mode'), 'public') <> 'custom'
    OR EXISTS (SELECT 1 FROM json_each(COALESCE(p.preferences_json, '{}'), '$.visibility.parts') WHERE value = 'directory')))`;

async function ownProfile(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const row = await env.DB.prepare(
    "SELECT display_name AS displayName, bio, is_public AS isPublic, public_id AS publicId, findable_by_name AS findableByName, show_presence AS showPresence, listed_in_search AS listedInSearch, preferences_json AS prefs, updated_at AS updatedAt FROM profiles WHERE discord_id = ?",
  ).bind(account.discordId).first();
  const isPublic = Number(row?.isPublic || 0) === 1;
  const { prefs, ...shown } = row || {};
  const { mode, parts } = profileVisibility(row?.isPublic, prefs);
  return json({ profile: { ...shown, isPublic, visibility: mode, publicParts: parts, findableByName: Number(row?.findableByName || 0) === 1, showPresence: Number(row?.showPresence ?? 1) === 1, listedInSearch: Number(row?.listedInSearch ?? 1) === 1, publicId: isPublic ? row?.publicId || null : null } });
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
  if (body.findableByName !== undefined && typeof body.findableByName !== "boolean") {
    return json({ error: "findableByName must be true or false." }, 400);
  }
  if (body.showPresence !== undefined && typeof body.showPresence !== "boolean") {
    return json({ error: "showPresence must be true or false." }, 400);
  }
  if (body.listedInSearch !== undefined && typeof body.listedInSearch !== "boolean") {
    return json({ error: "listedInSearch must be true or false." }, 400);
  }
  if (body.visibility !== undefined && !["public", "private", "custom"].includes(body.visibility)) {
    return json({ error: "visibility must be public, private or custom." }, 400);
  }
  if (body.publicParts !== undefined && (!Array.isArray(body.publicParts) || !body.publicParts.every((part) => PROFILE_PARTS.includes(part)))) {
    return json({ error: `publicParts must list some of: ${PROFILE_PARTS.join(", ")}.` }, 400);
  }
  // Public by default (Public, Private or Custom; editing the name or bio never changes it). A public profile has a
  // random id for its link (never the Discord id). Being found by the display name is a separate opt-in (off by
  // default), and only matters while the profile is public.
  const current = await env.DB.prepare(
    "SELECT is_public AS isPublic, public_id AS publicId, findable_by_name AS findableByName, show_presence AS showPresence, listed_in_search AS listedInSearch FROM profiles WHERE discord_id = ?",
  ).bind(account.discordId).first();
  const isPublic = body.visibility ? body.visibility !== "private"
    : typeof body.isPublic === "boolean" ? body.isPublic : Number(current?.isPublic || 0) === 1;
  const findableByName = typeof body.findableByName === "boolean" ? body.findableByName : Number(current?.findableByName || 0) === 1;
  const showPresence = typeof body.showPresence === "boolean" ? body.showPresence : Number(current?.showPresence ?? 1) === 1;
  const listedInSearch = typeof body.listedInSearch === "boolean" ? body.listedInSearch : Number(current?.listedInSearch ?? 1) === 1;
  const publicId = current?.publicId || (isPublic ? shareId() + shareId().slice(0, 4) : null);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE profiles SET display_name = ?, bio = ?, is_public = ?, public_id = ?, findable_by_name = ?, show_presence = ?, listed_in_search = ?, updated_at = ? WHERE discord_id = ?",
  ).bind(displayName, bio || null, isPublic ? 1 : 0, publicId, findableByName ? 1 : 0, showPresence ? 1 : 0, listedInSearch ? 1 : 0, now, account.discordId).run();
  if (!showPresence) {     // turned off: what was kept goes too
    await env.DB.prepare("UPDATE game_characters SET presence_state = NULL, presence_at = NULL WHERE discord_id = ?").bind(account.discordId).run();
  }
  // Custom: the parts it shows (kept in preferences_json); Public or Private drop the list
  if (body.visibility) {
    const custom = body.visibility === "custom" ? JSON.stringify({ mode: "custom", parts: PROFILE_PARTS.filter((part) => (body.publicParts || []).includes(part)) }) : null;
    await env.DB.prepare(`UPDATE profiles SET preferences_json = CASE WHEN ? IS NULL THEN json_remove(COALESCE(preferences_json, '{}'), '$.visibility')
      ELSE json_set(COALESCE(preferences_json, '{}'), '$.visibility', json(?)) END WHERE discord_id = ?`).bind(custom, custom, account.discordId).run();
  }
  const saved = await env.DB.prepare("SELECT preferences_json AS prefs FROM profiles WHERE discord_id = ?").bind(account.discordId).first();
  const { mode, parts } = profileVisibility(isPublic ? 1 : 0, saved?.prefs);
  return json({ ok: true, profile: { displayName, bio: bio || null, isPublic, visibility: mode, publicParts: parts, findableByName, showPresence, listedInSearch, publicId: isPublic ? publicId : null, updatedAt: now } });
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
  const where = ["s.kind = ?", "s.status = 'visible'", ON_BOARDS("s")];
  if (sortKey === "standing") where.push("(s.rank_tier IS NOT NULL OR s.score IS NOT NULL)");
  else where.push(`s.${sortKey} IS NOT NULL`);
  if (sortKey === "clear_time_s") where.push(clearedSql(kind, kind === "interlink_run" ? await interlinkCycles(env) : []));
  if (kind === "eggheist_season") where.push("s.cycle IS NOT NULL");
  // a run whose boss wasn't recognised can't stand on a boss's board (it was a second row beside the real one)
  if (kind === "interlink_run" || kind === "interlink_best") where.push("s.boss_id IS NOT NULL");
  const group = kind === "interlink_run" || kind === "interlink_best" ? "boss_id" : kind === "eggheist_season" ? "cycle"
    : kind === "sim_run" ? "cycle, trial, difficulty" : "";
  const partition = group ? `s.discord_id, ${group.split(", ").map((column) => `s.${column}`).join(", ")}` : "s.discord_id";
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
     ORDER BY ${kind === "eggheist_season" ? "cycle DESC" : kind === "sim_run" ? "cycle DESC, trial, difficulty" : group ? "boss_name, boss_id" : "position"}`,
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
    seasonProgress: kind === "eggheist_season" ? seasonProgress(row.extra_json) : null,
    stars: row.stars,
    clearTimeS: row.clear_time_s,
    floors: row.floors,
    partySize: row.party_size,
    playedAt: row.played_at,
  }));
}

// An Egg Heist season entry's progress for the profile, from what the app read in the game (its `extra`): where the
// next rank starts (Rank Info "1319/2370"), the last match's gain and the bar after it ("1337/1350 +18"). Only these
// fields, and only whole numbers, ever leave the server.
function seasonProgress(extraJson) {
  const extra = parseJsonColumn(extraJson) || {};
  const whole = (value) => (Number.isInteger(value) && value >= 0 && value < 1e9 ? value : null);
  const bar = Array.isArray(extra.bar) && extra.bar.length === 2 && extra.bar.every((v) => whole(v) != null) ? extra.bar : null;
  const progress = { nextRankAt: whole(extra.nextRankAt), lastGain: whole(extra.lastGain), bar, barAt: bar && Number.isInteger(extra.barAt) && extra.barAt > 0 && extra.barAt < 1e10 ? extra.barAt : null };
  return Object.values(progress).some((v) => v != null) ? progress : null;
}

// The account's main character: the one it picked (profiles.main_game_uid, while still linked to it), else the most
// recently seen character proven in the game menu, else the most recently seen one. Null without characters.
async function mainCharacter(env, discordId) {
  return env.DB.prepare(
    `SELECT gc.game_uid AS gameUid, gc.character_name AS name, gc.verified_at IS NOT NULL AS verified,
       gc.game_uid = p.main_game_uid AS picked
     FROM game_characters gc LEFT JOIN profiles p ON p.discord_id = gc.discord_id
     WHERE gc.discord_id = ?
     ORDER BY gc.game_uid = p.main_game_uid DESC, gc.verified_at IS NOT NULL DESC, gc.last_seen_at DESC LIMIT 1`,
  ).bind(discordId).first();
}

// The collection progress a profile shows: its main character's checklists (kept per UID), else the account's.
async function profileProgressRow(env, discordId, main) {
  return (main && await storedProgressRow(env, { uid: main.gameUid, discordId })) || storedProgressRow(env, discordId);
}

// PUT /api/profile/main {gameUid}: pick the main character (one of the account's), or null for automatic.
async function setMainCharacter(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 256);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  const gameUid = body.gameUid === null ? null : boundedText(body.gameUid, 24, /^\d+$/u);
  if (gameUid === undefined) return json({ error: "gameUid must be a game UID or null." }, 400);
  if (gameUid && !await env.DB.prepare("SELECT 1 AS ok FROM game_characters WHERE game_uid = ? AND discord_id = ?")
    .bind(gameUid, account.discordId).first()) return json({ error: "That character isn't linked to this account." }, 404);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO profiles (discord_id, display_name, bio, is_public, public_id, created_at, updated_at, main_game_uid)
     VALUES (?, NULL, NULL, 1, lower(hex(randomblob(8))), ?, ?, ?)
     ON CONFLICT(discord_id) DO UPDATE SET main_game_uid = excluded.main_game_uid, updated_at = excluded.updated_at`,
  ).bind(account.discordId, now, now, gameUid).run();
  return json({ ok: true, main: await mainCharacter(env, account.discordId) });
}

async function ownProfileOverview(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const [profile, characters, main] = await Promise.all([
    env.DB.prepare(
      "SELECT display_name AS displayName, bio, is_public AS isPublic, public_id AS publicId, preferences_json AS prefs FROM profiles WHERE discord_id = ?",
    ).bind(account.discordId).first(),
    env.DB.prepare(
      `SELECT game_uid AS gameUid, character_name AS name, last_seen_at AS lastSeenAt, json_extract(stats_json, '$.level') AS level, json_extract(stats_json, '$.exp') AS exp,
         json_extract(stats_json, '$.expNeeded') AS expNeeded,
         json_extract(stats_json, '$.gender') AS gender, json_extract(stats_json, '$.server') AS server
       FROM game_characters WHERE discord_id = ? ORDER BY last_seen_at DESC`,
    ).bind(account.discordId).all(),
    mainCharacter(env, account.discordId),
  ]);
  const ownProgress = await profileProgressRow(env, account.discordId, main);
  let completed = [];
  try {
    completed = ownProgress ? progressPayload(JSON.parse(ownProgress.dataJson))?.completed || [] : [];
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
      visibility: profileVisibility(profile?.isPublic, profile?.prefs).mode,
      ...(Number(profile?.isPublic || 0) === 1 && profile?.publicId ? { publicId: profile.publicId } : {}),
    },
    layout: storedProfileLayout(profile?.prefs),
    characters: (characters.results || []).map(({ level, gender, server, exp, expNeeded, ...row }) => ({ ...row, ...characterDetails({ level, gender, server, exp, expNeeded }) })),
    main: main ? { gameUid: main.gameUid, name: main.name, picked: Boolean(main.picked) } : null,
    presence: await profilePresence(env, account.discordId),
    leaderboards,
    photos: await profilePhotos(env, account.discordId, true),
    gameStats: await characterStats(env, main),
    collection: collectionSummary(completed, await releaseChecklist(env)),
    progressUpdatedAt: ownProgress ? Number(ownProgress.updatedAt) : null,
  });
}

// A profile its owner made public: name, about, characters, board standing and collection progress. No Discord
// identity (id, username, avatar). Private or unknown ids are a plain 404.
// Finds public profiles by a character name (part of it) or a game UID (all of it, or its start), and by the display
// name of owners who opted in to that. Only profiles their owners made public, and only what a public profile shows.
async function searchProfiles(request, env) {
  const q = String(new URL(request.url).searchParams.get("q") || "").trim();
  if (q.length < 2 || q.length > 40) return json({ results: [] });
  const byUid = /^\d{4,24}$/u.test(q);
  const like = `%${q.toLowerCase().replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
  const { results } = await env.DB.prepare(
    `SELECT p.public_id AS publicId, gc.character_name AS name, gc.game_uid AS gameUid
     FROM game_characters gc JOIN profiles p ON p.discord_id = gc.discord_id
     WHERE ${LISTED_PROFILE} AND gc.character_name IS NOT NULL
       AND ${byUid ? "gc.game_uid LIKE ?" : "LOWER(gc.character_name) LIKE ? ESCAPE '\\'"}
     ORDER BY gc.last_seen_at DESC LIMIT 30`,
  ).bind(byUid ? `${q}%` : like).all();
  const named = byUid ? { results: [] } : await env.DB.prepare(
    `SELECT p.public_id AS publicId, p.display_name AS displayName,
       (SELECT json_group_array(json_object('name', gc.character_name, 'gameUid', gc.game_uid)) FROM game_characters gc
        WHERE gc.discord_id = p.discord_id AND gc.character_name IS NOT NULL) AS charactersJson
     FROM profiles p
     WHERE ${LISTED_PROFILE} AND p.findable_by_name = 1 AND LOWER(p.display_name) LIKE ? ESCAPE '\\'
     ORDER BY p.updated_at DESC LIMIT 10`,
  ).bind(like).all();
  const seen = new Map();
  for (const row of named.results || []) {
    let characters = [];
    try { characters = JSON.parse(row.charactersJson || "[]"); } catch { characters = []; }
    seen.set(row.publicId, { publicId: row.publicId, displayName: row.displayName, characters });
  }
  for (const row of results || []) {
    const entry = seen.get(row.publicId) || { publicId: row.publicId, characters: [] };
    if (!entry.displayName) entry.characters.push({ name: row.name, gameUid: row.gameUid });
    seen.set(row.publicId, entry);
  }
  return json({ results: [...seen.values()].slice(0, 10) });
}

// The name a public profile goes by: its display name when its owner lets players find them by it, else its main
// character's (as mainCharacter picks it). For SQL over profiles p.
const PUBLIC_NAME_SQL = `COALESCE(CASE WHEN p.findable_by_name = 1 THEN p.display_name END,
  (SELECT gc.character_name FROM game_characters gc WHERE gc.discord_id = p.discord_id AND gc.character_name IS NOT NULL
   ORDER BY gc.game_uid = p.main_game_uid DESC, gc.verified_at IS NOT NULL DESC, gc.last_seen_at DESC LIMIT 1), 'Pathfinder')`;

// GET /api/profiles/directory: the Profiles page's Recently joined (public profiles, newest first) and Online now
// (public profiles showing their status). Players online with a private profile are only counted, never named.
async function profilesDirectory(env) {
  const fresh = Math.floor(Date.now() / 1000) - PRESENCE_FRESH_S;
  const [recent, online, others] = await Promise.all([
    env.DB.prepare(
      `SELECT p.public_id AS publicId, ${PUBLIC_NAME_SQL} AS name, p.created_at AS joinedAt FROM profiles p
       WHERE ${LISTED_PROFILE} ORDER BY p.created_at DESC LIMIT 8`,
    ).all(),
    env.DB.prepare(
      `SELECT p.public_id AS publicId, ${PUBLIC_NAME_SQL} AS name,
         CASE WHEN EXISTS (SELECT 1 FROM game_characters gc WHERE gc.discord_id = p.discord_id AND gc.presence_at > ?1
           AND gc.presence_state = 'online') THEN 'online' ELSE 'afk' END AS state
       FROM profiles p
       WHERE ${LISTED_PROFILE} AND COALESCE(p.show_presence, 1) = 1
         AND EXISTS (SELECT 1 FROM game_characters gc WHERE gc.discord_id = p.discord_id AND gc.presence_at > ?1
           AND gc.presence_state IN ('online', 'afk'))
       ORDER BY state = 'online' DESC, p.updated_at DESC LIMIT 24`,
    ).bind(fresh).all(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT gc.discord_id) AS count FROM game_characters gc LEFT JOIN profiles p ON p.discord_id = gc.discord_id
       WHERE gc.presence_at > ? AND gc.presence_state IN ('online', 'afk') AND NOT COALESCE(${LISTED_PROFILE}, 0)`,
    ).bind(fresh).first(),
  ]);
  return json({
    recent: (recent.results || []).map((row) => ({ publicId: row.publicId, name: row.name, joinedAt: Number(row.joinedAt) || null })),
    online: { players: online.results || [], others: Number(others?.count || 0) },
  });
}

// ---------------------------------------------------------------- Battle History
// Every record a player has: the ones they sent, newest first, plus Interlink runs a teammate's app sent with this
// player's proven UID in the party (as CREDITED_RUNS credits them; a run both sent shows once, as their own). The
// boards stay best-per-player; this is the whole record. It follows the profile: the owner's own, or a public
// profile's for anyone. Names as on screen, a profile link only for public profiles, never a UID.
const HISTORY_PAGE = 20;
// aLogs' Party-screen lineup (extra.lineup) as the site passes it on: for every player, slot, name, AI, and when read
// their lead Aniimo, its level, CP and team comp; self marks the player who sent the run.
function publicLineup(lineup) {
  if (!Array.isArray(lineup)) return null;
  const text = (value) => (typeof value === "string" ? value.slice(0, 40) : undefined);
  const level = (value) => (Number.isInteger(value) && value >= 1 && value <= 999 ? value : undefined);
  return lineup.slice(0, 4).filter((item) => item && typeof item === "object").map((item) => JSON.parse(JSON.stringify({
    slot: level(item.slot), name: text(item.name), ai: typeof item.ai === "boolean" ? item.ai : undefined, self: item.self === true || undefined,
    // every player's lead, its level and CP, and the team they went in with (public, the owner's decision)
    aniimo: text(item.aniimo) ?? text(item.lead?.name) ?? text(item.lead), aniimoLevel: level(item.aniimoLevel) ?? level(item.lead?.level),
    cp: Number.isInteger(item.cp) && item.cp >= 0 && item.cp <= 10000000 ? item.cp : undefined,
    // [{ aniimo | name, aniimoLevel | level, cp }] or names
    team: Array.isArray(item.team) ? item.team.slice(0, 6).map((member) => (typeof member === "string" ? { aniimo: text(member) } : {
      aniimo: text(member?.aniimo) ?? text(member?.name), aniimoLevel: level(member?.aniimoLevel) ?? level(member?.level),
      cp: Number.isInteger(member?.cp) && member.cp >= 0 && member.cp <= 10000000 ? member.cp : undefined,
    })).filter((member) => member.aniimo) : undefined,
  })));
}
// A shared run's lineup filled in from every copy of it: each player's details from the copy that read them, the
// player's own copy first (their app saw their own panel best), then any other.
function mergedLineup(own, copies) {
  if (!own) return own;
  const detail = (entry) => Boolean(entry?.aniimo || entry?.team?.length || Number.isInteger(entry?.cp));
  const same = (a, b) => (a.slot != null && a.slot === b.slot) || (a.name && a.name === b.name);
  return own.map((entry) => {
    if (entry.ai) return entry;
    const others = copies.flatMap((lineup) => lineup || []).filter((other) => same(entry, other) && detail(other));
    const best = (entry.self && detail(entry) ? entry : null) || others.find((other) => other.self) || (detail(entry) ? entry : null) || others[0];
    if (!best || best === entry) return entry;
    const { aniimo, aniimoLevel, cp, team } = best;
    return JSON.parse(JSON.stringify({ ...entry, aniimo, aniimoLevel, cp, team }));
  });
}
const HISTORY_COLUMNS = `c.submission_id, c.discord_id, c.kind, c.mode, c.cycle, c.boss_id, c.boss_name, c.boss_level, c.score, c.stars,
  c.clear_time_s, c.cleared, c.floors, c.team_dps, c.party_size, c.difficulty, c.trial, c.rank_tier, c.rank_subtier, c.rank_name,
  c.players_json, c.buffs_json, c.extra_json, c.evidence_key, c.battle_evidence_key, c.proof_pruned_at, c.verify_state, c.status, c.played_at,
  c.created_at, COALESCE(c.played_at, c.created_at) AS at,
  (SELECT COUNT(*) FROM leaderboard_submissions o WHERE json_extract(c.extra_json, '$.sharedRun') IS NOT NULL
     AND json_extract(o.extra_json, '$.sharedRun') = json_extract(c.extra_json, '$.sharedRun')) AS captures`;

async function battleHistory(env, discordId, params, { owner }) {
  const uids = ((await env.DB.prepare("SELECT game_uid AS uid FROM game_characters WHERE discord_id = ?").bind(discordId).all()).results || [])
    .map((row) => String(row.uid)).filter((uid) => /^\d{4,24}$/u.test(uid)).slice(0, 10);
  const own = `SELECT ${HISTORY_COLUMNS}, 0 AS credited FROM leaderboard_submissions c
    WHERE c.discord_id = ?1 AND c.kind <> 'interlink_week'${owner ? "" : " AND c.status = 'visible'"}`;
  // a teammate's copy: only through a UID of this account's that's proven (or confirmed in that party), and not a
  // run this player also sent themselves (same game instance)
  const credited = uids.length ? `SELECT ${HISTORY_COLUMNS}, 1 AS credited FROM leaderboard_submissions c
    WHERE c.kind = 'interlink_run' AND c.status = 'visible' AND c.discord_id <> ?1
      AND (${uids.map((uid) => `instr(c.players_json, '"${uid}"') > 0`).join(" OR ")})
      AND EXISTS (SELECT 1 FROM json_each(c.players_json) pl JOIN game_characters gc ON gc.game_uid = json_extract(pl.value, '$.uid')
        WHERE gc.discord_id = ?1 AND json_extract(pl.value, '$.ai') = 0
          AND (gc.verified_at IS NOT NULL OR json_extract(pl.value, '$.confirmed') = 1))
      AND NOT EXISTS (SELECT 1 FROM leaderboard_submissions mine WHERE mine.discord_id = ?1 AND mine.kind = 'interlink_run'
        AND ((json_extract(mine.extra_json, '$.instanceId') IS NOT NULL
          AND json_extract(mine.extra_json, '$.instanceId') = json_extract(c.extra_json, '$.instanceId'))
         OR (json_extract(mine.extra_json, '$.sharedRun') IS NOT NULL
          AND json_extract(mine.extra_json, '$.sharedRun') = json_extract(c.extra_json, '$.sharedRun'))))
      -- one teammate's copy of a shared run is enough
      AND NOT EXISTS (SELECT 1 FROM leaderboard_submissions twin WHERE twin.kind = 'interlink_run' AND twin.status = 'visible'
        AND twin.discord_id <> ?1 AND json_extract(c.extra_json, '$.sharedRun') IS NOT NULL
        AND json_extract(twin.extra_json, '$.sharedRun') = json_extract(c.extra_json, '$.sharedRun') AND twin.submission_id < c.submission_id
        AND (${uids.map((uid) => `instr(twin.players_json, '"${uid}"') > 0`).join(" OR ")}))` : null;
  const all = `SELECT * FROM (${own}${credited ? ` UNION ALL ${credited}` : ""})`;
  const where = [];
  const binds = [discordId];
  const mode = LEADERBOARD_MODES.includes(params.get("mode")) ? params.get("mode") : "";
  if (mode) { where.push(`mode = ?${binds.push(mode)}`); }
  const boss = String(params.get("boss") || "");
  if (/^[A-Za-z0-9_-]{1,40}$/u.test(boss)) where.push(`boss_id = ?${binds.push(boss)}`);
  const cycle = String(params.get("cycle") || "");
  if (/^[A-Za-z0-9_.-]{1,24}$/u.test(cycle)) where.push(`cycle = ?${binds.push(cycle)}`);
  const filtered = `${all}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  // the page after "<at>.<submissionId>" (newest first)
  const before = String(params.get("before") || "").match(/^(\d{1,12})\.([A-Za-z0-9_-]{8,40})$/u);
  const page = before
    ? `SELECT * FROM (${filtered}) WHERE at < ?${binds.push(Number(before[1]))} OR (at = ?${binds.length} AND submission_id < ?${binds.push(before[2])})`
    : filtered;
  const limit = Math.min(Math.max(Number.parseInt(params.get("limit") || String(HISTORY_PAGE), 10) || HISTORY_PAGE, 1), 50);
  const { results } = await env.DB.prepare(`${page} ORDER BY at DESC, submission_id DESC LIMIT ${limit + 1}`).bind(...binds).all();
  const rows = (results || []).slice(0, limit);
  const profiles = await partyProfiles(env, rows);
  // a week's dates, for its label ("Week of Oct 28")
  const weekList = await interlinkCycles(env);
  const weekDates = (id) => { const week = interlinkCycle(weekList, id); return week ? { start: week.start, end: week.end } : {}; };
  // the filter menus (first page only): what this player's record has
  let filters;
  if (!before) {
    const facet = async (sql) => (await env.DB.prepare(sql).bind(discordId).all()).results || [];
    const [modes, bosses, weeks] = await Promise.all([
      facet(`SELECT mode AS value, COUNT(*) AS count FROM (${all}) GROUP BY mode ORDER BY count DESC`),
      facet(`SELECT boss_id AS id, MAX(boss_name) AS name, COUNT(*) AS count FROM (${all}) WHERE boss_id IS NOT NULL GROUP BY boss_id ORDER BY name`),
      facet(`SELECT cycle AS value, COUNT(*) AS count FROM (${all}) WHERE cycle IS NOT NULL AND mode = 'interlink' GROUP BY cycle ORDER BY CAST(cycle AS INTEGER) DESC`),
    ]);
    filters = { modes, bosses, weeks: weeks.map((row) => ({ ...row, ...weekDates(row.value) })) };
  }
  // the other copies of shared runs (sent by teammates), for the players their apps read
  const shared = [...new Set(rows.map((row) => parseJsonColumn(row.extra_json)?.sharedRun).filter((id) => typeof id === "string"))];
  const copiesOf = new Map();
  if (shared.length) {
    const { results: copies } = await env.DB.prepare(
      `SELECT submission_id, json_extract(extra_json, '$.sharedRun') AS shared, json_extract(extra_json, '$.lineup') AS lineup
       FROM leaderboard_submissions WHERE json_extract(extra_json, '$.sharedRun') IN (${shared.map(() => "?").join(", ")})`,
    ).bind(...shared).all();
    for (const copy of copies || []) {
      const list = copiesOf.get(copy.shared) || [];
      list.push({ id: copy.submission_id, lineup: publicLineup(parseJsonColumn(copy.lineup)) });
      copiesOf.set(copy.shared, list);
    }
  }
  const last = rows.at(-1);
  return {
    runs: rows.map((row) => {
      const extra = parseJsonColumn(row.extra_json) || {};
      const copies = (copiesOf.get(extra.sharedRun) || []).filter((copy) => copy.id !== row.submission_id).map((copy) => copy.lineup);
      return {
        submissionId: row.submission_id,
        credited: Boolean(row.credited),      // from a teammate's copy of the run
        kind: row.kind,
        mode: row.mode,
        cycle: row.cycle,
        week: row.cycle ? weekDates(row.cycle) : null,
        boss: row.boss_id ? { id: row.boss_id, name: row.boss_name, level: row.boss_level } : null,
        score: row.score,
        stars: row.stars,
        clearTimeS: row.clear_time_s,
        cleared: row.cleared == null ? null : Boolean(row.cleared),
        outcome: interlinkOutcome(row, weekList),
        floors: row.floors,
        teamDps: row.team_dps,
        partySize: row.party_size,
        difficulty: row.difficulty || null,
        trialName: row.trial ? simStageName(row.trial, row.difficulty, row.cycle) : null,
        rank: row.rank_tier == null ? null : { tier: row.rank_tier, subtier: row.rank_subtier, name: row.rank_name },
        players: withProfiles(parseJsonColumn(row.players_json), profiles) || [],
        lineup: mergedLineup(publicLineup(extra.lineup), copies),
        // the buffs the party went in with (the leader picks them on the Party screen)
        buffs: (parseJsonColumn(row.buffs_json) || []).slice(0, 12).map((buff) => ({ name: buff.name, ...(Number.isInteger(buff.level) ? { level: buff.level } : {}) })),
        newBests: Array.isArray(extra.newBests) ? extra.newBests.slice(0, 8) : null,
        hasEvidence: Boolean(row.evidence_key),
        hasBattleEvidence: Boolean(row.battle_evidence_key),
        hasFullScreens: Object.keys(extra.proofFull || {}),
        hasPartyScreen: Boolean(extra.proofParty),
        captures: Math.max(1, Number(row.captures) || 0),     // how many players' apps captured this run
        proofPrunedAt: row.proof_pruned_at || null,
        check: runCheckBadge(row.verify_state),
        ...(owner && row.status !== "visible" ? { hidden: true } : {}),
        playedAt: row.played_at || row.created_at,
      };
    }),
    next: (results || []).length > limit && last ? `${last.at}.${last.submission_id}` : null,
    ...(filters ? { filters } : {}),
  };
}

// GET /api/profile/history (your own) and GET /api/profiles/<publicId>/history (a public profile's)
async function ownBattleHistory(request, env) {
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!leaderboardAllowed(account, env)) return json({ runs: [], next: null, filters: { modes: [], bosses: [], weeks: [] } });
  return json(await battleHistory(env, account.discordId, new URL(request.url).searchParams, { owner: true }));
}
async function publicBattleHistory(request, env, publicId) {
  const profile = await env.DB.prepare("SELECT discord_id AS discordId, preferences_json AS prefs FROM profiles WHERE public_id = ? AND is_public = 1").bind(publicId).first();
  if (!profile || !profileVisibility(1, profile.prefs).parts.includes("history")) return json({ error: "Profile not found." }, 404);
  if (!leaderboardPublic(env)) return json({ runs: [], next: null, filters: { modes: [], bosses: [], weeks: [] } });
  return json(await battleHistory(env, profile.discordId, new URL(request.url).searchParams, { owner: false }));
}

// Picture retention. A run that is nobody's current best keeps its full screens 14 days and its crops 90 days; a
// current best (for its sender, or for a teammate it credits) and a run under review keep everything, and every run
// keeps its numbers. Pages has no scheduled runs, so a few go after each submission (pruneProofs(env, max)).
// "Best" errs on keeping: a teammate's best is judged against the runs that teammate sent.
const RETENTION = Object.freeze({ fullScreensS: 14 * 86400, cropsS: 90 * 86400 });
const BETTER_INTERLINK = (b, c) => `(COALESCE(${b}.stars, -1) > COALESCE(${c}.stars, -1) OR (COALESCE(${b}.stars, -1) = COALESCE(${c}.stars, -1)
  AND (COALESCE(${b}.score, -1) > COALESCE(${c}.score, -1) OR (COALESCE(${b}.score, -1) = COALESCE(${c}.score, -1) AND ${b}.created_at < ${c}.created_at))))`;
const NOBODYS_BEST = `(
  (c.kind = 'interlink_run'
    AND EXISTS (SELECT 1 FROM leaderboard_submissions b WHERE b.discord_id = c.discord_id AND b.kind IN ('interlink_run', 'interlink_best')
      AND b.cycle IS c.cycle AND b.boss_id IS c.boss_id AND b.status = 'visible' AND COALESCE(b.outcome, '') <> 'invalid' AND b.submission_id <> c.submission_id AND ${BETTER_INTERLINK("b", "c")})
    AND NOT EXISTS (SELECT 1 FROM json_each(c.players_json) pl JOIN game_characters gc ON gc.game_uid = json_extract(pl.value, '$.uid')
      WHERE gc.discord_id <> c.discord_id AND (gc.verified_at IS NOT NULL OR json_extract(pl.value, '$.confirmed') = 1)
        AND NOT EXISTS (SELECT 1 FROM leaderboard_submissions b WHERE b.discord_id = gc.discord_id AND b.kind IN ('interlink_run', 'interlink_best')
          AND b.cycle IS c.cycle AND b.boss_id IS c.boss_id AND b.status = 'visible' AND COALESCE(b.outcome, '') <> 'invalid' AND ${BETTER_INTERLINK("b", "c")})))
  OR (c.kind = 'sim_run'
    AND EXISTS (SELECT 1 FROM leaderboard_submissions b WHERE b.discord_id = c.discord_id AND b.kind = 'sim_run' AND b.cycle IS c.cycle AND b.trial IS c.trial
      AND b.difficulty IS c.difficulty AND b.status = 'visible' AND COALESCE(b.outcome, '') <> 'invalid' AND b.submission_id <> c.submission_id AND b.cleared = 1
      AND (COALESCE(c.cleared, 0) = 0 OR b.clear_time_s < c.clear_time_s OR (b.clear_time_s = c.clear_time_s AND b.created_at < c.created_at))))
) AND COALESCE(c.verify_state, '') NOT IN ('pending', 'mismatch')`;

async function pruneProofs(env, max) {
  if (!env.EVIDENCE) return 0;
  const now = Math.floor(Date.now() / 1000);
  let pruned = 0;
  try {
    // the whole screens after 14 days
    const full = (await env.DB.prepare(
      `SELECT c.submission_id AS submissionId, c.extra_json AS extraJson FROM leaderboard_submissions c
       WHERE json_extract(c.extra_json, '$.proofFull') IS NOT NULL AND c.created_at < ? AND ${NOBODYS_BEST}
       ORDER BY c.created_at ASC LIMIT ?`,
    ).bind(now - RETENTION.fullScreensS, max).all()).results || [];
    for (const row of full) {
      for (const key of Object.values((parseJsonColumn(row.extraJson) || {}).proofFull || {})) await env.EVIDENCE.delete(key);
      await env.DB.prepare("UPDATE leaderboard_submissions SET extra_json = json_remove(extra_json, '$.proofFull') WHERE submission_id = ?")
        .bind(row.submissionId).run();
      pruned += 1;
    }
    // the crops after 90 days
    const crops = (await env.DB.prepare(
      `SELECT c.submission_id AS submissionId, c.evidence_key AS evidenceKey, c.battle_evidence_key AS battleKey, c.extra_json AS extraJson
       FROM leaderboard_submissions c
       WHERE (c.evidence_key IS NOT NULL OR c.battle_evidence_key IS NOT NULL OR json_extract(c.extra_json, '$.proofParty') IS NOT NULL)
         AND c.proof_pruned_at IS NULL AND c.created_at < ? AND ${NOBODYS_BEST}
       ORDER BY c.created_at ASC LIMIT ?`,
    ).bind(now - RETENTION.cropsS, max).all()).results || [];
    for (const row of crops) {
      for (const key of proofKeys(row)) await env.EVIDENCE.delete(key);
      await env.DB.prepare(`UPDATE leaderboard_submissions SET evidence_key = NULL, battle_evidence_key = NULL, proof_pruned_at = ?,
        extra_json = json_remove(extra_json, '$.proofFull', '$.proofParty') WHERE submission_id = ?`).bind(now, row.submissionId).run();
      pruned += 1;
    }
  } catch (error) {
    if (/proof_pruned_at/u.test(String(error?.message))) { console.error("Picture retention needs migration 0033", error); return 0; }
    throw error;
  }
  return pruned;
}

// The profile's cards, as its owner arranged them: { order, hidden } of card ids, kept in profiles.preferences_json.
// Ids are checked for shape only, so a card the site adds later needs no server change (it goes last until arranged).
const PROFILE_CARD_ID = /^[a-z][a-z0-9-]{0,31}$/u;
function cleanProfileLayout(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = (value) => (Array.isArray(value) && value.length <= 32 && value.every((id) => PROFILE_CARD_ID.test(String(id)))
    ? [...new Set(value.map(String))] : null);
  const order = list(raw.order ?? []);
  const hidden = list(raw.hidden ?? []);
  return order && hidden ? { order, hidden } : null;
}
function storedProfileLayout(prefsJson) {
  try {
    return cleanProfileLayout(JSON.parse(prefsJson || "{}").profileLayout) || { order: [], hidden: [] };
  } catch {
    return { order: [], hidden: [] };
  }
}

// PUT /api/profile/layout {order, hidden}: the owner's arrangement; empty lists put it back to the site's default.
async function saveProfileLayout(request, env) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await currentAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  let body;
  try {
    body = await readJsonBody(request, 4096);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const layout = cleanProfileLayout(body);
  if (!layout) return json({ error: "layout must be { order, hidden }: lists of card ids." }, 400);
  const now = Math.floor(Date.now() / 1000);
  const empty = !layout.order.length && !layout.hidden.length;
  await env.DB.prepare(
    `INSERT INTO profiles (discord_id, display_name, bio, is_public, public_id, created_at, updated_at, preferences_json)
     VALUES (?1, NULL, NULL, 1, lower(hex(randomblob(8))), ?2, ?2, CASE WHEN ?3 IS NULL THEN NULL ELSE json_object('profileLayout', json(?3)) END)
     ON CONFLICT(discord_id) DO UPDATE SET updated_at = ?2, preferences_json = CASE WHEN ?3 IS NULL
       THEN json_remove(COALESCE(preferences_json, '{}'), '$.profileLayout')
       ELSE json_set(COALESCE(preferences_json, '{}'), '$.profileLayout', json(?3)) END`,
  ).bind(account.discordId, now, empty ? null : JSON.stringify(layout)).run();
  return json({ layout });
}

// Search engines: the site's robots.txt names this sitemap, listing the public profiles whose owners leave
// "List my profile in search engines" on. Only the random public id is in it, never a Discord id or UID.
async function profilesSitemap(env) {
  const origin = configuredPublicSiteOrigin(env) || "https://aniilogs.github.io";
  const rows = await env.DB.prepare(
    `SELECT p.public_id AS publicId, p.updated_at AS updatedAt FROM profiles p
     WHERE ${LISTED_PROFILE} AND p.listed_in_search = 1 ORDER BY p.updated_at DESC LIMIT 5000`,
  ).all();
  const urls = (rows.results || []).filter((row) => /^[A-Za-z0-9]{8,24}$/u.test(String(row.publicId))).map((row) => {
    const lastmod = Number(row.updatedAt) > 0 ? `<lastmod>${new Date(Number(row.updatedAt) * 1000).toISOString().slice(0, 10)}</lastmod>` : "";
    return `<url><loc>${origin}/?profile=${row.publicId}</loc>${lastmod}</url>`;
  });
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

async function publicProfile(request, env, publicId) {
  const profile = await env.DB.prepare(
    "SELECT discord_id AS discordId, bio, display_name AS displayName, findable_by_name AS findableByName, listed_in_search AS listedInSearch, preferences_json AS prefs FROM profiles WHERE public_id = ? AND is_public = 1",
  ).bind(publicId).first();
  if (!profile) return json({ error: "Profile not found." }, 404);
  // the owner opening their own link: the page shows them their own profile (with Edit) at this address
  const viewer = bearerToken(request) ? await currentAccount(request, env).catch(() => null) : null;
  const { parts } = profileVisibility(1, profile.prefs);
  const shows = (part) => parts.includes(part);
  const [characters, main] = await Promise.all([
    env.DB.prepare(`SELECT character_name AS name, json_extract(stats_json, '$.level') AS level, json_extract(stats_json, '$.exp') AS exp,
         json_extract(stats_json, '$.expNeeded') AS expNeeded,
      json_extract(stats_json, '$.gender') AS gender, json_extract(stats_json, '$.server') AS server FROM game_characters
      WHERE discord_id = ? AND character_name IS NOT NULL ORDER BY last_seen_at DESC`)
      .bind(profile.discordId).all(),
    mainCharacter(env, profile.discordId),
  ]);
  const progressRow = await profileProgressRow(env, profile.discordId, main);
  let completed = [];
  try {
    completed = progressRow ? progressPayload(JSON.parse(progressRow.dataJson))?.completed || [] : [];
  } catch {
    completed = [];
  }
  let leaderboards = null;
  if (leaderboardPublic(env) && shows("standings")) {
    const kinds = Object.keys(LEADERBOARD_KINDS);
    const standings = await Promise.all(kinds.map((kind) => boardStandings(env, profile.discordId, kind)));
    leaderboards = Object.fromEntries(kinds.map((kind, index) => [kind, standings[index].map(({ gameUid, ...entry }) => entry)]));
    leaderboards.interlinkSeason = await interlinkSeasonStanding(env, profile.discordId);
  }
  return json({
    // the display name only when its owner lets players find them by it; otherwise their main character's name
    profile: { displayName: (Number(profile.findableByName) === 1 && profile.displayName) || main?.name || characters.results?.[0]?.name || "Pathfinder", bio: shows("about") ? profile.bio || null : null, avatarUrl: null, isPublic: true, listedInSearch: Number(profile.listedInSearch ?? 1) === 1 },
    main: main?.name ? { name: main.name } : null,
    ...(viewer?.discordId === profile.discordId ? { own: true } : {}),
    parts,                                 // the parts this profile shows (the page leaves out the rest)
    layout: storedProfileLayout(profile.prefs),
    characters: shows("about") ? (characters.results || []).map((row) => ({ name: row.name, ...characterDetails(row) })) : [],
    presence: await profilePresence(env, profile.discordId),
    leaderboards,
    photos: shows("photos") ? await profilePhotos(env, profile.discordId, false) : [],
    gameStats: shows("collection") ? await characterStats(env, main) : null,
    collection: shows("collection") ? collectionSummary(completed, await releaseChecklist(env)) : null,
  });
}

// Profile photos: pictures players took in Aniimo, uploaded from the aLogs app (WebP, kept privately in R2 under
// photos/). They show wherever the profile shows - to the owner, and to everyone once the profile is public - with what
// the game recorded: when, which character, the Aniimo in it and where. Public views never carry the UID.
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
const PHOTOS_PER_ACCOUNT = 500;

function cleanPhotoMeta(raw) {
  const meta = raw && typeof raw === "object" ? raw : {};
  const gamePhotoId = String(meta.gamePhotoId || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(gamePhotoId)) return { error: "The photo's game id is missing." };
  const int = (value, low, high) => (Number.isInteger(value) && value >= low && value <= high ? value : null);
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e7 ? value : null);
  const gameUid = /^\d{6,20}$/u.test(String(meta.gameUid || "")) ? String(meta.gameUid) : null;
  const aniimo = Array.isArray(meta.aniimo) ? [...new Set(meta.aniimo.filter((id) => int(id, 1, 1e9) != null))].slice(0, 20) : [];
  return {
    gamePhotoId, gameUid,
    takenAt: int(meta.takenAt, 1e9, 1e10),
    sceneId: int(meta.sceneId, 0, 1e7),
    pos: meta.pos && typeof meta.pos === "object" ? { x: num(meta.pos.x), y: num(meta.pos.y), z: num(meta.pos.z) } : { x: null, y: null, z: null },
    aniimo,
    width: int(meta.width, 1, 10000),
    height: int(meta.height, 1, 10000),
  };
}

async function uploadProfilePhoto(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Sign in to upload photos." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  if (!env.EVIDENCE) return json({ error: "Photo uploads are unavailable." }, 503);
  if (Number(request.headers.get("content-length") || 0) > PHOTO_MAX_BYTES + 16384) return json({ error: "The photo is too large." }, 413);
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Could not read the upload." }, 400);
  }
  const photo = form.get("photo");
  if (!photo || typeof photo === "string" || !photo.size) return json({ error: "The photo is missing." }, 400);
  if (photo.size > PHOTO_MAX_BYTES) return json({ error: "The photo is too large." }, 413);
  const head = new Uint8Array(await photo.slice(0, 12).arrayBuffer());
  const text = (a, b) => String.fromCharCode(...head.slice(a, b));
  if (text(0, 4) !== "RIFF" || text(8, 12) !== "WEBP") return json({ error: "Photos are uploaded as WebP." }, 400);
  let meta;
  try {
    meta = cleanPhotoMeta(JSON.parse(String(form.get("meta") || "{}")));
  } catch {
    return json({ error: "The photo's details are invalid." }, 400);
  }
  if (meta.error) return json({ error: meta.error }, 400);
  if (meta.gameUid) {
    const owner = await env.DB.prepare("SELECT discord_id AS discordId FROM game_characters WHERE game_uid = ? LIMIT 1").bind(meta.gameUid).first();
    if (owner && owner.discordId !== account.discordId) return json({ error: "This character is linked to another account." }, 409);
  }
  const existing = await env.DB.prepare(
    "SELECT photo_id AS id FROM profile_photos WHERE discord_id = ? AND game_photo_id = ?",
  ).bind(account.discordId, meta.gamePhotoId).first();
  if (existing) return json({ ok: true, id: existing.id, duplicate: true });
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM profile_photos WHERE discord_id = ?").bind(account.discordId).first();
  if (Number(count) >= PHOTOS_PER_ACCOUNT) return json({ error: `A profile holds up to ${PHOTOS_PER_ACCOUNT} photos: delete some first.` }, 409);

  const id = randomToken(12);
  const key = `photos/${account.discordId}/${id}.webp`;
  await env.EVIDENCE.put(key, photo.stream(), { httpMetadata: { contentType: "image/webp" } });
  await env.DB.prepare(
    `INSERT INTO profile_photos (photo_id, discord_id, game_photo_id, game_uid, taken_at, scene_id, pos_x, pos_y, pos_z,
       aniimo_json, width, height, size_bytes, photo_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, account.discordId, meta.gamePhotoId, meta.gameUid, meta.takenAt, meta.sceneId, meta.pos.x, meta.pos.y, meta.pos.z,
    JSON.stringify(meta.aniimo), meta.width, meta.height, photo.size, key, Math.floor(Date.now() / 1000)).run();
  return json({ ok: true, id }, 201);
}

// An account's photos, newest first. `owner` adds what only the owner sees (the UID and the game's photo id).
async function profilePhotos(env, discordId, owner) {
  const { results } = await env.DB.prepare(
    `SELECT p.photo_id AS id, p.game_photo_id AS gamePhotoId, p.game_uid AS gameUid, p.taken_at AS takenAt, p.scene_id AS sceneId,
       p.pos_x AS x, p.pos_y AS y, p.pos_z AS z, p.aniimo_json AS aniimo, p.width, p.height, gc.character_name AS character
     FROM profile_photos p LEFT JOIN game_characters gc ON gc.game_uid = p.game_uid AND gc.discord_id = p.discord_id
     WHERE p.discord_id = ? ORDER BY COALESCE(p.taken_at, p.created_at) DESC LIMIT ?`,
  ).bind(discordId, PHOTOS_PER_ACCOUNT).all();
  return (results || []).map((row) => ({
    id: row.id,
    url: `/api/photos/${row.id}`,
    takenAt: row.takenAt,
    character: row.character || null,
    sceneId: row.sceneId,
    pos: row.x == null ? null : { x: row.x, y: row.y, z: row.z },
    aniimo: parseJsonColumn(row.aniimo) || [],
    width: row.width,
    height: row.height,
    ...(owner ? { gameUid: row.gameUid, gamePhotoId: row.gamePhotoId } : {}),
  }));
}

async function listOwnPhotos(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  return json({ photos: await profilePhotos(env, account.discordId, true) });
}

async function deleteProfilePhoto(request, env, photoId) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const row = await env.DB.prepare("SELECT discord_id AS discordId, photo_key AS photoKey FROM profile_photos WHERE photo_id = ?").bind(photoId).first();
  if (!row) return json({ error: "Photo not found." }, 404);
  if (row.discordId !== account.discordId && !account.developerModeAvailable) return json({ error: "You can only delete your own photos." }, 403);
  await env.EVIDENCE?.delete(row.photoKey);
  await env.DB.prepare("DELETE FROM profile_photos WHERE photo_id = ?").bind(photoId).run();
  return json({ ok: true });
}

// The picture itself: for anyone while its profile is public, else for its owner (and developers) only.
async function profilePhotoImage(request, env, photoId) {
  const row = await env.DB.prepare(
    `SELECT p.discord_id AS discordId, p.photo_key AS photoKey, COALESCE(pr.is_public, 0) AS isPublic
     FROM profile_photos p LEFT JOIN profiles pr ON pr.discord_id = p.discord_id WHERE p.photo_id = ?`,
  ).bind(photoId).first();
  if (!row || !env.EVIDENCE) return json({ error: "Photo not found." }, 404);
  const visible = Number(row.isPublic) === 1;
  if (!visible) {
    const account = await leaderboardAccount(request, env);
    if (!account || (account.discordId !== row.discordId && !account.developerModeAvailable)) return json({ error: "Photo not found." }, 404);
  }
  const object = await env.EVIDENCE.get(row.photoKey);
  if (!object) return json({ error: "Photo not found." }, 404);
  const headers = securityHeaders(new Headers());
  headers.set("content-type", "image/webp");
  headers.set("cache-control", visible ? "public, max-age=3600" : "private, no-store");
  return new Response(object.body, { status: 200, headers });
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
      `SELECT evidence_key AS evidenceKey, battle_evidence_key AS battleKey, extra_json AS extraJson FROM leaderboard_submissions
       WHERE discord_id = ? AND (evidence_key IS NOT NULL OR battle_evidence_key IS NOT NULL)`,
    ).bind(discordId).all();
    for (const row of results || []) {
      for (const key of proofKeys(row)) await env.EVIDENCE.delete(key);
    }
    const photos = await env.DB.prepare("SELECT photo_key AS photoKey FROM profile_photos WHERE discord_id = ?").bind(discordId).all();
    for (const row of photos.results || []) {
      await env.EVIDENCE.delete(row.photoKey);
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_handoffs WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM leaderboard_tokens WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM leaderboard_submissions WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM game_characters WHERE discord_id = ?").bind(discordId),
    env.DB.prepare("DELETE FROM profile_photos WHERE discord_id = ?").bind(discordId),
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
// A run's proof: the app sends JPEGs - the cropped result screen ("evidence", from aLogs B2 at native size, ~0.3-0.6 MB
// at 4K), the whole screen ("evidence_full", at most 1920 wide, ~0.2-0.4 MB) and the same pair for Battle Data
// ("battle", "battle_full"), and the Party screen as it was when the battle started ("party": the leader or anyone can
// still change their Aniimo until then, so it's the last capture). Each image is capped here; anything larger isn't a
// screenshot from the app.
const MAX_EVIDENCE_BYTES = 1536 * 1024;
const EVIDENCE_PARTS = 5;
const EVIDENCE_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" });
const LEADERBOARD_KINDS = Object.freeze({
  interlink_run: "interlink",
  interlink_week: "interlink",
  interlink_best: "interlink",
  sim_run: "sim",
  eggheist_season: "eggheist",
  eggheist_match: "eggheist",
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
  p_dps: "DESC",
  p_break: "DESC",
  p_taken: "DESC",
  p_heal: "DESC",
  defeats: "DESC",
  difficulty: "DESC",
  player: "ASC",
});
// Egg Heist difficulties, hardest first
// Holo-Battle Sim stages, from the client's tables (rogue_difficulty_data, rogue_season_data), newest season first.
// Season 1: an element (Grass, Water, Fire) at Easy, Normal (the English client says "Common") or Hard ("Training of
// Water - Hard", Basic Training) or at Challenge ("Crucible of Fire - Challenge", which the Victory screen also calls
// "Trial of Fire", Elemental Crucible). Season 2: Earth, Lightning or Dark at Easy to Trial ("Earth Training - Trial");
// the game's own leaderboard ranks Trial only. A run is stored by season (cycle), element (trial) and difficulty: one
// board each. The facets send these rules to the page; a game update that adds a season only needs one added here.
const simSeason = (season, start, end, elements, stages) => Object.freeze({
  season, start: Date.parse(start) / 1000, end: Date.parse(end) / 1000, elements: Object.freeze(elements),
  difficulties: Object.freeze(stages.flatMap((stage) => stage.difficulties)),     // easiest to hardest
  stages: Object.freeze(stages.map((stage) => Object.freeze({ ...stage, difficulties: Object.freeze(stage.difficulties) }))),
});
const SIM_RULES = Object.freeze({
  seasons: Object.freeze([
    simSeason(2, "2026-10-29T02:00:00Z", "2026-12-09T03:59:59Z", ["Earth", "Lightning", "Dark"], [
      { id: "training", label: "Training", name: "{element} Training", difficulties: ["Easy", "Normal", "Hard", "Challenge", "Trial"] },
    ]),
    simSeason(1, "2026-07-31T00:00:00Z", "2026-10-28T23:59:59Z", ["Grass", "Water", "Fire"], [
      { id: "basic", label: "Basic Training", name: "Training of {element}", difficulties: ["Easy", "Normal", "Hard"] },
      { id: "crucible", label: "Elemental Crucible", name: "Crucible of {element}", alias: "Trial of {element}", difficulties: ["Challenge"] },
    ]),
  ]),
  aliases: Object.freeze({ Common: "Normal" }),                                     // Season 1's English Normal
  confirmed: true,
});
// "Training of Water", "Trial of Fire", "Crucible of Fire", "Earth Training" or just "Fire": the element, or null
function simElement(trial) {
  const match = String(trial || "").trim().match(/^(?:(?:Training|Trial|Crucible) of )?([A-Za-z]+)(?: Training)?$/iu);
  const word = match?.[1].toLowerCase();
  return SIM_RULES.seasons.flatMap((season) => season.elements).find((element) => element.toLowerCase() === word) || null;
}
// the season a run belongs to: the one with its element (the one it was played in, should a later season reuse it)
function simSeasonOf(element, playedAt = null, cycle = null) {
  const sent = SIM_RULES.seasons.find((season) => String(season.season) === String(cycle ?? ""));
  if (sent && (!element || sent.elements.includes(element))) return sent;
  const seasons = SIM_RULES.seasons.filter((season) => !element || season.elements.includes(element));
  return seasons.find((season) => playedAt && season.start <= playedAt && playedAt <= season.end)
    || seasons.find((season) => playedAt && season.start <= playedAt) || seasons.at(-1) || null;
}
function simDifficulty(difficulty) {
  return SIM_RULES.aliases[difficulty] || difficulty;
}
function simStage(difficulty, season = null) {
  const seasonRules = typeof season === "object" && season ? season : simSeasonOf(null, null, season);
  return seasonRules?.stages.find((stage) => stage.difficulties.includes(difficulty)) || null;
}
function simStageName(element, difficulty, cycle = null) {
  const stage = simStage(difficulty, simSeasonOf(element, null, cycle));
  return element && stage ? stage.name.replace("{element}", element) : element || null;
}

const DIFFICULTY_RANK_SQL = (prefix) => `CASE ${prefix}difficulty WHEN 'Chaos' THEN 4 WHEN 'Nightmare' THEN 3 WHEN 'Hard' THEN 2 WHEN 'Normal' THEN 1 ELSE 0 END`;
// Sorts that only order the rows: each player's row is still their best by the board's main measure (best loot,
// best score...), then the list is ordered by name, date or difficulty.
const DISPLAY_SORTS = new Set(["player", "played_at", "difficulty"]);
const LEADERBOARD_DEFAULT_SORT = Object.freeze({
  interlink_run: "score",
  interlink_week: "score",
  interlink_best: "score",
  sim_run: "clear_time_s",
  eggheist_season: "standing",
  eggheist_match: "score",
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
    return { discordId, viaToken: true, ...await accountRoleFields(discordId, env) };
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

// Names that look the same: accents and width forms dropped, lookalike letters folded together (Cyrillic and Greek
// letters to Latin, 0/O, 1/l/I/|, rn/m, vv/w), after Unicode's confusable-skeleton idea (UTS #39). Two characters with
// one skeleton but different UIDs are lookalikes: the boards mark them, and only the UID tells them apart.
const CONFUSABLE_LETTERS = Object.freeze({
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d",
  "ӏ": "l", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b", "ɡ": "g", "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t",
  "κ": "k", "ι": "i", "υ": "u", "χ": "x", "ε": "e", "β": "b", "μ": "u", "0": "o", "1": "l", "|": "l", "!": "l", "5": "s",
  "$": "s", "@": "a", "3": "e", "ø": "o", "ł": "l", "đ": "d", "ß": "ss",
});
export function nameSkeleton(name) {
  const folded = String(name || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return [...folded].map((letter) => CONFUSABLE_LETTERS[letter] ?? letter).join("")
    .replace(/i/gu, "l").replace(/rn/gu, "m").replace(/vv/gu, "w").replace(/cl/gu, "d")
    .replace(/[\s_.\-·•'`´]/gu, "");
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
    server: boundedText(value.server, 40),
    playedAt: boundedInteger(value.playedAt, 1.5e9, 4e9),
    // Egg Heist matches and Holo-Battle Sim runs: the difficulty shown on the end screen; Egg Heist's Total Defeats
    difficulty: boundedText(value.difficulty, 20, /^[A-Za-z ]+$/u),
    // Holo-Battle Sim: the trial named on the Victory screen ("Training of Water", "Trial of Fire")
    trial: boundedText(value.trial, 40, /^[A-Za-z][A-Za-z' -]*$/u),
    defeats: boundedInteger(value.defeats, 0, 1000),
  };
  const bad = Object.entries(record).find(([, field]) => field === undefined);
  if (bad) return { error: `Field ${bad[0]} is invalid.` };
  // a Holo-Battle Sim run names one of the game's stages: stored by season (cycle) and element, with a difficulty
  // that season's stages have
  if (record.kind === "sim_run") {
    if (record.trial !== null) {
      record.trial = simElement(record.trial);
      if (!record.trial) return { error: "Field trial is invalid." };
    }
    const season = record.trial ? simSeasonOf(record.trial, record.playedAt) : null;
    record.cycle = season ? String(season.season) : null;
    if (record.difficulty !== null) {
      record.difficulty = simDifficulty(record.difficulty);
      const allowed = season ? season.difficulties : SIM_RULES.seasons.flatMap((item) => item.difficulties);
      if (!allowed.includes(record.difficulty)) return { error: "Field difficulty is invalid." };
    }
  } else record.trial = null;
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
      self: player.self === undefined ? null : Boolean(player.self),
      uid: boundedText(player.uid, 24, /^\d+$/u),     // the teammate's UID, when the game showed it with the run
    };
    if (Object.values(clean).some((field) => field === undefined)) return { error: "A player field is invalid." };
    if (clean.name) clean.skel = nameSkeleton(clean.name);
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

  // a season standing belongs to a season: without one it would sit on the ladder as a second row for the player
  if (record.kind === "eggheist_season" && !record.cycle) return { error: "An Egg Heist standing needs its season (cycle)." };

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
  if (declared > MAX_SUBMISSION_BYTES + EVIDENCE_PARTS * MAX_EVIDENCE_BYTES + 16384) throw new RangeError("Request body is too large.");
  const form = await request.formData();
  const text = String(form.get("submission") || "");
  if (encoder.encode(text).byteLength > MAX_SUBMISSION_BYTES) throw new RangeError("Submission is too large.");
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    throw new TypeError("Submission must be valid JSON.");
  }
  // the result screen ("evidence") and, for a best run, its Battle Data screen ("battle")
  const picture = (name) => {
    const file = form.get(name);
    if (!file || typeof file === "string") return null;
    if (!EVIDENCE_TYPES[file.type]) throw new TypeError("Evidence must be a JPEG, PNG or WebP image.");
    if (file.size > MAX_EVIDENCE_BYTES) throw new RangeError("Evidence image is too large.");
    return file;
  };
  const evidence = picture("evidence");
  const battle = evidence ? picture("battle") : null;
  // the whole screens the crops came from (aLogs B2 on): kept for a second reading and for review
  return { body, evidence, battle, evidenceFull: evidence ? picture("evidence_full") : null, battleFull: battle ? picture("battle_full") : null,
    party: picture("party") };
}

// Two app users in one Interlink run both send it: same week and boss, played and sent within five minutes of each
// other, - when both apps read it from the game log - in the same dungeon instance, and either the same score, stars
// and time or the same party on the Party screen (the same players in the same slots, at least two of them real
// players: a misread number then doesn't split one run in two). Only full runs
// (result screen, timer, party) count: a best score read off the prep screen says nothing about who was in a run.
// The instance id stays server-side (see leaderboardEntries), so nobody can copy it into a made-up run. Each submission then vouches for the other: the other player's slot in this run's party gets their UID
// (from their own submission, whose UID only their account can send) and is marked confirmed, and the same the other
// way round. That is how a teammate's row gets a UID with the run - no name matching after the fact.
const CORROBORATE_WINDOW_S = 5 * 60;
async function corroborateRun(env, submissionId) {
  const me = await env.DB.prepare(
    `SELECT submission_id AS id, discord_id AS discordId, kind, game_uid AS gameUid, cycle, boss_id AS bossId, score, stars,
       clear_time_s AS clearTimeS, COALESCE(played_at, created_at) AS at, created_at AS sentAt, players_json AS playersJson,
       extra_json AS extraJson, json_extract(extra_json, '$.instanceId') AS instanceId, server
     FROM leaderboard_submissions WHERE submission_id = ?`,
  ).bind(submissionId).first();
  if (!me || me.kind !== "interlink_run" || me.score == null || !me.gameUid) return;
  const { results: nearby } = await env.DB.prepare(
    `SELECT submission_id AS id, discord_id AS discordId, game_uid AS gameUid, players_json AS playersJson, extra_json AS extraJson,
       score, stars, clear_time_s AS clearTimeS
     FROM leaderboard_submissions
     WHERE kind = 'interlink_run' AND submission_id <> ? AND discord_id <> ? AND game_uid IS NOT NULL AND game_uid <> ?
       AND cycle IS ? AND boss_id IS ?
       AND ABS(COALESCE(played_at, created_at) - ?) <= ? AND ABS(created_at - ?) <= ?
       AND (? IS NULL OR json_extract(extra_json, '$.instanceId') IS NULL OR json_extract(extra_json, '$.instanceId') = ?)
       AND (? IS NULL OR server IS NULL OR server = ?)`,
  ).bind(me.id, me.discordId, me.gameUid, me.cycle, me.bossId, me.at, CORROBORATE_WINDOW_S,
    me.sentAt, CORROBORATE_WINDOW_S, me.instanceId, me.instanceId, me.server, me.server).all();
  const myExtra = parseJsonColumn(me.extraJson) || {};
  const results = (nearby || []).filter((other) => (other.score === me.score && other.stars === me.stars && other.clearTimeS === me.clearTimeS)
    || sameParty(myExtra.lineup, (parseJsonColumn(other.extraJson) || {}).lineup));
  // the name a submission's sender goes by in that run: their own (self) slot, else their linked character's name
  const ownName = async (row, players) => players.find((player) => player?.self)?.name
    || (await env.DB.prepare("SELECT character_name AS name FROM game_characters WHERE game_uid = ?").bind(row.gameUid).first())?.name || null;
  // put the other sender's UID on their slot (matched by lookalike-folded name, never an AI or the sender's own slot)
  const vouch = (players, name, gameUid) => {
    if (!name) return false;
    const skeleton = nameSkeleton(name);
    const slot = players.find((player) => player?.name && player.ai !== true && !player.self && (player.skel || nameSkeleton(player.name)) === skeleton);
    if (!slot || (slot.uid === gameUid && slot.confirmed)) return false;
    Object.assign(slot, { uid: gameUid, confirmed: true });
    return true;
  };
  const mine = parseJsonColumn(me.playersJson) || [];
  let mineChanged = false;
  for (const other of results || []) {
    const theirs = parseJsonColumn(other.playersJson) || [];
    if (vouch(mine, await ownName(other, theirs), other.gameUid)) mineChanged = true;
    if (vouch(theirs, await ownName(me, mine), me.gameUid)) {
      await env.DB.prepare("UPDATE leaderboard_submissions SET players_json = ? WHERE submission_id = ?").bind(JSON.stringify(theirs), other.id).run();
    }
  }
  if (mineChanged) {
    await env.DB.prepare("UPDATE leaderboard_submissions SET players_json = ? WHERE submission_id = ?").bind(JSON.stringify(mine), me.id).run();
  }
  // link the copies as one shared run (server-only extra.sharedRun: the first copy's id), for Battle History
  if (results.length) {
    const group = (results.map((other) => (parseJsonColumn(other.extraJson) || {}).sharedRun).find(Boolean)) || myExtra.sharedRun
      || [me.id, ...results.map((other) => other.id)].sort()[0];
    for (const id of [me.id, ...results.map((other) => other.id)]) {
      await env.DB.prepare("UPDATE leaderboard_submissions SET extra_json = json_set(COALESCE(extra_json, '{}'), '$.sharedRun', ?) WHERE submission_id = ?")
        .bind(group, id).run();
    }
  }
}

// Whether two Party screens (extra.lineup) show the same party: every slot both read has the same player (names
// folded for lookalike letters), both read the same slots, and at least two of them are real players.
function sameParty(a, b) {
  const slots = (lineup) => new Map((Array.isArray(lineup) ? lineup : []).filter((entry) => Number.isInteger(entry?.slot) && entry.name)
    .map((entry) => [entry.slot, { skel: nameSkeleton(entry.name), ai: entry.ai === true }]));
  const mine = slots(a);
  const theirs = slots(b);
  if (mine.size < 2 || mine.size !== theirs.size) return false;
  let players = 0;
  for (const [slot, entry] of mine) {
    const other = theirs.get(slot);
    if (!other || other.skel !== entry.skel) return false;
    if (!entry.ai && !other.ai) players += 1;
  }
  return players >= 2;
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
  // An Interlink run must be on one of its week's three bosses, and takes that boss's name from the week's list
  // (a misread name on the screen never reaches the boards).
  if ((record.kind === "interlink_run" || record.kind === "interlink_best") && record.cycle != null) {
    const week = interlinkCycle(await interlinkCycles(env), record.cycle);
    if (week) {
      // From week 4003 the middle fight can have two bosses: a run on the second one counts on the middle board.
      const middle = interlinkSecondMiddle(week, record.bossId);
      if (middle) record.bossId = middle.id;
      const boss = week.bosses.find((b) => String(b.id) === String(record.bossId));
      if (!boss) return json({ error: "That boss isn't one of this week's Interlink bosses." }, 400);
      record.bossName = boss.name;
    }
  }
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
    `SELECT submission_id AS submissionId, evidence_key AS evidenceKey, battle_evidence_key AS battleKey, extra_json AS extraJson FROM leaderboard_submissions
     WHERE discord_id = ? AND kind = ? AND client_run_id = ? LIMIT 1`,
  ).bind(account.discordId, record.kind, record.clientRunId).first();
  // at most DAILY_RUN_LIMIT (default 300) new records an account a UTC day: far above real play (a run is 3 minutes),
  // so only a broken or abusive sender meets it. Re-sends of a record already stored don't count.
  if (!existing) {
    const limit = Math.max(1, Number.parseInt(env.DAILY_RUN_LIMIT || "300", 10) || 300);
    const today = await env.DB.prepare("SELECT COUNT(*) AS sent FROM leaderboard_submissions WHERE discord_id = ? AND created_at >= ?")
      .bind(account.discordId, Math.floor(Date.now() / 86400000) * 86400).first();
    if (Number(today?.sent || 0) >= limit) return json({ error: `At most ${limit} records a day; try again after 00:00 UTC.` }, 429);
  }
  const submissionId = existing?.submissionId || randomToken(12);
  let evidenceKey = existing?.evidenceKey || null;
  let battleKey = existing?.battleKey || null;
  // the whole screens: stored beside the crops, and named in the run's server-only extra.proofFull (the app can't
  // set it: anything it sends there is replaced)
  const proofFull = { ...((parseJsonColumn(existing?.extraJson) || {}).proofFull || {}) };   // kept when a re-send has none
  for (const [name, part, suffix] of [["evidence", parsed.evidenceFull, "full"], ["battle", parsed.battleFull, "battle-full"]]) {
    if (!part || !env.EVIDENCE) continue;
    const key = `evidence/${account.discordId}/${submissionId}-${suffix}.${EVIDENCE_TYPES[part.type]}`;
    await env.EVIDENCE.put(key, part.stream(), { httpMetadata: { contentType: part.type } });
    proofFull[name] = key;
  }
  // the Party screen (server-only extra.proofParty): a re-send with a newer one replaces it
  let proofParty = (parseJsonColumn(existing?.extraJson) || {}).proofParty || null;
  if (parsed.party && env.EVIDENCE) {
    proofParty = `evidence/${account.discordId}/${submissionId}-party.${EVIDENCE_TYPES[parsed.party.type]}`;
    await env.EVIDENCE.put(proofParty, parsed.party.stream(), { httpMetadata: { contentType: parsed.party.type } });
  }
  if (record.extraJson || Object.keys(proofFull).length || proofParty) {
    const extra = parseJsonColumn(record.extraJson) || {};
    delete extra.proofFull;
    delete extra.proofParty;
    delete extra.sharedRun;
    if (Object.keys(proofFull).length) extra.proofFull = proofFull;
    if (proofParty) extra.proofParty = proofParty;
    record.extraJson = Object.keys(extra).length ? JSON.stringify(extra) : null;
  }
  if (parsed.battle && env.EVIDENCE) {
    battleKey = `evidence/${account.discordId}/${submissionId}-battle.${EVIDENCE_TYPES[parsed.battle.type]}`;
    await env.EVIDENCE.put(battleKey, parsed.battle.stream(), { httpMetadata: { contentType: parsed.battle.type } });
  }
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
      players_json, buffs_json, extra_json, evidence_key, client_version, played_at, created_at, updated_at, server,
      battle_evidence_key, difficulty, defeats, trial
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(discord_id, kind, client_run_id) DO UPDATE SET
      game_uid = excluded.game_uid, cycle = excluded.cycle, boss_id = excluded.boss_id,
      boss_name = excluded.boss_name, boss_level = excluded.boss_level, score = excluded.score,
      rank_tier = excluded.rank_tier, rank_subtier = excluded.rank_subtier, rank_name = excluded.rank_name,
      stars = excluded.stars, clear_time_s = excluded.clear_time_s, cleared = excluded.cleared,
      floors = excluded.floors, team_dps = excluded.team_dps, meter_dps = excluded.meter_dps,
      meter_damage = excluded.meter_damage, party_size = excluded.party_size,
      players_json = excluded.players_json, buffs_json = excluded.buffs_json, extra_json = excluded.extra_json,
      evidence_key = excluded.evidence_key, client_version = excluded.client_version,
      played_at = excluded.played_at, updated_at = excluded.updated_at, server = excluded.server,
      battle_evidence_key = excluded.battle_evidence_key, difficulty = excluded.difficulty, defeats = excluded.defeats,
      trial = excluded.trial`,
  ).bind(
    submissionId, account.discordId, record.mode, record.kind, record.clientRunId, record.gameUid, record.cycle,
    record.bossId, record.bossName, record.bossLevel, record.score, record.rankTier, record.rankSubtier, record.rankName, record.stars, record.clearTimeS,
    record.cleared, record.floors, record.teamDps, record.meterDps, record.meterDamage, record.partySize,
    record.playersJson, record.buffsJson, record.extraJson, evidenceKey, record.clientVersion,
    record.playedAt, now, now, record.server, battleKey, record.difficulty, record.defeats, record.trial,
  ).run();
  await corroborateRun(env, submissionId);
  try {
    await storeRunOutcome(env, submissionId);
  } catch (error) {
    console.error("Run outcomes need migration 0033", error);
  }
  // the free checks, and for runs that matter the AI reading (shadow mode), after the response when the platform allows
  if (record.kind === "interlink_run") {
    // ... and while today's cap has room, up to 2 of the oldest queued runs (so a raised cap or the daily reset
    // works through the queue by itself)
    const checking = checkRun(env, submissionId).then(() => drainRunChecks(env, 2))
      .catch((error) => console.error("Run checks failed", error));
    if (env.waitUntil) env.waitUntil(checking);
    else await checking;
  }
  const pruning = pruneProofs(env, 4).catch((error) => console.error("Picture retention failed", error));
  if (env.waitUntil) env.waitUntil(pruning);
  else await pruning;
  return json({
    ok: true,
    submissionId,
    updated: Boolean(existing),
    evidenceStored: Boolean(parsed.evidence && env.EVIDENCE),
    battleEvidenceStored: Boolean(parsed.battle && env.EVIDENCE),
  }, existing ? 200 : 201);
}


// ---------------------------------------------------------------- second reading (shadow mode)
// aLogs reads a run off the screen; for the runs that matter (checkRun) the server reads the same whole screens again
// with Workers AI (env.AI) and compares: score, stars and time from the result screen, each Battle Data card's Avg DPS,
// BREAK, Damage Taken and Healing. Shadow mode: the outcome (verify_state, migration 0032) is recorded for an
// administrator to review and never holds a run off the boards. Without the AI binding nothing is read.
const VERIFY_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const VERIFY_PROMPTS = Object.freeze({
  // measured on five real runs (stars were missed beside their icon; the time is shown in seconds, "180s")
  result: "This is the end-of-run result screen of the game Aniimo (Holo-Battle Interlink). Read the run's total score, "
    + "the Challenge Rating number (the number next to the star icon), and the battle time as shown. Reply with only JSON, "
    + 'no other text: {"score": <integer>, "stars": <integer>, "time": "<as shown, e.g. 180s or 2:45>"}. Use null for '
    + "anything you cannot read clearly.",
  // a card's rows are always the same four, in order; a blank-looking row is 0 (read otherwise, the values shift)
  battle: "This is the Battle Data screen of the game Aniimo: up to four player cards side by side. Each card has exactly "
    + "four rows in this order: Average DPS, BREAK, Damage Taken, Healing; a row may show 0. For each card, left to right, "
    + "read the player's name and those four numbers. Reply with only JSON, no other text: {\"cards\": [{\"name\": "
    + '"<text>", "avgDps": <integer>, "break": <integer>, "taken": <integer>, "heal": <integer>}]}. Use null for anything '
    + "you cannot read clearly.",
});

function firstJson(text) {
  const start = String(text || "").indexOf("{");
  const end = String(text || "").lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(String(text).slice(start, end + 1));
  } catch {
    return null;
  }
}

const readNumber = (value) => {
  const number = Number(String(value ?? "").replace(/[^\d.]/gu, ""));
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : Math.round(number);
};
// "2:45", "1:02:03", or seconds as the screen shows them ("180s", 180)
const readSeconds = (value) => {
  const seconds = String(value ?? "").trim().match(/^(\d+)\s*s?$/iu);
  if (seconds) return Number(seconds[1]);
  const match = String(value ?? "").match(/(\d+):(\d{1,2})(?::(\d{1,2}))?/u);
  if (!match) return null;
  return match[3] !== undefined ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : Number(match[1]) * 60 + Number(match[2]);
};

async function readScreen(env, key, prompt) {
  const object = await env.EVIDENCE.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  const out = await env.AI.run(VERIFY_MODEL, { prompt, image: [...bytes], max_tokens: 400 });
  return firstJson(out?.response ?? out?.result?.response ?? out);
}

// What the second reading found against what the app sent: { checked, differences: [{ field, sent, read }] }.
// A value the reading couldn't make out isn't a difference; Battle Data cards are matched by name, else by order.
function compareReading(row, result, battle) {
  const differences = [];
  let checked = 0;
  const same = (field, sent, read, tolerance = 0) => {
    if (read === null || read === undefined || sent === null || sent === undefined) return;
    checked += 1;
    if (Math.abs(Number(sent) - Number(read)) > tolerance) differences.push({ field, sent, read });
  };
  if (result) {
    same("score", row.score, readNumber(result.score));
    same("stars", row.stars, readNumber(result.stars));
    if (row.cleared === 1) same("time", row.clearTimeS, readSeconds(result.time), 1);
  }
  const players = parseJsonColumn(row.playersJson) || [];
  const cards = Array.isArray(battle?.cards) ? battle.cards : [];
  const key = (name) => String(name || "").toLocaleLowerCase().replace(/\s+/gu, "");
  // a card read as shifted (BREAK missing but Healing there: a 0 row skipped, as the old OCR did) isn't compared
  const suspect = [];
  players.forEach((player, index) => {
    // by name when the reading has the player's name, else by position (it sometimes returns the card's title)
    const card = cards.find((item) => key(item?.name) && key(item.name) === key(player.name)) || cards[index];
    if (!card) return;
    const label = player.name || `card ${index + 1}`;
    if (readNumber(card.break) === null && readNumber(card.heal) !== null) {
      suspect.push(label);
      return;
    }
    same(`${label} Avg DPS`, player.avgDps, readNumber(card.avgDps));
    same(`${label} BREAK`, player.breakValue, readNumber(card.break));
    same(`${label} Damage Taken`, player.damageTaken, readNumber(card.taken));
    same(`${label} Healing`, player.heal, readNumber(card.heal));
  });
  return { checked, differences, ...(suspect.length ? { suspect } : {}) };
}

// Every Interlink run gets the free checks (no AI): the numbers the app read must hang together. Each flag names the
// rule; a run with flags is listed for review (verify_state "mismatch"). Shadow mode: nothing is held.
// - stars track score: each star is worth about 1,000, so stars = min(floor(score / 1000), the slot's cap), give or
//   take one (36,230 with 6 stars fails);
// - the players' Avg DPS add up to about the team DPS, and to about the meter's DPS when it measured one (within 35%);
// - no player's Avg DPS is above the whole team's, nor above 3x an even share in a full party (a BREAK-sized number
//   in a DPS field shows up here);
// - "cleared" only with the slot's full kill stars;
// - the star cap aLogs read from the game (extra.starCap) is the rules' for that boss (else the game changed).
// The run's own cap, when sent, is the one the stars and the clear are judged by.
const RUN_CHECK_TOLERANCE = 0.35;
function freeRunChecks(row, cycle) {
  const flags = [];
  const slot = cycle ? cycle.bosses.findIndex((boss) => String(boss.id) === String(row.bossId)) : -1;
  const sent = sentStarCap(row.extraJson);
  const { cap, clear, ruleCap } = runStarRule(row.cycle, slot, sent);
  // the game's cap for this boss isn't what the site's rules say: the game changed (INTERLINK_RULES needs updating)
  if (sent != null && slot >= 0 && sent !== ruleCap) {
    flags.push({ rule: "star cap matches the rules", sent, expected: ruleCap });
    console.warn(`Interlink star cap: week ${row.cycle} boss ${row.bossId} sent ${sent}, the rules say ${ruleCap}`);
  }
  if (row.score != null && row.stars != null) {
    const expected = Math.min(Math.floor(Number(row.score) / 1000), cap);
    if (Math.abs(Number(row.stars) - expected) > 1) flags.push({ rule: "stars track score", sent: row.stars, expected });
  }
  const players = (parseJsonColumn(row.playersJson) || []).filter((player) => Number.isFinite(Number(player?.avgDps)) && player.avgDps !== null);
  const sum = players.reduce((total, player) => total + Number(player.avgDps), 0);
  const near = (a, b) => Math.abs(a - b) <= RUN_CHECK_TOLERANCE * Math.max(a, b);
  if (players.length && Number(row.teamDps) > 0 && !near(sum, Number(row.teamDps))) {
    flags.push({ rule: "Avg DPS add up to team DPS", sent: row.teamDps, expected: sum });
  }
  if (players.length && Number(row.meterDps) > 0 && !near(sum, Number(row.meterDps))) {
    flags.push({ rule: "Avg DPS add up to the meter's DPS", sent: row.meterDps, expected: sum });
  }
  const team = Number(row.teamDps) || 0;
  const share = players.length >= 4 && team > 0 ? (3 * team) / players.length : Infinity;
  for (const player of players) {
    const dps = Number(player.avgDps);
    if (team > 0 && (dps > team * 1.1 || dps > share)) flags.push({ rule: "Avg DPS plausible", player: player.name || null, sent: dps, teamDps: team });
  }
  if (row.cleared === 1 && row.stars != null && Number(row.stars) < clear) flags.push({ rule: "cleared needs full stars", sent: row.stars, expected: clear });
  return flags;
}

// The AI reading is for runs that matter: a new personal best for that player, boss and week (a Season Ladder total
// only changes through those), a run in the top VERIFY_TOP_RANK (default 25) of its boss board, or a run the free
// checks flagged.
async function runMatters(env, row, submissionId, flags) {
  if (flags.length) return "flagged";
  const best = await env.DB.prepare(
    `SELECT MAX(score) AS best FROM leaderboard_submissions
     WHERE discord_id = ? AND cycle = ? AND boss_id = ? AND kind IN ('interlink_run', 'interlink_best') AND submission_id != ?`,
  ).bind(row.discordId, row.cycle, row.bossId, submissionId).first();
  if (best?.best == null || Number(row.score) > Number(best.best)) return "personal best";
  const above = await env.DB.prepare(
    `SELECT COUNT(*) AS players FROM (SELECT discord_id, MAX(score) AS best FROM leaderboard_submissions
       WHERE status = 'visible' AND COALESCE(outcome, '') <> 'invalid' AND cycle = ? AND boss_id = ? AND kind IN ('interlink_run', 'interlink_best') GROUP BY discord_id)
     WHERE best > ?`,
  ).bind(row.cycle, row.bossId, row.score).first();
  const top = Math.max(0, Number.parseInt(env.VERIFY_TOP_RANK || "25", 10) || 0);
  return Number(above?.players || 0) < top ? "top of its board" : null;
}

// At most VERIFY_DAILY_LIMIT AI readings a UTC day (default 500, the owner's cap: two screens a run is about 80
// neurons, so at most ~40,000 neurons a day, ~$0.33 above Workers AI's free 10,000), counted from the runs read today.
async function aiReadingsLeft(env) {
  const limit = Math.max(0, Number.parseInt(env.VERIFY_DAILY_LIMIT || "500", 10) || 0);
  const day = Math.floor(Date.now() / 86400000) * 86400;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS used FROM leaderboard_submissions WHERE verify_at >= ? AND json_extract(verify_json, '$.model') IS NOT NULL",
  ).bind(day).first();
  return limit - Number(row?.used || 0);
}

const RUN_CHECK_COLUMNS = `SELECT discord_id AS discordId, kind, cycle, boss_id AS bossId, score, stars, cleared,
  clear_time_s AS clearTimeS, team_dps AS teamDps, meter_dps AS meterDps, players_json AS playersJson, extra_json AS extraJson,
  verify_json AS verifyJson FROM leaderboard_submissions WHERE submission_id = ?`;
const saveRunCheck = (env, submissionId, state, detail) => env.DB.prepare(
  "UPDATE leaderboard_submissions SET verify_state = ?, verify_json = ?, verify_at = ? WHERE submission_id = ?",
).bind(state, JSON.stringify(detail), Math.floor(Date.now() / 1000), submissionId).run();

async function checkRun(env, submissionId) {
  const row = await env.DB.prepare(RUN_CHECK_COLUMNS).bind(submissionId).first();
  if (!row || row.kind !== "interlink_run") return;
  const flags = freeRunChecks(row, interlinkCycle(await interlinkCycles(env), row.cycle));
  const rules = { flags };
  try {
    await saveRunCheck(env, submissionId, flags.length ? "mismatch" : null, { rules });
  } catch (error) {
    console.error("Run checks need migration 0032", error);
    return;
  }
  const full = (parseJsonColumn(row.extraJson) || {}).proofFull || {};
  if (!env.AI || !env.EVIDENCE || !full.evidence) return;
  const reason = await runMatters(env, row, submissionId, flags);
  if (!reason) return;
  if (await aiReadingsLeft(env) <= 0) {
    // over today's cap: queued (still ranked, "not checked yet"); read when there's room - after the 00:00 UTC
    // reset or a higher VERIFY_DAILY_LIMIT, by the next runs that come in or an administrator's drain
    await saveRunCheck(env, submissionId, flags.length ? "mismatch" : "pending", { rules, reason, queued: true });
    return;
  }
  await aiReadRun(env, submissionId, row, rules, reason);
}

async function aiReadRun(env, submissionId, row, rules, reason) {
  const flags = rules.flags || [];
  const full = (parseJsonColumn(row.extraJson) || {}).proofFull || {};
  try {
    await saveRunCheck(env, submissionId, "pending", { rules, model: VERIFY_MODEL, reason });
    const result = await readScreen(env, full.evidence, VERIFY_PROMPTS.result);
    const battle = full.battle ? await readScreen(env, full.battle, VERIFY_PROMPTS.battle) : null;
    const { checked, differences, suspect } = compareReading(row, result, battle);
    const state = flags.length || differences.length ? "mismatch" : checked ? "match" : "unreadable";
    await saveRunCheck(env, submissionId, state, { rules, model: VERIFY_MODEL, reason, reading: { result, battle }, checked, differences, ...(suspect ? { suspect } : {}) });
  } catch (error) {
    console.error("Second reading failed", error);
    await saveRunCheck(env, submissionId, flags.length ? "mismatch" : "unreadable",
      { rules, model: VERIFY_MODEL, reason, error: String(error?.message || error).slice(0, 300) });
  }
}

// Reads the oldest queued runs while today's cap has room: up to max of them. Returns how many were read.
async function drainRunChecks(env, max) {
  if (!env.AI || !env.EVIDENCE) return 0;
  const { results } = await env.DB.prepare(
    `SELECT submission_id AS submissionId FROM leaderboard_submissions
     WHERE json_extract(verify_json, '$.queued') = 1 ORDER BY verify_at ASC LIMIT ?`,
  ).bind(Math.max(0, max)).all();
  let read = 0;
  for (const { submissionId } of results || []) {
    if (await aiReadingsLeft(env) <= 0) break;
    const row = await env.DB.prepare(RUN_CHECK_COLUMNS).bind(submissionId).first();
    const queued = parseJsonColumn(row?.verifyJson) || {};
    if (!row || !queued.queued) continue;
    await aiReadRun(env, submissionId, row, queued.rules || { flags: [] }, queued.reason || "queued");
    read += 1;
  }
  return read;
}

// POST /api/admin/run-checks/drain {max} (administrators and the owner): read up to max (default 20, at most 100)
// of the oldest queued runs now, within today's cap. -> { read, queued: how many still wait }
async function drainRunChecksNow(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!can(account, "logs.read")) return json({ error: "Access denied." }, 403);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body = {};
  try {
    body = await readJsonBody(request, 256);
  } catch {
    // an empty body: the default
  }
  const max = Math.min(100, Math.max(1, Number.parseInt(body?.max ?? "20", 10) || 20));
  const read = await drainRunChecks(env, max);
  const left = await env.DB.prepare("SELECT COUNT(*) AS queued FROM leaderboard_submissions WHERE json_extract(verify_json, '$.queued') = 1").first();
  return json({ read, queued: Number(left?.queued || 0), readingsLeftToday: Math.max(0, await aiReadingsLeft(env)) });
}

// The public badge for a run's check (shadow mode): "verified" when the AI reading agreed or an administrator
// confirmed it, "pending" while it waits for a check or is under review (a disagreement is never shown publicly),
// none for a run that didn't need the AI reading or was rejected (left to the administrators).
function runCheckBadge(state) {
  return state === "match" || state === "confirmed" ? "verified" : state === "pending" || state === "mismatch" ? "pending" : null;
}

// The review list (administrators and the owner, like log reports): runs whose second reading disagreed (?state=,
// default mismatch), newest first, with what was sent, what was read and the differences. POST
// /api/admin/run-checks/<id> {decision: "confirmed" | "rejected"} records the review (shadow mode: the run's place on
// the boards doesn't change).
const VERIFY_STATES = Object.freeze(["pending", "match", "mismatch", "unreadable", "confirmed", "rejected"]);
async function listRunChecks(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!can(account, "logs.read")) return json({ error: "Access denied." }, 403);
  const state = new URL(request.url).searchParams.get("state") || "mismatch";
  if (!VERIFY_STATES.includes(state)) return json({ error: "Unknown state." }, 400);
  const { results } = await env.DB.prepare(
    `SELECT submission_id AS submissionId, kind, cycle, boss_name AS bossName, score, stars, clear_time_s AS clearTimeS,
       players_json AS playersJson, verify_state AS state, verify_json AS verifyJson, verify_at AS checkedAt, created_at AS sentAt,
       (SELECT character_name FROM game_characters gc WHERE gc.discord_id = s.discord_id AND gc.character_name IS NOT NULL
        ORDER BY gc.last_seen_at DESC LIMIT 1) AS player
     FROM leaderboard_submissions s WHERE verify_state = ? ORDER BY verify_at DESC LIMIT 100`,
  ).bind(state).all();
  return json({
    state,
    runs: (results || []).map(({ playersJson, verifyJson, ...row }) => ({
      ...row, players: parseJsonColumn(playersJson) || [], check: parseJsonColumn(verifyJson) || {},
      proof: { crop: `/api/leaderboard/submissions/${row.submissionId}/evidence`, full: `/api/leaderboard/submissions/${row.submissionId}/evidence?shot=full`,
        battleFull: `/api/leaderboard/submissions/${row.submissionId}/evidence?shot=battle_full` },
    })),
  });
}

async function reviewRunCheck(request, env, submissionId) {
  const account = await leaderboardAccount(request, env);
  if (!can(account, "logs.read")) return json({ error: "Access denied." }, 403);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 512);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  if (!["confirmed", "rejected"].includes(body.decision)) return json({ error: "decision must be confirmed or rejected." }, 400);
  const row = await env.DB.prepare("SELECT verify_json AS verifyJson FROM leaderboard_submissions WHERE submission_id = ? AND verify_state IS NOT NULL")
    .bind(submissionId).first();
  if (!row) return json({ error: "No second reading for this run." }, 404);
  const check = { ...(parseJsonColumn(row.verifyJson) || {}), review: { by: account.discordId, decision: body.decision, at: Math.floor(Date.now() / 1000) } };
  await env.DB.prepare("UPDATE leaderboard_submissions SET verify_state = ?, verify_json = ? WHERE submission_id = ?")
    .bind(body.decision, JSON.stringify(check), submissionId).run();
  return json({ ok: true, submissionId, state: body.decision });
}

// ---------------------------------------------------------------- linked game characters
async function listCharacters(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  const { results } = await env.DB.prepare(
    `SELECT game_uid AS gameUid, character_name AS name, source, linked_at AS linkedAt, last_seen_at AS lastSeenAt,
       verified_at IS NOT NULL AS verified
     FROM game_characters WHERE discord_id = ? ORDER BY last_seen_at DESC`,
  ).bind(account.discordId).all();
  const main = await mainCharacter(env, account.discordId);
  return json({ characters: (results || []).map((row) => ({ ...row, main: row.gameUid === main?.gameUid })) });
}

// Claims a character for the signed-in account. The desktop meter calls this with the UID it reads from the game's
// own log ("meter"); the website can add one by hand ("manual"). A UID linked to another account is refused.
// the game menu's strip, or the Profile screen's column (about 0.5-1.5 MB as a PNG at 4K); stored in its D1 row, whose
// limit is 2 MB (a larger proof comes as a JPEG from the app)
const MAX_PROOF_BYTES = 1900 * 1000;

// A character link or dispute from the desktop app: JSON {gameUid, name}, or a form with the same fields plus "proof",
// the strip of the game menu showing the name with the UID under it (and "note" on a dispute).
async function readCharacterRequest(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) return { ...(await readJsonBody(request, 1024)), proof: null };
  if (Number(request.headers.get("content-length") || 0) > MAX_PROOF_BYTES + 4096) throw new RangeError("Request body is too large.");
  const form = await request.formData();
  const file = form.get("proof");
  let proof = null;
  if (file && typeof file !== "string") {
    if (!EVIDENCE_TYPES[file.type]) throw new TypeError("Proof must be a JPEG, PNG or WebP image.");
    if (file.size > MAX_PROOF_BYTES) throw new RangeError("Proof image is too large.");
    proof = { bytes: new Uint8Array(await file.arrayBuffer()), type: file.type };
  }
  return { gameUid: form.get("gameUid"), name: form.get("name"), note: form.get("note"), proof };
}

// Every name a UID has gone by (names can be bought), so runs keep going to whoever held the name when they were played.
async function recordCharacterName(env, gameUid, name, verified, now) {
  if (!name) return;
  await env.DB.prepare(
    `INSERT INTO character_names (game_uid, character_name, skeleton, verified, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_uid, character_name) DO UPDATE SET last_seen_at = excluded.last_seen_at, skeleton = excluded.skeleton,
       verified = MAX(verified, excluded.verified)`,
  ).bind(gameUid, name, nameSkeleton(name), verified ? 1 : 0, now, now).run();
}

// Characters are linked only by the desktop app, from the game itself: the UID from the game's log and the name from the
// game menu, sent with the menu as proof. A proven link takes a UID over from an unproven one; a UID another account
// already proved stays put, and the app offers to send a dispute instead.
async function linkCharacter(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  if (!account.viaToken) return json({ error: "Characters are linked by the desktop app when it sees you in game." }, 403);
  let body;
  try {
    body = await readCharacterRequest(request);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const gameUid = boundedText(body.gameUid, 24, /^\d+$/u);
  const name = boundedText(body.name, 40);
  if (!gameUid) return json({ error: "A numeric game UID is required." }, 400);
  if (name === undefined) return json({ error: "Character name is invalid." }, 400);
  const proven = Boolean(body.proof && name);
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare(
    "SELECT discord_id AS discordId, verified_at AS verifiedAt, character_name AS name FROM game_characters WHERE game_uid = ? LIMIT 1",
  ).bind(gameUid).first();
  if (existing && existing.discordId !== account.discordId) {
    if (!proven || existing.verifiedAt) {
      return json({
        error: existing.verifiedAt
          ? "Another account proved this character from the game menu. If it is yours, send a dispute from the app."
          : "This character is linked to another account. Open the game menu (Esc or Start) so the app can prove it is yours.",
        dispute: Boolean(proven && existing.verifiedAt),
      }, 409);
    }
    await env.DB.prepare(
      `UPDATE game_characters SET discord_id = ?, character_name = ?, source = 'meter', linked_at = ?, last_seen_at = ?,
         verified_at = ? WHERE game_uid = ?`,
    ).bind(account.discordId, name, now, now, now, gameUid).run();
  } else if (existing) {
    // a proven name always wins; an unproven reading never renames a proven character
    await env.DB.prepare(
      `UPDATE game_characters SET last_seen_at = ?, source = 'meter',
         character_name = CASE WHEN ? = 1 OR verified_at IS NULL THEN COALESCE(?, character_name) ELSE character_name END,
         verified_at = CASE WHEN ? = 1 THEN ? ELSE verified_at END
       WHERE game_uid = ?`,
    ).bind(now, proven ? 1 : 0, name, proven ? 1 : 0, now, gameUid).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at, verified_at)
       VALUES (?, ?, ?, 'meter', ?, ?, ?)`,
    ).bind(gameUid, account.discordId, name, now, now, proven ? now : null).run();
  }
  if (proven) {
    await env.DB.prepare(
      `INSERT INTO character_proofs (game_uid, discord_id, character_name, image, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_uid) DO UPDATE SET discord_id = excluded.discord_id, character_name = excluded.character_name,
         image = excluded.image, mime = excluded.mime, created_at = excluded.created_at`,
    ).bind(gameUid, account.discordId, name, body.proof.bytes, body.proof.type, now).run();
  }
  if (proven || !existing?.verifiedAt) await recordCharacterName(env, gameUid, name, proven, now);
  const taken = Boolean(existing && existing.discordId !== account.discordId);
  return json({ ok: true, gameUid, name, verified: proven || Boolean(existing?.verifiedAt && !taken), linked: !existing || taken },
    existing && !taken ? 200 : 201);
}

// The game's Profile screen numbers for a character (Collection Progress), sent by the meter when the player opens
// their own Profile, and the character's level (from the EXP card the game shows when you gain EXP), gender (the mark
// after the name on the Profile screen) and server (as the game's settings name it, e.g. "Aniimo-Americas"). Only for
// a character this account proved from the game, and only whole numbers in range. Each send updates what it has.
// The EXP card also gives the progress into that level: exp of expNeeded, kept only as a pair (exp <= expNeeded).
const CHARACTER_STATS = Object.freeze(["aniimoPoint", "sparklingAniimo", "stylePoints", "prismanaAniimo", "level"]);
const CHARACTER_STAT_MAX = 10_000_000;
const CHARACTER_LEVEL_MAX = 200;

const CHARACTER_GENDERS = Object.freeze(["female", "male"]);

export function cleanCharacterStats(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  if (raw.gender !== undefined && raw.gender !== null) {
    if (!CHARACTER_GENDERS.includes(raw.gender)) return null;
    out.gender = raw.gender;
  }
  if (raw.server !== undefined && raw.server !== null) {
    const server = boundedText(raw.server, 40, /^[\p{L}\p{N} ._-]+$/u);
    if (!server) return null;
    out.server = server;
  }
  for (const key of CHARACTER_STATS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0 || value > CHARACTER_STAT_MAX) return null;
    if (key === "level" && (value < 1 || value > CHARACTER_LEVEL_MAX)) return null;
    out[key] = value;
  }
  // EXP into the level: only as a pair (a lone one is dropped), whole numbers, exp no more than the level needs
  const whole = (value) => Number.isInteger(value) && value >= 0 && value <= CHARACTER_STAT_MAX;
  if (raw.exp != null && raw.expNeeded != null) {
    if (!whole(raw.exp) || !whole(raw.expNeeded) || raw.expNeeded < 1 || raw.exp > raw.expNeeded) return null;
    out.exp = raw.exp;
    out.expNeeded = raw.expNeeded;
  }
  return Object.keys(out).length ? out : null;
}

async function saveCharacterStats(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  if (!account.viaToken) return json({ error: "Profile numbers are sent by the desktop app from the game's Profile screen." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 1024);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const gameUid = boundedText(body.gameUid, 24, /^\d+$/u);
  const stats = cleanCharacterStats(body.stats);
  if (!gameUid) return json({ error: "A numeric game UID is required." }, 400);
  if (!stats) return json({ error: "Stats must be whole numbers (aniimoPoint, sparklingAniimo, stylePoints, prismanaAniimo, level; exp with expNeeded, exp no more than expNeeded), gender female or male, server a name." }, 400);
  const owned = await env.DB.prepare(
    "SELECT verified_at AS verifiedAt, stats_json AS statsJson FROM game_characters WHERE game_uid = ? AND discord_id = ?",
  ).bind(gameUid, account.discordId).first();
  if (!owned?.verifiedAt) return json({ error: "Prove this character from the game first (open the game menu or your Profile)." }, 409);
  let saved = null;
  try { saved = owned.statsJson ? cleanCharacterStats(JSON.parse(owned.statsJson)) : null; } catch { saved = null; }
  const merged = { ...saved, ...stats };        // the level and the Profile screen's numbers arrive separately
  // a new level without its EXP: the old level's EXP no longer applies
  if (stats.level !== undefined && stats.exp === undefined && stats.level !== saved?.level) {
    delete merged.exp;
    delete merged.expNeeded;
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE game_characters SET stats_json = ?, stats_at = ? WHERE game_uid = ? AND discord_id = ?")
    .bind(JSON.stringify(merged), now, gameUid, account.discordId).run();
  return json({ ok: true, gameUid, stats: merged });
}

// Online / AFK, sent by the aLogs app while the game runs: every 2 minutes and on each change, "offline" when the game
// closes. Only for a character this account proved, and only counted for PRESENCE_FRESH_S, so a PC that drops off
// shows offline on its own.
const PRESENCE_STATES = Object.freeze(["online", "afk", "offline"]);
const PRESENCE_FRESH_S = 300;

async function saveCharacterPresence(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  if (!account.viaToken) return json({ error: "Online status is sent by the desktop app." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 512);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const gameUid = boundedText(body.gameUid, 24, /^\d+$/u);
  if (!gameUid || !PRESENCE_STATES.includes(body.state)) return json({ error: "Send gameUid and state: online, afk or offline." }, 400);
  const owned = await env.DB.prepare(
    `SELECT gc.verified_at AS verifiedAt, COALESCE(p.show_presence, 1) AS shown
     FROM game_characters gc LEFT JOIN profiles p ON p.discord_id = gc.discord_id WHERE gc.game_uid = ? AND gc.discord_id = ?`,
  ).bind(gameUid, account.discordId).first();
  if (!owned?.verifiedAt) return json({ error: "Prove this character from the game first (open the game menu or your Profile)." }, 409);
  if (Number(owned.shown) !== 1) return json({ ok: true, state: body.state, shown: false });   // turned off: not kept
  await env.DB.prepare("UPDATE game_characters SET presence_state = ?, presence_at = ? WHERE game_uid = ? AND discord_id = ?")
    .bind(body.state, Math.floor(Date.now() / 1000), gameUid, account.discordId).run();
  return json({ ok: true, state: body.state, shown: true });
}

// Settings the website and the aLogs app share, kept with the account so changing one changes both: "Show my online
// status" (also in Edit profile) and the theme (a preset id, or "custom" with its colours). Signed in either way: the
// site's session or the app's desktop token. GET -> { showPresence, theme }; POST sends any of them. Turning the
// online status off also drops what was kept.
const THEME_ID = /^[a-z0-9-]{1,24}$/u;
const THEME_COLOUR = /^#[0-9a-f]{6}$/iu;

export function cleanTheme(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !THEME_ID.test(String(raw.id || ""))) return null;
  const theme = { id: raw.id };
  if (raw.custom !== undefined && raw.custom !== null) {
    if (typeof raw.custom !== "object" || Array.isArray(raw.custom)) return null;
    const entries = Object.entries(raw.custom);
    if (entries.length > 16 || !entries.every(([key, value]) => /^[A-Za-z]{1,24}$/u.test(key) && THEME_COLOUR.test(String(value)))) return null;
    theme.custom = Object.fromEntries(entries);
  }
  return theme;
}

async function accountPreferences(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (request.method === "POST") {
    if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
    let body;
    try {
      body = await readJsonBody(request, 2048);
    } catch (error) {
      return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
    }
    if (body.showPresence !== undefined && typeof body.showPresence !== "boolean") return json({ error: "showPresence must be true or false." }, 400);
    const theme = body.theme === undefined ? undefined : cleanTheme(body.theme);
    if (theme === null) return json({ error: "theme must be { id, custom? } with #rrggbb colours." }, 400);
    const now = Math.floor(Date.now() / 1000);
    if (typeof body.showPresence === "boolean") {
      await env.DB.prepare("UPDATE profiles SET show_presence = ?, updated_at = ? WHERE discord_id = ?")
        .bind(body.showPresence ? 1 : 0, now, account.discordId).run();
      if (!body.showPresence) {
        await env.DB.prepare("UPDATE game_characters SET presence_state = NULL, presence_at = NULL WHERE discord_id = ?").bind(account.discordId).run();
      }
    }
    if (theme) {
      await env.DB.prepare("UPDATE profiles SET preferences_json = json_set(COALESCE(preferences_json, '{}'), '$.theme', json(?)), updated_at = ? WHERE discord_id = ?")
        .bind(JSON.stringify(theme), now, account.discordId).run();
    }
  }
  const row = await env.DB.prepare("SELECT show_presence AS showPresence, preferences_json AS prefs FROM profiles WHERE discord_id = ?")
    .bind(account.discordId).first();
  let theme = null;
  try { theme = cleanTheme(JSON.parse(row?.prefs || "{}").theme); } catch { theme = null; }
  return json({ showPresence: Number(row?.showPresence ?? 1) === 1, theme });
}

// The profile's presence: "online" if any of its characters is, else "afk", else "offline" (the game or aLogs isn't
// running: either way nothing was heard for 5 minutes); null for a profile with no character yet, or whose owner turned
// it off (Edit profile > Show my online status).
async function profilePresence(env, discordId) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COALESCE(show_presence, 1) FROM profiles WHERE discord_id = ?1) AS shown,
            (SELECT presence_state FROM game_characters
             WHERE discord_id = ?1 AND presence_at > ?2 AND presence_state IN ('online', 'afk')
             ORDER BY presence_state = 'online' DESC LIMIT 1) AS state,
            (SELECT COUNT(*) FROM game_characters WHERE discord_id = ?1) AS characters`,
  ).bind(discordId, Math.floor(Date.now() / 1000) - PRESENCE_FRESH_S).first();
  if (row && row.shown !== null && Number(row.shown) !== 1) return null;
  return row?.state || (Number(row?.characters) ? "offline" : null);
}

// A character's level, gender and server as the profile lists them (only what's known).
function characterDetails(row) {
  return {
    ...(Number.isInteger(row.level) ? { level: row.level } : {}),
    ...(CHARACTER_GENDERS.includes(row.gender) ? { gender: row.gender } : {}),
    ...(typeof row.server === "string" && row.server ? { server: row.server } : {}),
    ...(Number.isInteger(row.exp) && Number.isInteger(row.expNeeded) && row.expNeeded > 0 ? { exp: row.exp, expNeeded: row.expNeeded } : {}),
  };
}

// The main character's Profile screen numbers, for a profile: {aniimoPoint, ..., seenAt} or null.
async function characterStats(env, main) {
  if (!main?.gameUid) return null;
  const row = await env.DB.prepare("SELECT stats_json AS statsJson, stats_at AS statsAt FROM game_characters WHERE game_uid = ?")
    .bind(main.gameUid).first();
  if (!row?.statsJson) return null;
  try {
    const stats = cleanCharacterStats(JSON.parse(row.statsJson));
    return stats ? { ...stats, seenAt: Number(row.statsAt) || null } : null;
  } catch {
    return null;
  }
}

// "That character is mine": a player whose proof was refused because another account proved the UID first sends their
// own proof and an optional note. Nothing changes until a developer compares the two proofs.
async function disputeCharacter(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account || !leaderboardAllowed(account, env)) return gatedResponse(account);
  if (!account.viaToken) return json({ error: "Disputes are sent from the desktop app, with the game menu as proof." }, 403);
  let body;
  try {
    body = await readCharacterRequest(request);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const gameUid = boundedText(body.gameUid, 24, /^\d+$/u);
  const name = boundedText(body.name, 40);
  const note = boundedText(body.note, 500);
  if (!gameUid || !name || note === undefined) return json({ error: "A UID, a name and an optional short note are required." }, 400);
  if (!body.proof) return json({ error: "A dispute needs the game menu as proof." }, 400);
  const owner = await env.DB.prepare("SELECT discord_id AS discordId FROM game_characters WHERE game_uid = ?").bind(gameUid).first();
  if (!owner || owner.discordId === account.discordId) return json({ error: "This character isn't held by another account." }, 409);
  const open = await env.DB.prepare(
    "SELECT dispute_id AS id FROM character_disputes WHERE game_uid = ? AND discord_id = ? AND status = 'open'",
  ).bind(gameUid, account.discordId).first();
  if (open) return json({ ok: true, disputeId: open.id, alreadyOpen: true });
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    `INSERT INTO character_disputes (game_uid, discord_id, character_name, note, image, mime, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?) RETURNING dispute_id AS id`,
  ).bind(gameUid, account.discordId, name, note, body.proof.bytes, body.proof.type, now).first();
  return json({ ok: true, disputeId: result?.id ?? null }, 201);
}

async function developerAccount(request, env) {
  const account = await currentAccount(request, env);
  return account?.developerModeAvailable ? account : null;
}

// Developers: the disputes players sent, newest first, with who holds each UID now.
async function listCharacterDisputes(request, env) {
  if (!await developerAccount(request, env)) return json({ error: "Developer access required." }, 403);
  const { results } = await env.DB.prepare(
    `SELECT d.dispute_id AS id, d.game_uid AS gameUid, d.character_name AS name, d.note, d.status, d.created_at AS createdAt,
       d.resolved_at AS resolvedAt, du.discord_username AS claimant, d.discord_id AS claimantId,
       gc.character_name AS holderName, hu.discord_username AS holder, gc.discord_id AS holderId, gc.verified_at AS holderVerifiedAt
     FROM character_disputes d
     JOIN users du ON du.discord_id = d.discord_id
     LEFT JOIN game_characters gc ON gc.game_uid = d.game_uid
     LEFT JOIN users hu ON hu.discord_id = gc.discord_id
     ORDER BY d.status = 'open' DESC, d.created_at DESC LIMIT 100`,
  ).all();
  return json({ disputes: results || [] });
}

// Developers: one proof image - a dispute's ("dispute") or the one the current holder sent ("holder").
async function characterProofImage(request, env, which, id) {
  if (!await developerAccount(request, env)) return json({ error: "Developer access required." }, 403);
  const row = which === "dispute"
    ? await env.DB.prepare("SELECT image, mime FROM character_disputes WHERE dispute_id = ?").bind(Number(id)).first()
    : await env.DB.prepare("SELECT image, mime FROM character_proofs WHERE game_uid = ?").bind(String(id)).first();
  if (!row) return json({ error: "Proof not found." }, 404);
  return new Response(row.image, { headers: { "content-type": row.mime, "cache-control": "private, no-store" } });
}

// Developers: grant a dispute (the UID moves to the player who sent it, with their proof) or reject it.
async function resolveCharacterDispute(request, env, id) {
  if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  if (!await developerAccount(request, env)) return json({ error: "Developer access required." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 256);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (!["grant", "reject"].includes(body.action)) return json({ error: "action must be grant or reject." }, 400);
  const dispute = await env.DB.prepare(
    "SELECT game_uid AS gameUid, discord_id AS discordId, character_name AS name, image, mime, status FROM character_disputes WHERE dispute_id = ?",
  ).bind(Number(id)).first();
  if (!dispute) return json({ error: "Dispute not found." }, 404);
  if (dispute.status !== "open") return json({ error: "This dispute is already resolved." }, 409);
  const now = Math.floor(Date.now() / 1000);
  if (body.action === "grant") {
    await env.DB.prepare(
      `UPDATE game_characters SET discord_id = ?, character_name = ?, source = 'meter', linked_at = ?, last_seen_at = ?,
         verified_at = ? WHERE game_uid = ?`,
    ).bind(dispute.discordId, dispute.name, now, now, now, dispute.gameUid).run();
    await env.DB.prepare(
      `INSERT INTO character_proofs (game_uid, discord_id, character_name, image, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_uid) DO UPDATE SET discord_id = excluded.discord_id, character_name = excluded.character_name,
         image = excluded.image, mime = excluded.mime, created_at = excluded.created_at`,
    ).bind(dispute.gameUid, dispute.discordId, dispute.name, dispute.image, dispute.mime, now).run();
    await recordCharacterName(env, dispute.gameUid, dispute.name, true, now);
  }
  await env.DB.prepare("UPDATE character_disputes SET status = ?, resolved_at = ? WHERE dispute_id = ?")
    .bind(body.action === "grant" ? "granted" : "rejected", now, Number(id)).run();
  return json({ ok: true, status: body.action === "grant" ? "granted" : "rejected" });
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
    if (kind === "eggheist_season") where.push("s.cycle IS NOT NULL");   // early builds sent standings without the season
  } else {
    const mode = LEADERBOARD_MODES.includes(params.get("mode")) ? params.get("mode") : "interlink";
    where.push("s.mode = ?");
    binds.push(mode);
  }
  if (!includeHidden) where.push("s.status = 'visible'");
  const exact = [["cycle", "s.cycle"], ["boss", "s.boss_id"], ["uid", "s.game_uid"], ["server", "s.server"], ["difficulty", "s.difficulty"], ["trial", "s.trial"]];
  for (const [name, column] of exact) {
    let value = String(params.get(name) || "").trim();
    if (name === "trial") value = simElement(value) || value;         // "Training of Water" or "Water"
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

// Every Interlink run counts for each real player in it, not only the one who sent it: one row per submission for its
// sender (who = their account), plus one per non-AI teammate the sender's app saw on the prep screen. A teammate's row
// belongs to an account only through the teammate's UID recorded with the run (proven by that player in their own game
// menu); a name alone never claims anything - names can be bought, given up and imitated - so without a UID the row
// stays under the name ("name:<name>") for good. The sender's own slot is marked self by the app and isn't counted twice.
const CREDITED_RUNS = `(
  SELECT c.*, c.discord_id AS who, NULL AS teammate, NULL AS teammate_uid,
    (SELECT json_extract(me.value, '$.avgDps') FROM json_each(c.players_json) me WHERE json_extract(me.value, '$.self') = 1) AS p_dps, (SELECT json_extract(me.value, '$.breakValue') FROM json_each(c.players_json) me WHERE json_extract(me.value, '$.self') = 1) AS p_break,
    (SELECT json_extract(me.value, '$.damageTaken') FROM json_each(c.players_json) me WHERE json_extract(me.value, '$.self') = 1) AS p_taken, (SELECT json_extract(me.value, '$.heal') FROM json_each(c.players_json) me WHERE json_extract(me.value, '$.self') = 1) AS p_heal
  FROM leaderboard_submissions c WHERE ${ON_BOARDS("c")}
  UNION ALL
  SELECT * FROM (
    SELECT c.*, COALESCE(
        (SELECT gc2.discord_id FROM game_characters gc2
         WHERE gc2.game_uid = json_extract(pl.value, '$.uid')
           AND (gc2.verified_at IS NOT NULL OR json_extract(pl.value, '$.confirmed') = 1)),
        'name:' || lower(json_extract(pl.value, '$.name'))) AS who,
      json_extract(pl.value, '$.name') AS teammate,
      (SELECT gc3.game_uid FROM game_characters gc3
       WHERE gc3.game_uid = json_extract(pl.value, '$.uid')
         AND (gc3.verified_at IS NOT NULL OR json_extract(pl.value, '$.confirmed') = 1)) AS teammate_uid,
      json_extract(pl.value, '$.avgDps') AS p_dps, json_extract(pl.value, '$.breakValue') AS p_break,
      json_extract(pl.value, '$.damageTaken') AS p_taken, json_extract(pl.value, '$.heal') AS p_heal
    FROM leaderboard_submissions c, json_each(c.players_json) pl
    WHERE c.kind = 'interlink_run' AND ${ON_BOARDS("c")} AND json_extract(pl.value, '$.ai') = 0
      AND COALESCE(json_extract(pl.value, '$.self'), 0) = 0 AND json_extract(pl.value, '$.name') IS NOT NULL
      -- older apps don't mark the sender's own slot: skip the slot with the sender's linked character name
      AND json_extract(pl.value, '$.name') <> COALESCE(
        (SELECT character_name FROM game_characters me WHERE me.game_uid = c.game_uid AND me.discord_id = c.discord_id), '')
        COLLATE NOCASE
  ) WHERE who <> discord_id
)`;


// The boards only list players with a name: a teammate's name from the run, or a character the sender's account linked.
// A record from an account with no character yet (its app couldn't read the name) stays saved and shows up under the
// name once that player's app links one - nobody is listed as a generic "Pathfinder".
const NAMED_ON_BOARDS = "(s.teammate IS NOT NULL OR EXISTS (SELECT 1 FROM game_characters named WHERE named.discord_id = s.who AND named.character_name IS NOT NULL))";

// Whether a name nobody claimed looks like a claimed character's name (same skeleton): the boards mark it, since only a
// UID tells two such players apart. A name is never matched to a UID - only a UID recorded with the run is.
async function nameIdentities(env, names) {
  const list = [...new Set(names.filter(Boolean).map((name) => String(name)))].slice(0, 300);
  const skeletons = [...new Set(list.map(nameSkeleton))];
  const rows = skeletons.length ? (await env.DB.prepare(
    `SELECT cn.character_name AS name, cn.skeleton, cn.game_uid AS gameUid, cn.verified, cn.last_seen_at AS lastSeenAt
     FROM character_names cn JOIN game_characters gc ON gc.game_uid = cn.game_uid
     WHERE cn.skeleton IN (${skeletons.map(() => "?").join(", ")})`,
  ).bind(...skeletons).all()).results || [] : [];
  return (name) => {
    if (!name) return { lookalike: false };
    const skeleton = nameSkeleton(name);
    const same = rows.filter((row) => row.skeleton === skeleton);
    const exact = same.filter((row) => String(row.name).toLowerCase() === String(name).toLowerCase())
      .sort((a, b) => b.verified - a.verified || b.lastSeenAt - a.lastSeenAt)[0];
    return { lookalike: same.length > 0 && !exact };
  };
}

// Party members are matched to accounts by character name (names are unique in the game). Only members whose owner
// made their profile public get a link; everyone else, and AI teammates, show as plain names.
async function partyProfiles(env, rows) {
  const names = new Set();
  const shown = [];
  for (const row of rows) {
    for (const player of parseJsonColumn(row.players_json) || []) {
      if (player?.name && !player.ai) { names.add(String(player.name).toLowerCase()); shown.push(String(player.name)); }
    }
  }
  const identities = await nameIdentities(env, shown);
  if (!names.size) return Object.assign(new Map(), { identities });
  const list = [...names].slice(0, 200);
  const { results } = await env.DB.prepare(
    `SELECT lower(gc.character_name) AS name, p.public_id AS publicId FROM game_characters gc
     JOIN profiles p ON p.discord_id = gc.discord_id
     WHERE p.is_public = 1 AND p.public_id IS NOT NULL AND lower(gc.character_name) IN (${list.map(() => "?").join(", ")})`,
  ).bind(...list).all();
  return Object.assign(new Map((results || []).map((row) => [row.name, row.publicId])), { identities });
}
function withProfiles(players, profiles) {
  if (!Array.isArray(players)) return players;
  return players.map((player) => {
    if (!player?.name || player.ai) return player;
    const { skel: _skeleton, uid: _uid, confirmed: _confirmed, ...shown } = player;
    const publicId = profiles.get(String(player.name).toLowerCase());
    const identity = profiles.identities ? profiles.identities(player.name) : { lookalike: false };
    return { ...shown, ...(publicId ? { profileId: publicId } : {}), ...(identity.lookalike ? { lookalike: true } : {}) };
  });
}

// ---------------------------------------------------------------- Interlink weeks and seasons
// Interlink runs weekly: each week (cycle) has three bosses, and a player's week score is their best score on each
// of them added up; a season adds up its weeks. A player's best on a boss is the highest score from any of their
// result-screen runs or battle-prep bests for that week. Every past week stays viewable.

// The weeks: built in, plus what developer accounts' desktop apps uploaded from the game data (newer patches).
// Interlink rules that change with game updates, kept in one place so a patch only needs this edited. The star caps
// come from the game's sys_config_data: BossRushMaxStarSideBoss (15 until the 4000 reset, 20 since) and
// BossRushStarMultiplierMidBoss (2: the center is a side's x2). aLogs reads them with each patch and sends the run's
// boss cap as extra.starCap; a run whose cap differs from these is flagged ("star cap matches the rules").
// - slots: what the game calls the three boss positions, in the order a week lists its bosses (cycle.bosses).
//   slotsConfirmed says whether that order has been checked in the game (the meter reads it: left, middle, right).
// - starCaps: each slot's max stars (caps) and the stars that count as a clear (clear: the game offers ending
//   early from there); the last entry whose fromCycle is at or below the week's id applies. Weeks before 4000:
//   15 stars cleared any boss. From 4000 a kill is every star: 20 / 40 / 20 (the center boss needs 40).
// - durationS: a fight's clock (sys_config_data BossRushCombatDuration, 180). A run that ends before it without the
//   kill's stars was quit early - the game still shows its result and Battle Data screens.
// - splitBlock: weeks are grouped into splits (the game resets stars) by their id block: 3000-3005 is one split,
//   4000 starts the next.
// - seasons: which weeks belong to which season, by week id (the last entry whose fromCycle is at or below the
//   week's id). The season number the weeks upload carries isn't consistent (week 1002 said season 1, 3000-3002
//   season 3, 3003-3005 and 4000+ season 1), so the site doesn't use it. Season 1 began with week 3000: Split 1 is
//   3000-3005, Split 2 started at the 4000 reset. Earlier weeks (test and launch weeks) are "Before Season 1".
const INTERLINK_RULES = Object.freeze({
  slots: Object.freeze(["Left", "Center", "Right"]),
  slotsConfirmed: true,
  starCaps: Object.freeze([
    Object.freeze({ fromCycle: 0, caps: Object.freeze([15, 30, 15]), clear: Object.freeze([15, 15, 15]) }),
    Object.freeze({ fromCycle: 4000, caps: Object.freeze([20, 40, 20]), clear: Object.freeze([20, 40, 20]) }),
  ]),
  durationS: 180,
  splitBlock: 1000,
  seasons: Object.freeze([
    Object.freeze({ season: 0, fromCycle: 0, label: "Before Season 1" }),
    Object.freeze({ season: 1, fromCycle: 3000, label: "Season 1" }),
  ]),
});

function interlinkSeasonRule(cycleId) {
  const id = Number(cycleId) || 0;
  return INTERLINK_RULES.seasons.filter((rule) => rule.fromCycle <= id).at(-1) || INTERLINK_RULES.seasons[0];
}

function interlinkStarRule(cycleId) {
  const id = Number(cycleId) || 0;
  return INTERLINK_RULES.starCaps.filter((rule) => rule.fromCycle <= id).at(-1) || INTERLINK_RULES.starCaps[0];
}

// The cap aLogs sent with the run (extra.starCap), when it's a sane number; else null.
function sentStarCap(extraJson) {
  const cap = (parseJsonColumn(extraJson) || {}).starCap;
  return Number.isInteger(cap) && cap >= 10 && cap <= 100 ? cap : null;
}
// A slot's cap and clear for a run: the rules', or the run's own cap when it sent one. A week where a kill is every
// star (from 4000) takes the sent cap as the clear too; earlier weeks keep their fixed clear (15).
function runStarRule(cycleId, slot, sentCap) {
  const rule = interlinkStarRule(cycleId);
  const ruleCap = slot >= 0 ? rule.caps[slot] : Math.max(...rule.caps);
  const ruleClear = slot >= 0 ? rule.clear[slot] : Math.min(...rule.clear);
  const everyStar = slot >= 0 ? ruleClear === ruleCap : rule.clear.every((value, index) => value === rule.caps[index]);
  if (sentCap == null) return { cap: ruleCap, clear: ruleClear, ruleCap };
  return { cap: sentCap, clear: everyStar ? sentCap : ruleClear, ruleCap };
}

// How an Interlink run ended. The game lets the leader end a run early only once the team has every star; otherwise
// it's a kill (more score) or the clock running out. So:
// - "cleared": every star for its slot that week (or the cap aLogs read) - a kill;
// - "ended-early": every star, and the leader ended it (aLogs read the game's "The team leader has ended the
//   challenge." notice: extra.endedByLeader) - valid, it counts like a clear;
// - "time-up": the clock ran out without every star;
// - "invalid": under the clock without every star - someone quit before the run could count. It stays in the
//   player's own history and off every board.
// null when the time isn't known.
function interlinkOutcome(row, weeks) {
  if (row.kind !== "interlink_run" || row.clear_time_s == null) return null;
  const week = interlinkCycle(weeks, row.cycle);
  const slot = week ? week.bosses.findIndex((boss) => String(boss.id) === String(row.boss_id)) : -1;
  const { clear } = runStarRule(row.cycle, slot, sentStarCap(row.extra_json));
  if ((Number(row.stars) || 0) >= clear) return (parseJsonColumn(row.extra_json) || {}).endedByLeader === true ? "ended-early" : "cleared";
  return Number(row.clear_time_s) < INTERLINK_RULES.durationS ? "invalid" : "time-up";
}
// Keeps a run's outcome column current (after it's stored or re-sent); the boards skip invalid ones.
function ON_BOARDS(alias) {      // a declaration: CREDITED_RUNS (built at load) uses it
  return `COALESCE(${alias}.outcome, '') <> 'invalid'`;
}
async function storeRunOutcome(env, submissionId) {
  const row = await env.DB.prepare(
    "SELECT kind, cycle, boss_id, stars, cleared, clear_time_s, extra_json FROM leaderboard_submissions WHERE submission_id = ?",
  ).bind(submissionId).first();
  if (!row || row.kind !== "interlink_run") return;
  await env.DB.prepare("UPDATE leaderboard_submissions SET outcome = ? WHERE submission_id = ?")
    .bind(interlinkOutcome(row, await interlinkCycles(env)), submissionId).run();
}
// Runs stored before the outcome column existed (or whose write failed) get theirs by themselves: the first API read
// in each worker fills up to 500 before it answers, so the boards never show an old invalid run, and once nothing is
// left that worker stops looking. No sign-in, no manual step. Holo-Battle Sim runs stored before seasons were kept get
// their season the same way, from their element.
const OUTCOMES_FILLED = new WeakSet();
async function fillRunOutcomes(env, max = 500) {
  if (!env.DB || OUTCOMES_FILLED.has(env.DB)) return null;
  const onlyIn = SIM_RULES.seasons.flatMap((season) => season.elements
    .filter((element) => SIM_RULES.seasons.filter((item) => item.elements.includes(element)).length === 1)
    .map((element) => [element, String(season.season)]));
  await env.DB.prepare(`UPDATE leaderboard_submissions SET cycle = CASE trial ${onlyIn.map(() => "WHEN ? THEN ?").join(" ")} END
    WHERE kind = 'sim_run' AND cycle IS NULL AND trial IN (${onlyIn.map(() => "?").join(", ")})`)
    .bind(...onlyIn.flat(), ...onlyIn.map(([element]) => element)).run();
  const { results } = await env.DB.prepare(
    `SELECT submission_id, kind, cycle, boss_id, stars, cleared, clear_time_s, extra_json FROM leaderboard_submissions
     WHERE kind = 'interlink_run' AND outcome IS NULL AND clear_time_s IS NOT NULL LIMIT ?`,
  ).bind(max + 1).all();
  const rows = (results || []).slice(0, max);
  const counts = {};
  if (rows.length) {
    const weeks = await interlinkCycles(env);
    await env.DB.batch(rows.map((row) => {
      const outcome = interlinkOutcome(row, weeks);
      counts[outcome] = (counts[outcome] || 0) + 1;
      return env.DB.prepare("UPDATE leaderboard_submissions SET outcome = ? WHERE submission_id = ?").bind(outcome, row.submission_id);
    }));
  }
  const left = Math.max(0, (results || []).length - rows.length);
  if (!left) OUTCOMES_FILLED.add(env.DB);
  return { updated: rows.length, counts, left };
}
// POST /api/admin/run-outcomes {max}: the same fill on demand (not needed: reads do it)
async function backfillRunOutcomes(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!can(account, "logs.read")) return json({ error: "Access denied." }, 403);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body = {};
  try { body = await readJsonBody(request, 256); } catch { /* the default */ }
  const max = Math.min(2000, Math.max(1, Number.parseInt(body?.max ?? "500", 10) || 500));
  OUTCOMES_FILLED.delete(env.DB);
  const filled = await fillRunOutcomes(env, max);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM leaderboard_submissions WHERE kind = 'interlink_run' AND outcome IS NULL AND clear_time_s IS NOT NULL").first();
  return json({ updated: filled.updated, counts: filled.counts, left: Number(left?.n || 0) });
}

function interlinkStarCaps(cycleId) {
  return interlinkStarRule(cycleId).caps;
}

function interlinkSplitOf(cycleId) {
  return Math.floor((Number(cycleId) || 0) / INTERLINK_RULES.splitBlock);
}

// Every season with its splits (weeks grouped by id block, in time order), for the Season Ladder selector.
function interlinkSeasons(list) {
  const seasons = new Map();
  for (const cycle of list) {
    if (cycle.season == null) continue;
    const season = seasons.get(cycle.season) || { season: cycle.season, start: cycle.start, end: cycle.end, splits: new Map() };
    season.start = Math.min(season.start, cycle.start);
    season.end = Math.max(season.end, cycle.end);
    const id = interlinkSplitOf(cycle.id);
    const split = season.splits.get(id) || { id, start: cycle.start, end: cycle.end, weeks: 0 };
    split.start = Math.min(split.start, cycle.start);
    split.end = Math.max(split.end, cycle.end);
    split.weeks += 1;
    season.splits.set(id, split);
    seasons.set(cycle.season, season);
  }
  return [...seasons.values()].sort((a, b) => a.start - b.start).map((season) => ({
    season: season.season, start: season.start, end: season.end,
    label: INTERLINK_RULES.seasons.find((rule) => rule.season === season.season)?.label || `Season ${season.season}`,
    splits: [...season.splits.values()].sort((a, b) => a.start - b.start).map((split, index) => ({ ...split, label: `Split ${index + 1}` })),
  }));
}

// When the newest run in these weeks reached the site (the boards' "last updated").
async function interlinkUpdatedAt(env, cycles) {
  if (!cycles.length) return null;
  const row = await env.DB.prepare(
    `SELECT MAX(s.created_at) AS at FROM ${CREDITED_RUNS} s
     WHERE s.status = 'visible' AND s.kind IN ('interlink_run', 'interlink_best') AND s.cycle IN (${cycles.map(() => "?").join(", ")})`,
  ).bind(...cycles).first();
  return row?.at ?? null;
}

// The ladders a boss board can be ranked by: only figures the game's result screens show. Ties: higher score, then
// whoever got there first. "clear" is the fastest full-star clear and lists only cleared runs.
const INTERLINK_LADDERS = Object.freeze({
  score: { key: "score" },
  stars: { key: "stars" },
  clear: { key: "clearTimeS", ascending: true },
  teamDps: { key: "teamDps" },
  dps: { key: "avgDps" },
  break: { key: "breakValue" },
  heal: { key: "heal" },
});

function rankedLadder(rows, ladderId) {
  const ladder = INTERLINK_LADDERS[ladderId] || INTERLINK_LADDERS.score;
  const value = (row) => Number(row[ladder.key]);
  return rows.filter((row) => Number.isFinite(value(row)) && row[ladder.key] !== null)
    .sort((a, b) => (ladder.ascending ? value(a) - value(b) : value(b) - value(a))
      || (Number(b.score) || 0) - (Number(a.score) || 0) || a.firstAt - b.firstAt)
    .map((row, index) => ({ rank: index + 1, ...row }));
}

async function interlinkCycles(env) {
  const byId = new Map(INTERLINK_CYCLES.map((cycle) => [cycle.id, cycle]));
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, season, start_at AS start, end_at AS end, bosses_json AS bossesJson FROM interlink_cycles",
    ).all();
    for (const row of results || []) {
      const bosses = parseJsonColumn(row.bossesJson);
      if (Array.isArray(bosses) && bosses.length === 3) {
        byId.set(String(row.id), { id: String(row.id), season: row.season, start: Number(row.start), end: Number(row.end), bosses });
      }
    }
  } catch (error) {
    console.error("Could not read uploaded Interlink weeks", error);
  }
  // each week's season from its id (INTERLINK_RULES.seasons), not the uploaded number
  return [...byId.values()].map((cycle) => ({ ...cycle, season: interlinkSeasonRule(cycle.id).season }))
    .sort((a, b) => a.start - b.start);
}

function interlinkCycle(list, id) {
  return list.find((cycle) => cycle.id === String(id)) || null;
}

// The second boss of a two-boss middle fight (weeks 4003 on): the one the weeks upload sent as `bosses2`, or else one
// of the game's second middle bosses. Gives the week's middle boss when bossId is that second boss.
const INTERLINK_SECOND_MIDDLE_IDS = Object.freeze(["80000119", "80000121", "80000123"]);
function interlinkSecondMiddle(week, bossId) {
  const middle = week?.bosses?.[1];
  if (!middle || String(middle.id) === String(bossId)) return null;
  if (middle.second) return String(middle.second.id) === String(bossId) ? middle : null;
  return Number(week.id) >= 4003 && INTERLINK_SECOND_MIDDLE_IDS.includes(String(bossId)) ? middle : null;
}

function currentInterlinkCycle(list, now = Math.floor(Date.now() / 1000)) {
  const started = list.filter((cycle) => cycle.start <= now);
  return started.length ? started[started.length - 1] : list[list.length - 1];
}

// Developer accounts' desktop apps send the schedule they read from the game data after a patch.
async function uploadInterlinkCycles(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!account.developerModeAvailable) return json({ error: "Only developer accounts can update the Interlink weeks." }, 403);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 64 * 1024);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const cycles = Array.isArray(body?.cycles) ? body.cycles : null;
  const validBoss = (boss) => /^\d{1,12}$/u.test(String(boss?.id)) && typeof boss.name === "string" && boss.name.length <= 80;
  // bosses2: the middle fight's second boss (weeks 4003 on), as one boss, a list beside `bosses`, or null.
  // Gives null for none and undefined when it isn't valid.
  const secondMiddle = (cycle) => {
    const raw = Array.isArray(cycle.bosses2) ? cycle.bosses2[1] ?? cycle.bosses2.find(Boolean) ?? null : cycle.bosses2 ?? null;
    if (raw === null) return null;
    return validBoss(raw) ? { id: String(raw.id), name: raw.name.trim() || String(raw.id) } : undefined;
  };
  const valid = (cycle) => cycle && /^\d{1,12}$/u.test(String(cycle.id)) && Number.isSafeInteger(cycle.start)
    && Number.isSafeInteger(cycle.end) && cycle.end > cycle.start && (cycle.season == null || Number.isSafeInteger(cycle.season))
    && Array.isArray(cycle.bosses) && cycle.bosses.length === 3
    && cycle.bosses.every(validBoss) && secondMiddle(cycle) !== undefined;
  if (!cycles || !cycles.length || cycles.length > 200 || !cycles.every(valid)) {
    return json({ error: "Send cycles: [{ id, season, start, end, bosses: [{ id, name } x 3] }]." }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(cycles.map((cycle) => env.DB.prepare(
    `INSERT INTO interlink_cycles (id, season, start_at, end_at, bosses_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET season = excluded.season, start_at = excluded.start_at, end_at = excluded.end_at,
       bosses_json = excluded.bosses_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(String(cycle.id), cycle.season ?? null, cycle.start, cycle.end,
    JSON.stringify(cycle.bosses.map((boss, index) => {
      const second = index === 1 ? secondMiddle(cycle) : null;
      return { id: String(boss.id), name: boss.name.trim() || String(boss.id), ...(second ? { second } : {}) };
    })),
    account.discordId, now)));
  return json({ ok: true, stored: cycles.length });
}

// An Interlink run is a clear only with the stars for a kill (INTERLINK_RULES.starCaps' clear): the game offers
// ending early from there. A run quit early also finishes under the clock, with fewer stars, and app versions up to
// 0.1.21 sent those as cleared. The stars depend on the boss's slot that week (from 4000 the center needs 40), so
// list (the weeks, interlinkCycles) names each week's bosses; a week it doesn't list gets that rule's lowest line.
function clearedSql(kind, list = []) {
  if (kind !== "interlink_run") return "COALESCE(s.cleared, 1) = 1";
  const bySlot = [];
  for (const cycle of list) {
    const clear = interlinkStarRule(cycle.id).clear;
    cycle.bosses.forEach((boss, slot) => {
      if (clear[slot] !== Math.min(...clear) && /^\d+$/u.test(String(cycle.id)) && /^\d+$/u.test(String(boss.id))) {
        bySlot.push(`WHEN s.cycle = '${cycle.id}' AND s.boss_id = '${boss.id}' THEN ${clear[slot]}`);
      }
    });
  }
  // weeks where a kill is every star: a run that sent the game's cap is judged by it
  const sentCap = "json_extract(s.extra_json, '$.starCap')";
  const bySent = INTERLINK_RULES.starCaps.map((rule, index) => {
    if (!rule.clear.every((value, slot) => value === rule.caps[slot])) return null;
    const next = INTERLINK_RULES.starCaps[index + 1]?.fromCycle;
    return `WHEN CAST(s.cycle AS INTEGER) >= ${rule.fromCycle}${next != null ? ` AND CAST(s.cycle AS INTEGER) < ${next}` : ""}
      AND typeof(${sentCap}) = 'integer' AND ${sentCap} BETWEEN 10 AND 100 THEN ${sentCap}`;
  }).filter(Boolean);
  const byWeek = [...INTERLINK_RULES.starCaps].reverse()
    .map((rule) => `WHEN CAST(s.cycle AS INTEGER) >= ${rule.fromCycle} THEN ${Math.min(...rule.clear)}`);
  return `(COALESCE(s.cleared, 1) = 1 AND COALESCE(s.stars, 0) >= CASE ${[...bySent, ...bySlot, ...byWeek].join(" ")} ELSE ${Math.min(...INTERLINK_RULES.starCaps[0].clear)} END)`;
}

// Best score per player per (week, boss), with each player's in-game name and public profile id (if public).
async function interlinkBests(env, cycles, list, server = null) {
  if (!cycles.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT s.who AS discordId, s.cycle, s.boss_id AS bossId, MAX(s.boss_name) AS bossName,
       MAX(s.score) AS score, MAX(s.stars) AS stars,
       MIN(CASE WHEN ${clearedSql("interlink_run", list)} AND s.cleared = 1 AND s.clear_time_s IS NOT NULL THEN s.clear_time_s END) AS clearTimeS,
       MAX(s.p_dps) AS avgDps, MAX(s.p_break) AS breakValue, MAX(s.p_taken) AS damageTaken, MAX(s.p_heal) AS heal,
       MAX(s.team_dps) AS teamDps, MIN(json_extract(s.extra_json, '$.starCap')) AS sentCap,
       CASE WHEN s.who LIKE 'name:%' THEN MAX(s.teammate) ELSE
         (SELECT character_name FROM game_characters gc WHERE gc.discord_id = s.who AND gc.character_name IS NOT NULL
          ORDER BY gc.last_seen_at DESC LIMIT 1) END AS player,
       CASE WHEN s.who LIKE 'name:%' THEN NULL ELSE COALESCE(MAX(s.teammate_uid),
         (SELECT game_uid FROM game_characters gc WHERE gc.discord_id = s.who AND gc.character_name IS NOT NULL
          ORDER BY gc.last_seen_at DESC LIMIT 1)) END AS uid,
       (SELECT CASE WHEN p.is_public = 1 THEN p.public_id END FROM profiles p WHERE p.discord_id = s.who) AS profileId,
       MIN(s.created_at) AS firstAt
     FROM ${CREDITED_RUNS} s
     WHERE s.status = 'visible' AND s.kind IN ('interlink_run', 'interlink_best') AND s.score IS NOT NULL AND ${NAMED_ON_BOARDS}
       AND s.boss_id IS NOT NULL AND s.cycle IN (${cycles.map(() => "?").join(", ")})${server ? " AND s.server = ?" : ""}
     GROUP BY s.who, s.cycle, s.boss_id`,
  ).bind(...cycles, ...(server ? [server] : [])).all();
  // a teammate's name nobody claimed yet: marked when it looks like a claimed one
  const identities = await nameIdentities(env, (results || []).filter((row) => String(row.discordId).startsWith("name:")).map((row) => row.player));
  for (const row of results || []) {
    row.unclaimed = String(row.discordId).startsWith("name:");
    row.lookalike = row.unclaimed && identities(row.player).lookalike;
  }
  // A week the game data lists only counts its own three bosses: a misread boss name (the battle prep screen's name
  // sits over the boss art) can't add a fourth board or count a score twice.
  return (results || []).filter((row) => {
    const cycle = interlinkCycle(list, row.cycle);
    return !cycle || cycle.bosses.some((boss) => boss.id === String(row.bossId));
  }).map((row) => {
    // the SQL keeps runs with at least the old 15 stars; that week's rules may ask more for that boss slot
    const cycle = interlinkCycle(list, row.cycle);
    const slot = cycle ? cycle.bosses.findIndex((boss) => boss.id === String(row.bossId)) : -1;
    const clear = slot >= 0 ? runStarRule(row.cycle, slot, Number.isInteger(row.sentCap) && row.sentCap >= 10 && row.sentCap <= 100 ? row.sentCap : null).clear : null;
    if (clear && (Number(row.stars) || 0) < clear) row.clearTimeS = null;
    delete row.sentCap;
    return row;
  });
}

// A boss board: most stars, then highest score, then fastest clear (no clear last), then whoever got there first.
function rankedBossRuns(rows) {
  const time = (row) => (row.clearTimeS == null ? Infinity : Number(row.clearTimeS));
  return rows.sort((a, b) => (Number(b.stars) || 0) - (Number(a.stars) || 0) || (Number(b.score) || 0) - (Number(a.score) || 0)
    || time(a) - time(b) || a.firstAt - b.firstAt).map((row, index) => ({ rank: index + 1, ...row }));
}

function ranked(rows, key) {
  return rows.sort((a, b) => b[key] - a[key] || a.firstAt - b.firstAt).map((row, index) => ({ rank: index + 1, ...row }));
}

function publicCycle(cycle) {
  return cycle ? { id: cycle.id, season: cycle.season, start: cycle.start, end: cycle.end, bosses: cycle.bosses } : null;
}

// One player's standing in an Interlink season (score, stars, weeks played, rank among everyone), for profiles.
async function interlinkSeasonStanding(env, discordId, season = null) {
  const list = await interlinkCycles(env);
  if (season == null) season = currentInterlinkCycle(list).season;
  const cycles = list.filter((cycle) => cycle.season === season).map((cycle) => cycle.id);
  const totals = new Map();
  for (const row of await interlinkBests(env, cycles, list)) {
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
  const list = await interlinkCycles(env);
  const server = String(params.get("server") || "").trim().slice(0, 40) || null;
  const servers = await gameServers(env, "interlink");
  const weeks = list.map(publicCycle);
  const seasonParam = params.get("season");
  if (seasonParam !== null) {
    // Season standings: every week of the season added up.
    const season = Number(seasonParam);
    // ?split=<id> narrows the season to one split (stars reset between splits); without it, the whole season
    const splitParam = params.get("split");
    const split = splitParam === null || splitParam === "" || splitParam === "all" ? null : Number(splitParam);
    const inSeason = list.filter((cycle) => cycle.season === season);
    const cycles = inSeason.filter((cycle) => split === null || interlinkSplitOf(cycle.id) === split).map((cycle) => cycle.id);
    if (!inSeason.length) return json({ error: "Unknown season." }, 404);
    const players = new Map();
    for (const row of await interlinkBests(env, cycles, list, server)) {
      const player = players.get(row.discordId) || { discordId: row.discordId, player: row.player || "Pathfinder",
        profileId: row.profileId || null, uid: row.uid || null, unclaimed: row.unclaimed, lookalike: row.lookalike || false,
        total: 0, stars: 0, weeks: new Set(), weekTotals: new Map(), bosses: 0, firstAt: row.firstAt };
      player.total += Number(row.score) || 0; player.stars += Number(row.stars) || 0;
      player.weeks.add(row.cycle); player.bosses += 1;
      player.weekTotals.set(row.cycle, (player.weekTotals.get(row.cycle) || 0) + (Number(row.score) || 0));
      player.firstAt = Math.min(player.firstAt, row.firstAt);
      players.set(row.discordId, player);
    }
    // ranked by combined score; ?sort=stars ranks by total stars (then score)
    const order = params.get("sort") === "stars" ? "stars" : "total";
    const sorted = [...players.values()].sort((a, b) => (order === "stars" ? b.stars - a.stars || b.total - a.total : b.total - a.total)
      || a.firstAt - b.firstAt);
    const standings = sorted.map(({ discordId, weeks: played, weekTotals, firstAt, ...row }, index) => ({
      rank: index + 1, ...row, weeks: played.size, bestWeek: Math.max(0, ...weekTotals.values()), own: own(discordId),
    }));
    return json({
      season, split, sort: order === "stars" ? "stars" : "score",
      weeks: weeks.filter((week) => week.season === season && (split === null || interlinkSplitOf(week.id) === split)),
      seasons: interlinkSeasons(list), updatedAt: await interlinkUpdatedAt(env, cycles),
      standings, server, servers,
    });
  }
  // One week: the three boss boards and the week total.
  const cycle = interlinkCycle(list, params.get("cycle")) || currentInterlinkCycle(list);
  const rows = await interlinkBests(env, [cycle.id], list, server);
  const proofs = await interlinkProofs(env, [cycle.id], server);
  for (const row of rows) {
    row.proofIds = proofs.get(`${row.discordId}|${row.cycle}|${row.bossId}`) || {};
    row.proofId = row.proofIds.score || null;
  }
  // each best's check badge, from the run behind it: { score: "verified", dps: "pending", ... }
  const proofRunIds = [...new Set(rows.flatMap((row) => Object.values(row.proofIds)))];
  const badges = new Map();
  try {
    for (let i = 0; i < proofRunIds.length; i += 90) {
      const chunk = proofRunIds.slice(i, i + 90);
      const { results } = await env.DB.prepare(
        `SELECT submission_id AS id, verify_state AS state FROM leaderboard_submissions WHERE submission_id IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(...chunk).all();
      for (const result of results || []) badges.set(result.id, runCheckBadge(result.state));
    }
  } catch (error) {
    console.error("Run check badges need migration 0032", error);
  }
  for (const row of rows) {
    row.checks = Object.fromEntries(Object.entries(row.proofIds).map(([metric, id]) => [metric, badges.get(id) || null]).filter(([, badge]) => badge));
  }
  const bossIds = cycle.bosses.map((boss) => boss.id);
  for (const row of rows) {                                  // a boss the table doesn't list (newer game data)
    if (!bossIds.includes(String(row.bossId))) { bossIds.push(String(row.bossId)); }
  }
  // ?ladder= ranks every board by that figure (default: the old order, most stars then score; the site asks for
  // score); ?limit=&offset= pages each board (total says how many there are); ?boss= keeps one board.
  const ladderParam = String(params.get("ladder") || "");
  const ladder = INTERLINK_LADDERS[ladderParam] ? ladderParam : null;
  const limitParam = Number(params.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : null;
  const offset = Math.max(0, Number.parseInt(params.get("offset") || "0", 10) || 0);
  const onlyBoss = params.get("boss") ? String(params.get("boss")) : null;
  const caps = interlinkStarCaps(cycle.id);
  const bosses = bossIds.filter((id) => !onlyBoss || id === onlyBoss).map((id) => {
    const listed = cycle.bosses.find((boss) => boss.id === id);
    const slotIndex = cycle.bosses.findIndex((boss) => boss.id === id);
    const runs = rows.filter((row) => String(row.bossId) === id).map((row) => ({ ...row }));
    const all = (ladder ? rankedLadder(runs, ladder) : rankedBossRuns(runs))
      .map(({ discordId, cycle: _c, bossId, bossName, firstAt, ...row }) => ({ ...row, player: row.player || "Pathfinder", own: own(discordId) }));
    return {
      id, name: listed?.name || rows.find((row) => String(row.bossId) === id)?.bossName || id,
      slot: slotIndex >= 0 ? INTERLINK_RULES.slots[slotIndex] || null : null,
      slotIndex: slotIndex >= 0 ? slotIndex : null,
      starCap: slotIndex >= 0 ? caps[slotIndex] ?? null : null,
      level: listed?.level ?? cycle.level ?? null,
      total: all.length,
      entries: limit ? all.slice(offset, offset + limit) : all,
    };
  });
  const totals = new Map();
  for (const row of rows) {
    const player = totals.get(row.discordId) || { discordId: row.discordId, player: row.player || "Pathfinder",
      profileId: row.profileId || null, uid: row.uid || null, unclaimed: row.unclaimed, lookalike: row.lookalike || false,
      total: 0, stars: 0, scores: {}, bossStars: {}, firstAt: row.firstAt };
    player.total += Number(row.score) || 0; player.stars += Number(row.stars) || 0; player.scores[row.bossId] = row.score;
    player.bossStars[row.bossId] = row.stars;
    player.firstAt = Math.min(player.firstAt, row.firstAt);
    totals.set(row.discordId, player);
  }
  const week = ranked([...totals.values()], "total").map(({ discordId, firstAt, ...row }) => ({ ...row, own: own(discordId) }));
  return json({
    cycle: publicCycle(cycle), current: currentInterlinkCycle(list).id, weeks, bosses, week, server, servers,
    ladder: ladder || "stars", offset, limit, updatedAt: await interlinkUpdatedAt(env, [cycle.id]),
    seasons: interlinkSeasons(list),
    rules: { slots: INTERLINK_RULES.slots, slotsConfirmed: INTERLINK_RULES.slotsConfirmed, starCaps: caps,
      clearStars: interlinkStarRule(cycle.id).clear, ladders: Object.keys(INTERLINK_LADDERS) },
  });
}

async function leaderboardEntries(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!leaderboardAllowed(account, env)) return gatedResponse(account);
  const params = new URL(request.url).searchParams;
  const moderator = Boolean(account?.developerModeAvailable);
  const { where, binds, kind } = leaderboardFilters(params, { includeHidden: moderator && params.get("hidden") === "1" });
  if (params.get("mine") === "1" && account) {
    where.push("s.who = ?");
    binds.push(account.discordId);
  } else where.push(NAMED_ON_BOARDS);   // your own list shows everything; the boards only players with a name
  const sortKey = Object.hasOwn(LEADERBOARD_SORTS, params.get("sort") || "")
    ? params.get("sort")
    : LEADERBOARD_DEFAULT_SORT[kind] || "score";
  const natural = LEADERBOARD_SORTS[sortKey];
  const order = params.get("order") === "asc" ? "ASC" : params.get("order") === "desc" ? "DESC" : natural;
  // Clear-time boards only rank finished runs; values the board sorts on must be present.
  // "standing" (Egg Heist season) orders by rank tier, then Emperor stars, then rank points.
  const sortBy = (key, direction) => (prefix) => {
    if (key === "standing") return ["rank_tier", "stars", "score"].map((column) => `COALESCE(${prefix}${column}, 0) ${direction}`).join(", ");
    // Egg Heist rank points: Egg Emperors have maxed them (MAX), so they come first, ordered by their stars
    if (key === "score" && kind === "eggheist_season") {
      return [`(COALESCE(${prefix}rank_tier, 0) = 7)`, `COALESCE(${prefix}stars, 0)`, `COALESCE(${prefix}score, 0)`]
        .map((column) => `${column} ${direction}`).join(", ");
    }
    if (key === "difficulty") return `${DIFFICULTY_RANK_SQL(prefix)} ${direction}, ${prefix}score DESC`;
    if (key === "played_at") return `COALESCE(${prefix}played_at, ${prefix}created_at) ${direction}`;
    if (key === "player") return `LOWER(COALESCE(${prefix}teammate, ${prefix}characterName, ${prefix}anyCharacter, '')) ${direction}`;
    return `${prefix}${key} ${direction}`;
  };
  const mainKey = LEADERBOARD_DEFAULT_SORT[kind] || "score";
  const orderBy = sortBy(sortKey, order);
  // which of a player's runs is their row: the sort itself, or for name/date/difficulty the board's main measure
  const pickBy = DISPLAY_SORTS.has(sortKey) ? sortBy(mainKey, LEADERBOARD_SORTS[mainKey]) : orderBy;
  if (sortKey === "standing" || (sortKey === "score" && kind === "eggheist_season")) where.push("(s.rank_tier IS NOT NULL OR s.score IS NOT NULL)");
  else if (sortKey === "difficulty") where.push("s.difficulty IS NOT NULL");
  else if (sortKey !== "player" && sortKey !== "played_at") where.push(`s.${sortKey} IS NOT NULL`);
  if (sortKey === "clear_time_s") where.push(clearedSql(kind, kind === "interlink_run" ? await interlinkCycles(env) : []));
  const limit = Math.min(Math.max(Number.parseInt(params.get("limit") || "50", 10) || 50, 1), 200);
  const offset = Math.min(Math.max(Number.parseInt(params.get("offset") || "0", 10) || 0, 0), 100000);
  // One row per player (their best on each boss) unless every submission is requested.
  const bestPerPlayer = params.get("best") !== "0";
  // one row per player: the sender, or a teammate credited with the run (see CREDITED_RUNS)
  const partition = kind === "interlink_run" || kind === "interlink_best" ? "s.who, s.boss_id"
    : kind === "eggheist_season" ? "s.who, s.cycle"
      : kind === "sim_run" ? "s.who, s.cycle, s.trial, s.difficulty" : "s.who";   // Sim: a best per season, trial and difficulty
  const base = `
    SELECT s.*, gc.character_name AS characterName,
      (SELECT character_name FROM game_characters WHERE discord_id = s.who AND character_name IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1) AS anyCharacter,
      (SELECT game_uid FROM game_characters WHERE discord_id = s.who AND character_name IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1) AS anyUid,
      CASE WHEN p.is_public = 1 THEN p.public_id END AS profileId,
      ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${pickBy("s.")}, s.created_at ASC) AS playerRank
    FROM ${CREDITED_RUNS} s
    JOIN users u ON u.discord_id = s.discord_id
    LEFT JOIN profiles p ON p.discord_id = s.who
    LEFT JOIN game_characters gc ON gc.game_uid = s.game_uid AND gc.discord_id = s.discord_id AND s.teammate IS NULL
    WHERE ${where.join(" AND ")}`;
  const filtered = bestPerPlayer ? `SELECT * FROM (${base}) WHERE playerRank = 1` : base;
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM (${filtered})`).bind(...binds).first();
  const { results } = await env.DB.prepare(
    `SELECT * FROM (${filtered}) ORDER BY ${orderBy("")}, created_at ASC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();
  const profiles = await partyProfiles(env, results || []);
  const teammates = await nameIdentities(env, (results || []).filter((row) => row.teammate).map((row) => row.teammate));
  const weeks = kind === "interlink_run" ? await interlinkCycles(env) : [];
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
      // the run's own linked character, else any the account linked; for a teammate's row, the name in the party.
      // Never a party slot for the sender: the sender isn't always 1P.
      player: row.teammate || row.characterName || row.anyCharacter || "Pathfinder",
      character: row.teammate || row.characterName || null,
      uid: (row.teammate ? row.teammate_uid : (row.characterName ? row.game_uid : row.anyUid)) || null,
      teammate: Boolean(row.teammate),
      unclaimed: String(row.who).startsWith("name:"),
      lookalike: String(row.who).startsWith("name:") && teammates(row.teammate).lookalike,
      own: Boolean(account && row.who === account.discordId),
      kind: row.kind,
      mode: row.mode,
      cycle: row.cycle,
      boss: { id: row.boss_id, name: row.boss_name, level: row.boss_level },
      score: row.score,
      seasonRank: row.rank_tier == null ? null : { tier: row.rank_tier, subtier: row.rank_subtier, name: row.rank_name },
      stars: row.stars,
      clearTimeS: row.clear_time_s,
      cleared: row.cleared == null ? null : Boolean(row.cleared),
      outcome: interlinkOutcome(row, weeks),
      floors: row.floors,
      teamDps: row.team_dps,
      avgDps: row.p_dps ?? null,
      breakValue: row.p_break ?? null,
      damageTaken: row.p_taken ?? null,
      heal: row.p_heal ?? null,
      meterDps: row.meter_dps,
      meterDamage: row.meter_damage,
      partySize: row.party_size,
      difficulty: row.difficulty || null,
      trial: row.trial || null,
      trialName: row.trial ? simStageName(row.trial, row.difficulty, row.cycle) : null,
      trialGroup: row.trial ? simStage(row.difficulty, simSeasonOf(row.trial, null, row.cycle))?.label || null : null,
      defeats: row.defeats ?? null,
      server: row.server || null,
      profileId: row.profileId || null,
      players: withProfiles(parseJsonColumn(row.players_json), profiles),
      buffs: parseJsonColumn(row.buffs_json),
      extra: (({ instanceId: _instance, proofFull, proofParty, sharedRun: _shared, lineup, ...extra }) => ({ ...extra, ...(lineup ? { lineup: publicLineup(lineup) } : {}),
        ...(proofParty ? { hasPartyScreen: true } : {}),
        ...(proofFull ? { hasFullScreens: Object.keys(proofFull) } : {}) }))(parseJsonColumn(row.extra_json) || {}),
      hasEvidence: Boolean(row.evidence_key),
      hasBattleEvidence: Boolean(row.battle_evidence_key),
      check: runCheckBadge(row.verify_state),
      status: row.status,
      playedAt: row.played_at,
      submittedAt: row.created_at,
    })),
  });
}

// Distinct values present in the data, for the page's filter menus.
// The game servers records came from, most records first (records from older apps have none).
async function gameServers(env, mode) {
  const { results } = await env.DB.prepare(
    `SELECT server AS value, COUNT(*) AS count FROM leaderboard_submissions
     WHERE mode = ? AND status = 'visible' AND COALESCE(outcome, '') <> 'invalid' AND server IS NOT NULL GROUP BY server ORDER BY count DESC`,
  ).bind(mode).all();
  return results || [];
}

async function leaderboardFacets(request, env) {
  const account = await leaderboardAccount(request, env);
  if (!leaderboardAllowed(account, env)) return gatedResponse(account);
  const params = new URL(request.url).searchParams;
  const mode = LEADERBOARD_MODES.includes(params.get("mode")) ? params.get("mode") : "interlink";
  const all = async (sql) => (await env.DB.prepare(sql).bind(mode).all()).results || [];
  const visible = "FROM leaderboard_submissions WHERE mode = ? AND status = 'visible' AND COALESCE(outcome, '') <> 'invalid'";
  const difficulties = await all(`SELECT difficulty AS value, COUNT(*) AS count ${visible} AND difficulty IS NOT NULL GROUP BY difficulty ORDER BY difficulty`);
  // Holo-Battle Sim: each season's trials with the difficulties they have runs on (a board each)
  const trials = mode === "sim" ? await all(`SELECT cycle AS season, trial, difficulty, COUNT(*) AS count ${visible} AND trial IS NOT NULL
    GROUP BY cycle, trial, difficulty ORDER BY cycle DESC, trial, difficulty`) : [];
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
    servers: await gameServers(env, mode),
    cycles,
    bosses,
    levels,
    partySizes: parties,
    difficulties,
    trials: trials.map((row) => ({ ...row, name: simStageName(row.trial, row.difficulty, row.season),
      group: simStage(row.difficulty, simSeasonOf(row.trial, null, row.season))?.label || null })),
    simRules: mode === "sim" ? SIM_RULES : undefined,
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

// Every stored picture of a run: the crops and the whole screens.
function proofKeys(row) {
  const extra = parseJsonColumn(row?.extraJson) || {};
  const full = extra.proofFull || {};
  return [row?.evidenceKey, row?.battleKey, full.evidence, full.battle, extra.proofParty].filter(Boolean);
}

async function deleteSubmission(request, env, submissionId) {
  const account = await leaderboardAccount(request, env);
  if (!account) return json({ error: "Authentication required." }, 401);
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, evidence_key AS evidenceKey, battle_evidence_key AS battleKey, extra_json AS extraJson FROM leaderboard_submissions WHERE submission_id = ?",
  ).bind(submissionId).first();
  if (!row) return json({ error: "Submission not found." }, 404);
  if (row.discordId !== account.discordId && !account.developerModeAvailable) {
    return json({ error: "You can only delete your own submissions." }, 403);
  }
  await env.DB.prepare("DELETE FROM leaderboard_submissions WHERE submission_id = ?").bind(submissionId).run();
  for (const key of proofKeys(row)) if (env.EVIDENCE) await env.EVIDENCE.delete(key);
  return json({ ok: true });
}

// Screenshot evidence: visible to the submitter and to developers only.
// A run's proof screenshot. Anyone may see the proof of an entry shown on the boards (the camera icon next to the
// name); a hidden entry's only its submitter and developers.
async function submissionEvidence(request, env, submissionId) {
  const row = await env.DB.prepare(
    "SELECT discord_id AS discordId, evidence_key AS evidenceKey, battle_evidence_key AS battleKey, extra_json AS extraJson, status FROM leaderboard_submissions WHERE submission_id = ?",
  ).bind(submissionId).first();
  const shot = new URL(request.url).searchParams.get("shot");
  const full = (parseJsonColumn(row?.extraJson) || {}).proofFull || {};
  const key = shot === "battle" ? row?.battleKey : shot === "full" ? full.evidence : shot === "battle_full" ? full.battle
    : shot === "party" ? (parseJsonColumn(row?.extraJson) || {}).proofParty : row?.evidenceKey;
  if (!key || !env.EVIDENCE) return json({ error: "Evidence not found." }, 404);
  const visible = row.status === "visible";
  if (!visible) {
    const account = await leaderboardAccount(request, env);
    if (!account) return json({ error: "Authentication required." }, 401);
    if (row.discordId !== account.discordId && !account.developerModeAvailable) {
      return json({ error: "This entry is hidden: its proof is visible to its submitter and developers only." }, 403);
    }
  }
  const object = await env.EVIDENCE.get(key);
  if (!object) return json({ error: "Evidence not found." }, 404);
  const headers = securityHeaders(new Headers());
  object.writeHttpMetadata?.(headers);
  headers.set("cache-control", visible ? "public, max-age=86400" : "private, no-store");
  return new Response(object.body, { status: 200, headers });
}

// The proof to show for each player's row on the Interlink boards: their best run on that boss (that week) that has
// a screenshot - for a teammate's row, the screenshot of the run they were in.
// The proof to show for each of a player's bests on an Interlink board (score, fastest clear, and their own Average
// DPS, BREAK, damage taken and healing): the run that set it, with its screenshots - for a teammate's row, the run
// they were in. { "<who>|<cycle>|<boss>": { score: id, clear: id, dps: id, ... } }
const PROOF_METRICS = Object.freeze({
  score: (r) => [r.stars ?? -1, r.score ?? -1], clear: (r) => (r.cleared === 1 && r.clear != null ? [-r.clear] : null),
  dps: (r) => (r.dps != null ? [r.dps] : null), break: (r) => (r.brk != null ? [r.brk] : null),
  taken: (r) => (r.taken != null ? [r.taken] : null), heal: (r) => (r.heal != null ? [r.heal] : null),
});
async function interlinkProofs(env, cycles, server) {
  if (!cycles.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT s.who, s.cycle, s.boss_id AS bossId, s.submission_id AS id, s.score, s.stars, s.cleared, s.clear_time_s AS clear,
       s.p_dps AS dps, s.p_break AS brk, s.p_taken AS taken, s.p_heal AS heal
     FROM ${CREDITED_RUNS} s
     WHERE s.status = 'visible' AND s.evidence_key IS NOT NULL AND s.kind IN ('interlink_run', 'interlink_best')
       AND s.cycle IN (${cycles.map(() => "?").join(", ")})${server ? " AND s.server = ?" : ""}
     ORDER BY s.created_at ASC`,
  ).bind(...cycles, ...(server ? [server] : [])).all();
  const better = (a, b) => { for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  const best = new Map();
  for (const row of results || []) {
    const key = `${row.who}|${row.cycle}|${row.bossId}`;
    const slot = best.get(key) || {};
    for (const [metric, value] of Object.entries(PROOF_METRICS)) {
      const mine = value(row);
      if (mine && (!slot[metric] || better(mine, slot[metric].value))) slot[metric] = { value: mine, id: row.id };
    }
    best.set(key, slot);
  }
  return new Map([...best].map(([key, slot]) => [key, Object.fromEntries(Object.entries(slot).map(([m, v]) => [m, v.id]))]));
}

// Log reports from the aLogs app's "Send logs" button: the meter's logs as a zip, the game UID that sent it, an optional
// note, the app version and up to 5 screenshots the player chose (PNG, JPEG or WebP). No account needed, so it's rate
// limited per UID and per address (a salted hash, kept only to count), capped in size and in how many are kept, and
// anything older than 30 days goes on the next report.
const LOG_REPORT_MAX_BYTES = 8 * 1024 * 1024;
const LOG_REPORT_SHOTS = Object.freeze({ count: 5, bytes: 4 * 1024 * 1024 });

// A screenshot's type from its first bytes (never from what the sender says): PNG, JPEG or WebP, else null.
function screenshotType(head) {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return { type: "image/png", ext: "png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  const text = String.fromCharCode(...head.slice(0, 4)) + String.fromCharCode(...head.slice(8, 12));
  if (text === "RIFFWEBP") return { type: "image/webp", ext: "webp" };
  return null;
}
const LOG_REPORT_KEEP_S = 30 * 86400;
const LOG_REPORT_LIMITS = Object.freeze({ perUidHour: 5, perIpHour: 10, kept: 1000 });

async function submitLogReport(request, env) {
  if (!env.DB || !env.EVIDENCE) return json({ error: "Log reports are unavailable." }, 503);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: "Send the logs as multipart/form-data." }, 400);
  }
  if (Number(request.headers.get("content-length") || 0) > LOG_REPORT_MAX_BYTES + LOG_REPORT_SHOTS.count * LOG_REPORT_SHOTS.bytes + 16384) {
    return json({ error: "The logs are too large." }, 413);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Could not read the report." }, 400);
  }
  const gameUid = String(form.get("uid") || "").trim();
  if (!/^\d{6,20}$/u.test(gameUid)) return json({ error: "A game UID is required." }, 400);
  const logs = form.get("logs");
  if (!logs || typeof logs === "string" || !logs.size) return json({ error: "The logs are required." }, 400);
  if (logs.size > LOG_REPORT_MAX_BYTES) return json({ error: "The logs are too large." }, 413);
  const head = new Uint8Array(await logs.slice(0, 4).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) return json({ error: "The logs must be a zip." }, 400);
  const note = String(form.get("note") || "").trim().slice(0, 2000) || null;
  const appVersion = String(form.get("app_version") || "").trim().slice(0, 40) || null;
  const shotFiles = form.getAll("screenshot").filter((file) => file && typeof file !== "string" && file.size);
  if (shotFiles.length > LOG_REPORT_SHOTS.count) return json({ error: `At most ${LOG_REPORT_SHOTS.count} screenshots.` }, 400);
  const shots = [];
  for (const file of shotFiles) {
    if (file.size > LOG_REPORT_SHOTS.bytes) return json({ error: "A screenshot is too large (4 MB at most)." }, 413);
    const kind = screenshotType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    if (!kind) return json({ error: "Screenshots must be PNG, JPEG or WebP pictures." }, 400);
    shots.push({ file, ...kind });
  }

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256(`${ip}|log-reports|${env.SESSION_SECRET || ""}`);
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM log_reports WHERE game_uid = ? AND created_at > ?) AS uidHour,
       (SELECT COUNT(*) FROM log_reports WHERE ip_hash = ? AND created_at > ?) AS ipHour,
       (SELECT COUNT(*) FROM log_reports WHERE cleared_at IS NULL) AS kept`,
  ).bind(gameUid, now - 3600, ipHash, now - 3600).first();
  if (Number(counts?.uidHour) >= LOG_REPORT_LIMITS.perUidHour || Number(counts?.ipHour) >= LOG_REPORT_LIMITS.perIpHour) {
    return json({ error: "Too many reports in the last hour. Try again later." }, 429);
  }
  if (Number(counts?.kept) >= LOG_REPORT_LIMITS.kept) return json({ error: "Log reports are full right now. Try again later." }, 503);

  const reportId = randomToken(12);
  const logKey = `logs/${reportId}.zip`;
  await env.EVIDENCE.put(logKey, logs.stream(), {
    httpMetadata: { contentType: "application/zip" },
    customMetadata: { uid: gameUid },
  });
  const stored = [];
  for (const [index, shot] of shots.entries()) {
    const key = `logs/${reportId}-shot-${index + 1}.${shot.ext}`;
    await env.EVIDENCE.put(key, shot.file.stream(), { httpMetadata: { contentType: shot.type }, customMetadata: { uid: gameUid } });
    stored.push({ key, type: shot.type, size: shot.file.size });
  }
  await env.DB.prepare(
    `INSERT INTO log_reports (report_id, game_uid, note, app_version, size_bytes, log_key, ip_hash, created_at, screenshots_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(reportId, gameUid, note, appVersion, logs.size, logKey, ipHash, now, stored.length ? JSON.stringify(stored) : null).run();
  await expireLogReports(env, now);
  return json({ ok: true, reportId, createdAt: now, screenshots: stored.length }, 201);
}

function reportScreenshots(row) {
  try {
    const list = JSON.parse(row?.shotsJson || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// A cleared report loses its logs (the zip and screenshots) but keeps its row and notes, so what was reported and done
// stays readable.
async function clearLogReportRows(env, rows, now) {
  for (const row of rows) {
    await env.EVIDENCE.delete(row.logKey);
    for (const shot of reportScreenshots(row)) await env.EVIDENCE.delete(shot.key);
    await env.DB.prepare("UPDATE log_reports SET cleared_at = ? WHERE report_id = ?").bind(now, row.id).run();
  }
}

async function expireLogReports(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT report_id AS id, log_key AS logKey, screenshots_json AS shotsJson FROM log_reports WHERE cleared_at IS NULL AND created_at < ? LIMIT 50",
  ).bind(now - LOG_REPORT_KEEP_S).all();
  await clearLogReportRows(env, results || [], now);
}

// Administrators and the owner (logs.read; signed in on the website or in the aLogs app with its desktop token) read
// reports and leave notes on the ones they work on. Clearing is for the owner (logs.clear): they read the notes and
// clear a report once its fix is in. Testers and developers send reports but don't read them.
const LOG_REPORT_DENIED = "Access denied.";
async function logReportReader(request, env) {
  const account = await leaderboardAccount(request, env);
  return can(account, "logs.read") ? account : null;
}

// Newest first, without the address hash; ?all=1 includes cleared ones. Each with its notes, oldest first, and how many
// screenshots came with it (GET .../<id>/screenshots/<n>, from 1).
async function listLogReports(request, env) {
  if (!await logReportReader(request, env)) return json({ error: LOG_REPORT_DENIED }, 403);
  const all = new URL(request.url).searchParams.get("all") === "1";
  // Beta results and bug reports (migration 0027) add their kind, summary and content.
  const reportList = (beta) => env.DB.prepare(
    `SELECT report_id AS id, game_uid AS gameUid, note, app_version AS appVersion, size_bytes AS sizeBytes,
       created_at AS createdAt, cleared_at AS clearedAt, screenshots_json AS shotsJson${beta ? ", kind, summary, body_json AS bodyJson" : ""}
     FROM log_reports ${all ? "" : "WHERE cleared_at IS NULL"} ORDER BY created_at DESC LIMIT 500`,
  ).all();
  let results;
  try {
    ({ results } = await reportList(true));
  } catch (error) {
    if (!/no such column/iu.test(String(error?.message || error))) throw error;
    ({ results } = await reportList(false));
  }
  const reports = (results || []).map(({ shotsJson, bodyJson, ...report }) => {
    let body = null;
    try {
      body = bodyJson ? JSON.parse(bodyJson) : null;
    } catch {
      body = null;
    }
    return { ...report, ...(body ? { body } : {}), screenshots: report.clearedAt ? 0 : reportScreenshots({ shotsJson }).length };
  });
  if (reports.length) {
    const { results: notes } = await env.DB.prepare(
      `SELECT n.report_id AS reportId, n.note, n.created_at AS createdAt, COALESCE(u.discord_global_name, u.discord_username, n.discord_id) AS author
       FROM log_report_notes n LEFT JOIN users u ON u.discord_id = n.discord_id
       WHERE n.report_id IN (${reports.map(() => "?").join(",")}) ORDER BY n.created_at, n.note_id`,
    ).bind(...reports.map((r) => r.id)).all();
    for (const report of reports) {
      report.notes = (notes || []).filter((n) => n.reportId === report.id).map(({ reportId, ...n }) => n);
    }
  }
  return json({ reports });
}

async function logReportZip(request, env, reportId) {
  if (!await logReportReader(request, env)) return json({ error: LOG_REPORT_DENIED }, 403);
  const row = await env.DB.prepare(
    "SELECT log_key AS logKey, game_uid AS gameUid, created_at AS createdAt, cleared_at AS clearedAt FROM log_reports WHERE report_id = ?",
  ).bind(reportId).first();
  if (row?.clearedAt) return json({ error: "This report was cleared: its logs are gone, its notes remain." }, 410);
  const object = row && await env.EVIDENCE.get(row.logKey);
  if (!object) return json({ error: "Report not found." }, 404);
  const headers = securityHeaders(new Headers());
  headers.set("content-type", "application/zip");
  headers.set("content-disposition", `attachment; filename="aLogs-logs-${row.gameUid}-${row.createdAt}.zip"`);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { status: 200, headers });
}

async function logReportScreenshot(request, env, reportId, number) {
  if (!await logReportReader(request, env)) return json({ error: LOG_REPORT_DENIED }, 403);
  const row = await env.DB.prepare(
    "SELECT screenshots_json AS shotsJson, cleared_at AS clearedAt FROM log_reports WHERE report_id = ?",
  ).bind(reportId).first();
  if (row?.clearedAt) return json({ error: "This report was cleared: its screenshots are gone, its notes remain." }, 410);
  const shot = reportScreenshots(row)[number - 1];
  const object = shot && await env.EVIDENCE.get(shot.key);
  if (!object) return json({ error: "Screenshot not found." }, 404);
  const headers = securityHeaders(new Headers());
  headers.set("content-type", shot.type);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { status: 200, headers });
}

// An administrator's note on a report they worked on: what they found, what they changed, the PR.
async function addLogReportNote(request, env, reportId) {
  // a bearer token can't be sent by another site on its own; a website session must come from the site
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await logReportReader(request, env);
  if (!account) return json({ error: LOG_REPORT_DENIED }, 403);
  let body;
  try {
    body = await readJsonBody(request, 16384);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const note = String(body.note || "").trim().slice(0, 4000);
  if (!note) return json({ error: "A note is required." }, 400);
  if (!await env.DB.prepare("SELECT 1 FROM log_reports WHERE report_id = ?").bind(reportId).first()) {
    return json({ error: "Report not found." }, 404);
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO log_report_notes (report_id, discord_id, note, created_at) VALUES (?, ?, ?, ?)")
    .bind(reportId, account.discordId, note, now).run();
  return json({ ok: true, createdAt: now }, 201);
}

async function clearLogReports(request, env, reportId) {
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await logReportReader(request, env);
  if (!account) return json({ error: LOG_REPORT_DENIED }, 403);
  if (!can(account, "logs.clear")) return json({ error: "Only the owner clears reports: leave a note on it instead." }, 403);
  const { results } = reportId
    ? await env.DB.prepare("SELECT report_id AS id, log_key AS logKey, screenshots_json AS shotsJson FROM log_reports WHERE report_id = ? AND cleared_at IS NULL").bind(reportId).all()
    : await env.DB.prepare("SELECT report_id AS id, log_key AS logKey, screenshots_json AS shotsJson FROM log_reports WHERE cleared_at IS NULL").all();
  if (reportId && !results?.length) return json({ error: "Report not found." }, 404);
  await clearLogReportRows(env, results || [], Math.floor(Date.now() / 1000));
  return json({ ok: true, cleared: results?.length || 0 });
}

// The aLogs Beta Menu: the tester role and above (Developer Mode on or off) get a shared
// list of things to test in the current build, mark each Working or Not working, and send the results or bug reports
// with their logs. The owner (beta.manage) adds and rewords tests, retires them, and sees everyone's results.
const BETA_TEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BETA_REPORT_SHOTS = Object.freeze({ perBug: 3, total: 30, bytes: 4 * 1024 * 1024 });

// The Beta Menu: every account at tester or above, whether or not Developer Mode is on.
async function betaTester(account) {
  return BETA_ROLES.has(account?.role);
}

// A beta route's account: the app's token or a website session, with the tester role or above.
async function betaAccount(request, env) {
  const account = await leaderboardAccount(request, env);
  return account && await betaTester(account) ? account : null;
}

const betaText = (value, max) => String(value ?? "").trim().slice(0, max);

async function listBetaTests(request, env) {
  if (!env.DB) return json({ error: "The beta list is unavailable." }, 503);
  const account = await betaAccount(request, env);
  if (!account) return json({ error: "Beta access required." }, 403);
  const manager = can(account, "beta.manage");
  const { results } = await env.DB.prepare(
    `SELECT test_id AS id, build, title, how, details, retired_at AS retiredAt, updated_at AS updatedAt
     FROM beta_tests ${manager ? "" : "WHERE retired_at IS NULL"} ORDER BY sort, created_at, test_id`,
  ).all();
  const tests = results || [];
  const counts = new Map();
  if (manager && tests.length) {
    const { results: marks } = await env.DB.prepare(
      "SELECT test_id AS id, SUM(working = 1) AS working, SUM(working = 0) AS broken FROM beta_test_marks GROUP BY test_id",
    ).all();
    for (const row of marks || []) counts.set(row.id, { working: Number(row.working) || 0, broken: Number(row.broken) || 0 });
  }
  const { results: mine } = await env.DB.prepare(
    "SELECT test_id AS id, working, marked_at AS at FROM beta_test_marks WHERE discord_id = ?",
  ).bind(account.discordId).all();
  const latest = tests.reduce((best, row) => (!best || row.updatedAt > best.updatedAt ? row : best), null);
  return json({
    build: latest?.build ?? null,
    items: tests.map((row) => ({
      id: row.id,
      title: row.title,
      how: row.how,
      ...(row.details ? { details: storedBetaDetails(row.details) } : {}),
      ...(manager ? { retired: row.retiredAt != null, results: counts.get(row.id) || { working: 0, broken: 0 } } : {}),
    })),
    mine: Object.fromEntries((mine || []).map((row) => [row.id, { working: row.working === 1, at: row.at }])),
  });
}

// A test's details are paragraphs: an array of strings (a single string counts as one), at most 4000 characters in all.
// Stored as a JSON array; returns null for none, or undefined when they're too long or not text.
function betaDetails(value) {
  if (value == null || value === "") return null;
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length > 20 || list.some((paragraph) => typeof paragraph !== "string")) return undefined;
  const paragraphs = list.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (paragraphs.join("\n").length > 4000) return undefined;
  return paragraphs.length ? JSON.stringify(paragraphs) : null;
}

function storedBetaDetails(stored) {
  try {
    const list = JSON.parse(stored);
    if (Array.isArray(list)) return list;
  } catch {
    // stored before details were paragraphs
  }
  return [String(stored)];
}

// Add new tests and reword existing ones, in the order sent. Publishing is upsert-only: a test missing from the list
// is left as it is (never retired or deleted), and a retired test stays retired.
async function upsertBetaTests(request, env) {
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await betaAccount(request, env);
  if (!can(account, "beta.manage")) return json({ error: "Beta management access required." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 256 * 1024);
  } catch (error) {
    return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
  }
  const build = betaText(body?.build, 40);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!build || !items || items.length > 500) return json({ error: "A build and a list of up to 500 tests are required." }, 400);
  const tests = items.map((item, index) => ({
    id: String(item?.id ?? ""), title: betaText(item?.title, 200), how: betaText(item?.how, 2000),
    details: betaDetails(item?.details), sort: index,
  }));
  if (tests.some((test) => !BETA_TEST_ID.test(test.id) || !test.title || !test.how)) {
    return json({ error: "Every test needs an id (letters, digits, . _ -), a title and how to test it." }, 400);
  }
  if (tests.some((test) => test.details === undefined)) {
    return json({ error: "details must be a list of paragraphs, 4000 characters at most in all." }, 400);
  }
  if (new Set(tests.map((test) => test.id)).size !== tests.length) return json({ error: "Test ids must be unique." }, 400);
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  let updated = 0;
  for (const test of tests) {
    const existing = await env.DB.prepare("SELECT 1 FROM beta_tests WHERE test_id = ?").bind(test.id).first();
    if (existing) {
      await env.DB.prepare("UPDATE beta_tests SET build = ?, title = ?, how = ?, details = ?, sort = ?, updated_at = ? WHERE test_id = ?")
        .bind(build, test.title, test.how, test.details, test.sort, now, test.id).run();
      updated += 1;
    } else {
      await env.DB.prepare(
        "INSERT INTO beta_tests (test_id, build, title, how, details, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(test.id, build, test.title, test.how, test.details, test.sort, now, now).run();
      added += 1;
    }
  }
  return json({ added, updated });
}

async function retireBetaTest(request, env, testId) {
  if (!bearerToken(request) && !browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
  const account = await betaAccount(request, env);
  if (!can(account, "beta.manage")) return json({ error: "Beta management access required." }, 403);
  let body;
  try {
    body = await readJsonBody(request, 256);
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  if (typeof body?.retired !== "boolean") return json({ error: "retired must be true or false." }, 400);
  const now = Math.floor(Date.now() / 1000);
  const changed = await env.DB.prepare("UPDATE beta_tests SET retired_at = ?, updated_at = ? WHERE test_id = ?")
    .bind(body.retired ? now : null, now, testId).run();
  if (!Number(changed?.meta?.changes)) return json({ error: "Test not found." }, 404);
  return json({ ok: true, id: testId, retired: body.retired });
}

function betaJsonList(value, max) {
  try {
    const list = JSON.parse(String(value || ""));
    return Array.isArray(list) && list.length <= max ? list : null;
  } catch {
    return null;
  }
}

// From the aLogs app only (its desktop token): test results or bug reports, always with the logs zip, and up to 3
// screenshots per bug named bug-<bug>-<n>. Stored as a log report that administrators read, with a one-line summary.
async function submitBetaReport(request, env) {
  if (!env.DB || !env.EVIDENCE) return json({ error: "Beta reports are unavailable." }, 503);
  if (!bearerToken(request).startsWith(LEADERBOARD_TOKEN_PREFIX)) return json({ error: "Sign in to aLogs first." }, 401);
  const account = await betaAccount(request, env);
  if (!account) return json({ error: "Beta access required." }, 403);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
    return json({ error: "Send the report as multipart/form-data." }, 400);
  }
  if (Number(request.headers.get("content-length") || 0) > LOG_REPORT_MAX_BYTES + BETA_REPORT_SHOTS.total * BETA_REPORT_SHOTS.bytes + 262144) {
    return json({ error: "The report is too large." }, 413);
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Could not read the report." }, 400);
  }
  const kind = String(form.get("kind") || "");
  if (kind !== "beta-tests" && kind !== "beta-bugs") return json({ error: "kind must be beta-tests or beta-bugs." }, 400);
  const gameUid = String(form.get("uid") || "").trim();
  if (!/^\d{6,20}$/u.test(gameUid)) return json({ error: "A game UID is required." }, 400);
  const appVersion = betaText(form.get("app_version"), 40) || null;
  const build = betaText(form.get("build"), 40);
  if (!build) return json({ error: "The build is required." }, 400);
  const logs = form.get("logs");
  if (!logs || typeof logs === "string" || !logs.size) return json({ error: "The logs are required." }, 400);
  if (logs.size > LOG_REPORT_MAX_BYTES) return json({ error: "The logs are too large." }, 413);
  const head = new Uint8Array(await logs.slice(0, 4).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) return json({ error: "The logs must be a zip." }, 400);

  let entries;
  let summary;
  if (kind === "beta-tests") {
    const tests = betaJsonList(form.get("tests"), 500);
    if (!tests || !tests.length) return json({ error: "The tests are required." }, 400);
    entries = tests.map((test) => ({
      id: String(test?.id ?? ""), title: betaText(test?.title, 200), tested: test?.tested === true,
      working: test?.working === true ? true : test?.working === false ? false : null, note: betaText(test?.note, 2000) || null,
    }));
    if (entries.some((test) => !BETA_TEST_ID.test(test.id))) return json({ error: "Every test needs its id." }, 400);
    const tested = entries.filter((test) => test.tested).length;
    const broken = entries.filter((test) => test.tested && test.working === false).length;
    summary = `${build}: ${tested} tested, ${broken} not working`;
  } else {
    const bugs = betaJsonList(form.get("bugs"), 50);
    if (!bugs || !bugs.length) return json({ error: "The bugs are required." }, 400);
    entries = bugs.map((bug) => ({
      title: betaText(bug?.title, 200), area: betaText(bug?.area, 80) || null, severity: betaText(bug?.severity, 20) || null,
      text: betaText(bug?.text, 4000), screenshots: Math.max(0, Math.min(BETA_REPORT_SHOTS.perBug, Number(bug?.screenshots) || 0)),
    }));
    if (entries.some((bug) => !bug.title)) return json({ error: "Every bug needs a title." }, 400);
    summary = `${build}: ${entries.length} bug${entries.length === 1 ? "" : "s"}`;
  }

  const shots = [];
  for (const [name, file] of form.entries()) {
    if (!/^bug-/u.test(name)) continue;
    const match = /^bug-(\d{1,2})-(\d)$/u.exec(name);
    if (kind !== "beta-bugs" || !match || typeof file === "string" || !file.size) return json({ error: `Unexpected file ${name}.` }, 400);
    const bug = Number(match[1]);
    const number = Number(match[2]);
    if (bug < 1 || bug > entries.length || number < 1 || number > BETA_REPORT_SHOTS.perBug) return json({ error: `Unexpected file ${name}.` }, 400);
    if (file.size > BETA_REPORT_SHOTS.bytes) return json({ error: "A screenshot is too large (4 MB at most)." }, 413);
    const type = screenshotType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    if (!type) return json({ error: "Screenshots must be PNG, JPEG or WebP pictures." }, 400);
    shots.push({ file, bug, number, ...type });
  }
  if (shots.length > BETA_REPORT_SHOTS.total) return json({ error: `At most ${BETA_REPORT_SHOTS.total} screenshots.` }, 400);

  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256(`${ip}|log-reports|${env.SESSION_SECRET || ""}`);
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM log_reports WHERE game_uid = ? AND created_at > ?) AS uidHour,
            (SELECT COUNT(*) FROM log_reports WHERE cleared_at IS NULL) AS kept`,
  ).bind(gameUid, now - 3600).first();
  if (Number(counts?.uidHour) >= LOG_REPORT_LIMITS.perUidHour * 2) return json({ error: "Too many reports in the last hour. Try again later." }, 429);
  if (Number(counts?.kept) >= LOG_REPORT_LIMITS.kept) return json({ error: "Log reports are full right now. Try again later." }, 503);

  const reportId = randomToken(12);
  const logKey = `logs/${reportId}.zip`;
  await env.EVIDENCE.put(logKey, logs.stream(), { httpMetadata: { contentType: "application/zip" }, customMetadata: { uid: gameUid } });
  const stored = [];
  for (const shot of shots.sort((a, b) => a.bug - b.bug || a.number - b.number)) {
    const key = `logs/${reportId}-bug-${shot.bug}-${shot.number}.${shot.ext}`;
    await env.EVIDENCE.put(key, shot.file.stream(), { httpMetadata: { contentType: shot.type }, customMetadata: { uid: gameUid } });
    stored.push({ key, type: shot.type, size: shot.file.size, bug: shot.bug });
  }
  await env.DB.prepare(
    `INSERT INTO log_reports (report_id, game_uid, note, app_version, size_bytes, log_key, ip_hash, created_at, screenshots_json,
       kind, body_json, summary, discord_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(reportId, gameUid, summary, appVersion, logs.size, logKey, ipHash, now, stored.length ? JSON.stringify(stored) : null,
    kind, JSON.stringify({ build, [kind === "beta-tests" ? "tests" : "bugs"]: entries }), summary, account.discordId).run();
  if (kind === "beta-tests") {
    for (const test of entries.filter((entry) => entry.tested && entry.working !== null)) {
      await env.DB.prepare(
        `INSERT INTO beta_test_marks (discord_id, test_id, working, report_id, marked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(discord_id, test_id) DO UPDATE SET working = excluded.working, report_id = excluded.report_id, marked_at = excluded.marked_at`,
      ).bind(account.discordId, test.id, test.working ? 1 : 0, reportId, now).run();
    }
  }
  await expireLogReports(env, now);
  return json({ ok: true, reportId }, 201);
}

// Unreleased / unverified records for Developer Mode only. They live under releases/<release>/dev/ in R2,
// which the public content relay never serves; this route checks the developer role AND the
// server-acknowledged Developer Mode (stored progress preferences) on every read, with no caching.
const DEV_CONTENT_PREFIX = "/api/dev-content/";
// <module>/<name>.json overlays and <module>/assets/<file> images and videos (fetched by the site as blobs).
const DEV_CONTENT_PATH = /^[a-z0-9][a-z0-9-]{0,47}\/(?:[a-z0-9][a-z0-9-]{0,95}\.json|assets\/[A-Za-z0-9_-][\w.-]{0,159}\.(?:png|webp|jpe?g|mp4))$/u;
const DEV_CONTENT_TYPES = { json: "application/json; charset=utf-8", png: "image/png", webp: "image/webp",
  jpg: "image/jpeg", jpeg: "image/jpeg", mp4: "video/mp4" };

async function getDeveloperContent(request, env) {
  let relative;
  try {
    relative = decodeURIComponent(new URL(request.url).pathname.slice(DEV_CONTENT_PREFIX.length));
  } catch {
    return json({ error: "Not found" }, 404);
  }
  if (!DEV_CONTENT_PATH.test(relative)) return json({ error: "Not found" }, 404);
  if (!env.DB || !env.CONTENT) return json({ error: "Developer content is unavailable." }, 503);
  const account = await currentAccount(request, env);
  if (!account?.developerModeAvailable) return json({ error: "Developer access required." }, 403);
  const row = await env.DB.prepare(
    "SELECT revision, data_json AS dataJson, updated_at AS updatedAt FROM progress_snapshots WHERE discord_id = ?",
  ).bind(account.discordId).first();
  let progress = null;
  try {
    progress = row ? progressPayload(JSON.parse(row.dataJson)) : null;
  } catch {
    progress = null;
  }
  if (progress?.preferences?.developerMode !== true) return json({ error: "Developer mode must be enabled." }, 403);
  const object = await env.CONTENT.get(`releases/${CONTENT_RELEASE}/dev/${relative}`);
  if (!object) return json({ error: "Not found" }, 404);
  const headers = securityHeaders();
  headers.set("content-type", DEV_CONTENT_TYPES[relative.split(".").pop().toLowerCase()]);
  headers.set("cache-control", "private, no-store");
  headers.set("vary", "Authorization");
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
  if (url.pathname.startsWith(DEV_CONTENT_PREFIX) && request.method === "GET") {
    return getDeveloperContent(request, env);
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
  if (url.pathname === "/api/auth/app/exchange" && request.method === "POST") return exchangeAppSignIn(request, env);
  if (url.pathname === "/api/auth/app/account" && request.method === "GET") return appAccount(request, env);
  if (url.pathname === "/api/auth/app/sign-out" && request.method === "POST") return appSignOut(request, env);
  if (url.pathname === "/api/auth/app/site-handoff" && request.method === "POST") return appSiteHandoff(request, env);
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
  if (url.pathname === "/api/profile/main" && request.method === "PUT") return setMainCharacter(request, env);
  if (url.pathname === "/api/profiles/search" && request.method === "GET") return searchProfiles(request, env);
  if (url.pathname === "/api/profiles/directory" && request.method === "GET") return profilesDirectory(env);
  if (url.pathname === "/api/profile/layout" && request.method === "PUT") return saveProfileLayout(request, env);
  if (url.pathname === "/api/profile/history" && request.method === "GET") return ownBattleHistory(request, env);
  if (url.pathname === "/api/admin/run-outcomes" && request.method === "POST") return backfillRunOutcomes(request, env);
  const historyMatch = url.pathname.match(/^\/api\/profiles\/([A-Za-z0-9]{8,24})\/history$/u);
  if (historyMatch && request.method === "GET") return publicBattleHistory(request, env, historyMatch[1]);
  if (url.pathname === "/api/sitemap/profiles.xml" && request.method === "GET") return profilesSitemap(env);
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
  if (url.pathname === "/api/leaderboard/interlink/cycles" && request.method === "POST") return uploadInterlinkCycles(request, env);
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
  if (url.pathname === "/api/leaderboard/characters/disputes" && request.method === "POST") return disputeCharacter(request, env);
  if (url.pathname === "/api/leaderboard/characters/stats" && request.method === "POST") return saveCharacterStats(request, env);
  if (url.pathname === "/api/leaderboard/characters/presence" && request.method === "POST") return saveCharacterPresence(request, env);
  if (url.pathname === "/api/account/preferences" && (request.method === "GET" || request.method === "POST")) return accountPreferences(request, env);
  if (url.pathname === "/api/admin/character-disputes" && request.method === "GET") return listCharacterDisputes(request, env);
  const disputeMatch = url.pathname.match(/^\/api\/admin\/character-disputes\/(\d{1,12})(\/proof)?$/u);
  if (disputeMatch && disputeMatch[2] && request.method === "GET") return characterProofImage(request, env, "dispute", disputeMatch[1]);
  if (disputeMatch && !disputeMatch[2] && request.method === "PATCH") return resolveCharacterDispute(request, env, disputeMatch[1]);
  const holderProofMatch = url.pathname.match(/^\/api\/admin\/characters\/(\d{1,24})\/proof$/u);
  if (holderProofMatch && request.method === "GET") return characterProofImage(request, env, "holder", holderProofMatch[1]);
  const characterMatch = url.pathname.match(/^\/api\/leaderboard\/characters\/(\d{1,24})$/u);
  if (characterMatch && request.method === "DELETE") return unlinkCharacter(request, env, characterMatch[1]);
  const characterAdminMatch = url.pathname.match(/^\/api\/admin\/characters\/(\d{1,24})$/u);
  if (characterAdminMatch && request.method === "PUT") return reassignCharacter(request, env, characterAdminMatch[1]);
  if (url.pathname === "/api/profile/photos" && request.method === "POST") return uploadProfilePhoto(request, env);
  if (url.pathname === "/api/profile/photos" && request.method === "GET") return listOwnPhotos(request, env);
  const ownPhotoMatch = url.pathname.match(/^\/api\/profile\/photos\/([A-Za-z0-9_-]{8,40})$/u);
  if (ownPhotoMatch && request.method === "DELETE") return deleteProfilePhoto(request, env, ownPhotoMatch[1]);
  const photoMatch = url.pathname.match(/^\/api\/photos\/([A-Za-z0-9_-]{8,40})$/u);
  if (photoMatch && (request.method === "GET" || request.method === "HEAD")) return profilePhotoImage(request, env, photoMatch[1]);
  if (url.pathname === "/api/logs/reports" && request.method === "POST") return submitLogReport(request, env);
  if (url.pathname === "/api/logs/beta" && request.method === "POST") return submitBetaReport(request, env);
  if (url.pathname === "/api/beta/tests" && request.method === "GET") return listBetaTests(request, env);
  if (url.pathname === "/api/beta/tests" && request.method === "POST") return upsertBetaTests(request, env);
  const betaRetireMatch = url.pathname.match(/^\/api\/beta\/tests\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/retire$/u);
  if (betaRetireMatch && request.method === "POST") return retireBetaTest(request, env, betaRetireMatch[1]);
  if (url.pathname === "/api/admin/log-reports" && request.method === "GET") return listLogReports(request, env);
  if (url.pathname === "/api/admin/run-checks" && request.method === "GET") return listRunChecks(request, env);
  if (url.pathname === "/api/admin/run-checks/drain" && request.method === "POST") return drainRunChecksNow(request, env);
  const runCheckMatch = url.pathname.match(/^\/api\/admin\/run-checks\/([A-Za-z0-9_-]{8,40})$/u);
  if (runCheckMatch && request.method === "POST") return reviewRunCheck(request, env, runCheckMatch[1]);
  if (url.pathname === "/api/admin/log-reports" && request.method === "DELETE") return clearLogReports(request, env, null);
  const logReportNotesMatch = url.pathname.match(/^\/api\/admin\/log-reports\/([A-Za-z0-9_-]{8,40})\/notes$/u);
  if (logReportNotesMatch && request.method === "POST") return addLogReportNote(request, env, logReportNotesMatch[1]);
  const logReportShotMatch = url.pathname.match(/^\/api\/admin\/log-reports\/([A-Za-z0-9_-]{8,40})\/screenshots\/([1-5])$/u);
  if (logReportShotMatch && request.method === "GET") return logReportScreenshot(request, env, logReportShotMatch[1], Number(logReportShotMatch[2]));
  const logReportMatch = url.pathname.match(/^\/api\/admin\/log-reports\/([A-Za-z0-9_-]{8,40})$/u);
  if (logReportMatch && request.method === "GET") return logReportZip(request, env, logReportMatch[1]);
  if (logReportMatch && request.method === "DELETE") return clearLogReports(request, env, logReportMatch[1]);
  if (url.pathname === "/api/v1/shares" && request.method === "POST") return createMapShare(request, env);
  const shareMatch = url.pathname.match(/^\/api\/v1\/shares\/([^/]+)$/u);
  if (shareMatch && request.method === "GET") return getMapShare(shareMatch[1], env);
  return json({ error: "Not found" }, 404);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    try { await fillRunOutcomes(env); } catch (error) { if (env.DB) OUTCOMES_FILLED.add(env.DB); console.error("Run outcomes need migration 0033", error); }
    return corsResponse(request, env, await api(request, env));
  }
  const asset = await env.ASSETS.fetch(request);
  const headers = securityHeaders(new Headers(asset.headers), url.hostname === "127.0.0.1" || url.hostname === "localhost");
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

export default {
  fetch(request, env, ctx) {
    const scoped = ctx?.waitUntil ? Object.assign(Object.create(env), { waitUntil: (promise) => ctx.waitUntil(promise) }) : env;
    return handleRequest(request, scoped).catch((error) => {
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
