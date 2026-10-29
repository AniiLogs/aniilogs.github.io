// Damage and stat model from the game's own scripts (build 3846247). Pure functions for the 1v1 tab,
// the Guide and the Team Builder Stats tab; no DOM. Every rule says where it comes from:
//   exact   - read from the game's bytecode or tables;
//   by-name - the formula input is matched to a game attribute by its name (the code that passes it
//             in runs on the server, not in the client);
//   inferred - a reasoned reading; say so wherever it is shown.
// Sources: Data/formula_data.lua formulas 3001 (HP damage), 3023 (BREAK), 3003-3018 (base stats);
// Common/Ability/CombatActionTool.lua (crit, element matchup, elemental damage); AttributeCalcUtils
// (stat = value x (1 + percent) + flat); PetAttributeCalcUtils (what a pet's stats add up from).
(() => {
  const STATS = Object.freeze(["HP", "ATK", "P.DEF", "REGEN", "M.DEF", "BREAK"]);
  // Older Aniilog files label the base stats differently.
  const STAT_ALIASES = Object.freeze({
    Attack: "ATK", Defense: "P.DEF", "Magic Defense": "M.DEF", "EP Regen": "REGEN", Break: "BREAK",
  });
  // Stat -> its percent and flat attribute keys (attribute_group_data 201-206 / 235 and AttributeConst).
  const STAT_KEYS = Object.freeze({
    HP: { p: "hp_max_p", fix: "hp_max_fix" },
    ATK: { p: "atk_p", fix: "atk_fix" },
    "P.DEF": { p: "def_p", fix: "def_fix" },
    REGEN: { p: "ep_regen_force_p", fix: "ep_regen_force_fix" },
    "M.DEF": { p: "def_mag_p", fix: "def_mag_fix" },
    BREAK: { p: "bp_atk_p", fix: "bp_atk_fix" },
  });

  // Which damage term an attribute feeds, whose value counts (the attacker's or the defender's) and how
  // sure that is. Values in one bracket add together; brackets multiply.
  const BRACKETS = Object.freeze({
    taken_dmg_inc_rate_v: { bracket: "amp", side: "attacker", basis: "by-name" },
    taken_dmg_dec_rate_v: { bracket: "amp", side: "defender", basis: "by-name" },
    final_taken_dmg_inc_rate_v: { bracket: "final", side: "attacker", basis: "by-name" },
    final_taken_dmg_dec_rate_v: { bracket: "final", side: "defender", basis: "by-name" },
    element_restraint_add_ratio: { bracket: "counter", side: "attacker", basis: "exact" },
    element_resist_add_ratio: { bracket: "resist", side: "defender", basis: "exact" },
    crit_rate_v: { bracket: "crit_rate", side: "attacker", basis: "exact" },
    crit_rate_dec_v: { bracket: "crit_rate", side: "defender", basis: "exact" },
    normal_attack_crit_inc_rate_v: { bracket: "crit_rate", side: "attacker", basis: "exact", only: "basic" },
    skill_crit_inc_rate_v: { bracket: "crit_rate", side: "attacker", basis: "exact", only: "skill" },
    ultimate_crit_inc_rate_v: { bracket: "crit_rate", side: "attacker", basis: "exact", only: "ultimate" },
    crit_dmg_v: { bracket: "crit_damage", side: "attacker", basis: "exact" },
    crit_dmg_rate_dec_v: { bracket: "crit_damage", side: "defender", basis: "exact" },
    normal_attack_crit_dmg_inc_rate_v: { bracket: "crit_damage", side: "attacker", basis: "exact", only: "basic" },
    skill_crit_dmg_v: { bracket: "crit_damage", side: "attacker", basis: "exact", only: "skill" },
    ultimate_crit_dmg_v: { bracket: "crit_damage", side: "attacker", basis: "exact", only: "ultimate" },
    taken_normal_attack_dmg_inc_rate_v: { bracket: "type", side: "attacker", basis: "inferred", only: "basic" },
    taken_skill_dmg_inc_rate_v: { bracket: "type", side: "attacker", basis: "inferred", only: "skill" },
    taken_ultimate_dmg_inc_rate_v: { bracket: "type", side: "attacker", basis: "inferred", only: "ultimate" },
    taken_normal_attack_dmg_dec_rate_v: { bracket: "type", side: "defender", basis: "inferred", only: "basic" },
    taken_phy_dmg_inc_rate_v: { bracket: "type", side: "attacker", basis: "inferred", only: "Physical" },
    dmg_break_add_ratio: { bracket: "vs_break", side: "attacker", basis: "inferred" },
    bp_add_ratio: { bracket: "break", side: "attacker", basis: "by-name" },
    skill_bp_add_ratio: { bracket: "break", side: "attacker", basis: "by-name", only: "skill" },
    bp_reduce_rate_v: { bracket: "break", side: "defender", basis: "by-name" },
    pvp_taken_dmg_inc_rate_v: { bracket: "pvp", side: "attacker", basis: "by-name" },
  });
  const ELEMENT_KEY = /^dmg_([a-z]+)_(add|dec)_ratio$/u;
  const STAT_KEY_BY_ATTR = Object.freeze(Object.fromEntries(Object.entries(STAT_KEYS)
    .flatMap(([stat, keys]) => [[keys.p, { stat, part: "p" }], [keys.fix, { stat, part: "fix" }]])));

  function bracketOf(key) {
    if (BRACKETS[key]) return BRACKETS[key];
    const element = ELEMENT_KEY.exec(key);
    if (element) return { bracket: "element", side: element[2] === "add" ? "attacker" : "defender", basis: "exact", element: element[1] };
    if (STAT_KEY_BY_ATTR[key]) return { bracket: "stat", side: "holder", basis: "exact", ...STAT_KEY_BY_ATTR[key] };
    return null;
  }

  // --- Stats ------------------------------------------------------------------------------------

  function statRows(entry) {
    return Object.fromEntries((entry?.stats || [])
      .map((row) => [STAT_ALIASES[row.label] || row.label, Number(row.value)])
      .filter(([label]) => STATS.includes(label)));
  }

  // Formulas 3003/3004/3007/3008/3018 through Utils.PropertyRefreshTotal (exact): the stat's base value.
  function baseValue(growth, stat, species, level, potential) {
    const formula = growth?.stats?.[stat] || growth?.stats?.[Object.keys(STAT_ALIASES).find((old) => STAT_ALIASES[old] === stat)];
    if (!formula || !Number.isFinite(species)) return null;
    const lv = growth.level_value;
    const steps = Math.min(Math.max(level - lv.extra_from_level, 0), lv.extra_levels);
    const extra = formula.extra ? lv.extra_weight * (steps * (20 + 3 * steps) / 50) : 0;
    const levelValue = lv.per_level * level + lv.base + extra;
    return Math.floor((species + formula.offset) * (1 + growth.attribute_point_bonus * potential) / formula.divisor
      * levelValue * formula.scale);
  }

  // A pet's six stats the way PetAttributeCalcUtils adds them up: base value (species points, level,
  // potential) x (1 + every percent bonus) + flat bonuses. Percent bonuses: potential (+4% per 4 levels,
  // pet_attr_convert_data), personality traits, held items (x (1 + the item level's enhance ratio)).
  // Species points: the game uses a pet's own species points when the server sends them
  // (Utils.getBasePropertySpeciesPoint); otherwise pet_data's plus the property template's bonus. The
  // site has no owned pets, so pet_data's are the default (as on the Aniimo page) and useTemplate adds
  // the template bonus. Not modelled: held-item talents and energy effects,
  // resonance and collection bonuses.
  // options: { level, potential: number | {stat: n}, personality: [letter], heldItems: [{ itemId, level }],
  //            species: {stat: points}, useTemplate, extra: [{ key, value, source }],
  //            coreUpgraded, formsCollected, rainbowForms, resonanceCp }  (the last four only feed CP)
  function statTotals(data, aniilog, formId, options = {}) {
    const entry = aniilog?.entries?.find((row) => String(row.form_id) === String(formId));
    const form = data?.forms?.[formId];
    const growth = aniilog?.stat_growth;
    if (!entry || !form || !growth) return null;
    const level = Math.min(Math.max(Math.round(Number(options.level) || growth.level_cap), 1), growth.level_cap);
    const potentialOf = (stat) => Math.min(Math.max(Math.round(Number(typeof options.potential === "object"
      ? options.potential?.[stat] : options.potential) || 0), 0), growth.attribute_points_max);
    const species = statRows(entry);
    const template = options.useTemplate ? form.stat_template?.species_bonus || {} : {};
    const bonus = Object.fromEntries(STATS.map((stat) => [stat, { p: 0, fix: 0, sources: [] }]));
    const add = (key, value, source) => {
      const target = STAT_KEY_BY_ATTR[key];
      if (!target || !Number.isFinite(value)) return;
      bonus[target.stat][target.part] += value;
      bonus[target.stat].sources.push({ source, key, value });
    };
    const traits = data.personality?.traits || [];
    (options.personality || []).forEach((letter) => {
      const trait = traits.find((row) => row.letter === letter);
      trait?.stats.forEach((stat) => stat.keys.forEach((key) => add(key, stat.value, `Personality: ${trait.name}`)));
    });
    (options.heldItems || []).forEach(({ itemId, level: itemLevel }) => {
      const tier = Object.values(data.forms).flatMap((row) => row.recommended?.held_items || [])
        .flatMap((item) => item.tiers.map((t) => ({ ...t, name: item.name }))).find((t) => String(t.item_id) === String(itemId));
      const ratio = data.held_item_levels?.[itemLevel]?.enhance_ratio || 0;
      tier?.stats.forEach((stat) => stat.keys.forEach((key) => add(key, stat.value * (1 + ratio), `Held item: ${tier.name}`)));
    });
    (options.extra || []).forEach(({ key, value, source }) => add(key, value, source || "Other"));
    const result = { level, base: {}, total: {}, bonus, template_species: template, potential: {} };
    STATS.forEach((stat) => {
      const points = Number.isFinite(options.species?.[stat]) ? options.species[stat] : (species[stat] ?? NaN) + (template[stat] || 0);
      const potential = potentialOf(stat);
      result.potential[stat] = potential;
      const base = baseValue(growth, stat, points, level, potential);
      const step = growth.potentials?.percent_steps?.[stat] || growth.potentials?.percent_steps?.[Object.keys(STAT_ALIASES).find((old) => STAT_ALIASES[old] === stat)];
      const potentialPercent = step ? Math.floor(potential / step.every) * step.percent : 0;
      result.base[stat] = base;
      // Shown rounded down (inferred: the game's display rounding is not in the client scripts).
      result.total[stat] = base === null ? null
        : Math.floor(base * (1 + potentialPercent + bonus[stat].p) + bonus[stat].fix);
    });
    result.cp = combatPower(data, form, species, level, result.potential, options);
    return result;
  }

  // CP (exact): Utils.getCpValue with formula 3100 (PetConfigData.cpFormulaId), rounded down.
  //   round(0.005 x (6 x min(80, level) + 35) x species x (1 + 0.05 core) x (1 + 0.00055 x potentialCp))
  //   + 20 core + held-item CP + 0.3 x potentialCp + resonance CP + 5 x (forms collected - 1 + rainbow forms)
  // species = HP + 2 x ATK + P.DEF + M.DEF + REGEN + BREAK from pet_data (the game subtracts 16 when that
  // sum is exactly 654); potentialCp = each stat's potential CP (pet_prop_level_data), x2 on the stats
  // the game recommends; held-item CP = cp + cp1 x item level (CoreCarryInfo.getCpValue).
  function combatPower(data, form, species, level, potential, options = {}) {
    if (STATS.some((stat) => !Number.isFinite(species[stat]))) return null;
    let speciesTotal = species.HP + 2 * species.ATK + species["P.DEF"] + species["M.DEF"] + species.REGEN + species.BREAK;
    if (speciesTotal === 654) speciesTotal -= 16;
    const recommended = new Set(form.stat_template?.recommended_stats || []);
    const potentialCp = STATS.reduce((sum, stat) => {
      const row = data.potential_cp?.[potential[stat] || 0];
      return sum + (row ? row.cp * (recommended.has(stat) ? row.recommended_rate : 1) : 0);
    }, 0);
    const heldItemCp = (options.heldItems || []).reduce((sum, { itemId, level: itemLevel }) => {
      const tier = Object.values(data.forms).flatMap((row) => row.recommended?.held_items || [])
        .flatMap((item) => item.tiers).find((t) => String(t.item_id) === String(itemId));
      return sum + (tier ? tier.cp + tier.cp_per_level * (Number(itemLevel) || 0) : 0);
    }, 0);
    const core = options.coreUpgraded ? 1 : 0;
    const calcLevel = Math.min(80, Math.max(1, level));
    const base = Math.round((6 * calcLevel + 35) * speciesTotal * (1 + 0.05 * core) * (1 + 0.00055 * potentialCp) * 0.005);
    const total = base + 20 * core + heldItemCp + 0.3 * potentialCp + (Number(options.resonanceCp) || 0)
      + 5 * ((Number(options.formsCollected) || 1) - 1 + (Number(options.rainbowForms) || 0));
    return Math.floor(Math.max(total, 1));
  }

  // --- Damage -----------------------------------------------------------------------------------

  // Defending elements multiply (exact, CombatActionTool 1288-1301). Net advantage x (1 + attacker's
  // Counter Boost); net disadvantage / (1 + defender's Resistance Boost); mixed counts as neutral.
  function elementMatchup(elements, attackElement, defendElements, counterBoost = 0, resistBoost = 0) {
    let factor = 1;
    let side = 1;
    for (const defender of defendElements || []) {
      const value = Number(elements?.[attackElement]?.against?.[defender]);
      if (!Number.isFinite(value)) continue;
      factor *= value;
      side *= value > 1 ? 2 : value < 1 ? 0.5 : 1;
    }
    if (Math.abs(side - 1) < 1e-9) return { factor, kind: "neutral" };
    return side > 1
      ? { factor: factor * (1 + counterBoost), kind: "advantage" }
      : { factor: factor / (1 + resistBoost), kind: "disadvantage" };
  }

  // Sum a side's modifiers into the brackets, keeping only the ones that apply to this skill.
  function bracketTotals(modifiers, side, skill) {
    const totals = {};
    for (const [key, raw] of Object.entries(modifiers || {})) {
      const info = bracketOf(key);
      const value = Number(raw);
      if (!info || !Number.isFinite(value) || info.side !== side) continue;
      if (info.only && info.only !== skill.type && info.only !== skill.category) continue;
      if (info.bracket === "element" && info.element !== skill.elementKey) continue;
      totals[info.bracket] = (totals[info.bracket] || 0) + value;
    }
    return totals;
  }

  // One hit of a skill. attacker / defender: { atk, pdef, mdef, breakAtk, breakDef, elements: [id],
  // critRate, critDamage (totals, base included), modifiers: { attributeKey: value } }; skill: { might,
  // breakRate, element, category: "Physical" | "Magical", type: "basic" | "skill" | "ultimate", hitShare }.
  // might = ability_param_data.power. BREAK damage (formula 3023) also scales with `power`: its separate
  // bpPower and dmgPercent inputs have no effect (checked by running the formula). breakRate =
  // ability_param_data.bpRate (1 when unset, 0 = no BREAK). tpPower is only for toughness, see
  // toughnessDrain.
  // context: { elements (team_builder_data.elements), sameElementBonus, elementKeys, broken, pvp }.
  function hit(attacker, defender, skill, context = {}) {
    const elementKey = context.elementKeys?.[skill.element]?.add?.replace(ELEMENT_KEY, "$1") || null;
    const s = { ...skill, elementKey };
    const atk = bracketTotals(attacker.modifiers, "attacker", s);
    const def = bracketTotals(defender.modifiers, "defender", s);
    const steps = [];
    const step = (label, value, basis) => { steps.push({ label, value, basis }); return value; };

    // Physical hits face P.DEF, Magical hits M.DEF (inferred: the server picks the defence passed in).
    const defence = skill.category === "Magical" ? defender.mdef : defender.pdef;
    const share = Number(skill.hitShare ?? 1);
    let damage = step("Base: max(ATK - DEF, 10% of ATK) x Might / 10",
      Math.max(attacker.atk - defence, 0.1 * attacker.atk) * (share * Number(skill.might || 0) / 10), "exact");
    const matchup = elementMatchup(context.elements, skill.element, defender.elements, atk.counter || 0, def.resist || 0);
    damage *= step(`Element matchup (${matchup.kind})`, matchup.factor, "exact");
    const same = (attacker.elements || []).map(String).includes(String(skill.element)) ? 1 + (context.sameElementBonus ?? 0.1) : 1;
    damage *= step("Same element as the Aniimo", same, "exact");
    const elementalDamage = 1 + (atk.element || 0) - (def.element || 0);
    if (elementalDamage <= 0) return { hit: 0, crit: 0, average: 0, break: 0, steps, ignored: "elemental damage at or below 0" };
    damage *= step("Elemental Boost - target's Elemental Resistance", elementalDamage, "exact");
    damage *= step("Basic / skill / Ultimate damage", 1 + (atk.type || 0) - (def.type || 0), "inferred");
    damage *= step("Damage Amp - target's Damage Reduction (min 0.2)", Math.max(0.2, 1 + (atk.amp || 0) - (def.amp || 0)), "by-name");
    if (context.broken) damage *= step("Damage to a BREAKed target", 1 + (atk.vs_break || 0), "inferred");
    damage *= step("Final damage (min 0.2)", Math.max(0.2, 1 + (atk.final || 0) - (def.final || 0)), "by-name");
    if (context.pvp) damage *= step("PvP", 0.15, "exact");
    damage = Math.max(damage, 0);

    // Crit (exact, CombatActionTool 1098-1137): rate from both sides; x(1 + crit damage), capped at 3x.
    const rate = Math.max(0, (attacker.critRate ?? 0.1) + (atk.crit_rate || 0) - (def.crit_rate || 0));
    const multiplier = Math.min(3, Math.max(1, 1 + (attacker.critDamage ?? 0.5) + (atk.crit_damage || 0) - (def.crit_damage || 0)));
    const chance = Math.min(1, rate);

    // BREAK damage (formula 3023, exact): (BREAK - target's BREAK DEF) x hit share x Might / 10 x bpRate
    // x efficiency pot (min 0.2) x max(1, matchup) x crit x elemental pot. Damage Amp, Final Damage and the
    // same-element bonus don't touch it. Efficiency and BREAK damage taken share the pot (by-name).
    const breakHit = Math.max(0, ((attacker.breakAtk || 0) - (defender.breakDef || 0)) * (share * Number(skill.might || 0) / 10)
      * Number(skill.breakRate ?? 1) * Math.max(0.2, 1 + (atk.break || 0) + (def.break || 0)) * Math.max(1, matchup.factor) * elementalDamage);

    return {
      hit: damage,
      crit: damage * multiplier,
      average: damage * (1 + chance * (multiplier - 1)),
      critChance: chance,
      critMultiplier: multiplier,
      break: breakHit,
      breakCrit: breakHit * multiplier,
      steps,
    };
  }

  // Toughness ("tp") a hit takes off (exact, ActorAttributeModifier.processReduceCurTpRate):
  // hitShare x tpPower x level-gap tpDamFixRate x (1 + target's element tp-reduce attribute)
  // x attacker size TpPowerRate / target size TpResistRate (BodyShapeEffectData). Nothing while the
  // target is in BREAK, recovering from it or under super armour. Pets' toughness: tp_max_v (60).
  // Toughness is not the BREAK bar: the BREAK bar shows bp (Utils.getEntityBreakInfo -> curBp / maxBp,
  // TopLogoCombatComponent), which formula 3023 drains. Toughness rises while casting (inCastWeightValue)
  // and is blocked by super armour, so it reads as the stagger / interruption gauge (inferred).
  // options: { hitShare = 1, tpReduceAdd = 0, levelRate = 1, sizePowerRate = 1, sizeResistRate = 1 }
  function toughnessDrain(tpPower, options = {}) {
    const value = Number(options.hitShare ?? 1) * Number(tpPower || 0) * Number(options.levelRate ?? 1)
      * (1 + Number(options.tpReduceAdd || 0)) * Number(options.sizePowerRate ?? 1) / Number(options.sizeResistRate || 1);
    return Math.max(0, value);
  }

  // A pet's BREAK bar at a level (exact: formula 3110 run on property_data's template, staged as
  // data.pet_break_bar) and how many hits of a given BREAK damage empty it.
  function breakBar(data, level) {
    const bars = data?.pet_break_bar?.by_level || [];
    return bars[Math.min(Math.max(Math.round(Number(level) || 1), 1), bars.length) - 1] ?? null;
  }
  function hitsToBreak(data, level, breakPerHit) {
    const bar = breakBar(data, level);
    return bar && breakPerHit > 0 ? Math.ceil(bar / breakPerHit) : null;
  }

  // --- Buffs and debuffs a team can bring -------------------------------------------------------

  // Every damage-relevant effect the forms' skills, upgrades, Ultimates, traits and recommended held
  // items can apply. who: self / ally / enemy / player / active Aniimo (as traced); trait effects are
  // listed on self because trait logic is not in the tables.
  function options(data, formIds) {
    const rows = [];
    const seen = new Set();
    const push = (row) => {
      const key = `${row.form_id}|${row.source.kind}|${row.source.id}|${row.buff_id ?? ""}|${row.who}|${row.key}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };
    for (const formId of formIds || []) {
      const form = data?.forms?.[formId];
      if (!form) continue;
      const sources = [
        ...form.skills.map((skill) => [skill.type === "ultimate" ? "ultimate" : "skill", skill]),
        ...form.skills.filter((skill) => skill.upgrade).map((skill) => ["upgrade", skill.upgrade]),
        ...form.traits.map((trait) => ["trait", { id: trait.id, name: trait.name, mechanics: { buffs: trait.buffs.map((id) => ({ id, on: "self" })) } }]),
      ];
      for (const [kind, source] of sources) {
        for (const link of source.mechanics?.buffs || []) {
          const buff = data.buffs?.[link.id];
          for (const attribute of buff?.attributes || []) {
            const info = bracketOf(attribute.key);
            if (!info) continue;
            push({
              form_id: Number(formId), id: `${link.id}:${attribute.key}:${link.on}`, buff_id: Number(link.id), name: buff.name || null,
              source: { kind, id: Number(source.id) || null, name: source.name || null },
              // Whole-team buffs (addTeamBuff) are traced by name only, so they can't be surer than that.
              who: link.on, key: attribute.key, label: attribute.label, bracket: info.bracket,
              basis: link.basis === "by-name" && info.basis === "exact" ? "by-name" : info.basis,
              whole_team: Boolean(link.whole_team),
              values: attribute.values, stacks: Number(link.stacks || buff.max_layer || 1),
              duration: link.duration ?? buff.duration ?? null, requires: link.requires || null,
            });
          }
        }
      }
      for (const item of form.recommended?.held_items || []) {
        for (const tier of item.tiers) {
          for (const stat of tier.stats) {
            for (const key of stat.keys) {
              const info = bracketOf(key);
              if (!info) continue;
              push({
                form_id: Number(formId), id: `item:${tier.item_id}:${key}`, buff_id: null, name: item.name,
                source: { kind: "held item", id: tier.item_id, name: `${item.name} (${tier.quality_label || `quality ${tier.quality}`})` },
                who: "self", key, label: stat.label, bracket: info.bracket, basis: info.basis,
                values: [stat.value], stacks: 1, duration: null, requires: null, scales_with_item_level: true,
              });
            }
          }
        }
      }
    }
    return rows;
  }

  window.AniilogsDamage = Object.freeze({
    STATS, STAT_ALIASES, BRACKETS, bracketOf, baseValue, statTotals, combatPower, elementMatchup, hit, toughnessDrain, breakBar, hitsToBreak, options,
  });
})();
