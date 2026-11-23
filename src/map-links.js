// game-audit: n/a short links to pins on the map; the map names come from the content release (map_site_data.json)
// Short links to a set of map pins (migration 0039): https://aniilogs.app/m/<code>.
// - POST /api/map-links { version: 1, selection: { m, g }, count, points }: the pins as the map shares them (the same
//   payload as its ?pins= links, checked by the same rules), stored once under a 5-character code; the same pins give
//   the code they already have. No sign-in: a browser on the site only, at most MAP_LINK_LIMITS a network and a day.
//   count and points (the pins' places, 0..9999 across the map, at most MAX_POINTS) are only drawn on the card.
// - GET /api/map-links/<code>: { selection } for the map (?pinlink=<code>).
// - GET /m/<code>: a person goes to the map with the pins: the long ?pins= address when it is short enough for
//   every browser and host (LONG_LINK_LIMIT), else ?pinlink=<code>, which the map reads from the API. A link-preview
//   crawler gets Open Graph tags with a 1200x630 card: the map's picture with the pins on it
//   (src/placement-card.js drawMapCard), kept in R2.
// - GET /api/map-links/<code>.png?v=<hash>: that card.
export const MAP_LINK_PATH = /^\/m(?:\/([^/]*))?\/?$/iu;
export const MAP_LINK_API_PATH = /^\/api\/map-links\/([23456789abcdefghjkmnpqrstuvwxyz]{5})(\.png)?$/u;
export const MAP_CODE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u;
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";   // placement links' letters (src/placement-links.js)
export const MAX_PINS_PARAM = 24000;                   // the map's own limit for ?pins= (MAX_SHARED_PINS_PAYLOAD_LENGTH)
export const LONG_LINK_LIMIT = 6000;                   // longer ?pins= addresses go by ?pinlink= instead
export const MAX_POINTS = 1500;
export const MAP_LINK_LIMITS = Object.freeze({ perNetworkHour: 30, perDay: 3000, bodyBytes: 64 * 1024 });
const CARD_VERSION = 1;

// The pins in the one spelling stored and hashed: { m, g: [[item], [item, "s" | "x", [spawn ids]]] }. Null when it
// isn't a selection the map would read (validShape: the API's own check of its share payloads).
export function canonicalSelection(value, validShape) {
  if (!validShape(value)) return null;
  if (!value.g.every((group) => group[0] !== "")) return null;         // the map drops a group without an item
  const g = value.g.map((group) => (group[1] === "s" || group[1] === "x" ? [group[0], group[1], Array.isArray(group[2]) ? group[2] : []] : [group[0]]));
  return { m: value.m, g };
}
// The ?pins= value the map reads (public/explorer/app.js parseSharedPinSelection): v1.<base64url of the JSON>
export function pinsParam(selection) {
  const bytes = new TextEncoder().encode(JSON.stringify(selection));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `v1.${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
}
// The card's dots: an even list of whole numbers 0..9999, at most MAX_POINTS pairs; null when it isn't one
export function pinPoints(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length % 2 || value.length > MAX_POINTS * 2) return null;
  return value.every((n) => Number.isInteger(n) && n >= 0 && n <= 9999) ? value : null;
}

const hex = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function createMapLinks({ json, browserWriteAllowed, readJsonBody, validSelection, siteOrigin, loadMaps, loadBase, drawCard, page,
  isCrawler, linkOrigin, pngResponse, escapeHtml }) {
  const site = (env) => siteOrigin(env) || "https://aniilogs.github.io";
  const moved = (location) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", vary: "user-agent" } });

  async function linkOf(env, code) {
    if (!MAP_CODE.test(String(code))) return null;
    const row = await env.DB.prepare("SELECT code, map_id AS mapId, selection_json AS selectionJson, pin_count AS count, points_json AS pointsJson FROM map_links WHERE code = ?")
      .bind(code).first();
    if (!row) return null;
    try {
      return { ...row, selection: JSON.parse(row.selectionJson), points: JSON.parse(row.pointsJson || "[]") };
    } catch {
      return null;
    }
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  }

  async function create(request, env) {
    if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
    let body;
    try {
      body = await readJsonBody(request, MAP_LINK_LIMITS.bodyBytes);
    } catch (error) {
      return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
    }
    const selection = body?.version === 1 ? canonicalSelection(body.selection, validSelection) : null;
    const points = pinPoints(body?.points);
    if (!selection || !points) return json({ error: "Send version 1, the pins as the map shares them, and their points." }, 400);
    const selectionJson = JSON.stringify(selection);
    if (pinsParam(selection).length > MAX_PINS_PARAM) return json({ error: "Too many pins for one link." }, 413);
    const maps = await loadMaps(env);
    if (!maps) return json({ error: "Map links are unavailable right now." }, 503);
    if (!maps.has(selection.m)) return json({ error: "That map isn't on the site." }, 400);
    const count = Number.isInteger(body.count) && body.count >= points.length / 2 && body.count <= 100000 ? body.count : points.length / 2;
    const origin = linkOrigin(request, env);
    const answer = (code, status = 200) => json({ code, url: `${origin}/m/${code}` }, status);
    const payloadHash = await hex(selectionJson);
    const existing = await env.DB.prepare("SELECT code FROM map_links WHERE payload_hash = ?").bind(payloadHash).first();
    if (existing) return answer(existing.code);

    const now = Math.floor(Date.now() / 1000);
    const network = request.headers.get("cf-connecting-ip") || "unknown";
    const networkHash = await hex(`${network}|map-links|${env.SESSION_SECRET || ""}`);
    // a network's mark is kept a day, for the hourly limit, then wiped from its links
    await env.DB.prepare("UPDATE map_links SET ip_hash = '' WHERE ip_hash != '' AND created_at < ?").bind(now - 86400).run();
    const made = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM map_links WHERE ip_hash = ? AND created_at > ?) AS hour,
              (SELECT COUNT(*) FROM map_links WHERE created_at > ?) AS day`,
    ).bind(networkHash, now - 3600, now - 86400).first();
    if (Number(made?.hour) >= MAP_LINK_LIMITS.perNetworkHour) return json({ error: "Too many new map links in the last hour. Try again later." }, 429);
    if (Number(made?.day) >= MAP_LINK_LIMITS.perDay) return json({ error: "Map links are busy today. Try again tomorrow." }, 503);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = newCode();
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO map_links (code, payload_hash, map_id, selection_json, pin_count, points_json, ip_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(code, payloadHash, selection.m, selectionJson, count, JSON.stringify(points), networkHash, now).run();
      } catch (error) {
        console.error("Could not store a map link", error);
        return json({ error: "Map links are unavailable right now." }, 503);
      }
      // ours, or the one a call at the same moment made for the same pins; none: the code was taken, try another
      const stored = await env.DB.prepare("SELECT code FROM map_links WHERE payload_hash = ?").bind(payloadHash).first();
      if (stored) return answer(stored.code, stored.code === code ? 201 : 200);
    }
    return json({ error: "Map links are unavailable right now." }, 503);
  }

  async function read(request, env, code) {
    const link = await linkOf(env, code);
    if (!link) return json({ error: "This pin link was not found." }, 404);
    return json({ code: link.code, selection: link.selection });
  }

  // What the preview and the card say
  function describe(link, map) {
    const count = Math.max(Number(link.count) || 0, link.points.length / 2);
    const name = map?.label || "the AniiLogs map";
    const kinds = link.selection.g.length;
    const title = `${count.toLocaleString("en-US")} ${count === 1 ? "pin" : "pins"} on ${name}`;
    const description = `${count.toLocaleString("en-US")} ${count === 1 ? "pin" : "pins"}${kinds > 1 ? ` of ${kinds} kinds` : ""} on ${name}`
      + `${map?.world && map.world !== name ? `, ${map.world}` : ""}. Open them on the AniiLogs interactive map.`;
    const card = { count, map: name, world: map?.world && map.world !== name ? map.world : "", kinds, aspect: map?.aspect || 0, points: link.points, v: CARD_VERSION };
    return { title, description, card };
  }
  const cardHash = async (card, base) => (await hex(JSON.stringify({ ...card, base: Boolean(base) }))).slice(0, 16);

  async function open(request, env, asked) {
    const code = String(asked || "").toLowerCase();
    if (!MAP_CODE.test(code)) return moved(`${site(env)}/explorer/`);
    const link = await linkOf(env, code);
    if (!isCrawler(request)) {
      if (!link) return moved(`${site(env)}/explorer/?pinlink=${code}`);       // the map says it wasn't found
      const pins = pinsParam(link.selection);
      return moved(`${site(env)}/explorer/?${pins.length <= LONG_LINK_LIMIT ? `pins=${pins}` : `pinlink=${code}`}`);
    }
    if (!link) {
      return page(404, { title: "This pin link isn't available · AniiLogs", description: "These pins aren't on the AniiLogs map.",
        body: `<h1>This pin link isn't available</h1>\n<p><a href="${escapeHtml(`${site(env)}/explorer/`)}">Open the map</a></p>` });
    }
    const maps = await loadMaps(env);
    const { title, description, card } = describe(link, maps?.get(link.mapId));
    const base = await loadBase(env, link.mapId, true);
    const hash = await cardHash(card, base);
    const target = `${site(env)}/explorer/?pinlink=${code}`;
    return page(200, { title, tabTitle: `${title} · AniiLogs`, description, url: `${linkOrigin(request, env)}/m/${code}`,
      image: `${new URL(request.url).origin}/api/map-links/${code}.png?v=${hash}`, imageAlt: `${title}: ${description}`,
      body: `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(description)}</p>\n<p><a href="${escapeHtml(target)}">Open them on the map</a></p>` });
  }

  // The card: kept in R2 under the code and a hash of everything it shows (with or without the map's picture), so it
  // is drawn once, and again once the map's picture is there
  async function cardImage(request, env, code) {
    const link = await linkOf(env, code);
    if (!link) return json({ error: "Not found" }, 404);
    const maps = await loadMaps(env);
    const { card } = describe(link, maps?.get(link.mapId));
    const base = await loadBase(env, link.mapId, false);
    const hash = await cardHash(card, base);
    const key = `map-cards/${code}-${hash}.png`;
    const exact = new URL(request.url).searchParams.get("v") === hash;
    const store = env.EVIDENCE || null;
    const kept = store ? await store.get(key) : null;
    if (kept) return pngResponse(kept.body, exact);
    const png = await drawCard(card, base);
    if (store) {
      const put = store.put(key, png, { httpMetadata: { contentType: "image/png" } });
      if (env.waitUntil) env.waitUntil(put.catch((error) => console.error("Could not keep a map card", error)));
      else await put;
    }
    return pngResponse(png, exact);
  }

  return { create, read, open, cardImage };
}
