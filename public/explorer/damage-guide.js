// The Try-Hard Guide's text and the "i" notes for skills and traits whose game text leaves something
// out. Plain-text paragraphs (no HTML); the page renders them. Each section says how sure it is:
// exact (read from the game's scripts or tables), by-name (matched to a game attribute by its name),
// inferred (a reasoned reading), text (from the game's own skill text, not its effect data). Numbers come
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
        "Damage Amp, Damage Boost and \"DMG +x%\" are all the same stat in the game, so they share one pot. The target's Damage Reduction comes out of that same pot. Each pot has a floor of ×0.2, so reductions can never cut a hit below a fifth.",
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
        "Each ATK potential point adds 0.8% to your ATK's formula value. Every 4 points also add a flat +4%. So 20 points give ×1.16 and then +20%, about +39% ATK.",
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
        "Every skill has its own BREAK power, separate from its Might. For example, Fire Bolt has Might 30 and BREAK power 10.",
        "Each hit lowers the target's toughness by its share of the skill's BREAK power. Elemental toughness bonuses on the target, attacker vs target body size and the level gap scale that amount. Pets start with 60 toughness. Hits do nothing to toughness while the target is in BREAK, recovering from it, or under super armour.",
        "Your BREAK stat feeds a separate BREAK damage formula: BREAK minus the target's BREAK resistance, times BREAK power ÷ 10, plus its own crit and element terms. A bad element matchup never lowers it.",
        "Which of the two actually triggers the BREAK state is decided on the game's server, so the site doesn't promise a \"hits to BREAK\" number yet.",
        "BREAK Efficiency on you and \"BREAK damage taken\" on the target add together (by name). Some effects add damage against a target already in BREAK, for example Pawney's Ironclad Armament +30% (inferred).",
      ],
    },
    {
      id: "level",
      title: "Level gap",
      basis: "by-name",
      paragraphs: [
        "The level difference between attacker and target changes damage through a table in the game data (calc_lv_modify_data). Which column applies to which side isn't in the client scripts, so the 1v1 tab leaves it out.",
      ],
    },
    {
      id: "stats",
      title: "What makes up an Aniimo's stats",
      basis: "exact",
      paragraphs: [
        "The six stats are HP, ATK, P.DEF, REGEN, M.DEF and BREAK. Magic Attack is gone from the game.",
        "Each stat is its base value × (1 + every % bonus) + flat bonuses. All % bonuses to a stat share one pot: potential, personality, held items.",
        "The base value comes from the Aniimo's species points, level and potential. The game can also give an owned Aniimo species points of its own, which replace the listed ones, so your card may not match the site's numbers exactly.",
        "Personality traits each give one bonus and one home bonus, for example Energetic: ATK +2%, BREAK +2%. Natures are flavour only.",
        "A held item's stat grows with its level: +5% of its base per level up to level 10, then +10% per level, doubling at level 15.",
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
      text: "Shelly's puddle bonus is +15% Water Elemental Boost, not Damage Amp as the text says. It stacks with Damage Amp instead of sharing a pot with it." },
    { kind: "skill", id: 10400270, basis: "exact",
      text: "Besides the extra damage near water, Thunder Slam also gives Sherro +15% Damage Amp for 20s." },
    { kind: "skill", id: 10900480, basis: "exact",
      text: "Weakness Mark also lowers the marked target's own damage by 5%, on top of cutting its crit resistance." },
    { kind: "trait", id: 10252, basis: "text",
      text: "The +30% is Damage Amp, so it shares a pot with your other Damage Amp. It only counts against targets with more than 5 Fire Debuff stacks." },
    { kind: "skill", id: 10600080, basis: "exact",
      text: "Plant Charge also applies a few hidden effects in the game's data that only change damage in PvP. The text doesn't mention them." },
    { kind: "skill", id: 11200202, basis: "exact",
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
