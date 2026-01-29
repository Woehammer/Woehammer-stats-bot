// ==================================================
// index.js
// Woehammer Stats Bot — Discord.js v14 (ESM)
// ==================================================
//
// ENV VARS REQUIRED:
//   DISCORD_TOKEN
//   SHEET_CSV_URL     (warscroll CSV)
//   FACTION_CSV_URL   (faction CSV)
//   LEAGUE_PLAYERS_CSV_URL (optional, league command)
//
// ==================================================

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
  EmbedBuilder,
} from "discord.js";

import http from "http";

// -------------------- ENV --------------------
const TOKEN = process.env.DISCORD_TOKEN;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const FACTION_CSV_URL = process.env.FACTION_CSV_URL;
const LEAGUE_PLAYERS_CSV_URL = process.env.LEAGUE_PLAYERS_CSV_URL;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var");

if (!SHEET_CSV_URL)
  console.warn("⚠️ Missing SHEET_CSV_URL (warscroll commands disabled)");

if (!FACTION_CSV_URL)
  console.warn("⚠️ Missing FACTION_CSV_URL (faction commands disabled)");

const MIN_GAMES = 5;

// -------------------- HEALTHCHECK (Railway) --------------------
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => {
    console.log(`Healthcheck listening on ${PORT}`);
  });

// ==================================================
// CSV PARSER (handles Google Sheets quirks)
// ==================================================
function parseCSV(text) {
  text = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

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
        if (row.some(v => String(v).trim() !== "")) rows.push(row);
        row = [];
      }
      continue;
    }

    field += c;
  }

  row.push(field);
  if (row.some(v => String(v).trim() !== "")) rows.push(row);

  if (!rows.length) return [];

  const header = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => (obj[h] = r[i] ?? ""));
    return obj;
  });
}

// ==================================================
// GENERIC HELPERS
// ==================================================
function norm(s) {
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toNum(v) {
  const n = Number(String(v ?? "").replace(/[% ,]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function fmtPct(x, d = 0) {
  return Number.isFinite(x) ? `${x.toFixed(d)}%` : "—";
}

function fmtInt(x) {
  return Number.isFinite(x) ? String(Math.round(x)) : "—";
}

function fmtPP(x) {
  if (!Number.isFinite(x)) return "—";
  return `${x > 0 ? "+" : ""}${Math.round(x)}pp`;
}

function nowStr(d = new Date()) {
  return d.toLocaleString("en-GB", { hour12: true });
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function makeBaseEmbed(title) {
  return new EmbedBuilder()
    .setTitle(title)
    .setFooter({ text: "Source: Woehammer GT Database" });
}

// ==================================================
// TEXT CHUNKING (Discord embed safety)
// ==================================================
function chunkText(text, max = 1024) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + max));
    i += max;
  }
  return out;
}

function chunkByLines(lines, maxLen = 1024) {
  const chunks = [];
  let cur = "";

  for (const line of lines) {
    const add = (cur ? "\n\n" : "") + line;

    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);

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

// ==================================================
// DATA CACHES
// ==================================================
let warscrollCache = [];
let factionCache = [];

let warscrollCachedAt = null;
let factionCachedAt = null;

function addCachedLine(embed) {
  const parts = [];
  if (warscrollCachedAt) parts.push(`Warscrolls: ${nowStr(warscrollCachedAt)}`);
  if (factionCachedAt) parts.push(`Factions: ${nowStr(factionCachedAt)}`);

  embed.setFooter({
    text: `Source: Woehammer GT Database • Cached: ${parts.length ? parts.join(" • ") : "—"}`,
  });

  return embed;
}

// ==================================================
// CSV FETCHING
// ==================================================
function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cb=${Date.now()}`;
}

async function fetchCSV(url, { cacheBust = false } = {}) {
  if (!url) throw new Error("fetchCSV called with empty url");

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

// Soft-fail wrappers: if fetch fails but cache exists, keep going.
async function ensureWarscrolls() {
  try {
    await loadWarscrolls(false);
  } catch (e) {
    if (!warscrollCache.length) throw e;
    console.warn("Warscroll fetch failed; using cached:", e?.message ?? e);
  }
}

async function ensureFactions() {
  try {
    await loadFactions(false);
  } catch (e) {
    if (!factionCache.length) throw e;
    console.warn("Faction fetch failed; using cached:", e?.message ?? e);
  }
}

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

// ==================================================
// COLUMN GETTERS (tolerant to header changes)
// ==================================================
function getCol(row, candidates) {
  for (const c of candidates) {
    if (c in row) return row[c];
  }
  return "";
}

// -------------------- Warscroll columns --------------------
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

// -------------------- Faction columns --------------------
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

// ==================================================
// FACTION BASELINE LOOKUP (impact / leastimpact)
// ==================================================
function findFactionOverallRowByInput(factionInput) {
  const fq = norm(factionInput);
  const pool = factionCache.filter((r) => factionGames(r) >= MIN_GAMES);
  const candidates = pool.filter((r) => norm(factionName(r)).includes(fq));

  if (!candidates.length) return null;

  return (
    candidates.find((r) => norm(formationName(r)) === "overall") ||
    candidates[0]
  );
}

function warscrollLiftVsFaction(row, factionOverallWin) {
  const w = warscrollWinPct(row);
  if (!Number.isFinite(w) || !Number.isFinite(factionOverallWin)) return NaN;
  return w - factionOverallWin;
}

// ==================================================
// HUMAN-READABLE FACTION SUMMARY
// ==================================================
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

  const out = [];

  if (Number.isFinite(games) && Number.isFinite(win)) {
    out.push(
      `Based on **${fmtInt(games)} games**, this faction is winning **${fmtPct(
        win,
        1
      )}** of the time.`
    );
  }

  if (
    Number.isFinite(avg) &&
    Number.isFinite(med) &&
    Number.isFinite(gap)
  ) {
    const avgDelta = avg - 400;

    let skill;
    if (avgDelta >= 40) skill = "well above average";
    else if (avgDelta >= 20) skill = "above average";
    else if (avgDelta >= 5) skill = "slightly above average";
    else if (avgDelta > -5) skill = "about average";
    else skill = "below average";

    let spread;
    if (gap >= 40)
      spread = "Results are driven by a small number of strong players.";
    else if (gap >= 20)
      spread = "Top players outperform the rest noticeably.";
    else spread = "Results are fairly consistent across players.";

    out.push(
      `Player base is **${skill}** (avg Elo **${fmt1(avg)}**, median **${fmt1(
        med
      )}**). ${spread}`
    );
  }

  const buckets = [
    { l: "5–0", v: p50 },
    { l: "4–1", v: p41 },
    { l: "3–2", v: p32 },
    { l: "2–3", v: p23 },
    { l: "1–4", v: p14 },
    { l: "0–5", v: p05 },
  ].filter((b) => Number.isFinite(b.v));

  if (buckets.length) {
    buckets.sort((a, b) => b.v - a.v);
    out.push(
      `Most players finish around **${buckets[0].l}** (${fmtPct(
        buckets[0].v,
        1
      )}).`
    );
  }

  return out.join("\n\n");
}

// ==================================================
// TOP WARSCROLLS SUMMARY
// ==================================================
function topWarscrollsForFaction(factionQuery, limit = 3) {
  const fq = norm(factionQuery);

  return warscrollCache
    .filter((r) => warscrollGames(r) >= MIN_GAMES)
    .filter((r) => norm(warscrollFaction(r)).includes(fq))
    .sort((a, b) => (warscrollUsedPct(b) || 0) - (warscrollUsedPct(a) || 0))
    .slice(0, limit)
    .map((r) => ({
      name: warscrollName(r),
      used: warscrollUsedPct(r),
      win: warscrollWinPct(r),
      impact: warscrollImpactPP(r),
    }));
}

function formatTopWarscrollsBlock(list) {
  if (!list.length) return null;

  const lines = list.map(
    (w, i) =>
      `**${i + 1}. ${w.name}** — Used ${fmtPct(w.used)}, Win ${fmtPct(
        w.win
      )}, Impact ${fmtPP(w.impact)}`
  );

  return [`**Most-used warscrolls**`, ...lines].join("\n");
}

// ==================================================
// DISCOVERY & AUTOCOMPLETE HELPERS
// ==================================================
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function startsOrIncludes(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  return !n || h.startsWith(n) || h.includes(n);
}

function getAllFactions() {
  return uniq(
    factionCache
      .filter((r) => factionGames(r) >= MIN_GAMES)
      .map((r) => factionName(r))
  );
}

function getFormationsForFaction(factionInput) {
  const fq = norm(factionInput);
  return uniq(
    factionCache
      .filter((r) => norm(factionName(r)).includes(fq))
      .map((r) => formationName(r))
  );
}

function getWarscrolls({ factionInput = null } = {}) {
  let rows = warscrollCache.filter((r) => warscrollGames(r) >= MIN_GAMES);

  if (factionInput) {
    const fq = norm(factionInput);
    rows = rows.filter((r) => norm(warscrollFaction(r)).includes(fq));
  }

  return uniq(rows.map((r) => warscrollName(r)));
}

function makeChoices(list, typed) {
  return list
    .filter((x) => startsOrIncludes(x, typed))
    .slice(0, 25)
    .map((x) => ({ name: x, value: x }));
}

// ==================================================
// DISCORD CLIENT
// ==================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ==================================================
// SLASH COMMAND REGISTRATION
// ==================================================
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show bot commands"),

    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscroll stats")
      .addStringOption(o =>
        o.setName("name")
          .setDescription("Warscroll name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("compare")
      .setDescription("Compare two warscrolls")
      .addStringOption(o =>
        o.setName("a")
          .setDescription("Warscroll A")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(o =>
        o.setName("b")
          .setDescription("Warscroll B")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("common")
      .setDescription("Most-used warscrolls for a faction")
      .addStringOption(o =>
        o.setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("leastcommon")
      .setDescription("Least-used warscrolls for a faction")
      .addStringOption(o =>
        o.setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Warscrolls pulling a faction UP")
      .addStringOption(o =>
        o.setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("leastimpact")
      .setDescription("Warscrolls pulling a faction DOWN")
      .addStringOption(o =>
        o.setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("faction")
      .setDescription("Faction stats")
      .addStringOption(o =>
        o.setName("name")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(o =>
        o.setName("formation")
          .setDescription("Battle formation (optional)")
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("factions")
      .setDescription("List factions"),

    new SlashCommandBuilder()
      .setName("formations")
      .setDescription("List formations for a faction")
      .addStringOption(o =>
        o.setName("faction")
          .setDescription("Faction name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("warscrolls")
      .setDescription("List warscrolls")
      .addStringOption(o =>
        o.setName("faction")
          .setDescription("Faction name (optional)")
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Admin: refresh cached data")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());

  await client.application.commands.set(commands);
  console.log("✅ Slash commands registered");

  // Cache warm (safe)
  try {
    if (FACTION_CSV_URL) await loadFactions(true);
    if (SHEET_CSV_URL) await loadWarscrolls(true);
    console.log("🔥 Cache warmed");
  } catch (e) {
    console.warn("Cache warm issue:", e?.message ?? e);
  }
});

// ==================================================
// AUTOCOMPLETE HANDLER
// ==================================================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isAutocomplete()) return;

  try {
    const cmd = interaction.commandName;
    const focused = interaction.options.getFocused(true);
    const typed = String(focused?.value ?? "");

    if (["faction", "impact", "leastimpact", "common", "leastcommon"].includes(cmd)) {
      await ensureFactions();
    }
    if (["warscroll", "compare", "warscrolls"].includes(cmd)) {
      await ensureWarscrolls();
    }

    if (focused.name === "name" || focused.name === "faction") {
      return interaction.respond(
        makeChoices(getAllFactions(), typed)
      );
    }

    if (focused.name === "formation") {
      const fac = interaction.options.getString("name") ?? "";
      return interaction.respond(
        makeChoices(getFormationsForFaction(fac), typed)
      );
    }

    if (focused.name === "a" || focused.name === "b") {
      return interaction.respond(
        makeChoices(getWarscrolls(), typed)
      );
    }

    if (focused.name === "name") {
      return interaction.respond(
        makeChoices(getWarscrolls(), typed)
      );
    }

    return interaction.respond([]);
  } catch {
    try { await interaction.respond([]); } catch {}
  }
});

// ==================================================
// COMMAND HANDLER
// ==================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply();
  } catch {}

  try {
    const cmd = interaction.commandName;

    // ---------------- HELP ----------------
    if (cmd === "help") {
      const embed = makeBaseEmbed("Woehammer Stats Bot — Commands")
        .setDescription(`Ignoring rows with < ${MIN_GAMES} games`)
        .addFields(
          { name: "/warscroll", value: "Search warscroll stats" },
          { name: "/compare", value: "Compare two warscrolls" },
          { name: "/common", value: "Most-used warscrolls for a faction" },
          { name: "/leastcommon", value: "Least-used warscrolls for a faction" },
          { name: "/impact", value: "Warscrolls pulling faction UP" },
          { name: "/leastimpact", value: "Warscrolls pulling faction DOWN" },
          { name: "/faction", value: "Faction stats & formations" },
          { name: "/refresh", value: "Admin: refresh cached data" }
        );

      addCachedLine(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ---------------- REFRESH ----------------
    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        return interaction.editReply({
          embeds: [
            makeBaseEmbed("❌ Admin only")
              .setDescription("You need Administrator permission."),
          ],
        });
      }

      const { warscrollOk, factionOk } = await refreshAllSoft();

      const embed = makeBaseEmbed("🔄 Refresh results").setDescription(
        [
          warscrollOk === null
            ? "Warscrolls: —"
            : warscrollOk
            ? "Warscrolls: ✅ refreshed"
            : "Warscrolls: ⚠️ failed (cached)",
          factionOk === null
            ? "Factions: —"
            : factionOk
            ? "Factions: ✅ refreshed"
            : "Factions: ⚠️ failed (cached)",
        ].join("\n")
      );

      addCachedLine(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // Ensure caches
    if (["warscroll", "compare", "common", "leastcommon", "impact", "leastimpact"].includes(cmd)) {
      await ensureWarscrolls();
    }
    if (["faction", "impact", "leastimpact"].includes(cmd)) {
      await ensureFactions();
    }

    // ---------------- WARSCROLL SEARCH ----------------
    if (cmd === "warscroll") {
      const q = norm(interaction.options.getString("name"));

      const matches = warscrollCache
        .filter(r => warscrollGames(r) >= MIN_GAMES)
        .filter(r => norm(warscrollName(r)).includes(q))
        .slice(0, 10);

      if (!matches.length) {
        return interaction.editReply({
          embeds: [makeBaseEmbed("No results").setDescription("No warscrolls found.")],
        });
      }

      const embed = makeBaseEmbed("Warscroll results");

      embed.setDescription(
        matches.map((r, i) =>
          `${i + 1}. **${warscrollName(r)}**\n` +
          `Used ${fmtPct(warscrollUsedPct(r))} | ` +
          `Win ${fmtPct(warscrollWinPct(r))} | ` +
          `Impact ${fmtPP(warscrollImpactPP(r))}`
        ).join("\n\n")
      );

      addCachedLine(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ---------------- COMMON / LEASTCOMMON ----------------
    if (cmd === "common" || cmd === "leastcommon") {
      const fac = interaction.options.getString("faction");
      const fq = norm(fac);

      let rows = warscrollCache
        .filter(r => warscrollGames(r) >= MIN_GAMES)
        .filter(r => norm(warscrollFaction(r)).includes(fq));

      rows.sort((a, b) =>
        (warscrollUsedPct(b) || 0) - (warscrollUsedPct(a) || 0)
      );

      if (cmd === "leastcommon") rows.reverse();

      rows = rows.slice(0, 10);

      const embed = makeBaseEmbed(
        `${cmd === "common" ? "Most" : "Least"} used warscrolls — ${fac}`
      );

      embed.setDescription(
        rows.map((r, i) =>
          `${i + 1}. **${warscrollName(r)}** — ${fmtPct(warscrollUsedPct(r))}`
        ).join("\n")
      );

      addCachedLine(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ---------------- IMPACT / LEASTIMPACT ----------------
    if (cmd === "impact" || cmd === "leastimpact") {
      const fac = interaction.options.getString("faction");
      const baseRow = findFactionOverallRowByInput(fac);

      if (!baseRow) {
        return interaction.editReply({
          embeds: [makeBaseEmbed("No data").setDescription("Faction not found.")],
        });
      }

      const baseWin = factionWinPct(baseRow);

      let rows = warscrollCache
        .filter(r => warscrollGames(r) >= MIN_GAMES)
        .filter(r => norm(warscrollFaction(r)).includes(norm(factionName(baseRow))))
        .map(r => ({ r, lift: warscrollLiftVsFaction(r, baseWin) }))
        .filter(x => Number.isFinite(x.lift));

      rows.sort((a, b) => b.lift - a.lift);
      if (cmd === "leastimpact") rows.reverse();

      rows = rows.slice(0, 10);

      const embed = makeBaseEmbed(
        `${cmd === "impact" ? "Positive" : "Negative"} impact — ${fac}`
      );

      embed.setDescription(
        rows.map((x, i) =>
          `${i + 1}. **${warscrollName(x.r)}** — ${fmtPP(x.lift)}`
        ).join("\n")
      );

      addCachedLine(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ---------------- FACTION ----------------
    if (cmd === "faction") {
      const facInput = interaction.options.getString("name");
      const formInput = interaction.options.getString("formation");

      const rows = factionCache.filter(r =>
        norm(factionName(r)).includes(norm(facInput))
      );

      if (!rows.length) {
        return interaction.editReply({
          embeds: [makeBaseEmbed("No results").setDescription("Faction not found.")],
        });
      }

      const row =
        formInput
          ? rows.find(r => norm(formationName(r)).includes(norm(formInput)))
          : rows.find(r => norm(formationName(r)) === "overall") || rows[0];

      const embed = makeBaseEmbed(
        `${factionName(row)} — ${formationName(row) || "Overall"}`
      );

      embed.setDescription(
        [
          `**Win rate:** ${fmtPct(factionWinPct(row), 1)}`,
          `**Games:** ${fmtInt(factionGames(row))}`,
          ``,
          `**Summary**`,
          buildFactionBlurb(row),
        ].join("\n")
      );

      const topWs = topWarscrollsForFaction(factionName(row), 3);
      const block = formatTopWarscrollsBlock(topWs);
      if (block) embed.addFields({ name: "Top Warscrolls", value: block });

      addCachedLine(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ---------------- FALLBACK ----------------
    return interaction.editReply({
      embeds: [makeBaseEmbed("Unknown command").setDescription("Try /help")],
    });

  } catch (err) {
    console.error("COMMAND ERROR:", err);
    return interaction.editReply({
      embeds: [
        makeBaseEmbed("❌ Internal error")
          .setDescription(String(err?.message ?? err)),
      ],
    });
  }
});

// ==================================================
// LOGIN
// ==================================================
client.login(TOKEN);
