/**
 * ============================================================================
 *  MC TIER BOT  ·  index.js
 * ============================================================================
 *  Minecraft PvP tier test / siralama Discord botu (MCTiers tarzi)
 *
 *  Ozellikler:
 *   - Hesap eslestirme (Mojang dogrulamali) ve oyuncu profilleri
 *   - 8 mod, HT1-LT5 tier sistemi, puan ve unvan hesaplama
 *   - Kalici test kuyrugu + canli kuyruk panelleri
 *   - Ticket tabanli test sistemi (panel, devral, sonuc, transcript, kapatma)
 *   - Otomatik tier rolleri, bekleme suresi, kara liste
 *   - Siralama tablolari (sayfali), karsilastirma, gecmis, istatistik
 *   - Otomatik yedekleme, durum dongusu, suresi dolan ticket temizligi
 *
 *  Gereksinimler: Node.js 18+, discord.js v14, better-sqlite3, dotenv
 * ============================================================================
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  ActivityType,
  MessageFlags,
} = require('discord.js');

// ============================================================================
// 1) AYARLAR
// ============================================================================
const ENV = process.env;

const CONFIG = {
  token: ENV.DISCORD_TOKEN,
  clientId: ENV.CLIENT_ID,
  guildId: ENV.GUILD_ID || null,
  testerRoleId: ENV.TESTER_ROLE_ID || null,
  adminRoleId: ENV.ADMIN_ROLE_ID || null,
  resultChannelId: ENV.RESULT_CHANNEL_ID || null,
  logChannelId: ENV.LOG_CHANNEL_ID || null,
  ticketCategoryId: ENV.TICKET_CATEGORY_ID || null,
  testCooldownDays: Number(ENV.TEST_COOLDOWN_DAYS || 30),
  ticketMaxHours: Number(ENV.TICKET_MAX_HOURS || 48),
  maxQueueSize: Number(ENV.MAX_QUEUE_SIZE || 50),
  requirePremium: ENV.REQUIRE_PREMIUM === 'true',
  autoRoles: ENV.AUTO_ROLES !== 'false',
  backupHours: Number(ENV.BACKUP_HOURS || 6),
  dataDir: path.join(__dirname, 'data'),
};

if (!CONFIG.token || !CONFIG.clientId) {
  console.error('[HATA] .env dosyasinda DISCORD_TOKEN ve CLIENT_ID zorunludur.');
  process.exit(1);
}

fs.mkdirSync(path.join(CONFIG.dataDir, 'backups'), { recursive: true });

// ============================================================================
// 2) SABITLER
// ============================================================================
const MODES = [
  { id: 'crystal', name: 'Crystal', emoji: '💎', description: 'Crystal PvP' },
  { id: 'sword', name: 'Sword', emoji: '⚔️', description: 'Kilic PvP' },
  { id: 'uhc', name: 'UHC', emoji: '❤️', description: 'UHC / Gapple' },
  { id: 'pot', name: 'Pot', emoji: '🧪', description: 'Potion PvP' },
  { id: 'nethpot', name: 'NethPot', emoji: '🔥', description: 'Netherite Pot' },
  { id: 'smp', name: 'SMP', emoji: '🌍', description: 'SMP PvP' },
  { id: 'axe', name: 'Axe', emoji: '🪓', description: 'Balta PvP' },
  { id: 'mace', name: 'Mace', emoji: '🔨', description: 'Mace PvP' },
];
const MODE_MAP = Object.fromEntries(MODES.map((m) => [m.id, m]));

const TIERS = [
  { id: 'HT1', points: 60, color: 0xffd700, emoji: '🏆' },
  { id: 'LT1', points: 44, color: 0xf1c40f, emoji: '🏆' },
  { id: 'HT2', points: 32, color: 0xe67e22, emoji: '🥇' },
  { id: 'LT2', points: 20, color: 0xd35400, emoji: '🥇' },
  { id: 'HT3', points: 16, color: 0xe74c3c, emoji: '🥈' },
  { id: 'LT3', points: 10, color: 0xc0392b, emoji: '🥈' },
  { id: 'HT4', points: 6, color: 0x9b59b6, emoji: '🥉' },
  { id: 'LT4', points: 4, color: 0x8e44ad, emoji: '🥉' },
  { id: 'HT5', points: 2, color: 0x3498db, emoji: '🎖️' },
  { id: 'LT5', points: 1, color: 0x2980b9, emoji: '🎖️' },
];
const TIER_MAP = Object.fromEntries(TIERS.map((t) => [t.id, t]));

const REGIONS = [
  { id: 'EU', name: 'Avrupa' },
  { id: 'NA', name: 'Kuzey Amerika' },
  { id: 'AS', name: 'Asya' },
  { id: 'SA', name: 'Guney Amerika' },
  { id: 'AU', name: 'Okyanusya' },
  { id: 'AF', name: 'Afrika' },
];
const REGION_MAP = Object.fromEntries(REGIONS.map((r) => [r.id, r]));

const RANK_TITLES = [
  { min: 400, name: 'Combat Grandmaster', emoji: '👑' },
  { min: 250, name: 'Combat Master', emoji: '💠' },
  { min: 100, name: 'Combat Ace', emoji: '🔱' },
  { min: 50, name: 'Combat Specialist', emoji: '⭐' },
  { min: 20, name: 'Combat Cadet', emoji: '🔰' },
  { min: 10, name: 'Combat Novice', emoji: '🌱' },
  { min: 0, name: 'Rookie', emoji: '🪵' },
];

const COLORS = {
  primary: 0x5865f2,
  success: 0x2ecc71,
  error: 0xe74c3c,
  warn: 0xf1c40f,
  gold: 0xffd700,
  dark: 0x2b2d31,
};

const PAGE_SIZE = 10;
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;

// ============================================================================
// 3) GENEL YARDIMCILAR
// ============================================================================
const LOG_FILE = path.join(CONFIG.dataDir, 'bot.log');

function log(level, ...args) {
  const text = args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch (_) {
        return String(a);
      }
    })
    .join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${text}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {
    /* log dosyasi yazilamazsa sessizce gec */
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const relTime = (t) => `<t:${t}:R>`;
const fullTime = (t) => `<t:${t}:F>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isValidNick = (n) => NICK_REGEX.test(n || '');
const avatarUrl = (nick, size = 128) => `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/${size}`;
const bodyUrl = (nick) => `https://mc-heads.net/body/${encodeURIComponent(nick)}/right`;

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}g`);
  if (h) parts.push(`${h}sa`);
  if (m || !parts.length) parts.push(`${m}dk`);
  return parts.join(' ');
}

function medal(pos) {
  if (pos === 1) return '🥇';
  if (pos === 2) return '🥈';
  if (pos === 3) return '🥉';
  return `\`#${pos}\``;
}

// ============================================================================
// 4) VERITABANI
// ============================================================================
const db = new Database(path.join(CONFIG.dataDir, 'mctier.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  nick         TEXT PRIMARY KEY,
  display_nick TEXT NOT NULL,
  discord_id   TEXT,
  uuid         TEXT,
  region       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_discord ON players(discord_id);

CREATE TABLE IF NOT EXISTS tiers (
  nick        TEXT NOT NULL,
  mode        TEXT NOT NULL,
  tier        TEXT NOT NULL,
  points      INTEGER NOT NULL,
  peak_tier   TEXT NOT NULL,
  peak_points INTEGER NOT NULL,
  tester_id   TEXT,
  updated_at  INTEGER NOT NULL,
  retired     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (nick, mode)
);
CREATE INDEX IF NOT EXISTS idx_tiers_mode ON tiers(mode, points DESC);

CREATE TABLE IF NOT EXISTS history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nick      TEXT NOT NULL,
  mode      TEXT NOT NULL,
  old_tier  TEXT,
  new_tier  TEXT,
  tester_id TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_nick ON history(nick, id DESC);

CREATE TABLE IF NOT EXISTS queue (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  mode      TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  nick      TEXT NOT NULL,
  region    TEXT,
  joined_at INTEGER NOT NULL,
  UNIQUE (mode, user_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  channel_id TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  nick       TEXT NOT NULL,
  mode       TEXT NOT NULL,
  region     TEXT,
  tester_id  TEXT,
  result     TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS blacklist (
  user_id TEXT PRIMARY KEY,
  reason  TEXT,
  by_id   TEXT,
  at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  user_id TEXT NOT NULL,
  mode    TEXT NOT NULL,
  until   INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const Q = {
  // --- oyuncular
  getPlayer: db.prepare('SELECT * FROM players WHERE nick = ?'),
  getPlayerByDiscord: db.prepare('SELECT * FROM players WHERE discord_id = ?'),
  insertPlayer: db.prepare(
    'INSERT INTO players (nick, display_nick, discord_id, uuid, region, created_at) VALUES (@nick, @display_nick, @discord_id, @uuid, @region, @created_at)'
  ),
  updatePlayer: db.prepare(
    'UPDATE players SET display_nick = @display_nick, discord_id = COALESCE(@discord_id, discord_id), uuid = COALESCE(@uuid, uuid), region = COALESCE(@region, region) WHERE nick = @nick'
  ),
  unlinkPlayer: db.prepare('UPDATE players SET discord_id = NULL WHERE discord_id = ?'),
  searchNicks: db.prepare('SELECT display_nick FROM players WHERE nick LIKE ? ORDER BY nick LIMIT 25'),
  countPlayers: db.prepare('SELECT COUNT(*) AS c FROM players'),

  // --- tierlar
  getTiers: db.prepare('SELECT * FROM tiers WHERE nick = ? ORDER BY points DESC'),
  getTier: db.prepare('SELECT * FROM tiers WHERE nick = ? AND mode = ?'),
  upsertTier: db.prepare(`
    INSERT INTO tiers (nick, mode, tier, points, peak_tier, peak_points, tester_id, updated_at, retired)
    VALUES (@nick, @mode, @tier, @points, @peak_tier, @peak_points, @tester_id, @updated_at, 0)
    ON CONFLICT (nick, mode) DO UPDATE SET
      tier = @tier, points = @points, peak_tier = @peak_tier, peak_points = @peak_points,
      tester_id = @tester_id, updated_at = @updated_at, retired = 0`),
  deleteTier: db.prepare('DELETE FROM tiers WHERE nick = ? AND mode = ?'),
  retireTier: db.prepare('UPDATE tiers SET retired = 1 WHERE nick = ? AND mode = ?'),
  countTiers: db.prepare('SELECT COUNT(*) AS c FROM tiers'),
  tierDistribution: db.prepare('SELECT tier, COUNT(*) AS c FROM tiers WHERE retired = 0 GROUP BY tier ORDER BY MAX(points) DESC'),
  modeDistribution: db.prepare('SELECT mode, COUNT(*) AS c FROM tiers WHERE retired = 0 GROUP BY mode ORDER BY c DESC'),

  // --- gecmis
  insertHistory: db.prepare('INSERT INTO history (nick, mode, old_tier, new_tier, tester_id, at) VALUES (?, ?, ?, ?, ?, ?)'),
  getHistory: db.prepare('SELECT * FROM history WHERE nick = ? ORDER BY id DESC LIMIT 15'),
  getHistoryMode: db.prepare('SELECT * FROM history WHERE nick = ? AND mode = ? ORDER BY id DESC LIMIT 15'),

  // --- siralama
  lbOverall: db.prepare(`
    SELECT t.nick AS nick, COALESCE(p.display_nick, t.nick) AS name, SUM(t.points) AS total, COUNT(*) AS modes
    FROM tiers t LEFT JOIN players p ON p.nick = t.nick
    WHERE t.retired = 0 GROUP BY t.nick
    ORDER BY total DESC, MIN(t.updated_at) ASC LIMIT ? OFFSET ?`),
  lbOverallCount: db.prepare('SELECT COUNT(DISTINCT nick) AS c FROM tiers WHERE retired = 0'),
  lbMode: db.prepare(`
    SELECT t.nick AS nick, COALESCE(p.display_nick, t.nick) AS name, t.tier AS tier, t.points AS points
    FROM tiers t LEFT JOIN players p ON p.nick = t.nick
    WHERE t.mode = ? AND t.retired = 0
    ORDER BY t.points DESC, t.updated_at ASC LIMIT ? OFFSET ?`),
  lbModeCount: db.prepare('SELECT COUNT(*) AS c FROM tiers WHERE mode = ? AND retired = 0'),
  overallRank: db.prepare(
    'SELECT COUNT(*) + 1 AS pos FROM (SELECT nick, SUM(points) AS s FROM tiers WHERE retired = 0 GROUP BY nick) WHERE s > ?'
  ),

  // --- kuyruk
  queueAdd: db.prepare('INSERT OR IGNORE INTO queue (mode, user_id, nick, region, joined_at) VALUES (?, ?, ?, ?, ?)'),
  queueRemove: db.prepare('DELETE FROM queue WHERE mode = ? AND user_id = ?'),
  queueRemoveAll: db.prepare('DELETE FROM queue WHERE user_id = ?'),
  queueList: db.prepare('SELECT * FROM queue WHERE mode = ? ORDER BY joined_at ASC, id ASC'),
  queueHas: db.prepare('SELECT 1 AS x FROM queue WHERE mode = ? AND user_id = ?'),
  queueCount: db.prepare('SELECT COUNT(*) AS c FROM queue WHERE mode = ?'),
  queueCountAll: db.prepare('SELECT COUNT(*) AS c FROM queue'),
  queueFirst: db.prepare('SELECT * FROM queue WHERE mode = ? ORDER BY joined_at ASC, id ASC LIMIT 1'),
  queueClear: db.prepare('DELETE FROM queue WHERE mode = ?'),

  // --- ticketlar
  ticketInsert: db.prepare(
    "INSERT INTO tickets (channel_id, user_id, nick, mode, region, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)"
  ),
  ticketByChannel: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
  ticketOpenByUser: db.prepare("SELECT * FROM tickets WHERE user_id = ? AND status = 'open'"),
  ticketClaim: db.prepare('UPDATE tickets SET tester_id = ? WHERE channel_id = ?'),
  ticketResult: db.prepare('UPDATE tickets SET result = ? WHERE channel_id = ?'),
  ticketClose: db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE channel_id = ?"),
  ticketsStale: db.prepare("SELECT * FROM tickets WHERE status = 'open' AND created_at < ?"),
  ticketCounts: db.prepare('SELECT status, COUNT(*) AS c FROM tickets GROUP BY status'),

  // --- kara liste
  blAdd: db.prepare('INSERT OR REPLACE INTO blacklist (user_id, reason, by_id, at) VALUES (?, ?, ?, ?)'),
  blRemove: db.prepare('DELETE FROM blacklist WHERE user_id = ?'),
  blGet: db.prepare('SELECT * FROM blacklist WHERE user_id = ?'),
  blList: db.prepare('SELECT * FROM blacklist ORDER BY at DESC LIMIT 25'),
  blCount: db.prepare('SELECT COUNT(*) AS c FROM blacklist'),

  // --- bekleme sureleri
  cdGet: db.prepare('SELECT until FROM cooldowns WHERE user_id = ? AND mode = ?'),
  cdSet: db.prepare('INSERT OR REPLACE INTO cooldowns (user_id, mode, until) VALUES (?, ?, ?)'),
  cdDel: db.prepare('DELETE FROM cooldowns WHERE user_id = ? AND mode = ?'),
  cdDelAll: db.prepare('DELETE FROM cooldowns WHERE user_id = ?'),
  cdList: db.prepare('SELECT mode, until FROM cooldowns WHERE user_id = ? AND until > ?'),

  // --- ayarlar
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
  delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
};

// ============================================================================
// 5) AYAR / IZIN / EMBED YARDIMCILARI
// ============================================================================
function getSetting(key, fallback = null) {
  const row = Q.getSetting.get(key);
  return row ? row.value : fallback;
}
const setSetting = (key, value) => Q.setSetting.run(key, String(value));
const delSetting = (key) => Q.delSetting.run(key);

/** Ayar degerini once veritabanindan (/ayar ile), yoksa .env'den okur. */
function conf(key) {
  return getSetting(`cfg:${key}`) || CONFIG[key] || null;
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const rid = conf('adminRoleId');
  return Boolean(rid && member.roles.cache.has(rid));
}

function isTester(member) {
  if (!member) return false;
  if (isAdmin(member)) return true;
  const rid = conf('testerRoleId');
  return Boolean(rid && member.roles.cache.has(rid));
}

function makeEmbed(color = COLORS.primary) {
  return new EmbedBuilder().setColor(color).setTimestamp();
}
const okEmbed = (text) => makeEmbed(COLORS.success).setDescription(`✅ ${text}`);
const errEmbed = (text) => makeEmbed(COLORS.error).setDescription(`❌ ${text}`);
const warnEmbed = (text) => makeEmbed(COLORS.warn).setDescription(`⚠️ ${text}`);

/** Etkilesim durumuna gore (reply / editReply / followUp) guvenli cevap verir. */
async function reply(i, payload, ephemeral = false) {
  const data = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (i.deferred) {
    delete data.flags;
    return i.editReply(data);
  }
  if (ephemeral) data.flags = MessageFlags.Ephemeral;
  if (i.replied) return i.followUp(data);
  return i.reply(data);
}
const fail = (i, text) => reply(i, { embeds: [errEmbed(text)] }, true);

// ============================================================================
// 6) MOJANG DOGRULAMA
// ============================================================================
async function fetchMojang(nick) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(nick)}`, {
      signal: ctrl.signal,
    });
    if (res.status === 200) {
      const data = await res.json();
      return { status: 'ok', uuid: data.id, name: data.name };
    }
    if (res.status === 404 || res.status === 204) return { status: 'notfound' };
    return { status: 'error' };
  } catch (_) {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 7) PUAN / UNVAN / OYUNCU YARDIMCILARI
// ============================================================================
const totalPoints = (rows) => rows.filter((r) => !r.retired).reduce((sum, r) => sum + r.points, 0);
const getRankTitle = (points) => RANK_TITLES.find((r) => points >= r.min) || RANK_TITLES[RANK_TITLES.length - 1];
const tierLabel = (id, retired = false) => (TIER_MAP[id] ? `${TIER_MAP[id].emoji} ${retired ? 'R' : ''}${id}` : '—');

/** Oyuncu kaydi yoksa olusturur; varsa gerekirse gunceller. */
function ensurePlayer(nick, extra = {}) {
  const key = nick.toLowerCase();
  let player = Q.getPlayer.get(key);
  if (!player) {
    Q.insertPlayer.run({
      nick: key,
      display_nick: nick,
      discord_id: extra.discord_id || null,
      uuid: extra.uuid || null,
      region: extra.region || null,
      created_at: nowSec(),
    });
    return Q.getPlayer.get(key);
  }
  const needsUpdate =
    extra.discord_id || extra.uuid || extra.region || (extra.display_nick && extra.display_nick !== player.display_nick);
  if (needsUpdate) {
    Q.updatePlayer.run({
      nick: key,
      display_nick: extra.display_nick || player.display_nick,
      discord_id: extra.discord_id || null,
      uuid: extra.uuid || null,
      region: extra.region || null,
    });
    player = Q.getPlayer.get(key);
  }
  return player;
}

/** nick / kullanici / kendi hesabi sirasiyla oyuncuyu bulur. */
function resolvePlayer({ nick, userId }) {
  if (nick) return Q.getPlayer.get(nick.toLowerCase()) || null;
  if (userId) return Q.getPlayerByDiscord.get(userId) || null;
  return null;
}

// ============================================================================
// 8) KARA LISTE / BEKLEME
// ============================================================================
const isBlacklisted = (userId) => Q.blGet.get(userId) || null;

function getCooldown(userId, modeId) {
  const row = Q.cdGet.get(userId, modeId);
  if (!row) return null;
  if (row.until <= nowSec()) {
    Q.cdDel.run(userId, modeId);
    return null;
  }
  return row.until;
}

function setCooldown(userId, modeId, days = CONFIG.testCooldownDays) {
  if (!days || days <= 0) return;
  Q.cdSet.run(userId, modeId, nowSec() + days * 86400);
}

// ============================================================================
// 9) KANAL / LOG / ROL YARDIMCILARI
// ============================================================================
async function sendToChannel(guild, channelId, payload) {
  if (!channelId || !guild) return null;
  const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return null;
  return channel.send(payload).catch((e) => {
    log('WARN', `Kanala mesaj gonderilemedi (${channelId}):`, e.message);
    return null;
  });
}

const sendLog = (guild, embed) => sendToChannel(guild, conf('logChannelId'), { embeds: [embed] });

async function ensureTierRole(guild, mode, tierId) {
  const name = `${mode.name} ${tierId}`;
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    role = await guild.roles.create({
      name,
      color: TIER_MAP[tierId].color,
      mentionable: false,
      reason: 'MC Tier otomatik rol',
    });
  }
  return role;
}

/** Uyenin o moddaki eski tier rollerini temizler, yenisini verir (tierId null ise sadece temizler). */
async function syncTierRole(guild, userId, modeId, tierId) {
  if (!CONFIG.autoRoles || !guild || !userId) return;
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    const mode = MODE_MAP[modeId];
    const prefix = `${mode.name} `;
    const oldRoles = member.roles.cache.filter((r) => r.name.startsWith(prefix) && TIER_MAP[r.name.slice(prefix.length)]);
    if (oldRoles.size) await member.roles.remove(oldRoles, 'Tier guncellemesi');
    if (tierId) {
      const role = await ensureTierRole(guild, mode, tierId);
      await member.roles.add(role, 'Tier verildi');
    }
  } catch (e) {
    log('WARN', 'Rol senkronizasyon hatasi:', e.message);
  }
}

// ============================================================================
// 10) TIER UYGULAMA (cekirdek is mantigi)
// ============================================================================
async function applyTierResult({ guild, nick, modeId, tierId, testerId, discordId = null, cooldown = false }) {
  const mode = MODE_MAP[modeId];
  const tier = TIER_MAP[tierId];
  let player = ensurePlayer(nick);

  // Discord hesabi henuz bagli degilse ve baska birine ait degilse bagla.
  if (discordId && !player.discord_id && !Q.getPlayerByDiscord.get(discordId)) {
    player = ensurePlayer(nick, { discord_id: discordId });
  }
  const targetDiscord = player.discord_id || null;

  const pointsBefore = totalPoints(Q.getTiers.all(player.nick));
  const old = Q.getTier.get(player.nick, modeId);
  const peak =
    old && old.peak_points >= tier.points
      ? { tier: old.peak_tier, points: old.peak_points }
      : { tier: tier.id, points: tier.points };

  Q.upsertTier.run({
    nick: player.nick,
    mode: modeId,
    tier: tier.id,
    points: tier.points,
    peak_tier: peak.tier,
    peak_points: peak.points,
    tester_id: testerId,
    updated_at: nowSec(),
  });
  Q.insertHistory.run(player.nick, modeId, old ? old.tier : null, tier.id, testerId, nowSec());

  const pointsAfter = totalPoints(Q.getTiers.all(player.nick));
  const titleBefore = getRankTitle(pointsBefore);
  const titleAfter = getRankTitle(pointsAfter);

  if (targetDiscord) {
    await syncTierRole(guild, targetDiscord, modeId, tier.id);
    if (cooldown) setCooldown(targetDiscord, modeId);
  }

  const embed = makeEmbed(tier.color)
    .setTitle(`${mode.emoji} ${mode.name} Test Sonucu`)
    .setThumbnail(avatarUrl(player.display_nick, 128))
    .addFields(
      { name: 'Oyuncu', value: `**${player.display_nick}**`, inline: true },
      { name: 'Yeni Tier', value: `**${tierLabel(tier.id)}**`, inline: true },
      { name: 'Onceki Tier', value: old ? tierLabel(old.tier) : 'İlk test', inline: true },
      { name: 'Tester', value: `<@${testerId}>`, inline: true },
      { name: 'Toplam Puan', value: `${pointsAfter} (${tier.points - (old ? old.points : 0) >= 0 ? '+' : ''}${tier.points - (old ? old.points : 0)})`, inline: true },
      { name: 'Unvan', value: `${titleAfter.emoji} ${titleAfter.name}`, inline: true }
    );
  if (titleAfter.name !== titleBefore.name) {
    embed.setDescription(`🎉 **Yeni unvan kazanildi:** ${titleAfter.emoji} ${titleAfter.name}`);
  }

  await sendToChannel(guild, conf('resultChannelId'), {
    content: targetDiscord ? `<@${targetDiscord}>` : undefined,
    embeds: [embed],
  });
  await sendLog(
    guild,
    makeEmbed(COLORS.dark).setDescription(
      `📝 <@${testerId}> **${player.display_nick}** icin ${mode.name} tierini ${old ? old.tier : 'yok'} → **${tier.id}** yapti.`
    )
  );
  return { player, old, tier, discordId: targetDiscord, pointsAfter };
}

async function removeTierResult({ guild, nick, modeId, byId }) {
  const player = Q.getPlayer.get(nick.toLowerCase());
  if (!player) return null;
  const old = Q.getTier.get(player.nick, modeId);
  if (!old) return null;
  Q.deleteTier.run(player.nick, modeId);
  Q.insertHistory.run(player.nick, modeId, old.tier, null, byId, nowSec());
  if (player.discord_id) await syncTierRole(guild, player.discord_id, modeId, null);
  await sendLog(
    guild,
    makeEmbed(COLORS.dark).setDescription(`🗑️ <@${byId}> **${player.display_nick}** icin ${MODE_MAP[modeId].name} tierini (${old.tier}) sildi.`)
  );
  return { player, old };
}

// ============================================================================
// 11) PROFIL / SIRALAMA / KARSILASTIRMA EMBED'LERI
// ============================================================================
function buildProfileEmbed(player) {
  const rows = Q.getTiers.all(player.nick);
  const points = totalPoints(rows);
  const title = getRankTitle(points);
  const active = rows.filter((r) => !r.retired);
  const position = active.length ? Q.overallRank.get(points).pos : null;

  const embed = makeEmbed(active.length ? TIER_MAP[active[0].tier].color : COLORS.primary)
    .setTitle(`${title.emoji} ${player.display_nick}`)
    .setDescription(`**${title.name}**${position ? ` · Genel Sira: **#${position}**` : ''}\n💠 Toplam Puan: **${points}**`)
    .setThumbnail(avatarUrl(player.display_nick, 128))
    .setImage(bodyUrl(player.display_nick));

  for (const mode of MODES) {
    const row = rows.find((r) => r.mode === mode.id);
    let value = '`Testlenmedi`';
    if (row) {
      value = `${tierLabel(row.tier, row.retired)}`;
      if (row.peak_tier !== row.tier) value += `\nZirve: ${row.peak_tier}`;
    }
    embed.addFields({ name: `${mode.emoji} ${mode.name}`, value, inline: true });
  }

  const info = [];
  if (player.region) info.push(`🌐 ${REGION_MAP[player.region]?.name || player.region}`);
  if (player.discord_id) info.push(`<@${player.discord_id}>`);
  info.push(`Kayit: ${relTime(player.created_at)}`);
  embed.addFields({ name: 'Bilgi', value: info.join(' · ') });
  return embed;
}

function buildLeaderboard(modeId, page) {
  const isAll = modeId === 'all';
  const total = isAll ? Q.lbOverallCount.get().c : Q.lbModeCount.get(modeId).c;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const offset = (current - 1) * PAGE_SIZE;
  const rows = isAll ? Q.lbOverall.all(PAGE_SIZE, offset) : Q.lbMode.all(modeId, PAGE_SIZE, offset);

  const lines = rows.map((r, idx) => {
    const pos = offset + idx + 1;
    if (isAll) {
      const t = getRankTitle(r.total);
      return `${medal(pos)} **${r.name}** — ${r.total} puan · ${r.modes} mod · ${t.emoji} ${t.name}`;
    }
    return `${medal(pos)} **${r.name}** — ${tierLabel(r.tier)} · ${r.points} puan`;
  });

  const heading = isAll ? '🏆 Genel Siralama' : `${MODE_MAP[modeId].emoji} ${MODE_MAP[modeId].name} Siralamasi`;
  const embed = makeEmbed(COLORS.gold)
    .setTitle(heading)
    .setDescription(lines.length ? lines.join('\n') : 'Henuz kayitli oyuncu yok.')
    .setFooter({ text: `Sayfa ${current}/${pages} · Toplam ${total} oyuncu` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lb|${modeId}|${current - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(current <= 1),
    new ButtonBuilder().setCustomId('lb|noop|0').setLabel(`${current}/${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`lb|${modeId}|${current + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(current >= pages)
  );
  return { embeds: [embed], components: [row] };
}

function buildCompareEmbed(a, b) {
  const rowsA = Q.getTiers.all(a.nick);
  const rowsB = Q.getTiers.all(b.nick);
  const pointsA = totalPoints(rowsA);
  const pointsB = totalPoints(rowsB);

  const lines = MODES.map((mode) => {
    const ra = rowsA.find((r) => r.mode === mode.id && !r.retired);
    const rb = rowsB.find((r) => r.mode === mode.id && !r.retired);
    const pa = ra ? ra.points : 0;
    const pb = rb ? rb.points : 0;
    const mark = pa === pb ? '➖' : pa > pb ? '◀️' : '▶️';
    return `${mode.emoji} **${mode.name}**: ${ra ? ra.tier : '—'} ${mark} ${rb ? rb.tier : '—'}`;
  });

  let verdict = '🤝 Berabere';
  if (pointsA > pointsB) verdict = `🏅 **${a.display_nick}** onde (+${pointsA - pointsB})`;
  if (pointsB > pointsA) verdict = `🏅 **${b.display_nick}** onde (+${pointsB - pointsA})`;

  return makeEmbed(COLORS.primary)
    .setTitle(`⚔️ ${a.display_nick} vs ${b.display_nick}`)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: a.display_nick, value: `${pointsA} puan`, inline: true },
      { name: b.display_nick, value: `${pointsB} puan`, inline: true },
      { name: 'Sonuc', value: verdict }
    );
}

// ============================================================================
// 12) KUYRUK MANTIGI VE CANLI PANELLER
// ============================================================================
/** Kullaniciyi kuyruga ekler. {ok:true} veya {ok:false, reason} doner. */
function queueJoin(modeId, userId, nick, region) {
  if (isBlacklisted(userId)) return { ok: false, reason: 'Kara listedesin, teste katilamazsin.' };
  const cd = getCooldown(userId, modeId);
  if (cd) return { ok: false, reason: `Bu modda bekleme suresindesin. Tekrar test: ${relTime(cd)}` };
  if (Q.queueHas.get(modeId, userId)) return { ok: false, reason: 'Zaten bu kuyruktasin.' };
  if (Q.queueCount.get(modeId).c >= CONFIG.maxQueueSize) return { ok: false, reason: 'Kuyruk dolu, daha sonra tekrar dene.' };
  Q.queueAdd.run(modeId, userId, nick, region || null, nowSec());
  const pos = Q.queueList.all(modeId).findIndex((r) => r.user_id === userId) + 1;
  return { ok: true, position: pos };
}

function queueLeave(modeId, userId) {
  return Q.queueRemove.run(modeId, userId).changes > 0;
}

function buildQueuePanel(modeId) {
  const mode = MODE_MAP[modeId];
  const list = Q.queueList.all(modeId);
  const shown = list.slice(0, 20);
  const text = shown.length
    ? shown.map((r, idx) => `\`${idx + 1}.\` <@${r.user_id}> — **${r.nick}**${r.region ? ` (${r.region})` : ''}`).join('\n')
    : '_Kuyruk su an bos._';

  const embed = makeEmbed(COLORS.primary)
    .setTitle(`${mode.emoji} ${mode.name} Test Kuyrugu`)
    .setDescription(text)
    .setFooter({ text: `${list.length}/${CONFIG.maxQueueSize} oyuncu` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`q|join|${modeId}`).setLabel('Katil').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`q|leave|${modeId}`).setLabel('Ayril').setEmoji('🚪').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`q|refresh|${modeId}`).setEmoji('🔄').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

/** Kayitli canli panel mesajini gunceller (silinmisse kaydi temizler). */
async function refreshQueuePanel(modeId) {
  const stored = getSetting(`qpanel:${modeId}`);
  if (!stored) return;
  const [channelId, messageId] = stored.split(':');
  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit(buildQueuePanel(modeId));
  } catch (_) {
    delSetting(`qpanel:${modeId}`);
  }
}

// ============================================================================
// 13) TICKET PANELI
// ============================================================================
function buildTicketPanel() {
  const embed = makeEmbed(COLORS.gold)
    .setTitle('⚔️ Tier Testi Talep Et')
    .setDescription(
      [
        'Asagidaki butona basarak bir tier testi talep edebilirsin.',
        '',
        '**Nasil calisir?**',
        '1️⃣ Butona bas ve test olmak istedigin modu sec.',
        '2️⃣ Minecraft nickini ve bolgeni gir.',
        '3️⃣ Senin icin ozel bir kanal acilir, bir tester seni test eder.',
        '',
        `⏳ Testten sonra ayni modda **${CONFIG.testCooldownDays} gun** beklemen gerekir.`,
      ].join('\n')
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk|open').setLabel('Test Talep Et').setEmoji('🎫').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

// ============================================================================
// 14) ISTEMCI
// ============================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // rol senkronu + ayrilan uye takibi (Portal'dan acilmali)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // transcript icin (Portal'dan acilmali)
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ============================================================================
// 15) SLASH KOMUT TANIMLARI
// ============================================================================
const modeOption = (required = true) => (o) =>
  o
    .setName('mod')
    .setDescription('Oyun modu')
    .setRequired(required)
    .addChoices(...MODES.map((m) => ({ name: m.name, value: m.id })));

const tierOption = (o) =>
  o
    .setName('tier')
    .setDescription('Verilecek tier')
    .setRequired(true)
    .addChoices(...TIERS.map((t) => ({ name: t.id, value: t.id })));

const regionOption = (required = false) => (o) =>
  o
    .setName('bolge')
    .setDescription('Bolgen')
    .setRequired(required)
    .addChoices(...REGIONS.map((r) => ({ name: `${r.id} - ${r.name}`, value: r.id })));

const nickOption = (name = 'nick', required = true, desc = 'Minecraft nicki') => (o) =>
  o.setName(name).setDescription(desc).setRequired(required).setAutocomplete(true).setMaxLength(16);

const userOption = (name = 'kullanici', required = false, desc = 'Discord kullanicisi') => (o) =>
  o.setName(name).setDescription(desc).setRequired(required);

const COMMAND_DATA = [
  new SlashCommandBuilder().setName('yardim').setDescription('Botun komutlarini gosterir').setDMPermission(false),

  new SlashCommandBuilder().setName('ping').setDescription('Botun gecikmesini gosterir').setDMPermission(false),

  new SlashCommandBuilder()
    .setName('hesap')
    .setDescription('Minecraft hesap eslestirme')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('kayit')
        .setDescription('Minecraft hesabini Discord hesabina bagla')
        .addStringOption(nickOption('nick', true, 'Minecraft nickin'))
        .addStringOption(regionOption(false))
    )
    .addSubcommand((s) =>
      s.setName('sil').setDescription('Hesap eslestirmesini kaldir').addUserOption(userOption('kullanici', false, 'Sadece yoneticiler'))
    )
    .addSubcommand((s) => s.setName('bilgi').setDescription('Bagli hesabi goster').addUserOption(userOption())),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Oyuncu tier profilini gosterir')
    .setDMPermission(false)
    .addStringOption(nickOption('nick', false))
    .addUserOption(userOption()),

  new SlashCommandBuilder()
    .setName('tier')
    .setDescription('Tier islemleri')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('ver')
        .setDescription('Oyuncuya tier ver (tester)')
        .addStringOption(nickOption('nick', true))
        .addStringOption(modeOption())
        .addStringOption(tierOption)
        .addUserOption(userOption('kullanici', false, 'Oyuncunun Discord hesabi'))
        .addBooleanOption((o) => o.setName('bekleme').setDescription('Bekleme suresi uygulansin mi?'))
    )
    .addSubcommand((s) => s.setName('goster').setDescription('Oyuncunun tierlarini goster').addStringOption(nickOption('nick', true)))
    .addSubcommand((s) =>
      s.setName('sil').setDescription('Oyuncunun bir moddaki tierini sil (tester)').addStringOption(nickOption('nick', true)).addStringOption(modeOption())
    )
    .addSubcommand((s) =>
      s.setName('emekli').setDescription('Oyuncuyu bir modda emekli et (tester)').addStringOption(nickOption('nick', true)).addStringOption(modeOption())
    )
    .addSubcommand((s) =>
      s.setName('gecmis').setDescription('Tier gecmisini goster').addStringOption(nickOption('nick', true)).addStringOption(modeOption(false))
    )
    .addSubcommand((s) => s.setName('siralama').setDescription('Siralama tablosu').addStringOption(modeOption(false)))
    .addSubcommand((s) =>
      s
        .setName('karsilastir')
        .setDescription('Iki oyuncuyu karsilastir')
        .addStringOption(nickOption('oyuncu1', true, 'Birinci oyuncu'))
        .addStringOption(nickOption('oyuncu2', true, 'Ikinci oyuncu'))
    ),

  new SlashCommandBuilder()
    .setName('kuyruk')
    .setDescription('Test kuyrugu')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('katil').setDescription('Test kuyruguna katil').addStringOption(modeOption()).addStringOption(nickOption('nick', false, 'Kayitli degilsen nickin')))
    .addSubcommand((s) => s.setName('ayril').setDescription('Kuyruktan ayril').addStringOption(modeOption()))
    .addSubcommand((s) => s.setName('liste').setDescription('Kuyrugu goster').addStringOption(modeOption()))
    .addSubcommand((s) => s.setName('sonraki').setDescription('Siradaki oyuncuyu cagir (tester)').addStringOption(modeOption()))
    .addSubcommand((s) => s.setName('temizle').setDescription('Kuyrugu temizle (yonetici)').addStringOption(modeOption()))
    .addSubcommand((s) => s.setName('panel').setDescription('Canli kuyruk paneli olustur (yonetici)').addStringOption(modeOption())),

  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Test (ticket) islemleri')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('panel').setDescription('Test talep panelini gonder (yonetici)'))
    .addSubcommand((s) => s.setName('devral').setDescription('Bu ticketi devral (tester)'))
    .addSubcommand((s) => s.setName('sonuc').setDescription('Bu ticket icin sonuc gir (tester)').addStringOption(tierOption))
    .addSubcommand((s) =>
      s.setName('kapat').setDescription('Bu ticketi kapat (tester)').addStringOption((o) => o.setName('sebep').setDescription('Kapatma sebebi'))
    ),

  new SlashCommandBuilder()
    .setName('karaliste')
    .setDescription('Kara liste yonetimi (yonetici)')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('ekle')
        .setDescription('Kullaniciyi kara listeye ekle')
        .addUserOption(userOption('kullanici', true))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setMaxLength(200))
    )
    .addSubcommand((s) => s.setName('cikar').setDescription('Kullaniciyi kara listeden cikar').addUserOption(userOption('kullanici', true)))
    .addSubcommand((s) => s.setName('liste').setDescription('Kara listeyi goster')),

  new SlashCommandBuilder()
    .setName('bekleme')
    .setDescription('Test bekleme sureleri')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('goster').setDescription('Bekleme surelerini goster').addUserOption(userOption()))
    .addSubcommand((s) =>
      s
        .setName('sifirla')
        .setDescription('Bekleme suresini sifirla (yonetici)')
        .addUserOption(userOption('kullanici', true))
        .addStringOption(modeOption(false))
    ),

  new SlashCommandBuilder()
    .setName('ayar')
    .setDescription('Bot ayarlari (yonetici)')
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('kanal')
        .setDescription('Kanal ayarla')
        .addStringOption((o) =>
          o
            .setName('tur')
            .setDescription('Kanal turu')
            .setRequired(true)
            .addChoices(
              { name: 'Sonuc kanali', value: 'resultChannelId' },
              { name: 'Log kanali', value: 'logChannelId' },
              { name: 'Ticket kategorisi', value: 'ticketCategoryId' }
            )
        )
        .addChannelOption((o) =>
          o
            .setName('kanal')
            .setDescription('Kanal veya kategori')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildCategory, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('rol')
        .setDescription('Rol ayarla')
        .addStringOption((o) =>
          o
            .setName('tur')
            .setDescription('Rol turu')
            .setRequired(true)
            .addChoices({ name: 'Tester rolu', value: 'testerRoleId' }, { name: 'Yonetici rolu', value: 'adminRoleId' })
        )
        .addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true))
    )
    .addSubcommand((s) => s.setName('goster').setDescription('Mevcut ayarlari goster')),

  new SlashCommandBuilder().setName('istatistik').setDescription('Bot istatistiklerini gosterir').setDMPermission(false),

  new ContextMenuCommandBuilder().setName('Tier Profili').setType(ApplicationCommandType.User).setDMPermission(false),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  const body = COMMAND_DATA.map((c) => c.toJSON());
  if (CONFIG.guildId) {
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body });
    log('INFO', `${body.length} komut sunucuya (${CONFIG.guildId}) kaydedildi.`);
  } else {
    await rest.put(Routes.applicationCommands(CONFIG.clientId), { body });
    log('INFO', `${body.length} komut global olarak kaydedildi (yayilmasi 1 saat surebilir).`);
  }
}

// ============================================================================
// 16) KOMUT ISLEYICILERI
// ============================================================================
const handlers = {};

// ---------------------------------------------------------------- /yardim
handlers.yardim = async (i) => {
  const embed = makeEmbed(COLORS.primary)
    .setTitle('📖 MC Tier Bot - Yardim')
    .setDescription('Minecraft PvP tier testi, siralama ve kuyruk sistemi.')
    .addFields(
      {
        name: '👤 Oyuncu',
        value: [
          '`/hesap kayit` - Minecraft hesabini bagla',
          '`/hesap sil` · `/hesap bilgi` - Eslestirmeyi yonet',
          '`/profil` - Tier profilini goster',
        ].join('\n'),
      },
      {
        name: '🏆 Tier',
        value: [
          '`/tier goster` · `/tier gecmis` - Tier bilgisi ve gecmis',
          '`/tier siralama` - Genel veya mod siralamasi',
          '`/tier karsilastir` - Iki oyuncuyu karsilastir',
        ].join('\n'),
      },
      {
        name: '⏳ Kuyruk ve Test',
        value: [
          '`/kuyruk katil` · `/kuyruk ayril` · `/kuyruk liste`',
          '`/bekleme goster` - Bekleme surelerini gor',
          'Test panelindeki **Test Talep Et** butonu ile ticket ac.',
        ].join('\n'),
      },
      {
        name: '🛡️ Tester',
        value: [
          '`/tier ver` · `/tier sil` · `/tier emekli`',
          '`/kuyruk sonraki` · `/test devral` · `/test sonuc` · `/test kapat`',
        ].join('\n'),
      },
      {
        name: '⚙️ Yonetici',
        value: [
          '`/test panel` · `/kuyruk panel` · `/kuyruk temizle`',
          '`/karaliste` · `/bekleme sifirla` · `/ayar`',
        ].join('\n'),
      },
      {
        name: '📊 Puan Tablosu',
        value: TIERS.map((t) => `${t.id}: ${t.points}`).join(' · '),
      }
    );
  return reply(i, { embeds: [embed] }, true);
};

// ---------------------------------------------------------------- /ping
handlers.ping = async (i) => {
  const embed = makeEmbed(COLORS.success).setDescription(
    `🏓 WebSocket: **${Math.round(client.ws.ping)}ms**\n🗄️ Oyuncu sayisi: **${Q.countPlayers.get().c}**`
  );
  return reply(i, { embeds: [embed] }, true);
};

// ---------------------------------------------------------------- /hesap
handlers.hesap = async (i) => {
  const sub = i.options.getSubcommand();

  if (sub === 'kayit') {
    const nick = i.options.getString('nick', true).trim();
    const region = i.options.getString('bolge');
    if (!isValidNick(nick)) return fail(i, 'Gecersiz nick. 3-16 karakter, sadece harf, rakam ve alt cizgi kullanabilirsin.');
    if (isBlacklisted(i.user.id)) return fail(i, 'Kara listedesin, hesap baglayamazsin.');

    const linked = Q.getPlayerByDiscord.get(i.user.id);
    if (linked && linked.nick !== nick.toLowerCase()) {
      return fail(i, `Zaten **${linked.display_nick}** hesabina bagli durumdasin. Once \`/hesap sil\` kullan.`);
    }
    const existing = Q.getPlayer.get(nick.toLowerCase());
    if (existing && existing.discord_id && existing.discord_id !== i.user.id) {
      return fail(i, 'Bu nick baska bir Discord hesabina bagli. Sorun varsa bir yoneticiye ulas.');
    }

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const check = await fetchMojang(nick);
    if (check.status === 'notfound' && CONFIG.requirePremium) {
      return fail(i, 'Bu nick Mojang kayitlarinda bulunamadi. Sadece orijinal hesaplar kabul ediliyor.');
    }
    const finalNick = check.status === 'ok' ? check.name : nick;
    const player = ensurePlayer(finalNick, {
      discord_id: i.user.id,
      uuid: check.status === 'ok' ? check.uuid : null,
      region,
      display_nick: finalNick,
    });

    const embed = okEmbed(`Hesabin baglandi: **${player.display_nick}**`).setThumbnail(avatarUrl(player.display_nick));
    if (check.status === 'notfound') embed.setFooter({ text: 'Not: Nick Mojang kayitlarinda bulunamadi (cracked olabilir).' });
    if (check.status === 'error') embed.setFooter({ text: 'Not: Mojang API ulasilamadi, dogrulama yapilamadi.' });
    return reply(i, { embeds: [embed] });
  }

  if (sub === 'sil') {
    const target = i.options.getUser('kullanici');
    if (target && target.id !== i.user.id && !isAdmin(i.member)) {
      return fail(i, 'Baskasinin hesabini sadece yoneticiler silebilir.');
    }
    const userId = target ? target.id : i.user.id;
    const player = Q.getPlayerByDiscord.get(userId);
    if (!player) return fail(i, 'Bagli bir hesap bulunamadi.');
    Q.unlinkPlayer.run(userId);
    Q.queueRemoveAll.run(userId);
    for (const m of MODES) refreshQueuePanel(m.id);
    return reply(i, { embeds: [okEmbed(`**${player.display_nick}** eslestirmesi kaldirildi.`)] }, true);
  }

  if (sub === 'bilgi') {
    const user = i.options.getUser('kullanici') || i.user;
    const player = Q.getPlayerByDiscord.get(user.id);
    if (!player) return fail(i, `${user} icin bagli hesap yok.`);
    const embed = makeEmbed(COLORS.primary)
      .setTitle('🔗 Bagli Hesap')
      .setThumbnail(avatarUrl(player.display_nick))
      .addFields(
        { name: 'Nick', value: player.display_nick, inline: true },
        { name: 'Bolge', value: player.region || '—', inline: true },
        { name: 'UUID', value: player.uuid ? `\`${player.uuid}\`` : '—' },
        { name: 'Kayit', value: fullTime(player.created_at) }
      );
    return reply(i, { embeds: [embed] }, true);
  }
};

// ---------------------------------------------------------------- /profil
handlers.profil = async (i) => {
  const nick = i.options.getString('nick');
  const user = i.options.getUser('kullanici');
  const player = resolvePlayer({ nick, userId: nick ? null : (user || i.user).id });
  if (!player) {
    return fail(i, nick ? `**${nick}** icin kayit bulunamadi.` : 'Profil bulunamadi. Once `/hesap kayit` ile hesabini bagla.');
  }
  return reply(i, { embeds: [buildProfileEmbed(player)] });
};

// ---------------------------------------------------------------- /tier
handlers.tier = async (i) => {
  const sub = i.options.getSubcommand();

  if (sub === 'ver') {
    if (!isTester(i.member)) return fail(i, 'Bu komut icin tester yetkisi gerekir.');
    const nick = i.options.getString('nick', true).trim();
    const modeId = i.options.getString('mod', true);
    const tierId = i.options.getString('tier', true);
    const user = i.options.getUser('kullanici');
    const cooldown = i.options.getBoolean('bekleme') ?? false;
    if (!isValidNick(nick)) return fail(i, 'Gecersiz Minecraft nicki.');

    if (user) {
      const other = Q.getPlayerByDiscord.get(user.id);
      if (other && other.nick !== nick.toLowerCase()) {
        return fail(i, `${user} zaten **${other.display_nick}** hesabina bagli.`);
      }
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const res = await applyTierResult({
      guild: i.guild,
      nick,
      modeId,
      tierId,
      testerId: i.user.id,
      discordId: user ? user.id : null,
      cooldown,
    });
    if (res.discordId) {
      queueLeave(modeId, res.discordId);
      refreshQueuePanel(modeId);
    }
    return reply(i, {
      embeds: [okEmbed(`**${res.player.display_nick}** → ${MODE_MAP[modeId].name} **${tierId}** (toplam ${res.pointsAfter} puan)`)],
    });
  }

  if (sub === 'goster') {
    const nick = i.options.getString('nick', true);
    const player = resolvePlayer({ nick });
    if (!player) return fail(i, `**${nick}** icin kayit bulunamadi.`);
    return reply(i, { embeds: [buildProfileEmbed(player)] });
  }

  if (sub === 'sil' || sub === 'emekli') {
    if (!isTester(i.member)) return fail(i, 'Bu komut icin tester yetkisi gerekir.');
    const nick = i.options.getString('nick', true);
    const modeId = i.options.getString('mod', true);
    const player = resolvePlayer({ nick });
    if (!player || !Q.getTier.get(player.nick, modeId)) return fail(i, 'Oyuncunun bu modda kaydi yok.');

    if (sub === 'sil') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await removeTierResult({ guild: i.guild, nick, modeId, byId: i.user.id });
      return reply(i, { embeds: [okEmbed(`**${player.display_nick}** icin ${MODE_MAP[modeId].name} tieri silindi.`)] });
    }
    Q.retireTier.run(player.nick, modeId);
    Q.insertHistory.run(player.nick, modeId, Q.getTier.get(player.nick, modeId).tier, 'R', i.user.id, nowSec());
    return reply(i, { embeds: [okEmbed(`**${player.display_nick}** ${MODE_MAP[modeId].name} modunda emekli edildi.`)] }, true);
  }

  if (sub === 'gecmis') {
    const nick = i.options.getString('nick', true);
    const modeId = i.options.getString('mod');
    const player = resolvePlayer({ nick });
    if (!player) return fail(i, `**${nick}** icin kayit bulunamadi.`);
    const rows = modeId ? Q.getHistoryMode.all(player.nick, modeId) : Q.getHistory.all(player.nick);
    if (!rows.length) return fail(i, 'Gecmis kaydi bulunamadi.');
    const lines = rows.map((r) => {
      const m = MODE_MAP[r.mode];
      return `${m ? m.emoji : '•'} **${m ? m.name : r.mode}**: ${r.old_tier || '—'} → **${r.new_tier || 'silindi'}** · ${relTime(r.at)}`;
    });
    const embed = makeEmbed(COLORS.primary)
      .setTitle(`📜 ${player.display_nick} - Tier Gecmisi`)
      .setThumbnail(avatarUrl(player.display_nick))
      .setDescription(lines.join('\n'));
    return reply(i, { embeds: [embed] });
  }

  if (sub === 'siralama') {
    const modeId = i.options.getString('mod') || 'all';
    return reply(i, buildLeaderboard(modeId, 1));
  }

  if (sub === 'karsilastir') {
    const n1 = i.options.getString('oyuncu1', true);
    const n2 = i.options.getString('oyuncu2', true);
    const a = resolvePlayer({ nick: n1 });
    const b = resolvePlayer({ nick: n2 });
    if (!a) return fail(i, `**${n1}** icin kayit bulunamadi.`);
    if (!b) return fail(i, `**${n2}** icin kayit bulunamadi.`);
    return reply(i, { embeds: [buildCompareEmbed(a, b)] });
  }
};

// ---------------------------------------------------------------- /kuyruk
handlers.kuyruk = async (i) => {
  const sub = i.options.getSubcommand();
  const modeId = i.options.getString('mod', true);
  const mode = MODE_MAP[modeId];

  if (sub === 'katil') {
    let nick = i.options.getString('nick');
    const linked = Q.getPlayerByDiscord.get(i.user.id);
    if (linked) nick = linked.display_nick;
    if (!nick) return fail(i, 'Once `/hesap kayit` ile hesabini bagla veya nick yaz.');
    if (!isValidNick(nick)) return fail(i, 'Gecersiz Minecraft nicki.');
    const res = queueJoin(modeId, i.user.id, nick, linked ? linked.region : null);
    if (!res.ok) return fail(i, res.reason);
    refreshQueuePanel(modeId);
    return reply(i, { embeds: [okEmbed(`${mode.emoji} **${mode.name}** kuyruguna katildin. Siran: **${res.position}**`)] }, true);
  }

  if (sub === 'ayril') {
    if (!queueLeave(modeId, i.user.id)) return fail(i, 'Bu kuyrukta degilsin.');
    refreshQueuePanel(modeId);
    return reply(i, { embeds: [okEmbed('Kuyruktan ayrildin.')] }, true);
  }

  if (sub === 'liste') {
    return reply(i, buildQueuePanel(modeId), true);
  }

  if (sub === 'sonraki') {
    if (!isTester(i.member)) return fail(i, 'Bu komut icin tester yetkisi gerekir.');
    const next = Q.queueFirst.get(modeId);
    if (!next) return fail(i, 'Kuyruk bos.');
    Q.queueRemove.run(modeId, next.user_id);
    refreshQueuePanel(modeId);
    const embed = makeEmbed(COLORS.gold).setDescription(
      `📣 <@${next.user_id}> (**${next.nick}**) sira sende! ${i.user} seni **${mode.name}** icin test edecek.`
    );
    try {
      const user = await client.users.fetch(next.user_id);
      await user.send({ embeds: [embed] }).catch(() => null);
    } catch (_) {
      /* DM kapaliysa sorun degil */
    }
    return reply(i, { content: `<@${next.user_id}>`, embeds: [embed] });
  }

  if (sub === 'temizle') {
    if (!isAdmin(i.member)) return fail(i, 'Bu komut icin yonetici yetkisi gerekir.');
    const count = Q.queueCount.get(modeId).c;
    Q.queueClear.run(modeId);
    refreshQueuePanel(modeId);
    return reply(i, { embeds: [okEmbed(`${mode.name} kuyrugu temizlendi (${count} kisi).`)] }, true);
  }

  if (sub === 'panel') {
    if (!isAdmin(i.member)) return fail(i, 'Bu komut icin yonetici yetkisi gerekir.');
    const message = await i.channel.send(buildQueuePanel(modeId));
    setSetting(`qpanel:${modeId}`, `${message.channelId}:${message.id}`);
    return reply(i, { embeds: [okEmbed('Canli kuyruk paneli olusturuldu.')] }, true);
  }
};

// ---------------------------------------------------------------- /test
handlers.test = async (i) => {
  const sub = i.options.getSubcommand();

  if (sub === 'panel') {
    if (!isAdmin(i.member)) return fail(i, 'Bu komut icin yonetici yetkisi gerekir.');
    await i.channel.send(buildTicketPanel());
    return reply(i, { embeds: [okEmbed('Test paneli gonderildi.')] }, true);
  }

  const ticket = Q.ticketByChannel.get(i.channelId);
  if (!ticket || ticket.status !== 'open') return fail(i, 'Bu komut sadece acik bir test ticketinde kullanilabilir.');
  if (!isTester(i.member)) return fail(i, 'Bu komut icin tester yetkisi gerekir.');

  if (sub === 'devral') {
    await claimTicket(i, ticket);
    return;
  }
  if (sub === 'sonuc') {
    await giveTicketResult(i, ticket, i.options.getString('tier', true));
    return;
  }
  if (sub === 'kapat') {
    const reason = i.options.getString('sebep') || 'Belirtilmedi';
    await reply(i, { embeds: [warnEmbed('Ticket 5 saniye icinde kapatiliyor...')] });
    await closeTicket(i.channel, i.user, reason);
  }
};

// ---------------------------------------------------------------- /karaliste
handlers.karaliste = async (i) => {
  if (!isAdmin(i.member)) return fail(i, 'Bu komut icin yonetici yetkisi gerekir.');
  const sub = i.options.getSubcommand();

  if (sub === 'ekle') {
    const user = i.options.getUser('kullanici', true);
    const reason = i.options.getString('sebep') || 'Sebep belirtilmedi';
    if (user.bot) return fail(i, 'Botlar kara listeye eklenemez.');
    Q.blAdd.run(user.id, reason, i.user.id, nowSec());
    Q.queueRemoveAll.run(user.id);
    for (const m of MODES) refreshQueuePanel(m.id);
    await sendLog(i.guild, makeEmbed(COLORS.error).setDescription(`⛔ ${user} kara listeye eklendi. Sebep: ${reason} (${i.user})`));
    return reply(i, { embeds: [okEmbed(`${user} kara listeye eklendi.`)] }, true);
  }

  if (sub === 'cikar') {
    const user = i.options.getUser('kullanici', true);
    if (Q.blRemove.run(user.id).changes === 0) return fail(i, 'Bu kullanici kara listede degil.');
    await sendLog(i.guild, makeEmbed(COLORS.success).setDescription(`✅ ${user} kara listeden cikarildi. (${i.user})`));
    return reply(i, { embeds: [okEmbed(`${user} kara listeden cikarildi.`)] }, true);
  }

  if (sub === 'liste') {
    const rows = Q.blList.all();
    if (!rows.length) return reply(i, { embeds: [warnEmbed('Kara liste bos.')] }, true);
    const lines = rows.map((r) => `<@${r.user_id}> — ${truncate(r.reason, 80)} · ${relTime(r.at)}`);
    return reply(i, { embeds: [makeEmbed(COLORS.error).setTitle('⛔ Kara Liste').setDescription(lines.join('\n'))] }, true);
  }
};

// ---------------------------------------------------------------- /bekleme
handlers.bekleme = async (i) => {
  const sub = i.options.getSubcommand();

  if (sub === 'goster') {
    const user = i.options.getUser('kullanici') || i.user;
    const rows = Q.cdList.all(user.id, nowSec());
    if (!rows.length) return reply(i, { embeds: [okEmbed(`${user} icin aktif bekleme suresi yok.`)] }, true);
    const lines = rows.map((r) => `${MODE_MAP[r.mode].emoji} **${MODE_MAP[r.mode].name}**: ${relTime(r.until)}`);
    return reply(i, { embeds: [makeEmbed(COLORS.warn).setTitle('⏳ Bekleme Sureleri').setDescription(lines.join('\n'))] }, true);
  }

  if (sub === 'sifirla') {
    if (!isAdmin(i.member)) return fail(i, 'Bu komut icin yonetici yetkisi gerekir.');
    const user = i.options.getUser('kullanici', true);
    const modeId = i.options.getString('mod');
    if (modeId) Q.cdDel.run(user.id, modeId);
    else Q.cdDelAll.run(user.id);
    return reply(i, { embeds: [okEmbed(`${user} icin bekleme suresi sifirlandi${modeId ? ` (${MODE_MAP[modeId].name})` : ''}.`)] }, true);
  }
};

// ---------------------------------------------------------------- /ayar
handlers.ayar = async (i) => {
  if (!isAdmin(i.member)) return fail(i, 'Bu komut icin yonetici yetkisi gerekir.');
  const sub = i.options.getSubcommand();

  if (sub === 'kanal') {
    const type = i.options.getString('tur', true);
    const channel = i.options.getChannel('kanal', true);
    if (type === 'ticketCategoryId' && channel.type !== ChannelType.GuildCategory) {
      return fail(i, 'Ticket icin bir **kategori** secmelisin.');
    }
    if (type !== 'ticketCategoryId' && channel.type === ChannelType.GuildCategory) {
      return fail(i, 'Bu ayar icin bir **metin kanali** secmelisin.');
    }
    setSetting(`cfg:${type}`, channel.id);
    return reply(i, { embeds: [okEmbed(`Ayar kaydedildi: ${channel}`)] }, true);
  }

  if (sub === 'rol') {
    const type = i.options.getString('tur', true);
    const role = i.options.getRole('rol', true);
    setSetting(`cfg:${type}`, role.id);
    return reply(i, { embeds: [okEmbed(`Ayar kaydedildi: ${role}`)] }, true);
  }

  if (sub === 'goster') {
    const show = (key, kind) => {
      const v = conf(key);
      if (!v) return '`Ayarlanmadi`';
      return kind === 'role' ? `<@&${v}>` : `<#${v}>`;
    };
    const embed = makeEmbed(COLORS.primary)
      .setTitle('⚙️ Bot Ayarlari')
      .addFields(
        { name: 'Sonuc Kanali', value: show('resultChannelId'), inline: true },
        { name: 'Log Kanali', value: show('logChannelId'), inline: true },
        { name: 'Ticket Kategorisi', value: show('ticketCategoryId'), inline: true },
        { name: 'Tester Rolu', value: show('testerRoleId', 'role'), inline: true },
        { name: 'Yonetici Rolu', value: show('adminRoleId', 'role'), inline: true },
        { name: 'Otomatik Roller', value: CONFIG.autoRoles ? 'Acik' : 'Kapali', inline: true },
        { name: 'Bekleme Suresi', value: `${CONFIG.testCooldownDays} gun`, inline: true },
        { name: 'Ticket Omru', value: `${CONFIG.ticketMaxHours} saat`, inline: true },
        { name: 'Premium Zorunlu', value: CONFIG.requirePremium ? 'Evet' : 'Hayir', inline: true }
      );
    return reply(i, { embeds: [embed] }, true);
  }
};

// ---------------------------------------------------------------- /istatistik
handlers.istatistik = async (i) => {
  const tickets = Object.fromEntries(Q.ticketCounts.all().map((r) => [r.status, r.c]));
  const tierDist = Q.tierDistribution.all().map((r) => `${r.tier}: **${r.c}**`).join(' · ') || '—';
  const modeDist =
    Q.modeDistribution
      .all()
      .map((r) => `${MODE_MAP[r.mode].emoji} ${MODE_MAP[r.mode].name}: **${r.c}**`)
      .join('\n') || '—';

  const embed = makeEmbed(COLORS.primary)
    .setTitle('📊 Istatistikler')
    .addFields(
      { name: 'Kayitli Oyuncu', value: String(Q.countPlayers.get().c), inline: true },
      { name: 'Toplam Tier', value: String(Q.countTiers.get().c), inline: true },
      { name: 'Kuyrukta', value: String(Q.queueCountAll.get().c), inline: true },
      { name: 'Acik Ticket', value: String(tickets.open || 0), inline: true },
      { name: 'Kapali Ticket', value: String(tickets.closed || 0), inline: true },
      { name: 'Kara Liste', value: String(Q.blCount.get().c), inline: true },
      { name: 'Tier Dagilimi', value: tierDist },
      { name: 'Mod Dagilimi', value: modeDist },
      { name: 'Calisma Suresi', value: formatDuration(Math.floor(process.uptime())), inline: true },
      { name: 'Bellek', value: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`, inline: true }
    );
  return reply(i, { embeds: [embed] });
};

// ---------------------------------------------------------------- baglam menusu
async function handleContext(i) {
  if (i.commandName !== 'Tier Profili') return;
  const player = Q.getPlayerByDiscord.get(i.targetId);
  if (!player) return fail(i, `${i.targetUser} icin bagli bir Minecraft hesabi yok.`);
  return reply(i, { embeds: [buildProfileEmbed(player)] }, true);
}

// ---------------------------------------------------------------- otomatik tamamlama
async function handleAutocomplete(i) {
  const focused = i.options.getFocused(true);
  const nickFields = ['nick', 'oyuncu1', 'oyuncu2'];
  if (!nickFields.includes(focused.name)) return i.respond([]);
  const term = String(focused.value || '').replace(/[%_]/g, '');
  const rows = Q.searchNicks.all(`${term.toLowerCase()}%`);
  return i.respond(rows.map((r) => ({ name: r.display_nick, value: r.display_nick })));
}

// ============================================================================
// 17) TICKET SISTEMI
// ============================================================================
function ticketButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk|claim').setLabel('Devral').setEmoji('🙋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tk|result').setLabel('Sonuc Gir').setEmoji('🏁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('tk|close').setLabel('Kapat').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

/** Kullanicinin ticket acip acamayacagini kontrol eder. Hata metni veya null doner. */
function checkTicketEligibility(userId, modeId) {
  if (isBlacklisted(userId)) return 'Kara listedesin, test talep edemezsin.';
  const open = Q.ticketOpenByUser.get(userId);
  if (open) return `Zaten acik bir ticketin var: <#${open.channel_id}>`;
  const cd = getCooldown(userId, modeId);
  if (cd) return `Bu modda bekleme suresindesin. Tekrar test: ${relTime(cd)}`;
  return null;
}

async function createTicket(i, modeId, nick, region, notes) {
  const guild = i.guild;
  const mode = MODE_MAP[modeId];
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: i.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];
  const testerRoleId = conf('testerRoleId');
  if (testerRoleId && guild.roles.cache.has(testerRoleId)) {
    overwrites.push({
      id: testerRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
      ],
    });
  }

  const categoryId = conf('ticketCategoryId');
  const category = categoryId ? guild.channels.cache.get(categoryId) : null;

  const channel = await guild.channels.create({
    name: `test-${mode.id}-${nick}`.toLowerCase().slice(0, 90),
    type: ChannelType.GuildText,
    parent: category && category.type === ChannelType.GuildCategory ? category.id : undefined,
    topic: `Tier testi · ${nick} · ${mode.name} · ${i.user.id}`,
    permissionOverwrites: overwrites,
    reason: `Test ticketi: ${i.user.tag}`,
  });

  Q.ticketInsert.run(channel.id, i.user.id, nick, modeId, region, nowSec());
  queueJoin(modeId, i.user.id, nick, region); // basarisizsa sorun degil (ticket yine de acik)
  refreshQueuePanel(modeId);

  const embed = makeEmbed(COLORS.gold)
    .setTitle(`${mode.emoji} ${mode.name} Tier Testi`)
    .setThumbnail(avatarUrl(nick))
    .addFields(
      { name: 'Oyuncu', value: `${i.user} · **${nick}**`, inline: true },
      { name: 'Mod', value: mode.name, inline: true },
      { name: 'Bolge', value: region ? REGION_MAP[region].name : '—', inline: true },
      { name: 'Not', value: notes ? truncate(notes, 500) : '_Yok_' }
    )
    .setFooter({ text: 'Bir tester en kisa surede seninle ilgilenecek.' });

  const testerPing = testerRoleId ? `<@&${testerRoleId}>` : '';
  await channel.send({ content: `${i.user} ${testerPing}`.trim(), embeds: [embed], components: [ticketButtons()] });
  await sendLog(
    guild,
    makeEmbed(COLORS.dark).setDescription(`🎫 ${i.user} icin ${channel} ticketi acildi (${mode.name} · ${nick}).`)
  );
  return channel;
}

async function claimTicket(i, ticket) {
  if (ticket.tester_id && ticket.tester_id !== i.user.id) {
    return fail(i, `Bu ticket zaten <@${ticket.tester_id}> tarafindan devralinmis.`);
  }
  Q.ticketClaim.run(i.user.id, ticket.channel_id);
  return reply(i, {
    embeds: [makeEmbed(COLORS.success).setDescription(`🙋 ${i.user} bu testi devraldi. <@${ticket.user_id}>, hazir ol!`)],
  });
}

async function giveTicketResult(i, ticket, tierId) {
  if (!TIER_MAP[tierId]) return fail(i, 'Gecersiz tier.');
  await i.deferReply();
  if (!ticket.tester_id) Q.ticketClaim.run(i.user.id, ticket.channel_id);

  const res = await applyTierResult({
    guild: i.guild,
    nick: ticket.nick,
    modeId: ticket.mode,
    tierId,
    testerId: i.user.id,
    discordId: ticket.user_id,
    cooldown: true,
  });
  Q.ticketResult.run(tierId, ticket.channel_id);
  queueLeave(ticket.mode, ticket.user_id);
  refreshQueuePanel(ticket.mode);

  const embed = makeEmbed(TIER_MAP[tierId].color)
    .setTitle('🏁 Test Tamamlandi')
    .setDescription(
      `**${res.player.display_nick}** → ${MODE_MAP[ticket.mode].emoji} ${MODE_MAP[ticket.mode].name}: **${tierLabel(tierId)}**\n` +
        `Toplam puan: **${res.pointsAfter}**\n\nSonuc sonuc kanalinda paylasildi. Ticketi kapatmak icin asagidaki butonu kullan.`
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk|close').setLabel('Ticketi Kapat').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
  return reply(i, { content: `<@${ticket.user_id}>`, embeds: [embed], components: [row] });
}

async function buildTranscript(channel, ticket) {
  const all = [];
  let before;
  for (let n = 0; n < 5; n += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const header = [
    '=== MC TIER BOT - TICKET TRANSCRIPT ===',
    `Oyuncu : ${ticket.nick} (${ticket.user_id})`,
    `Mod    : ${MODE_MAP[ticket.mode]?.name || ticket.mode}`,
    `Tester : ${ticket.tester_id || '-'}`,
    `Acilis : ${new Date(ticket.created_at * 1000).toISOString()}`,
    '=======================================',
    '',
  ];
  const lines = all.map((m) => {
    const time = new Date(m.createdTimestamp).toISOString();
    const content = m.content || (m.embeds.length ? '[embed]' : '');
    const files = m.attachments.size ? ` [ek: ${[...m.attachments.values()].map((a) => a.url).join(', ')}]` : '';
    return `[${time}] ${m.author.tag}: ${content}${files}`;
  });
  return header.concat(lines).join('\n');
}

async function closeTicket(channel, closedBy, reason) {
  const ticket = Q.ticketByChannel.get(channel.id);
  if (!ticket || ticket.status !== 'open') return;
  Q.ticketClose.run(nowSec(), channel.id);
  queueLeave(ticket.mode, ticket.user_id);
  refreshQueuePanel(ticket.mode);

  const transcript = await buildTranscript(channel, ticket);
  const embed = makeEmbed(COLORS.dark)
    .setTitle('🎫 Ticket Kapatildi')
    .addFields(
      { name: 'Oyuncu', value: `<@${ticket.user_id}> (${ticket.nick})`, inline: true },
      { name: 'Mod', value: MODE_MAP[ticket.mode]?.name || ticket.mode, inline: true },
      { name: 'Sonuc', value: ticket.result || 'Verilmedi', inline: true },
      { name: 'Tester', value: ticket.tester_id ? `<@${ticket.tester_id}>` : '—', inline: true },
      { name: 'Kapatan', value: String(closedBy), inline: true },
      { name: 'Sebep', value: truncate(reason, 300) }
    );
  await sendToChannel(channel.guild, conf('logChannelId'), {
    embeds: [embed],
    files: [{ attachment: Buffer.from(transcript, 'utf8'), name: `transcript-${ticket.nick}-${ticket.mode}.txt` }],
  });

  try {
    const user = await client.users.fetch(ticket.user_id);
    await user
      .send({ embeds: [makeEmbed(COLORS.dark).setDescription(`🎫 **${MODE_MAP[ticket.mode]?.name}** test ticketin kapatildi. Sonuc: **${ticket.result || 'Verilmedi'}**`)] })
      .catch(() => null);
  } catch (_) {
    /* kullanici bulunamadi / DM kapali */
  }

  await sleep(5000);
  await channel.delete(`Ticket kapatildi: ${reason}`).catch((e) => log('WARN', 'Ticket kanali silinemedi:', e.message));
}

// ============================================================================
// 18) BILESEN ETKILESIMLERI (buton / secim menusu / modal)
// ============================================================================
async function handleButton(i) {
  const [scope, action, extra] = i.customId.split('|');

  // ---- siralama sayfalama
  if (scope === 'lb') {
    if (action === 'noop') return i.deferUpdate();
    return i.update(buildLeaderboard(action, Number(extra) || 1));
  }

  // ---- kuyruk panel butonlari
  if (scope === 'q') {
    const modeId = extra;
    if (!MODE_MAP[modeId]) return fail(i, 'Gecersiz mod.');
    if (action === 'refresh') return i.update(buildQueuePanel(modeId));
    if (action === 'join') {
      const linked = Q.getPlayerByDiscord.get(i.user.id);
      if (!linked) return fail(i, 'Kuyruga katilmak icin once `/hesap kayit` ile hesabini baglamalisin.');
      const res = queueJoin(modeId, i.user.id, linked.display_nick, linked.region);
      if (!res.ok) return fail(i, res.reason);
      await reply(i, { embeds: [okEmbed(`Kuyruga katildin. Siran: **${res.position}**`)] }, true);
      return refreshQueuePanel(modeId);
    }
    if (action === 'leave') {
      if (!queueLeave(modeId, i.user.id)) return fail(i, 'Bu kuyrukta degilsin.');
      await reply(i, { embeds: [okEmbed('Kuyruktan ayrildin.')] }, true);
      return refreshQueuePanel(modeId);
    }
    return null;
  }

  // ---- ticket butonlari
  if (scope === 'tk') {
    if (action === 'open') {
      if (isBlacklisted(i.user.id)) return fail(i, 'Kara listedesin, test talep edemezsin.');
      const open = Q.ticketOpenByUser.get(i.user.id);
      if (open) return fail(i, `Zaten acik bir ticketin var: <#${open.channel_id}>`);
      const menu = new StringSelectMenuBuilder()
        .setCustomId('tk|mode')
        .setPlaceholder('Test olmak istedigin modu sec')
        .addOptions(MODES.map((m) => ({ label: m.name, value: m.id, description: m.description, emoji: m.emoji })));
      return reply(i, { content: '🎮 Hangi modda test olmak istiyorsun?', components: [new ActionRowBuilder().addComponents(menu)] }, true);
    }

    const ticket = Q.ticketByChannel.get(i.channelId);
    if (!ticket || ticket.status !== 'open') return fail(i, 'Bu ticket artik aktif degil.');

    if (action === 'claim') {
      if (!isTester(i.member)) return fail(i, 'Bu islem icin tester yetkisi gerekir.');
      return claimTicket(i, ticket);
    }

    if (action === 'result') {
      if (!isTester(i.member)) return fail(i, 'Bu islem icin tester yetkisi gerekir.');
      const menu = new StringSelectMenuBuilder()
        .setCustomId('tk|tier')
        .setPlaceholder('Verilecek tieri sec')
        .addOptions(TIERS.map((t) => ({ label: t.id, value: t.id, description: `${t.points} puan`, emoji: t.emoji })));
      return reply(i, { content: '🏁 Oyuncunun tierini sec:', components: [new ActionRowBuilder().addComponents(menu)] }, true);
    }

    if (action === 'close') {
      if (!isTester(i.member) && i.user.id !== ticket.user_id) return fail(i, 'Bu ticketi sadece tester veya ticket sahibi kapatabilir.');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk|confirm').setLabel('Evet, kapat').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tk|cancel').setLabel('Vazgec').setStyle(ButtonStyle.Secondary)
      );
      return reply(i, { content: '🔒 Ticketi kapatmak istedigine emin misin?', components: [row] }, true);
    }

    if (action === 'confirm') {
      if (!isTester(i.member) && i.user.id !== ticket.user_id) return fail(i, 'Yetkin yok.');
      await i.update({ content: '🔒 Ticket 5 saniye icinde kapatiliyor...', components: [] });
      return closeTicket(i.channel, i.user, 'Buton ile kapatildi');
    }

    if (action === 'cancel') return i.update({ content: 'Islem iptal edildi.', components: [] });
  }
  return null;
}

async function handleSelect(i) {
  const [scope, action] = i.customId.split('|');
  if (scope !== 'tk') return null;

  // ---- mod secildi -> modal ac
  if (action === 'mode') {
    const modeId = i.values[0];
    if (!MODE_MAP[modeId]) return fail(i, 'Gecersiz mod.');
    const problem = checkTicketEligibility(i.user.id, modeId);
    if (problem) return fail(i, problem);

    const linked = Q.getPlayerByDiscord.get(i.user.id);
    const nickInput = new TextInputBuilder()
      .setCustomId('nick')
      .setLabel('Minecraft nickin')
      .setStyle(TextInputStyle.Short)
      .setMinLength(3)
      .setMaxLength(16)
      .setRequired(true);
    if (linked) nickInput.setValue(linked.display_nick);

    const regionInput = new TextInputBuilder()
      .setCustomId('region')
      .setLabel('Bolgen (EU, NA, AS, SA, AU, AF)')
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(2)
      .setRequired(true);
    if (linked && linked.region) regionInput.setValue(linked.region);

    const notesInput = new TextInputBuilder()
      .setCustomId('notes')
      .setLabel('Eklemek istedigin not (istege bagli)')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(500)
      .setRequired(false);

    const modal = new ModalBuilder()
      .setCustomId(`tk|modal|${modeId}`)
      .setTitle(`${MODE_MAP[modeId].name} Test Talebi`)
      .addComponents(
        new ActionRowBuilder().addComponents(nickInput),
        new ActionRowBuilder().addComponents(regionInput),
        new ActionRowBuilder().addComponents(notesInput)
      );
    return i.showModal(modal);
  }

  // ---- tier secildi -> sonuc ver
  if (action === 'tier') {
    const ticket = Q.ticketByChannel.get(i.channelId);
    if (!ticket || ticket.status !== 'open') return fail(i, 'Bu ticket artik aktif degil.');
    if (!isTester(i.member)) return fail(i, 'Bu islem icin tester yetkisi gerekir.');
    return giveTicketResult(i, ticket, i.values[0]);
  }
  return null;
}

async function handleModal(i) {
  const [scope, action, modeId] = i.customId.split('|');
  if (scope !== 'tk' || action !== 'modal') return null;
  if (!MODE_MAP[modeId]) return fail(i, 'Gecersiz mod.');

  const nick = i.fields.getTextInputValue('nick').trim();
  const region = i.fields.getTextInputValue('region').trim().toUpperCase();
  const notes = i.fields.getTextInputValue('notes').trim();

  if (!isValidNick(nick)) return fail(i, 'Gecersiz nick. Sadece harf, rakam ve alt cizgi kullanabilirsin (3-16).');
  if (!REGION_MAP[region]) return fail(i, `Gecersiz bolge. Gecerli degerler: ${REGIONS.map((r) => r.id).join(', ')}`);

  const problem = checkTicketEligibility(i.user.id, modeId);
  if (problem) return fail(i, problem);

  const linked = Q.getPlayerByDiscord.get(i.user.id);
  if (linked && linked.nick !== nick.toLowerCase()) {
    return fail(i, `Hesabin **${linked.display_nick}** nickine bagli. Farkli nick icin once \`/hesap sil\` kullan.`);
  }
  const owner = Q.getPlayer.get(nick.toLowerCase());
  if (owner && owner.discord_id && owner.discord_id !== i.user.id) {
    return fail(i, 'Bu nick baska bir Discord hesabina bagli.');
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  let finalNick = nick;
  let uuid = null;
  if (!linked) {
    const check = await fetchMojang(nick);
    if (check.status === 'notfound' && CONFIG.requirePremium) {
      return fail(i, 'Bu nick Mojang kayitlarinda bulunamadi. Sadece orijinal hesaplar kabul ediliyor.');
    }
    if (check.status === 'ok') {
      finalNick = check.name;
      uuid = check.uuid;
    }
  }
  ensurePlayer(finalNick, { discord_id: i.user.id, uuid, region, display_nick: finalNick });

  const channel = await createTicket(i, modeId, finalNick, region, notes);
  return reply(i, { embeds: [okEmbed(`Test ticketin olusturuldu: ${channel}`)] });
}

// ============================================================================
// 19) ETKILESIM YONLENDIRICI
// ============================================================================
const lastUse = new Map();

async function handleCommand(i) {
  const last = lastUse.get(i.user.id) || 0;
  if (Date.now() - last < 1500) return fail(i, 'Cok hizli komut kullaniyorsun, biraz yavasla.');
  lastUse.set(i.user.id, Date.now());

  const handler = handlers[i.commandName];
  if (!handler) return fail(i, 'Bilinmeyen komut.');
  return handler(i);
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.guild) return;
    if (i.isAutocomplete()) return await handleAutocomplete(i);
    if (i.isChatInputCommand()) return await handleCommand(i);
    if (i.isUserContextMenuCommand()) return await handleContext(i);
    if (i.isButton()) return await handleButton(i);
    if (i.isStringSelectMenu()) return await handleSelect(i);
    if (i.isModalSubmit()) return await handleModal(i);
  } catch (err) {
    log('ERROR', 'Etkilesim hatasi:', err);
    if (i.isAutocomplete && i.isAutocomplete()) return;
    const payload = { embeds: [errEmbed('Beklenmeyen bir hata olustu. Lutfen daha sonra tekrar dene.')] };
    try {
      if (i.deferred || i.replied) await i.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      else if (i.isRepliable()) await i.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (_) {
      /* son care: sessiz gec */
    }
  }
});

// ============================================================================
// 20) OLAYLAR
// ============================================================================
client.once(Events.ClientReady, async (c) => {
  log('INFO', `Giris yapildi: ${c.user.tag} (${c.guilds.cache.size} sunucu)`);
  try {
    await registerCommands();
  } catch (e) {
    log('ERROR', 'Komutlar kaydedilemedi:', e);
  }
  for (const m of MODES) refreshQueuePanel(m.id);
  startSchedulers();
});

// Sunucudan ayrilan uyenin kuyruk ve ticket kayitlarini temizle
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    Q.queueRemoveAll.run(member.id);
    for (const m of MODES) refreshQueuePanel(m.id);
    const ticket = Q.ticketOpenByUser.get(member.id);
    if (ticket) {
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      if (channel) await closeTicket(channel, 'Sistem (oyuncu sunucudan ayrildi)', 'Oyuncu sunucudan ayrildi');
    }
  } catch (e) {
    log('WARN', 'Uye ayrilma islemi hatasi:', e.message);
  }
});

// Ticket kanali elle silinirse kaydi kapat
client.on(Events.ChannelDelete, (channel) => {
  const ticket = Q.ticketByChannel.get(channel.id);
  if (ticket && ticket.status === 'open') {
    Q.ticketClose.run(nowSec(), channel.id);
    queueLeave(ticket.mode, ticket.user_id);
    refreshQueuePanel(ticket.mode);
  }
});

client.on(Events.Error, (e) => log('ERROR', 'Client hatasi:', e));
client.on(Events.Warn, (w) => log('WARN', w));

// ============================================================================
// 21) ZAMANLAYICILAR
// ============================================================================
let presenceIndex = 0;

function updatePresence() {
  const statuses = [
    { name: `${Q.countPlayers.get().c} oyuncu`, type: ActivityType.Watching },
    { name: `${Q.queueCountAll.get().c} kisi kuyrukta`, type: ActivityType.Watching },
    { name: '/yardim · Tier testleri', type: ActivityType.Playing },
  ];
  const s = statuses[presenceIndex % statuses.length];
  presenceIndex += 1;
  client.user.setPresence({ activities: [s], status: 'online' });
}

async function cleanStaleTickets() {
  const limit = nowSec() - CONFIG.ticketMaxHours * 3600;
  for (const ticket of Q.ticketsStale.all(limit)) {
    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    if (channel) {
      await closeTicket(channel, 'Sistem (zaman asimi)', `${CONFIG.ticketMaxHours} saat icinde tamamlanmadi`);
    } else {
      Q.ticketClose.run(nowSec(), ticket.channel_id);
      queueLeave(ticket.mode, ticket.user_id);
    }
  }
}

async function backupDatabase() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(CONFIG.dataDir, 'backups', `mctier-${stamp}.db`);
    await db.backup(file);
    const files = fs
      .readdirSync(path.join(CONFIG.dataDir, 'backups'))
      .filter((f) => f.endsWith('.db'))
      .sort();
    while (files.length > 10) fs.unlinkSync(path.join(CONFIG.dataDir, 'backups', files.shift()));
    log('INFO', `Veritabani yedeklendi: ${path.basename(file)}`);
  } catch (e) {
    log('ERROR', 'Yedekleme hatasi:', e);
  }
}

function startSchedulers() {
  updatePresence();
  setInterval(updatePresence, 30 * 1000);
  setInterval(() => cleanStaleTickets().catch((e) => log('ERROR', e)), 30 * 60 * 1000);
  setInterval(backupDatabase, CONFIG.backupHours * 3600 * 1000);
  setInterval(() => {
    const cutoff = Date.now() - 60 * 1000;
    for (const [id, t] of lastUse) if (t < cutoff) lastUse.delete(id);
  }, 10 * 60 * 1000);
}

// ============================================================================
// 22) HATA YAKALAMA VE KAPANIS
// ============================================================================
process.on('unhandledRejection', (reason) => log('ERROR', 'Yakalanmayan promise hatasi:', reason));
process.on('uncaughtException', (err) => log('ERROR', 'Yakalanmayan hata:', err));

function shutdown(signal) {
  log('INFO', `${signal} alindi, bot kapatiliyor...`);
  try {
    client.destroy();
    db.close();
  } catch (_) {
    /* kapanis sirasinda hata onemsiz */
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================================================
// 23) BASLAT
// ============================================================================
client.login(CONFIG.token).catch((e) => {
  log('ERROR', 'Giris basarisiz. Token dogru mu?', e);
  process.exit(1);
});
