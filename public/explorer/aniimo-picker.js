// Type-to-filter for the site's dropdowns (Aniimo, held items, skills, Star Up, saved teams, 1v1 settings). It wraps an existing
// <select>, which stays the source of truth: picking an entry sets the select's value and fires its
// "change" event, so the code that built the select keeps working unchanged.
// Each option can carry extra words in data-search (element names, Aniilog number); every word typed
// has to appear somewhere in the option's text, its group or those extra words ("fulm", "lightning"), and a
// "#45" word matches the number 45 (also written #045). Matches are highlighted in the list.
(() => {
  let nextId = 0;

  const fold = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();

  function entriesOf(select) {
    const rows = [];
    for (const child of select.children) {
      if (child.tagName === "OPTGROUP") {
        for (const option of child.children) rows.push({ option, group: child.label });
      } else if (child.tagName === "OPTION") {
        rows.push({ option: child, group: "" });
      }
    }
    return rows.map((row) => {
      const haystack = fold(`${row.option.textContent} ${row.group} ${row.option.dataset.search || ""}`);
      const numbers = new Set((haystack.match(/\d+/gu) || []).map((digits) => String(Number(digits))));
      return { ...row, haystack, numbers };
    });
  }

  const matches = (entry, word) => (/^#\d+$/u.test(word) ? entry.numbers.has(String(Number(word.slice(1))))
    : entry.haystack.includes(word.replace(/^#/u, "")));

  // The option's text with every typed word marked, as DOM nodes (no HTML parsing of game text).
  function highlighted(text, words) {
    const chars = [...text];
    const folded = chars.map((char) => fold(char));
    const flat = folded.join("");
    // Index in `flat` -> index in `chars`.
    const owner = [];
    folded.forEach((part, index) => { for (let step = 0; step < part.length; step += 1) owner.push(index); });
    const marked = new Array(chars.length).fill(false);
    for (const word of words.map((value) => value.replace(/^#/u, "")).filter(Boolean)) {
      let at = flat.indexOf(word);
      while (at >= 0) {
        for (let index = at; index < at + word.length; index += 1) marked[owner[index]] = true;
        at = flat.indexOf(word, at + word.length);
      }
    }
    const nodes = [];
    let run = "";
    let runMarked = false;
    const flush = () => {
      if (!run) return;
      if (runMarked) {
        const mark = document.createElement("mark");
        mark.textContent = run;
        nodes.push(mark);
      } else {
        nodes.push(document.createTextNode(run));
      }
      run = "";
    };
    chars.forEach((char, index) => {
      if (marked[index] !== runMarked) { flush(); runMarked = marked[index]; }
      run += char;
    });
    flush();
    return nodes;
  }

  // Returns { wrap, input, list, close }, or null when the select is missing or already enhanced.
  function enhance(select, { placeholder = "Type to filter", emptyText = "No matches" } = {}) {
    if (!select || select.dataset.pickerEnhanced) return null;
    select.dataset.pickerEnhanced = "true";
    const id = `aniimo-picker-${nextId += 1}`;
    const wrap = document.createElement("div");
    wrap.className = "aniimo-picker";
    const input = document.createElement("input");
    input.type = "text";
    input.className = `${select.className} aniimo-picker-input`.trim();
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", `${id}-list`);
    input.setAttribute("aria-label", select.getAttribute("aria-label") || "Aniimo");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = placeholder;
    const list = document.createElement("ul");
    list.className = "aniimo-picker-list";
    list.id = `${id}-list`;
    list.setAttribute("role", "listbox");
    list.hidden = true;

    // Empties the text box (the chosen entry stays until another is picked).
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "aniimo-picker-clear";
    clear.tabIndex = -1;
    clear.setAttribute("aria-label", "Clear the search");
    clear.textContent = "×";
    clear.hidden = true;

    // In the page already: the picker takes the select's place. Otherwise the caller adds `wrap`.
    if (select.parentNode) select.parentNode.insertBefore(wrap, select);
    wrap.append(input, clear, list, select);
    select.classList.add("aniimo-picker-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    let entries = entriesOf(select);
    let shown = [];
    let active = -1;
    const selectedText = () => select.selectedOptions[0]?.textContent || "";
    const showClear = () => { clear.hidden = !input.value || input.disabled; };
    const showSelected = () => { input.value = select.value ? selectedText() : ""; showClear(); };

    // The list is fixed to the window so a scrolling sidebar can't clip it: under the box, or above it
    // when there's more room there. While open it sits in <body>: a panel with CSS containment (the Team
    // Builder's map-panel has contain: layout paint) would otherwise offset the fixed list and cut it off.
    function place() {
      if (list.hidden) return;
      if (!input.isConnected) { close(); return; }
      const box = input.getBoundingClientRect();
      // Narrow boxes (a 1v1 hit-strength cell) still get a readable list, kept inside the window.
      const width = Math.min(Math.max(box.width, 160), window.innerWidth - 16);
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
      const below = window.innerHeight - box.bottom - 8;
      const above = box.top - 8;
      const up = below < 200 && above > below;
      const height = Math.max(120, Math.min(320, (up ? above : below) - 4));
      Object.assign(list.style, {
        left: `${Math.round(left)}px`,
        width: `${Math.round(width)}px`,
        maxHeight: `${Math.round(height)}px`,
        top: up ? "" : `${Math.round(box.bottom + 4)}px`,
        bottom: up ? `${Math.round(window.innerHeight - box.top + 4)}px` : "",
      });
    }
    const onMove = () => place();
    // Phones: the on-screen keyboard shrinks the visual viewport; keep the list beside the box.
    const viewport = window.visualViewport;

    function close() {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      viewport?.removeEventListener("resize", onMove);
      viewport?.removeEventListener("scroll", onMove);
      list.hidden = true;
      if (list.parentNode !== wrap) wrap.insertBefore(list, select);
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function setActive(index) {
      const items = list.querySelectorAll("[role=option]");
      items.forEach((item, position) => item.classList.toggle("is-active", position === index));
      active = index;
      const item = items[index];
      if (item) {
        input.setAttribute("aria-activedescendant", item.id);
        item.scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function render(query) {
      const words = fold(query).split(/\s+/u).filter(Boolean);
      shown = entries.filter((entry) => words.every((word) => matches(entry, word)));
      list.textContent = "";
      let group = null;
      shown.forEach((entry, index) => {
        if (entry.group && entry.group !== group) {
          group = entry.group;
          const header = document.createElement("li");
          header.className = "aniimo-picker-group";
          header.setAttribute("role", "presentation");
          header.textContent = group;
          list.append(header);
        }
        const item = document.createElement("li");
        item.id = `${id}-option-${index}`;
        item.className = "aniimo-picker-option";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(entry.option.selected && entry.option.value === select.value));
        item.append(...highlighted(entry.option.textContent, words));
        if (entry.option.disabled) {
          item.classList.add("is-disabled");
          item.setAttribute("aria-disabled", "true");
        }
        // mousedown runs before the input's blur, so the pick isn't lost when the list closes.
        item.addEventListener("mousedown", (event) => { event.preventDefault(); choose(index); });
        list.append(item);
      });
      if (!shown.length) {
        const empty = document.createElement("li");
        empty.className = "aniimo-picker-empty";
        empty.setAttribute("role", "presentation");
        empty.textContent = emptyText;
        list.append(empty);
      }
      if (list.hidden) {
        document.body.append(list);
        window.addEventListener("scroll", onMove, true);
        window.addEventListener("resize", onMove);
        viewport?.addEventListener("resize", onMove);
        viewport?.addEventListener("scroll", onMove);
      }
      list.hidden = false;
      place();
      input.setAttribute("aria-expanded", "true");
      setActive(shown.findIndex((entry) => !entry.option.disabled));
    }

    function choose(index) {
      const entry = shown[index];
      if (!entry || entry.option.disabled) return;
      close();
      if (entry.option.value === select.value && entry.option.selected) {
        showSelected();
        return;
      }
      entry.option.selected = true;
      select.value = entry.option.value;
      showSelected();
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    input.addEventListener("focus", () => { input.select(); render(""); });
    input.addEventListener("input", () => { showClear(); render(input.value); });
    // mousedown so the box keeps focus (and the list stays open) while the text is cleared.
    clear.addEventListener("mousedown", (event) => {
      event.preventDefault();
      input.value = "";
      showClear();
      if (document.activeElement !== input) input.focus();
      render("");
    });
    input.addEventListener("blur", () => { close(); showSelected(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (list.hidden) render("");
        else if (shown.length) setActive((active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
      } else if (event.key === "Enter") {
        if (!list.hidden && active >= 0) { event.preventDefault(); choose(active); }
      } else if (event.key === "Escape") {
        if (!list.hidden) { event.preventDefault(); close(); showSelected(); }
      }
    });
    showSelected();
    // refresh(): re-read the select after its options or value changed in code (the "change" event isn't
    // fired for those), so the list and the box match it again.
    function refresh() {
      entries = entriesOf(select);
      if (!list.hidden) render(input.value);
      else showSelected();
    }
    return { wrap, input, list, close, refresh };
  }

  // makeCombobox(select, { placeholder, emptyText }) is the same call under the name other pages use.
  window.AniilogsPicker = Object.freeze({ enhance, makeCombobox: enhance });
})();
