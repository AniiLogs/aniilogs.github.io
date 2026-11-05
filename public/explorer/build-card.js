// A shareable picture of one Aniimo's build (Team Builder, Build tab): drawn in the browser on a canvas and handed
// to the player to copy, save or share. Nothing is uploaded and no link is made: the picture is the share.
// draw(spec) -> Promise<HTMLCanvasElement>; spec is plain data built by team-builder.js (buildCardSpec):
// { name, formLabel, role, icon, elements: [{ name, color }], level, cp, personality, perfect,
//   stats: [{ stat, value, potential }], skills: [{ name, icon, slot }], heldItem: { name, icon, rarity, level } | null,
//   starUp: { stage, level } | null, research: [labels], aniilog: { forms, prismana }, footer }
(() => {
  "use strict";

  const WIDTH = 1200;
  const HEIGHT = 675;
  const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, sans-serif';
  const COLORS = Object.freeze({
    bg: "#0c1417", panel: "#132126", panel2: "#1a2c32", line: "rgba(255,255,255,0.08)",
    text: "#eef6f4", muted: "#9fb5b0", accent: "#62d9b3", gold: "#f4bd4f",
  });
  const RARITY = Object.freeze({ Common: "#b8c4c2", Uncommon: "#6fd08c", Rare: "#4da3ff", Epic: "#b57cff", Legendary: "#f2a93b" });

  // Icons come from the content server (CORS open), read as blobs so the canvas stays exportable.
  async function loadImage(url) {
    if (!url) return null;
    try {
      const response = await fetch(url, { mode: "cors" });
      if (!response.ok) return null;
      return await createImageBitmap(await response.blob());
    } catch {
      return null;
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function panel(ctx, x, y, w, h, fill = COLORS.panel) {
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function text(ctx, value, x, y, { size = 16, weight = 400, color = COLORS.text, align = "left", max = 0 } = {}) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    let shown = String(value ?? "");
    if (max > 0 && ctx.measureText(shown).width > max) {
      while (shown.length > 1 && ctx.measureText(`${shown}…`).width > max) shown = shown.slice(0, -1);
      shown = `${shown}…`;
    }
    ctx.fillText(shown, x, y);
    return ctx.measureText(shown).width;
  }

  function drawIcon(ctx, image, x, y, size) {
    if (!image) {
      roundRect(ctx, x, y, size, size, size / 5);
      ctx.fillStyle = COLORS.panel2;
      ctx.fill();
      return;
    }
    const scale = Math.min(size / image.width, size / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, x + (size - w) / 2, y + (size - h) / 2, w, h);
  }

  function chip(ctx, label, x, y, color) {
    ctx.font = `600 15px ${FONT}`;
    const w = ctx.measureText(label).width + 22;
    roundRect(ctx, x, y, w, 26, 13);
    ctx.fillStyle = `${color}33`;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    text(ctx, label, x + 11, y + 18, { size: 15, weight: 600, color: COLORS.text });
    return w;
  }

  async function draw(spec) {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    const lead = spec.elements?.[0]?.color || COLORS.accent;

    const [portrait, held, ...skillIcons] = await Promise.all([
      loadImage(spec.icon), loadImage(spec.heldItem?.icon), ...(spec.skills || []).map((skill) => loadImage(skill.icon)),
    ]);

    // Background: dark, tinted by the first element.
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const glow = ctx.createRadialGradient(220, 230, 20, 220, 230, 520);
    glow.addColorStop(0, `${lead}55`);
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Left: the Aniimo.
    const left = 40;
    drawIcon(ctx, portrait, left + 30, 40, 300);
    text(ctx, spec.name, left, 380, { size: 38, weight: 700, max: 380 });
    text(ctx, [spec.formLabel, spec.role].filter(Boolean).join(" · "), left, 410, { size: 18, color: COLORS.muted, max: 380 });
    let chipX = left;
    (spec.elements || []).forEach((element) => { chipX += chip(ctx, element.name, chipX, 426, element.color || COLORS.accent) + 8; });

    panel(ctx, left, 472, 380, 116);
    text(ctx, "LEVEL", left + 20, 502, { size: 13, weight: 700, color: COLORS.muted });
    text(ctx, String(spec.level ?? "–"), left + 20, 552, { size: 44, weight: 700 });
    text(ctx, "CP", left + 150, 502, { size: 13, weight: 700, color: COLORS.muted });
    text(ctx, Number.isFinite(spec.cp) ? spec.cp.toLocaleString("en-US") : "–", left + 150, 552, { size: 44, weight: 700, color: COLORS.gold });
    const tags = [spec.personality ? `Personality ${spec.personality}` : "", spec.perfect ? "Perfect" : ""].filter(Boolean).join(" · ");
    if (tags) text(ctx, tags, left + 20, 576, { size: 15, color: COLORS.muted, max: 340 });

    // Right: stats.
    const rx = 460;
    const rw = WIDTH - rx - 40;
    text(ctx, "STATS", rx, 58, { size: 13, weight: 700, color: COLORS.muted });
    const cellW = (rw - 20) / 3;
    (spec.stats || []).forEach((row, index) => {
      const x = rx + (index % 3) * (cellW + 10);
      const y = 70 + Math.floor(index / 3) * 86;
      panel(ctx, x, y, cellW, 76);
      text(ctx, row.stat, x + 16, y + 26, { size: 14, weight: 700, color: COLORS.muted });
      text(ctx, row.value === null || row.value === undefined ? "–" : Number(row.value).toLocaleString("en-US"), x + 16, y + 62, { size: 30, weight: 700 });
      if (row.potential) text(ctx, `Potential ${row.potential}`, x + cellW - 14, y + 26, { size: 13, color: COLORS.accent, align: "right" });
    });

    // Skills: the picks, the switch-skill, then the Ultimate.
    text(ctx, "SKILLS", rx, 268, { size: 13, weight: 700, color: COLORS.muted });
    const skills = spec.skills || [];
    const skillW = skills.length ? (rw - 10 * (skills.length - 1)) / skills.length : rw;
    skills.forEach((skill, index) => {
      const x = rx + index * (skillW + 10);
      const ultimate = skill.slot === "Ultimate";
      panel(ctx, x, 280, skillW, 132, ultimate ? "#2a2416" : COLORS.panel);
      drawIcon(ctx, skillIcons[index], x + (skillW - 56) / 2, 290, 56);
      text(ctx, skill.name, x + skillW / 2, 372, { size: 16, weight: 600, align: "center", max: skillW - 16 });
      text(ctx, skill.slot, x + skillW / 2, 396, { size: 13, color: ultimate ? COLORS.gold : COLORS.muted, align: "center", max: skillW - 16 });
    });
    if (!skills.length) text(ctx, "No skills chosen", rx, 320, { size: 16, color: COLORS.muted });

    // Held item, Star Up and the Aniilog bonuses.
    const boxW = (rw - 20) / 3;
    const by = 428;
    panel(ctx, rx, by, boxW, 160);
    text(ctx, "HELD ITEM", rx + 16, by + 26, { size: 13, weight: 700, color: COLORS.muted });
    if (spec.heldItem) {
      drawIcon(ctx, held, rx + 16, by + 40, 64);
      text(ctx, spec.heldItem.name, rx + 92, by + 66, { size: 17, weight: 600, max: boxW - 104 });
      const rarity = spec.heldItem.rarity || "";
      text(ctx, [rarity, spec.heldItem.level ? `Lv ${spec.heldItem.level}` : ""].filter(Boolean).join(" · "), rx + 92, by + 90,
        { size: 14, color: RARITY[rarity] || COLORS.muted, max: boxW - 104 });
    } else text(ctx, "None", rx + 16, by + 70, { size: 18, color: COLORS.muted });

    const sx = rx + boxW + 10;
    panel(ctx, sx, by, boxW, 160);
    text(ctx, "STAR UP", sx + 16, by + 26, { size: 13, weight: 700, color: COLORS.muted });
    if (spec.starUp?.stage) {
      text(ctx, "★".repeat(Math.min(7, spec.starUp.stage)), sx + 16, by + 70, { size: 26, color: COLORS.gold, max: boxW - 32 });
      text(ctx, `Stage ${spec.starUp.stage}${spec.starUp.level ? ` · Level ${spec.starUp.level}` : ""}`, sx + 16, by + 98, { size: 16 });
    } else text(ctx, "None", sx + 16, by + 70, { size: 18, color: COLORS.muted });

    const ax = sx + boxW + 10;
    panel(ctx, ax, by, boxW, 160);
    text(ctx, "ANIILOG", ax + 16, by + 26, { size: 13, weight: 700, color: COLORS.muted });
    const lines = [
      spec.aniilog ? `Forms caught ${spec.aniilog.forms}${spec.aniilog.total ? `/${spec.aniilog.total}` : ""}` : "",
      spec.aniilog?.prismana ? `Prismana caught ${spec.aniilog.prismana}` : "",
      ...(spec.research || []).map((label) => `${label} researched`),
      spec.coreUpgraded ? "Core skill upgraded" : "",
    ].filter(Boolean);
    lines.slice(0, 5).forEach((line, index) => text(ctx, line, ax + 16, by + 56 + index * 22, { size: 15, max: boxW - 32 }));

    // Footer.
    text(ctx, spec.footer || "aniilogs.github.io", WIDTH - 40, HEIGHT - 28, { size: 14, color: COLORS.muted, align: "right" });
    text(ctx, "aLogs Team Builder", left, HEIGHT - 28, { size: 14, weight: 700, color: COLORS.accent });
    return canvas;
  }

  const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The card could not be drawn."))), "image/png"));

  window.AniilogsBuildCard = Object.freeze({ draw, toBlob, WIDTH, HEIGHT });
})();
