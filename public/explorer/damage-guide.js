// The Try-Hard Guide's text and the "i" notes for skills and traits whose game text leaves something
// out. Plain-text paragraphs (no HTML); the page renders them. Each section says how sure it is:
// exact (read from the game's scripts or tables), by-name (matched to a game attribute by its name),
// inferred (a reasoned reading), text (from the game's own skill text, not its effect data). A section
// may carry `tests`: [{ id, text }] for things to check in the game before they can be trusted. Numbers come
// from build 3846247; see damage-model.js for the maths.
(() => {
  const TITLE = "Try-Hard Guide";

  const SECTIONS = Object.freeze([
    {
      id: "formula",
      title: "How a hit's damage is worked out",
      basis: "exact",
      paragraphs: [
        "Every hit starts from your ATK minus the target's defence, times the skill's Might divided by 10. A Might 30 skill hits for 3 × (ATK − DEF).",
        "That base never drops below 10% of your ATK, so even a very tanky target takes something.",
        "The base is then multiplied by a row of separate boosts: the element matchup, a ×1.1 bonus when the skill's element is one of your Aniimo's own, Elemental Boost, crits, Damage Amp and Final Damage.",
        "Physical skills hit against P.DEF and Magical skills against M.DEF. This part is inferred: the game's server picks which defence it passes in, but the stat names and skill categories line up.",
      ],
    },
    {
      id: "stacking",
      title: "What stacks with what",
      basis: "exact",
      paragraphs: [
        "Boosts of the same kind add together. Different kinds multiply. Two +15% Damage Amp buffs give +30%, not +32%. A +15% Damage Amp and a +15% Elemental Boost give ×1.15 × 1.15 = +32%.",
        "So spreading your team's boosts over different kinds beats piling up one kind. Each kind is strongest while it is still empty.",
        "Damage Amp, Damage Boost and \"DMG +x%\" are all the same stat in the game, so they share one pot. The target's Damage Reduction comes out of that same pot. The Damage Amp and Final Damage pots each have a floor of ×0.2, so reductions can never cut those below a fifth. The elemental pot has no floor: at 0 or less the hit does nothing.",
        "Final Damage (for example Helion's Solar Grace) is a separate pot from Damage Amp, so it multiplies on top.",
      ],
      table: {
        columns: ["Kind of boost", "Adds with", "Example"],
        rows: [
          ["Damage Amp", "Other Damage Amp; the target's Damage Reduction subtracts", "Glimmer Shot +15% (team), Practical personality +4%"],
          ["Elemental Boost", "Other boosts of that element; the target's resistance to it subtracts", "Lotus Bloom +15% Grass (team), Fire Debuff stacks −1% Fire resistance each"],
          ["Final Damage", "Other Final Damage", "Solar Grace"],
          ["Crit Rate / Crit Damage", "Their own kind; the target's crit resistance subtracts", "Waltz crit damage, Weakness Mark crit resistance cut"],
          ["Basic / Skill / Ultimate damage (inferred)", "Bonuses for the same type of attack", "Darkblade basic attack damage"],
          ["Counter Boost", "Only applies when your element counters the target", "Scorching Flames +25%"],
        ],
      },
    },
    {
      id: "atk",
      title: "ATK potential: how much damage each point adds",
      basis: "exact",
      paragraphs: [
        "Each ATK potential point adds 0.8% to your ATK's formula value. Every 4 points also add +4% to the stat's % pot, which it shares with personality and held items. So 20 points give ×1.16 and +20%, about +39% ATK.",
        "Because damage comes from ATK minus the target's DEF, extra ATK is worth more than its own percentage. The gain from extra ATK is ΔATK ÷ (ATK − DEF): the closer your ATK is to the target's DEF, the bigger each point's effect.",
        "Against no defence, +39% ATK is +39% damage. Against a same-level target it is about +76%. Against a very tanky target that was holding you at the 10% floor, it can be several times your damage.",
        "Compare a +15% Damage Amp buff: at most +15%, and less if your team already has Damage Amp. Damage Amp doesn't care about the target's DEF. ATK potential matters most against tanky targets.",
        "Example: Flameruff (ATK 111, P.DEF 72 species values) hitting another Flameruff with no P.DEF potential, per 10 Might.",
      ],
      table: {
        columns: ["ATK potential", "Lv 50: ATK / damage", "Lv 67: ATK / damage", "Lv 70: ATK / damage"],
        rows: [
          ["0", "309 / 159", "413 / 212", "437 / 225"],
          ["4", "331 / 181", "444 / 243", "469 / 257"],
          ["8", "355 / 205", "475 / 274", "502 / 290"],
          ["12", "379 / 229", "507 / 306", "536 / 324"],
          ["16", "404 / 254", "540 / 339", "571 / 359"],
          ["20", "430 / 280 (+76%)", "574 / 373 (+76%)", "608 / 396 (+76%)"],
        ],
      },
      note: "Target P.DEF: 150 at Lv 50, 201 at Lv 67, 212 at Lv 70. Before personality, held items and other bonuses.",
    },
    {
      id: "elements",
      title: "Elements",
      basis: "exact",
      paragraphs: [
        "A countering element deals ×1.6, a resisted one ×0.625. Against two elements the two values multiply: 1.6 × 1.6 = ×2.56, 1.6 × 0.625 = ×1.",
        "Counter Boost (for example Scorching Flames) multiplies your damage only when the matchup is in your favour overall. Resistance Boost divides it only when the matchup is against you. A mixed matchup (one countered, one resisted) counts as neutral, so neither applies.",
        "Elemental Boost and the target's resistance to that element share one pot. If that pot reaches 0 or less, the hit does no damage at all.",
        "An elemental shield replaces the target's own elements while it is up.",
      ],
    },
    {
      id: "crit",
      title: "Crits",
      basis: "exact",
      paragraphs: [
        "Every Aniimo starts with 10% Crit Rate and +50% Crit Damage.",
        "Crit Rate adds up from all sources, including bonuses for basic attacks, skills or Ultimates, minus the target's crit resistance. At 100% or more every hit crits.",
        "A crit multiplies the hit by 1 + Crit Damage, capped at ×3 in total.",
      ],
    },
    {
      id: "break",
      title: "BREAK",
      basis: "exact",
      paragraphs: [
        "The BREAK bar over a target is its BREAK points. Every hit takes BREAK damage off it, and at zero the target is in BREAK. Pets stay in BREAK for 6s.",
        "BREAK damage uses your BREAK stat: (your BREAK − the target's BREAK defence) × the hit's share × the skill's Might ÷ 10. Some skills add their own BREAK multiplier; most don't. It can crit like normal damage (up to ×3), and a bad element matchup never lowers it. Damage Amp, Final Damage and the same-element bonus don't affect it. BREAK Efficiency and \"BREAK damage taken\" on the target do.",
        "A pet's BREAK bar grows with its level: about 27,900 at Lv 50 and 52,800 at Lv 70 (formula 3110). Pets have no BREAK defence of their own. So against a pet, hits to BREAK ≈ its BREAK bar ÷ your BREAK damage per hit.",
        "Example: a Lv 50 Flameruff with 20 BREAK potential has BREAK 208. Fire Kick (Might 72) deals about 208 × 7.2 ≈ 1,500 BREAK damage, so about 19 Fire Kicks to BREAK a Lv 50 pet without any BREAK Efficiency.",
        "Toughness is a different, smaller gauge (60 for pets; 10, 30, 50, 120 or unbreakable for other targets). It drains by each skill's own toughness power (a separate value per skill), not your BREAK stat. Casting raises it and super armour blocks it, so it reads as the stagger / interrupt gauge rather than BREAK (inferred).",
        "Monsters use their own BREAK bars, and the world scales to your level, so hits to BREAK something depend on what you're fighting and both levels.",
      ],
    },
    {
      id: "level",
      title: "Level gap",
      basis: "by-name",
      paragraphs: [
        "The game picks a row of its level-gap table by your level minus the target's (exact). The world scales to your level, so most fights sit near 0, where nothing changes.",
        "Toughness drain from that row is exact: fighting 10 levels above you, your hits drain ×0.5 toughness; 20 above, ×0.1.",
        "The damage part has four columns, picked on the game's server by who is fighting whom. For example, at 10 levels in your favour one column gives +35% damage and another −30%. Which applies to you isn't in the client files, so the 1v1 tab leaves it out.",
      ],
    },
    {
      id: "stats",
      title: "What makes up an Aniimo's stats",
      basis: "exact",
      paragraphs: [
        "The six stats are HP, ATK, P.DEF, REGEN, M.DEF and BREAK. Magic Attack still exists in old data but nothing in the game uses it.",
        "Each stat is its base value × (1 + every % bonus) + flat bonuses. All % bonuses to a stat share one pot: potential, personality, held items.",
        "The base value comes from the Aniimo's species points, level and potential. The game can also give an owned Aniimo species points of its own, which replace the listed ones, so your card may not match the site's numbers exactly.",
        "Personality traits each give one bonus and one home bonus, for example Energetic: ATK +2%, BREAK +2%. Natures are flavour only.",
        "A held item's stat grows with its level: +5% of its base per level up to level 10, then +10% per level, doubling at level 15.",
      ],
    },
    {
      id: "untested",
      title: "Not verified yet",
      basis: "inferred",
      paragraphs: [
        "These come from reading the game files but haven't been checked in the game. Treat them as unconfirmed until someone tests them.",
      ],
      tests: [
        { id: "break-hits", text: "Hits to BREAK a pet. The BREAK bar is BREAK points (read from the game's UI code), and BREAK damage uses your BREAK stat and the skill's Might. Test: count the Fire Kicks a Lv 50 Flameruff with 20 BREAK potential needs to BREAK a Lv 50 pet (about 19 expected, with no BREAK Efficiency). Note both levels and what you fought." },
        { id: "break-pots", text: "BREAK Efficiency (on you) and BREAK damage taken (on the target) add in one pot." },
        { id: "magic-defence", text: "Magical skills hit against M.DEF and Physical skills against P.DEF. Test: hit the same target with a Physical and a Magical skill of similar Might, and compare against its P.DEF and M.DEF." },
        { id: "amp-sides", text: "Damage Amp counts from the attacker and Damage Reduction from the target, in one pot." },
        { id: "attack-type-bonus", text: "Basic attack, skill and Ultimate damage bonuses are their own multiplier." },
        { id: "vs-break", text: "Bonus damage against a target in BREAK (e.g. Ironclad Armament) is its own multiplier." },
        { id: "inspiration", text: "Sparkelf's Inspiration: the text says +15–18% team Fire damage, but the game data gives +30% Fire Elemental Boost. Test which one shows up in a hit." },
        { id: "whole-team", text: "Whole-team buffs such as Zephyr's Breath and Inspiration reach every Aniimo on the team, including ones not currently out. Read from the skill texts; the game code for it isn't in the client." },
        { id: "level-gap", text: "Which side of the level-gap table applies to whom. The world scales with your level, so this matters in most fights." },
      ],
    },
    {
      id: "cp",
      title: "CP",
      basis: "exact",
      paragraphs: [
        "CP comes from the Aniimo's listed species values, not its current stats: HP + 2 × ATK + P.DEF + M.DEF + REGEN + BREAK. ATK counts double.",
        "That total is multiplied by a level factor (6 × level + 35, up to level 80) and by 0.005. An upgraded Core skill adds 5% to that part, and potential adds a little more.",
        "On top come: +20 for an upgraded Core skill, your held item's CP (its base CP plus a fixed amount per item level), 30% of your potential CP, resonance CP, and +5 for each extra form or rainbow form of that Aniimo you've collected.",
        "Potential CP is 6 per potential level in each stat, counted twice in the stats the game recommends for that Aniimo.",
      ],
    },
  ]);

  // "i" notes, keyed by skill id or trait id; `forms` limits a note to the forms it is about when a
  // skill id is shared (Shelly and Sherro both have Torrent Slam).
  const EXPLANATIONS = Object.freeze([
    { kind: "skill", id: 11200021, forms: [1003100, 1003101, 1003103], basis: "exact",
      text: "Wisptis's Darkblade gives +15% basic attack damage, not the 40% in the text. Ignitis's version gives the 40%." },
    { kind: "skill", id: 10300090, forms: [1019100], basis: "exact",
      text: "Shelly's puddle bonus is +15% Water Elemental Boost for 10s, not Damage Amp for 20s as the text says. It stacks with Damage Amp instead of sharing a pot with it." },
    { kind: "skill", id: 10400270, basis: "exact",
      text: "Besides the extra damage near water, Thunder Slam also gives Sherro +15% Damage Amp for 20s." },
    { kind: "skill", id: 10900480, basis: "exact",
      text: "Weakness Mark also lowers the marked target's own damage by 5%, on top of cutting its crit resistance." },
    { kind: "trait", id: 10252, basis: "text",
      text: "The +30% is Damage Amp, so it shares a pot with your other Damage Amp. It only counts against targets with more than 5 Fire Debuff stacks." },
    { kind: "skill", id: 10600080, basis: "exact",
      text: "Plant Charge also applies a few hidden effects in the game's data that only change damage in PvP. The text doesn't mention them." },
    { kind: "skill", id: 11200202, basis: "by-name",
      text: "\"BREAK damage taken +15%\" is a debuff on the target. It adds to your own BREAK Efficiency rather than multiplying with it." },
    { kind: "trait", id: 126301, basis: "text",
      text: "Nightmare's Dark resistance cut lands on the target, so every Dark-type teammate's hits on it get stronger." },
    { kind: "skill", id: 10900260, basis: "exact",
      text: "Without Shrouded in Mist, only Turbo gets the boost (+15% damage and BREAK Efficiency). With it, teammates get +30%." },
    { kind: "trait", id: 10503, basis: "exact",
      text: "Counter Boost: +25% only when your element counters the target's overall. It does nothing in a neutral or mixed matchup." },
    { kind: "skill", id: 10600900, basis: "exact",
      text: "Two different effects. The Grass resistance cut goes on the target (Grass Elemental pot). The +15% for your Grass-types (while Glameep has Energy Full) is Damage Amp on your team. Different pots, so they multiply." },
    { kind: "trait", id: 13611, basis: "by-name",
      text: "Solar Grace raises Final Damage, a separate pot from Damage Amp, so it multiplies on top of your Damage Amp buffs." },
  ]);

  function explanationFor(kind, id, formId) {
    return EXPLANATIONS.find((note) => note.kind === kind && note.id === Number(id)
      && (!note.forms || note.forms.includes(Number(formId)))) || null;
  }

  window.AniilogsGuide = Object.freeze({ title: TITLE, sections: SECTIONS, explanations: EXPLANATIONS, explanationFor });
})();
