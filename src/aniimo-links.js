// game-audit: n/a links to the Aniilog's pages; every fact shown is read from the content release (aniilog_data.json)
// A link for every Aniimo: https://aniilogs.app/a/<slug> (the names players type, not form ids).
// - The slug: the Aniimo's English name, lower case, letters and digits joined by "-" ("emberpup"); a form other than
//   the basic one adds its form's name ("emberpup-highland" for the Highland Form, "scorchhowl-prismana"). Forms are
//   named in form id order, so a slug never moves once given; a slug already taken gets the form id after it
//   ("<slug>-<form id>"). public/aniimo-link.js makes the same slugs for the Aniilog's "Copy link" button.
// - GET /a/<slug>: a person is sent to that form's Aniilog page; a link-preview crawler (Discord) gets Open Graph tags
//   with a 1200x630 card (src/placement-card.js drawAniimoCard), kept in R2. A name without a form (/a/fennelun for a
//   name with no basic form), any letter case, or a form id also find their page. Anything else goes to the Aniilog.
//   Search engines are crawlers too: the same page is the Aniimo's search entry (indexed, canonical /a/<slug>), with
//   what the Aniilog shows in words - stats, skills, traits, where it lives, evolutions, research.
// - GET /api/aniimo-cards/<slug>.png?v=<hash>: that card.
// - GET /api/sitemap/aniimo.xml: every form's /a/<slug>, named in robots.txt.
// The Aniimo list comes from the content release's aniilog_data.json (3 MB) once per release, kept as a small index in
// R2 (aniimoLinkIndex below; loadIndex in src/index.js), so a link costs the API a small read, not that file.
export const ANIIMO_PATH = /^\/a(?:\/([^/]*))?\/?$/iu;
export const ANIIMO_CARD_PATH = /^\/api\/aniimo-cards\/([a-z0-9-]{1,80})\.png$/u;
export const ANIIMO_INDEX_VERSION = 2;                 // 2: the search page's facts
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
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  // longer text for the search page: cut at a word, with an ellipsis, never mid-word
  const words = (value, max) => { const all = text(value, 4000); if (all.length <= max) return all;
    const cut = all.slice(0, max); const space = cut.lastIndexOf(" "); return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/u, "")}…`; };
  const formIdOf = (step) => { const id = String(step?.id ?? step?.form_id ?? "").replace(/^aniimo:/u, ""); return /^\d{1,12}$/u.test(id) ? id : ""; };
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
    // the search page: what the Aniilog shows, in words
    stats: list(entry.stats, 12).map((stat) => ({ label: text(stat?.label, 30), value: Number(stat?.value) }))
      .filter((stat) => stat.label && Number.isFinite(stat.value)),
    skills: [...list(entry.skills, 24), ...list(entry.ultimates, 6).map((skill) => ({ ...skill, group: skill?.group || "Ultimate" }))]
      .map((skill) => ({ name: text(skill?.name, 60), group: text(skill?.group, 20), element: text(labels[skill?.combat?.element] || skill?.combat?.element, 20),
        description: words(skill?.description, 480) })).filter((skill) => skill.name),
    traits: list(entry.traits, 8).map((trait) => ({ name: text(trait?.name, 60), description: words(trait?.description, 480) })).filter((trait) => trait.name),
    abilities: list(entry.homeland, 6).map((ability) => ({ name: text(ability?.name, 40), description: words(ability?.description, 300) })).filter((ability) => ability.name),
    explore: text(entry.explore_ability?.name, 40),
    places: list(entry.locations, 8).map((place) => ({ map: text(place?.map_label, 60), areas: list(place?.areas, 24).map((area) => text(area, 60)).filter(Boolean) }))
      .filter((place) => place.map),
    from: list(entry.evolution?.from, 6).map(formIdOf).filter(Boolean),
    to: list(entry.evolution?.to, 6).map(formIdOf).filter(Boolean),
    research: list(entry.aniilog_research, 12).map((task) => ({ name: text(task?.name, 80), objective: words(task?.objective, 300) })).filter((task) => task.name),
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

// The search page's text: everything escaped; other forms and evolutions link to their own /a/ pages
export function aniimoPageBody(form, index, { escapeHtml, linkBase, target, art }) {
  const e = escapeHtml;
  const { title, description } = describeAniimo(form);
  const byId = new Map((index?.forms || []).map((item) => [item.id, item]));
  const nameOf = (item) => (item.basic || !item.form ? item.name : `${item.name} (${item.form})`);
  const linkTo = (item) => `<a href="${e(`${linkBase}/a/${item.slug}`)}">${e(nameOf(item))}</a>`;
  const section = (heading, items) => (items.length ? `<h2>${e(heading)}</h2>\n<ul>\n${items.map((item) => `<li>${item}</li>`).join("\n")}\n</ul>` : "");
  const named = (name, words) => `<strong>${e(name)}</strong>${words ? ` - ${e(words)}` : ""}`;
  const stats = form.stats?.length
    ? `<h2>Base stats</h2>\n<table>\n${form.stats.map((stat) => `<tr><th>${e(stat.label)}</th><td>${e(String(stat.value))}</td></tr>`).join("\n")}\n</table>` : "";
  const facts = [
    form.elements.length ? `Element: ${form.elements.map((element) => element.label).join(" / ")}` : null,
    form.role ? `Role: ${form.role}` : null, form.number ? `Aniilog ${form.number}` : null, form.world ? `World: ${form.world}` : null,
    form.height ? `Height: ${form.height} m` : null, form.weight ? `Weight: ${form.weight} kg` : null,
    form.explore ? `Exploration: ${form.explore}` : null,
  ].filter(Boolean);
  const forms = (index?.forms || []).filter((item) => item.name === form.name && item.id !== form.id);
  const steps = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map(linkTo);
  const skillName = (skill) => `${skill.name}${skill.group || skill.element ? ` (${[skill.group, skill.element].filter(Boolean).join(", ")})` : ""}`;
  return [
    art ? `<img src="${e(art)}" alt="${e(title)}" width="96" height="96">` : "",
    `<h1>${e(title)}</h1>`,
    `<p>${e(description)}</p>`,
    section("Facts", facts.map(e)),
    stats,
    section("Skills", (form.skills || []).map((skill) => named(skillName(skill), skill.description))),
    section("Traits", (form.traits || []).map((trait) => named(trait.name, trait.description))),
    section("Home abilities", (form.abilities || []).map((ability) => named(ability.name, ability.description))),
    section("Where to find it", (form.places || []).map((place) => named(place.map, place.areas.join(", ")))),
    section("Evolves from", steps(form.from || [])),
    section("Evolves into", steps(form.to || [])),
    section("Other forms", forms.map(linkTo)),
    section("Aniilog research", (form.research || []).map((task) => named(task.name, task.objective))),
    `<p><a href="${e(target)}">Open ${e(title)} in the 3D Aniilog</a> · <a href="${e(`${linkBase}/explorer/?view=aniilog`)}">Every Aniimo</a></p>`,
  ].filter(Boolean).join("\n");
}

// The sitemap search engines read: one /a/<slug> a form
export function aniimoSitemap(index, linkBase) {
  const urls = (index?.forms || []).filter((form) => /^[a-z0-9-]{1,80}$/u.test(form.slug)).map((form) => `<url><loc>${linkBase}/a/${form.slug}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function createAniimoLinks({ json, siteOrigin, loadIndex, loadArt, drawCard, page, isCrawler, linkOrigin, pngResponse, escapeHtml, artUrl = () => null }) {
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
    const linkBase = linkOrigin(request, env);
    const art = form.icon ? artUrl(request, env, form.icon) : null;
    return page(200, { title, tabTitle: `${title} - Aniimo stats, skills and where to find it · AniiLogs`, description,
      url: `${linkBase}/a/${form.slug}`, image, imageAlt: `${title}: ${description}`, indexable: true,
      body: aniimoPageBody(form, index, { escapeHtml, linkBase, target, art }) });
  }

  async function sitemap(request, env) {
    const index = await loadIndex(env);
    const ok = Boolean(index?.forms?.length);
    return new Response(aniimoSitemap(index, linkOrigin(request, env)), { status: ok ? 200 : 503,
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": ok ? "public, max-age=3600" : "no-store" } });
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

  return { open, cardImage, sitemap };
}
