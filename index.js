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

console.log("SHEET_CSV_URL =", SHEET_CSV_URL);
console.log("FACTION_CSV_URL =", FACTION_CSV_URL);

const MIN_GAMES = 5;

import http from "http";

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => {
    console.log(`Healthcheck server listening on ${PORT}`);
  });

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
  return String(s ?? "")
    .replace(/\u00A0/g, " ")   // NBSP -> space (Google Sheets loves these)
    .replace(/\s+/g, " ")     // collapse whitespace
    .trim()
    .toLowerCase();
}

function chunkText(text, max = 1024) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + max));
    i += max;
  }
  return chunks;
}

function chunkByLines(lines, maxLen = 1024) {
  const chunks = [];
  let cur = "";

  for (const line of lines) {
    const add = (cur ? "\n\n" : "") + line;
    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);
      // if a single line is too long, hard-split it
      if (line.length > maxLen) {
        chunkText(line, maxLen).forEach((c) => chunks.push(c));
        cur = "";
      } else {
        cur = line;
      }
    } else {
      cur += add;
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
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

function fmtWinPair(withPct, withoutPct, decimals = 0) {
  const w = fmtPct(withPct, decimals);
  const wo = fmtPct(withoutPct, decimals);
  return `Win: ${w} | Win w/o: ${wo}`;
}

// -------------------- Caches --------------------
let warscrollCache = [];
let factionCache = [];

let warscrollCachedAt = null;
let factionCachedAt = null;

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cb=${Date.now()}`;
}

async function fetchCSV(url, { cacheBust = false } = {}) {
  const finalUrl = cacheBust ? withCacheBust(url) : url;

  const res = await fetch(finalUrl, {
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

  warscrollCache = await fetchCSV(SHEET_CSV_URL, { cacheBust: force });
  warscrollCachedAt = new Date();
}

async function loadFactions(force = false) {
  if (!FACTION_CSV_URL) throw new Error("Missing FACTION_CSV_URL env var");
  if (!force && factionCache.length) return;

  factionCache = await fetchCSV(FACTION_CSV_URL, { cacheBust: force });
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
console.log("Warscroll rows loaded:", warscrollCache.length);

const oss = warscrollCache
  .filter(r => norm(warscrollFaction(r)).includes("ossiarch"))
  .slice(0, 5)
  .map(r => ({
    faction: warscrollFaction(r),
    name: warscrollName(r),
    games: warscrollGames(r),
    win: warscrollWinPct(r),
    used: warscrollUsedPct(r),
  }));

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
  return toNum(
    getCol(row, [
      "Games",
      "games",
      "Faction Games Featured",
      "Games Featured",
      "Games Featured (Faction)",
      "Faction Games",
      "Games Featured ",
    ])
  );
}
function warscrollUsedPct(row) {
  return toNum(
    getCol(row, [
      "Used %",
      "Used%",
      "Used",
      "Use %",
      "Used Percent",
      "Usage %",
      "Pick %",
      "Picked %",
    ])
  );
}
function warscrollWinPct(row) {
  return toNum(
    getCol(row, [
      "Win %",
      "Win%",
      "Win Rate",
      "Win rate",
      "Winrate",
      "Wins %",
      "Win Percentage",
    ])
  );
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

// -------------------- Discovery + Autocomplete helpers --------------------
//
// Goal:
// - As the user types, Discord suggests factions, formations, and warscrolls.
// - Discovery commands can list factions/formations/etc without needing exact spelling.
//
// Notes:
// - Autocomplete requires option.setAutocomplete(true) in your SlashCommand definitions.
// - This code only *provides suggestions*; it does not change your existing commands yet.

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function startsOrIncludes(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  if (!n) return true;
  // Prefer "starts with", then "includes"
  return h.startsWith(n) || h.includes(n);
}

function limitChoices(choices, max = 25) {
  // Discord autocomplete max is 25
  return choices.slice(0, max);
}

// Build faction name list from factionCache (best source for “canonical” names)
function getAllFactions() {
  const pool = factionCache.filter((r) => factionGames(r) >= MIN_GAMES);
  const names = pool.map((r) => factionName(r)).map((x) => String(x ?? "").trim());
  return uniq(names);
}

// Build formation list for a given faction input (from factionCache)
function getFormationsForFaction(factionInput) {
  const fq = norm(factionInput);
  const pool = factionCache.filter((r) => factionGames(r) >= MIN_GAMES);
  const rows = pool.filter((r) => norm(factionName(r)).includes(fq));
  const forms = rows.map((r) => formationName(r)).map((x) => String(x ?? "").trim());
  return uniq(forms);
}

// Build warscroll list, optionally filtered by faction (from warscrollCache)
function getWarscrolls({ factionInput = null } = {}) {
  let rows = warscrollCache.filter((r) => warscrollGames(r) >= MIN_GAMES);

  if (factionInput) {
    const fq = norm(factionInput);
    rows = rows.filter((r) => norm(warscrollFaction(r)).includes(fq));
  }

  const names = rows.map((r) => warscrollName(r)).map((x) => String(x ?? "").trim());
  return uniq(names);
}

// Return autocomplete choices: [{ name, value }]
function makeChoices(list, typed) {
  const out = list
    .filter((x) => startsOrIncludes(x, typed))
    .slice(0, 25)
    .map((x) => ({
      name: x.length > 100 ? x.slice(0, 97) + "..." : x,
      value: x,
    }));
  return out;
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
        o
          .setName("name")
          .setDescription("Warscroll name (or part of it)")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("compare")
      .setDescription("Compare two warscrolls")
      .addStringOption((o) =>
        o
          .setName("a")
          .setDescription("Warscroll A")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("b")
          .setDescription("Warscroll B")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("common")
      .setDescription("Top 10 most common warscrolls for a faction (by Used %)")
      .addStringOption((o) =>
        o
          .setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("leastcommon")
      .setDescription("Bottom 10 least common warscrolls for a faction (by Used %)")
      .addStringOption((o) =>
        o
          .setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Top 10 warscrolls pulling the faction UP (vs faction overall win%)")
      .addStringOption((o) =>
        o
          .setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("leastimpact")
      .setDescription("Top 10 warscrolls pulling the faction DOWN (vs faction overall win%)")
      .addStringOption((o) =>
        o
          .setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("faction")
      .setDescription("Faction stats (overall or by battle formation)")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("formation")
          .setDescription("Battle formation (optional)")
          .setRequired(false)
          .setAutocomplete(true)
      ),
    
    new SlashCommandBuilder()
  .setName("league")
  .setDescription("Show a player's army list, fixtures, and results")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("Player name")
      .setRequired(true)
  ),

    // -------------------- Discovery commands --------------------
    new SlashCommandBuilder()
      .setName("factions")
      .setDescription("List factions (discovery)")
      .addStringOption((o) =>
        o
          .setName("search")
          .setDescription("Filter factions by name (optional)")
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("formations")
      .setDescription("List battle formations for a faction (discovery)")
      .addStringOption((o) =>
        o
          .setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("warscrolls")
      .setDescription("List warscrolls (optionally filtered by faction) (discovery)")
      .addStringOption((o) =>
        o
          .setName("faction")
          .setDescription("Faction name (optional)")
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((o) =>
        o
          .setName("search")
          .setDescription("Filter warscrolls by name (optional)")
          .setRequired(false)
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

/* -------------------- Autocomplete Handler -------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  try {
    const cmd = interaction.commandName;
    const focused = interaction.options.getFocused(true);
    const typed = String(focused?.value ?? "");

    // Soft load caches for suggestions
    if (
      ["faction", "impact", "leastimpact", "common", "leastcommon", "factions", "formations"].includes(
        cmd
      )
    ) {
      try {
        await ensureFactions();
      } catch {}
    }
    if (["warscroll", "compare", "warscrolls"].includes(cmd)) {
      try {
        await ensureWarscrolls();
      } catch {}
    }

    // Helper for responding safely
    const safeRespond = async (choices) => {
      try {
        return await interaction.respond(choices.slice(0, 25));
      } catch {
        // ignore
      }
    };

    // /faction name + formation
    if (cmd === "faction") {
      if (focused.name === "name") {
        const choices = makeChoices(getAllFactions(), typed);
        return safeRespond(choices);
      }
      if (focused.name === "formation") {
        const fac = interaction.options.getString("name") ?? "";
        const forms = fac ? getFormationsForFaction(fac) : [];
        const choices = makeChoices(forms, typed);
        return safeRespond(choices);
      }
    }

    // faction pickers
    if (["impact", "leastimpact", "common", "leastcommon", "formations"].includes(cmd)) {
      if (focused.name === "faction") {
        const choices = makeChoices(getAllFactions(), typed);
        return safeRespond(choices);
      }
    }

    // warscroll pickers
    if (cmd === "warscroll" && focused.name === "name") {
      const choices = makeChoices(getWarscrolls(), typed);
      return safeRespond(choices);
    }

    if (cmd === "compare" && (focused.name === "a" || focused.name === "b")) {
      const choices = makeChoices(getWarscrolls(), typed);
      return safeRespond(choices);
    }

    if (cmd === "warscrolls" && focused.name === "faction") {
      const choices = makeChoices(getAllFactions(), typed);
      return safeRespond(choices);
    }

    // Nothing matched
    return safeRespond([]);
  } catch {
    try {
      return interaction.respond([]);
    } catch {}
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
if (cmd === "factions") {
      await ensureFactions();

      const search = interaction.options.getString("search") ?? "";
      const all = getAllFactions();
      const filtered = search ? all.filter((x) => startsOrIncludes(x, search)) : all;

      if (!filtered.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No factions match "${search}".`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const embed = makeBaseEmbed("Factions (discovery)").setDescription(
        filtered.slice(0, 50).map((x) => `• ${x}`).join("\n") +
          (filtered.length > 50 ? `\n\n…and ${filtered.length - 50} more.` : "")
      );

      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "formations") {
      await ensureFactions();

      const facInput = interaction.options.getString("faction");
      const forms = getFormationsForFaction(facInput);

      if (!forms.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No formations found for "${facInput}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const embed = makeBaseEmbed(`Formations — ${facInput}`).setDescription(
        forms.slice(0, 50).map((x) => `• ${x}`).join("\n") +
          (forms.length > 50 ? `\n\n…and ${forms.length - 50} more.` : "")
      );

      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "warscrolls") {
      await ensureWarscrolls();

      const facInput = interaction.options.getString("faction");
      const search = interaction.options.getString("search") ?? "";

      const list = getWarscrolls({ factionInput: facInput ?? null });
      const filtered = search ? list.filter((x) => startsOrIncludes(x, search)) : list;

      if (!filtered.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No warscrolls found${facInput ? ` for "${facInput}"` : ""}${
            search ? ` matching "${search}"` : ""
          } (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const title = facInput ? `Warscrolls — ${facInput}` : "Warscrolls (all)";
      const embed = makeBaseEmbed(title).setDescription(
        filtered.slice(0, 50).map((x) => `• ${x}`).join("\n") +
          (filtered.length > 50 ? `\n\n…and ${filtered.length - 50} more.` : "")
      );

      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
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

  const used = warscrollUsedPct(r);
  const games = warscrollGames(r);
  const win = warscrollWinPct(r);
  const winWo = warscrollWinWithoutPct(r);
  const impact = warscrollImpactPP(r); // if direct impact col missing, uses win - winWo

  return [
    `${i + 1}. **${name}**`,
    `Used: ${fmtPct(used, 0)} | Games: ${fmtInt(games)} | ${fmtWinPair(win, winWo, 0)} | Impact: ${fmtPP(impact)}`,
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

        const lines = rows.map((r, i) => {
  const win = warscrollWinPct(r);
  const winWo = warscrollWinWithoutPct(r);

  return [
    `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
    `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(warscrollGames(r))} | ${fmtWinPair(win, winWo, 0)}`,
  ].join("\n");
});

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

      const lines = rows.map((r, i) => {
  const win = warscrollWinPct(r);
  const winWo = warscrollWinWithoutPct(r);

  return [
    `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
    `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(warscrollGames(r))} | ${fmtWinPair(win, winWo, 0)}`,
  ].join("\n");
});

    const resultsText = lines.join("\n\n");
const chunks = chunkText(resultsText, 1024);

chunks.forEach((chunk, idx) => {
  embed.addFields({
    name: idx === 0 ? "Results" : "Results (cont.)",
    value: chunk,
  });
});
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
      
      console.log("IMPACT baseline faction =", baseName, "baseWin =", baseWin);
    
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

      let filtered = enriched;

if (cmd === "impact") {
  filtered = enriched.filter(x => x.lift > 0);
  filtered.sort((a, b) => b.lift - a.lift);
} else {
  filtered = enriched.filter(x => x.lift < 0);
  filtered.sort((a, b) => a.lift - b.lift);
}

const top10 = filtered.slice(0, 10);

if (!top10.length) {
  const embed = makeBaseEmbed("No results").setDescription(
    cmd === "impact"
      ? `No warscrolls are above ${baseName}'s overall win rate right now.`
      : `No warscrolls are below ${baseName}'s overall win rate right now.`
  );
  addCachedLine(embed, warscrollCachedAt, factionCachedAt);
  return interaction.editReply({ embeds: [embed] });
}

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
  const winWo = warscrollWinWithoutPct(r);
  const used = warscrollUsedPct(r);
  const games = warscrollGames(r);

  return [
    `${i + 1}. **${name}**`,
    `Win: **${fmtPct(wWin, 1)}** (${fmtPP(lift)} vs faction) | Win w/o: ${fmtPct(
      winWo,
      1
    )} | Used: ${fmtPct(used, 0)} | Games: ${fmtInt(games)}`,
  ].join("\n");
});

const chunks = chunkByLines(lines, 1024);

chunks.forEach((chunk, idx) => {
  embed.addFields({
    name: idx === 0 ? "Results" : "Results (cont.)",
    value: chunk,
  });
});

addCachedLine(embed, warscrollCachedAt, factionCachedAt);
return interaction.editReply({ embeds: [embed] });
    }

if (cmd === "league") {
  await ensureLeaguePlayers();

  const input = interaction.options.getString("name");
  const q = norm(input);

  const row = leaguePlayersCache.find(r =>
    norm(lpPlayer(r)).includes(q)
  );

  if (!row) {
    const embed = makeBaseEmbed("No results")
      .setDescription(`No league player found for "${input}".`);
    leagueCachedFooter(embed);
    return interaction.editReply({ embeds: [embed] });
  }

  const playerName = lpPlayer(row);
  const leagueName = lpLeague(row);

  const embed = makeBaseEmbed(`Player Profile — ${playerName}`);
  if (leagueName) embed.setDescription(`League: **${leagueName}**`);

  // Army list
  const listText = String(lpList(row) ?? "").trim();
  embed.addFields({
    name: "Army List",
    // Army list (fields max 1024 chars)
  const listText = String(lpList(row) ?? "").trim();

  if (!listText) {
    embed.addFields({ name: "Army List", value: "No list submitted." });
  } else {
    const listChunks = chunkText(listText, 1024);
    listChunks.slice(0, 6).forEach((chunk, idx) => {
      embed.addFields({
        name: idx === 0 ? "Army List" : "Army List (cont.)",
        value: chunk,
      });
    });

    if (listChunks.length > 6) {
      embed.addFields({
        name: "Army List (truncated)",
        value: `List is long — showing first ${6 * 1024} characters.`,
      });
    }
  }

  // Fixtures
  const fixtures = lpOpponents(row)
    .map((o, i) => o ? `Round ${i + 1}: ${o}` : null)
    .filter(Boolean);

  embed.addFields({
    name: "Fixtures",
    value: fixtures.length ? fixtures.join("\n") : "No fixtures available.",
  });

  // Results
  embed.addFields({
    name: "Results",
    value: [
      `Played: **${fmtInt(lpGames(row))}**`,
      `Won: **${fmtInt(lpW(row))}**`,
      `Drew: **${fmtInt(lpD(row))}**`,
      `Lost: **${fmtInt(lpL(row))}**`,
      `Points: **${fmtInt(lpPts(row))}**`,
    ].join("\n"),
    inline: true,
  });

  leagueCachedFooter(embed);
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

// ==================================================
// LEAGUE MODULE (CSV -> /league)
// PURPOSE: Show a player's list, fixtures, and results from a league CSV
// ENV: LEAGUE_PLAYERS_CSV_URL
// ==================================================

const LEAGUE_PLAYERS_CSV_URL = process.env.LEAGUE_PLAYERS_CSV_URL;

let leaguePlayersCache = [];
let leaguePlayersCachedAt = null;

async function loadLeaguePlayers(force = false) {
  if (!LEAGUE_PLAYERS_CSV_URL) throw new Error("Missing LEAGUE_PLAYERS_CSV_URL env var");
  if (!force && leaguePlayersCache.length) return;

  leaguePlayersCache = await fetchCSV(LEAGUE_PLAYERS_CSV_URL, { cacheBust: force });
  leaguePlayersCachedAt = new Date();
}

async function ensureLeaguePlayers() {
  try {
    await loadLeaguePlayers(false);
  } catch (e) {
    if (!leaguePlayersCache.length) throw e;
    console.warn("League player fetch failed; using cached:", e?.message ?? e);
  }
}

function leagueCachedFooter(embed) {
  const cached = leaguePlayersCachedAt ? nowStr(leaguePlayersCachedAt) : "—";
  // Keep your existing footer format; just tack league cache info onto it
  const base = embed.data?.footer?.text || "Source: Woehammer GT Database";
  embed.setFooter({ text: `${base} • League: ${cached}` });
  return embed;
}

// ---------- League CSV column helpers ----------
function lp(row, candidates) {
  return getCol(row, candidates);
}

const lpPlayer = (r) => lp(r, ["Player", "player", "Name", "name"]);
const lpLeague  = (r) => lp(r, ["League", "league"]);
const lpList    = (r) => lp(r, ["Lists", "List", "lists", "list"]);

const lpOpponents = (r) => ([
  lp(r, ["Rnd 1 Opponent", "Round 1 Opponent", "R1 Opponent"]),
  lp(r, ["Rnd 2 Opponent", "Round 2 Opponent", "R2 Opponent"]),
  lp(r, ["Rnd 3 Opponent", "Round 3 Opponent", "R3 Opponent"]),
  lp(r, ["Rnd 4 Opponent", "Round 4 Opponent", "R4 Opponent"]),
  lp(r, ["Rnd 5 Opponent", "Round 5 Opponent", "R5 Opponent"]),
]);

const lpGames = (r) => toNum(lp(r, ["Games", "games", "Played"]));
const lpW     = (r) => toNum(lp(r, ["W", "w", "Wins"]));
const lpD     = (r) => toNum(lp(r, ["D", "d", "Draws"]));
const lpL     = (r) => toNum(lp(r, ["L", "l", "Losses"]));
const lpPts   = (r) => toNum(lp(r, ["Pts", "pts", "Points"]));

function safeFilename(s) {
  return norm(s).replace(/[^\w\-]+/g, "-").replace(/\-+/g, "-").replace(/^\-|\-$/g, "");
}

client.login(TOKEN);
