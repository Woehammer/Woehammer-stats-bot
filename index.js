// index.js
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import http from "http";

/* -------------------- Keep Replit Deploy alive (opens a port) -------------------- */
const PORT = process.env.PORT || 8000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server listening on :${PORT}`));

/* -------------------- Discord client -------------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const CSV_URL = process.env.SHEET_CSV_URL;
if (!CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");
if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN env var");

/* -------------------- Crash visibility (don’t die silently) -------------------- */
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

/* -------------------- Cache (sheet updates weekly, so cache hard) -------------------- */
let CACHE = { at: 0, headers: null, rows: null };
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/* -------------------- Helpers -------------------- */
function normalise(str = "") {
  return String(str)
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asNumber(v) {
  if (v == null) return null;
  const s = String(v).trim().replace("%", "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(v) {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  return s.includes("%") ? s : `${s}%`;
}

function ppDiff(winPct, winWithoutPct) {
  const a = asNumber(winPct);
  const b = asNumber(winWithoutPct);
  if (a == null || b == null) return "—";
  const d = a - b;
  const sign = d >= 0 ? "+" : "";
  return `${sign}${Math.round(d)}pp`;
}

// CSV parser that respects quotes (so commas inside cells won’t explode you)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => String(c).trim() !== "")) rows.push(row.map((c) => String(c).trim()));
      row = [];
      continue;
    }
    cur += ch;
  }

  row.push(cur);
  if (row.some((c) => String(c).trim() !== "")) rows.push(row.map((c) => String(c).trim()));
  return rows;
}

async function loadCSV(force = false) {
  const now = Date.now();
  if (!force && CACHE.headers && CACHE.rows && now - CACHE.at < CACHE_TTL_MS) {
    return { headers: CACHE.headers, rows: CACHE.rows, cached: true };
  }

  const res = await fetch(CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);

  const text = await res.text();
  const parsed = parseCSV(text);
  const headers = parsed.shift() || [];
  const rows = parsed;

  CACHE = { at: now, headers, rows };
  return { headers, rows, cached: false };
}

function idx(headers, name) {
  return headers.indexOf(name);
}

function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

function pickFactionRows(allRows, factionQuery) {
  const fq = normalise(factionQuery);
  // exact normalised match preferred
  let exact = allRows.filter((d) => normalise(d.Faction) === fq);
  if (exact.length) return { rows: exact, chosen: exact[0].Faction };

  // partial fallback
  const partial = allRows.filter((d) => normalise(d.Faction).includes(fq));
  if (!partial.length) return { rows: [], chosen: null };

  // choose most common exact string among partial matches
  const counts = new Map();
  for (const d of partial) counts.set(d.Faction, (counts.get(d.Faction) || 0) + 1);
  const chosen = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { rows: partial.filter((d) => d.Faction === chosen), chosen };
}

function safeFieldValue(text) {
  // Discord field value limit is 1024 chars
  if (text.length <= 1024) return text;
  return text.slice(0, 1010) + "\n…(trimmed)";
}

function makeEmbed(title, description, fields) {
  const embed = new EmbedBuilder().setTitle(title).setDescription(description);
  if (fields?.length) {
    embed.addFields(fields.map((f) => ({ ...f, value: safeFieldValue(f.value) })));
  }
  embed.setFooter({ text: "Source: Google Sheets (CSV)" });
  return embed;
}

/* -------------------- Command registration -------------------- */
client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName("peek").setDescription("Show detected sheet headers"),
    new SlashCommandBuilder().setName("refresh").setDescription("Refresh cached CSV now"),

    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscroll stats (partial matches supported)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Warscroll name (partial ok)").setRequired(true)
      ),

    // aliases: /common and /top10 do the same thing
    new SlashCommandBuilder()
      .setName("common")
      .setDescription("Top 10 most common warscrolls in a faction (by Used %)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("top10")
      .setDescription("Alias of /common")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    // aliases: /leastcommon and /least10 do the same thing
    new SlashCommandBuilder()
      .setName("leastcommon")
      .setDescription("Bottom 10 least common warscrolls in a faction (by Used %)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("least10")
      .setDescription("Alias of /leastcommon")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    // aliases: /impact and /impact10 do the same thing
    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Top 10 warscrolls by impact (+pp) for a faction (Win% − Win% Without)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("impact10")
      .setDescription("Alias of /impact")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("factionsummary")
      .setDescription("Faction summary: common, least common, best & worst impact (top 3 each)")
      .addStringOption((o) =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),
  ].map((c) => c.toJSON());

  await client.application.commands.set(commands);

  // Warm cache so first user doesn’t pay the fetch cost
  loadCSV().catch(console.error);
});

/* -------------------- Interaction handler (no double-ack, no 40060) -------------------- */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ACK ONCE
  await interaction.deferReply({ ephemeral: false });

  try {
    const cmd = interaction.commandName;

    if (cmd === "refresh") {
      await loadCSV(true);
      return interaction.editReply("✅ Cache refreshed.");
    }

    const { headers, rows, cached } = await loadCSV(false);
    const all = rows.map((r) => rowToObj(headers, r));

    if (cmd === "peek") {
      return interaction.editReply(
        `Headers I see${cached ? " (cached)" : ""}:\n• ${headers.join("\n• ")}`
      );
    }

    // Required columns
    const warscrollCol = idx(headers, "Warscroll");
    const factionCol = idx(headers, "Faction");
    if (warscrollCol === -1 || factionCol === -1) {
      return interaction.editReply("❌ Missing required columns: `Faction` and/or `Warscroll`.");
    }

    /* -------------------- /warscroll -------------------- */
    if (cmd === "warscroll") {
      const raw = interaction.options.getString("name", true);
      const q = normalise(raw);

      const matches = all.filter((d) => normalise(d.Warscroll).includes(q));
      if (!matches.length) return interaction.editReply(`No matches for "${raw}".`);

      // cap at 10 results so we don’t hit Discord limits
      const shown = matches.slice(0, 10);

      const lines = shown.map((d, i) => {
        const usedTxt = d["Used %"] ? `${fmtPct(d["Used %"])} of faction lists` : "—";
        return (
          `${i + 1}. **${d.Warscroll}** (${d.Faction})\n` +
          `Games: ${d["Faction Games Featured"] ?? "—"} | Win: ${fmtPct(d["Win %"])} | Used: ${usedTxt} | Avg/list: ${d["Av Per List"] ?? "—"} | Win w/o: ${fmtPct(d["Win % Without"])}`
        );
      });

      const embed = makeEmbed(
        `Warscroll results for: ${raw}`,
        `Showing ${shown.length}${matches.length > shown.length ? ` of ${matches.length}` : ""} matches.`,
        [{ name: "Results", value: lines.join("\n\n") }]
      );
      return interaction.editReply({ embeds: [embed] });
    }

    /* -------------------- Faction-based commands -------------------- */
    const isCommon = cmd === "common" || cmd === "top10";
    const isLeast = cmd === "leastcommon" || cmd === "least10";
    const isImpact = cmd === "impact" || cmd === "impact10";
    const isSummary = cmd === "factionsummary";

    if (isCommon || isLeast || isImpact || isSummary) {
      const factionRaw = interaction.options.getString("faction", true);
      const { rows: factionRows, chosen } = pickFactionRows(all, factionRaw);

      if (!factionRows.length) {
        // suggest a few faction names
        const uniq = [...new Set(all.map((d) => d.Faction).filter(Boolean))];
        const sug = uniq
          .map((f) => ({ f, score: normalise(f).includes(normalise(factionRaw)) ? 0 : 1 }))
          .sort((a, b) => a.score - b.score || a.f.localeCompare(b.f))
          .slice(0, 5)
          .map((x) => `• ${x.f}`)
          .join("\n");
        return interaction.editReply(`No faction match for "${factionRaw}". Try:\n${sug}`);
      }

      const factionName = chosen || factionRows[0].Faction;

      // Common/Least by Used %
      const usedSorted = [...factionRows].sort(
        (a, b) => (asNumber(b["Used %"]) ?? -999) - (asNumber(a["Used %"]) ?? -999)
      );

      // Impact sort
      const impactSorted = [...factionRows]
        .map((d) => {
          const win = d["Win %"];
          const wwo = d["Win % Without"];
          const diff = (asNumber(win) ?? 0) - (asNumber(wwo) ?? 0);
          return { d, diff };
        })
        .sort((a, b) => b.diff - a.diff);

      if (isCommon || isLeast) {
        const list = (isCommon ? usedSorted : [...usedSorted].reverse()).slice(0, 10);

        const lines = list.map((d, i) => {
          return (
            `${i + 1}. **${d.Warscroll}**\n` +
            `Used: ${fmtPct(d["Used %"])} | Games: ${d["Faction Games Featured"] ?? "—"} | Win: ${fmtPct(d["Win %"])}`
          );
        });

        const embed = makeEmbed(
          isCommon
            ? `Top 10 most common warscrolls — ${factionName}`
            : `Bottom 10 least common warscrolls — ${factionName}`,
          isCommon ? "Most common = highest Used %" : "Least common = lowest Used %",
          [{ name: "Results", value: lines.join("\n\n") }]
        );
        return interaction.editReply({ embeds: [embed] });
      }

      if (isImpact) {
        const list = impactSorted.slice(0, 10);

        const lines = list.map((x, i) => {
          const d = x.d;
          const impact = ppDiff(d["Win %"], d["Win % Without"]);
          return (
            `${i + 1}. **${d.Warscroll}**\n` +
            `Impact: ${impact} | Win: ${fmtPct(d["Win %"])} | Win w/o: ${fmtPct(d["Win % Without"])} | Used: ${fmtPct(d["Used %"])} | Games: ${d["Faction Games Featured"] ?? "—"}`
          );
        });

        const embed = makeEmbed(
          `Top 10 warscrolls by impact — ${factionName}`,
          "Impact = Win % − Win % Without (percentage points)",
          [{ name: "Results", value: lines.join("\n\n") }]
        );
        return interaction.editReply({ embeds: [embed] });
      }

      if (isSummary) {
        // Top 3 each to avoid Discord field limits
        const topCommon = usedSorted.slice(0, 3);
        const botLeast = [...usedSorted].reverse().slice(0, 3);
        const bestImpact = impactSorted.slice(0, 3).map((x) => x.d);
        const worstImpact = [...impactSorted].reverse().slice(0, 3).map((x) => x.d);

        const fmtUsedLine = (d, i) =>
          `${i + 1}. **${d.Warscroll}**\nUsed: ${fmtPct(d["Used %"])} | Games: ${d["Faction Games Featured"] ?? "—"} | Win: ${fmtPct(d["Win %"])}`;

        const fmtImpactLine = (d, i) =>
          `${i + 1}. **${d.Warscroll}**\nImpact: ${ppDiff(d["Win %"], d["Win % Without"])} | Win: ${fmtPct(d["Win %"])} | Win w/o: ${fmtPct(d["Win % Without"])} | Used: ${fmtPct(d["Used %"])}`;

        const embed = makeEmbed(
          `Faction summary — ${factionName}`,
          "Top/bottom 3 for readability (Discord limits are tight).",
          [
            { name: "Top 3 most common (Used %)", value: topCommon.map(fmtUsedLine).join("\n\n") || "—" },
            { name: "Bottom 3 least common (Used %)", value: botLeast.map(fmtUsedLine).join("\n\n") || "—" },
            { name: "Top 3 best impact (+pp)", value: bestImpact.map(fmtImpactLine).join("\n\n") || "—" },
            { name: "Bottom 3 worst impact (+pp)", value: worstImpact.map(fmtImpactLine).join("\n\n") || "—" },
          ]
        );

        return interaction.editReply({ embeds: [embed] });
      }
    }

    return interaction.editReply("❌ Unknown command.");
  } catch (err) {
    console.error(err);
    // Already deferred, so only editReply here
    return interaction.editReply("❌ Internal error (check logs).");
  }
});

/* -------------------- Login -------------------- */
client.login(process.env.DISCORD_TOKEN);
