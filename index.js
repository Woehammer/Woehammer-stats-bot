// index.js (ESM)
// Discord.js v14+
// Env vars required:
// - DISCORD_TOKEN
// - SHEET_CSV_URL
// - FACTION_CSV_URL   (optional until your faction sheet is ready)
// Optional:
// - ADMIN_USER_IDS          (comma-separated Discord user IDs who can /refresh)
// - MIN_GAMES               (default 5)
// - PORT                    (for Railway/hosts that expect a web listener)

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} from "discord.js";

import http from "node:http";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const WARSCROLL_CSV_URL = process.env.SHEET_CSV_URL;
const FACTION_CSV_URL = process.env.FACTION_CSV_URL;

const MIN_GAMES = Number(process.env.MIN_GAMES ?? 5);

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAdmin(interaction) {
  // Either explicitly listed, or has Discord Administrator permission
  if (ADMIN_USER_IDS.includes(interaction.user.id)) return true;
  const memberPerms = interaction.memberPermissions;
  if (memberPerms?.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}

/* -------------------- Tiny HTTP listener (helps some hosts) -------------------- */
const PORT = process.env.PORT;
if (PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Woehammer Stats bot is alive.\n");
    })
    .listen(PORT, () => console.log(`HTTP listener on :${PORT}`));
}

/* -------------------- CSV + Cache -------------------- */
let warscrollCache = { headers: null, rows: null, fetchedAt: null };
let factionCache = { headers: null, rows: null, fetchedAt: null };

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.text();
}

// Minimal CSV parser that handles quoted commas
function parseCSV(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length);

  if (!lines.length) return { headers: [], rows: [] };

  const rows = lines.map(parseCSVLine);
  const headers = rows.shift() ?? [];
  return { headers, rows };
}

function parseCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"' && line[i + 1] === '"') {
      // Escaped quote
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

function normalize(str) {
  return (str ?? "")
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePercent(v) {
  if (v == null) return null;
  const s = String(v).trim().replace("%", "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseNumber(v) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function prettyPct(n, decimals = 0) {
  if (n == null || !Number.isFinite(n)) return "—";
  const d = decimals;
  return `${n.toFixed(d)}%`;
}

function prettyNum(n, decimals = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function nowStamp() {
  // UK-ish readable stamp without timezone fuss
  const d = new Date();
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

async function loadWarscrollData({ force = false } = {}) {
  if (!WARSCROLL_CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");

  if (!force && warscrollCache.headers && warscrollCache.rows) return warscrollCache;

  const text = await fetchText(WARSCROLL_CSV_URL);
  const parsed = parseCSV(text);

  warscrollCache = {
    headers: parsed.headers,
    rows: parsed.rows,
    fetchedAt: new Date(),
  };

  return warscrollCache;
}

async function loadFactionData({ force = false } = {}) {
  if (!FACTION_CSV_URL) {
    return {
      headers: null,
      rows: null,
      fetchedAt: null,
      missing: true,
    };
  }

  if (!force && factionCache.headers && factionCache.rows) return factionCache;

  const text = await fetchText(FACTION_CSV_URL);
  const parsed = parseCSV(text);

  factionCache = {
    headers: parsed.headers,
    rows: parsed.rows,
    fetchedAt: new Date(),
  };

  return factionCache;
}

function cacheFooter() {
  const w = warscrollCache.fetchedAt ? nowStamp() : "—";
  // If faction cache exists, show whichever is newer
  const f = factionCache.fetchedAt ? nowStamp() : null;
  const stamp = f ? `${w} (warscroll) / ${f} (faction)` : w;
  return `Source: Woehammer GT Database • Cached: ${stamp}`;
}

/* -------------------- Helpers: lookups -------------------- */
function getIdx(headers, name) {
  return headers.indexOf(name);
}

function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

function bestMatchesByColumn(rows, headers, columnName, query, max = 10) {
  const idx = getIdx(headers, columnName);
  if (idx === -1) return [];

  const q = normalize(query);
  if (!q) return [];

  const scored = rows
    .map((r) => {
      const val = r[idx] ?? "";
      const n = normalize(val);
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80;
      else if (n.includes(q)) score = 60;
      else score = 0;
      return { r, score, val };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, max).map((x) => x.r);
}

/* -------------------- Output builders -------------------- */
function baseEmbed() {
  return new EmbedBuilder().setColor(0x2f3136);
}

function warscrollLine(obj) {
  const used = parsePercent(obj["Used %"]);
  const games = parseNumber(obj["Faction Games Featured"]);
  const win = parsePercent(obj["Win %"]);
  const wout = parsePercent(obj["Win % Without"]);
  const impact = win != null && wout != null ? win - wout : null;

  return {
    name: obj.Warscroll,
    faction: obj.Faction,
    used,
    games,
    win,
    wout,
    impact,
    avPerList: parseNumber(obj["Av Per List"]),
  };
}

function formatWarscrollResultLine(x) {
  // name bold, stats on next line
  const impactStr =
    x.impact == null ? "Impact: —" : `Impact: ${(x.impact >= 0 ? "+" : "")}${x.impact.toFixed(0)}pp`;
  const usedStr = x.used == null ? "Used: —" : `Used: ${x.used.toFixed(0)}% of faction lists`;
  const gamesStr = x.games == null ? "Games: —" : `Games: ${x.games}`;
  const winStr = x.win == null ? "Win: —" : `Win: ${x.win.toFixed(0)}%`;

  return `**${x.name}**\n${usedStr} | ${gamesStr} | ${winStr} | ${impactStr}`;
}

function buildFactionSummary(obj) {
  const games = parseNumber(obj["Games"]);
  const share = parsePercent(obj["Games Share"]);
  const win = parsePercent(obj["Win %"]);
  const avgElo = parseNumber(obj["Average Elo"]);
  const medElo = parseNumber(obj["Median Elo"]);
  const gap = parseNumber(obj["Elo Gap"]);

  const p5 = parsePercent(obj["Players Achieving 5 Wins"]);
  const p4 = parsePercent(obj["Players Achieving 4 wins"]);
  const p3 = parsePercent(obj["Players Achieving 3 Wins"]);
  const p2 = parsePercent(obj["Players Achieving 2 wins"]);
  const p1 = parsePercent(obj["Players Achieving 1 Win"]);
  // optional columns might exist:
  const p0 = parsePercent(obj["Players Achieving 0 Wins"]) ?? parsePercent(obj["Players Achieving 0 wins"]);
  const p05 = parsePercent(obj["Players Achieving 0–5"]) ?? null; // ignore if not present

  // Bot blurb logic (simple + readable)
  let style = "mixed";
  if (gap != null) {
    if (gap >= 50) style = "specialist-driven";
    else if (gap <= 15) style = "consistent";
  }

  // Elo baseline reminder: 400 is starting Elo
  let eloTake = "";
  if (avgElo != null) {
    if (avgElo >= 460) eloTake = "Above-average player pool (vs 400 start).";
    else if (avgElo <= 410) eloTake = "Mostly newer/lower-rated player pool (vs 400 start).";
    else eloTake = "Roughly average player pool (vs 400 start).";
  }

  let wrTake = "";
  if (win != null && avgElo != null) {
    if (win >= 55 && avgElo <= 430) wrTake = "Win rate looks strong even without an elite Elo base.";
    else if (win <= 45 && avgElo >= 460) wrTake = "Win rate underperforms despite a strong Elo base.";
    else wrTake = "Win rate broadly matches the Elo profile.";
  }

  const lines = [];

  // Spread stats across lines (your request)
  lines.push(`Games: **${games ?? "—"}** (${share != null ? `${share.toFixed(1)}% share` : "—"})`);
  lines.push(`Win rate: **${win != null ? win.toFixed(1) + "%" : "—"}**`);
  lines.push(`Elo: Avg **${avgElo != null ? avgElo.toFixed(1) : "—"}** | Median **${medElo != null ? medElo.toFixed(1) : "—"}** | Gap **${gap != null ? gap.toFixed(1) : "—"}**`);
  lines.push(
    `Finishes: 5–0 **${prettyPct(p5, 2)}** | 4–1 **${prettyPct(p4, 1)}** | 3–2 **${prettyPct(p3, 1)}**`
  );
  lines.push(
    `More: 2–3 **${prettyPct(p2, 1)}** | 1–4 **${prettyPct(p1, 1)}**${p0 != null ? ` | 0–5 **${prettyPct(p0, 1)}**` : ""}`
  );

  const summary = [
    `Based on **${games ?? "—"}** games. Results look **${style}**${gap != null ? ` (Elo gap ${gap.toFixed(1)})` : ""}.`,
    eloTake,
    wrTake,
  ]
    .filter(Boolean)
    .join(" ");

  return { lines, summary };
}

/* -------------------- Slash Commands -------------------- */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show bot commands"),

    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscroll stats (partial matches)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Warscroll name (or part of it)").setRequired(true)
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

  // Global command update
  await client.application.commands.set(commands);

  // Warm the cache once at boot (fast responses afterwards)
  try {
    await loadWarscrollData({ force: true });
    await loadFactionData({ force: true });
    console.log("Caches warmed.");
  } catch (e) {
    console.warn("Cache warm failed:", e?.message ?? e);
  }
});

/* -------------------- Interaction Handler -------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply();

  try {
    const cmd = interaction.commandName;

    if (cmd === "help") {
      const embed = baseEmbed()
        .setTitle("Woehammer Stats Bot — Commands")
        .setDescription(
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
            `• **/faction** name + optional formation: Faction stats\n` +
            `  Example: \`/faction name: blades of khorne\`\n` +
            `  Example: \`/faction name: blades of khorne formation: the goretide\`\n\n` +
            `Impact = (Win %) − (Win % Without) shown as percentage points (pp).\n\n` +
            cacheFooter()
        );

      return interaction.editReply({ embeds: [embed], content: "" });
    }

    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        const embed = baseEmbed()
          .setTitle("❌ Not allowed")
          .setDescription("You’re not on the admin list for `/refresh`.");
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      warscrollCache = { headers: null, rows: null, fetchedAt: null };
      factionCache = { headers: null, rows: null, fetchedAt: null };

      await loadWarscrollData({ force: true });
      await loadFactionData({ force: true });

      const embed = baseEmbed()
        .setTitle("✅ Refreshed")
        .setDescription(`Reloaded CSV data.\n\n${cacheFooter()}`);

      return interaction.editReply({ embeds: [embed], content: "" });
    }

    // Warscroll sheet needed for the commands below
    const { headers, rows } = await loadWarscrollData();

    // Required warscroll columns sanity check
    const idxFaction = getIdx(headers, "Faction");
    const idxWarscroll = getIdx(headers, "Warscroll");
    const idxGames = getIdx(headers, "Faction Games Featured");

    if (idxFaction === -1 || idxWarscroll === -1 || idxGames === -1) {
      const embed = baseEmbed()
        .setTitle("❌ Sheet error")
        .setDescription(
          `I can’t find one or more required columns in the warscroll CSV.\n` +
            `Need: **Faction**, **Warscroll**, **Faction Games Featured**.\n\n` +
            cacheFooter()
        );
      return interaction.editReply({ embeds: [embed], content: "" });
    }

    // Filter out rows with < MIN_GAMES
    const filtered = rows.filter((r) => {
      const g = parseNumber(r[idxGames]);
      return g != null && g >= MIN_GAMES;
    });

    if (cmd === "warscroll") {
      const queryRaw = interaction.options.getString("name");
      const matches = bestMatchesByColumn(filtered, headers, "Warscroll", queryRaw, 10);

      if (!matches.length) {
        const embed = baseEmbed()
          .setTitle("No matches")
          .setDescription(`No warscroll rows found for **"${queryRaw}"** (≥ ${MIN_GAMES} games).\n\n${cacheFooter()}`);
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      const objs = matches.map((r) => warscrollLine(rowToObj(headers, r)));

      const body = objs
        .slice(0, 6)
        .map((x, i) => `${i + 1}. ${formatWarscrollResultLine(x)}\n`)
        .join("\n");

      const embed = baseEmbed()
        .setTitle(`Warscroll results for: ${queryRaw}`)
        .setDescription(`${body}\n${cacheFooter()}`);

      return interaction.editReply({ embeds: [embed], content: "" });
    }

    if (cmd === "compare") {
      const aRaw = interaction.options.getString("a");
      const bRaw = interaction.options.getString("b");

      const aRow = bestMatchesByColumn(filtered, headers, "Warscroll", aRaw, 1)[0];
      const bRow = bestMatchesByColumn(filtered, headers, "Warscroll", bRaw, 1)[0];

      if (!aRow || !bRow) {
        const embed = baseEmbed()
          .setTitle("Not enough matches")
          .setDescription(
            `I couldn’t find both warscrolls (≥ ${MIN_GAMES} games).\n` +
              `Try being a bit more specific.\n\n${cacheFooter()}`
          );
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      const a = warscrollLine(rowToObj(headers, aRow));
      const b = warscrollLine(rowToObj(headers, bRow));

      const embed = baseEmbed()
        .setTitle("Warscroll comparison")
        .addFields(
          {
            name: `${a.name} (${a.faction})`,
            value:
              `Used: **${a.used?.toFixed(0) ?? "—"}%** of faction lists\n` +
              `Games: **${a.games ?? "—"}**\n` +
              `Win: **${a.win?.toFixed(0) ?? "—"}%**\n` +
              `Win w/o: **${a.wout?.toFixed(0) ?? "—"}%**\n` +
              `Impact: **${a.impact == null ? "—" : `${a.impact >= 0 ? "+" : ""}${a.impact.toFixed(0)}pp`}**`,
            inline: true,
          },
          {
            name: `${b.name} (${b.faction})`,
            value:
              `Used: **${b.used?.toFixed(0) ?? "—"}%** of faction lists\n` +
              `Games: **${b.games ?? "—"}**\n` +
              `Win: **${b.win?.toFixed(0) ?? "—"}%**\n` +
              `Win w/o: **${b.wout?.toFixed(0) ?? "—"}%**\n` +
              `Impact: **${b.impact == null ? "—" : `${b.impact >= 0 ? "+" : ""}${b.impact.toFixed(0)}pp`}**`,
            inline: true,
          }
        )
        .setFooter({ text: cacheFooter() });

      return interaction.editReply({ embeds: [embed], content: "" });
    }

    // faction-based warscroll lists
    if (cmd === "common" || cmd === "leastcommon" || cmd === "impact") {
      const factionRaw = interaction.options.getString("faction");
      const fNorm = normalize(factionRaw);

      const factionRows = filtered.filter((r) => normalize(r[idxFaction]) === fNorm);

      if (!factionRows.length) {
        const embed = baseEmbed()
          .setTitle("No results")
          .setDescription(
            `No warscroll rows found for **"${factionRaw}"** (≥ ${MIN_GAMES} games).\n\n${cacheFooter()}`
          );
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      const objs = factionRows.map((r) => warscrollLine(rowToObj(headers, r)));

      let sorted = objs;

      if (cmd === "common") {
        sorted = [...objs].sort((a, b) => (b.used ?? -1) - (a.used ?? -1));
      } else if (cmd === "leastcommon") {
        sorted = [...objs].sort((a, b) => (a.used ?? 999999) - (b.used ?? 999999));
      } else if (cmd === "impact") {
        sorted = [...objs].sort((a, b) => Math.abs(b.impact ?? -1) - Math.abs(a.impact ?? -1));
      }

      const top = sorted.slice(0, 10);

      const headerTitle =
        cmd === "common"
          ? `Top 10 most common warscrolls — ${factionRaw}`
          : cmd === "leastcommon"
            ? `Bottom 10 least common warscrolls — ${factionRaw}`
            : `Top 10 biggest impact warscrolls — ${factionRaw}`;

      const sub =
        cmd === "common"
          ? `*Most common = highest Used %*`
          : cmd === "leastcommon"
            ? `*Least common = lowest Used %*`
            : `*Impact = (Win %) − (Win % Without), in percentage points (pp)*`;

      const body = top
        .map((x, i) => `${i + 1}. ${formatWarscrollResultLine(x)}`)
        .join("\n\n");

      const embed = baseEmbed()
        .setTitle(headerTitle)
        .setDescription(`${sub}\n\n**Results**\n\n${body}\n\n${cacheFooter()}`);

      return interaction.editReply({ embeds: [embed], content: "" });
    }

    if (cmd === "faction") {
      const nameRaw = interaction.options.getString("name");
      const formationRaw = interaction.options.getString("formation") ?? "Overall";

      const facData = await loadFactionData();

      if (facData.missing) {
        const embed = baseEmbed()
          .setTitle("Faction sheet not configured")
          .setDescription(
            `You haven’t set **FACTION_CSV_URL** yet.\n\n` +
              `Once you do, \`/faction\` will work.\n\n${cacheFooter()}`
          );
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      const fh = facData.headers;
      const fr = facData.rows;

      const fIdxFaction = getIdx(fh, "Faction");
      const fIdxFormation = getIdx(fh, "Battle Formation");
      const fIdxGames = getIdx(fh, "Games");

      if (fIdxFaction === -1 || fIdxFormation === -1 || fIdxGames === -1) {
        const embed = baseEmbed()
          .setTitle("❌ Sheet error")
          .setDescription(
            `I can’t find required columns in BOT_FACTION CSV.\n` +
              `Need: **Faction**, **Battle Formation**, **Games**.\n\n${cacheFooter()}`
          );
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      const fName = normalize(nameRaw);
      const fFormation = normalize(formationRaw);

      const eligible = fr.filter((r) => {
        const g = parseNumber(r[fIdxGames]);
        return g != null && g >= MIN_GAMES;
      });

      // match faction exactly (normalized)
      const byFaction = eligible.filter((r) => normalize(r[fIdxFaction]) === fName);

      if (!byFaction.length) {
        const embed = baseEmbed()
          .setTitle("No results")
          .setDescription(`No faction rows found for **"${nameRaw}"** (≥ ${MIN_GAMES} games).\n\n${cacheFooter()}`);
        return interaction.editReply({ embeds: [embed], content: "" });
      }

      // formation: try exact first, then contains
      let picked =
        byFaction.find((r) => normalize(r[fIdxFormation]) === fFormation) ??
        byFaction.find((r) => normalize(r[fIdxFormation]).includes(fFormation));

      // if still nothing, default to Overall
      if (!picked) {
        picked = byFaction.find((r) => normalize(r[fIdxFormation]) === "overall") ?? byFaction[0];
      }

      const obj = rowToObj(fh, picked);
      const titleFaction = obj["Faction"] ?? nameRaw;
      const titleFormation = obj["Battle Formation"] ?? formationRaw;

      const { lines, summary } = buildFactionSummary(obj);

      const embed = baseEmbed()
        .setTitle(`${titleFaction} — ${titleFormation}`)
        .setDescription(
          `${lines.join("\n")}\n\n` +
            `**Bot summary**\n${summary}\n\n` +
            cacheFooter()
        );

      return interaction.editReply({ embeds: [embed], content: "" });
    }

    // Unknown command fallback
    const embed = baseEmbed()
      .setTitle("❌ Unknown command")
      .setDescription(`Try **/help**.\n\n${cacheFooter()}`);

    return interaction.editReply({ embeds: [embed], content: "" });
  } catch (err) {
    console.error(err);
    const embed = baseEmbed()
      .setTitle("❌ Internal error")
      .setDescription(`Check logs.\n\n${cacheFooter()}`);
    return interaction.editReply({ embeds: [embed], content: "" });
  }
});

/* -------------------- Login -------------------- */
client.login(process.env.DISCORD_TOKEN);
