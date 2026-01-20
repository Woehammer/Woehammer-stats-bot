import { EmbedBuilder } from
"discord.js";  
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
} from "discord.js";

/* =========================
   Config / Env
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const WARSCR0LL_CSV_URL = process.env.SHEET_CSV_URL;   // warscroll sheet CSV
const FACTION_CSV_URL = process.env.FACTION_CSV_URL;   // faction sheet CSV
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!WARSCR0LL_CSV_URL) console.warn("⚠️ Missing SHEET_CSV_URL");
if (!FACTION_CSV_URL) console.warn("⚠️ Missing FACTION_CSV_URL");

/* =========================
   Normalisation helpers
========================= */
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/^the\s+/i, "")          // optional: ignore leading "the"
    .replace(/[^a-z0-9 %.-]/g, " ")   // keep % . - for stats, but normalise others
    .replace(/\s+/g, " ")
    .trim();

const isAdmin = (interaction) => ADMIN_USER_IDS.includes(interaction.user.id);

/* =========================
   CSV parsing (simple, pragmatic)
   Works for your sheets because values are mostly simple.
   If you ever get commas inside fields, swap this for a real CSV parser.
========================= */
function parseCSV(text) {
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  const rows = lines.map(line => {
    // naive split, strips surrounding quotes
    return line
      .split(",")
      .map(c => c.replace(/^"|"$/g, "").trim());
  });

  const headers = rows.shift() || [];
  return { headers, rows };
}

async function fetchCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  return { status: res.status, text };
}

/* =========================
   In-memory cache (fast)
========================= */
const cache = {
  warscroll: { loadedAt: 0, headers: [], rows: [], url: WARSCR0LL_CSV_URL },
  faction: { loadedAt: 0, headers: [], rows: [], url: FACTION_CSV_URL },
};

async function loadWarscrollData(force = false) {
  const ageMs = Date.now() - cache.warscroll.loadedAt;
  if (!force && cache.warscroll.rows.length && ageMs < 1000 * 60 * 60) return; // 1h cache

  const { status, text } = await fetchCSV(WARSCR0LL_CSV_URL);
  if (status !== 200) throw new Error(`Warscroll CSV fetch failed: ${status}`);

  // guard against HTML being returned
  if (text.toLowerCase().includes("<html")) {
    throw new Error("Warscroll CSV returned HTML (sheet not published or wrong URL).");
  }

  const { headers, rows } = parseCSV(text);
  // sanity check
  if (!headers.includes("Warscroll") || !headers.includes("Faction")) {
    throw new Error(
      `Warscroll CSV headers don't look right. Got: ${headers.slice(0, 12).join(", ")}`
    );
  }

  cache.warscroll = { loadedAt: Date.now(), headers, rows, url: WARSCR0LL_CSV_URL };
}

async function loadFactionData(force = false) {
  const ageMs = Date.now() - cache.faction.loadedAt;
  if (!force && cache.faction.rows.length && ageMs < 1000 * 60 * 60) return; // 1h cache

  const { status, text } = await fetchCSV(FACTION_CSV_URL);
  if (status !== 200) throw new Error(`Faction CSV fetch failed: ${status}`);

  if (text.toLowerCase().includes("<html")) {
    throw new Error("Faction CSV returned HTML (sheet not published or wrong URL).");
  }

  const { headers, rows } = parseCSV(text);
  if (!headers.includes("Faction") || !headers.includes("Battle Formation")) {
    throw new Error(
      `Faction CSV headers don't look right. Got: ${headers.slice(0, 12).join(", ")}`
    );
  }

  cache.faction = { loadedAt: Date.now(), headers, rows, url: FACTION_CSV_URL };
}

/* =========================
   Column helpers
========================= */
function rowToObj(headers, row) {
  const obj = {};
  headers.forEach((h, i) => (obj[h] = row[i] ?? ""));
  return obj;
}

function num(val) {
  const x = parseFloat(String(val).replace("%", "").trim());
  return Number.isFinite(x) ? x : null;
}

function ppDiff(win, without) {
  const a = num(win);
  const b = num(without);
  if (a === null || b === null) return null;
  const diff = a - b;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(0)}pp`;
}

function fmtPct(v) {
  const s = String(v ?? "").trim();
  if (!s) return "—";
  return s.includes("%") ? s : `${s}%`;
}

/* =========================
   Commands registration
========================= */
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show bot commands"),

    new SlashCommandBuilder()
      .setName("warscroll")
      .setDescription("Search warscroll stats (partial matches)")
      .addStringOption(o =>
        o.setName("name").setDescription("Warscroll name / partial").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("compare")
      .setDescription("Compare two warscrolls (search terms)")
      .addStringOption(o => o.setName("a").setDescription("Search A").setRequired(true))
      .addStringOption(o => o.setName("b").setDescription("Search B").setRequired(true)),

    new SlashCommandBuilder()
      .setName("common")
      .setDescription("Top 10 most common warscrolls for a faction")
      .addStringOption(o =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("leastcommon")
      .setDescription("Bottom 10 least common warscrolls for a faction")
      .addStringOption(o =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("impact")
      .setDescription("Top 10 warscrolls with biggest win-rate swing for a faction")
      .addStringOption(o =>
        o.setName("faction").setDescription("Faction name").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("faction")
      .setDescription("Show faction stats (overall or a specific battle formation)")
      .addStringOption(o =>
        o.setName("name").setDescription("Faction name").setRequired(true)
      )
      .addStringOption(o =>
        o.setName("formation").setDescription("Battle formation (optional)").setRequired(false)
      ),

    // admin
    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("ADMIN: refresh cached data now"),

    new SlashCommandBuilder()
      .setName("peek")
      .setDescription("ADMIN: show loaded CSV headers + row counts"),
  ].map(c => c.toJSON());

  await client.application.commands.set(commands);

  // warm cache at startup (don’t block ready)
  loadWarscrollData(false).catch(err => console.warn("Warscroll warm load failed:", err.message));
  loadFactionData(false).catch(err => console.warn("Faction warm load failed:", err.message));
});

/* =========================
   Interaction handler
========================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply(); // IMPORTANT: avoids 3s timeout

  try {
    const cmd = interaction.commandName;

    /* ---------- HELP ---------- */
    if (cmd === "help") {
      return interaction.editReply(
        [
          `**Woehammer Stats Bot — Commands**`,
          `_(Ignores rows with < 5 games where relevant)_`,
          ``,
          `• **/warscroll** name: Search warscrolls (partial matches)`,
          `• **/compare** a + b: Compare two warscrolls`,
          `• **/common** faction: Top 10 by Used %`,
          `• **/leastcommon** faction: Bottom 10 by Used %`,
          `• **/impact** faction: Biggest (Win% - Win%Without) in pp`,
          `• **/faction** name + optional formation: Faction stats`,
          ``,
          `Source: **Woehammer GT Database**`,
        ].join("\n")
      );
    }

    /* ---------- ADMIN: REFRESH ---------- */
    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        return interaction.editReply("❌ Admin only.");
      }

      await loadWarscrollData(true);
      await loadFactionData(true);

      return interaction.editReply(
        `✅ Refreshed.\n` +
        `Warscroll rows: ${cache.warscroll.rows.length}\n` +
        `Faction rows: ${cache.faction.rows.length}\n` +
        `Source: **Woehammer GT Database**`
      );
    }

    /* ---------- ADMIN: PEEK ---------- */
    if (cmd === "peek") {
      if (!isAdmin(interaction)) {
        return interaction.editReply("❌ Admin only.");
      }
      // ensure loaded
      await loadWarscrollData(false);
      await loadFactionData(false);

      return interaction.editReply(
        [
          `**Loaded datasets**`,
          ``,
          `**Warscroll**`,
          `Rows: ${cache.warscroll.rows.length}`,
          `Headers: ${cache.warscroll.headers.join(" | ")}`,
          ``,
          `**Faction**`,
          `Rows: ${cache.faction.rows.length}`,
          `Headers: ${cache.faction.headers.join(" | ")}`,
        ].join("\n")
      );
    }

    /* =========================
       WARSCR0LL DATA COMMANDS
    ========================= */
    if (["warscroll", "common", "leastcommon", "impact", "compare"].includes(cmd)) {
      await loadWarscrollData(false);

      const headers = cache.warscroll.headers;
      const rows = cache.warscroll.rows;

      const getCol = (name) => headers.indexOf(name);

      const idxFaction = getCol("Faction");
      const idxWarscroll = getCol("Warscroll");
      const idxGames = getCol("Faction Games Featured");
      const idxWin = getCol("Win %");
      const idxUsed = getCol("Used %");
      const idxAvgList = getCol("Av Per List");
      const idxWinWithout = getCol("Win % Without");

      const minGames = 5;

      const rowObj = (r) => rowToObj(headers, r);

      // helper: filter out low-games rows
      const hasEnoughGames = (r) => (num(r[idxGames]) ?? 0) >= minGames;

      /* ---------- /warscroll ---------- */
      if (cmd === "warscroll") {
        const qRaw = interaction.options.getString("name");
        const q = norm(qRaw);

        const matches = rows
          .filter(hasEnoughGames)
          .filter(r => norm(r[idxWarscroll]).includes(q))
          .slice(0, 10);

        if (!matches.length) {
          return interaction.editReply(
            `No warscroll rows found for "${qRaw}" (≥ ${minGames} games).`
          );
        }

        const lines = matches.map(r => {
          const d = rowObj(r);
          const impact = ppDiff(d["Win %"], d["Win % Without"]);

          return [
            `**${d.Warscroll}** (${d.Faction})`,
            `Used: ${fmtPct(d["Used %"])} of faction lists | Games: ${d["Faction Games Featured"]} | Win: ${fmtPct(d["Win %"])} | Impact: ${impact ?? "—"} | Avg/list: ${d["Av Per List"] || "—"}`,
            ``,
          ].join("\n");
        });

        return interaction.editReply(
          [
            `**Warscroll results for: ${qRaw}**`,
            ``,
            ...lines,
            `Source: **Woehammer GT Database**`,
          ].join("\n")
        );
      }

      /* ---------- /compare ---------- */
      if (cmd === "compare") {
        const aRaw = interaction.options.getString("a");
        const bRaw = interaction.options.getString("b");
        const aQ = norm(aRaw);
        const bQ = norm(bRaw);

        const findTop = (q) =>
          rows
            .filter(hasEnoughGames)
            .filter(r => norm(r[idxWarscroll]).includes(q))
            .slice(0, 1)
            .map(rowObj)[0];

        const A = findTop(aQ);
        const B = findTop(bQ);

        if (!A || !B) {
          return interaction.editReply(
            `Couldn't find both warscrolls (≥ ${minGames} games).\n` +
            `Try more specific searches.`
          );
        }

        const line = (d) => {
          const impact = ppDiff(d["Win %"], d["Win % Without"]);
          return [
            `**${d.Warscroll}** (${d.Faction})`,
            `Used: ${fmtPct(d["Used %"])} | Games: ${d["Faction Games Featured"]} | Win: ${fmtPct(d["Win %"])} | Win w/o: ${fmtPct(d["Win % Without"])} | Impact: ${impact ?? "—"}`,
          ].join("\n");
        };

        return interaction.editReply(
          [
            `**Compare**`,
            ``,
            line(A),
            ``,
            line(B),
            ``,
            `Source: **Woehammer GT Database**`,
          ].join("\n")
        );
      }

      /* ---------- /common, /leastcommon, /impact ---------- */
      const factionRaw = interaction.options.getString("faction");
      const factionQ = norm(factionRaw);

      // Case-insensitive faction match FIX
      const factionRows = rows
        .filter(hasEnoughGames)
        .filter(r => norm(r[idxFaction]) === factionQ);

      if (!factionRows.length) {
        return interaction.editReply(
          `No warscroll rows found for "${factionRaw}" (≥ ${minGames} games).`
        );
      }

      const list = factionRows.map(rowObj);

      if (cmd === "common" || cmd === "leastcommon") {
        const sorted = [...list].sort((a, b) => (num(a["Used %"]) ?? 0) - (num(b["Used %"]) ?? 0));
        const picked = (cmd === "common") ? sorted.slice(-10).reverse() : sorted.slice(0, 10);

        const title = cmd === "common"
          ? `Top 10 most common warscrolls — ${factionRaw}`
          : `Bottom 10 least common warscrolls — ${factionRaw}`;

        const subtitle = cmd === "common"
          ? `Most common = highest Used %`
          : `Least common = lowest Used %`;

        const lines = picked.map((d, i) => {
          const impact = ppDiff(d["Win %"], d["Win % Without"]);
          return [
            `${i + 1}. **${d.Warscroll}**`,
            `Used: ${fmtPct(d["Used %"])} | Games: ${d["Faction Games Featured"]} | Win: ${fmtPct(d["Win %"])} | Impact: ${impact ?? "—"}`,
            ``,
          ].join("\n");
        });

        return interaction.editReply(
          [
            `**${title}**`,
            ``,
            `${subtitle}`,
            ``,
            `**Results**`,
            ...lines,
            `Source: **Woehammer GT Database**`,
          ].join("\n")
        );
      }

      if (cmd === "impact") {
        const scored = list
          .map(d => {
            const a = num(d["Win %"]);
            const b = num(d["Win % Without"]);
            const diff = (a === null || b === null) ? null : (a - b);
            return { d, diff };
          })
          .filter(x => x.diff !== null);

        scored.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
        const picked = scored.slice(0, 10);

        const lines = picked.map((x, i) => {
          const d = x.d;
          const diff = x.diff;
          const sign = diff >= 0 ? "+" : "";
          const impact = `${sign}${diff.toFixed(0)}pp`;
          return [
            `${i + 1}. **${d.Warscroll}**`,
            `Impact: ${impact} | Win: ${fmtPct(d["Win %"])} | Win w/o: ${fmtPct(d["Win % Without"])} | Games: ${d["Faction Games Featured"]} | Used: ${fmtPct(d["Used %"])}`,
            ``,
          ].join("\n");
        });

        return interaction.editReply(
          [
            `**Top 10 warscrolls with biggest impact — ${factionRaw}**`,
            ``,
            `Impact = (Win %) - (Win % Without) shown as percentage points (pp).`,
            ``,
            `**Results**`,
            ...lines,
            `Source: **Woehammer GT Database**`,
          ].join("\n")
        );
      }
    }

    /* =========================
       FACTION DATA COMMAND
    ========================= */
    if (interaction.commandName === "faction") {
      await loadFactionData(false);

      const nameRaw = interaction.options.getString("name");
      const formationRaw = interaction.options.getString("formation") || "overall";

      const nameQ = norm(nameRaw);
      const formationQ = norm(formationRaw);

      const headers = cache.faction.headers;
      const rows = cache.faction.rows.map(r => rowToObj(headers, r));

      // find all rows for faction (case-insensitive)
      const factionRows = rows.filter(r => norm(r["Faction"]) === nameQ);

      if (!factionRows.length) {
        return interaction.editReply(`No faction rows found for "${nameRaw}".`);
      }

      // choose formation
      const chosen =
        factionRows.find(r => norm(r["Battle Formation"]) === formationQ) ||
        factionRows.find(r => norm(r["Battle Formation"]) === "overall") ||
        factionRows[0];

      const title = `**${chosen["Faction"]} — ${chosen["Battle Formation"]}**`;

      // “one stat per line” layout
      const lines = [
        `Games: ${chosen["Games"]} (${chosen["Games Share"]} share)`,
        `Win %: ${chosen["Win %"]}`,
        `Average Elo: ${chosen["Average Elo"]}`,
        `Median Elo: ${chosen["Median Elo"]}`,
        `Elo Gap: ${chosen["Elo Gap"]}`,
        `5-0 rate: ${chosen["Players Achieving 5 Wins"]}`,
        `4-1 rate: ${chosen["Players Achieving 4 wins"]}`,
        `3-2 rate: ${chosen["Players Achieving 3 Wins"]}`,
        `2-3 rate: ${chosen["Players Achieving 2 wins"]}`,
        `1-4 rate: ${chosen["Players Achieving 1 Win"]}`,
        `0-5 rate: ${chosen["Players Without a Win"]}`,
      ].filter(Boolean);

      // optional bot summary (if you’re already calculating it in-sheet, include it)
      const botSummary = chosen["Bot summary"] || chosen["Summary"] || "";

      return interaction.editReply(
        [
          `Woehammer Stats`,
          title,
          ``,
          ...lines,
          ``,
          botSummary ? `**Bot summary**\n${botSummary}\n` : "",
          `Source: **Woehammer GT Database**`,
        ].join("\n")
      );
    }

    /* ---------- fallback ---------- */
    return interaction.editReply("❌ Unknown command (try /help).");

  } catch (err) {
    console.error(err);
    return interaction.editReply("❌ Internal error (check logs).");
  }
});

/* =========================
   Login
========================= */
client.login(process.env.DISCORD_TOKEN);
