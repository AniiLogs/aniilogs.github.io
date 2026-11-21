// game-audit: 1.1.3989635 2026-11-21 the end of the Night Parade (game_event_data 10000080) and of the Nighttime Gathering (home_season_module_data 206), both common time 2026-12-09 23:59:59 UTC
// Guides hosted elsewhere, listed on the Guides page (/guides/) as cards that open the guide itself in a new tab.
// Adding a guide is one more entry: id, title, summary and the guide's direct url (never the site's index), plus by
// and host. Give it `ends` (an ISO time in UTC) only when the guide is about a limited-time event: once that time has
// passed the card moves to the page's "Archived" group by itself.
(() => {
  "use strict";
  const SARGEEVA = { by: "sargeeva", host: "sargeeva.github.io" };
  const guide = (entry) => Object.freeze({ ...SARGEEVA, ...entry });

  const guides = Object.freeze([
    guide({
      id: "nighttime-gathering",
      title: "Nighttime Gathering",
      url: "https://sargeeva.github.io/aniimo-guides/nighttime-gathering/",
      summary: "Decorating your RV Park platform for Co-building Contribution in Magical Wonder Night: how Habitability counts, setups that reach the cap, and a platform planner.",
      ends: "2026-12-09T23:59:59Z",
    }),
    guide({
      id: "rv-crop-planner",
      title: "RV Crop Planner",
      url: "https://sargeeva.github.io/aniimo-guides/rv-crop-planner/",
      summary: "A balanced, nonstop farm for every Home Store item that needs crops or trees: plots, trees and wells at your RV level, with profit per hour.",
    }),
    guide({
      id: "night-parade",
      title: "Night Parade",
      url: "https://sargeeva.github.io/aniimo-guides/night-parade/",
      summary: "The Candy House tiers and a candy planner, every working perfume recipe for all five visitors, a recipe tester, and the rewards.",
      ends: "2026-12-09T23:59:59Z",
    }),
    guide({
      id: "outings",
      title: "Aniimo Outings",
      url: "https://sargeeva.github.io/aniimo-guides/outings/",
      summary: "Hiking, Adventure and Camping trips from the RV Park: unlocks and costs, what an egg inherits, which Aniimo can't bring eggs back, and each Park's specialties.",
    }),
    guide({
      id: "badges",
      title: "Badge Guide",
      url: "https://sargeeva.github.io/aniimo-guides/badges/",
      summary: "Every badge from Bronze to Legendary: how to earn each one, and the privileges and titles it unlocks.",
    }),
    guide({
      id: "egg-heist",
      title: "Egg Heist Loot Tables",
      url: "https://sargeeva.github.io/aniimo-guides/egg-heist/",
      summary: "Operation: Egg Heist loot by mode and difficulty, every egg with its scent and Prismana variants, and the rank, daily chest and Display Case rewards.",
    }),
    guide({
      id: "aniimo-affinity",
      title: "Aniimo Affinity",
      url: "https://sargeeva.github.io/aniimo-guides/aniimo-affinity/",
      summary: "The four Affinity levels and what they unlock, every way to earn it, the daily and weekly limits, and a days-to-max calculator.",
    }),
    guide({
      id: "friendship",
      title: "Friendship & Illusory",
      url: "https://sargeeva.github.io/aniimo-guides/friendship/",
      summary: "Friend Affinity's six levels and what each unlocks, the fastest daily routine, and how Illusory Friends and their odds work.",
    }),
  ]);

  // True once `now` (ms, as Date.now()) is past the guide's end; a guide without `ends` is never archived.
  function isArchived(entry, now) {
    if (!entry || !entry.ends) return false;
    const end = Date.parse(entry.ends);
    return Number.isFinite(end) && now > end;
  }

  window.AniilogsLinkedGuides = Object.freeze({ guides, isArchived });
})();
