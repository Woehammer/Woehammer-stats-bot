import { Client, GatewayIntentBits, SlashCommandBuilder } from "discord.js";

/**
 * REQUIRED ENV VARS (Railway -> Variables)
 * - DISCORD_TOKEN
 * - SHEET_CSV_URL
 */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CSV_URL = process.env.SHEET_CSV_URL;
if (!CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");
if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN env var");

// ---- Settings you can tweak ----
const MIN_GAMES = 5;                      // ignore rows with fewer than this many games
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours cache
const MAX_LIST_RESULTS = 10;              // top/bottom list size
// --------------------------------

/* ---------------- Cache ---------------- */
let cache = {
  at: 0,
  headers: null,
  rows: null
};

async function loadCSVCached(force = false) {
  const now = Date.now();
  if (!force && cache.rows && (now - cache.at) < CACHE_TTL_MS) {
    return { headers: cache.headers, rows: cache.rows, cached: true };
  }

  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status} ${res.statusText}`);
  const text = await res.text();

  const rows = text
    .split("\n")
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => r.split(",").map(c => c.replace(/^"|"$/g, "").trim()))
    .filter(r => r.length > 1);

  const headers = rows.shift();
  cache = { at: now, headers, rows };

  return { headers, rows, cached: false };
}

/* ---------------- Helpers ---------------- */
function normalise(str) {
  return (str || "")
    .toLowerCase()
    .replace(/^the\s+/i, "") // ignore leading "The"
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function asNumber(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).replace("%", "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function getIdx(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error(`Missing required column: ${name}`);
  return idx;
}

function pickRowData(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

function impactPP(winWith, winWithout) {
  const diff = asNumber(winWith) - asNumber(winWithout);
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(0)}pp`;
}

function formatWarscrollLine(d) {
  const games = asNumber(d["Faction Games Featured"]);
  const win = d["Win %"];
  const used = d["Used %"];
  const avg = d["Av Per List"];
  const wout = d["Win % Without"];
  const imp = impactPP(win, wout);

  return (
    `**${d.Warscroll}**\n` +
    `Used: ${used} of faction lists | Games: ${games} | Win: ${win} | Avg/list: ${avg} | Win w/o: ${wout} | Impact: ${imp}`
  );
}

function factionMatch(rowFaction, queryFaction) {
  const f = normalise(rowFaction);
  const q = normalise(queryFaction);
  return f.includes(q) || q.includes(f);
}

function safeChunk(text, max = 1900) {
  if (text.length <= max) return [text];
  const parts = [];
  let remaining = text;

  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < 500) cut = max;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length) parts.push(remaining);
  return parts;
}

/* ---------------- Commands ---------------- */
const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available commands and examples"),

  new SlashCommandBuilder()
    .setName("warscroll")
    .setDescription("Search warscroll stats (partial matches allowed)")
    .addStringOption(o =>
      o.setName("name")
        .setDescription("Warscroll name (partial OK, e.g. 'krethusa')")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("compare")
    .setDescription("Compare two warscrolls (first match for each query)")
    .addStringOption(o =>
      o.setName("a")
        .setDescription("Warscroll A (partial OK)")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("b")
        .setDescription("Warscroll B (partial OK)")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("common")
    .setDescription("Top 10 most common warscrolls for a faction (by Used %)")
    .addStringOption(o =>
      o.setName("faction")
        .setDescription("Faction name, e.g. 'Fyreslayers'")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("leastcommon")
    .setDescription("Bottom 10 least common warscrolls for a faction (by Used %)")
    .addStringOption(o =>
      o.setName("faction")
        .setDescription("Faction name, e.g. 'Stormcast'")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("impact")
    .setDescription("Top 10 warscrolls with biggest win-rate impact for a faction (by |Impact pp|)")
    .addStringOption(o =>
      o.setName("faction")
        .setDescription("Faction name, e.g. 'Slaves to Darkness'")
        .setRequired(true)
    )
].map(c => c.toJSON());

/* ---------------- Startup ---------------- */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await client.application.commands.set(commands);
  console.log("Slash commands registered:", commands.map(c => `/${c.name}`).join(", "));
});

/* ---------------- Interaction Handler ---------------- */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply();

  try {
    const { headers, rows } = await loadCSVCached(false);

    const idxFaction = getIdx(headers, "Faction");
    const idxWarscroll = getIdx(headers, "Warscroll");
    const idxGames = getIdx(headers, "Faction Games Featured");
    const idxUsed = getIdx(headers, "Used %");

    const command = interaction.commandName;

    // -------- /help --------
    if (command === "help") {
      const out =
        `**Woehammer Stats Bot — Commands**\n` +
        `*(Ignoring rows with < ${MIN_GAMES} games)*\n\n` +
        `• **/warscroll** name: Search warscrolls (partial matches)\n` +
        `  Example: \`/warscroll name: krethusa\`\n\n` +
        `• **/compare** a + b: Compare two warscrolls\n` +
        `  Example: \`/compare a: krethusa b: scourge of ghyran krethusa\`\n\n` +
        `• **/common** faction: Top 10 most used warscrolls (by Used %)\n` +
        `  Example: \`/common faction: fyreslayers\`\n\n` +
        `• **/leastcommon** faction: Bottom 10 least used warscrolls (by Used %)\n` +
        `  Example: \`/leastcommon faction: stormcast\`\n\n` +
        `• **/impact** faction: Biggest win-rate swings (Impact in pp)\n` +
        `  Example: \`/impact faction: slaves to darkness\`\n\n` +
        `Impact = (Win %) - (Win % Without) shown as percentage points (pp).\n` +
        `Source: Google Sheets (CSV)`;

      return interaction.editReply(out);
    }

    // -------- /warscroll --------
    if (command === "warscroll") {
      const raw = interaction.options.getString("name");
      const q = normalise(raw);

      const matches = rows
        .filter(r => asNumber(r[idxGames]) >= MIN_GAMES)
        .filter(r => normalise(r[idxWarscroll]).includes(q))
        .slice(0, 10);

      if (!matches.length) {
        return interaction.editReply(`No matches for "${raw}" (min games filter: ${MIN_GAMES}+).`);
      }

      const lines = matches.map(r => formatWarscrollLine(pickRowData(headers, r)));

      const out =
        `**Warscroll results for:** ${raw}\n` +
        `*(Ignoring rows with < ${MIN_GAMES} games)*\n\n` +
        lines.join("\n\n") +
        `\n\nSource: Google Sheets (CSV)`;

      return interaction.editReply(out);
    }

    // -------- /compare --------
    if (command === "compare") {
      const aRaw = interaction.options.getString("a");
      const bRaw = interaction.options.getString("b");
      const aQ = normalise(aRaw);
      const bQ = normalise(bRaw);

      const eligible = rows.filter(r => asNumber(r[idxGames]) >= MIN_GAMES);

      const aRow = eligible.find(r => normalise(r[idxWarscroll]).includes(aQ));
      const bRow = eligible.find(r => normalise(r[idxWarscroll]).includes(bQ));

      if (!aRow || !bRow) {
        const missing = [
          !aRow ? `A ("${aRaw}")` : null,
          !bRow ? `B ("${bRaw}")` : null
        ].filter(Boolean).join(" and ");

        return interaction.editReply(
          `Couldn’t find ${missing} (min games filter: ${MIN_GAMES}+). Try more letters.`
        );
      }

      const a = pickRowData(headers, aRow);
      const b = pickRowData(headers, bRow);

      const out =
        `**Compare** *(Ignoring rows with < ${MIN_GAMES} games)*\n\n` +
        `A) ${formatWarscrollLine(a)}\n\n` +
        `B) ${formatWarscrollLine(b)}\n\n` +
        `Source: Google Sheets (CSV)`;

      return interaction.editReply(out);
    }

    // shared faction list builder for /common /leastcommon /impact
    const buildFactionList = (factionQuery) => {
      const elig = rows
        .filter(r => asNumber(r[idxGames]) >= MIN_GAMES)
        .filter(r => factionMatch(r[idxFaction], factionQuery));

      return elig.map(r => pickRowData(headers, r));
    };

    // -------- /common --------
    if (command === "common") {
      const faction = interaction.options.getString("faction");
      const list = buildFactionList(faction);

      if (!list.length) {
        return interaction.editReply(`No rows found for "${faction}" (min games filter: ${MIN_GAMES}+).`);
      }

      list.sort((a, b) => {
        const du = asNumber(b["Used %"]) - asNumber(a["Used %"]);
        if (du !== 0) return du;
        return asNumber(b["Faction Games Featured"]) - asNumber(a["Faction Games Featured"]);
      });

      const top = list.slice(0, MAX_LIST_RESULTS);
      const lines = top.map((d, i) =>
        `${i + 1}. **${d.Warscroll}**\n` +
        `Used: ${d["Used %"]} | Games: ${d["Faction Games Featured"]} | Win: ${d["Win %"]} | Impact: ${impactPP(d["Win %"], d["Win % Without"])}`
      );

      const out =
        `**Top ${MAX_LIST_RESULTS} most common warscrolls — ${top[0].Faction}**\n` +
        `Most common = highest Used %\n` +
        `*(Ignoring rows with < ${MIN_GAMES} games)*\n\n` +
        lines.join("\n\n") +
        `\n\nSource: Google Sheets (CSV)`;

      return interaction.editReply(out);
    }

    // -------- /leastcommon --------
    if (command === "leastcommon") {
      const faction = interaction.options.getString("faction");
      const list = buildFactionList(faction);

      if (!list.length) {
        return interaction.editReply(`No rows found for "${faction}" (min games filter: ${MIN_GAMES}+).`);
      }

      list.sort((a, b) => {
        const du = asNumber(a["Used %"]) - asNumber(b["Used %"]);
        if (du !== 0) return du;
        return asNumber(a["Faction Games Featured"]) - asNumber(b["Faction Games Featured"]);
      });

      const bottom = list.slice(0, MAX_LIST_RESULTS);
      const lines = bottom.map((d, i) =>
        `${i + 1}. **${d.Warscroll}**\n` +
        `Used: ${d["Used %"]} | Games: ${d["Faction Games Featured"]} | Win: ${d["Win %"]} | Impact: ${impactPP(d["Win %"], d["Win % Without"])}`
      );

      const out =
        `**Bottom ${MAX_LIST_RESULTS} least common warscrolls — ${bottom[0].Faction}**\n` +
        `Least common = lowest Used %\n` +
        `*(Ignoring rows with < ${MIN_GAMES} games)*\n\n` +
        lines.join("\n\n") +
        `\n\nSource: Google Sheets (CSV)`;

      return interaction.editReply(out);
    }

    // -------- /impact --------
    if (command === "impact") {
      const faction = interaction.options.getString("faction");
      const list = buildFactionList(faction);

      if (!list.length) {
        return interaction.editReply(`No rows found for "${faction}" (min games filter: ${MIN_GAMES}+).`);
      }

      list.sort((a, b) => {
        const aImp = Math.abs(asNumber(a["Win %"]) - asNumber(a["Win % Without"]));
        const bImp = Math.abs(asNumber(b["Win %"]) - asNumber(b["Win % Without"]));
        if (bImp !== aImp) return bImp - aImp;
        return asNumber(b["Faction Games Featured"]) - asNumber(a["Faction Games Featured"]);
      });

      const top = list.slice(0, MAX_LIST_RESULTS);
      const lines = top.map((d, i) => {
        const imp = impactPP(d["Win %"], d["Win % Without"]);
        return (
          `${i + 1}. **${d.Warscroll}**\n` +
          `Impact: ${imp} | Used: ${d["Used %"]} | Games: ${d["Faction Games Featured"]} | Win: ${d["Win %"]} | Win w/o: ${d["Win % Without"]}`
        );
      });

      const out =
        `**Top ${MAX_LIST_RESULTS} warscrolls by impact — ${top[0].Faction}**\n` +
        `Impact = (Win %) - (Win % Without), shown as percentage points (pp)\n` +
        `*(Ignoring rows with < ${MIN_GAMES} games)*\n\n` +
        lines.join("\n\n") +
        `\n\nSource: Google Sheets (CSV)`;

      const chunks = safeChunk(out);
      if (chunks.length === 1) return interaction.editReply(chunks[0]);

      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
      }
      return;
    }

    return interaction.editReply("Unknown command. (This shouldn’t happen.)");

  } catch (err) {
    console.error(err);
    return interaction.editReply("❌ Internal error (check Railway logs).");
  }
});

/* ---------------- Login ---------------- */
client.login(process.env.DISCORD_TOKEN);
