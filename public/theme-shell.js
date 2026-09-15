(() => {
  const PREFERENCES_KEY = "aniilogs:explorer:preferences:v1";
  const LEGACY_MODE_KEY = "aniilogs:color-mode:v1";
  const PRESETS = Object.freeze({
    default: Object.freeze({
      label: "AniiLogs Night",
      motif: "signal",
      colors: Object.freeze({
        background: "#0b1215", backgroundAlt: "#10242a", surface: "#121d21",
        surfaceRaised: "#1a2a2f", border: "#315057", text: "#f4f4e9",
        muted: "#9bb5b2", primary: "#62d9b3", secondary: "#2d9d82", highlight: "#f4bd4f",
      }),
    }),
    meadow: Object.freeze({
      label: "AniiLogs Meadow",
      motif: "signal",
      colors: Object.freeze({
        background: "#f8f2d7", backgroundAlt: "#ccebe4", surface: "#fffaf0",
        surfaceRaised: "#f3edd8", border: "#b7d2c7", text: "#24473f",
        muted: "#506a62", primary: "#4fcda5", secondary: "#258c76", highlight: "#f4bd4f",
      }),
    }),
    emberpup: Object.freeze({
      label: "Emberpup",
      motif: "paw",
      colors: Object.freeze({
        background: "#111218", backgroundAlt: "#2b1815", surface: "#1c1d27",
        surfaceRaised: "#292a36", border: "#4b4650", text: "#fff4e8",
        muted: "#bdb4b5", primary: "#ff742e", secondary: "#d9471d", highlight: "#ffc857",
      }),
    }),
    pawney: Object.freeze({
      label: "Pawney",
      motif: "armor",
      colors: Object.freeze({
        background: "#0e1120", backgroundAlt: "#171b3a", surface: "#171b2d",
        surfaceRaised: "#232844", border: "#444d76", text: "#f5f4ff",
        muted: "#aeb3cf", primary: "#7a84f7", secondary: "#4d57bc", highlight: "#ee8bd4",
      }),
    }),
  });
  const COLOR_KEYS = Object.keys(PRESETS.default.colors);
  const HOME_ACCENTS = Object.freeze({
    default: Object.freeze({ teal: "#79e5c2", coral: "#f48972" }),
    meadow: Object.freeze({ teal: "#1c756b", coral: "#b84c3b" }),
    emberpup: Object.freeze({ teal: "#ffad82", coral: "#ff742e" }),
    pawney: Object.freeze({ teal: "#adb5ff", coral: "#ee8bd4" }),
  });

  function normalizeHex(value, fallback) {
    const source = String(value || "").trim();
    const expanded = /^#[0-9a-f]{3}$/iu.test(source)
      ? `#${source.slice(1).split("").map((part) => part + part).join("")}`
      : source;
    return /^#[0-9a-f]{6}$/iu.test(expanded) ? expanded.toLowerCase() : fallback;
  }

  function normalizeColors(value, fallback = PRESETS.default.colors) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(COLOR_KEYS.map((key) => [key, normalizeHex(source[key], fallback[key])]));
  }

  function readPreferences() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) || "{}");
      const storedTheme = String(parsed.theme || "").toLowerCase();
      if (storedTheme === "custom" || Object.hasOwn(PRESETS, storedTheme)) return parsed;
      const legacyMode = window.localStorage.getItem(LEGACY_MODE_KEY);
      return { ...parsed, theme: legacyMode === "light" ? "meadow" : "default" };
    } catch {
      return { theme: "default" };
    }
  }

  function rgb(hex) {
    return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  }

  function relativeLuminance(hex) {
    const channels = rgb(hex).map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(first, second) {
    const light = Math.max(relativeLuminance(first), relativeLuminance(second));
    const dark = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (light + 0.05) / (dark + 0.05);
  }

  function readableText(background) {
    return contrastRatio("#08110f", background) >= contrastRatio("#fffdf3", background)
      ? "#08110f"
      : "#fffdf3";
  }

  function paletteFor(theme, customTheme) {
    if (theme === "custom") return normalizeColors(customTheme, PRESETS.default.colors);
    return normalizeColors(PRESETS[theme]?.colors || PRESETS.default.colors);
  }

  function syncControls(theme) {
    document.querySelectorAll("[data-site-theme-select]").forEach((select) => {
      if (theme === "custom" && !select.querySelector('option[value="custom"]')) {
        select.add(new Option("Custom", "custom"));
      }
      select.value = theme;
      select.setAttribute("aria-label", `Website theme: ${select.selectedOptions[0]?.textContent || theme}`);
    });
  }

  function apply(theme, customTheme, { persist = false, notify = false } = {}) {
    const id = theme === "custom" || Object.hasOwn(PRESETS, theme) ? theme : "default";
    const colors = paletteFor(id, customTheme);
    const [backgroundR, backgroundG, backgroundB] = rgb(colors.background);
    const [panelR, panelG, panelB] = rgb(colors.surface);
    const [primaryR, primaryG, primaryB] = rgb(colors.primary);
    const [highlightR, highlightG, highlightB] = rgb(colors.highlight);
    const luminance = (backgroundR * 299 + backgroundG * 587 + backgroundB * 114) / 1000;
    const homeAccents = HOME_ACCENTS[id] || { teal: colors.primary, coral: colors.secondary };
    const root = document.documentElement;
    root.dataset.theme = id;
    root.dataset.themeMotif = id === "custom" ? "custom" : PRESETS[id].motif;
    root.dataset.colorMode = luminance >= 150 ? "light" : "dark";
    root.style.colorScheme = luminance >= 150 ? "light" : "dark";
    const variables = {
      "--background": colors.background, "--background-2": colors.backgroundAlt,
      "--background-rgb": `${backgroundR}, ${backgroundG}, ${backgroundB}`,
      "--panel": colors.surface, "--panel-2": colors.surfaceRaised,
      "--panel-rgb": `${panelR}, ${panelG}, ${panelB}`, "--line": colors.border,
      "--text": colors.text, "--muted": colors.muted, "--accent": colors.primary,
      "--accent-strong": colors.secondary, "--accent-rgb": `${primaryR}, ${primaryG}, ${primaryB}`,
      "--accent-2": colors.highlight, "--accent-2-rgb": `${highlightR}, ${highlightG}, ${highlightB}`,
      "--ink": colors.text, "--ink-soft": colors.muted, "--cream": colors.surface,
      "--paper": colors.background, "--mint": colors.primary, "--mint-dark": colors.secondary,
      "--teal": homeAccents.teal, "--gold": colors.highlight, "--coral": homeAccents.coral,
      "--on-primary": readableText(colors.primary), "--on-highlight": readableText(colors.highlight),
      "--on-coral": readableText(homeAccents.coral), "--on-lavender": readableText("#9d91dc"),
    };
    Object.entries(variables).forEach(([name, value]) => root.style.setProperty(name, value));
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", colors.surface);
    syncControls(id);
    if (persist) {
      try {
        const current = readPreferences();
        window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
          ...current,
          theme: id,
          customTheme: normalizeColors(customTheme || current.customTheme || colors),
        }));
        window.localStorage.setItem(LEGACY_MODE_KEY, luminance >= 150 ? "light" : "dark");
      } catch {
        // The chosen theme still applies to the current page when storage is unavailable.
      }
    }
    if (notify) window.dispatchEvent(new CustomEvent("aniilogs:themechange", { detail: { theme: id, colors } }));
    return colors;
  }

  function bindControls() {
    document.querySelectorAll("[data-site-theme-select]").forEach((select) => {
      select.addEventListener("change", () => {
        const preferences = readPreferences();
        apply(select.value, preferences.customTheme, { persist: true, notify: true });
      });
    });
    const preferences = readPreferences();
    syncControls(String(preferences.theme || "default").toLowerCase());
  }

  function bindAccountMenus() {
    document.querySelectorAll("[data-account-menu]").forEach((menu) => {
      let closeTimer = 0;
      let openedByHover = false;
      const cancelClose = () => window.clearTimeout(closeTimer);
      const openForPointer = (event) => {
        if (event.pointerType && event.pointerType !== "mouse") return;
        cancelClose();
        if (!menu.open) {
          menu.open = true;
          openedByHover = true;
        }
      };
      const closeAfterPointer = () => {
        cancelClose();
        closeTimer = window.setTimeout(() => {
          if (!menu.matches(":focus-within")) menu.open = false;
        }, 140);
      };
      menu.addEventListener("pointerenter", openForPointer);
      menu.addEventListener("pointerleave", closeAfterPointer);
      menu.querySelector("summary")?.addEventListener("click", (event) => {
        if (!openedByHover) return;
        event.preventDefault();
        openedByHover = false;
      });
      menu.addEventListener("focusin", cancelClose);
      menu.addEventListener("focusout", closeAfterPointer);
      menu.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        menu.open = false;
        menu.querySelector("summary")?.focus();
      });
    });
  }

  function bindShell() {
    bindControls();
    bindAccountMenus();
  }

  const initial = readPreferences();
  apply(String(initial.theme || "default").toLowerCase(), initial.customTheme);
  window.AniiLogsTheme = Object.freeze({ PRESETS, apply, bindControls, readPreferences, syncControls });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindShell, { once: true });
  else bindShell();
})();
