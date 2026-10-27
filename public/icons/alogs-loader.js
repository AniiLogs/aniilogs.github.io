// aLogs loader: the aLogs icon as a progress meter.
// The HP arc is the total progress. The break bar is the section loading right now.
// Each buff lights up as its share of the sections finishes: with 6 sections, one buff per section;
// with 4 sections, 2 done of 4 is half the work, so 3 of the 6 buffs are lit.
//
//   const loader = AlogsLoader.create(element, { sections: 4 });
//   loader.section(0.4);          // the current section is 40% loaded
//   loader.done();                // the current section finished; the next one starts empty
//   loader.set({ done: 2, section: 0.5 });  // or set everything at once
//   loader.set({ done: 1, section: 0.2, total: 0.73 });  // when the source knows its real total
//   loader.loop();                // no numbers to show: cycle on its own (the default before any progress)
(() => {
  const SVG_URL = "/icons/alogs-loader.svg";
  const BUFFS = 6;
  let markup = null;
  const fetchMarkup = () => (markup ??= fetch(SVG_URL).then((response) => {
    if (!response.ok) throw new Error(`aLogs loader art returned ${response.status}`);
    return response.text();
  }));

  const clamp = (value) => Math.min(1, Math.max(0, Number(value) || 0));

  function create(host, { sections = 1, svg = null } = {}) {
    const model = { sections: Math.max(1, Math.round(sections)), done: 0, section: 0, looping: true };
    let parts = null;

    const render = () => {
      if (!parts) return;
      parts.root.classList.toggle("loop", model.looping);
      if (model.looping) {
        parts.hp.style.strokeDashoffset = "";
        parts.brk.style.strokeDashoffset = "";
        parts.buffs.forEach((buff) => buff.classList.remove("on"));
        return;
      }
      const total = model.done >= model.sections ? 1 : model.total ?? (model.done + model.section) / model.sections;
      parts.hp.style.strokeDashoffset = String(100 - total * 100);
      parts.brk.style.strokeDashoffset = String(100 - (model.done >= model.sections ? 1 : model.section) * 100);
      const lit = Math.floor((model.done / model.sections) * BUFFS + 1e-9);
      parts.buffs.forEach((buff) => buff.classList.toggle("on", Number(buff.dataset.i) < lit));
      parts.root.setAttribute("aria-valuenow", String(Math.round(total * 100)));
    };

    const mount = (text) => {
      host.innerHTML = text;
      const root = host.querySelector("svg");
      root.setAttribute("aria-valuemin", "0");
      root.setAttribute("aria-valuemax", "100");
      parts = { root, hp: root.querySelector(".hp"), brk: root.querySelector(".brk"), buffs: [...root.querySelectorAll(".buff")] };
      render();
    };
    if (svg) mount(svg);
    else fetchMarkup().then(mount, () => { host.hidden = true; });

    const api = {
      // total: the HP arc's own value when the source reports one; otherwise it follows the sections.
      set({ sections: count, done, section, total } = {}) {
        if (count != null) model.sections = Math.max(1, Math.round(count));
        if (done != null) model.done = Math.min(model.sections, Math.max(0, Math.floor(done)));
        if (section != null) model.section = clamp(section);
        model.total = total == null ? null : clamp(total);
        model.looping = false;
        render();
        return api;
      },
      section(fraction) { return api.set({ section: fraction }); },
      done() { return api.set({ done: model.done + 1, section: 0 }); },
      loop() { model.looping = true; render(); return api; },
      get progress() { return model.looping ? null : Math.min(1, (model.done + model.section) / model.sections); },
    };
    return api;
  }

  window.AlogsLoader = { create };
})();
