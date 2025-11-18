// --- 🟢 Importy a setup --- //
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import multer from "multer";
import fetch from "node-fetch";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

dotenv.config();

// --- 🖼 Multer setup pro upload avataru --- //
const upload = multer({ storage: multer.memoryStorage() });

// --- 📁 Načtení konfiguračního JSONu --- //
let config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
// použij hodnotu z config.json (pokud tam není, true fallback)
let verifyEnabled = !!config.verifyEnabled;


// =====================
// 📝 LOG BUFFER
// =====================

// budeme držet posledních třeba 200 řádků logu v paměti
const LOG_LIMIT = 200;
let logBuffer = [];

// helper na push do bufferu
function pushLog(level, msg) {
  const line =
    `[${new Date().toISOString()}] [${level}] ` +
    (typeof msg === "string" ? msg : JSON.stringify(msg));

  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_LIMIT);
  }
}

// obalíme konzole, ale zároveň pořád logujeme do normální konzole Renderu
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
  origLog(...args);
  pushLog("INFO", args.join(" "));
};
console.warn = (...args) => {
  origWarn(...args);
  pushLog("WARN", args.join(" "));
};
console.error = (...args) => {
  origError(...args);
  pushLog("ERROR", args.join(" "));
};

// --- 🤖 Discord Bot klient --- //
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User,
    Partials.GuildMember
  ]
});

// --- 🧠 Anti-dupe zámky / helpery --- //
const processedJoins = new Set();
const processedReactions = new Set();
const lastEvent = new Map();

function withShortLock(set, key, ttlMs) {
  if (set.has(key)) return true;
  set.add(key);
  setTimeout(() => set.delete(key), ttlMs);
  return false;
}

// === [2] SADA HERNÍCH ROLÍ PRO STATISTIKY + TLAČÍTKA ===
const GAME_ROLE_IDS = [
  "1433504172296245278", // WildRift
  "1433504443269255399", // Others
  "1433504552140673105", // Warzone
  "1433504646357586062", // Metin2
  "1433504694529167360", // CS:2
  "1400578107823489024", // Creator  
];

// Pro mapování tlačítek -> role
const BUTTON_ROLE_MAP = {
  "pickgame:wildrift": "1433504172296245278",
  "pickgame:warzone": "1433504552140673105",
  "pickgame:metin2": "1433504646357586062",
  "pickgame:cs2": "1433504694529167360",
  "pickgame:others": "1433504443269255399",
};

// === [3] RANK ROLE MAP (emoji -> roleId) ===
const RANK_EMOJI_ROLE_MAP = {
  "<:iron:1426288101604593846>":       "1437499734775562341",
  "<:bronze:1426287955227574472>":     "1437500038564544654",
  "<:silver:1426288167807615207>":     "1437490677771403515",
  "<:gold:1426288055240753272>":       "1437499870545182720",
  "<:platinum:1426288148886851704>":   "1437499938044116992",
  "<:emerald:1426288014845546576>":    "1437500189400371201",
  "<:diamond:1426287985145544817>":    "1437500095669997749",
  "<:master:1426288128607653888>":     "1437500235680186428",
  "<:grandmaster:1426288034382352544>":"1437500283596050715",
  "<:challenger:1426288082507923467>": "1437500351375867945",
  "<:sovereign:1426288186375667812>":  "1437500382313054432",
};


// postaví mapu emoji -> roleId z config.reactionRoles.emojiRoleMap
function buildEmojiRoleMap() {
  const map = {};
  for (const entry of (config.reactionRoles?.emojiRoleMap || [])) {
    if (entry.emoji && entry.roleId) {
      map[entry.emoji] = entry.roleId;
    }
  }
  return map;
}

// rozbalí templaty typu {USER}, {ANSWER}, {MOD}, ...
function fillTemplate(str, vars) {
  if (!str) return "";
  return str
    .replace(/\{USER\}/g, vars.USER ?? "")
    .replace(/\{MOD\}/g, vars.MOD ?? "")
    .replace(/\{ANSWER\}/g, vars.ANSWER ?? "")
    .replace(/\{REASON\}/g, vars.REASON ?? "")
    .replace(/\{USER_ID\}/g, vars.USER_ID ?? "");
}

// --- 🧲 Sync reaction-role embed zprávy v kanálu --- //
async function syncReactionRoleMessage() {
  try {
    const channelId = config.channelsAndRoles?.roleSelectChannelId;
    if (!channelId) {
      console.warn("⚠️ syncReactionRoleMessage: chybí roleSelectChannelId");
      return;
    }

    // zkus najít kanál
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn("⚠️ syncReactionRoleMessage: channel nenalezen");
      return;
    }

    // config pro embed
    const rrEmbedCfg = config.reactionRoles?.embed;
    if (!rrEmbedCfg) {
      console.warn("⚠️ syncReactionRoleMessage: chybí reactionRoles.embed v configu");
      return;
    }

    // stáhnem posledních pár zpráv v kanálu
    const recentMessages = await channel.messages.fetch({ limit: 10 }).catch(() => null);

    // snažíme se najít, jestli už tam NÁŠ embed existuje: autor = náš bot, stejný title
    const existing = recentMessages?.find(
      m =>
        m.author.id === client.user.id &&
        m.embeds?.[0]?.title === rrEmbedCfg.title
    );

    // postav nový embed podle configu
    const embed = new EmbedBuilder()
  .setTitle(rrEmbedCfg.title || "Role výběr")
  .setDescription(rrEmbedCfg.description || "")
  .setColor(rrEmbedCfg.color || "#3a3838")
  .setThumbnail(rrEmbedCfg.thumbnailUrl || "");

   // if (rrEmbedCfg.imageUrl) {
   // embed.setImage(rrEmbedCfg.imageUrl);
   // }

    if (existing) {
  // porovnej jen podstatné části embedu a edituj JEN když se liší
  const cur = existing.embeds?.[0];

  // aktuální hodnoty v existující zprávě
  const curTitle = cur?.title || "";
  const curDesc  = cur?.description || "";
  const curThumb = cur?.thumbnail?.url || "";
  const curImg   = cur?.image?.url || "";
  const curColor = (cur?.color ?? null); // číslo (int) nebo null

  // požadované hodnoty
  const wantTitle = rrEmbedCfg.title || "Role výběr";
  const wantDesc  = rrEmbedCfg.description || "";
  const wantThumb = rrEmbedCfg.thumbnailUrl || "";
  const wantImg   = rrEmbedCfg.imageUrl || "";
  const wantColorHex = (rrEmbedCfg.color || "#3a3838").replace("#","");
  const wantColorInt = parseInt(wantColorHex, 16);

  const needsUpdate =
    curTitle !== wantTitle ||
    curDesc  !== wantDesc  ||
    curThumb !== wantThumb ||
    curImg   !== wantImg   ||
    (typeof curColor === "number" ? curColor : null) !== wantColorInt;

  if (needsUpdate) {
    await existing.edit({ embeds: [embed] }).catch(err => {
      console.warn("⚠️ syncReactionRoleMessage: nemůžu editnout message:", err.message);
    });
    console.log("🔁 Reaction role embed aktualizován (edit, změna zjištěna).");
  } else {
    console.log("👌 Reaction role embed beze změny – žádný edit neproběhl.");
  }

  // doplnit případně chybějící reakce, ale nereagovat duplicitně
  const needed = (config.reactionRoles.emojiRoleMap || []).map(e => e.emoji).filter(Boolean);
  for (const e of needed) {
    const already = existing.reactions?.cache?.some(r =>
      r.emoji.toString() === e
    );
    if (!already) {
      await existing.react(e).catch(() => {});
    }
  }

} else {
  // žádná naše zpráva → pošleme novou
  const sent = await channel.send({ embeds: [embed] });
  for (const entry of config.reactionRoles.emojiRoleMap || []) {
    const e = entry.emoji;
    if (!e) continue;
    await sent.react(e).catch(err => {
      console.warn("⚠️ Reakce se nepodařila:", e, err.message);
    });
  }
  console.log("✅ Reaction role embed poslán + emoji přidány.");
}

  } catch (err) {
    console.warn("⚠️ syncReactionRoleMessage fail:", err.message);
  }
}

// --- 🔁 Reload configu + update identity bota --- //
function reloadConfig() {
  try {
    config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    console.log(♻️ Config reloadnutý.");

    // identity + presence (stávající kód zanech)
    if (client?.user && config.botIdentity?.displayName) {
      client.user
        .setUsername(config.botIdentity.displayName)
        .then(() =>
          console.log(`💫 Bot přejmenován na: ${config.botIdentity.displayName}`)
        )
        .catch(err =>
          console.warn("⚠️ Nepodařilo se změnit jméno bota:", err.message)
        );
    }

    if (client?.user && config.botIdentity?.statusText) {
      client.user.setPresence({
        activities: [{ name: config.botIdentity.statusText }],
        status: "online"
      });
      console.log(`💬 Status bota nastaven na: ${config.botIdentity.statusText}`);
    }

    // --- NOVĚ: přepni runtime verifyEnabled podle configu ---
    verifyEnabled = !!config.verifyEnabled;
    console.log(`🔔 verifyEnabled = ${verifyEnabled}`);

  } catch (err) {
    console.error("❌ Chyba při reloadu configu:", err.message);
  }
}

// --- 🌐 Express server --- //
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.post("/api/verify-toggle", express.json(), (req, res) => {
  const { enabled } = req.body;
  verifyEnabled = !!enabled; // aktualizuje globální proměnnou
  res.json({ success: true, verifyEnabled });
});

// --- 🔒 Basic auth middleware --- //
function requireAdminAuth(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
    return res.status(401).send("Auth required");
  }

  const base64 = auth.replace("Basic ", "").trim();
  let decoded = "";
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
  } catch (e) {
    console.warn("⚠️ Basic auth decode fail:", e.message);
  }

  const sepIndex = decoded.indexOf(":");
  const user = decoded.substring(0, sepIndex);
  const pass = decoded.substring(sepIndex + 1);

  const okUser = process.env.ADMIN_USER;
  const okPass = process.env.ADMIN_PASS;

  if (user === okUser && pass === okPass) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Restricted Area"');
  return res.status(401).send("Not authorized");
}

// --- ✅ Healthcheck (veřejné kvůli Renderu) --- //
app.get("/", (req, res) => res.send("✅ Bot is running!"));

// --- 🧩 GET /config – dashboard načte aktuální stav --- //
app.get("/config", requireAdminAuth, (req, res) => {
  try {
    const raw = fs.readFileSync("./config.json", "utf8");
    const json = JSON.parse(raw);
    res.json(json);
  } catch (err) {
    console.error("❌ Chyba při čtení configu:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 🧾 GET /logs – dashboard si vytáhne runtime logy --- //
app.get("/logs", requireAdminAuth, (req, res) => {
  try {
    // vrátíme jako text/plain, ať to můžeš hodit do <pre>
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(logBuffer.join("\n"));
  } catch (err) {
    console.error("❌ /logs error:", err);
    res
      .status(500)
      .send("Nepodařilo se načíst logy z paměti serveru.");
  }
});

// --- 💾 POST /save-welcome --- //
app.post("/save-welcome", requireAdminAuth, (req, res) => {
  try {
    const incoming = req.body;
    if (!config.welcomeFlow) config.welcomeFlow = {};

    // greetingEmbed
    if (!config.welcomeFlow.greetingEmbed)
      config.welcomeFlow.greetingEmbed = {};
    config.welcomeFlow.greetingEmbed.title =
      incoming.greetingEmbed?.title ?? config.welcomeFlow.greetingEmbed.title;
    config.welcomeFlow.greetingEmbed.color =
      incoming.greetingEmbed?.color ?? config.welcomeFlow.greetingEmbed.color;
    config.welcomeFlow.greetingEmbed.description =
      incoming.greetingEmbed?.description ??
      config.welcomeFlow.greetingEmbed.description;

    // verify / timeoutKickReason
    config.welcomeFlow.verifyQuestionText =
      incoming.verifyQuestionText ?? config.welcomeFlow.verifyQuestionText;
    config.welcomeFlow.timeoutKickReason =
      incoming.timeoutKickReason ?? config.welcomeFlow.timeoutKickReason;

    // modLogEmbed
    if (!config.welcomeFlow.modLogEmbed)
      config.welcomeFlow.modLogEmbed = {};
    config.welcomeFlow.modLogEmbed.title =
      incoming.modLogEmbed?.title ?? config.welcomeFlow.modLogEmbed.title;
    config.welcomeFlow.modLogEmbed.color =
      incoming.modLogEmbed?.color ?? config.welcomeFlow.modLogEmbed.color;
    config.welcomeFlow.modLogEmbed.descriptionTemplate =
      incoming.modLogEmbed?.descriptionTemplate ??
      config.welcomeFlow.modLogEmbed.descriptionTemplate;

    // approveMessage
    if (!config.welcomeFlow.modLogEmbed.approveMessage)
      config.welcomeFlow.modLogEmbed.approveMessage = {};
    config.welcomeFlow.modLogEmbed.approveMessage.textTemplate =
      incoming.modLogEmbed?.approveMessage?.textTemplate ??
      config.welcomeFlow.modLogEmbed.approveMessage.textTemplate;
    config.welcomeFlow.modLogEmbed.approveMessage.color =
      incoming.modLogEmbed?.approveMessage?.color ??
      config.welcomeFlow.modLogEmbed.approveMessage.color;

    // rejectMessage
    if (!config.welcomeFlow.modLogEmbed.rejectMessage)
      config.welcomeFlow.modLogEmbed.rejectMessage = {};
    config.welcomeFlow.modLogEmbed.rejectMessage.textTemplate =
      incoming.modLogEmbed?.rejectMessage?.textTemplate ??
      config.welcomeFlow.modLogEmbed.rejectMessage.textTemplate;
    config.welcomeFlow.modLogEmbed.rejectMessage.color =
      incoming.modLogEmbed?.rejectMessage?.color ??
      config.welcomeFlow.modLogEmbed.rejectMessage.color;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    reloadConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-welcome error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-botsettings --- //
app.post("/save-botsettings", requireAdminAuth, (req, res) => {
  try {
    const { displayName, statusText } = req.body;
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ ok: false, error: "Missing displayName" });
    }

    if (!config.botIdentity) config.botIdentity = {};
    config.botIdentity.displayName = displayName.trim();
    config.botIdentity.statusText = statusText?.trim() || "";

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    reloadConfig(); // nastaví username + presence

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-botsettings error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-verify --- //
app.post("/save-verify", requireAdminAuth, (req, res) => {
  try {
    const incoming = req.body;
    // očekává { verifyEnabled: true|false }
    config.verifyEnabled = !!incoming.verifyEnabled;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // přenačti runtime hodnoty
    reloadConfig();

    res.json({ ok: true, verifyEnabled: config.verifyEnabled });
  } catch (err) {
    console.error("❌ /save-verify error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /upload-avatar --- //
app.post(
  "/upload-avatar",
  requireAdminAuth,
  upload.single("avatarFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "Chybí soubor." });
      }

      if (!client?.user) {
        return res
          .status(500)
          .json({ ok: false, error: "Bot client není připraven." });
      }

      const buffer = req.file.buffer;

      await client.user.setAvatar(buffer);
      console.log("🖼 Avatar bota aktualizován.");

      // preview do configu
      const base64 = `data:${req.file.mimetype};base64,${buffer.toString(
        "base64"
      )}`;
      config.avatarPreviewUrl = base64;
      fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

      res.json({ ok: true });
    } catch (err) {
      console.error("❌ /upload-avatar error:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// --- 💾 POST /save-ids --- //
app.post("/save-ids", requireAdminAuth, (req, res) => {
  try {
    config.channelsAndRoles = req.body;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    // přenačteme config do bota
    reloadConfig();

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-ids error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-reactionroles --- //
app.post("/save-reactionroles", requireAdminAuth, async (req, res) => {
  try {
    config.reactionRoles = req.body;

    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");

    reloadConfig();

    // 💥 hned po uložení syncni/aktuální message v kanálu
    await syncReactionRoleMessage();

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-reactionroles error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-leaveban --- //
app.post("/save-leaveban", requireAdminAuth, (req, res) => {
  try {
    config.leaveBanLogs = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-leaveban error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 💾 POST /save-banlog --- //
app.post("/save-banlog", requireAdminAuth, (req, res) => {
  try {
    config.banCommandLog = req.body;
    fs.writeFileSync("./config.json", JSON.stringify(config, null, 2), "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /save-banlog error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 🧠 GET /admin – dashboard HTML --- //
app.get("/admin", requireAdminAuth, (req, res) => {
  try {
    const html = fs.readFileSync("./discordbot.html", "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("❌ Nemůžu načíst dashboard:", err);
    res.status(500).send("Dashboard se nepodařilo načíst.");
  }
});

// --- 🌍 Start Express --- //
app.listen(PORT, () =>
  console.log(`🌐 Mini server běží na portu ${PORT}`)
);

// =====================
// 🤖 DISCORD BOT LOGIKA
// =====================

// === READY EVENT ===
client.once("clientReady", async () => {
  console.log(`✅ Přihlášen jako ${client.user.tag}`);

  // po přihlášení ping do onlineLogChannelId
  {
    const chId = config.channelsAndRoles?.onlineLogChannelId;
    const logCh = chId ? client.channels.cache.get(chId) : null;
    if (logCh) {
      logCh.send("🟢 Bot je zpět online");
    }
  }

  // zaregistruj slash commands /clear a /ban
  const commands = [
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("🧹 Smaže poslední zprávy v tomto kanálu.")
      .addIntegerOption(o =>
        o
          .setName("pocet")
          .setDescription("1–100")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("ban")
      .setDescription(
        "🔨 Zabanovat uživatele podle ID (i když není na serveru)"
      )
      .addStringOption(o =>
        o
          .setName("userid")
          .setDescription("ID uživatele k banu")
          .setRequired(true)
      )
      .addStringOption(o =>
        o
          .setName("duvod")
          .setDescription("Důvod banu (volitelné)")
          .setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(
      client.user.id,
      config.channelsAndRoles.guildId
    ),
    { body: commands }
  );
    console.log("✅ Slash commands /clear a /ban zaregistrovány.");

  // 🔁 Syncni / refreshni reaction role embed teď při startu
  await syncReactionRoleMessage();

  // 🔹 RANK SELECTION EMBED – druhá embed zpráva v roleSelectChannel
  try {
    const roleSelectChannelId = config.channelsAndRoles?.roleSelectChannelId;
    if (roleSelectChannelId) {
      const roleSelectChannel = await client.channels
        .fetch(roleSelectChannelId)
        .catch(() => null);

      if (roleSelectChannel) {
        // koukneme, jestli už tam není naše rank zpráva (podle title)
        const recent = await roleSelectChannel.messages
          .fetch({ limit: 20 })
          .catch(() => null);

        const existingRankMsg = recent?.find(
          m =>
            m.author.id === client.user.id &&
            m.embeds?.[0]?.title === "HIGHEST ACHIEVED RANK"
        );

        if (!existingRankMsg) {
          const rankEmbed = new EmbedBuilder()
  .setTitle("HIGHEST ACHIEVED RANK")
  .setDescription(
    ":flag_cz: Vyber si svůj nejvýš dosažený rank, je jedno jaká season.\n:flag_us: Pick your highest achieved rank, no matter which season.\n\n" + // ⬅ dvakrát \n = prázdný řádek
    "<:iron:1426288101604593846> <@&1437499734775562341>\n" +
    "<:bronze:1426287955227574472> <@&1437500038564544654>\n" +
    "<:silver:1426288167807615207> <@&1437490677771403515>\n" +
    "<:gold:1426288055240753272> <@&1437499870545182720>\n" +
    "<:platinum:1426288148886851704> <@&1437499938044116992>\n" +
    "<:emerald:1426288014845546576> <@&1437500189400371201>\n" +
    "<:diamond:1426287985145544817> <@&1437500095669997749>\n" +
    "<:master:1426288128607653888> <@&1437500235680186428>\n" +
    "<:grandmaster:1426288034382352544> <@&1437500283596050715>\n" +
    "<:challenger:1426288082507923467> <@&1437500351375867945>\n" +
    "<:sovereign:1426288186375667812> <@&1437500382313054432>"
  )
            .setColor("#3a3838")
            .setThumbnail("https://static.wikia.nocookie.net/leagueoflegends/images/3/38/Season_2019_-_Unranked.png/revision/latest/scale-to-width-down/250?cb=20190908074432"); 

          const sentRankMsg = await roleSelectChannel.send({
            embeds: [rankEmbed],
          });

          // 🎯 Reakce pro všechny rank emoji (MUSÍ sedět na RANK_EMOJI_ROLE_MAP výše)
          await sentRankMsg.react("<:iron:1426288101604593846>");
          await sentRankMsg.react("<:bronze:1426287955227574472>");
          await sentRankMsg.react("<:silver:1426288167807615207>");
          await sentRankMsg.react("<:gold:1426288055240753272>");
          await sentRankMsg.react("<:platinum:1426288148886851704>");
          await sentRankMsg.react("<:emerald:1426288014845546576>");
          await sentRankMsg.react("<:diamond:1426287985145544817>");
          await sentRankMsg.react("<:master:1426288128607653888>");
          await sentRankMsg.react("<:grandmaster:1426288034382352544>");
          await sentRankMsg.react("<:challenger:1426288082507923467>");
          await sentRankMsg.react("<:sovereign:1426288186375667812>");
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ Nepodařilo se odeslat rank výběr embed:", err.message);
  }
});


// === 🟢 Nový člen join (upraveno pro verifyEnabled) ===
client.on("guildMemberAdd", async member => {
  try {
    if (member.user.bot) return;

    const unverifiedRoleId = config.channelsAndRoles.unverifiedRoleId;
    const verifiedRoleId = config.channelsAndRoles.verifiedRoleId;

    // anti-dupe join
    if (member.roles.cache.has(unverifiedRoleId) || member.roles.cache.has(verifiedRoleId)) {
      console.log(
        ⚠️ Duplicitní guildMemberAdd pro ${member.user.tag} — přeskočeno.`
      );
      return;
    }
    if (withShortLock(processedJoins, member.id, 2 * 60 * 1000)) return;

    // --- 1) veřejný welcome embed do nazdarChannelId (vždy) ---
    {
      const welcomeChannelIdHard = "1400569915437748254";
      const welcomeEmbedChannel =
        member.guild.channels.cache.get(welcomeChannelIdHard) ||
        member.guild.channels.cache.get(config.channelsAndRoles.nazdarChannelId);

      if (welcomeEmbedChannel) {
        const embed = new EmbedBuilder()
          .setTitle("W E L C O M E !")
          .setDescription(
            `:flag_cz: Vítej ${member}!\nNechovej se tu jako píča prosím. Díky! 🤍\nVyber si kliknutím na tlačítko hru, kvůli které jsi tu!\n\n:flag_us: Welcome ${member}!\nPlease don’t act like a pussy here, thanks! 🤍\nClick a button below to choose the game you're here for!`
          )
          .setColor("#3a3838")
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("pickgame:wildrift")
            .setLabel("🎮WildRift")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("pickgame:warzone")
            .setLabel("🔫Warzone")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("pickgame:metin2")
            .setLabel("⚔️Metin2")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("pickgame:cs2")
            .setLabel("🔫CS:2")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("pickgame:others")
            .setLabel("👀Others")
            .setStyle(ButtonStyle.Secondary)
        );

        await welcomeEmbedChannel.send({ embeds: [embed], components: [row] });
      }
    }

    // --- 2) verify flow závislý na verifyEnabled ---
    if (verifyEnabled) {
      // dej Unverified roli a pošli ověřovací otázku (stávající flow)
      if (unverifiedRoleId) {
        await member.roles.add(unverifiedRoleId).catch(() => {});
        console.log(`👤 ${member.user.tag} dostal roli Unverified`);
      }

      const verifyChannel = member.guild.channels.cache.get(
        config.channelsAndRoles.welcomeChannelId
      );
      if (!verifyChannel) return;

      const questionText = fillTemplate(
        config.welcomeFlow.verifyQuestionText,
        { USER: `${member}` }
      );

      const questionMsg = await verifyChannel.send(questionText);

      const filter = m => m.author.id === member.id;
      const collector = verifyChannel.createMessageCollector({
        filter,
        max: 1,
        time: 86400000 // 24h
      });

      collector.on("collect", async msg => {
        const logChannel = member.guild.channels.cache.get(
          config.channelsAndRoles.joinLogChannelId
        );
        if (!logChannel) return;

        const modLogCfg = config.welcomeFlow.modLogEmbed;

        // embed pro mod tým
        const embed = new EmbedBuilder()
          .setTitle(modLogCfg.title)
          .setDescription(
            fillTemplate(modLogCfg.descriptionTemplate, {
              USER: `<@${member.id}>`,
              ANSWER: msg.content || "*Žádná odpověď*"
            })
          )
          .setColor(modLogCfg.color || "#3a3838");

        const logMsg = await logChannel.send({ embeds: [embed] });

        await logMsg.react("✅");
        await logMsg.react("❌");

        // cleanup
        await msg.delete().catch(() => {});
        await questionMsg.delete().catch(() => {});
      });

      collector.on("end", async collected => {
        if (collected.size === 0) {
          // kick po timeoutu
          await member
            .kick(
              config.welcomeFlow.timeoutKickReason ||
                "Timeout ověření"
            )
            .catch(() => {});
          console.log(
            `⏰ ${member.user.tag} byl automaticky vyhozen po timeoutu`
          );
        }
      });

    } else {
      // pokud verify vypnutý → hned dej VERIFIED roli (neposílej otázku)
      if (verifiedRoleId) {
        await member.roles.add(verifiedRoleId).catch(() => {});
        console.log(`👤 ${member.user.tag} dostal roli Verified (verify vypnuté)`);
      }
    }

  } catch (err) {
    console.error("❌ Chyba v guildMemberAdd:", err);
  }
});

// === 🧩 Reaction Add ===
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }

    const message = reaction.message;
    if (!message.guild) return;

    const rk = `add:${message.id}:${reaction.emoji.identifier}:${user.id}`;
    if (withShortLock(processedReactions, rk, 2000)) return;

       // 1) reaction roles (lajny z configu + ranky z RANK_EMOJI_ROLE_MAP)
    if (
      message.channelId ===
      config.channelsAndRoles.roleSelectChannelId
    ) {
      const emojiKey = reaction.emoji.toString();
      const EMOJI_ROLE_MAP = buildEmojiRoleMap();

      // nejdřív lajny / jiné role z configu, pak rank role
      const roleId =
        EMOJI_ROLE_MAP[emojiKey] || RANK_EMOJI_ROLE_MAP[emojiKey];

      if (!roleId) return;

      const member = await message.guild.members
        .fetch(user.id)
        .catch(() => null);
      if (member) await member.roles.add(roleId).catch(() => {});
      return;
    }


    // 2) approve / reject mod log
    if (
      message.channelId ===
      config.channelsAndRoles.joinLogChannelId
    ) {
      const embed = message.embeds?.[0];
      if (!embed?.title?.includes("Nový člen")) return;

      const match = embed.description?.match(/<@(\d+)>/);
      if (!match) return;
      const memberId = match[1];

      const guild = message.guild;
      const member = await guild.members
        .fetch(memberId)
        .catch(() => null);
      if (!member) return;

      if (reaction.emoji.name === "✅") {
        await member.roles
          .add(config.channelsAndRoles.verifiedRoleId)
          .catch(() => {});
        await member.roles
          .remove(config.channelsAndRoles.unverifiedRoleId)
          .catch(() => {});
        await message.delete().catch(() => {});

        const approveCfg =
          config.welcomeFlow.modLogEmbed.approveMessage;
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                fillTemplate(approveCfg.textTemplate, {
                  USER: `<@${member.id}>`,
                  MOD: `<@${user.id}>`
                })
              )
              .setColor(approveCfg.color || "#00FF00")
          ]
        });
      } else if (reaction.emoji.name === "❌") {
        await member
          .kick(`Zamítnuto ${user.tag}`)
          .catch(() => {});
        await message.delete().catch(() => {});

        const rejectCfg =
          config.welcomeFlow.modLogEmbed.rejectMessage;
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setDescription(
                fillTemplate(rejectCfg.textTemplate, {
                  USER: `<@${member.id}>`,
                  MOD: `<@${user.id}>`
                })
              )
              .setColor(rejectCfg.color || "#FF0000")
          ]
        });
      }
    }
  } catch (err) {
    console.error("⚠️ Chyba při messageReactionAdd:", err);
  }
});

// === 🧩 Reaction Remove ===
client.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    const message = reaction.message;
    if (!message.guild) return;
    if (
      message.channelId !==
      config.channelsAndRoles.roleSelectChannelId
    )
      return;

        const emojiKey = reaction.emoji.toString();
    const EMOJI_ROLE_MAP = buildEmojiRoleMap();
    const roleId =
      EMOJI_ROLE_MAP[emojiKey] || RANK_EMOJI_ROLE_MAP[emojiKey];
    if (!roleId) return;

    const member = await message.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (member) await member.roles.remove(roleId).catch(() => {});

  } catch (err) {
    console.error("⚠️ Chyba při messageReactionRemove:", err);
  }
});

// === 🔴 Leave & Ban ===
client.on("guildMemberRemove", async member => {
  const now = Date.now(),
    last = lastEvent.get(member.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(member.id, now);

  const ch = member.guild.channels.cache.get(
    config.channelsAndRoles.leaveBanChannelId
  );
  if (ch) {
    const leaveCfg = config.leaveBanLogs.leave;
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(
            fillTemplate(leaveCfg.textTemplate, {
              USER: `${member.user}`
            })
          )
          .setColor(leaveCfg.color || "#FFD700")
      ]
    });
  }
});

client.on("guildBanAdd", async ban => {
  const now = Date.now(),
    last = lastEvent.get(ban.user.id) || 0;
  if (now - last < 3000) return;
  lastEvent.set(ban.user.id, now);

  const ch = ban.guild.channels.cache.get(
    config.channelsAndRoles.leaveBanChannelId
  );
  if (ch) {
    const banCfg = config.leaveBanLogs.ban;
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setDescription(
            fillTemplate(banCfg.textTemplate, {
              USER: `${ban.user}`
            })
          )
          .setColor(banCfg.color || "#FF0000")
      ]
    });
  }
});

// === 🧮 Counters ===
let lastMemberCount = -1,
  lastUnverifiedCount = -1;

setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    // 🔇 Tichý fetch s fallbackem
    try {
      await guild.members.fetch();
    } catch (err) {
      if (err.message?.includes("Members didn't arrive in time")) {
        console.warn("⏱️ [Members] Timeout při fetchi – používám cache.");
      } else {
        console.warn("⚠️ [Members] Fetch error:", err.message);
      }
    }

    // [2] NOVÁ LOGIKA: počítat uživatele s alespoň jednou z pěti „game“ rolí
    const memberCount = guild.members.cache.filter(m => {
      if (m.user.bot) return false;
      if (m.id === config.channelsAndRoles.fallenPhoenixId) return false;
      return GAME_ROLE_IDS.some(rid => m.roles.cache.has(rid));
    }).size;

    if (memberCount !== lastMemberCount) {
      const ch = guild.channels.cache.get(
        config.channelsAndRoles.memberStatsChannelId // = 1429158078980423913
      );
      if (ch) {
        await ch
          .setName(`🔢︱Mᴇᴍʙᴇʀs: ${memberCount}`)
          .catch(() => {});
      }
      lastMemberCount = memberCount;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Members:", err.message);
  }
}, 30000);

setInterval(async () => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) return;

    // 🔇 Tichý fetch s fallbackem
try {
  await guild.members.fetch();
} catch (err) {
  // Pokud timeout → prostě ticho a fallback na cache
  if (err.message?.includes("Members didn't arrive in time")) {
    // ticho
  } else {
    // a i ostatní chyby ignorujeme, není důvod to logovat
  }
}

    const count = guild.members.cache.filter(m => {
      return (
        !m.user.bot &&
        m.roles.cache.has(config.channelsAndRoles.unverifiedRoleId)
      );
    }).size;

    if (count !== lastUnverifiedCount) {
      const ch = guild.channels.cache.get(
        config.channelsAndRoles.unverifiedStatsChannelId
      );
      if (ch) {
        await ch
          .setName(`❔︱Uɴᴠᴇʀɪғɪᴇᴅ: ${count}`)
          .catch(() => {});
      }
      lastUnverifiedCount = count;
    }
  } catch (err) {
    console.error("⚠️ Chyba při update Unverified:", err.message);
  }
}, 35000);

// === /clear + /ban + [3] BUTTON HANDLER ===
client.on("interactionCreate", async i => {
  if (i.isChatInputCommand()) {
    // /clear
    if (i.commandName === "clear") {
      const count = i.options.getInteger("pocet");
      if (count < 1 || count > 100) {
        return i.reply({
          content: "⚠️ Zadej číslo 1–100!",
          flags: 64
        });
      }

      try {
        const deleted = await i.channel.bulkDelete(count, true);
        await i.reply({
          content: `✅ Smazáno ${deleted.size} zpráv`,
          flags: 64
        });
        setTimeout(() => i.deleteReply().catch(() => {}), 1000);
      } catch (err) {
        if (err.code === 10008) {
          console.log(
            "⚠️ Některé zprávy už byly smazány dřív, přeskočeno."
          );
        } else {
          console.error("❌ Chyba při mazání zpráv:", err);
        }
      }
    }

    // /ban
    if (i.commandName === "ban") {
      const userId = i.options.getString("userid");
      const reason = i.options.getString("duvod") || "Bez důvodu";
      try {
        const guild = i.guild;
        await guild.bans.create(userId, { reason });

        await i.reply({
          content: `✅ Uživatel <@${userId}> byl zabanován.`,
          flags: 64
        });
        setTimeout(() => i.deleteReply().catch(() => {}), 1000);

        // log do onlineLogChannelId
        const logCh = guild.channels.cache.get(
          config.channelsAndRoles.onlineLogChannelId
        );
        if (logCh) {
          const banLogCfg = config.banCommandLog;
          const embed = new EmbedBuilder()
            .setTitle(banLogCfg.title)
            .setDescription(
              fillTemplate(banLogCfg.descriptionTemplate, {
                USER: `<@${userId}>`,
                USER_ID: userId,
                MOD: `<@${i.user.id}>`,
                REASON: reason
              })
            )
            .setColor(banLogCfg.color || "#FF0000");

          await logCh.send({ embeds: [embed] });
        }
      } catch (err) {
        console.error("❌ Chyba při /ban:", err);
        await i.reply({
          content: `⚠️ Nepodařilo se zabanovat uživatele s ID ${userId}`,
          flags: 64
        });
        setTimeout(() => i.deleteReply().catch(() => {}), 2000);
      }
    }

    return; // konec chat input commandů
  }

  // [3] Button handler – výběr hry/role (povolený jen 1 výběr)
  if (i.isButton() && i.customId.startsWith("pickgame:")) {
    try {
      const roleId = BUTTON_ROLE_MAP[i.customId];
      if (!roleId) {
        await i.reply({ content: "⚠️ Neznámé tlačítko.", ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
        return;
      }

      const member = await i.guild.members.fetch(i.user.id).catch(() => null);
      if (!member) {
        await i.reply({ content: "⚠️ Nepodařilo se načíst tvůj profil.", ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
        return;
      }

      // Pokud už má některou z „game“ rolí, další výběr nepovolíme
      const alreadyHasAny = GAME_ROLE_IDS.some(r => member.roles.cache.has(r));
      if (alreadyHasAny) {
        await i.reply({
          content: "❗ Už sis jednou vybral/a. Další změna není povolená.",
          ephemeral: true
        });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
        return;
      }

      // Přidat vybranou roli a pro jistotu odebrat ostatní z téhle pětice (mělo by být zbytečné, ale ať je to čisté)
      await member.roles.add(roleId).catch(() => {});
      for (const rid of GAME_ROLE_IDS) {
        if (rid !== roleId && member.roles.cache.has(rid)) {
          await member.roles.remove(rid).catch(() => {});
        }
      }

// Odebrat „zámek“ roli po výběru (aby už viděl zbytek serveru)
await member.roles.remove("1428624557635407902").catch(() => {});

      // Ephemeral potvrzení a rychlý autodelete jako u příkazů
      await i.reply({
        content: "✅ Role byla přidělena.",
        ephemeral: true
      });
      setTimeout(() => i.deleteReply().catch(() => {}), 1000);

// 🧹 Odstranit tlačítka a změnit text embedu po výběru
const oldEmbed = i.message.embeds[0];
if (oldEmbed) {
  const updatedEmbed = EmbedBuilder.from(oldEmbed)
    .setDescription(
      `:flag_cz: Vítej ${member}!\nNechovej se tu jako píča prosím. Díky! 🤍\n\n:flag_us: Welcome ${member}!\nPlease don’t act like a pussy here, thanks! 🤍`
    );

  await i.message
    .edit({ embeds: [updatedEmbed], components: [] })
    .catch(() => {});
}

      // Tlačítka „skrýt po kliknutí“ pouze pro jednoho usera Discord neumí.
      // (Nelze skrýt komponenty jen pro konkrétního uživatele bez smazání celé zprávy.)
      // Funkčně je ale zajištěno: po 1. volbě už další kliky neprojdou.

    } catch (err) {
      console.error("❌ Button handler error:", err);
      if (!i.replied) {
        await i.reply({ content: "⚠️ Něco se pokazilo.", ephemeral: true });
        setTimeout(() => i.deleteReply().catch(() => {}), 1500);
      }
    }
  }
});

// === 💤 Keepalive ping co 5 minut ===
setInterval(() => {
  fetch("https://discord-bot-i4hx.onrender.com")
    .then(() => console.log("💓 Keepalive ping"))
    .catch(e => console.error("⚠️ Keepalive error:", e.message));
}, 5 * 60 * 1000);

// === Přihlášení bota ===
client.login(process.env.BOT_TOKEN);
