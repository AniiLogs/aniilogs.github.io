(() => {
  "use strict";

  // 1v1: what one Aniimo's attacks do to another, with the game's own damage formulas decoded from its scripts
  // (Data/formula_data.lua 3001 HP damage, 3023 BREAK damage; CombatActionTool's crit, element and same-element
  // rules). Stats come from the Aniilog's stat_growth, so they match the Aniimo page. Every number assumes the
  // attack lands: dodges, misses, positioning and buffs are not simulated.
  // Team Builder mounts it with render({ aniilog, data, members, memberStats, formLabel, contentUrl, developerMode, rerender }).
  const STORAGE_KEY = "aniilogs:duel:v1";
  const RULES = Object.freeze({
    critRate: 0.1, // property_data[pet_data.propId].crit_rate_v: 10% for every current form (PetAttributeCalcUtils)
    critDamage: 0.5, // crit_dmg_v: a crit deals 1 + 0.5 = 1.5x, capped at 3x
    critCap: 3,
    sameElement: 0.1, // ability_setting_global_const_data.sameElementDamageAddRatio
    minimumShare: 0.1, // damage is at least 10% of ATK before skill power, however high DEF is
    pvpFactor: 0.15, // formula 3001 pvpFactor when isPvp
    breakTime: 6, // property_data 1001 break_time (seconds)
    maxSeconds: 300,
  });
  // Attack and defence stat per skill category. The game no longer has a Magic Attack stat, so magic skills use ATK;
  // they are taken to hit M.DEF (the game splits P.DEF and M.DEF, but which one a hit uses is chosen in native code).
  const STAT_KEYS = Object.freeze({
    Physical: ["Attack", "Defense"],
    Magic: ["Attack", "Magic Defense"],
  });
  // The game’s six stats in its stat-card order, with its labels.
  const SHOWN_STATS = Object.freeze([
    ["HP", "HP"], ["Attack", "ATK"], ["Defense", "P.DEF"], ["EP Regen", "REGEN"], ["Magic Defense", "M.DEF"], ["Break", "BREAK"],
  ]);

  let settings = loadSettings();

  function loadSettings() {
    const defaults = {
      you: { formId: "", level: 70, potential: 0 },
      foe: { formId: "", level: 70, potential: 0 },
      startHp: 100,
      broken: false,
      brokenBonus: 0,
      pvp: false,
      actionSeconds: 1,
      rates: {},
      off: {},
      buffs: {},
      tiers: {},
      steps: {},
    };
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") {
        return {
          ...defaults,
          ...saved,
          you: { ...defaults.you, ...saved.you },
          foe: { ...defaults.foe, ...saved.foe },
          rates: { ...saved.rates },
          off: { ...saved.off },
          buffs: { ...saved.buffs },
          tiers: { ...saved.tiers },
          steps: { ...saved.steps },
        };
      }
    } catch {
      // Storage can be unavailable; the calculator still works for this visit.
    }
    return defaults;
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Not saved; nothing else depends on it.
    }
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
  }

  // --- Formatting ---------------------------------------------------------------------------------

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  function percent(value, digits = 1) {
    if (!Number.isFinite(value)) return "–";
    return `${value >= 100 ? Math.round(value) : value.toFixed(digits)}%`;
  }

  function seconds(value) {
    return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} s` : "–";
  }

  function whole(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString() : "–";
  }

  // --- Stats ----------------------------------------------------------------------------------------

  function levelValue(growth, level, withExtra) {
    const lv = growth.level_value;
    const steps = Math.min(Math.max(level - lv.extra_from_level, 0), lv.extra_levels);
    const extra = withExtra ? lv.extra_weight * (steps * (20 + 3 * steps) / 50) : 0;
    return lv.per_level * level + lv.base + extra;
  }

  // Same as the Aniimo page's Growth view: the formula's +0.8% per potential level, then +4% every 4 levels.
  function grownStat(growth, label, base, level, points) {
    const formula = growth?.stats?.[label];
    if (!formula || !Number.isFinite(base)) return null;
    const total = Math.floor((base + formula.offset) * (1 + growth.attribute_point_bonus * points) / formula.divisor
      * levelValue(growth, level, formula.extra) * formula.scale);
    const step = growth.potentials?.percent_steps?.[label];
    const bonus = step ? Math.floor(points / step.every) * step.percent : 0;
    return Math.floor(total * (1 + bonus));
  }

  // The game's stat calculator (damage-model.js statTotals: base x (1 + potential %) and so on) when it is loaded;
  // otherwise the Aniimo page's growth formula.
  function sideStats(aniilog, data, entry, side) {
    const model = window.AniilogsDamage;
    const totals = model?.statTotals && data?.forms?.[String(entry?.form_id)]
      ? model.statTotals(data, aniilog, String(entry.form_id), { level: side.level, potential: side.potential })
      : null;
    if (totals) {
      return {
        HP: totals.total.HP, Attack: totals.total.ATK, Defense: totals.total["P.DEF"], "EP Regen": totals.total.REGEN,
        "Magic Defense": totals.total["M.DEF"], Break: totals.total.BREAK, cp: totals.cp,
      };
    }
    const stats = {};
    for (const row of entry?.stats || []) {
      stats[row.label] = grownStat(aniilog.stat_growth, row.label, Number(row.value), side.level, side.potential);
    }
    return stats;
  }

  // --- Elements -------------------------------------------------------------------------------------

  function elementId(data, name) {
    const wanted = String(name || "").toLowerCase();
    return Object.entries(data?.elements || {}).find(([, element]) =>
      String(element.name).toLowerCase() === wanted || String(element.key).toLowerCase() === wanted)?.[0] || null;
  }

  function entryElementIds(data, entry) {
    const form = data?.forms?.[String(entry?.form_id)];
    if (form?.elements?.length) return form.elements.map(String);
    return (entry?.elements || []).map((element) => elementId(data, element.name)).filter(Boolean);
  }

  // CombatActionTool: the attack's multiplier against each defending element, multiplied together.
  function elementFactor(data, attackElement, defenderIds) {
    const against = data?.elements?.[attackElement]?.against || {};
    return defenderIds.reduce((factor, id) => factor * (Number(against[id]) || 1), 1);
  }

  // --- Skills -------------------------------------------------------------------------------------

  function hitRates(data, entry, skillId) {
    const skill = (data?.forms?.[String(entry?.form_id)]?.skills || []).find((row) => String(row.id) === String(skillId));
    const operation = (skill?.mechanics?.operations || []).find((row) => row.key === "instant_dmg_rate_v");
    const values = (operation?.values || []).map(Number).filter((value) => value > 0);
    return values.length ? [...new Set(values)].sort((left, right) => left - right) : [1];
  }

  function attacks(data, entry) {
    const rows = [];
    for (const [group, list] of [["", entry?.skills], ["Ultimate", entry?.ultimates]]) {
      for (const skill of Array.isArray(list) ? list : []) {
        const combat = skill.combat;
        const id = String(skill.skill_id || skill.ultimate_id || "");
        if (!combat || !id || !(Number(combat.might) > 0) || !STAT_KEYS[combat.category]) continue;
        const rates = hitRates(data, entry, id);
        // BREAK power is the skill's own tpPower (ability_param_data), from the Team Builder data when it has it.
        const teamSkill = (data?.forms?.[String(entry?.form_id)]?.skills || []).find((row) => String(row.id) === id);
        const tpPower = Number(teamSkill?.tp_power ?? teamSkill?.break_power);
        rows.push({
          id,
          name: skill.name,
          group: group || skill.group || "Skill",
          icon: skill.icon,
          category: combat.category,
          element: elementId(data, combat.element),
          elementName: combat.element,
          elementColor: combat.element_color,
          might: Number(combat.might),
          breakRate: Number.isFinite(Number(teamSkill?.bp_rate)) ? Number(teamSkill.bp_rate)
            : Number.isFinite(Number(combat.break_power)) ? Number(combat.break_power) : 1,
          breakPower: Number.isFinite(tpPower) ? tpPower : null,
          cooldown: Math.max(Number(combat.cooldown) || 0, 0),
          epCost: Number(combat.ep_cost) || 0,
          rates,
        });
      }
    }
    return rows;
  }

  function chosenRate(attack) {
    const saved = Number(settings.rates[attack.id]);
    if (attack.rates.includes(saved)) return saved;
    return attack.rates.includes(1) ? 1 : attack.rates[0];
  }

  // --- Damage ---------------------------------------------------------------------------------------

  // Formula 3001 for one hit, with every modifier the scenario doesn't set left neutral (1x).
  function hpDamage(attacker, defender, attack, scenario, crit) {
    const [atkKey, defKey] = STAT_KEYS[attack.category];
    const atk = Math.max(attacker.stats[atkKey] || 0, 0);
    const def = defender.stats[defKey] || 0;
    let damage = Math.max(atk - def, RULES.minimumShare * atk) * (chosenRate(attack) * attack.might / 10);
    damage *= elementFactor(scenario.data, attack.element, defender.elements);
    if (attacker.elements.includes(attack.element)) damage *= 1 + RULES.sameElement;
    if (crit) damage *= Math.min(RULES.critCap, 1 + RULES.critDamage);
    if (scenario.broken) damage *= 1 + scenario.brokenBonus;
    damage = Math.max(damage, 0);
    return scenario.pvp ? damage * RULES.pvpFactor : damage;
  }

  // Formula 3023 for one hit. Aniimo have no BREAK defense of their own (property_data gives pets none).
  function breakDamage(attacker, defender, attack, scenario, crit) {
    const bpAtk = attacker.stats.Break || 0;
    let damage = bpAtk * (chosenRate(attack) * attack.might / 10) * attack.breakRate;
    damage *= Math.max(1, elementFactor(scenario.data, attack.element, defender.elements));
    if (crit) damage *= Math.min(RULES.critCap, 1 + RULES.critDamage);
    return Math.max(damage, 0);
  }

  function averaged(normal, crit) {
    return normal * (1 - RULES.critRate) + crit * RULES.critRate;
  }

  // Uses the strongest attack that is off cooldown, one attack every `actionSeconds`, until the HP is gone (or the
  // time runs out). `pick` is "normal", "average" or "crit" for which damage each hit deals.
  function rotation(rows, hp, actionSeconds, pick, limit = RULES.maxSeconds) {
    const ready = new Map(rows.map((row) => [row.attack.id, 0]));
    const used = new Map();
    let time = 0;
    let left = hp;
    let dealt = 0;
    let hits = 0;
    let ep = 0;
    const order = [...rows].sort((left, right) => right[pick] - left[pick]);
    while (hits < 2000) {
      const choice = order.find((row) => ready.get(row.attack.id) <= time + 1e-9);
      if (!choice) {
        time = Math.min(...ready.values());
        continue;
      }
      if (time > limit) break;
      hits += 1;
      dealt += choice[pick];
      ep += choice.attack.epCost;
      left -= choice[pick];
      used.set(choice.attack.name, (used.get(choice.attack.name) || 0) + 1);
      ready.set(choice.attack.id, time + Math.max(choice.attack.cooldown, 0));
      if (left <= 0) return { time, hits, used, dealt, ep, ko: true };
      time += actionSeconds;
    }
    return { time: limit, hits, used, dealt, ep, ko: false };
  }


  // One attack through damage-model.js (Team Builder's port of formulas 3001/3023 with every bracket), with the
  // picked buffs and debuffs; falls back to the simple formula above when the model isn't loaded.
  function modelHit(attacker, defender, attack, scenario) {
    const model = window.AniilogsDamage;
    if (!model?.hit) return null;
    const side = (model, modifiers) => ({
      atk: model.stats.Attack || 0,
      pdef: model.stats.Defense || 0,
      mdef: model.stats["Magic Defense"] || 0,
      breakAtk: model.stats.Break || 0,
      breakDef: 0,
      elements: model.elements,
      modifiers,
    });
    const attackerMods = { ...(scenario.attackerMods || {}) };
    if (scenario.broken && scenario.brokenBonus) attackerMods.dmg_break_add_ratio = (attackerMods.dmg_break_add_ratio || 0) + scenario.brokenBonus;
    const type = attack.group === "Normal" ? "basic" : attack.group === "Ultimate" ? "ultimate" : "skill";
    return model.hit(side(attacker, attackerMods), side(defender, scenario.defenderMods || {}), {
      might: attack.might,
      // BREAK (formula 3023): the skill's Might times its bpRate; tpPower only drains toughness.
      breakRate: attack.breakRate,
      element: attack.element,
      category: attack.category === "Magic" ? "Magical" : "Physical",
      type,
      hitShare: chosenRate(attack),
    }, {
      elements: scenario.data?.elements,
      sameElementBonus: scenario.data?.combat?.same_element_bonus,
      elementKeys: scenario.data?.combat?.element_damage_keys,
      broken: scenario.broken,
      pvp: scenario.pvp,
    });
  }

  function matchup(aniilog, data, attackerSide, defenderSide, scenario) {
    const attacker = sideModel(aniilog, data, attackerSide);
    const defender = sideModel(aniilog, data, defenderSide);
    if (!attacker.entry || !defender.entry) return null;
    const maxHp = defender.stats.HP || 0;
    const rows = attacks(data, attacker.entry).map((attack) => {
      const result = modelHit(attacker, defender, attack, scenario);
      if (result) {
        return {
          attack,
          normal: result.hit,
          crit: result.crit,
          average: result.average,
          // Toughness: how much of the target's toughness (stagger) gauge one hit drains, before the level gap.
          toughness: attack.breakPower === null || !window.AniilogsDamage?.toughnessDrain
            ? NaN : window.AniilogsDamage.toughnessDrain(attack.breakPower, { hitShare: chosenRate(attack) }),
          breakNormal: result.break,
          breakAverage: result.break + (result.critChance || 0) * ((result.breakCrit ?? result.break) - result.break),
          hitsToBreak: window.AniilogsDamage?.hitsToBreak
            ? window.AniilogsDamage.hitsToBreak(scenario.data, defender.side.level, result.break + (result.critChance || 0) * ((result.breakCrit ?? result.break) - result.break))
            : null,
          critChance: result.critChance,
          critMultiplier: result.critMultiplier,
          steps: result.steps || [],
          ignored: result.ignored || "",
          enabled: !settings.off[attack.id],
        };
      }
      const normal = hpDamage(attacker, defender, attack, scenario, false);
      const crit = hpDamage(attacker, defender, attack, scenario, true);
      const breakNormal = breakDamage(attacker, defender, attack, scenario, false);
      const breakCrit = breakDamage(attacker, defender, attack, scenario, true);
      return {
        attack,
        normal,
        crit,
        average: averaged(normal, crit),
        breakNormal,
        breakAverage: averaged(breakNormal, breakCrit),
        steps: [],
        enabled: !settings.off[attack.id],
      };
    });
    const startHp = maxHp * (scenario.startHp / 100);
    const enabled = rows.filter((row) => row.enabled);
    const plan = (pick, limit) => enabled.length ? rotation(enabled, startHp, scenario.actionSeconds, pick, limit) : null;
    return {
      attacker,
      defender,
      maxHp,
      startHp,
      rows,
      average: plan("average"),
      normal: plan("normal"),
      crit: plan("crit"),
      breakWindow: scenario.broken && enabled.length
        ? rotation(enabled, Infinity, scenario.actionSeconds, "average", RULES.breakTime - 1e-6)
        : null,
    };
  }

  function sideModel(aniilog, data, side) {
    const entry = (aniilog?.entries || []).find((row) => String(row.form_id) === String(side.formId)) || null;
    return { entry, side, stats: entry ? sideStats(aniilog, data, entry, side) : {}, elements: entry ? entryElementIds(data, entry) : [] };
  }

  // --- Rendering ------------------------------------------------------------------------------------

  function change(rerender, update) {
    return (event) => {
      update(event.target);
      saveSettings();
      rerender();
    };
  }

  function numberField(label, value, { min, max, step = 1, suffix = "" }, onChange) {
    const wrap = el("label", "duel-field");
    wrap.append(el("span", "", label));
    const input = el("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.inputMode = "decimal";
    input.addEventListener("change", onChange);
    wrap.append(input);
    if (suffix) wrap.append(el("small", "", suffix));
    return wrap;
  }

  function aniimoSelect(options, side, rerender) {
    const select = el("select", "duel-aniimo-select");
    select.setAttribute("aria-label", "Aniimo");
    const blank = el("option", "", "Pick an Aniimo");
    blank.value = "";
    select.append(blank);
    const team = options.members.filter((formId, index, list) => formId && list.indexOf(formId) === index);
    const groups = [];
    if (team.length) groups.push(["Your team", team]);
    groups.push(["All Aniimo", (options.aniilog.entries || []).map((entry) => String(entry.form_id))]);
    for (const [label, ids] of groups) {
      const group = el("optgroup");
      group.label = label;
      for (const formId of ids) {
        const entry = options.aniilog.entries.find((row) => String(row.form_id) === formId);
        if (!entry) continue;
        const option = el("option", "", options.formLabel(entry, options.data.forms?.[formId]));
        option.value = formId;
        option.selected = formId === String(side.formId) && (label === "Your team" || !team.includes(formId));
        group.append(option);
      }
      select.append(group);
    }
    select.addEventListener("change", change(rerender, (target) => {
      side.formId = target.value;
      // A team member brings the level and potential from its Stats tab.
      const member = options.memberStats?.[target.value];
      if (member) {
        const cap = options.aniilog.stat_growth?.level_cap || 70;
        side.level = Math.round(clamp(member.level ?? cap, 1, cap, cap));
        side.potential = Math.round(clamp(member.potential ?? 0, 0, 20, 0));
      }
    }));
    return select;
  }

  function renderSide(options, key, title, rerender) {
    const side = settings[key];
    const model = sideModel(options.aniilog, options.data, side);
    const card = el("section", `duel-side is-${key}`);
    const head = el("header", "duel-side-head");
    head.append(el("h3", "", title));
    if (model.entry?.icon) {
      const icon = el("img", "duel-side-icon");
      icon.src = options.contentUrl ? options.contentUrl(model.entry.icon) : model.entry.icon;
      icon.alt = "";
      icon.loading = "lazy";
      head.prepend(icon);
    }
    card.append(head, aniimoSelect(options, side, rerender));
    const fields = el("div", "duel-side-fields");
    fields.append(
      numberField("Level", side.level, { min: 1, max: options.aniilog.stat_growth?.level_cap || 70 }, change(rerender, (target) => {
        side.level = Math.round(clamp(target.value, 1, options.aniilog.stat_growth?.level_cap || 70, 70));
      })),
      numberField("Potential", side.potential, { min: 0, max: 20, suffix: "per stat" }, change(rerender, (target) => {
        side.potential = Math.round(clamp(target.value, 0, 20, 0));
      })),
    );
    card.append(fields);
    if (model.entry) {
      const chips = el("div", "duel-elements");
      for (const id of model.elements) {
        const element = options.data.elements?.[id];
        const chip = el("span", "duel-element-chip", element?.name || id);
        if (element?.color) chip.style.setProperty("--chip", element.color);
        chips.append(chip);
      }
      card.append(chips);
      const stats = el("dl", "duel-stats");
      for (const [label, display] of SHOWN_STATS) {
        if (!(label in model.stats)) continue;
        const pair = el("div");
        pair.append(el("dt", "", display), el("dd", "", whole(model.stats[label])));
        stats.append(pair);
      }
      card.append(stats);
    }
    return card;
  }

  function renderScenario(options, rerender) {
    const box = el("section", "duel-scenario");
    box.append(el("h3", "", "Scenario"));
    const fields = el("div", "duel-scenario-fields");
    fields.append(numberField("Opponent starts at", settings.startHp, { min: 1, max: 100, suffix: "% HP" }, change(rerender, (target) => {
      settings.startHp = clamp(target.value, 1, 100, 100);
    })));
    const broken = el("label", "duel-check");
    const brokenInput = el("input");
    brokenInput.type = "checkbox";
    brokenInput.checked = settings.broken;
    brokenInput.addEventListener("change", change(rerender, (target) => {
      settings.broken = target.checked;
    }));
    broken.append(brokenInput, el("span", "", `Opponent is broken (lasts ${RULES.breakTime} s)`));
    fields.append(broken);
    if (settings.broken) {
      fields.append(numberField("Extra damage while broken", Math.round(settings.brokenBonus * 100), { min: 0, max: 500, suffix: "%" }, change(rerender, (target) => {
        settings.brokenBonus = clamp(target.value, 0, 500, 0) / 100;
      })));
    }
    const pvp = el("label", "duel-check");
    const pvpInput = el("input");
    pvpInput.type = "checkbox";
    pvpInput.checked = settings.pvp;
    pvpInput.addEventListener("change", change(rerender, (target) => {
      settings.pvp = target.checked;
    }));
    pvp.append(pvpInput, el("span", "", `PvP (the game scales PvP damage to ${Math.round(RULES.pvpFactor * 100)}%)`));
    fields.append(pvp, numberField("Time per attack", settings.actionSeconds, { min: 0.3, max: 5, step: 0.1, suffix: "s" }, change(rerender, (target) => {
      settings.actionSeconds = clamp(target.value, 0.3, 5, 1);
    })));
    box.append(fields);
    const notes = el("p", "duel-note");
    notes.textContent = settings.broken
      ? "Each enemy sets its own bonus for being broken (bosses show it on their BREAK bar), so enter it if you know it. 0% means no bonus."
      : "Time per attack is how long one attack takes before the next. Animation times aren't in the game data, so 1 s is a stand-in.";
    box.append(notes);
    return box;
  }

  function verdictText(you, foe) {
    const mine = you?.average;
    const theirs = foe?.average;
    if (!mine || !theirs) return "";
    if (mine.ko && (!theirs.ko || mine.time < theirs.time)) return `You win the race: KO in ${seconds(mine.time)} vs ${seconds(theirs.time)}.`;
    if (theirs.ko && (!mine.ko || theirs.time < mine.time)) return `The opponent wins the race: KO in ${seconds(theirs.time)} vs ${seconds(mine.time)}.`;
    if (mine.ko && theirs.ko) return `Dead even: both KO in ${seconds(mine.time)}.`;
    return `Neither side KOs within ${RULES.maxSeconds} s.`;
  }

  function planSummary(result, label) {
    const box = el("div", "duel-plan");
    if (!result?.average) {
      box.append(el("p", "duel-note", "Turn on at least one attack."));
      return box;
    }
    const { average, normal, crit } = result;
    const head = el("p", "duel-plan-head");
    const strong = el("strong", "", average.ko ? `KO in ${average.hits} hit${average.hits === 1 ? "" : "s"} · ${seconds(average.time)}` : `No KO in ${RULES.maxSeconds} s`);
    head.append(strong, ` ${label}`);
    const range = el("p", "duel-plan-range");
    range.textContent = `No crits: ${normal.ko ? `${normal.hits} hits, ${seconds(normal.time)}` : "no KO"} · Every hit crits: ${crit.ko ? `${crit.hits} hits, ${seconds(crit.time)}` : "no KO"}`;
    const used = el("p", "duel-plan-used");
    used.textContent = `Uses ${[...average.used].map(([name, count]) => `${name} ×${count}`).join(", ")}${average.ep ? ` · spends ${whole(average.ep)} EP (EP isn’t limited here)` : ""}`;
    box.append(head, range, used);
    if (result.breakWindow) {
      const window = el("p", "duel-plan-break");
      window.textContent = `During the ${RULES.breakTime} s break: ${result.breakWindow.hits} hits for ${percent(result.breakWindow.dealt / result.maxHp * 100)} of max HP.`;
      box.append(window);
    }
    return box;
  }

  function renderAttackTable(options, result, rerender) {
    const table = el("div", "duel-table");
    table.setAttribute("role", "table");
    const head = el("div", "duel-row is-head");
    head.setAttribute("role", "row");
    ["", "Attack", "Hit", "Cooldown", "Damage", "With crit", "Average", "Hits to KO", "BREAK dmg", "Hits to BREAK*"].forEach((label) => {
      const cell = el("span", "", label);
      cell.setAttribute("role", "columnheader");
      head.append(cell);
    });
    table.append(head);
    const hpShare = (value) => result.maxHp ? value / result.maxHp * 100 : NaN;
    const toKo = (value) => value > 0 ? Math.ceil(result.startHp / value) : Infinity;
    for (const row of result.rows) {
      // Which direction this table is, so opening an attack's working opens it on this side only.
      const stepKey = `${result.attacker.side === settings.you ? "you" : "foe"}:${row.attack.id}`;
      const line = el("div", `duel-row${row.enabled ? "" : " is-off"}`);
      line.setAttribute("role", "row");
      const toggle = el("input");
      toggle.type = "checkbox";
      toggle.checked = row.enabled;
      toggle.title = "Use this attack in the KO plan";
      toggle.setAttribute("aria-label", `Use ${row.attack.name}`);
      toggle.addEventListener("change", change(rerender, (target) => {
        if (target.checked) delete settings.off[row.attack.id];
        else settings.off[row.attack.id] = true;
      }));
      const name = el("button", "duel-attack");
      name.type = "button";
      name.setAttribute("aria-expanded", String(Boolean(settings.steps[stepKey])));
      name.title = "Show how this was worked out";
      name.addEventListener("click", change(rerender, () => {
        if (settings.steps[stepKey]) delete settings.steps[stepKey];
        else settings.steps[stepKey] = true;
      }));
      const title = el("strong", "", row.attack.name);
      const meta = el("small", "", [row.attack.group, row.attack.category, row.attack.elementName].filter(Boolean).join(" · "));
      if (row.attack.elementColor) name.style.setProperty("--chip", row.attack.elementColor);
      name.append(title, meta);
      let rate;
      if (row.attack.rates.length > 1) {
        rate = el("select", "duel-rate");
        rate.setAttribute("aria-label", `${row.attack.name} hit strength`);
        for (const value of row.attack.rates) {
          const option = el("option", "", `${Math.round(value * 100)}%`);
          option.value = String(value);
          option.selected = value === chosenRate(row.attack);
          rate.append(option);
        }
        rate.title = "This attack's hits use these shares of its Might in the game data (for example a stronger follow-up or a dodge bonus).";
        rate.addEventListener("change", change(rerender, (target) => {
          settings.rates[row.attack.id] = Number(target.value);
        }));
      } else {
        rate = el("span", "", `${Math.round(row.attack.rates[0] * 100)}%`);
      }
      rate.classList.add("duel-cell-rate");
      const cells = [
        toggle,
        name,
        rate,
        el("span", "", row.attack.cooldown ? `${row.attack.cooldown} s` : "–"),
        el("span", "duel-num", percent(hpShare(row.normal))),
        el("span", "duel-num", percent(hpShare(row.crit))),
        el("span", "duel-num is-key", percent(hpShare(row.average))),
        el("span", "duel-num", Number.isFinite(toKo(row.average)) ? String(toKo(row.average)) : "–"),
        el("span", "duel-num", whole(row.breakAverage)),
        el("span", "duel-num duel-unverified", Number.isFinite(row.hitsToBreak) ? String(row.hitsToBreak) : "–"),
      ];
      cells.forEach((cell, index) => {
        cell.setAttribute("role", "cell");
        if (index > 1) cell.dataset.label = ["", "", "Hit", "Cooldown", "Damage", "With crit", "Average", "Hits to KO", "BREAK dmg", "Hits to BREAK*"][index];
      });
      line.append(...cells);
      table.append(line);
      if (settings.steps[stepKey] && row.steps?.length) table.append(renderSteps(row, result));
    }
    return table;
  }

  function renderDirection(options, result, title, rerender) {
    const section = el("section", "duel-direction");
    section.append(el("h3", "", title));
    if (!result) {
      section.append(el("p", "duel-note", "Pick both Aniimo to see the numbers."));
      return section;
    }
    const target = settings.startHp < 100 ? ` from ${percent(settings.startHp, 0)} HP` : "";
    section.append(planSummary(result, `(${whole(result.startHp)} HP${target}, average with crits)`));
    section.append(renderAttackTable(options, result, rerender));
    const bar = window.AniilogsDamage?.breakBar?.(options.data, result.defender.side.level);
    if (Number.isFinite(bar)) {
      const line = el("p", "duel-dev");
      line.append(el("span", "duel-dev-badge", "Not verified"), ` * The opponent's BREAK bar at Lv ${result.defender.side.level} is ${whole(bar)} (formula 3110). Hits to BREAK counts one attack over and over (average BREAK with crits). Not yet checked in the game: use one attack on a same-level Aniimo until it’s BREAKed, then compare the count with this column.`);
      section.append(line);
    }
    return section;
  }

  // With nothing picked yet, your side starts as the first Aniimo on your team (at its Stats-tab level).
  function defaultYourAniimo(options) {
    const formId = options.members?.[0];
    if (settings.you.formId || !formId) return;
    settings.you.formId = formId;
    const member = options.memberStats?.[formId];
    const cap = options.aniilog.stat_growth?.level_cap || 70;
    settings.you.level = Math.round(clamp(member?.level ?? cap, 1, cap, cap));
    settings.you.potential = Math.round(clamp(member?.potential ?? 0, 0, 20, 0));
  }

  // --- Buffs and debuffs from your team ------------------------------------------------------------

  const PERCENT_KEY = /(_rate|_ratio|_p)(_v)?$/u;

  // What can apply in this 1v1: everything your Aniimo brings itself, and from teammates only what reaches your
  // Aniimo (team and active-Aniimo buffs) or the opponent (debuffs). A teammate's own self buffs don't count.
  // A held item's rarities fold into one effect with a rarity choice.
  const TEAM_WIDE = new Set(["ally", "player", "active Aniimo", "enemy"]);

  function teamEffects(options) {
    const model = window.AniilogsDamage;
    if (!model?.options) return [];
    const you = String(settings.you.formId || "");
    const formIds = [...new Set([...(options.members || []), you].filter(Boolean).map(String))];
    const effects = [];
    const items = new Map();
    // Effects whose amount scales with the caster's stat (e.g. "+28–49% depending on ATK") get it from that
    // caster's card stats: your Aniimo at its 1v1 level and potential, a teammate at its Stats-tab settings.
    const casterStats = new Map();
    const statsFor = (formId) => {
      const key = String(formId);
      if (!casterStats.has(key)) {
        const cap = options.aniilog.stat_growth?.level_cap || 70;
        const source = key === you ? settings.you : options.memberStats?.[key] || {};
        const totals = model.statTotals?.(options.data, options.aniilog, key, { level: source.level ?? cap, potential: source.potential ?? 0 });
        casterStats.set(key, totals?.total || null);
      }
      return casterStats.get(key);
    };
    for (const raw of model.options(options.data, formIds)) {
      if (String(raw.form_id) !== you && !TEAM_WIDE.has(raw.who)) continue;
      let effect = raw;
      if (raw.scaling && !(raw.values || []).length && model.scaledValue) {
        const value = model.scaledValue(raw.scaling, statsFor(raw.form_id), raw.scaling.bases?.length || 1);
        const range = model.scaledRange?.(raw.scaling);
        effect = {
          ...raw,
          values: Number.isFinite(value) ? [value] : [],
          scaledNote: range ? `scales with ${raw.scaling.stat}` : "",
        };
      }
      if (effect.source?.kind !== "held item") {
        effects.push(effect);
        continue;
      }
      const id = `item:${effect.form_id}:${effect.name}:${effect.key}`;
      let row = items.get(id);
      if (!row) {
        row = { ...effect, id, tiers: [] };
        items.set(id, row);
        effects.push(row);
      }
      const quality = /\(([^)]+)\)$/u.exec(effect.source?.name || "")?.[1] || `Tier ${row.tiers.length + 1}`;
      row.tiers.push({ label: quality, value: Number(effect.values?.[0]) });
      row.source = { ...effect.source, name: effect.name };
    }
    return effects;
  }

  // The strongest listed level of an effect, times the stacks picked.
  function effectValue(effect) {
    if (effect.tiers?.length) {
      const tier = effect.tiers[Math.min(Number(settings.tiers?.[effect.id] ?? effect.tiers.length - 1), effect.tiers.length - 1)];
      return Number.isFinite(tier?.value) ? tier.value : null;
    }
    const values = (effect.values || []).map(Number).filter(Number.isFinite);
    if (!values.length) return null;
    const value = values[values.length - 1];
    const stacks = Math.min(Math.max(Number(settings.buffs[effect.id]) || 1, 1), effect.stacks || 1);
    return value * stacks;
  }

  // Picked effects summed per holder: your side (self, ally, player, active Aniimo) and the opponent (enemy).
  function pickedModifiers(effects) {
    const mods = { you: {}, foe: {} };
    for (const effect of effects) {
      if (!settings.buffs[effect.id]) continue;
      const value = effectValue(effect);
      if (value === null) continue;
      const side = effect.who === "enemy" ? mods.foe : mods.you;
      side[effect.key] = (side[effect.key] || 0) + value;
    }
    return mods;
  }

  function formatEffect(effect, value) {
    if (value === null) return "(amount not in the data)";
    const percent = PERCENT_KEY.test(effect.key) || Math.abs(value) < 1;
    const amount = percent ? `${Math.round(value * 1000) / 10}%` : `${Math.round(value * 10) / 10}`;
    return `${value >= 0 ? "+" : ""}${amount}`;
  }

  const WHO_LABELS = Object.freeze({ self: "self", ally: "team", player: "team", "active Aniimo": "active Aniimo", enemy: "enemy" });

  function renderBuffs(options, effects, rerender) {
    const section = el("section", "duel-buffs");
    const head = el("header", "duel-buffs-head");
    head.append(el("h3", "", "Buffs and debuffs"), el("p", "duel-note", "From the Aniimo on your team: their skills, Ultimates, traits and recommended held items. Buffs go on your Aniimo; debuffs go on the opponent, where they also weaken its hits on you. Each uses its strongest listed level."));
    section.append(head);
    if (!effects.length) {
      section.append(el("p", "duel-note", options.members?.length ? "Your team’s Aniimo don’t list any damage effects." : "Add Aniimo to your team on the Team page to pick their buffs and debuffs here."));
      return section;
    }
    const groups = [["On your Aniimo", effects.filter((effect) => effect.who !== "enemy")], ["On the opponent", effects.filter((effect) => effect.who === "enemy")]];
    const lists = el("div", "duel-buff-groups");
    for (const [title, rows] of groups) {
      if (!rows.length) continue;
      const group = el("div", "duel-buff-group");
      group.append(el("h4", "", title));
      for (const effect of rows) {
        const value = effectValue(effect);
        const item = el("div", `duel-buff${value === null ? " is-unknown" : ""}`);
        const label = el("label", "duel-buff-label");
        const check = el("input");
        check.type = "checkbox";
        check.checked = Boolean(settings.buffs[effect.id]);
        check.disabled = value === null;
        check.addEventListener("change", change(rerender, (target) => {
          if (target.checked) settings.buffs[effect.id] = 1;
          else delete settings.buffs[effect.id];
        }));
        const copy = el("span", "duel-buff-copy");
        const entry = (options.aniilog.entries || []).find((row) => String(row.form_id) === String(effect.form_id));
        copy.append(
          el("strong", "", `${effect.label} ${formatEffect(effect, value)}`),
          el("small", "", [`${effect.source?.name || effect.name}${effect.source?.kind === "upgrade" ? " (upgraded)" : ""}`, entry?.name, WHO_LABELS[effect.who] || effect.who, effect.scaledNote, effect.basis === "inferred" ? "not verified: inferred" : effect.basis === "by-name" ? "not verified: matched by name" : effect.basis !== "exact" ? effect.basis : ""].filter(Boolean).join(" · ")),
        );
        label.append(check, copy);
        item.append(label);
        if (effect.tiers?.length > 1) {
          const tier = el("select", "duel-buff-tier");
          tier.setAttribute("aria-label", `${effect.name} rarity`);
          const chosen = Math.min(Number(settings.tiers?.[effect.id] ?? effect.tiers.length - 1), effect.tiers.length - 1);
          effect.tiers.forEach((row, index) => {
            const option = el("option", "", row.label);
            option.value = String(index);
            option.selected = index === chosen;
            tier.append(option);
          });
          tier.addEventListener("change", change(rerender, (target) => {
            settings.tiers = { ...settings.tiers, [effect.id]: Number(target.value) };
          }));
          item.append(tier);
        }
        if ((effect.stacks || 1) > 1 && settings.buffs[effect.id]) {
          const stacks = el("label", "duel-buff-stacks");
          const input = el("input");
          input.type = "number";
          input.min = "1";
          input.max = String(effect.stacks);
          input.value = String(settings.buffs[effect.id]);
          input.setAttribute("aria-label", `${effect.label} stacks`);
          input.addEventListener("change", change(rerender, (target) => {
            settings.buffs[effect.id] = Math.round(clamp(target.value, 1, effect.stacks, 1));
          }));
          stacks.append(input, el("small", "", `of ${effect.stacks} stacks`));
          item.append(stacks);
        }
        group.append(item);
      }
      lists.append(group);
    }
    section.append(lists);
    return section;
  }

  // "How this was worked out": each multiplier the damage model applied, and how sure it is.
  function renderSteps(row, result) {
    const box = el("div", "duel-steps");
    const list = el("ol");
    for (const step of row.steps) {
      const item = el("li");
      const value = Number(step.value);
      const shown = step.label.startsWith("Base") ? whole(value) : `×${Math.round(value * 1000) / 1000}`;
      item.append(el("span", "", step.label), el("b", "", shown));
      if (step.basis && step.basis !== "exact") item.append(el("small", "duel-step-basis", step.basis === "inferred" ? "not verified: inferred" : step.basis === "by-name" ? "not verified: matched by name" : step.basis));
      list.append(item);
    }
    const crit = Number.isFinite(row.critChance)
      ? `Crit: ${Math.round(row.critChance * 100)}% chance for ×${Math.round(row.critMultiplier * 100) / 100}.`
      : "";
    const toughness = Number.isFinite(row.toughness) ? ` Toughness drained: ${Math.round(row.toughness * 10) / 10} (not verified: a separate stagger gauge).` : "";
    box.append(list, el("p", "duel-note", `One hit: ${whole(row.normal)} damage (${percent(result.maxHp ? row.normal / result.maxHp * 100 : NaN)} of max HP), ${whole(row.breakAverage)} BREAK. ${crit}${toughness}`.trim()));
    return box;
  }

  function render(options) {
    defaultYourAniimo(options);
    const root = el("div", "duel");
    const rerender = options.rerender;
    const banner = el("p", "duel-banner");
    const strong = el("strong", "", "Assumes every attack lands.");
    banner.append(strong, ` No dodges, misses or blocks, and no buffs or team effects. Crits use the game's base ${Math.round(RULES.critRate * 100)}% chance for ${1 + RULES.critDamage}× damage; "Average" mixes them in, and the KO plan shows the no-crit and all-crit range too.`);
    root.append(banner);
    const setup = el("div", "duel-setup");
    setup.append(renderSide(options, "you", "Your Aniimo", rerender), renderScenario(options, rerender), renderSide(options, "foe", "Opponent", rerender));
    root.append(setup);
    const effects = teamEffects(options);
    const mods = pickedModifiers(effects);
    root.append(renderBuffs(options, effects, rerender));
    const scenario = {
      data: options.data,
      startHp: settings.startHp,
      broken: settings.broken,
      brokenBonus: settings.broken ? settings.brokenBonus : 0,
      pvp: settings.pvp,
      actionSeconds: settings.actionSeconds,
    };
    const youHit = matchup(options.aniilog, options.data, settings.you, settings.foe, { ...scenario, attackerMods: mods.you, defenderMods: mods.foe });
    // The opponent's attack back on you always starts from your full HP and isn't broken.
    const foeHit = matchup(options.aniilog, options.data, settings.foe, settings.you, { ...scenario, startHp: 100, broken: false, brokenBonus: 0, attackerMods: mods.foe, defenderMods: mods.you });
    const verdict = verdictText(youHit, foeHit);
    if (verdict) root.append(el("p", "duel-verdict", verdict));
    const results = el("div", "duel-results");
    results.append(
      renderDirection(options, youHit, "You → Opponent", rerender),
      renderDirection(options, foeHit, "Opponent → You", rerender),
    );
    root.append(results);
    const sources = el("p", "duel-sources");
    sources.textContent = "From the game's own scripts: HP damage formula 3001 (ATK − DEF, at least 10% of ATK, × Might ÷ 10), BREAK damage formula 3023, crits and elements from the combat code. Two elements multiply (1.6 × 1.6 = 2.56×). Same-element attacks get +10%. BREAK dmg is formula 3023: BREAK stat × Might ÷ 10 × the skill’s BREAK rate, and it can crit. Hits to BREAK divides the opponent’s BREAK bar by it and isn’t checked in the game yet. Toughness (a separate stagger gauge) is in each attack’s working. Physical skills hit P.DEF and magic skills M.DEF, both with ATK. Stats are base stats, before personality, held items and other bonuses. EP isn't limited, and buffs, traits and skill effects beyond damage aren't included.";
    root.append(sources);
    return root;
  }

  window.AniilogsDuel = Object.freeze({ render, rules: RULES, hpDamage, breakDamage, rotation, grownStat });
})();
