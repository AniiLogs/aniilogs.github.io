// game-audit: n/a links to the Aniilog's pages; every fact shown is read from the content release (aniilog_data.json)
// A link for every Aniimo: https://aniilogs.app/a/<slug> (the names players type, not form ids).
// - The slug: the Aniimo's English name, lower case, letters and digits joined by "-" ("emberpup"); a form other than
//   the basic one adds its form's name ("emberpup-highland" for the Highland Form, "scorchhowl-prismana"). Forms are
//   named in form id order, so a slug never moves once given; a slug already taken gets the form id after it
//   ("<slug>-<form id>"). public/aniimo-link.js makes the same slugs for the Aniilog's "Copy link" button.
// - GET /a/<slug>: a person is sent to that form's Aniilog page; a link-preview crawler (Discord) gets Open Graph tags
//   with a 1200x630 card (src/placement-card.js drawAniimoCard), kept in R2. A name without a form (/a/fennelun for a
//   name with no basic form), any letter case, or a form id also find their page. Anything else goes to the Aniilog.
// - GET /api/aniimo-cards/<slug>.png?v=<hash>: that card.
// The Aniimo list comes from the content release's aniilog_data.json (3 MB) once per release, kept as a small index in
// R2 (aniimoLinkIndex below; loadIndex in src/index.js), so a link costs the API a small read, not that file.
export const ANIIMO_PATH = /^\/a(?:\/([^/]*))?\/?$/iu;
export const ANIIMO_CARD_PATH = /^\/api\/aniimo-cards\/([a-z0-9-]{1,80})\.png$/u;
export const ANIIMO_INDEX_VERSION = 1;
const CARD_VERSION = 1;                                  // raise when the card's drawing changes, to draw kept cards anew

// "Emberpup" -> "emberpup", "Timberline Form" -> "timberline-form": lower-case letters and digits, joined by "-"
export function slugPart(text) {
  return String(text ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

// Every form's slug: entries are the Aniilog's ({ form_id, name, form_key, form_label }). Returns Map form id -> slug,
// and the names that have no form of their own bare slug -> the form id they open (the lowest).
export function aniimoSlugs(entries) {
  const forms = [...entries].filter((entry) => /^\d{1,12}$/u.test(String(entry?.form_id ?? "")))
    .sort((a, b) => Number(a.form_id) - Number(b.form_id));
  const taken = new Set(); const slugs = new Map(); const firstOfName = new Map();
  for (const entry of forms) {
    const id = String(entry.form_id);
    const base = slugPart(entry.name) || "aniimo";
    const basic = String(entry.form_key || "basic").toLowerCase() === "basic";
    const form = slugPart(String(entry.form_label || "").replace(/\s*\bform\s*$/iu, ""));
    let slug = basic ? base : form ? `${base}-${form}` : `${base}-${id}`;
    if (taken.has(slug)) slug = `${slug}-${id}`;
    taken.add(slug); slugs.set(id, slug);
    if (!firstOfName.has(base)) firstOfName.set(base, id);
  }
  const aliases = new Map();
  for (const [base, id] of firstOfName) if (!taken.has(base)) aliases.set(base, id);
  return { slugs, aliases };
}

const roundFigure = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? String(Math.round(Number(value) * 100) / 100) : null);
// The small index the links read: one row a form, with what the card and the preview say
export function aniimoLinkIndex(data, release) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const labels = data?.element_labels && typeof data.element_labels === "object" ? data.element_labels : {};
  const colours = new Map();                             // an element's colour, as its skills show it
  for (const entry of entries) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const element = skill?.combat?.element; const colour = skill?.combat?.element_color;
      if (element && /^#[0-9a-f]{6}$/iu.test(String(colour || "")) && !colours.has(element)) colours.set(element, String(colour));
    }
  }
  const { slugs, aliases } = aniimoSlugs(entries);
  const text = (value, max) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
  const forms = entries.filter((entry) => slugs.has(String(entry?.form_id ?? ""))).map((entry) => ({
    id: String(entry.form_id), slug: slugs.get(String(entry.form_id)), name: text(entry.name, 60),
    form: text(entry.form_label, 60), basic: String(entry.form_key || "basic").toLowerCase() === "basic", number: text(entry.aniilog_number, 12),
    elements: (Array.isArray(entry.elements) ? entry.elements : []).slice(0, 3).map((element) => ({
      label: text(labels[element?.name] || element?.name, 20), color: colours.get(element?.name) || "" })).filter((element) => element.label),
    role: text(entry.role, 20), world: text(entry.surface_label, 40),
    height: roundFigure(entry.profile?.height_m), weight: roundFigure(entry.profile?.weight_kg),
    // art: the release's own picture only (a few forms point at another site's; they get the letter instead)
    icon: /^assets\/[A-Za-z0-9_./-]+\.png$/u.test(String(entry.icon || "")) && !String(entry.icon).includes("..") ? String(entry.icon) : "",
    description: text(entry.description, 400),
  }));
  return { version: ANIIMO_INDEX_VERSION, release: String(release), forms, aliases: Object.fromEntries(aliases) };
}

// The form a link asks for: its slug, a name or form id in any letter case or spelling the slug rule turns into one
export function findAniimo(index, asked) {
  if (!index?.forms?.length) return null;
  let raw = String(asked ?? "");
  try { raw = decodeURIComponent(raw); } catch { /* the address as it came */ }
  const bySlug = (slug) => index.forms.find((form) => form.slug === slug) || null;
  const byId = (id) => index.forms.find((form) => form.id === id) || null;
  const key = slugPart(raw);
  if (!key) return null;
  if (/^\d{1,12}$/u.test(key)) return byId(key);
  return bySlug(key) || (index.aliases?.[key] ? byId(index.aliases[key]) : null);
}

// What the preview and the card say
export function describeAniimo(form) {
  const title = form.basic || !form.form ? form.name : `${form.name} · ${form.form}`;
  const elements = form.elements.map((element) => element.label);
  const facts = [elements.join(" / "), form.role, form.form, form.number ? `Aniilog ${form.number}` : null].filter(Boolean).join(" · ");
  const size = [form.height ? `${form.height} m` : null, form.weight ? `${form.weight} kg` : null, form.world || null].filter(Boolean).join(" · ");
  const description = [facts ? `${facts}.` : null, form.description || null].filter(Boolean).join(" ").slice(0, 300);
  const card = { name: form.name, form: form.form, number: form.number, elements: form.elements, role: form.role,
    facts: size ? [size] : [], description: form.description, art: form.icon || null, v: CARD_VERSION };
  return { title, description, card };
}

export function createAniimoLinks({ json, siteOrigin, loadIndex, loadArt, drawCard, page, isCrawler, linkOrigin, pngResponse, escapeHtml }) {
  const site = (env) => siteOrigin(env) || "https://aniilogs.github.io";
  const cardHash = async (card) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(card))));
    return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const moved = (location) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store", vary: "user-agent" } });

  async function open(request, env, asked) {
    const index = await loadIndex(env);
    const form = findAniimo(index, asked);
    if (!form) return moved(`${site(env)}/explorer/?view=aniilog`);
    const target = `${site(env)}/explorer/?aniimo=${encodeURIComponent(form.id)}`;
    if (!isCrawler(request)) return moved(target);
    const { title, description, card } = describeAniimo(form);
    const hash = await cardHash(card);
    const image = `${new URL(request.url).origin}/api/aniimo-cards/${form.slug}.png?v=${hash}`;
    return page(200, { title, tabTitle: `${title} · AniiLogs`, description, url: `${linkOrigin(request, env)}/a/${form.slug}`, image,
      imageAlt: `${title}: ${description}`,
      body: `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(description)}</p>\n<p><a href="${escapeHtml(target)}">Open it in the Aniilog</a></p>` });
  }

  // The card: kept in R2 under the release, the slug and a hash of everything it shows, so each look is drawn once
  async function cardImage(request, env, slug) {
    const index = await loadIndex(env);
    const form = index?.forms?.find((item) => item.slug === slug);
    if (!form) return json({ error: "Not found" }, 404);
    const { card } = describeAniimo(form);
    const hash = await cardHash(card);
    const key = `aniimo-cards/${index.release}/${form.slug}-${hash}.png`;
    const exact = new URL(request.url).searchParams.get("v") === hash;
    const store = env.EVIDENCE || null;
    const kept = store ? await store.get(key) : null;
    if (kept) return pngResponse(kept.body, exact);
    const art = card.art ? await loadArt(env, card.art) : null;
    const png = await drawCard(card, art);
    // art that couldn't be read this time: the card is shown, not kept, so the next look tries the art again
    if (store && (!card.art || art)) {
      const put = store.put(key, png, { httpMetadata: { contentType: "image/png" } });
      if (env.waitUntil) env.waitUntil(put.catch((error) => console.error("Could not keep an Aniimo card", error)));
      else await put;
    }
    return pngResponse(png, exact && (!card.art || art));
  }

  return { open, cardImage };
}
