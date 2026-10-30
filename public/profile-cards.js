// The profile's cards in the order its owner arranged them. The cards themselves are the page's
// [data-overview-panel] articles, so a card the site adds later joins without changes here or on the server:
// a card the saved order doesn't name goes last, shown, until the owner arranges it.
(function (root) {
  // cards: [{ id, title }] as the page lists them; layout: { order, hidden } as saved (either may be missing)
  function arrangeCards(cards, layout) {
    const known = new Map(cards.map((card) => [card.id, card]));
    const order = (layout?.order || []).filter((id) => known.has(id));
    const hidden = new Set(layout?.hidden || []);
    const rest = cards.filter((card) => !order.includes(card.id));
    return [...order.map((id) => known.get(id)), ...rest].map((card) => ({ ...card, hidden: hidden.has(card.id) }));
  }

  // what is saved for an arranged list (the site's default saves as empty lists)
  function layoutOf(list, cards) {
    const order = list.map((card) => card.id);
    const hidden = list.filter((card) => card.hidden).map((card) => card.id);
    const isDefault = !hidden.length && order.join() === cards.map((card) => card.id).join();
    return isDefault ? { order: [], hidden: [] } : { order, hidden };
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

  root.AniiProfileCards = { arrangeCards, layoutOf, moveCard };
})(window);
