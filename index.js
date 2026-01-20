import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

/* =========================
   Config
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const WARSCR_CSV_URL = process.env.SHEET_CSV_URL;     // warscroll sheet CSV
const FACTION_CSV_URL = process.env.FACTION_CSV_URL;  // BOT_FACTION sheet CSV

if (!WARSCR_CSV_URL) console.warn("⚠️ Missing SHEET_CSV_URL (warscroll CSV).");
if (!FACTION_CSV_URL) console.warn("⚠️ Missing FACTION_CSV_URL (faction CSV).");

/* =========================
   Normalisation helpers
========================= */
function normalise(str = "") {
  return str
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePercent(val) {
  // accepts "53.8%" or "53.8" or "" -> number
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  const num = Number(s.replace("%", ""));
  return Number.isFinite(num) ? num : null;
}

function parseNumber(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

function hasMinGames(rowObj, minGames = 5) {
  const g = parseNumber(rowObj["Games"]);
  return g != null && g >= minGames;
}

/* =========================
   CSV loading + caching
   (fast + sheet only updates weekly)
========================= */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (adjust)
let warscrollCache = { at: 0, headers: [], rows: [] };
let factionCache = { at: 0, headers: [], rows: [] };

async function loadCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed CSV fetch (${res.status})`);
  const text = await res.text();

  // naive CSV split (works if your sheet is simple, which yours is)
  const rows = text
    .split("\n")
    .map(r =>
      r
        .split(",")
        .map(c => c.replace(/^"|"$/g, "").trim())
    )
    .filter(r => r.length > 1);

  const headers = rows.shift() || [];
  return { headers, rows };
}

async function getWarscrollData(force = false) {
  const now = Date.now();
  if (!force && warscrollCache.rows.length && now - warscrollCache.at < CACHE_TTL_MS) {
    return warscrollCache;
  }
  if (!WARSCR_CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");
  const fresh = await loadCSV(WARSCR_CSV_URL);
  warscrollCache = { at: now, ...fresh };
  return warscrollCache;
}

async function getFactionData(force = false) {
  const now = Date.now();
  if (!force && factionCache.rows.length && now - factionCache.at < CACHE_TTL_MS) {
    return factionCache;
  }
  if (!FACTION_CSV_URL) throw new Error("Missing FACTION_CSV_URL env var");
  const fresh = await loadCSV(FACTION_CSV_URL);
  factionCache = { at: now, ...fresh };
  return factionCache;
}

/* =========================
   Faction row helpers
========================= */
function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

function findFactionOverall(rowsObj, factionName) {
  const q = normalise(factionName);
  return rowsObj.find(r =>
    normalise(r.Faction) === q && normalise(r["Battle Formation"]) === "overall"
  );
}

function findFactionFormation(rowsObj, factionName, formationName) {
  const fq = normalise(factionName);
  const bq = normalise(formationName);
  return rowsObj.find(r =>
    normalise(r.Faction) === fq && normalise(r["Battle Formation"]) === bq
  );
}

function listFactionFormations(rowsObj, factionName) {
  const fq = normalise(factionName);
  return rowsObj
    .filter(r => normalise(r.Faction) === fq)
    .map(r => r["Battle Formation"])
    .filter(Boolean);
}

/* =========================
   Blurb generator (simple + useful)
========================= */
function makeFactionBlurb(r) {
  // Uses: Win %, Average Elo, Median Elo, Elo Gap, plus 5-0 etc if present
  const win = parsePercent(r["Win %"]);
  const avg = parseNumber(r["Average Elo"]);
  const med = parseNumber(r["Median Elo"]);
  const gap = parseNumber(r["Elo Gap"]); // already computed by you
  const games = parseNumber(r["Games"]);

  // consistency proxy: % 4 wins and % 5 wins if present
  const p5 = parsePercent(r["Players Achieving 5 Wins"]);
  const p4 = parsePercent(r["Players Achieving 4 wins"]); // note your header casing
  const p1 = parsePercent(r["Players Achieving 1 Win"]);
  const p0 = parsePercent(r["Players Without a Win"]);

  const parts = [];

  // Elo gap meaning (starting Elo is 400 — you can mention elsewhere globally)
  if (gap != null) {
    if (gap >= 40) parts.push("Results look specialist-driven (big Elo gap).");
    else if (gap <= 15) parts.push("Performance looks broad-based (small Elo gap).");
    else parts.push("Some top-end lift (moderate Elo gap).");
  }

  if (win != null) {
    if (win >= 55) parts.push("Win rate is above average.");
    else if (win <= 45) parts.push("Win rate is below average.");
    else parts.push("Win rate is middling.");
  }

  if (p5 != null || p4 != null) {
    const p5txt = p5 != null ? `${p5.toFixed(0)}% 5–0s` : null;
    const p4txt = p4 != null ? `${p4.toFixed(0)}% 4–1s` : null;
    const bit = [p5txt, p4txt].filter(Boolean).join(", ");
    if (bit) parts.push(`Top-end finishes: ${bit}.`);
  }

  if (p0 != null || p1 != null) {
    const p0txt = p0 != null ? `${p0.toFixed(0)}% 0–5` : null;
    const p1txt = p1 != null ? `${p1.toFixed(0)}% 1–4` : null;
    const bit = [p0txt, p1txt].filter(Boolean).join(", ");
    if (bit) parts.push(`Lower-end finishes: ${bit}.`);
  }

  if (games != null) parts.unshift(`Based on ${games} games.`);

  return parts.length ? parts.join(" ") : "Not enough data to generate a summary.";
}

/* =========================
   Output formatting (Discord)
========================= */
function formatFactionRow(r, titlePrefix = "") {
  const faction = r.Faction;
  const formation = r["Battle Formation"];
  const games = r["Games"];
  const win = r["Win %"];
  const avg = r["Average Elo"];
  const med = r["Median Elo"];
  const gap = r["Elo Gap"];
  const share = r["Games Share"];

  // keep it readable on mobile:
  return (
    `**${titlePrefix}${faction} — ${formation}**\n` +
    `Games: ${games} (${share ?? "—"} share) | Win: ${win}\n` +
    `Elo: Avg ${avg} | Median ${med} | Gap ${gap}\n` +
    `5–0: ${r["Players Achieving 5 Wins"] ?? "—"} | 4–1: ${r["Players Achieving 4 wins"] ?? "—"} | 3–2: ${r["Players Achieving 3 Wins"] ?? "—"}\n` +
    `2–3: ${r["Players Achieving 2 wins"] ?? "—"} | 1–4: ${r["Players Achieving 1 Win"] ?? "—"} | 0–5: ${r["Players Without a Win"] ?? "—"}`
  );
}

/* =========================
   Slash commands
========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    // help
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show bot commands"),

    // refresh (admin only)
    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Admin only: refresh cached CSV data")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // warscroll search
    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscrolls (partial matches)")
      .addStringOption(o =>
        o.setName("name").setDescription("Warscroll name").setRequired(true)
      ),

    // compare two warscroll queries
    new SlashCommandBuilder()
      .setName("compare")
      .setDescription("Compare two warscroll searches")
      .addStringOption(o => o.setName("a").setDescription("First warscroll query").setRequired(true))
      .addStringOption(o => o.setName("b").setDescription("Second warscroll query").setRequired(true)),

    // top 10 common warscrolls for a faction
    new SlashCommandBuilder()
      .setName("common")
      .setDescription("Top 10 most used warscrolls (by Used %) for a faction")
      .addStringOption(o => o.setName("faction").setDescription("Faction").setRequired(true)),

    // bottom 10 least common warscrolls
    new SlashCommandBuilder()
      .setName("leastcommon")
      .setDescription("Bottom 10 least used warscrolls (by Used %) for a faction")
      .addStringOption(o => o.setName("faction").setDescription("Faction").setRequired(true)),

    // impact (win% - win% without) largest swings
    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Top 10 biggest win-rate swings (Impact in pp) for a faction")
      .addStringOption(o => o.setName("faction").setDescription("Faction").setRequired(true)),

    // NEW: faction overall
    new SlashCommandBuilder()
      .setName("faction")
      .setDescription("Show faction Overall stats + blurb")
      .addStringOption(o => o.setName("name").setDescription("Faction name").setRequired(true)),

    // NEW: formation line
    new SlashCommandBuilder()
      .setName("formation")
      .setDescription("Show stats for a specific formation within a faction")
      .addStringOption(o => o.setName("faction").setDescription("Faction name").setRequired(true))
      .addStringOption(o => o.setName("name").setDescription("Formation name").setRequired(true)),

    // NEW: compare factions
    new SlashCommandBuilder()
      .setName("fcompare")
      .setDescription("Compare two factions (Overall vs Overall)")
      .addStringOption(o => o.setName("a").setDescription("Faction A").setRequired(true))
      .addStringOption(o => o.setName("b").setDescription("Faction B").setRequired(true)),
  ].map(c => c.toJSON());

  await client.application.commands.set(commands);
});

/* =========================
   Interaction handler
========================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // Always defer once per interaction
  await interaction.deferReply();

  try {
    const cmd = interaction.commandName;

    if (cmd === "help") {
      return interaction.editReply(
        `**Woehammer Stats Bot — Commands**\n` +
          `_(Ignoring rows with < 5 games)_\n\n` +
          `• **/warscroll** name: Search warscrolls (partial matches)\n` +
          `• **/compare** a + b: Compare two warscroll searches\n` +
          `• **/common** faction: Top 10 most used warscrolls (Used %)\n` +
          `• **/leastcommon** faction: Bottom 10 least used warscrolls (Used %)\n` +
          `• **/impact** faction: Biggest win-rate swings (pp)\n\n` +
          `• **/faction** name: Overall stats + bot blurb\n` +
          `• **/formation** faction + name: Single formation line\n` +
          `• **/fcompare** a + b: Compare two factions (Overall)\n\n` +
          `Source: **Woehammer GT Database**`
      );
    }

    if (cmd === "refresh") {
      // Discord already gates by admin perms, but we’ll be extra safe:
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.editReply("❌ Admin only.");
      }
      await getWarscrollData(true);
      await getFactionData(true);
      return interaction.editReply("✅ Refreshed cached data.");
    }

    /* ---------- Warscroll sheet commands ---------- */
    if (["warscroll", "compare", "common", "leastcommon", "impact"].includes(cmd)) {
      const { headers, rows } = await getWarscrollData(false);

      const idxWarscroll = headers.indexOf("Warscroll");
      if (idxWarscroll === -1) return interaction.editReply("❌ No `Warscroll` column found.");

      const rowsObj = rows.map(r => rowToObj(headers, r));

      const MIN_GAMES = 5;

      if (cmd === "warscroll") {
        const qRaw = interaction.options.getString("name");
        const q = normalise(qRaw);

        const matches = rowsObj
          .filter(r => hasMinGames(r, MIN_GAMES))
          .filter(r => normalise(r["Warscroll"]).includes(q));

        if (!matches.length) {
          return interaction.editReply(`No matches for "${qRaw}".`);
        }

        // show all matches (but keep it reasonable)
        const top = matches.slice(0, 5);

        const lines = top.map(r => {
          const impact =
            parsePercent(r["Win %"]) != null && parsePercent(r["Win % Without"]) != null
              ? (parsePercent(r["Win %"]) - parsePercent(r["Win % Without"]))
              : null;

          const impactTxt = impact == null ? "" : ` | Impact: ${impact >= 0 ? "+" : ""}${impact.toFixed(0)}pp`;

          return (
            `**${r.Warscroll}** (${r.Faction})\n` +
            `Games: ${r["Faction Games Featured"]} | Win: ${r["Win %"]} | Used: ${r["Used %"]} of faction lists | Avg/list: ${r["Av Per List"]} | Win w/o: ${r["Win % Without"]}${impactTxt}`
          );
        });

        return interaction.editReply(
          `**Warscroll results for:** ${qRaw}\n\n` +
            lines.join("\n\n") +
            `\n\nSource: **Woehammer GT Database**`
        );
      }

      if (cmd === "compare") {
        const aRaw = interaction.options.getString("a");
        const bRaw = interaction.options.getString("b");
        const a = normalise(aRaw);
        const b = normalise(bRaw);

        const aMatch = rowsObj.find(r => hasMinGames(r, MIN_GAMES) && normalise(r["Warscroll"]).includes(a));
        const bMatch = rowsObj.find(r => hasMinGames(r, MIN_GAMES) && normalise(r["Warscroll"]).includes(b));

        if (!aMatch || !bMatch) {
          return interaction.editReply(
            `Couldn't find both entries (need ≥ ${MIN_GAMES} games).\n` +
              `A: ${aMatch ? "✅" : "❌"} "${aRaw}"\n` +
              `B: ${bMatch ? "✅" : "❌"} "${bRaw}"`
          );
        }

        const fmt = r => {
          const impact =
            parsePercent(r["Win %"]) != null && parsePercent(r["Win % Without"]) != null
              ? (parsePercent(r["Win %"]) - parsePercent(r["Win % Without"]))
              : null;
          return (
            `**${r.Warscroll}** (${r.Faction})\n` +
            `Games: ${r["Faction Games Featured"]} | Win: ${r["Win %"]} | Used: ${r["Used %"]} of faction lists\n` +
            `Avg/list: ${r["Av Per List"]} | Win w/o: ${r["Win % Without"]}` +
            (impact == null ? "" : ` | Impact: ${impact >= 0 ? "+" : ""}${impact.toFixed(0)}pp`)
          );
        };

        return interaction.editReply(
          `**Warscroll compare**\n\n${fmt(aMatch)}\n\n${fmt(bMatch)}\n\nSource: **Woehammer GT Database**`
        );
      }

      // faction filter for warscroll commands
      const factionRaw = interaction.options.getString("faction");
      const fq = normalise(factionRaw);

      const pool = rowsObj
        .filter(r => hasMinGames(r, MIN_GAMES))
        .filter(r => normalise(r["Faction"]) === fq);

      if (!pool.length) {
        return interaction.editReply(`No warscroll rows found for "${factionRaw}" (≥ ${MIN_GAMES} games).`);
      }

      if (cmd === "common" || cmd === "leastcommon") {
        const sorted = [...pool].sort((a, b) => (parsePercent(b["Used %"]) ?? -999) - (parsePercent(a["Used %"]) ?? -999));
        const list = cmd === "common" ? sorted.slice(0, 10) : sorted.slice(-10).reverse();

        const title = cmd === "common"
          ? `**Top 10 most common warscrolls — ${pool[0].Faction}**`
          : `**Bottom 10 least common warscrolls — ${pool[0].Faction}**`;

        const subtitle = cmd === "common"
          ? `Most common = highest Used %`
          : `Least common = lowest Used %`;

        const lines = list.map((r, i) => {
          return (
            `${i + 1}. **${r.Warscroll}**\n` +
            `Used: ${r["Used %"]} | Games: ${r["Faction Games Featured"]} | Win: ${r["Win %"]}`
          );
        });

        return interaction.editReply(
          `${title}\n${subtitle}\n\n` +
            lines.join("\n\n") +
            `\n\nSource: **Woehammer GT Database**`
        );
      }

      if (cmd === "impact") {
        // impact = win - winWithout (pp)
        const withImpact = pool
          .map(r => {
            const w = parsePercent(r["Win %"]);
            const wo = parsePercent(r["Win % Without"]);
            if (w == null || wo == null) return null;
            return { r, impact: w - wo };
          })
          .filter(Boolean);

        if (!withImpact.length) {
          return interaction.editReply(`No impact data available for "${pool[0].Faction}".`);
        }

        withImpact.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
        const top = withImpact.slice(0, 10);

        const lines = top.map((x, i) => {
          const sign = x.impact >= 0 ? "+" : "";
          return (
            `${i + 1}. **${x.r.Warscroll}**\n` +
            `Impact: ${sign}${x.impact.toFixed(0)}pp | Win: ${x.r["Win %"]} | Win w/o: ${x.r["Win % Without"]} | Games: ${x.r["Faction Games Featured"]}`
          );
        });

        return interaction.editReply(
          `**Top 10 warscrolls with biggest win-rate impact — ${pool[0].Faction}**\n` +
            `Impact = (Win %) - (Win % Without) shown as percentage points (pp).\n\n` +
            lines.join("\n\n") +
            `\n\nSource: **Woehammer GT Database**`
        );
      }
    }

    /* ---------- NEW: Faction sheet commands ---------- */
    if (["faction", "formation", "fcompare"].includes(interaction.commandName)) {
      const { headers, rows } = await getFactionData(false);
      const rowsObj = rows.map(r => rowToObj(headers, r));

      const MIN_GAMES = 5;

      if (interaction.commandName === "faction") {
        const nameRaw = interaction.options.getString("name");
        const overall = findFactionOverall(rowsObj, nameRaw);

        if (!overall) {
          const candidates = rowsObj
            .filter(r => normalise(r["Battle Formation"]) === "overall")
            .map(r => r.Faction);

          return interaction.editReply(
            `Couldn't find an Overall row for "${nameRaw}".\n` +
              `Try the exact faction name (e.g. "Slaves to Darkness").`
          );
        }

        if (!hasMinGames(overall, MIN_GAMES)) {
          return interaction.editReply(`Not enough data for "${overall.Faction}" (need ≥ ${MIN_GAMES} games).`);
        }

        const blurb = makeFactionBlurb(overall);

        return interaction.editReply(
          formatFactionRow(overall) +
            `\n\n**Bot summary**\n${blurb}\n\nSource: **Woehammer GT Database**`
        );
      }

      if (interaction.commandName === "formation") {
        const factionRaw = interaction.options.getString("faction");
        const formRaw = interaction.options.getString("name");
        const row = findFactionFormation(rowsObj, factionRaw, formRaw);

        if (!row) {
          const forms = listFactionFormations(rowsObj, factionRaw).slice(0, 20);
          return interaction.editReply(
            `Couldn't find "${formRaw}" for "${factionRaw}".\n` +
              (forms.length ? `Available (sample): ${forms.join(", ")}` : "")
          );
        }

        if (!hasMinGames(row, MIN_GAMES)) {
          return interaction.editReply(`Not enough data for that line (need ≥ ${MIN_GAMES} games).`);
        }

        const blurb = makeFactionBlurb(row);

        return interaction.editReply(
          formatFactionRow(row) +
            `\n\n**Bot summary**\n${blurb}\n\nSource: **Woehammer GT Database**`
        );
      }

      if (interaction.commandName === "fcompare") {
        const aRaw = interaction.options.getString("a");
        const bRaw = interaction.options.getString("b");

        const a = findFactionOverall(rowsObj, aRaw);
        const b = findFactionOverall(rowsObj, bRaw);

        if (!a || !b) {
          return interaction.editReply(
            `Couldn't find both Overall rows.\n` +
              `A: ${a ? "✅" : "❌"} "${aRaw}"\n` +
              `B: ${b ? "✅" : "❌"} "${bRaw}"`
          );
        }

        if (!hasMinGames(a, MIN_GAMES) || !hasMinGames(b, MIN_GAMES)) {
          return interaction.editReply(`Need ≥ ${MIN_GAMES} games on both factions to compare.`);
        }

        // quick “who leads” line
        const aWin = parsePercent(a["Win %"]);
        const bWin = parsePercent(b["Win %"]);
        const aGap = parseNumber(a["Elo Gap"]);
        const bGap = parseNumber(b["Elo Gap"]);

        const leadBits = [];
        if (aWin != null && bWin != null) {
          const lead = aWin === bWin ? "Even win rate" : (aWin > bWin ? `${a.Faction} leads win rate` : `${b.Faction} leads win rate`);
          leadBits.push(`${lead} (${a["Win %"]} vs ${b["Win %"]}).`);
        }
        if (aGap != null && bGap != null) {
          const lead = aGap === bGap ? "Even Elo gap" : (aGap > bGap ? `${a.Faction} more specialist-driven` : `${b.Faction} more specialist-driven`);
          leadBits.push(`${lead} (gap ${a["Elo Gap"]} vs ${b["Elo Gap"]}).`);
        }

        return interaction.editReply(
          `**Faction compare (Overall)**\n\n` +
            `${formatFactionRow(a)}\n\n` +
            `${formatFactionRow(b)}\n\n` +
            (leadBits.length ? `**Read:** ${leadBits.join(" ")}\n\n` : "") +
            `Source: **Woehammer GT Database**`
        );
      }
    }

    return interaction.editReply("❌ Unknown command (try /help).");
  } catch (err) {
    console.error(err);
    // If something went wrong after defer, always editReply (not reply)
    return interaction.editReply("❌ Internal error (check logs).");
  }
});

/* =========================
   Login
========================= */
client.login(process.env.DISCORD_TOKEN);
