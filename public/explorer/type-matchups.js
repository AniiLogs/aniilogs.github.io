// game-audit: 1.1.3887621 2026-11-10 real_element_against values and getElementAgainstValue; duel buff 11158 (sys_config DUEL_ELEMENT_RESIST_V) for the PvP values, which are expected, not seen in play
(() => {
  "use strict";

  // What a form takes from each attacking element: one multiplier per element, for the Aniimo page (radar) and
  // Team Builder (grid). `elements` is team_builder_data.json's table: elements[attacker].against[defender].
  //
  // PvE: the game multiplies the table value of each defending element (1.6 or 0.625), so two elements give
  // 2.56, 1 or 0.39.
  // PvP: the duel buff (11158) takes 0.5 off both sides' Counter Boost and Resistance Boost (neither goes below
  // 0) and then 0.1 more off each when one Aniimo hits another. With no boost from gear that leaves -0.1: a
  // countered hit is 1.6 x 0.9, a resisted one 0.625 / 0.9. Mixed matchups stay 1. No scene in the game files
  // turns this on yet, so these are the values to expect, not ones measured in a duel.
  const ORDER = Object.freeze(["5", "3", "6", "4", "2", "8", "9", "13", "12"]);
  const MODES = Object.freeze([
    Object.freeze({ id: "pve", label: "PvE" }),
    Object.freeze({ id: "pvp", label: "PvP" }),
  ]);
  const DUEL_SHIFT = -0.1;
  const PVP_NOTE = "PvP: expected values. The game files hold a duel-only effect that removes 50 points of Counter Boost and Resistance Boost from gear and softens every matchup by 10%. No mode uses it yet, so it isn't confirmed in play.";
  const PVE_NOTE = "With two elements the game multiplies both values, so ×1.6 twice is ×2.56. Counter Boost and Resistance Boost from gear change the result.";
  const EPSILON = 1e-9;

  const shift = (mode) => (mode === "pvp" ? DUEL_SHIFT : 0);

  // A table product and which side it favours -> the multiplier in this mode.
  function adjust(factor, side, mode) {
    if (Math.abs(side - 1) < EPSILON) return factor;
    return side > 1 ? factor * (1 + shift(mode)) : factor / (1 + shift(mode));
  }

  // Damage multiplier when `attacker` (an element id) hits something with the `defending` element ids.
  function net(elements, defending, attacker, mode = "pve") {
    let factor = 1;
    let side = 1;
    for (const defender of defending || []) {
      const value = Number(elements?.[String(attacker)]?.against?.[String(defender)]);
      if (!Number.isFinite(value)) continue;
      factor *= value;
      side *= value > 1 ? 2 : value < 1 ? 0.5 : 1;
    }
    return adjust(factor, side, mode);
  }

  // The four values a matchup can take in this mode, weakest hit first: both resist, one resists, one counters,
  // both counter.
  function steps(mode = "pve") {
    return [adjust(0.625 * 0.625, 0.25, mode), adjust(0.625, 0.5, mode), adjust(1.6, 2, mode), adjust(1.6 * 1.6, 4, mode)];
  }

  function format(value) {
    const exact = Number(value.toFixed(3));
    return `×${Math.abs(exact - value) < EPSILON ? exact : Number(value.toFixed(2))}`;
  }

  function tone(value) {
    return value > 1 + EPSILON ? "more" : value < 1 - EPSILON ? "less" : "even";
  }

  // Element ids in the order every chart uses; ids the list doesn't know go last.
  function order(elements) {
    const ids = Object.keys(elements || {});
    return [...ORDER.filter((id) => ids.includes(id)), ...ids.filter((id) => !ORDER.includes(id))];
  }

  // One entry per attacking element: { id, name, color, value, tone }.
  function row(elements, defending, mode = "pve") {
    return order(elements).map((id) => {
      const value = net(elements, defending, id, mode);
      return { id, name: elements[id].name || id, color: elements[id].color || "", value, tone: tone(value) };
    });
  }

  // The row's entries grouped by multiplier, biggest first: [{ value, tone, entries }].
  function groups(entries) {
    const out = [];
    [...entries].sort((left, right) => right.value - left.value).forEach((entry) => {
      const last = out[out.length - 1];
      if (last && Math.abs(last.value - entry.value) < EPSILON) last.entries.push(entry);
      else out.push({ value: entry.value, tone: entry.tone, entries: [entry] });
    });
    return out;
  }

  function sentence(entries) {
    const names = (wanted) => entries.filter((entry) => entry.tone === wanted)
      .sort((left, right) => (wanted === "more" ? right.value - left.value : left.value - right.value))
      .map((entry) => entry.name).join(", ");
    const more = names("more");
    const less = names("less");
    if (!more && !less) return "Takes normal damage from every element.";
    return [more && `Takes more from ${more}.`, less && `Takes less from ${less}.`].filter(Boolean).join(" ");
  }

  // --- Radar geometry (pure) ------------------------------------------------------------------

  const RADAR = Object.freeze({ width: 380, height: 330, cx: 190, cy: 165, outer: 112, inner: 34, label: 138 });

  // Log scale from the smallest PvE value (inner) to the largest (outer); PvP values lie between them.
  function radarRadius(value) {
    const low = Math.log(0.625 * 0.625);
    const high = Math.log(1.6 * 1.6);
    const share = Math.min(1, Math.max(0, (Math.log(value) - low) / (high - low)));
    return RADAR.inner + share * (RADAR.outer - RADAR.inner);
  }

  function radarPoint(index, count, radius) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    return [RADAR.cx + radius * Math.cos(angle), RADAR.cy + radius * Math.sin(angle)];
  }

  // --- DOM ------------------------------------------------------------------------------------

  const SVG = "http://www.w3.org/2000/svg";

  function svg(tag, attributes = {}, text = "") {
    const node = document.createElementNS(SVG, tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    if (text) node.textContent = text;
    return node;
  }

  function html(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  function polygon(count, radiusAt, className) {
    const points = Array.from({ length: count }, (_, index) => radarPoint(index, count, radiusAt(index))
      .map((value) => value.toFixed(1)).join(",")).join(" ");
    return svg("polygon", { points, class: className });
  }

  // Several defenders (a team) against one attacking element: the geometric mean of their multipliers, so x1.6 on
  // one member and x0.625 on another average to x1.
  function average(elements, defendingList, attacker, mode = "pve") {
    const list = (defendingList || []).filter((defending) => defending?.length);
    if (!list.length) return 1;
    return Math.exp(list.reduce((sum, defending) => sum + Math.log(net(elements, defending, attacker, mode)), 0) / list.length);
  }

  // One entry per attacking element for a whole team: { id, name, color, value, tone }.
  function teamRow(elements, defendingList, mode = "pve") {
    return order(elements).map((id) => {
      const value = average(elements, defendingList, id, mode);
      return { id, name: elements[id].name || id, color: elements[id].color || "", value, tone: tone(value) };
    });
  }

  // Background, rings and spokes shared by both radars.
  function radarFrame(count, mode, label) {
    const chart = svg("svg", { viewBox: `0 0 ${RADAR.width} ${RADAR.height}`, role: "img", "aria-label": label });
    const even = radarRadius(1);
    chart.append(
      polygon(count, () => RADAR.outer, "matchup-radar-more"),
      polygon(count, () => even, "matchup-radar-cover"),
      polygon(count, () => even, "matchup-radar-less"),
    );
    steps(mode).forEach((value) => chart.append(polygon(count, () => radarRadius(value), "matchup-radar-ring")));
    chart.append(polygon(count, () => even, "matchup-radar-ring matchup-radar-ring--even"));
    for (let index = 0; index < count; index += 1) {
      const [fromX, fromY] = radarPoint(index, count, RADAR.inner);
      const [toX, toY] = radarPoint(index, count, RADAR.outer);
      chart.append(svg("line", { x1: fromX.toFixed(1), y1: fromY.toFixed(1), x2: toX.toFixed(1), y2: toY.toFixed(1), class: "matchup-radar-spoke" }));
    }
    return chart;
  }

  function radarName(chart, entry, index, count) {
    const [labelX, labelY] = radarPoint(index, count, RADAR.label);
    const swatch = svg("circle", { cx: (labelX - (entry.name.length * 3.3 + 9)).toFixed(1), cy: (labelY - 8).toFixed(1), r: 4 });
    if (entry.color) swatch.setAttribute("fill", entry.color);
    chart.append(swatch, svg("text", { x: (labelX + 4).toFixed(1), y: (labelY - 4).toFixed(1), class: "matchup-radar-name" }, entry.name));
    return [labelX, labelY];
  }

  function radarEven(chart, count) {
    const [evenX, evenY] = radarPoint(0, count, radarRadius(1));
    chart.append(svg("text", { x: (evenX + 5).toFixed(1), y: (evenY - 4).toFixed(1), class: "matchup-radar-even" }, "×1"));
  }

  // Two shapes on one radar: `sides` is [{ entries, name }, { entries, name }] with the same elements in the same
  // order. The first is drawn solid, the second dashed, and both values stand under each element's name.
  function renderCompareRadar(sides, { mode = "pve" } = {}) {
    const count = sides[0].entries.length;
    const box = html("div", "matchup-radar matchup-radar--compare");
    const label = sides.map((side) => `${side.name}: ${sentence(side.entries)}`).join(" ");
    const chart = radarFrame(count, mode, label);
    sides.forEach((side, sideIndex) => {
      const key = sideIndex ? "b" : "a";
      chart.append(polygon(count, (index) => radarRadius(side.entries[index].value), `matchup-compare-shape matchup-side-${key}`));
      side.entries.forEach((entry, index) => {
        const [x, y] = radarPoint(index, count, radarRadius(entry.value));
        chart.append(svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: 3.6, class: `matchup-compare-dot matchup-side-${key}` }));
      });
    });
    sides[0].entries.forEach((entry, index) => {
      const [labelX, labelY] = radarName(chart, entry, index, count);
      sides.forEach((side, sideIndex) => chart.append(svg("text", {
        x: (labelX + (sideIndex ? 17 : -15)).toFixed(1), y: (labelY + 11).toFixed(1),
        class: `matchup-compare-value matchup-side-${sideIndex ? "b" : "a"}`,
      }, format(side.entries[index].value))));
    });
    radarEven(chart, count);
    box.append(chart);
    const key = html("div", "matchup-compare-key");
    sides.forEach((side, sideIndex) => {
      const item = html("span", `matchup-side-${sideIndex ? "b" : "a"}`, side.name);
      item.prepend(html("i"));
      key.append(item);
    });
    box.append(key);
    return box;
  }

  // The radar: further out = takes more. `image` (a ready <img>, the Aniimo's head) sits in the middle.
  function renderRadar(entries, { mode = "pve", color = "", image = null } = {}) {
    const count = entries.length;
    const box = html("div", "matchup-radar");
    const chart = svg("svg", { viewBox: `0 0 ${RADAR.width} ${RADAR.height}`, role: "img", "aria-label": sentence(entries) });
    const even = radarRadius(1);
    chart.append(
      polygon(count, () => RADAR.outer, "matchup-radar-more"),
      polygon(count, () => even, "matchup-radar-cover"),
      polygon(count, () => even, "matchup-radar-less"),
    );
    steps(mode).forEach((value) => chart.append(polygon(count, () => radarRadius(value), "matchup-radar-ring")));
    chart.append(polygon(count, () => even, "matchup-radar-ring matchup-radar-ring--even"));
    entries.forEach((_, index) => {
      const [fromX, fromY] = radarPoint(index, count, RADAR.inner);
      const [toX, toY] = radarPoint(index, count, RADAR.outer);
      chart.append(svg("line", { x1: fromX.toFixed(1), y1: fromY.toFixed(1), x2: toX.toFixed(1), y2: toY.toFixed(1), class: "matchup-radar-spoke" }));
    });
    const shape = polygon(count, (index) => radarRadius(entries[index].value), "matchup-radar-shape");
    if (color) shape.style.setProperty("--type-color", color);
    chart.append(shape);
    entries.forEach((entry, index) => {
      const [x, y] = radarPoint(index, count, radarRadius(entry.value));
      const [labelX, labelY] = radarPoint(index, count, RADAR.label);
      chart.append(svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: entry.tone === "even" ? 3.5 : 5, class: `matchup-radar-dot matchup-tone-${entry.tone}` }));
      const swatch = svg("circle", { cx: (labelX - (entry.name.length * 3.3 + 9)).toFixed(1), cy: (labelY - 8).toFixed(1), r: 4 });
      if (entry.color) swatch.setAttribute("fill", entry.color);
      chart.append(
        swatch,
        svg("text", { x: (labelX + 4).toFixed(1), y: (labelY - 4).toFixed(1), class: "matchup-radar-name" }, entry.name),
        svg("text", { x: labelX.toFixed(1), y: (labelY + 11).toFixed(1), class: `matchup-radar-value matchup-tone-${entry.tone}` }, format(entry.value)),
      );
    });
    const [evenX, evenY] = radarPoint(0, count, even);
    chart.append(svg("text", { x: (evenX + 5).toFixed(1), y: (evenY - 4).toFixed(1), class: "matchup-radar-even" }, "×1"));
    box.append(chart);
    if (image) {
      image.classList.add("matchup-radar-head");
      box.append(image);
    }
    return box;
  }

  function renderLegend() {
    const legend = html("div", "matchup-legend");
    [["more", "takes more"], ["even", "normal"], ["less", "takes less"]].forEach(([key, label]) => {
      const item = html("span", "", label);
      item.prepend(html("i", `matchup-swatch matchup-swatch--${key}`));
      legend.append(item);
    });
    return legend;
  }

  function cellLevel(value) {
    if (value > 2) return "more-2";
    if (value > 1 + EPSILON) return "more-1";
    if (value < 0.5) return "less-2";
    if (value < 1 - EPSILON) return "less-1";
    return "even";
  }

  // The grid: one line per row ({ head: Node, defending: [ids], current?: bool, count?: false, className? }), one column per
  // attacking element. `foot` adds a last line counting the rows that take more from each element (not the
  // rows with count: false).
  function renderGrid(elements, rows, { mode = "pve", foot = "" } = {}) {
    const ids = order(elements);
    const scroll = html("div", "matchup-grid-scroll");
    const table = html("table", "matchup-grid");
    const head = html("tr");
    head.append(html("th", "matchup-grid-corner", "Damage taken from"));
    ids.forEach((id) => {
      const cell = html("th", "matchup-grid-element");
      const swatch = html("i", "matchup-grid-dot");
      if (elements[id].color) swatch.style.background = elements[id].color;
      cell.append(swatch, html("span", "", elements[id].name || id));
      cell.scope = "col";
      head.append(cell);
    });
    table.append(head);
    const counts = Object.fromEntries(ids.map((id) => [id, 0]));
    rows.forEach((line) => {
      const tr = html("tr", [line.current ? "is-current" : "", line.className || ""].filter(Boolean).join(" "));
      const name = html("th", "matchup-grid-head");
      name.scope = "row";
      name.append(line.head);
      tr.append(name);
      ids.forEach((id) => {
        const value = net(elements, line.defending, id, mode);
        if (line.count !== false && value > 1 + EPSILON) counts[id] += 1;
        tr.append(html("td", `matchup-cell matchup-cell--${cellLevel(value)}`, format(value)));
      });
      table.append(tr);
    });
    if (foot && rows.filter((line) => line.count !== false).length > 1) {
      const tr = html("tr", "matchup-grid-foot");
      const name = html("th", "matchup-grid-head", foot);
      name.scope = "row";
      tr.append(name);
      ids.forEach((id) => tr.append(html("td", `matchup-cell${counts[id] >= 2 ? " matchup-cell--risk" : ""}`, counts[id] ? String(counts[id]) : "–")));
      table.append(tr);
    }
    scroll.append(table);
    return scroll;
  }

  window.AniilogsMatchups = Object.freeze({
    MODES, PVE_NOTE, PVP_NOTE, net, steps, format, tone, order, row, groups, sentence, radarRadius, radarPoint,
    average, teamRow, renderRadar, renderCompareRadar, renderLegend, renderGrid,
    note: (mode) => (mode === "pvp" ? PVP_NOTE : PVE_NOTE),
  });
})();
