// index.js
// Woehammer Stats Bot (Discord.js v14)
// Commands: /help /peek /refresh (admin-only) /warscroll /common /leastcommon /impact /compare
// Data source: Google Sheets published as CSV (SHEET_CSV_URL)
// Caching: in-memory with optional manual refresh

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";

/* -------------------- Config -------------------- */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CSV_URL = process.env.SHEET_CSV_URL;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Admin-only refresh: put YOUR Discord user ID in Railway env var ADMIN_USER_IDS
// Example: "123456789012345678,987654321098765432"
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Ignore low sample rows
const MIN_GAMES = Number(process.env.MIN_GAMES || 5);

// Optional: auto-refresh every X hours (0 = off)
const AUTO_REFRESH_HOURS = Number(process.env.AUTO_REFRESH_HOURS || 0);

/* -------------------- Cache -------------------- */

let cache = {
  loadedAt: 0,
  headers: [],
  rows: [],
};

function nowMs() {
  return Date.now();
}

/* -------------------- Helpers -------------------- */

function normalise(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePercent(value) {
  // Accepts: "47%", "47", "47.0", ""
  if (value == null) return NaN;
  const s = String(value).trim().replace("%", "");
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseNumber(value) {
  if (value == null) return NaN;
  const s = String(value).trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// Robust CSV split for basic CSV (Google Sheets export is usually simple).
// If you later hit commas inside quoted text, switch to a real CSV parser.
function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      // escaped quote
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.map((c) => c.replace(/^"|"$/g, "").trim());
}

async function fetchCSV() {
  if (!CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();

  const rows = text
    .split("\n")
    .map((r) => r.replace(/\r$/, ""))
    .filter((r) => r.trim().length > 0)
    .map((r) => splitCSVLine(r))
    .filter((r) => r.length > 1);

  const headers = rows.shift() || [];
  return { headers, rows };
}

async function ensureCacheLoaded(force = false) {
  if (!force && cache.rows.length && cache.loadedAt) return cache;
  const { headers, rows } = await fetchCSV();
  cache = {
    loadedAt: nowMs(),
    headers,
    rows,
  };
  return cache;
}

function isAdmin(interaction) {
  if (!ADMIN_USER_IDS.length) return false;
  return ADMIN_USER_IDS.includes(interaction.user.id);
}

function headerIndex(headers, name) {
  return headers.findIndex((h) => String(h).trim() === name);
}

function buildSourceFooter() {
  const dt = new Date(cache.loadedAt || nowMs());
  return `Source: Google Sheets (CSV) • Cached: ${dt.toLocaleString()}`;
}

/* -------------------- Data extraction -------------------- */

function buildRowObject(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

function getGamesValue(rowObj) {
  // Expect column name exactly as your sheet: "Faction Games Featured"
  return parseNumber(rowObj["Faction Games Featured"]);
}

function passesMinGames(rowObj) {
  const g = getGamesValue(rowObj);
  return Number.isFinite(g) && g >= MIN_GAMES;
}

function impactPP(rowObj) {
  const win = parsePercent(rowObj["Win %"]);
  const without = parsePercent(rowObj["Win % Without"]);
  if (!Number.isFinite(win) || !Number.isFinite(without)) return NaN;
  return win - without;
}

/* -------------------- Embeds -------------------- */

function embedError(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc);
}

function embedHelp() {
  return new EmbedBuilder()
    .setTitle("Woehammer Stats Bot — Commands")
    .setDescription(`(Ignoring rows with < ${MIN_GAMES} games)`)
    .addFields(
      {
        name: "/warscroll",
        value:
          "Search warscrolls (partial matches)\nExample: `/warscroll name: krethusa`",
      },
      {
        name: "/compare",
        value:
          "Compare two warscrolls\nExample: `/compare a: krethusa b: scourge of ghyran krethusa`",
      },
      {
        name: "/common",
        value:
          "Top 10 most used warscrolls (by Used %)\nExample: `/common faction: fyreslayers`",
      },
      {
        name: "/leastcommon",
        value:
          "Bottom 10 least used warscrolls (by Used %)\nExample: `/leastcommon faction: stormcast`",
      },
      {
        name: "/impact",
        value:
          "Biggest win-rate swings (Impact in pp)\nExample: `/impact faction: slaves to darkness`",
      },
      {
        name: "/peek",
        value: "Show detected sheet headers",
      },
      {
        name: "/refresh (Admin only)",
        value:
          "Reload stats from Google Sheets\nExample: `/refresh`",
      }
    )
    .addFields({
      name: "Impact definition",
      value:
        "Impact = (Win %) − (Win % Without) shown as percentage points (pp).",
    })
    .setFooter({ text: buildSourceFooter() });
}

function embedWarscrollResults(queryRaw, matches) {
  const e = new EmbedBuilder()
    .setTitle(`Warscroll results for: ${queryRaw}`)
    .setFooter({ text: buildSourceFooter() });

  // Keep it readable: warscroll bold, stats on next line
  // Also stay within Discord embed limits (field values max 1024 chars)
  const lines = matches.slice(0, 10).map((m, i) => {
    const imp = impactPP(m);
    const impText = Number.isFinite(imp) ? ` | Impact: ${imp > 0 ? "+" : ""}${imp.toFixed(0)}pp` : "";
    return (
      `${i + 1}. **${m.Warscroll}** (${m.Faction})\n` +
      `Games: ${m["Faction Games Featured"]} | Win: ${m["Win %"]} | Used: ${m["Used %"]} of faction lists | Avg/list: ${m["Av Per List"]} | Win w/o: ${m["Win % Without"]}${impText}`
    );
  });

  e.setDescription(lines.join("\n\n"));
  return e;
}

function embedRankedList(title, subtitle, rows) {
  const e = new EmbedBuilder()
    .setTitle(title)
    .setDescription(subtitle)
    .setFooter({ text: buildSourceFooter() });

  const lines = rows.slice(0, 10).map((r, i) => {
    const imp = impactPP(r);
    const impText = Number.isFinite(imp) ? ` | Impact: ${imp > 0 ? "+" : ""}${imp.toFixed(0)}pp` : "";
    return (
      `${i + 1}. **${r.Warscroll}**\n` +
      `Used: ${r["Used %"]} | Games: ${r["Faction Games Featured"]} | Win: ${r["Win %"]}${impText}`
    );
  });

  e.addFields({ name: "Results", value: lines.join("\n\n") });
  return e;
}

function embedImpactList(faction, rows) {
  const e = new EmbedBuilder()
    .setTitle(`Top 10 warscrolls by win-rate impact — ${faction}`)
    .setDescription("Impact = (Win %) − (Win % Without) in percentage points (pp)")
    .setFooter({ text: buildSourceFooter() });

  const lines = rows.slice(0, 10).map((r, i) => {
    const imp = impactPP(r);
    const impText = Number.isFinite(imp) ? `${imp > 0 ? "+" : ""}${imp.toFixed(0)}pp` : "n/a";
    return (
      `${i + 1}. **${r.Warscroll}**\n` +
      `Impact: ${impText} | Used: ${r["Used %"]} | Games: ${r["Faction Games Featured"]} | Win: ${r["Win %"]} | Win w/o: ${r["Win % Without"]}`
    );
  });

  e.addFields({ name: "Results", value: lines.join("\n\n") });
  return e;
}

function embedCompare(aObj, bObj) {
  const aImp = impactPP(aObj);
  const bImp = impactPP(bObj);

  const e = new EmbedBuilder()
    .setTitle("Warscroll compare")
    .setFooter({ text: buildSourceFooter() })
    .addFields(
      {
        name: `A — ${aObj.Warscroll}`,
        value:
          `Faction: ${aObj.Faction}\n` +
          `Games: ${aObj["Faction Games Featured"]}\n` +
          `Win %: ${aObj["Win %"]}\n` +
          `Used %: ${aObj["Used %"]} of faction lists\n` +
          `Avg/list: ${aObj["Av Per List"]}\n` +
          `Win % without: ${aObj["Win % Without"]}\n` +
          `Impact: ${Number.isFinite(aImp) ? `${aImp > 0 ? "+" : ""}${aImp.toFixed(0)}pp` : "n/a"}`,
        inline: true,
      },
      {
        name: `B — ${bObj.Warscroll}`,
        value:
          `Faction: ${bObj.Faction}\n` +
          `Games: ${bObj["Faction Games Featured"]}\n` +
          `Win %: ${bObj["Win %"]}\n` +
          `Used %: ${bObj["Used %"]} of faction lists\n` +
          `Avg/list: ${bObj["Av Per List"]}\n` +
          `Win % without: ${bObj["Win % Without"]}\n` +
          `Impact: ${Number.isFinite(bImp) ? `${bImp > 0 ? "+" : ""}${bImp.toFixed(0)}pp` : "n/a"}`,
        inline: true,
      }
    );

  return e;
}

/* -------------------- Commands registration -------------------- */

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show bot commands"),
    new SlashCommandBuilder().setName("peek").setDescription("Show detected sheet headers"),

    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Admin only: refresh cached Google Sheets data"),

    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscroll stats (partial matches)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Warscroll name (partial ok)").setRequired(true)
      ),

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
      .setDescription("Top 10 biggest win-rate impacts for a faction (pp)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("compare")
      .setDescription("Compare two warscrolls")
      .addStringOption((o) =>
        o.setName("a").setDescription("Warscroll A").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("b").setDescription("Warscroll B").setRequired(true)
      ),
  ].map((c) => c.toJSON());

  await client.application.commands.set(commands);

  // Warm cache on startup (fast first command)
  try {
    await ensureCacheLoaded(true);
    console.log("CSV cache loaded.");
  } catch (e) {
    console.warn("CSV cache load failed on startup:", e?.message || e);
  }

  // Optional auto-refresh timer
  if (AUTO_REFRESH_HOURS > 0) {
    setInterval(async () => {
      try {
        await ensureCacheLoaded(true);
        console.log("Auto-refreshed CSV cache.");
      } catch (e) {
        console.warn("Auto-refresh failed:", e?.message || e);
      }
    }, AUTO_REFRESH_HOURS * 60 * 60 * 1000);
  }
});

/* -------------------- Interaction Handler -------------------- */

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Avoid 40060 errors: only acknowledge once.
  // Defer for anything that fetches/filters data.
  const cmd = interaction.commandName;

  const shouldDefer = ["peek", "refresh", "warscroll", "common", "leastcommon", "impact", "compare"].includes(cmd);
  if (shouldDefer) await interaction.deferReply({ ephemeral: false });

  try {
    // /help is instant and doesn’t need data
    if (cmd === "help") {
      return interaction.reply({ embeds: [embedHelp()], ephemeral: false });
    }

    // Ensure cache
    await ensureCacheLoaded(false);
    const { headers, rows } = cache;

    if (cmd === "peek") {
      const e = new EmbedBuilder()
        .setTitle("Headers I see")
        .setDescription(headers.map((h) => `• ${h}`).join("\n"))
        .setFooter({ text: buildSourceFooter() });

      return interaction.editReply({ embeds: [e] });
    }

    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        return interaction.editReply({
          embeds: [embedError("❌ Not allowed", "This command is admin-only.")],
        });
      }

      await ensureCacheLoaded(true);
      const dt = new Date(cache.loadedAt);
      return interaction.editReply(
        `✅ Refreshed data cache.\nCached at: **${dt.toLocaleString()}**`
      );
    }

    // Column checks (fail fast if sheet changes)
    const required = [
      "Faction",
      "Warscroll",
      "Faction Games Featured",
      "Win %",
      "Used %",
      "Av Per List",
      "Faction Games Excluded",
      "Win % Without",
    ];
    const missing = required.filter((h) => headerIndex(headers, h) === -1);
    if (missing.length) {
      return interaction.editReply(
        `❌ Sheet is missing columns:\n• ${missing.join("\n• ")}`
      );
    }

    // Convert all rows to objects (once per request)
    // Filter by min games to keep results sane
    const rowObjs = rows
      .map((r) => buildRowObject(headers, r))
      .filter((o) => passesMinGames(o));

    if (cmd === "warscroll") {
      const raw = interaction.options.getString("name");
      const query = normalise(raw);

      const matches = rowObjs
        .filter((o) => normalise(o.Warscroll).includes(query))
        .slice(0, 10);

      if (!matches.length) {
        return interaction.editReply(`No matches for "${raw}".`);
      }

      return interaction.editReply({ embeds: [embedWarscrollResults(raw, matches)] });
    }

    if (cmd === "common" || cmd === "leastcommon") {
      const rawFaction = interaction.options.getString("faction");
      const qFaction = normalise(rawFaction);

      const factionRows = rowObjs.filter((o) => normalise(o.Faction).includes(qFaction));
      if (!factionRows.length) {
        return interaction.editReply(`No rows found for faction "${rawFaction}".`);
      }

      // Sort by Used % numeric
      const sorted = factionRows
        .map((o) => ({ ...o, __used: parsePercent(o["Used %"]) }))
        .filter((o) => Number.isFinite(o.__used))
        .sort((a, b) => b.__used - a.__used);

      const list = cmd === "leastcommon" ? [...sorted].reverse() : sorted;

      const title =
        cmd === "leastcommon"
          ? `Bottom 10 least common warscrolls — ${rawFaction}`
          : `Top 10 most common warscrolls — ${rawFaction}`;

      const subtitle =
        cmd === "leastcommon"
          ? "Least common = lowest Used %"
          : "Most common = highest Used %";

      return interaction.editReply({
        embeds: [embedRankedList(title, subtitle, list)],
      });
    }

    if (cmd === "impact") {
      const rawFaction = interaction.options.getString("faction");
      const qFaction = normalise(rawFaction);

      const factionRows = rowObjs.filter((o) => normalise(o.Faction).includes(qFaction));
      if (!factionRows.length) {
        return interaction.editReply(`No rows found for faction "${rawFaction}".`);
      }

      const withImpact = factionRows
        .map((o) => ({ ...o, __impact: impactPP(o) }))
        .filter((o) => Number.isFinite(o.__impact))
        // Sort by absolute swing (biggest magnitude)
        .sort((a, b) => Math.abs(b.__impact) - Math.abs(a.__impact));

      return interaction.editReply({
        embeds: [embedImpactList(rawFaction, withImpact)],
      });
    }

    if (cmd === "compare") {
      const rawA = interaction.options.getString("a");
      const rawB = interaction.options.getString("b");
      const qA = normalise(rawA);
      const qB = normalise(rawB);

      const findBest = (q) => {
        const exact = rowObjs.find((o) => normalise(o.Warscroll) === q);
        if (exact) return exact;
        return rowObjs.find((o) => normalise(o.Warscroll).includes(q)) || null;
      };

      const aObj = findBest(qA);
      const bObj = findBest(qB);

      if (!aObj || !bObj) {
        return interaction.editReply(
          `Couldn’t find both warscrolls.\nA: ${aObj ? "✅" : "❌"} (${rawA})\nB: ${bObj ? "✅" : "❌"} (${rawB})`
        );
      }

      return interaction.editReply({ embeds: [embedCompare(aObj, bObj)] });
    }

    // fallback
    return interaction.editReply("❌ Unknown command.");

  } catch (err) {
    console.error(err);
    // If the interaction was deferred, we must editReply. If not, reply.
    try {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply("❌ Internal error (check logs).");
      }
      return interaction.reply("❌ Internal error (check logs).");
    } catch {
      // swallow
    }
  }
});

/* -------------------- Login -------------------- */

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN env var");
client.login(DISCORD_TOKEN);
