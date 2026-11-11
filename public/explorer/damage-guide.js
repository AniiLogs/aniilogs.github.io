// game-audit: 1.1.3857679 2026-11-03 every section, table, example and i-note (claim-by-claim list kept with the owner's private notes)
// The Try-Hard Guide's text and the "i" notes for skills and traits whose game text leaves something
// out. Plain-text paragraphs (no HTML); the page renders them. Each section says how sure it is:
// exact (read from the game's scripts or tables), by-name (matched to a game attribute by its name),
// inferred (a reasoned reading), text (from the game's own skill text, not its effect data). A section
// may carry `tests`: [{ id, text }] for things to check in the game before they can be trusted. Numbers come
// from build 3846247, re-checked against game 1.1 (build 3857679); see damage-model.js for the maths.
(() => {
  const TITLE = "Try-Hard Guide";

  const SECTIONS = Object.freeze([
    {
      id: "formula",
      title: "How a hit's damage is worked out",
      basis: "exact",
      paragraphs: [
        "Every hit starts from your ATK minus the target's defence, times the skill's Might divided by 10. A Might 30 skill hits for 3 × (ATK − DEF). Which ATK counts depends on your Aniimo's role: see the next section.",
        "That base never drops below 10% of your ATK, so even a very tanky target takes something.",
        "The base is then multiplied by a row of separate boosts: the element matchup, a ×1.1 bonus when the skill's element is one of your Aniimo's own, Elemental Boost, crits, Damage Amp and Final Damage.",
        "Physical skills hit against P.DEF and Magical skills against M.DEF. This part is inferred: the game's server picks which defence it passes in, but the stat names and skill categories line up.",
        "The formula also has flat terms: a flat amount added to the base before the boosts, and one added after them, minus the target's flat damage reduction. Only a few skills set them, and the site's calculators leave them out.",
        "In Egg Heist the game's server passes one more multiplier into every hit, at the very end (BREAK damage takes its square root). Its value isn't in the client files, so the site leaves it out.",
      ],
    },
    {
      id: "role-atk",
      title: "ATK by role",
      basis: "inferred",
      paragraphs: [
        "Since game 1.1 the ATK a hit uses depends on the Aniimo's role. The game's role-trait tooltips say so: BREAK Aniimo read \"When ATK is low, ATK and BREAK both affect damage within a certain range.\" Support, REGEN and Heal Aniimo read the same with \"ATK and level\". DPS Aniimo have no trait.",
        "DPS: your ATK.",
        "BREAK: ATK + 0.42 × (BREAK − half your ATK), counting BREAK only up to 2.2 × your ATK and never below your ATK (formula 3512). A BREAK Aniimo with ATK 350 and BREAK 491 hits as if it had ATK 483. The most it can reach is 1.714 × ATK.",
        "Support, REGEN and Heal: 7 × level (up to Lv 60) + 0.3 × ATK, when that is more than your ATK (formula 3513). At Lv 60 and above that is 420 + 0.3 × ATK, so it helps while ATK is under 600; at Lv 30 while ATK is under 300. A Lv 70 Heal Aniimo with ATK 335 hits as if it had ATK 521.",
        "Both formulas are read from the game's files. Which role uses which is matched from the tooltips (they name exactly those formulas' inputs), and the \"when that is more\" for Support, REGEN and Heal is read from \"When ATK is low\": the game's server applies them, so the client files don't show the call. In 1.0 every Aniimo instead used the higher of ATK and 0.825 × BREAK.",
      ],
    },
    {
      id: "stacking",
      title: "What stacks with what",
      basis: "exact",
      paragraphs: [
        "Many buffs with a range in their text (for example Waltz's 28–49% Crit Damage) grow with the caster's own stat. For most, the game works out base × (0.8 + stat × rate), capped at 1.4 (or at 1.2 for some; a few start at 1.0 instead of 0.8). The low end is at 0 of that stat, the top at the cap, so a higher-ATK caster gives a bigger buff.",
        "Boosts of the same kind add together. Different kinds multiply. Two +15% Damage Amp buffs give +30%, not +32%. A +15% Damage Amp and a +15% Elemental Boost give ×1.15 × 1.15 = +32%.",
        "So spreading your team's boosts over different kinds beats piling up one kind. Each kind is strongest while it is still empty.",
        "Damage Amp, Damage Boost and \"DMG +x%\" are all the same stat in the game, so they share one pot. The target's Damage Reduction comes out of that same pot. The Damage Amp and Final Damage pots each have a floor of ×0.2, so reductions can never cut those below a fifth. The elemental pot has no floor: at 0 or less the hit does nothing.",
        "Final Damage (for example Helion's Solar Grace) is a separate pot from Damage Amp, so it multiplies on top.",
        "In PvP every hit is scaled to 15%. PvP-only boosts and reductions are one more pot with a floor of ×0.2 (matched to the game's PvP stats by name). BREAK damage isn't touched by either.",
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
        "Because damage comes from ATK minus the target's DEF, extra ATK is worth more than its own percentage. For a DPS Aniimo the gain from extra ATK is ΔATK ÷ (ATK − DEF): the closer your ATK is to the target's DEF, the bigger each point's effect.",
        "Other roles hit with their role's ATK (see ATK by role), so a point of ATK counts differently. The gain is (points × rate) ÷ (role ATK − DEF). BREAK: rate 0.79 while BREAK is between half and 2.2 × ATK (each BREAK point then adds 0.42), 1.714 once BREAK is above 2.2 × ATK, 1 when BREAK is under half of ATK. Support, REGEN and Heal: rate 0.3 while the level part is the higher (ATK under 10 × level, up to Lv 60), 1 above it.",
        "Against no defence, +39% ATK is +39% damage. Against a same-level target it is about +76%. Against a very tanky target that was holding you at the 10% floor, it can be several times your damage.",
        "Compare a +15% Damage Amp buff: at most +15%, and less if your team already has Damage Amp. Damage Amp doesn't care about the target's DEF. ATK potential matters most against tanky targets.",
        "Example: Flameruff, a DPS (ATK 111, P.DEF 72 species values), hitting another Flameruff with no P.DEF potential, per 10 Might.",
      ],
      table: {
        columns: ["ATK potential", "Lv 50: ATK / damage", "Lv 67: ATK / damage", "Lv 70: ATK / damage"],
        rows: [
          ["0", "309 / 159", "413 / 212", "437 / 225"],
          ["4", "332 / 182", "445 / 244", "470 / 258"],
          ["8", "356 / 206", "476 / 275", "503 / 291"],
          ["12", "380 / 230", "508 / 307", "537 / 325"],
          ["16", "405 / 255", "541 / 340", "572 / 360"],
          ["20", "431 / 281 (+77%)", "575 / 374 (+76%)", "609 / 397 (+76%)"],
        ],
      },
      note: "Target P.DEF: 150 at Lv 50, 201 at Lv 67, 212 at Lv 70. Before personality, held items and other bonuses. Unconfirmed: the game's data gives Flameruff a +10 P.DEF species bonus that may apply to wild ones. Then the target's P.DEF is 171, 229 and 242, each row deals about 21–30 less, and 20 points give about +88% instead of +76%.",
    },
    {
      id: "elements",
      title: "Elements",
      basis: "exact",
      paragraphs: [
        "A countering element deals ×1.6, a resisted one ×0.625. Against two elements the two values multiply: 1.6 × 1.6 = ×2.56, 1.6 × 0.625 = ×1.",
        "Counter Boost (for example Scorching Flames) multiplies your damage only when the matchup is in your favour overall. Resistance Boost divides it only when the matchup is against you. A mixed matchup (one countered, one resisted) counts as neutral, so neither applies.",
        "Elemental Boost and the target's resistance to that element share one pot. If that pot reaches 0 or less, the hit does no damage at all.",
        "An elemental shield seems to replace the target's own elements while it is up. This hasn't been checked in the game.",
      ],
    },
    {
      id: "crit",
      title: "Crits",
      basis: "exact",
      paragraphs: [
        "Every Aniimo starts with 10% Crit Rate and +50% Crit Damage.",
        "Crit Rate adds up from all sources, including bonuses for basic attacks, skills or Ultimates, minus the target's crit resistance, including its resistance to that type of attack. At 100% or more every hit crits.",
        "The crit is rolled for each hit on its own, so a 3-hit skill can crit on some hits and not others.",
        "A crit multiplies the hit by 1 + Crit Damage, capped at ×3 in total. Crit Damage adds up and subtracts the same way as Crit Rate.",
        "Crit Rate over 100% is normally wasted. A few skills turn the part over 100% into extra Crit Damage, at their own rate.",
        "A few Crit Rate and Crit Damage bonuses only count while the target is in BREAK (matched by name).",
      ],
    },
    {
      id: "break",
      title: "BREAK",
      basis: "exact",
      paragraphs: [
        "The BREAK bar over a target is its BREAK points. Every hit takes BREAK damage off it, and at zero the target is in BREAK. Pets stay in BREAK for 6s.",
        "BREAK damage uses your BREAK stat: (your BREAK − the target's BREAK defence) × the hit's share × the skill's Might ÷ 10. Some skills add their own BREAK multiplier; most don't. It can crit like normal damage (up to ×3). A countering element raises it (×1.6, and Counter Boost on top), but a bad element matchup never lowers it. Elemental Boost, minus the target's resistance to that element, counts as it does for a hit's damage. Damage Amp, Final Damage and the same-element bonus don't affect it. BREAK Efficiency and \"BREAK damage taken\" on the target do.",
        "A pet's BREAK bar grows with its level: about 27,900 at Lv 50 and 52,800 at Lv 70 (formula 3110). Pets have no BREAK defence of their own. So against a pet, hits to BREAK ≈ its BREAK bar ÷ your BREAK damage per hit.",
        "Example: a Lv 50 Flameruff with 20 BREAK potential has BREAK 209. Fire Kick (Might 72) deals about 209 × 7.2 ≈ 1,500 BREAK damage, so about 19 Fire Kicks to BREAK a Lv 50 pet without any BREAK Efficiency.",
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
        "Toughness drain from that row is exact. With the target 5 to 15 levels above you, your hits drain ×0.5 toughness; 16 to 19 above, ×0.2; 20 or more above, ×0.1. Being above the target doesn't raise it.",
        "The damage part has four columns, picked on the game's server by who is fighting whom, and all of them favour the higher level: at 10 levels in your favour ×1.10–1.35, at 10 against ×0.5–0.9. Which applies to you isn't in the client files, so the 1v1 tab leaves it out.",
        "BREAK damage changes by the square root of that same factor, so a level gap moves it less than a hit's damage, but it isn't immune.",
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
        "Potential per stat has three sources. Your own points, rolled at capture plus Capability Awakening, go up to 20. Star-Up adds extra potential to every stat on top of that cap: +1 at stage 5, +2 at stage 6, +4 at stage 7. Some Epic and Legendary held items add +2 to one stat once the item reaches level 10. Stats use the total; CP counts only your own points.",
        "Star-Up also adds flat HP, ATK, P.DEF, M.DEF, REGEN and BREAK (added before the % bonuses), +2% to each stat from stage 2 or 3 on, and Counter Boost from stage 4.",
        "The card shows each stat rounded up. With a Perfect Aniimo's species points, the calculator matched a real Lv 65 Fulmintis card exactly on HP, P.DEF, M.DEF and REGEN.",
        "From Lv 61 to 70 HP, ATK, P.DEF and M.DEF grow faster than before (formulas 3003, 3004 and 3007 add extra levels for pets); REGEN and BREAK don't.",
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
        "Settled by the game's own formulas and data, no test needed: BREAK Efficiency and BREAK damage taken share one pot. Damage Amp and Damage Reduction share one pot. Bonus damage against a target in BREAK is its own multiplier. Sparkelf's Inspiration is 15–18% Fire Elemental Boost, growing with its ATK up to 800 (upgraded, 12–21%). Hummin's Energized is +2.5% BREAK Efficiency per 1,000 max HP, which its text shows rounded down to 2%.",
      ],
      tests: [
        { id: "break-hits", text: "Hits to BREAK a pet. The BREAK bar is BREAK points (read from the game's UI code), and BREAK damage uses your BREAK stat and the skill's Might. Test: count the Fire Kicks a Lv 50 Flameruff with 20 BREAK potential needs to BREAK a Lv 50 pet (about 19 expected, roughly 17–19 with crits, with no BREAK Efficiency, on a target Fire doesn't counter, with no dodge procs). Note both levels and what you fought." },
        { id: "magic-defence", text: "Magical skills hit against M.DEF and Physical skills against P.DEF. The game's stat text says so; the server picks the defence used. Test: hit the same target with a Physical and a Magical skill of similar Might, and compare against its P.DEF and M.DEF." },
        { id: "attack-type-bonus", text: "Basic attack, skill and Ultimate damage bonuses are their own multiplier." },
        { id: "whole-team", text: "Whole-team buffs such as Zephyr's Breath and Inspiration: the game holds these on the player and shows them on whichever Aniimo is out. Whether a switched-in Aniimo's hits get stronger is still to confirm. Test: cast one, switch, compare one hit." },
        { id: "role-atk", text: "ATK by role. Test: a Lv 70 Heal, Support or REGEN Aniimo with ATK well under 600 should hit a target for about (420 + 0.3 × ATK − DEF) × Might ÷ 10, not (ATK − DEF) × Might ÷ 10; one with ATK above 600 should hit with its own ATK. A BREAK Aniimo should hit for (ATK + 0.42 × (BREAK − ATK ÷ 2) − DEF) × Might ÷ 10." },
        { id: "level-gap", text: "Which column of the level-gap table applies. Test: hit a target at your level and one 10 levels above with the same skill; the ratio (0.7, 0.5 or 0.9) names the column." },
        { id: "wild-species-bonus", text: "Whether a wild Flameruff gets the +10 P.DEF species bonus (P.DEF 171 at Lv 50 instead of 150). Test: hit a Lv 50 wild Flameruff with a known ATK and Might, and compare the number with both P.DEF values." },
        { id: "frenzied-assault", text: "Surging Wave's Frenzied Assault. Its text says +25% Water Elemental Boost, but the client's data reads a value its row doesn't have, so it comes out as +0%. Test: hit the same target with a Water skill before and during Frenzied Assault." },
        { id: "lightning-cross", text: "Lightning Cross. Its text says +50% CRIT Rate, but the data gives the caster +50% Skill Crit Damage while the skill hits. Test: count crits over many casts against a target with no crit resistance (about 10% expected without other Crit Rate), and compare the size of a crit with a non-crit." },
      ],
    },
    {
      id: "cp",
      title: "CP",
      basis: "exact",
      paragraphs: [
        "CP comes from the Aniimo's listed species values, not its current stats: HP + 2 × ATK + P.DEF + M.DEF + REGEN + BREAK. ATK counts double. When that total is exactly 654 the game takes 16 off.",
        "That total is multiplied by a level factor (6 × level + 35, up to level 80) and by 0.005. An enhanced Core skill adds 5% to that part, and potential adds a little more.",
        "On top come: +20 for an enhanced Core skill, your held item's CP (its base CP plus a fixed amount per item level), 30% of your potential CP, resonance CP, and +5 for each extra form or rainbow form of that Aniimo you've collected.",
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
      text: "Shelly's puddle bonus is +15% Water Elemental Boost, not Damage Amp as the text says. It stacks with Damage Amp instead of sharing a pot with it. The skill applies it for 10s, though the buff's own default is the text's 20s." },
    { kind: "skill", id: 10400270, basis: "exact",
      text: "Besides the extra damage near water, Thunder Slam also gives Sherro +15% Damage Amp for 20s." },
    { kind: "skill", id: 10900480, basis: "exact",
      text: "Once the skill is upgraded, Weakness Mark also lowers the marked target's own damage by 5%, on top of cutting its crit resistance." },
    { kind: "trait", id: 10252, basis: "by-name",
      text: "The game data makes the +30% Damage Amp, so it shares a pot with your other Damage Amp. That it only counts against targets with more than 5 Fire Debuff stacks comes from the text alone (unconfirmed)." },
    { kind: "skill", id: 10600080, basis: "exact",
      text: "Plant Charge also applies a few hidden effects in the game's data that only change damage in PvP. The text doesn't mention them." },
    { kind: "skill", id: 11200202, basis: "by-name",
      text: "\"BREAK damage taken +15%\" is a debuff on the target. It adds to your own BREAK Efficiency rather than multiplying with it." },
    { kind: "trait", id: 126301, basis: "exact",
      text: "Nightmare's Dark resistance cut lands on the target (the buff lowers the defender's Dark resistance), so every Dark-type teammate's hits on it get stronger." },
    { kind: "skill", id: 10900260, basis: "exact",
      text: "Without Shrouded in Mist, only Turbo gets the boost (+15% damage and BREAK Efficiency). With it, teammates get +30%." },
    { kind: "trait", id: 10503, basis: "exact",
      text: "Counter Boost: +25% only when your element counters the target's overall. It does nothing in a neutral or mixed matchup." },
    { kind: "skill", id: 10600900, basis: "exact",
      text: "Two different effects. The Grass resistance cut goes on the target (Grass Elemental pot). The +15% for your Grass-types (while Glameep has Energy Full) is Damage Amp on your team. Different pots, so they multiply." },
    { kind: "trait", id: 120101, basis: "exact",
      text: "The game data gives +2.5% BREAK Efficiency per 1,000 max HP, not the 2% in the text." },
    { kind: "skill", id: 10900170, basis: "by-name",
      text: "Truce's 35% is Final Damage reduction, a separate pot from normal Damage Reduction. It multiplies with other reductions instead of adding to them." },
    { kind: "skill", id: 10400140, basis: "exact",
      text: "The 28–49% and 16–28% grow with Luminelle's ATK: the low end at 0 ATK, +2.6% / +1.5% per 100 ATK, the top at 800 ATK." },
    { kind: "trait", id: 13611, basis: "by-name",
      text: "Solar Grace raises Final Damage, a separate pot from Damage Amp, so it multiplies on top of your Damage Amp buffs." },
    { kind: "skill", id: 10400211, basis: "exact",
      text: "The game data gives +50% Skill Crit Damage while this skill hits, not the +50% CRIT Rate in the text. So it makes crits bigger, not more frequent. Unconfirmed until tested in the game." },
    { kind: "trait", id: 139301, basis: "exact",
      text: "Frenzied Assault's +25% Water Elemental Boost isn't in the client's data: the buff reads a value its row doesn't have, so it comes out as +0%. The game's server may still apply it. Unconfirmed until tested in the game." },
  ]);

  function explanationFor(kind, id, formId) {
    return EXPLANATIONS.find((note) => note.kind === kind && note.id === Number(id)
      && (!note.forms || note.forms.includes(Number(formId)))) || null;
  }

  window.AniilogsGuide = Object.freeze({ title: TITLE, sections: SECTIONS, explanations: EXPLANATIONS, explanationFor });

  // The Guides page (/guides/) lists every guide registered here; this one is "damage".
  window.AniilogsGuides = window.AniilogsGuides || [];
  window.AniilogsGuides.push(Object.freeze({
    id: "damage",
    title: "How damage works",
    summary: "What each kind of boost does, what stacks with what, and where your next point of ATK or potential does the most.",
    intro: "How damage works in Aniimo, in plain words: what each kind of boost does, what stacks with what, and where your next point of ATK or potential does the most. Each section says how sure it is.",
    sections: SECTIONS,
  }));
})();
