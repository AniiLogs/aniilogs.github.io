// The profile's cards in the order its owner arranged them. The cards themselves are the page's
// [data-overview-panel] articles, so a card the site adds later joins without changes here or on the server:
// a card the saved order doesn't name goes last, shown, until the owner arranges it.
(function (root) {
  const WIDTHS = [1, 2, 3];                          // columns a card takes (where the page has that many)
  // "" = the default: no taller than the Collection card (which sets it); "none" = as tall as it needs
  const HEIGHTS = ["", "short", "medium", "tall", "none"];

  // cards: [{ id, title }] as the page lists them; layout: { order, hidden, widths, heights } as saved (any may be missing)
  function arrangeCards(cards, layout) {
    const known = new Map(cards.map((card) => [card.id, card]));
    const order = (layout?.order || []).filter((id) => known.has(id));
    const hidden = new Set(layout?.hidden || []);
    const widths = layout?.widths || {};
    const heights = layout?.heights || {};
    const rest = cards.filter((card) => !order.includes(card.id));
    return [...order.map((id) => known.get(id)), ...rest].map((card) => ({
      ...card,
      hidden: hidden.has(card.id),
      width: WIDTHS.includes(widths[card.id]) ? widths[card.id] : 1,
      height: HEIGHTS.includes(heights[card.id]) ? heights[card.id] : "",
    }));
  }

  // what is saved for an arranged list (the site's default saves as empty lists)
  function layoutOf(list, cards) {
    const order = list.map((card) => card.id);
    const hidden = list.filter((card) => card.hidden).map((card) => card.id);
    const widths = Object.fromEntries(list.filter((card) => card.width > 1).map((card) => [card.id, card.width]));
    const heights = Object.fromEntries(list.filter((card) => card.height).map((card) => [card.id, card.height]));
    const sized = Object.keys(widths).length || Object.keys(heights).length;
    const isDefault = !hidden.length && !sized && order.join() === cards.map((card) => card.id).join();
    if (isDefault) return { order: [], hidden: [] };
    const layout = { order, hidden };
    if (Object.keys(widths).length) layout.widths = widths;
    if (Object.keys(heights).length) layout.heights = heights;
    return layout;
  }

  // the list with one card moved by step (-1 up, +1 down) or to an index (drag and drop)
  function moveCard(list, id, { step, to } = {}) {
    const from = list.findIndex((card) => card.id === id);
    if (from < 0) return list;
    const target = Math.max(0, Math.min(list.length - 1, to ?? from + step));
    const next = list.slice();
    const [card] = next.splice(from, 1);
    next.splice(target, 0, card);
    return next;
  }

  root.AniiProfileCards = { arrangeCards, layoutOf, moveCard, WIDTHS, HEIGHTS };
})(window);
