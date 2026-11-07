// game-audit: 1.1.3857679 2026-11-07 star thresholds, star caps, fight time and revives, season-star buffs, weekly star rewards, assist gifts (bossrush_grade_data, sys_config_data, bossrush_season_reward_data, buff_calc_value_data, bossrush_reward_data and the BossRush client scripts)
// The Interlink guide: how stars and score work, what the game files prove, and what only the server knows.
// Same shape as damage-guide.js; guides.js lists it on the Guides page as "interlink".
(() => {
  // bossrush_grade_data: the share of the Alpha's max HP removed for each star (bossHpLossPercent, _2, _3).
  const STAR_ROWS = [
    ["1", "0.44%", "1.17%", "0.23%"], ["2", "0.89%", "2.34%", "0.47%"], ["3", "1.44%", "3.80%", "0.70%"],
    ["4", "1.99%", "5.26%", "0.94%"], ["5", "2.66%", "7.01%", "1.17%"], ["6", "3.32%", "8.76%", "1.41%"],
    ["7", "4.09%", "10.8%", "1.64%"], ["8", "4.76%", "12.6%", "4.07%"], ["9", "6.19%", "16.3%", "5.87%"],
    ["10", "7.86%", "20.7%", "7.67%"], ["11", "9.52%", "25.1%", "9.43%"], ["12", "11.9%", "31.4%", "11.2%"],
    ["13", "15.0%", "39.1%", "13.0%"], ["14", "19.2%", "46.4%", "14.7%"], ["15", "22.4%", "55.9%", "18.1%"],
    ["16", "25.4%", "62.3%", "21.4%"], ["17", "28.4%", "68.6%", "25.6%"], ["18", "34.2%", "74.9%", "29.7%"],
    ["19", "41.4%", "84.4%", "34.8%"], ["20", "50.0%", "95.0%", "39.8%"], ["Eliminate (kill)", "100%", "100%", "100%"],
  ];

  const SECTIONS = Object.freeze([
    {
      id: "stars-not-grades",
      title: "Stars, not grades",
      basis: "exact",
      paragraphs: [
        "Interlink has no S, A or B grades. Each Alpha gives a Star Rank from 0 to 20 stars, plus one more step called Eliminate for the kill.",
        "A week has three Alphas: left, middle and right. The side Alphas give up to 20 stars each. The middle one counts double, up to 40, so a week tops out at 80 stars.",
        "Stars come from how much of the Alpha's HP your team takes off, not from time or damage per second. The table in the next section is the game's own.",
      ],
    },
    {
      id: "star-table",
      title: "How much HP each star needs",
      basis: "exact",
      paragraphs: [
        "The share of the Alpha's max HP your team has to remove for each star. The first stars come quickly; the last few need big chunks. 20 stars on a single Alpha is half its HP, and Eliminate is the kill.",
        "Fights with two Alphas use their own columns: the first Alpha needs much more of its HP (95% for 20 stars), the second much less (about 40%).",
      ],
      table: {
        columns: ["Stars", "One Alpha", "Two Alphas: first", "Two Alphas: second"],
        rows: STAR_ROWS,
      },
    },
    {
      id: "alpha-grows",
      title: "The Alpha gets tougher as you earn stars",
      basis: "exact",
      paragraphs: [
        "From 3 stars on, the Alpha gets a buff called Enhance (ATK and BREAK resistance up). It starts at level 1 around 3 to 5 stars and reaches level 7 at Eliminate. So later stars are harder in two ways: they need more HP, and the Alpha hits harder and BREAKs less easily.",
        "The game files list Enhance for each star but not its numbers, so how much stronger it gets isn't known yet.",
      ],
    },
    {
      id: "score",
      title: "Score",
      basis: "server",
      paragraphs: [
        "The score is worked out on the game's server. The game only shows the number it's sent, on the HUD and the result screen, so the exact formula isn't in the files.",
        "What the files do show: each star is listed as worth 500 + 500 points, and Eliminate 2,500 + 2,500. The game itself never reads those numbers, so they're a hint, not proof.",
      ],
    },
    {
      id: "score-measured",
      title: "What real scores look like",
      basis: "measured",
      paragraphs: [
        "From real results read by the aLogs meter: a score sits in its stars' thousand, about 1,000 per star (12,058 is 12 stars). Once you have all 20 stars it keeps rising until time runs out, and a kill adds more on top (21,519 on a 20-star Alpha). The middle Alpha's score looks doubled, like its stars.",
        "Still unknown: what exactly raises the score within a star (time left, damage, KOs), and whether team size or bots change it.",
      ],
    },
    {
      id: "week-and-season",
      title: "Your week and your season",
      basis: "exact",
      paragraphs: [
        "Your week's score is your best score on each Alpha, added up. Your week's stars work the same way. Each route keeps its own best, so a bad run never lowers what you already have.",
        "Season stars are your best stars on every Alpha of every week of the season, added up. They unlock buffs (next section), so going back for stars on an earlier week still pays off while the season lasts.",
        "The game's own leaderboards: one personal board, ranked by your best total score this period, and a team board per route, ranked by best result. Prizes go to ranks 1–2, 3–10, 11–30 and 31–100.",
      ],
    },
    {
      id: "season-buffs",
      title: "Season-star buffs",
      basis: "exact",
      paragraphs: [
        "Season stars unlock two buffs that apply on their own in every Interlink fight. They take turns levelling up: Joint Defense at 16 season stars, Coordinated Strike at 24, then each again every 16 stars, up to level 7 at 112 and 120.",
        "Coordinated Strike: +2% damage per level (+14% at level 7), and the same again against elements you counter. Joint Defense: 1% less damage taken per level (7% at level 7), again with extra against elements you counter.",
      ],
      table: {
        columns: ["Season stars", "Unlocks"],
        rows: [
          ["16", "Joint Defense 1"], ["24", "Coordinated Strike 1"], ["32", "Joint Defense 2"], ["40", "Coordinated Strike 2"],
          ["48", "Joint Defense 3"], ["56", "Coordinated Strike 3"], ["64", "Joint Defense 4"], ["72", "Coordinated Strike 4"],
          ["80", "Joint Defense 5"], ["88", "Coordinated Strike 5"], ["96", "Joint Defense 6"], ["104", "Coordinated Strike 6"],
          ["112", "Joint Defense 7"], ["120", "Coordinated Strike 7"],
        ],
      },
    },
    {
      id: "rules",
      title: "Time, revives and the team",
      basis: "exact",
      paragraphs: [
        "Each fight lasts 180 seconds. The Overtime buff adds 60.",
        "You can respawn 4 times, 5 seconds each. The Resurgence buff gives the team 4 more revives.",
        "A team is four players; empty slots are filled with bots. The Alpha takes the highest level on the team, and its stats grow with the whole team's Aniimo Rating. The files say so but give no numbers.",
        "Each week sets an environment rule and a hazard for each side, and a recommended Aniimo for each Alpha.",
      ],
    },
    {
      id: "rewards",
      title: "Weekly star rewards",
      basis: "exact",
      paragraphs: [
        "Your week's stars (out of 80) unlock these. They're handed out when you leave Interlink.",
        "Assist Gifts: if a run doesn't raise your own best, you get 1 Assist Gift for every 5 stars gained by the teammate who improved the most, rounded up, up to 12.",
      ],
      table: {
        columns: ["Week stars", "Reward"],
        rows: [
          ["4", "Sparkling Crystal ×20 and a Gift of Encounter"],
          ["8 to 28", "Sparkling Crystal ×20 every 4 stars (plus Windborn Stamps ×50 at 20 and 28)"],
          ["32 and 36", "Sparkling Crystal ×30 (plus Windborn Stamps ×50 at 36)"],
          ["40, 44, 52, 56, 60", "Starcryst Essence ×1 (plus Windborn Stamps ×50 at 44)"],
          ["48", "Wonder Egg and Windborn Stamps ×100"],
          ["66", "Advanced Held Item Core ×2"],
          ["72 and 80", "Tumbler ×2"],
        ],
      },
    },
    {
      id: "result-titles",
      title: "Result-screen titles",
      basis: "exact",
      paragraphs: [
        "The titles on the result screen (Best DPS, Best Strike, BREAK Expert, Last Strike, Reaper and the rest) are just for show: they don't change stars, score or rewards, and the server picks them. The DPS figure there is total damage divided by fight time.",
      ],
    },
  ]);

  window.AniilogsGuides = window.AniilogsGuides || [];
  window.AniilogsGuides.push(Object.freeze({
    id: "interlink",
    title: "How Interlink is scored",
    summary: "Stars, score, the HP each star needs, season-star buffs and weekly rewards: what the game files prove and what only the server knows.",
    intro: "How Interlink stars and score work, from the game's own files. Stars come straight from the HP you take off each Alpha. The score is worked out on the game's server, so that part is measured from real results rather than read from the files. Each section says how sure it is.",
    sections: SECTIONS,
  }));
})();
