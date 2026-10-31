// Type-to-filter for the site's Aniimo dropdowns (Team Builder slots, 1v1 sides). It wraps an existing
// <select>, which stays the source of truth: picking an entry sets the select's value and fires its
// "change" event, so the code that built the select keeps working unchanged.
// Each option can carry extra words in data-search (element names, Aniilog number); every word typed
// has to appear in the option's text, its group or those extra words.
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
    return rows.map((row) => ({ ...row, haystack: fold(`${row.option.textContent} ${row.group} ${row.option.dataset.search || ""}`) }));
  }

  // Returns { wrap, input, list, close }, or null when the select is missing or already enhanced.
  function enhance(select, { placeholder = "Type a name, form or element" } = {}) {
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

    // In the page already: the picker takes the select's place. Otherwise the caller adds `wrap`.
    if (select.parentNode) select.parentNode.insertBefore(wrap, select);
    wrap.append(input, list, select);
    select.classList.add("aniimo-picker-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const entries = entriesOf(select);
    let shown = [];
    let active = -1;
    const selectedText = () => select.selectedOptions[0]?.textContent || "";
    const showSelected = () => { input.value = select.value ? selectedText() : ""; };

    // The list is fixed to the window so a scrolling sidebar can't clip it: under the box, or above it
    // when there's more room there.
    function place() {
      if (list.hidden) return;
      const box = input.getBoundingClientRect();
      const below = window.innerHeight - box.bottom - 8;
      const above = box.top - 8;
      const up = below < 200 && above > below;
      const height = Math.max(120, Math.min(320, (up ? above : below) - 4));
      Object.assign(list.style, {
        left: `${Math.round(box.left)}px`,
        width: `${Math.round(box.width)}px`,
        maxHeight: `${Math.round(height)}px`,
        top: up ? "" : `${Math.round(box.bottom + 4)}px`,
        bottom: up ? `${Math.round(window.innerHeight - box.top + 4)}px` : "",
      });
    }
    const onMove = () => place();

    function close() {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      list.hidden = true;
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
      shown = entries.filter((entry) => words.every((word) => entry.haystack.includes(word)));
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
        item.textContent = entry.option.textContent;
        // mousedown runs before the input's blur, so the pick isn't lost when the list closes.
        item.addEventListener("mousedown", (event) => { event.preventDefault(); choose(index); });
        list.append(item);
      });
      if (!shown.length) {
        const empty = document.createElement("li");
        empty.className = "aniimo-picker-empty";
        empty.setAttribute("role", "presentation");
        empty.textContent = "No Aniimo match";
        list.append(empty);
      }
      if (list.hidden) {
        window.addEventListener("scroll", onMove, true);
        window.addEventListener("resize", onMove);
      }
      list.hidden = false;
      place();
      input.setAttribute("aria-expanded", "true");
      setActive(shown.length ? 0 : -1);
    }

    function choose(index) {
      const entry = shown[index];
      if (!entry) return;
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
    input.addEventListener("input", () => render(input.value));
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
    return { wrap, input, list, close };
  }

  window.AniilogsPicker = Object.freeze({ enhance });
})();
