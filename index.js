// index.js
// Discord.js v14 single-file bot (ESM)
//
// Env vars required:
//   DISCORD_TOKEN
//   SHEET_CSV_URL     (warscroll CSV - published Google Sheet CSV link)
//   FACTION_CSV_URL   (faction CSV - published Google Sheet CSV link)
//
// Notes:
// - Adds "soft-fail" fetching so Google 401s won't brick the bot if we already have cached data.
// - Changes /impact to: Top 10 warscrolls whose Win% is ABOVE the faction's overall Win%.
// - Adds /leastimpact: Top 10 warscrolls whose Win% is BELOW the faction's overall Win%.
// - /refresh now reports what refreshed vs what stayed cached (instead of crashing).

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
  EmbedBuilder,
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL; // warscrolls
const FACTION_CSV_URL = process.env.FACTION_CSV_URL; // factions

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var");
if (!SHEET_CSV_URL)
  console.warn(
    "⚠️ Missing SHEET_CSV_URL env var (warscroll commands will fail)."
  );
if (!FACTION_CSV_URL)
  console.warn("⚠️ Missing FACTION_CSV_URL env var (faction commands will fail).");

const MIN_GAMES = 5;

// -------------------- CSV parsing (handles quotes reasonably) --------------------
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      field += '"';
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && (c === "," || c === "\n")) {
      row.push(field);
      field = "";

      if (c === "\n") {
        if (row.some((x) => String(x ?? "").trim() !== "")) rows.push(row);
        row = [];
      }
      continue;
    }

    field += c;
  }

  row.push(field);
  if (row.some((x) => String(x ?? "").trim() !== "")) rows.push(row);

  if (!rows.length) return [];

  const header = rows[0].map((h) => String(h ?? "").trim());
  const data = rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? "";
    return obj;
  });

  return data;
}

// -------------------- Helpers --------------------
function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function toNum(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  const cleaned = s.replace(/%/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function fmtPct(x, decimals = 0) {
  if (!Number.isFinite(x)) return "—";
  return `${x.toFixed(decimals)}%`;
}

function fmtPP(x) {
  if (!Number.isFinite(x)) return "—";
  const sign = x > 0 ? "+" : "";
  return `${sign}${Math.round(x)}pp`;
}

function fmt1(x) {
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(1);
}

function fmtInt(x) {
  if (!Number.isFinite(x)) return "—";
  return `${Math.round(x)}`;
}

function nowStr(d = new Date()) {
  return d.toLocaleString("en-GB", { hour12: true });
}

function makeBaseEmbed(title) {
  return new EmbedBuilder()
    .setTitle(title)
    .setFooter({ text: "Source: Woehammer GT Database" });
}

function addCachedLine(embed, warscrollCachedAt, factionCachedAt) {
  const parts = [];
  if (warscrollCachedAt) parts.push(`Warscrolls: ${nowStr(warscrollCachedAt)}`);
  if (factionCachedAt) parts.push(`Factions: ${nowStr(factionCachedAt)}`);
  const cached = parts.length ? parts.join(" • ") : "—";
  embed.setFooter({ text: `Source: Woehammer GT Database • Cached: ${cached}` });
  return embed;
}

function isAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function titleCaseMaybe(s) {
  return String(s ?? "").trim();
}

// -------------------- Caches --------------------
let warscrollCache = [];
let factionCache = [];

let warscrollCachedAt = null;
let factionCachedAt = null;

async function fetchCSV(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "WoehammerStatsBot/1.0" },
  });

  if (!res.ok) {
    const err = new Error(`Failed to fetch CSV (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const text = await res.text();
  return parseCSV(text);
}

async function loadWarscrolls(force = false) {
  if (!SHEET_CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");
  if (!force && warscrollCache.length) return;

  warscrollCache = await fetchCSV(SHEET_CSV_URL);
  warscrollCachedAt = new Date();
}

async function loadFactions(force = false) {
  if (!FACTION_CSV_URL) throw new Error("Missing FACTION_CSV_URL env var");
  if (!force && factionCache.length) return;

  factionCache = await fetchCSV(FACTION_CSV_URL);
  factionCachedAt = new Date();
}

// “Soft fail” wrappers: if fetch fails but cache exists, keep going.
async function ensureWarscrolls() {
  try {
    await loadWarscrolls(false);
  } catch (e) {
    if (!warscrollCache.length) throw e;
    console.warn("Warscroll fetch failed; using cached data:", e?.message ?? e);
  }
}

async function ensureFactions() {
  try {
    await loadFactions(false);
  } catch (e) {
    if (!factionCache.length) throw e;
    console.warn("Faction fetch failed; using cached data:", e?.message ?? e);
  }
}

// refresh that doesn’t explode
async function refreshAllSoft() {
  let warscrollOk = null;
  let factionOk = null;

  if (SHEET_CSV_URL) {
    try {
      await loadWarscrolls(true);
      warscrollOk = true;
    } catch (e) {
      warscrollOk = false;
      console.warn("Warscroll refresh failed; keeping cache:", e?.message ?? e);
    }
  }

  if (FACTION_CSV_URL) {
    try {
      await loadFactions(true);
      factionOk = true;
    } catch (e) {
      factionOk = false;
      console.warn("Faction refresh failed; keeping cache:", e?.message ?? e);
    }
  }

  return { warscrollOk, factionOk };
}

// -------------------- Column getters (tolerant to header changes) --------------------
function getCol(row, candidates) {
  for (const c of candidates) {
    if (c in row) return row[c];
  }
  return "";
}

// warscroll columns
function warscrollName(row) {
  return getCol(row, ["Warscroll", "warscroll", "Name", "Unit", "Unit Name"]);
}
function warscrollFaction(row) {
  return getCol(row, ["Faction", "faction"]);
}
function warscrollGames(row) {
  return toNum(getCol(row, ["Games", "games"]));
}
function warscrollUsedPct(row) {
  return toNum(getCol(row, ["Used %", "Used%", "Used", "Use %", "Used Percent"]));
}
function warscrollWinPct(row) {
  return toNum(getCol(row, ["Win %", "Win%", "Win Rate", "Win rate"]));
}

// Old impact columns (still used for display in /warscroll search and other outputs)
function warscrollWinWithoutPct(row) {
  return toNum(
    getCol(row, [
      "Win % Without",
      "Win% Without",
      "Win Without",
      "Win w/o",
      "Win Without %",
    ])
  );
}
function warscrollImpactPP(row) {
  const direct = toNum(
    getCol(row, ["Impact", "Impact (pp)", "Impact pp", "Impact in pp"])
  );
  if (Number.isFinite(direct)) return direct;

  const w = warscrollWinPct(row);
  const wo = warscrollWinWithoutPct(row);
  if (Number.isFinite(w) && Number.isFinite(wo)) return w - wo;
  return NaN;
}

// faction columns
function factionName(row) {
  return getCol(row, ["Faction", "faction"]);
}
function formationName(row) {
  return getCol(row, [
    "Battle Formation",
    "Battle formation",
    "Formation",
    "formation",
  ]);
}
function factionGames(row) {
  return toNum(getCol(row, ["Games", "games"]));
}
function factionGamesShare(row) {
  return toNum(getCol(row, ["Games Share", "Games share", "Share", "Share %"]));
}
function factionWinPct(row) {
  return toNum(getCol(row, ["Win %", "Win%", "Win Rate", "Win rate"]));
}
function factionAvgElo(row) {
  return toNum(getCol(row, ["Average Elo", "Avg Elo", "AvgElo"]));
}
function factionMedianElo(row) {
  return toNum(getCol(row, ["Median Elo", "Med Elo", "MedianElo"]));
}
function factionEloGap(row) {
  const direct = toNum(getCol(row, ["Elo Gap", "Elo gap", "Gap"]));
  if (Number.isFinite(direct)) return direct;
  const a = factionAvgElo(row);
  const m = factionMedianElo(row);
  if (Number.isFinite(a) && Number.isFinite(m)) return a - m;
  return NaN;
}
function perf(row, key) {
  return toNum(getCol(row, [key]));
}

// -------------------- Faction baseline lookup (for /impact & /leastimpact) --------------------
function findFactionOverallRowByInput(factionInput) {
  const fq = norm(factionInput);
  const pool = factionCache.filter((r) => factionGames(r) >= MIN_GAMES);
  const candidates = pool.filter((r) => norm(factionName(r)).includes(fq));

  if (!candidates.length) return null;

  // Prefer the explicit "Overall" row if present
  const overall =
    candidates.find((r) => norm(formationName(r)) === "overall") || candidates[0];

  return overall;
}

// New “lift” metric: warscroll win% minus faction overall win%
function warscrollLiftVsFaction(row, factionOverallWin) {
  const w = warscrollWinPct(row);
  if (!Number.isFinite(w) || !Number.isFinite(factionOverallWin)) return NaN;
  return w - factionOverallWin;
}

// -------------------- Bot summary blurb (paragraphs + plain English) --------------------
function buildFactionBlurb(row) {
  const games = factionGames(row);
  const win = factionWinPct(row);

  const avg = factionAvgElo(row);
  const med = factionMedianElo(row);
  const gap = factionEloGap(row);

  const p50 = perf(row, "Players Achieving 5 Wins");
  const p41 = perf(row, "Players Achieving 4 wins");
  const p32 = perf(row, "Players Achieving 3 Wins");
  const p23 = perf(row, "Players Achieving 2 wins");
  const p14 = perf(row, "Players Achieving 1 Win");
  const p05 = perf(row, "Players Without a Win");

  const paragraphs = [];

  // Paragraph 1: sample + win rate
  if (Number.isFinite(games) && Number.isFinite(win)) {
    paragraphs.push(
      `Based on **${fmtInt(games)} games**, this faction is currently winning **${fmtPct(
        win,
        1
      )}** of the time.`
    );
  } else if (Number.isFinite(games)) {
    paragraphs.push(`Based on **${fmtInt(games)} games**.`);
  }

  // Paragraph 2: Elo, explained plainly (baseline = 400)
  if (Number.isFinite(avg) && Number.isFinite(med) && Number.isFinite(gap)) {
    const avgDelta = avg - 400;
    const medDelta = med - 400;

    let playerbaseRead;
    if (avgDelta >= 40) playerbaseRead = "well above average";
    else if (avgDelta >= 20) playerbaseRead = "above average";
    else if (avgDelta >= 5) playerbaseRead = "a little above average";
    else if (avgDelta > -5) playerbaseRead = "about average";
    else playerbaseRead = "below average";

    let spreadRead;
    if (gap >= 40)
      spreadRead = "Results are being pulled up by a smaller group of strong players.";
    else if (gap >= 25)
      spreadRead = "Stronger players are doing noticeably better than the typical player.";
    else if (gap >= 10)
      spreadRead = "Performance is fairly consistent across the player base.";
    else if (gap > -10)
      spreadRead = "Most players sit in a similar skill band for this faction.";
    else
      spreadRead =
        "The middle of the player base is doing okay, with fewer standout spikes at the top.";

    paragraphs.push(
      `Comparing Elo to the **400 baseline**, this faction has an **${playerbaseRead}** player base: average Elo **${fmt1(
        avg
      )}** (≈${fmtInt(avgDelta)} over 400) and median **${fmt1(med)}** (≈${fmtInt(
        medDelta
      )} over 400). The gap is **${fmt1(gap)}**, which suggests: ${spreadRead}`
    );
  }

  // Paragraph 3: interpret the finishes (not just repeat them)
  const havePerf = [p50, p41, p32, p23, p14, p05].some((x) => Number.isFinite(x));

  if (havePerf) {
    const buckets = [
      { label: "5–0", v: p50 },
      { label: "4–1", v: p41 },
      { label: "3–2", v: p32 },
      { label: "2–3", v: p23 },
      { label: "1–4", v: p14 },
      { label: "0–5", v: p05 },
    ].filter((b) => Number.isFinite(b.v));

    buckets.sort((a, b) => b.v - a.v);
    const mostCommon = buckets[0];

    const topShare =
      (Number.isFinite(p50) ? p50 : 0) + (Number.isFinite(p41) ? p41 : 0);
    const lowShare =
      (Number.isFinite(p14) ? p14 : 0) + (Number.isFinite(p05) ? p05 : 0);

    let shape;
    if (topShare >= 20)
      shape = "There’s a decent ceiling here — strong runs happen with some regularity.";
    else if (lowShare >= 35)
      shape = "A lot of players are struggling to convert games into wins.";
    else shape = "Most results cluster in the middle — lots of ‘roughly even’ tournament runs.";

    paragraphs.push(
      `Most players are finishing events around **${mostCommon.label}** (about **${fmtPct(
        mostCommon.v,
        1
      )}**). ${shape}`
    );
  }

  return paragraphs.join("\n\n");
}

// -------------------- Warscroll usage summary for a faction --------------------
function topWarscrollsForFaction(factionQuery, limit = 3) {
  const fq = norm(factionQuery);
  const rows = warscrollCache
    .filter((r) => warscrollGames(r) >= MIN_GAMES)
    .filter((r) => norm(warscrollFaction(r)).includes(fq))
    .slice()
    .sort(
      (a, b) =>
        (warscrollUsedPct(b) || -Infinity) - (warscrollUsedPct(a) || -Infinity)
    )
    .slice(0, limit);

  return rows.map((r) => ({
    name: warscrollName(r) || "Unknown",
    used: warscrollUsedPct(r),
    win: warscrollWinPct(r),
    impact: warscrollImpactPP(r),
    games: warscrollGames(r),
  }));
}

function formatTopWarscrollsBlock(list) {
  if (!list?.length) return null;

  const lines = list.map((w, i) => {
    return `**${i + 1}. ${w.name}** — Used **${fmtPct(
      w.used,
      0
    )}**, Win ${fmtPct(w.win, 0)}, Impact ${fmtPP(w.impact)}`;
  });

  return [`**Most-used warscrolls**`, ...lines].join("\n");
}

// -------------------- Discord client --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* -------------------- Slash Commands -------------------- */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show bot commands"),

    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscroll stats (partial matches)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Warscroll name (or part of it)").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("compare")
      .setDescription("Compare two warscrolls")
      .addStringOption((o) => o.setName("a").setDescription("Warscroll A").setRequired(true))
      .addStringOption((o) => o.setName("b").setDescription("Warscroll B").setRequired(true)),

    new SlashCommandBuilder()
      .setName("common")
      .setDescription("Top 10 most common warscrolls for a faction (by Used %)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("leastcommon")
      .setDescription("Bottom 10 least common warscrolls for a faction (by Used %)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    // Updated meaning: lift above faction overall win%
    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Top 10 warscrolls pulling the faction UP (vs faction overall win%)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    // New: drag below faction overall win%
    new SlashCommandBuilder()
      .setName("leastimpact")
      .setDescription("Top 10 warscrolls pulling the faction DOWN (vs faction overall win%)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("faction")
      .setDescription("Faction stats (overall or by battle formation)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Faction name").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("formation").setDescription("Battle formation (optional)").setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Admin: refresh cached CSV data")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());

  await client.application.commands.set(commands);
  console.log("✅ Global slash commands registered/updated.");

  // Safe cache warm (won't crash)
  try {
    // Try both, but don't die if one 401s
    if (FACTION_CSV_URL) {
      try {
        await loadFactions(true);
      } catch (e) {
        console.warn("Faction cache warm failed:", e?.message ?? e);
      }
    }
    if (SHEET_CSV_URL) {
      try {
        await loadWarscrolls(true);
      } catch (e) {
        console.warn("Warscroll cache warm failed:", e?.message ?? e);
      }
    }
    console.log("✅ Cache warm attempt complete.");
  } catch (e) {
    console.warn("Cache warm failed:", e?.message ?? e);
  }
});

/* -------------------- Interaction Handler -------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply();
  } catch {}

  try {
    const cmd = interaction.commandName;

    if (cmd === "help") {
      const embed = makeBaseEmbed("Woehammer Stats Bot — Commands")
        .setDescription(`(Ignoring rows with < ${MIN_GAMES} games)`)
        .addFields(
          { name: "/warscroll name", value: "Search warscrolls (partial match)\nExample: `/warscroll name: krethusa`" },
          { name: "/compare a b", value: "Compare two warscrolls\nExample: `/compare a: krethusa b: scourge of ghyran krethusa`" },
          { name: "/common faction", value: "Top 10 most used warscrolls (by Used %)\nExample: `/common faction: ironjawz`" },
          { name: "/leastcommon faction", value: "Bottom 10 least used warscrolls (by Used %)\nExample: `/leastcommon faction: stormcast`" },
          { name: "/impact faction", value: "Top 10 warscrolls pulling UP vs the faction’s overall win rate\nExample: `/impact faction: gloomspite gitz`" },
          { name: "/leastimpact faction", value: "Top 10 warscrolls pulling DOWN vs the faction’s overall win rate\nExample: `/leastimpact faction: gloomspite gitz`" },
          { name: "/faction name formation?", value: "Faction stats (Overall or a specific battle formation)\nExample: `/faction name: blades of khorne formation: the goretide`" },
          { name: "/refresh", value: "Admin only: refresh cached CSV data (won’t crash on Google 401s)" }
        );

      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        const embed = makeBaseEmbed("❌ Admin only").setDescription(
          "You need Administrator permission to run `/refresh`."
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const { warscrollOk, factionOk } = await refreshAllSoft();

      const lines = [];
      if (warscrollOk !== null) {
        lines.push(
          `Warscrolls: ${warscrollOk ? "✅ refreshed" : "⚠️ refresh failed (using cached)"}`
        );
      } else {
        lines.push("Warscrolls: — (SHEET_CSV_URL not set)");
      }

      if (factionOk !== null) {
        lines.push(
          `Factions: ${factionOk ? "✅ refreshed" : "⚠️ refresh failed (using cached)"}`
        );
      } else {
        lines.push("Factions: — (FACTION_CSV_URL not set)");
      }

      const embed = makeBaseEmbed("🔄 Refresh results").setDescription(lines.join("\n"));
      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    // Ensure caches as needed (soft-fail if possible)
    if (
      ["warscroll", "compare", "common", "leastcommon", "impact", "leastimpact"].includes(cmd)
    ) {
      await ensureWarscrolls();
    }
    if (["faction", "impact", "leastimpact"].includes(cmd)) {
      await ensureFactions();
    }

    if (cmd === "warscroll") {
      const q = norm(interaction.options.getString("name"));

      const matches = warscrollCache
        .filter((r) => warscrollGames(r) >= MIN_GAMES)
        .filter((r) => norm(warscrollName(r)).includes(q))
        .slice(0, 10);

      if (!matches.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No warscroll rows found for "${interaction.options.getString("name")}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const embed = makeBaseEmbed(
        `Warscroll search — "${interaction.options.getString("name")}"`
      );

      const lines = matches.map((r, i) => {
        const name = warscrollName(r) || "Unknown";
        return [
          `${i + 1}. **${name}**`,
          `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
            warscrollGames(r)
          )} | Win: ${fmtPct(warscrollWinPct(r), 0)} | Impact: ${fmtPP(
            warscrollImpactPP(r)
          )}`,
        ].join("\n");
      });

      embed.setDescription(lines.join("\n\n"));
      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "compare") {
      const aQ = norm(interaction.options.getString("a"));
      const bQ = norm(interaction.options.getString("b"));

      const pool = warscrollCache.filter((r) => warscrollGames(r) >= MIN_GAMES);

      const aMatches = pool.filter((r) => norm(warscrollName(r)).includes(aQ));
      const bMatches = pool.filter((r) => norm(warscrollName(r)).includes(bQ));

      if (!aMatches.length || !bMatches.length) {
        const embed = makeBaseEmbed("Compare — not enough matches").setDescription(
          [
            !aMatches.length ? `No matches for A: "${interaction.options.getString("a")}"` : null,
            !bMatches.length ? `No matches for B: "${interaction.options.getString("b")}"` : null,
          ].filter(Boolean).join("\n")
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const a = aMatches[0];
      const b = bMatches[0];

      function wsBlock(r) {
        const name = warscrollName(r) || "Unknown";
        const fac = warscrollFaction(r);
        return [
          `**${name}**`,
          fac ? `Faction: ${fac}` : null,
          `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
            warscrollGames(r)
          )} | Win: ${fmtPct(warscrollWinPct(r), 0)} | Impact: ${fmtPP(
            warscrollImpactPP(r)
          )}`,
        ]
          .filter(Boolean)
          .join("\n");
      }

      const embed = makeBaseEmbed("Warscroll compare").addFields(
        { name: "A", value: wsBlock(a), inline: false },
        { name: "B", value: wsBlock(b), inline: false }
      );

      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "common" || cmd === "leastcommon") {
      const facInput = interaction.options.getString("faction");
      const facQ = norm(facInput);

      let rows = warscrollCache
        .filter((r) => warscrollGames(r) >= MIN_GAMES)
        .filter((r) => norm(warscrollFaction(r)).includes(facQ));

      if (!rows.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No warscroll rows found for "${facInput}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const prettyFaction = facInput;

      if (cmd === "common") {
        rows = rows
          .slice()
          .sort(
            (a, b) =>
              (warscrollUsedPct(b) || -Infinity) - (warscrollUsedPct(a) || -Infinity)
          )
          .slice(0, 10);

        const embed = makeBaseEmbed(`Top 10 most common warscrolls — ${prettyFaction}`)
          .setDescription("Most common = highest Used %");

        const lines = rows.map((r, i) =>
          [
            `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
            `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
              warscrollGames(r)
            )} | Win: ${fmtPct(warscrollWinPct(r), 0)}`,
          ].join("\n")
        );

        embed.addFields({ name: "Results", value: lines.join("\n\n") });
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      // leastcommon
      rows = rows
        .slice()
        .sort(
          (a, b) =>
            (warscrollUsedPct(a) || Infinity) - (warscrollUsedPct(b) || Infinity)
        )
        .slice(0, 10);

      const embed = makeBaseEmbed(`Bottom 10 least common warscrolls — ${prettyFaction}`)
        .setDescription("Least common = lowest Used %");

      const lines = rows.map((r, i) =>
        [
          `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
          `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
            warscrollGames(r)
          )} | Win: ${fmtPct(warscrollWinPct(r), 0)}`,
        ].join("\n")
      );

      embed.addFields({ name: "Results", value: lines.join("\n\n") });
      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "impact" || cmd === "leastimpact") {
      const facInput = interaction.options.getString("faction");

      // Need faction overall win rate as baseline
      const factionOverallRow = findFactionOverallRowByInput(facInput);
      if (!factionOverallRow) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No faction "Overall" row found for "${facInput}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const baseWin = factionWinPct(factionOverallRow);
      const baseName = factionName(factionOverallRow) || facInput;

      if (!Number.isFinite(baseWin)) {
        const embed = makeBaseEmbed("No baseline").setDescription(
          `Found "${baseName}" but couldn't read its overall win rate from the faction CSV.`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      // Collect warscroll rows for that faction
      const fq = norm(baseName);
      let rows = warscrollCache
        .filter((r) => warscrollGames(r) >= MIN_GAMES)
        .filter((r) => norm(warscrollFaction(r)).includes(fq))
        .filter((r) => Number.isFinite(warscrollWinPct(r)));

      if (!rows.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No warscroll rows found for "${baseName}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      // Compute lift
      const enriched = rows
        .map((r) => {
          const lift = warscrollLiftVsFaction(r, baseWin);
          return { r, lift };
        })
        .filter((x) => Number.isFinite(x.lift));

      if (!enriched.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `Couldn't compute lift vs "${baseName}" overall win rate for any warscroll rows.`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      if (cmd === "impact") {
        // Pulling UP: highest positive lift
        enriched.sort((a, b) => b.lift - a.lift);
      } else {
        // Pulling DOWN: most negative lift
        enriched.sort((a, b) => a.lift - b.lift);
      }

      const top10 = enriched.slice(0, 10);

      const title =
        cmd === "impact"
          ? `Top 10 warscrolls pulling UP — ${baseName}`
          : `Top 10 warscrolls pulling DOWN — ${baseName}`;

      const desc =
        cmd === "impact"
          ? `Baseline (faction overall win rate): **${fmtPct(baseWin, 1)}**.\nListed warscrolls have a **higher** win rate than this baseline.`
          : `Baseline (faction overall win rate): **${fmtPct(baseWin, 1)}**.\nListed warscrolls have a **lower** win rate than this baseline.`;

      const embed = makeBaseEmbed(title).setDescription(desc);

      const lines = top10.map(({ r, lift }, i) => {
        const name = warscrollName(r) || "Unknown";
        const wWin = warscrollWinPct(r);
        const used = warscrollUsedPct(r);
        const games = warscrollGames(r);

        return [
          `${i + 1}. **${name}**`,
          `Win: **${fmtPct(wWin, 1)}** (${fmtPP(lift)} vs faction) | Used: ${fmtPct(
            used,
            0
          )} | Games: ${fmtInt(games)}`,
        ].join("\n");
      });

      embed.addFields({ name: "Results", value: lines.join("\n\n") });
      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "faction") {
      const inputName = interaction.options.getString("name");
      const fQ = norm(inputName);

      const formationQRaw = interaction.options.getString("formation");
      const formationQ = norm(formationQRaw);

      const pool = factionCache.filter((r) => factionGames(r) >= MIN_GAMES);
      const factionRows = pool.filter((r) => norm(factionName(r)).includes(fQ));

      if (!factionRows.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No faction rows found for "${inputName}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      let row = null;

      if (formationQ) {
        row = factionRows.find((r) => norm(formationName(r)).includes(formationQ));
        if (!row) {
          const formations = [
            ...new Set(factionRows.map((r) => formationName(r)).filter(Boolean)),
          ].slice(0, 15);

          const embed = makeBaseEmbed("Formation not found").setDescription(
            `No formation match for "${formationQRaw}". Try one of:\n` +
              formations.map((x) => `• ${x}`).join("\n")
          );
          addCachedLine(embed, warscrollCachedAt, factionCachedAt);
          return interaction.editReply({ embeds: [embed] });
        }
      } else {
        row =
          factionRows.find((r) => norm(formationName(r)) === "overall") ||
          factionRows[0];
      }

      const fac = factionName(row) || titleCaseMaybe(inputName);
      const form = formationName(row) || (formationQRaw ? formationQRaw : "Overall");

      const embed = makeBaseEmbed(`${fac} — ${form}`);

      const games = factionGames(row);
      const share = factionGamesShare(row);
      const win = factionWinPct(row);

      const avg = factionAvgElo(row);
      const med = factionMedianElo(row);
      const gap = factionEloGap(row);

      const p50 = perf(row, "Players Achieving 5 Wins");
      const p41 = perf(row, "Players Achieving 4 wins");
      const p32 = perf(row, "Players Achieving 3 Wins");
      const p23 = perf(row, "Players Achieving 2 wins");
      const p14 = perf(row, "Players Achieving 1 Win");
      const p05 = perf(row, "Players Without a Win");

      const topWs = warscrollCache.length ? topWarscrollsForFaction(fac, 3) : [];
      const topWsBlock = formatTopWarscrollsBlock(topWs);

      embed.setDescription(
        [
          `**Win Rate**`,
          `**Games:** ${fmtInt(games)}${
            Number.isFinite(share) ? ` (*${fmtPct(share, 1)} share*)` : ""
          }`,
          `**Win rate:** **${fmtPct(win, 1)}**`,
          ``,
          `**Elo**`,
          `**Average:** **${fmt1(avg)}**`,
          `Median: ${fmt1(med)}`,
          `Gap: **${fmt1(gap)}**`,
          ``,
          `**Player Performance**`,
          `**5–0:** ${fmtPct(p50, 1)}`,
          `**4–1:** ${fmtPct(p41, 1)}`,
          `**3–2:** ${fmtPct(p32, 1)}`,
          `**2–3:** ${fmtPct(p23, 1)}`,
          `**1–4:** ${fmtPct(p14, 1)}`,
          `**0–5:** ${fmtPct(p05, 1)}`,
          ``,
          `**Summary**`,
          buildFactionBlurb(row),
          topWsBlock ? `` : null,
          topWsBlock ? topWsBlock : null,
        ]
          .filter((x) => x !== null)
          .join("\n")
      );

      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    const fallback = makeBaseEmbed("❌ Unknown command").setDescription("Try `/help`.");
    addCachedLine(fallback, warscrollCachedAt, factionCachedAt);
    return interaction.editReply({ embeds: [fallback] });
  } catch (err) {
    console.error("COMMAND ERROR:", err);

    const embed = makeBaseEmbed("❌ Internal error").setDescription(
      `Check logs.\n\n**Error:** ${String(err?.message ?? err)}`
    );

    addCachedLine(embed, warscrollCachedAt, factionCachedAt);

    try {
      return interaction.editReply({ embeds: [embed] });
    } catch {
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.login(TOKEN);
