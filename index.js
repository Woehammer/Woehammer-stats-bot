// index.js
// Discord.js v14 single-file bot (ESM)
// Env vars required:
//   DISCORD_TOKEN
//   SHEET_CSV_URL     (warscroll CSV)
//   FACTION_CSV_URL   (faction CSV)

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
  console.warn("⚠️ Missing SHEET_CSV_URL env var (warscroll commands will fail).");
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
  // leave user's casing alone if they typed it; used only for computed labels
  return String(s ?? "").trim();
}

function fmtHeaderLine(fac, form) {
  return `**${String(fac ?? "").toUpperCase()} — ${String(form ?? "").toUpperCase()}**`;
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
  if (!res.ok) throw new Error(`Failed to fetch CSV (${res.status})`);
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

async function refreshAll() {
  await Promise.all([loadWarscrolls(true), loadFactions(true)]);
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
  return getCol(row, ["Battle Formation", "Battle formation", "Formation", "formation"]);
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

// -------------------- Bot summary blurb --------------------
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

  const parts = [];
  if (Number.isFinite(games)) parts.push(`Based on ${fmtInt(games)} games.`);

  const avgVs400 = Number.isFinite(avg) ? avg - 400 : NaN;
  const medVs400 = Number.isFinite(med) ? med - 400 : NaN;

  if (Number.isFinite(avg) && Number.isFinite(med) && Number.isFinite(gap)) {
    const vibe =
      gap >= 40
        ? "specialist-driven (big Elo gap)"
        : gap >= 20
          ? "top-heavy (moderate Elo gap)"
          : gap <= -20
            ? "oddly inverted (median > average)"
            : "pretty even (small Elo gap)";
    parts.push(
      `Elo looks ${vibe}: avg ${fmt1(avg)} (≈${fmtInt(avgVs400)} over 400), median ${fmt1(
        med
      )} (≈${fmtInt(medVs400)} over 400), gap ${fmt1(gap)}.`
    );
  } else if (Number.isFinite(avg) || Number.isFinite(med)) {
    parts.push(
      `Elo: avg ${fmt1(avg)} (≈${fmtInt(avgVs400)} over 400), median ${fmt1(
        med
      )} (≈${fmtInt(medVs400)} over 400).`
    );
  }

  if (Number.isFinite(win)) parts.push(`Win rate is ${fmtPct(win, 1)}.`);

  const topEnd = [];
  if (Number.isFinite(p50)) topEnd.push(`${fmtPct(p50, 2)} 5–0s`);
  if (Number.isFinite(p41)) topEnd.push(`${fmtPct(p41, 1)} 4–1s`);

  const lowEnd = [];
  if (Number.isFinite(p05)) lowEnd.push(`${fmtPct(p05, 1)} 0–5`);
  if (Number.isFinite(p14)) lowEnd.push(`${fmtPct(p14, 1)} 1–4`);

  if (topEnd.length) parts.push(`Top-end finishes: ${topEnd.join(", ")}.`);
  if (lowEnd.length) parts.push(`Lower-end finishes: ${lowEnd.join(", ")}.`);

  const mid = [];
  if (Number.isFinite(p32)) mid.push(`${fmtPct(p32, 1)} 3–2`);
  if (Number.isFinite(p23)) mid.push(`${fmtPct(p23, 1)} 2–3`);
  if (mid.length) parts.push(`Middle: ${mid.join(", ")}.`);

  return parts.join(" ");
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

  // Keep it short and readable on mobile
  const lines = list.map((w, i) => {
    return `**${i + 1}. ${w.name}** — Used **${fmtPct(w.used, 0)}**, Win ${fmtPct(
      w.win,
      0
    )}, Impact ${fmtPP(w.impact)}`;
  });

  return [
    `**Most-used warscrolls**`,
    ...lines,
  ].join("\n");
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

    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Top 10 biggest win-rate swings for a faction (Impact in pp)")
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
    await refreshAll();
    console.log("✅ Cache warm complete.");
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
          {
            name: "/warscroll name",
            value:
              "Search warscrolls (partial match)\nExample: `/warscroll name: krethusa`",
          },
          {
            name: "/compare a b",
            value:
              "Compare two warscrolls\nExample: `/compare a: krethusa b: scourge of ghyran krethusa`",
          },
          {
            name: "/common faction",
            value:
              "Top 10 most used warscrolls (by Used %)\nExample: `/common faction: ironjawz`",
          },
          {
            name: "/leastcommon faction",
            value:
              "Bottom 10 least used warscrolls (by Used %)\nExample: `/leastcommon faction: stormcast`",
          },
          {
            name: "/impact faction",
            value:
              "Biggest win-rate swings (Impact in pp)\nExample: `/impact faction: slaves to darkness`",
          },
          {
            name: "/faction name formation?",
            value:
              "Faction stats (Overall or a specific battle formation)\nExample: `/faction name: blades of khorne formation: the goretide`",
          },
          { name: "/refresh", value: "Admin only: refresh cached CSV data" }
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
      await refreshAll();
      const embed = makeBaseEmbed("✅ Refreshed CSV cache");
      addCachedLine(embed, warscrollCachedAt, factionCachedAt);
      return interaction.editReply({ embeds: [embed] });
    }

    if (["warscroll", "compare", "common", "leastcommon", "impact"].includes(cmd)) {
      await loadWarscrolls(false);
    }
    if (cmd === "faction") {
      await loadFactions(false);
      // For the "Most-used warscrolls" block in /faction, we also need warscroll cache.
      // If SHEET_CSV_URL is missing, we just omit that section.
      try {
        if (SHEET_CSV_URL) await loadWarscrolls(false);
      } catch {
        // ignore; we can still show faction stats
      }
    }

    if (cmd === "warscroll") {
      const q = norm(interaction.options.getString("name"));

      const matches = warscrollCache
        .filter((r) => warscrollGames(r) >= MIN_GAMES)
        .filter((r) => norm(warscrollName(r)).includes(q))
        .slice(0, 10);

      if (!matches.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No warscroll rows found for "${interaction.options.getString(
            "name"
          )}" (≥ ${MIN_GAMES} games).`
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
            !aMatches.length
              ? `No matches for A: "${interaction.options.getString("a")}"`
              : null,
            !bMatches.length
              ? `No matches for B: "${interaction.options.getString("b")}"`
              : null,
          ]
            .filter(Boolean)
            .join("\n")
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

    if (cmd === "common" || cmd === "leastcommon" || cmd === "impact") {
      const facQ = norm(interaction.options.getString("faction"));

      let rows = warscrollCache
        .filter((r) => warscrollGames(r) >= MIN_GAMES)
        .filter((r) => norm(warscrollFaction(r)).includes(facQ));

      if (!rows.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No warscroll rows found for "${interaction.options.getString(
            "faction"
          )}" (≥ ${MIN_GAMES} games).`
        );
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      const prettyFaction = interaction.options.getString("faction");

      if (cmd === "common") {
        rows = rows
          .slice()
          .sort(
            (a, b) =>
              (warscrollUsedPct(b) || -Infinity) -
              (warscrollUsedPct(a) || -Infinity)
          )
          .slice(0, 10);

        const embed = makeBaseEmbed(`Top 10 most common warscrolls — ${prettyFaction}`)
          .setDescription("Most common = highest Used %");

        const lines = rows.map((r, i) =>
          [
            `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
            `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
              warscrollGames(r)
            )} | Win: ${fmtPct(warscrollWinPct(r), 0)} | Impact: ${fmtPP(
              warscrollImpactPP(r)
            )}`,
          ].join("\n")
        );

        embed.addFields({ name: "Results", value: lines.join("\n\n") });
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      if (cmd === "leastcommon") {
        rows = rows
          .slice()
          .sort(
            (a, b) =>
              (warscrollUsedPct(a) || Infinity) -
              (warscrollUsedPct(b) || Infinity)
          )
          .slice(0, 10);

        const embed = makeBaseEmbed(`Bottom 10 least common warscrolls — ${prettyFaction}`)
          .setDescription("Least common = lowest Used %");

        const lines = rows.map((r, i) =>
          [
            `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
            `Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
              warscrollGames(r)
            )} | Win: ${fmtPct(warscrollWinPct(r), 0)} | Impact: ${fmtPP(
              warscrollImpactPP(r)
            )}`,
          ].join("\n")
        );

        embed.addFields({ name: "Results", value: lines.join("\n\n") });
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }

      if (cmd === "impact") {
        rows = rows
          .slice()
          .sort(
            (a, b) =>
              Math.abs(warscrollImpactPP(b) || 0) -
              Math.abs(warscrollImpactPP(a) || 0)
          )
          .slice(0, 10);

        const embed = makeBaseEmbed(`Top 10 warscrolls with biggest impact — ${prettyFaction}`)
          .setDescription("Impact = (Win %) − (Win % Without) shown as percentage points (pp).");

        const lines = rows.map((r, i) =>
          [
            `${i + 1}. **${warscrollName(r) || "Unknown"}**`,
            `Impact: ${fmtPP(warscrollImpactPP(r))} | Win: ${fmtPct(
              warscrollWinPct(r),
              0
            )} | Used: ${fmtPct(warscrollUsedPct(r), 0)} | Games: ${fmtInt(
              warscrollGames(r)
            )}`,
          ].join("\n")
        );

        embed.addFields({ name: "Results", value: lines.join("\n\n") });
        addCachedLine(embed, warscrollCachedAt, factionCachedAt);
        return interaction.editReply({ embeds: [embed] });
      }
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
        row = factionRows.find((r) => norm(formationName(r)) === "overall") || factionRows[0];
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

      // Optional “most-used warscrolls” block (only if warscroll cache available)
      const topWs =
        warscrollCache.length ? topWarscrollsForFaction(fac, 3) : [];
      const topWsBlock = formatTopWarscrollsBlock(topWs);

      // New tidy presentation
      embed.setDescription(
        [
          fmtHeaderLine(fac, form),
          ``,
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
          `**3–2:** **${fmtPct(p32, 1)}**`,
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
