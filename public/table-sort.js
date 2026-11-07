// Sorting a table by its column headers, like a spreadsheet: click a header to sort by it, click it again to flip
// the order. Shared by the leaderboards, My runs and the 1v1 tab. Empty values (none, "", "—") always go last.
(() => {
  const blank = (value) => value === null || value === undefined || value === ""
    || (typeof value === "number" && !Number.isFinite(value));
  const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;
  function compare(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    const x = String(a);
    const y = String(b);
    return collator ? collator.compare(x, y) : x < y ? -1 : x > y ? 1 : 0;
  }
  // A sorted copy; equal rows keep their order (so a list the server ranked stays ranked within ties).
  function sortRows(rows, value, order = "asc") {
    const flip = order === "desc" ? -1 : 1;
    return rows.map((row, index) => ({ row, index, key: value(row) }))
      .sort((a, b) => {
        const emptyA = blank(a.key);
        const emptyB = blank(b.key);
        if (emptyA || emptyB) return emptyA === emptyB ? a.index - b.index : emptyA ? 1 : -1;
        return flip * compare(a.key, b.key) || a.index - b.index;
      })
      .map((item) => item.row);
  }
  // The sort after clicking `key`: the same column flips, another starts in its natural order.
  function nextSort(current, key, natural = "asc") {
    if (current?.key === key) return { key, order: current.order === "asc" ? "desc" : "asc" };
    return { key, order: natural === "desc" ? "desc" : "asc" };
  }
  function ariaSort(active, order) {
    return active ? (order === "asc" ? "ascending" : "descending") : null;
  }
  // A header's button: its label, with ▲ or ▼ while the table is sorted by it. The header cell gets aria-sort.
  function headerButton(label, { active = false, order = "asc", onSort, className = "table-sort" } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = active ? `${className} is-active` : className;
    button.textContent = label + (active ? (order === "asc" ? " ▲" : " ▼") : "");
    button.title = `Sort by ${label}`;
    if (onSort) button.addEventListener("click", onSort);
    return button;
  }
  function fillHeader(cell, label, options = {}) {
    const sort = ariaSort(options.active, options.order);
    if (sort) cell.setAttribute("aria-sort", sort); else cell.removeAttribute("aria-sort");
    cell.replaceChildren(headerButton(label, options));
    return cell;
  }
  window.AniilogsTableSort = Object.freeze({ compare, sortRows, nextSort, ariaSort, headerButton, fillHeader });
})();
