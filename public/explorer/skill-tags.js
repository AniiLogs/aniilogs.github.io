// game-audit: unaudited skill tag labels (combat.types) read from the game-derived release data
(() => {
  "use strict";

  // Skill tags: the game's own labels on a combat skill or Ultimate (Control, Pound, Abnormal Status, REGEN...),
  // which the release data carries as `combat.types`. Nothing here is hand-made: a tag exists only if some skill
  // in the data has it. The Aniilog filter uses this to list every Aniimo with a skill that has the chosen tags.

  const key = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // An Aniimo's tagged abilities: combat skills, then Ultimates.
  function abilities(entry) {
    return [...(Array.isArray(entry?.skills) ? entry.skills : []), ...(Array.isArray(entry?.ultimates) ? entry.ultimates : [])];
  }

  function tagsOf(ability) {
    const types = ability?.combat?.types;
    return Array.isArray(types) ? types.map((type) => String(type || "").trim()).filter(Boolean) : [];
  }

  // Every tag in the data, A to Z: {id, label, count}, where count is how many Aniimo have a skill with it.
  function options(entries) {
    const found = new Map();
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const seen = new Set();
      abilities(entry).forEach((ability) => tagsOf(ability).forEach((label) => {
        const id = key(label);
        if (!id || seen.has(id)) return;
        seen.add(id);
        const option = found.get(id) || { id, label, count: 0 };
        option.count += 1;
        found.set(id, option);
      }));
    });
    return [...found.values()].sort((left, right) => left.label.localeCompare(right.label, "en", { sensitivity: "base" }));
  }

  // The skills that make an Aniimo match the chosen tags.
  //   "same" (default): one skill has every chosen tag, e.g. a single skill that is both Control and Pound.
  //   "any": the chosen tags are all there, but may sit on different skills; every skill with one of them is listed.
  function matchingSkills(entry, tagIds, mode = "same") {
    const wanted = [...(tagIds || [])].map(key).filter(Boolean);
    if (!wanted.length) return [];
    const tagged = abilities(entry).map((ability) => ({ ability, ids: new Set(tagsOf(ability).map(key)) }));
    if (mode === "any") {
      if (!wanted.every((id) => tagged.some((item) => item.ids.has(id)))) return [];
      return tagged.filter((item) => wanted.some((id) => item.ids.has(id))).map((item) => item.ability);
    }
    return tagged.filter((item) => wanted.every((id) => item.ids.has(id))).map((item) => item.ability);
  }

  function matches(entry, tagIds, mode = "same") {
    return ![...(tagIds || [])].length || matchingSkills(entry, tagIds, mode).length > 0;
  }

  window.AniilogsSkillTags = Object.freeze({ key, abilities, tagsOf, options, matchingSkills, matches });
})();
