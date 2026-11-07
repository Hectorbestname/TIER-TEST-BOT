require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  REST,
  Routes,
  PermissionsBitField,
  ChannelType,
  MessageFlags,
  Colors,
  Events,
} = require('discord.js');

// ============================================================
// HARLEM TIER LIST - PvP Tier Test / WAITLIST / Queue Bot
// Node.js 22 + discord.js 14.27 + better-sqlite3
// ============================================================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'harlem-tierlist.sqlite');
const RED = 0xD71920;
const WHITE = 0xFFFFFF;
const FOOTER = 'HARLEM TIER LIST';

const KITS = {
  netpot: { name: 'NETPOT', role: 'NETPOT WAITLIST' },
  sword: { name: 'SWORD', role: 'SWORD WAITLIST' },
  smp: { name: 'SMP', role: 'SMP WAITLIST' },
  cpvp: { name: 'CPVP', role: 'CPVP WAITLIST' },
  mace: { name: 'MACE', role: 'MACE WAITLIST' },
  axe: { name: 'AXE', role: 'AXE WAITLIST' },
  uhc: { name: 'UHC', role: 'UHC WAITLIST' },
};
const KIT_CHOICES = Object.entries(KITS).map(([value, kit]) => ({ name: kit.name, value }));
const ALL_KIT_CHOICES = [{ name: 'TÜM KİTLER', value: 'all' }, ...KIT_CHOICES];

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Eksik ortam değişkeni. TOKEN, CLIENT_ID ve GUILD_ID zorunludur.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    guild_id TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    PRIMARY KEY (guild_id, setting_key)
  );

  CREATE TABLE IF NOT EXISTS access_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id, role_type)
  );

  CREATE TABLE IF NOT EXISTS tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kit TEXT NOT NULL,
    mc_name TEXT COLLATE NOCASE NOT NULL,
    discord_id TEXT,
    discord_tag TEXT,
    tier TEXT NOT NULL,
    tester_id TEXT NOT NULL,
    tester_tag TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (guild_id, kit, mc_name)
  );

  CREATE TABLE IF NOT EXISTS tier_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kit TEXT NOT NULL,
    mc_name TEXT COLLATE NOCASE NOT NULL,
    discord_id TEXT,
    discord_tag TEXT,
    old_tier TEXT,
    new_tier TEXT,
    action TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    staff_tag TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS queues (
    guild_id TEXT NOT NULL,
    kit TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    owner_id TEXT NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, kit)
  );

  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kit TEXT NOT NULL,
    user_id TEXT NOT NULL,
    discord_tag TEXT NOT NULL,
    mc_name TEXT COLLATE NOCASE NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (guild_id, kit, user_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS queue_unique_mc
  ON queue_entries (guild_id, kit, mc_name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS test_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kit TEXT NOT NULL,
    mc_name TEXT COLLATE NOCASE NOT NULL,
    discord_id TEXT,
    tester_id TEXT NOT NULL,
    tester_tag TEXT NOT NULL,
    status TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    result_tier TEXT,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tiers_player ON tiers (guild_id, mc_name);
  CREATE INDEX IF NOT EXISTS idx_history_player ON tier_history (guild_id, mc_name, created_at);
  CREATE INDEX IF NOT EXISTS idx_history_staff ON tier_history (guild_id, staff_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON test_sessions (guild_id, status, start_at);
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

const nowISO = () => new Date().toISOString();
const shortDate = (value) => {
  if (!value) return 'Bilinmiyor';
  const timestamp = Math.floor(new Date(value).getTime() / 1000);
  return Number.isFinite(timestamp) ? `<t:${timestamp}:f>` : 'Bilinmiyor';
};
const relativeDate = (value) => {
  if (!value) return 'Bilinmiyor';
  const timestamp = Math.floor(new Date(value).getTime() / 1000);
  return Number.isFinite(timestamp) ? `<t:${timestamp}:R>` : 'Bilinmiyor';
};
const truncate = (value, max = 900) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};
const safeName = (value) => String(value || '').replace(/[`@<>]/g, '').trim();
const validMinecraftName = (value) => /^[A-Za-z0-9_]{3,16}$/.test(value);
const getKit = (kitId) => KITS[kitId] || null;

function getSetting(guildId, key, fallback = null) {
  const row = db.prepare('SELECT setting_value FROM settings WHERE guild_id = ? AND setting_key = ?').get(guildId, key);
  return row ? row.setting_value : fallback;
}

function setSetting(guildId, key, value) {
  db.prepare(`
    INSERT INTO settings (guild_id, setting_key, setting_value)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `).run(guildId, key, String(value));
}

function getAccessRoles(guildId, type) {
  return db.prepare('SELECT role_id FROM access_roles WHERE guild_id = ? AND role_type = ?')
    .all(guildId, type).map((row) => row.role_id);
}

function memberRoleIds(member) {
  if (member?.roles?.cache) return [...member.roles.cache.keys()];
  if (Array.isArray(member?.roles)) return member.roles;
  return [];
}

function hasAnyRole(interaction, roleIds) {
  const current = new Set(memberRoleIds(interaction.member));
  return roleIds.some((roleId) => current.has(roleId));
}

function isManager(interaction) {
  const permissions = interaction.memberPermissions;
  if (permissions?.has(PermissionsBitField.Flags.Administrator) ||
      permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  return hasAnyRole(interaction, getAccessRoles(interaction.guildId, 'manager'));
}

function isTester(interaction) {
  if (isManager(interaction)) return true;
  return hasAnyRole(interaction, getAccessRoles(interaction.guildId, 'tester'));
}

async function deny(interaction, message = 'Bu komutu kullanmak için yetkin yok.') {
  const payload = { content: message, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

async function requireTester(interaction) {
  if (isTester(interaction)) return true;
  await deny(interaction, 'Bu işlem tester veya yönetici yetkisi gerektiriyor.');
  return false;
}

async function requireManager(interaction) {
  if (isManager(interaction)) return true;
  await deny(interaction, 'Bu işlem yönetici yetkisi gerektiriyor.');
  return false;
}

function baseEmbed(title, description = null) {
  const embed = new EmbedBuilder().setColor(RED).setTitle(title).setFooter({ text: FOOTER }).setTimestamp();
  if (description) embed.setDescription(description);
  return embed;
}

function getTierRow(guildId, kit, mcName) {
  return db.prepare(`SELECT * FROM tiers WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE`)
    .get(guildId, kit, mcName);
}

function addHistory({ guildId, kit, mcName, discordId, discordTag, oldTier, newTier, action, staffId, staffTag, reason }) {
  db.prepare(`
    INSERT INTO tier_history
    (guild_id, kit, mc_name, discord_id, discord_tag, old_tier, new_tier, action, staff_id, staff_tag, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, kit, mcName, discordId || null, discordTag || null,
    oldTier || null, newTier || null, action, staffId, staffTag,
    reason || null, nowISO(),
  );
}

function tierResultEmbed({ mcName, kit, oldTier, newTier, discordId, testerTag, reason, action = 'TIER TEST RESULT' }) {
  const embed = baseEmbed(action, `**${safeName(mcName)}** oyuncusunun ${kit.toUpperCase()} test kaydı güncellendi.`);
  embed.addFields(
    { name: 'PLAYER', value: `\`${safeName(mcName)}\``, inline: true },
    { name: 'KIT', value: kit.toUpperCase(), inline: true },
    { name: 'DISCORD', value: discordId ? `<@${discordId}>` : 'Bağlanmadı', inline: true },
    { name: 'PREVIOUS TIER', value: oldTier || 'Yok', inline: true },
    { name: 'NEW TIER', value: newTier || 'Silindi', inline: true },
    { name: 'TESTER', value: testerTag || 'Bilinmiyor', inline: true },
    { name: 'NOTE', value: truncate(reason || 'Belirtilmedi', 900), inline: false },
  );
  return embed;
}

function tierLogEmbed({ mcName, kit, oldTier, newTier, discordId, staffTag, staffId, reason, action }) {
  const embed = baseEmbed('TIER DATABASE LOG', `İşlem: **${action}**`);
  embed.addFields(
    { name: 'PLAYER', value: `\`${safeName(mcName)}\``, inline: true },
    { name: 'KIT', value: kit.toUpperCase(), inline: true },
    { name: 'DISCORD', value: discordId ? `<@${discordId}>` : 'Bağlanmadı', inline: true },
    { name: 'OLD TIER', value: oldTier || 'Yok', inline: true },
    { name: 'NEW TIER', value: newTier || 'Silindi', inline: true },
    { name: 'STAFF', value: `${staffTag} (${staffId})`, inline: false },
    { name: 'NOTE', value: truncate(reason || 'Belirtilmedi', 900), inline: false },
  );
  return embed;
}

async function sendToConfiguredChannel(guildId, settingKey, fallbackChannel, payload) {
  const channelId = getSetting(guildId, settingKey);
  let channel = null;
  if (channelId) channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') channel = fallbackChannel;
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;
  await channel.send(payload);
  return true;
}

async function sendTierLog(guildId, embed) {
  const channelId = getSetting(guildId, 'log_channel_id');
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;
  await channel.send({ embeds: [embed] });
  return true;
}

function waitlistEmbed() {
  const embed = new EmbedBuilder()
    .setColor(WHITE)
    .setTitle('WAITLIST')
    .setDescription('WAITLIST almak istiyorsanız seçin.')
    .addFields({
            name: 'KIT SELECTION',
      value: 'Test olmak istediğin kitin rolünü aşağıdaki menüden seç. Aynı kiti tekrar seçersen rolün kaldırılır.',
    })
    .setFooter({ text: FOOTER });
  return embed;
}

function waitlistComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('waitlist:select')
    .setPlaceholder('Bir kit seç')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Object.entries(KITS).map(([value, kit]) => ({
      label: kit.name,
      value,
      description: `${kit.name} WAITLIST rolünü al veya kaldır`,
      emoji: { name: '⚪' },
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function queueEntries(guildId, kit) {
  return db.prepare(`
    SELECT * FROM queue_entries WHERE guild_id = ? AND kit = ? ORDER BY id ASC
  `).all(guildId, kit);
}

function queueEmbed(guildId, kit) {
  const kitData = getKit(kit);
  const queue = db.prepare('SELECT * FROM queues WHERE guild_id = ? AND kit = ?').get(guildId, kit);
  const entries = queueEntries(guildId, kit);
  const open = Boolean(queue?.is_open);
  const lines = entries.slice(0, 15).map((entry, index) =>
    `**${index + 1}.** \`${safeName(entry.mc_name)}\` — <@${entry.user_id}>`,
  );
  if (entries.length > 15) lines.push(`+ ${entries.length - 15} oyuncu daha`);
  const embed = baseEmbed(`${kitData.name} TEST QUEUE`,
    `Durum: **${open ? 'AÇIK' : 'KAPALI'}**\nSıradaki oyuncu sayısı: **${entries.length}**\n\nKatılmak için WAITLIST rolüne sahip olmalısın.`);
  embed.addFields({ name: `QUEUE LIST (${entries.length})`, value: lines.length ? lines.join('\n') : 'Kuyrukta henüz oyuncu yok.' });
  return embed;
}

function queueComponents(kit, isOpen) {
  const join = new ButtonBuilder().setCustomId(`queue:join:${kit}`).setLabel('Katıl').setStyle(ButtonStyle.Success);
  const leave = new ButtonBuilder().setCustomId(`queue:leave:${kit}`).setLabel('Ayrıl').setStyle(ButtonStyle.Secondary);
  const toggle = new ButtonBuilder()
    .setCustomId(`queue:toggle:${kit}`)
    .setLabel(isOpen ? 'Kuyruğu Kapat' : 'Kuyruğu Aç')
    .setStyle(isOpen ? ButtonStyle.Danger : ButtonStyle.Success);
  return [new ActionRowBuilder().addComponents(join, leave, toggle)];
}

async function refreshQueuePanel(guildId, kit) {
  const queue = db.prepare('SELECT * FROM queues WHERE guild_id = ? AND kit = ?').get(guildId, kit);
  if (!queue?.message_id) return;
  const channel = await client.channels.fetch(queue.channel_id).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages) return;
  const message = await channel.messages.fetch(queue.message_id).catch(() => null);
  if (!message) return;
  await message.edit({
    embeds: [queueEmbed(guildId, kit)],
    components: queueComponents(kit, Boolean(queue.is_open)),
  }).catch((error) => console.error('Kuyruk paneli güncellenemedi:', error.message));
}

async function getWaitlistRole(guild, kit) {
  const kitData = getKit(kit);
  if (!kitData) return null;
  return guild.roles.cache.find((role) => role.name === kitData.role) || null;
}

async function createWaitlistRoles(guild) {
  const created = [];
  const existing = [];
  for (const kit of Object.values(KITS)) {
    let role = guild.roles.cache.find((item) => item.name === kit.role);
    if (!role) {
      role = await guild.roles.create({
        name: kit.role,
        color: WHITE,
        hoist: false,
        mentionable: false,
        permissions: [],
        reason: 'HARLEM TIER LIST WAITLIST kurulumu',
      });
      created.push(role.name);
    } else {
      existing.push(role.name);
    }
  }
  return { created, existing };
}

function addQueueEntry(guildId, kit, userId, discordTag, mcName) {
  db.prepare(`
    INSERT INTO queue_entries (guild_id, kit, user_id, discord_tag, mc_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, kit, userId, discordTag, mcName, nowISO());
}

function makeWaitlistResetKitOption(option) {
  option.setName('kit').setDescription('Sıfırlanacak kit veya tüm kitler').setRequired(true);
  option.addChoices(...ALL_KIT_CHOICES);
  return option;
}

function makeKitOption(option, required = true) {
  option.setName('kit').setDescription('İşlem yapılacak kit').setRequired(required);
  option.addChoices(...KIT_CHOICES);
  return option;
}

function buildCommands() {
  const tier = new SlashCommandBuilder().setName('tier').setDescription('Tier kayıtlarını ve test sonuçlarını yönetir')
    .addSubcommand((s) => s.setName('ver').setDescription('Oyuncuya tier ver veya güncelle')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('yeni_tier').setDescription('Verilecek tier (örnek: HT1, LT2)').setRequired(true).setMaxLength(30))
      .addUserOption((o) => o.setName('discord').setDescription('Oyuncunun Discord hesabı'))
      .addStringOption((o) => o.setName('sebep').setDescription('Test notu veya açıklama').setMaxLength(500)))
    .addSubcommand((s) => s.setName('bak').setDescription('Oyuncunun mevcut tierlerini gösterir')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o, false)))
    .addSubcommand((s) => s.setName('sil').setDescription('Oyuncunun seçilen kitteki tierini siler')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('sebep').setDescription('Silme nedeni').setMaxLength(500)))
    .addSubcommand((s) => s.setName('duzenle').setDescription('Mevcut tier kaydını düzeltir')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('yeni_tier').setDescription('Doğru tier').setRequired(true).setMaxLength(30))
      .addStringOption((o) => o.setName('sebep').setDescription('Düzeltme açıklaması').setMaxLength(500)))
    .addSubcommand((s) => s.setName('log').setDescription('Son tier işlemlerini listeler')
      .addStringOption((o) => makeKitOption(o, false))
      .addUserOption((o) => o.setName('tester').setDescription('Tester filtresi'))
      .addIntegerOption((o) => o.setName('adet').setDescription('Gösterilecek kayıt sayısı').setMinValue(1).setMaxValue(15)))
    .addSubcommand((s) => s.setName('gecmis').setDescription('Bir oyuncunun tier geçmişini gösterir')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16)))
    .addSubcommand((s) => s.setName('liste').setDescription('Bir kitin tier listesini gösterir')
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('tier').setDescription('İsteğe bağlı tier filtresi').setMaxLength(30))
      .addIntegerOption((o) => o.setName('sayfa').setDescription('Sayfa numarası').setMinValue(1).setMaxValue(1000)))
    .addSubcommand((s) => s.setName('istatistik').setDescription('Kitlerin tier ve test istatistiklerini gösterir'))
    .addSubcommand((s) => s.setName('tester').setDescription('Bir testerın test performansını gösterir')
      .addUserOption((o) => o.setName('uye').setDescription('İstatistiği gösterilecek tester')))
    .addSubcommand((s) => s.setName('sifirla').setDescription('Oyuncunun tüm tier kayıtlarını siler')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addBooleanOption((o) => o.setName('onay').setDescription('Bu oyuncunun bütün tierlerini silmeyi onayla').setRequired(true)))
    .addSubcommand((s) => s.setName('aktar').setDescription('Tier veritabanını CSV olarak dışa aktarır')
      .addStringOption((o) => makeKitOption(o, false)));

  const waitlist = new SlashCommandBuilder().setName('waitlist').setDescription('WAITLIST rollerini ve panelini yönetir')
    .addSubcommand((s) => s.setName('kur').setDescription('Yedi kitin WAITLIST rollerini oluşturur'))
    .addSubcommand((s) => s.setName('panel').setDescription('WAITLIST seçim panelini bu kanala gönderir'))
    .addSubcommand((s) => s.setName('kontrol').setDescription('WAITLIST rollerinin üye sayılarını gösterir'))
    .addSubcommand((s) => s.setName('sifirla').setDescription('Bir kitin veya tüm kitlerin WAITLIST rollerini kaldırır')
      .addStringOption((o) => makeWaitlistResetKitOption(o))
      .addBooleanOption((o) => o.setName('onay').setDescription('Üyelerin rollerini kaldırmayı onayla').setRequired(true)));

  const queue = new SlashCommandBuilder().setName('kuyruk').setDescription('Kit bazlı test kuyruklarını yönetir')
    .addSubcommand((s) => s.setName('netpot').setDescription('Bu kanalda NETPOT kuyruğu kurar'))
    .addSubcommand((s) => s.setName('sword').setDescription('Bu kanalda SWORD kuyruğu kurar'))
    .addSubcommand((s) => s.setName('smp').setDescription('Bu kanalda SMP kuyruğu kurar'))
    .addSubcommand((s) => s.setName('cpvp').setDescription('Bu kanalda CPVP kuyruğu kurar'))
    .addSubcommand((s) => s.setName('mace').setDescription('Bu kanalda MACE kuyruğu kurar'))
    .addSubcommand((s) => s.setName('axe').setDescription('Bu kanalda AXE kuyruğu kurar'))
    .addSubcommand((s) => s.setName('uhc').setDescription('Bu kanalda UHC kuyruğu kurar'))
    .addSubcommand((s) => s.setName('ac').setDescription('Bir kitin kuyruğunu açar')
      .addStringOption((o) => makeKitOption(o)))
    .addSubcommand((s) => s.setName('kapat').setDescription('Bir kitin kuyruğunu kapatır')
      .addStringOption((o) => makeKitOption(o)))
    .addSubcommand((s) => s.setName('durum').setDescription('Bir kitin kuyruk durumunu gösterir')
      .addStringOption((o) => makeKitOption(o)))
    .addSubcommand((s) => s.setName('liste').setDescription('Kuyruktaki oyuncuları gösterir')
      .addStringOption((o) => makeKitOption(o)))
    .addSubcommand((s) => s.setName('siradaki').setDescription('Kuyruktaki sıradaki oyuncuyu gösterir')
      .addStringOption((o) => makeKitOption(o)))
    .addSubcommand((s) => s.setName('cikar').setDescription('Oyuncuyu kuyruktan çıkarır')
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16)))
    .addSubcommand((s) => s.setName('temizle').setDescription('Seçilen kitin kuyruğunu boşaltır')
      .addStringOption((o) => makeKitOption(o))
      .addBooleanOption((o) => o.setName('onay').setDescription('Kuyruğu boşaltmayı onayla').setRequired(true)))
    .addSubcommand((s) => s.setName('sil').setDescription('Kitin kuyruk panelini ve kayıtlarını siler')
      .addStringOption((o) => makeKitOption(o))
      .addBooleanOption((o) => o.setName('onay').setDescription('Kuyruğu silmeyi onayla').setRequired(true)));

  const test = new SlashCommandBuilder().setName('test').setDescription('Tier test oturumlarını yönetir')
    .addSubcommand((s) => s.setName('baslat').setDescription('Bir oyuncu için test oturumu başlatır')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o))
      .addUserOption((o) => o.setName('discord').setDescription('Oyuncunun Discord hesabı'))
      .addStringOption((o) => o.setName('not').setDescription('Test başlangıç notu').setMaxLength(500)))
    .addSubcommand((s) => s.setName('bitir').setDescription('Aktif test oturumunu bitirir')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('not').setDescription('Test bitiş notu').setMaxLength(500)))
    .addSubcommand((s) => s.setName('iptal').setDescription('Aktif test oturumunu iptal eder')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft kullanıcı adı').setRequired(true).setMaxLength(16))
      .addStringOption((o) => makeKitOption(o))
      .addStringOption((o) => o.setName('sebep').setDescription('İptal nedeni').setMaxLength(500)))
    .addSubcommand((s) => s.setName('aktif').setDescription('Aktif testleri listeler')
      .addUserOption((o) => o.setName('tester').setDescription('Tester filtresi')));

  const settings = new SlashCommandBuilder().setName('ayar').setDescription('Botun kanal ve yetki ayarlarını düzenler')
    .addSubcommand((s) => s.setName('sonuc').setDescription('Tier sonuç kanalını ayarlar')
      .addChannelOption((o) => o.setName('kanal').setDescription('Sonuçların gönderileceği kanal').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('log').setDescription('Tier log kanalını ayarlar')
      .addChannelOption((o) => o.setName('kanal').setDescription('Logların gönderileceği kanal').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) => s.setName('tester-rol').setDescription('Tester rolü ekler veya kaldırır')
      .addStringOption((o) => o.setName('islem').setDescription('Rol işlemi').setRequired(true).addChoices({ name: 'Ekle', value: 'add' }, { name: 'Kaldır', value: 'remove' }))
      .addRoleOption((o) => o.setName('rol').setDescription('Tester rolü').setRequired(true)))
    .addSubcommand((s) => s.setName('yetkili-rol').setDescription('Yönetici rolü ekler veya kaldırır')
      .addStringOption((o) => o.setName('islem').setDescription('Rol işlemi').setRequired(true).addChoices({ name: 'Ekle', value: 'add' }, { name: 'Kaldır', value: 'remove' }))
      .addRoleOption((o) => o.setName('rol').setDescription('Yönetici rolü').setRequired(true)))
    .addSubcommand((s) => s.setName('durum').setDescription('Mevcut bot ayarlarını gösterir'));

  const bot = new SlashCommandBuilder().setName('bot').setDescription('Bot bilgileri ve komut rehberi')
    .addSubcommand((s) => s.setName('ping').setDescription('Bot gecikmesini gösterir'))
    .addSubcommand((s) => s.setName('yardim').setDescription('Tüm komutların kısa rehberini gösterir'));

  return [tier, waitlist, queue, test, settings, bot].map((command) => command.toJSON());
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: buildCommands() });
  console.log('Slash komutları sunucuya yüklendi.');
}

async function handleWaitlistCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'kur') {
    if (!(await requireManager(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await createWaitlistRoles(interaction.guild);
    const lines = [
      `Oluşturulan roller: **${result.created.length}**`,
      `Zaten bulunan roller: **${result.existing.length}**`,
    ];
    if (result.created.length) lines.push(`Yeni: ${result.created.join(', ')}`);
    await interaction.editReply(lines.join('\n'));
    return;
  }

  if (sub === 'panel') {
    if (!(await requireManager(interaction))) return;
    if (!interaction.channel?.isTextBased?.() || typeof interaction.channel.send !== 'function') {
      return interaction.reply({ content: 'Bu komut bir yazı kanalında kullanılmalı.', flags: MessageFlags.Ephemeral });
    }
    await interaction.channel.send({ embeds: [waitlistEmbed()], components: waitlistComponents() });
    await interaction.reply({ content: 'WAITLIST paneli gönderildi.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'kontrol') {
    if (!(await requireTester(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await interaction.guild.members.fetch();
    } catch {
      return interaction.editReply('Üye listesi alınamadı. Developer Portal içinden **Server Members Intent** özelliğini aç.');
    }
    const lines = [];
    for (const [kitId, kit] of Object.entries(KITS)) {
      const role = await getWaitlistRole(interaction.guild, kitId);
      lines.push(`**${kit.name}:** ${role ? role.members.size : 'Rol oluşturulmamış'}`);
    }
    await interaction.editReply({ embeds: [baseEmbed('WAITLIST MEMBER COUNTS', lines.join('\n'))] });
    return;
  }

  if (sub === 'sifirla') {
    if (!(await requireManager(interaction))) return;
    const kitChoice = interaction.options.getString('kit', true);
    const confirmed = interaction.options.getBoolean('onay', true);
    if (!confirmed) return interaction.reply({ content: 'İşlem iptal edildi. Onay seçeneğini true yapmalısın.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await interaction.guild.members.fetch();
    } catch {
      return interaction.editReply('Üyeler alınamadı. Developer Portal içinden Server Members Intent özelliğini aç.');
    }
    const kits = kitChoice === 'all' ? Object.keys(KITS) : [kitChoice];
    let removed = 0;
    for (const kitId of kits) {
      const role = await getWaitlistRole(interaction.guild, kitId);
      if (!role) continue;
      for (const member of role.members.values()) {
        await member.roles.remove(role, 'WAITLIST sıfırlama işlemi').catch(() => null);
        db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ? AND user_id = ?')
          .run(interaction.guildId, kitId, member.id);
        removed += 1;
      }
      await refreshQueuePanel(interaction.guildId, kitId);
    }
    await interaction.editReply(`${kitChoice === 'all' ? 'Tüm kitler' : getKit(kitChoice).name} için **${removed}** WAITLIST rolü kaldırıldı.`);
    return;
  }
}

async function handleWaitlistSelect(interaction) {
  const kitId = interaction.values[0];
  const kit = getKit(kitId);
  if (!kit) return interaction.reply({ content: 'Geçersiz kit seçimi.', flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const role = await getWaitlistRole(interaction.guild, kitId);
  if (!role) return interaction.editReply(`WAITLIST rolü bulunamadı. Önce bir yönetici /waitlist kur komutunu kullanmalı.`);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.editReply('Discord üye bilgisi alınamadı.');
  if (member.roles.cache.has(role.id)) {
    await member.roles.remove(role, 'WAITLIST rolü kullanıcı tarafından kaldırıldı');
    db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ? AND user_id = ?')
      .run(interaction.guildId, kitId, interaction.user.id);
    await refreshQueuePanel(interaction.guildId, kitId);
    await interaction.editReply(`${kit.name} WAITLIST rolün kaldırıldı. Bu kitin kuyruğundaysan kaydın da silindi.`);
  } else {
    await member.roles.add(role, 'WAITLIST rolü kullanıcı tarafından alındı');
    await interaction.editReply(`${kit.name} WAITLIST rolün verildi. Artık ${kit.name} test kanalına erişebilirsin.`);
      }
}

async function createQueuePanel(interaction, kitId) {
  if (!(await requireTester(interaction))) return;
  const kit = getKit(kitId);
  if (!kit) return interaction.reply({ content: 'Geçersiz kit.', flags: MessageFlags.Ephemeral });
  const oldQueue = db.prepare('SELECT * FROM queues WHERE guild_id = ? AND kit = ?').get(interaction.guildId, kitId);
  if (oldQueue) {
    return interaction.reply({
      content: `Bu kitin kuyruğu zaten kurulmuş: <#${oldQueue.channel_id}>. Yeniden kurmak için önce /kuyruk sil komutunu kullan.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!interaction.channel?.isTextBased?.() || typeof interaction.channel.send !== 'function') {
    return interaction.reply({ content: 'Kuyruk bir yazı kanalında kurulmalı.', flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const timestamp = nowISO();
  db.prepare(`INSERT INTO queues (guild_id, kit, channel_id, message_id, owner_id, is_open, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 1, ?, ?)`)
    .run(interaction.guildId, kitId, interaction.channelId, interaction.user.id, timestamp, timestamp);
  try {
    const message = await interaction.channel.send({
      embeds: [queueEmbed(interaction.guildId, kitId)],
      components: queueComponents(kitId, true),
    });
    db.prepare('UPDATE queues SET message_id = ? WHERE guild_id = ? AND kit = ?')
      .run(message.id, interaction.guildId, kitId);
    await interaction.editReply(`${kit.name} kuyruğu bu kanalda kuruldu.`);
  } catch (error) {
    db.prepare('DELETE FROM queues WHERE guild_id = ? AND kit = ?').run(interaction.guildId, kitId);
    console.error(error);
    await interaction.editReply('Kuyruk paneli gönderilemedi. Botun kanalda mesaj gönderme ve embed kullanma iznini kontrol et.');
  }
}

async function handleQueueCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (KITS[sub]) return createQueuePanel(interaction, sub);
  const kitId = interaction.options.getString('kit', true);
  const kit = getKit(kitId);
  const queue = db.prepare('SELECT * FROM queues WHERE guild_id = ? AND kit = ?').get(interaction.guildId, kitId);

  if (sub === 'durum') {
    if (!queue) return interaction.reply({ content: `${kit.name} kuyruğu henüz kurulmamış.`, flags: MessageFlags.Ephemeral });
    return interaction.reply({ embeds: [queueEmbed(interaction.guildId, kitId)], flags: MessageFlags.Ephemeral });
  }

  if (!(await requireTester(interaction))) return;
  if (!queue) return interaction.reply({ content: `${kit.name} kuyruğu yok. Önce ilgili kanalda /kuyruk ${kitId} kullan.`, flags: MessageFlags.Ephemeral });

  if (sub === 'ac' || sub === 'kapat') {
    const open = sub === 'ac' ? 1 : 0;
    db.prepare('UPDATE queues SET is_open = ?, updated_at = ? WHERE guild_id = ? AND kit = ?')
      .run(open, nowISO(), interaction.guildId, kitId);
    await refreshQueuePanel(interaction.guildId, kitId);
    return interaction.reply({ content: `${kit.name} kuyruğu ${open ? 'açıldı' : 'kapatıldı'}.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'liste') {
    const entries = queueEntries(interaction.guildId, kitId);
    const lines = entries.slice(0, 25).map((entry, index) =>
      `**${index + 1}.** \`${safeName(entry.mc_name)}\` — <@${entry.user_id}>`,
    );
    const embed = baseEmbed(`${kit.name} QUEUE LIST`, lines.length ? lines.join('\n') : 'Kuyruk boş.');
    embed.setFooter({ text: `${FOOTER} • Toplam: ${entries.length}` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'siradaki') {
    const first = queueEntries(interaction.guildId, kitId)[0];
    return interaction.reply({
      content: first ? `Sıradaki ${kit.name} oyuncusu: **${safeName(first.mc_name)}** — <@${first.user_id}>` : `${kit.name} kuyruğu boş.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'cikar') {
    const mcName = interaction.options.getString('oyuncu', true).trim();
    const result = db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE')
      .run(interaction.guildId, kitId, mcName);
    await refreshQueuePanel(interaction.guildId, kitId);
    return interaction.reply({ content: result.changes ? `${mcName} ${kit.name} kuyruğundan çıkarıldı.` : `${mcName} kuyrukta bulunamadı.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'temizle') {
    if (!interaction.options.getBoolean('onay', true)) {
      return interaction.reply({ content: 'İşlem iptal edildi. Onay seçeneğini true yapmalısın.', flags: MessageFlags.Ephemeral });
    }
    const result = db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ?').run(interaction.guildId, kitId);
    await refreshQueuePanel(interaction.guildId, kitId);
    return interaction.reply({ content: `${kit.name} kuyruğundan ${result.changes} kayıt silindi.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'sil') {
    if (!(await requireManager(interaction))) return;
    if (!interaction.options.getBoolean('onay', true)) {
      return interaction.reply({ content: 'İşlem iptal edildi. Onay seçeneğini true yapmalısın.', flags: MessageFlags.Ephemeral });
    }
    const channel = await client.channels.fetch(queue.channel_id).catch(() => null);
    if (channel?.isTextBased?.() && channel.messages && queue.message_id) {
      const message = await channel.messages.fetch(queue.message_id).catch(() => null);
      if (message) await message.delete().catch(() => null);
    }
    db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ?').run(interaction.guildId, kitId);
    db.prepare('DELETE FROM queues WHERE guild_id = ? AND kit = ?').run(interaction.guildId, kitId);
    return interaction.reply({ content: `${kit.name} kuyruk paneli ve kayıtları silindi.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleQueueButton(interaction) {
  const [, action, kitId] = interaction.customId.split(':');
  const kit = getKit(kitId);
  if (!kit) return interaction.reply({ content: 'Bu kuyruk artık geçerli değil.', flags: MessageFlags.Ephemeral });
  const queue = db.prepare('SELECT * FROM queues WHERE guild_id = ? AND kit = ?').get(interaction.guildId, kitId);
  if (!queue) return interaction.reply({ content: 'Bu kuyruk silinmiş.', flags: MessageFlags.Ephemeral });

  if (action === 'toggle') {
    if (interaction.user.id !== queue.owner_id) {
      return interaction.reply({ content: 'Bu düğmeyi yalnızca kuyruğu kuran kişi kullanabilir.', flags: MessageFlags.Ephemeral });
    }
    const nextOpen = queue.is_open ? 0 : 1;
    db.prepare('UPDATE queues SET is_open = ?, updated_at = ? WHERE guild_id = ? AND kit = ?')
      .run(nextOpen, nowISO(), interaction.guildId, kitId);
    return interaction.update({ embeds: [queueEmbed(interaction.guildId, kitId)], components: queueComponents(kitId, Boolean(nextOpen)) });
  }

  if (action === 'join') {
    if (!queue.is_open) return interaction.reply({ content: 'Bu kitin kuyruğu şu anda kapalı.', flags: MessageFlags.Ephemeral });
    const role = await getWaitlistRole(interaction.guild, kitId);
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!role || !member?.roles.cache.has(role.id)) {
      return interaction.reply({ content: `${kit.name} kuyruğuna katılmak için önce WAITLIST panelinden ${kit.name} rolünü almalısın.`, flags: MessageFlags.Ephemeral });
    }
    const existing = db.prepare('SELECT id FROM queue_entries WHERE guild_id = ? AND kit = ? AND user_id = ?')
      .get(interaction.guildId, kitId, interaction.user.id);
    if (existing) return interaction.reply({ content: 'Bu kitin kuyruğunda zaten varsın.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId(`queue-modal:${kitId}`).setTitle(`${kit.name} QUEUE`);
    const input = new TextInputBuilder()
      .setCustomId('mc_name')
      .setLabel('Minecraft kullanıcı adın')
      .setPlaceholder('Örnek: ItzRealJust')
      .setStyle(TextInputStyle.Short)
      .setMinLength(3)
      .setMaxLength(16)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (action === 'leave') {
    const result = db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ? AND user_id = ?')
      .run(interaction.guildId, kitId, interaction.user.id);
    await refreshQueuePanel(interaction.guildId, kitId);
    return interaction.reply({
      content: result.changes ? `${kit.name} kuyruğundan ayrıldın.` : 'Bu kuyruğa kayıtlı değilsin.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleQueueModal(interaction) {
  const kitId = interaction.customId.split(':')[1];
  const kit = getKit(kitId);
  const mcName = interaction.fields.getTextInputValue('mc_name').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!kit) return interaction.editReply('Geçersiz kit.');
  if (!validMinecraftName(mcName)) return interaction.editReply('Minecraft kullanıcı adı 3-16 karakter olmalı; yalnızca harf, rakam ve alt çizgi kullanılabilir.');
  const queue = db.prepare('SELECT * FROM queues WHERE guild_id = ? AND kit = ?').get(interaction.guildId, kitId);
  if (!queue || !queue.is_open) return interaction.editReply('Bu kitin kuyruğu şu anda kapalı veya silinmiş.');
  const role = await getWaitlistRole(interaction.guild, kitId);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!role || !member?.roles.cache.has(role.id)) return interaction.editReply(`${kit.name} WAITLIST rolün bulunmuyor. Önce WAITLIST panelinden rol al.`);
  try {
    addQueueEntry(interaction.guildId, kitId, interaction.user.id, interaction.user.tag, mcName);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return interaction.editReply('Bu Discord hesabı veya Minecraft adı zaten bu kitin kuyruğunda.');
    }
    throw error;
  }
  await refreshQueuePanel(interaction.guildId, kitId);
  const position = queueEntries(interaction.guildId, kitId).findIndex((entry) => entry.user_id === interaction.user.id) + 1;
  await interaction.editReply(`${mcName} adıyla ${kit.name} kuyruğuna katıldın. Sıran: **${position}**.`);
}

async function handleTestCommand(interaction) {
  if (!(await requireTester(interaction))) return;
  const sub = interaction.options.getSubcommand();
  const mcName = interaction.options.getString('oyuncu');
  const kitId = interaction.options.getString('kit');
  const kit = kitId ? getKit(kitId) : null;

  if (sub === 'baslat') {
    if (!validMinecraftName(mcName)) return interaction.reply({ content: 'Geçerli bir Minecraft kullanıcı adı gir (3-16 karakter).', flags: MessageFlags.Ephemeral });
    const active = db.prepare(`SELECT * FROM test_sessions WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE AND status = 'active'`)
      .get(interaction.guildId, kitId, mcName);
    if (active) return interaction.reply({ content: `Bu oyuncunun ${kit.name} test oturumu zaten aktif. Testi başlatan: ${active.tester_tag}.`, flags: MessageFlags.Ephemeral });
    const discordUser = interaction.options.getUser('discord');
    const note = interaction.options.getString('not');
    const qEntry = db.prepare('SELECT id, user_id FROM queue_entries WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE')
      .get(interaction.guildId, kitId, mcName);
    db.prepare(`INSERT INTO test_sessions
      (guild_id, kit, mc_name, discord_id, tester_id, tester_tag, status, start_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
      .run(interaction.guildId, kitId, mcName, discordUser?.id || qEntry?.user_id || null, interaction.user.id, interaction.user.tag, nowISO(), note || null);
    if (qEntry) {
      db.prepare('DELETE FROM queue_entries WHERE id = ?').run(qEntry.id);
      await refreshQueuePanel(interaction.guildId, kitId);
    }
    return interaction.reply({ content: `${mcName} için ${kit.name} test oturumu başlatıldı.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'bitir' || sub === 'iptal') {
    const session = db.prepare(`SELECT * FROM test_sessions WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE AND status = 'active'`)
      .get(interaction.guildId, kitId, mcName);
    if (!session) return interaction.reply({ content: `${mcName} için aktif ${kit.name} test oturumu bulunamadı.`, flags: MessageFlags.Ephemeral });
    const status = sub === 'bitir' ? 'completed' : 'cancelled';
    const note = interaction.options.getString(sub === 'bitir' ? 'not' : 'sebep');
    db.prepare('UPDATE test_sessions SET status = ?, end_at = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run(status, nowISO(), note || null, session.id);
    return interaction.reply({ content: `${mcName} oyuncusunun ${kit.name} test oturumu ${sub === 'bitir' ? 'bitirildi' : 'iptal edildi'}.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'aktif') {
    const tester = interaction.options.getUser('tester');
    const sessions = tester
      ? db.prepare(`SELECT * FROM test_sessions WHERE guild_id = ? AND status = 'active' AND tester_id = ? ORDER BY start_at ASC LIMIT 20`).all(interaction.guildId, tester.id)
      : db.prepare(`SELECT * FROM test_sessions WHERE guild_id = ? AND status = 'active' ORDER BY start_at ASC LIMIT 20`).all(interaction.guildId);
    const lines = sessions.map((session, index) =>
      `**${index + 1}.** \`${safeName(session.mc_name)}\` — **${session.kit.toUpperCase()}** — <@${session.tester_id}> — ${relativeDate(session.start_at)}`,
    );
    const total = db.prepare(`SELECT COUNT(*) AS count FROM test_sessions WHERE guild_id = ? AND status = 'active'`).get(interaction.guildId).count;
    const embed = baseEmbed('ACTIVE TEST SESSIONS', lines.length ? lines.join('\n') : 'Aktif test oturumu yok.');
    embed.setFooter({ text: `${FOOTER} • Toplam aktif: ${total}` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

async function saveTier(interaction, { mcName, kitId, newTier, discordUser, reason, requireExisting = false }) {
  const old = getTierRow(interaction.guildId, kitId, mcName);
  if (requireExisting && !old) {
    return interaction.reply({ content: `${mcName} oyuncusunun ${kitId.toUpperCase()} tier kaydı bulunamadı.`, flags: MessageFlags.Ephemeral });
  }
  const queuedPlayer = db.prepare('SELECT user_id, discord_tag FROM queue_entries WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE')
    .get(interaction.guildId, kitId, mcName);
  const activeSession = db.prepare(`SELECT discord_id FROM test_sessions WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE AND status = 'active' ORDER BY id DESC LIMIT 1`)
    .get(interaction.guildId, kitId, mcName);
  const timestamp = nowISO();
  const discordId = discordUser?.id || old?.discord_id || queuedPlayer?.user_id || activeSession?.discord_id || null;
  const discordTag = discordUser?.tag || old?.discord_tag || queuedPlayer?.discord_tag || null;
  const action = old ? 'GUNCELLENDI' : 'VERILDI';
  db.prepare(`
    INSERT INTO tiers (guild_id, kit, mc_name, discord_id, discord_tag, tier, tester_id, tester_tag, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, kit, mc_name) DO UPDATE SET
      discord_id = excluded.discord_id,
      discord_tag = excluded.discord_tag,
      tier = excluded.tier,
      tester_id = excluded.tester_id,
      tester_tag = excluded.tester_tag,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).run(
    interaction.guildId, kitId, mcName, discordId, discordTag, newTier,
    interaction.user.id, interaction.user.tag, reason || null,
    old?.created_at || timestamp, timestamp,
  );
  addHistory({
    guildId: interaction.guildId, kit: kitId, mcName, discordId, discordTag,
    oldTier: old?.tier, newTier, action, staffId: interaction.user.id,
    staffTag: interaction.user.tag, reason,
  });
  db.prepare(`UPDATE test_sessions SET status = 'completed', end_at = ?, result_tier = ?
    WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE AND status = 'active'`)
    .run(timestamp, newTier, interaction.guildId, kitId, mcName);
  db.prepare('DELETE FROM queue_entries WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE')
    .run(interaction.guildId, kitId, mcName);
  await refreshQueuePanel(interaction.guildId, kitId);

  const resultEmbed = tierResultEmbed({
    mcName, kit: kitId, oldTier: old?.tier, newTier, discordId,
    testerTag: interaction.user.tag, reason, action: 'TIER TEST RESULT',
  });
  const sent = await sendToConfiguredChannel(interaction.guildId, 'result_channel_id', interaction.channel, { embeds: [resultEmbed] });
  const logEmbed = tierLogEmbed({
    mcName, kit: kitId, oldTier: old?.tier, newTier, discordId,
    staffTag: interaction.user.tag, staffId: interaction.user.id, reason, action,
  });
  await sendTierLog(interaction.guildId, logEmbed);
  return interaction.reply({
    content: `${mcName} oyuncusuna ${kitId.toUpperCase()} için **${newTier}** tieri ${old ? 'güncellendi' : 'verildi'}.${sent ? '' : ' Sonuç kanalı bulunamadığı için sonuç mesajı gönderilemedi; /ayar sonuc ile kanal ayarla.'}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTierCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (['ver', 'duzenle', 'sil', 'sifirla', 'aktar'].includes(sub)) {
    if (sub === 'duzenle' || sub === 'sil' || sub === 'sifirla' || sub === 'aktar') {
      if (!(await requireManager(interaction))) return;
    } else if (!(await requireTester(interaction))) return;
  }

  if (sub === 'ver' || sub === 'duzenle') {
    const mcName = interaction.options.getString('oyuncu', true).trim();
    const kitId = interaction.options.getString('kit', true);
    const newTier = interaction.options.getString('yeni_tier', true).trim();
    const discordUser = interaction.options.getUser('discord');
    const reason = interaction.options.getString('sebep');
    if (!validMinecraftName(mcName)) return interaction.reply({ content: 'Geçerli bir Minecraft kullanıcı adı gir (3-16 karakter).', flags: MessageFlags.Ephemeral });
    if (!newTier || newTier.length > 30) return interaction.reply({ content: 'Tier adı 1-30 karakter arasında olmalı.', flags: MessageFlags.Ephemeral });
    return saveTier(interaction, { mcName, kitId, newTier, discordUser, reason, requireExisting: sub === 'duzenle' });
  }

  if (sub === 'bak') {
    const mcName = interaction.options.getString('oyuncu', true).trim();
    const kitFilter = interaction.options.getString('kit');
    const rows = kitFilter
      ? db.prepare('SELECT * FROM tiers WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE').all(interaction.guildId, kitFilter, mcName)
      : db.prepare('SELECT * FROM tiers WHERE guild_id = ? AND mc_name = ? COLLATE NOCASE ORDER BY kit').all(interaction.guildId, mcName);
    if (!rows.length) return interaction.reply({ content: `${mcName} için kayıtlı tier bulunamadı.`, flags: MessageFlags.Ephemeral });
    const embed = baseEmbed(`PLAYER TIERS • ${safeName(mcName)}`);
    embed.addFields(rows.map((row) => ({ name: row.kit.toUpperCase(), value: `**${row.tier}**\nSon güncelleme: ${relativeDate(row.updated_at)}`, inline: true })));
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'sil') {
    const mcName = interaction.options.getString('oyuncu', true).trim();
    const kitId = interaction.options.getString('kit', true);
    const reason = interaction.options.getString('sebep') || 'Tier kaydı yönetici tarafından silindi.';
    const old = getTierRow(interaction.guildId, kitId, mcName);
    if (!old) return interaction.reply({ content: `${mcName} için ${kitId.toUpperCase()} tier kaydı bulunamadı.`, flags: MessageFlags.Ephemeral });
    db.prepare('DELETE FROM tiers WHERE guild_id = ? AND kit = ? AND mc_name = ? COLLATE NOCASE')
      .run(interaction.guildId, kitId, mcName);
    addHistory({
      guildId: interaction.guildId, kit: kitId, mcName, discordId: old.discord_id,
      discordTag: old.discord_tag, oldTier: old.tier, newTier: 'SİLİNDİ', action: 'SILINDI',
      staffId: interaction.user.id, staffTag: interaction.user.tag, reason,
    });
    await sendTierLog(interaction.guildId, tierLogEmbed({
      mcName, kit: kitId, oldTier: old.tier, newTier: 'SİLİNDİ', discordId: old.discord_id,
      staffTag: interaction.user.tag, staffId: interaction.user.id, reason, action: 'SILINDI',
    }));
    return interaction.reply({ content: `${mcName} oyuncusunun ${kitId.toUpperCase()} tier kaydı silindi.`, flags: MessageFlags.Ephemeral });
  }
    if (sub === 'gecmis') {
    const mcName = interaction.options.getString('oyuncu', true).trim();
    const rows = db.prepare(`SELECT * FROM tier_history WHERE guild_id = ? AND mc_name = ? COLLATE NOCASE ORDER BY id DESC LIMIT 12`)
      .all(interaction.guildId, mcName);
    if (!rows.length) return interaction.reply({ content: `${mcName} için tier geçmişi bulunamadı.`, flags: MessageFlags.Ephemeral });
    const embed = baseEmbed(`TIER HISTORY • ${safeName(mcName)}`);
    embed.setDescription(rows.map((row) =>
      `**${row.kit.toUpperCase()}** | ${row.old_tier || 'Yok'} → **${row.new_tier || 'Yok'}**\n${row.action} • ${row.staff_tag} • ${relativeDate(row.created_at)}`,
    ).join('\n\n'));
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'log') {
    if (!(await requireTester(interaction))) return;
    const kit = interaction.options.getString('kit');
    const tester = interaction.options.getUser('tester');
    const limit = interaction.options.getInteger('adet') || 10;
    let sql = 'SELECT * FROM tier_history WHERE guild_id = ?';
    const params = [interaction.guildId];
    if (kit) { sql += ' AND kit = ?'; params.push(kit); }
    if (tester) { sql += ' AND staff_id = ?'; params.push(tester.id); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    const rows = db.prepare(sql).all(...params);
    if (!rows.length) return interaction.reply({ content: 'Bu filtrelere uygun tier logu bulunamadı.', flags: MessageFlags.Ephemeral });
    const embed = baseEmbed('TIER OPERATION LOG');
    embed.setDescription(rows.map((row) =>
      `**${row.action}** | ${row.kit.toUpperCase()} | \`${safeName(row.mc_name)}\`\n${row.old_tier || 'Yok'} → **${row.new_tier || 'Yok'}** • ${row.staff_tag} • ${relativeDate(row.created_at)}`,
    ).join('\n\n'));
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'liste') {
    const kitId = interaction.options.getString('kit', true);
    const tierFilter = interaction.options.getString('tier');
    const page = interaction.options.getInteger('sayfa') || 1;
    const perPage = 15;
    let countSql = 'SELECT COUNT(*) AS count FROM tiers WHERE guild_id = ? AND kit = ?';
    let listSql = 'SELECT * FROM tiers WHERE guild_id = ? AND kit = ?';
    const params = [interaction.guildId, kitId];
    if (tierFilter) {
      countSql += ' AND tier = ? COLLATE NOCASE';
      listSql += ' AND tier = ? COLLATE NOCASE';
      params.push(tierFilter);
    }
    const count = db.prepare(countSql).get(...params).count;
    const rows = db.prepare(`${listSql} ORDER BY mc_name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, perPage, (page - 1) * perPage);
    if (!count) return interaction.reply({ content: `${kitId.toUpperCase()} için kayıtlı oyuncu yok.`, flags: MessageFlags.Ephemeral });
    const lines = rows.map((row, index) => `**${(page - 1) * perPage + index + 1}.** \`${safeName(row.mc_name)}\` — **${row.tier}**`);
    const embed = baseEmbed(`${kitId.toUpperCase()} TIER LIST`, lines.join('\n') || 'Bu sayfada kayıt yok.');
    embed.setFooter({ text: `${FOOTER} • Sayfa ${page}/${Math.max(1, Math.ceil(count / perPage))} • Toplam ${count}` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'istatistik') {
    const lines = Object.entries(KITS).map(([kitId, kit]) => {
      const active = db.prepare('SELECT COUNT(*) AS count FROM tiers WHERE guild_id = ? AND kit = ?').get(interaction.guildId, kitId).count;
      const tests = db.prepare(`SELECT COUNT(*) AS count FROM tier_history WHERE guild_id = ? AND kit = ? AND action IN ('VERILDI','GUNCELLENDI')`)
        .get(interaction.guildId, kitId).count;
      return `**${kit.name}:** ${active} aktif tier kaydı | ${tests} tier işlemi`;
    });
    const total = db.prepare('SELECT COUNT(*) AS count FROM tiers WHERE guild_id = ?').get(interaction.guildId).count;
    const embed = baseEmbed('TIER DATABASE STATISTICS', lines.join('\n'));
    embed.addFields({ name: 'TOTAL ACTIVE PLAYERS', value: String(total), inline: true });
    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'tester') {
    if (!(await requireTester(interaction))) return;
    const user = interaction.options.getUser('uye') || interaction.user;
    const totalActions = db.prepare(`SELECT COUNT(*) AS count FROM tier_history WHERE guild_id = ? AND staff_id = ?`)
      .get(interaction.guildId, user.id).count;
    const assigned = db.prepare(`SELECT COUNT(*) AS count FROM tier_history WHERE guild_id = ? AND staff_id = ? AND action IN ('VERILDI','GUNCELLENDI')`)
      .get(interaction.guildId, user.id).count;
    const sessions = db.prepare(`SELECT COUNT(*) AS count FROM test_sessions WHERE guild_id = ? AND tester_id = ?`)
      .get(interaction.guildId, user.id).count;
    const active = db.prepare(`SELECT COUNT(*) AS count FROM test_sessions WHERE guild_id = ? AND tester_id = ? AND status = 'active'`)
      .get(interaction.guildId, user.id).count;
    const embed = baseEmbed('TESTER PERFORMANCE', `<@${user.id}> için istatistikler`);
    embed.addFields(
      { name: 'TIER ACTIONS', value: String(totalActions), inline: true },
      { name: 'TIER ASSIGNMENTS', value: String(assigned), inline: true },
      { name: 'TEST SESSIONS', value: String(sessions), inline: true },
      { name: 'ACTIVE TESTS', value: String(active), inline: true },
    );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'sifirla') {
    const mcName = interaction.options.getString('oyuncu', true).trim();
    const confirmed = interaction.options.getBoolean('onay', true);
    if (!confirmed) return interaction.reply({ content: 'İşlem iptal edildi. Onay seçeneğini true yapmalısın.', flags: MessageFlags.Ephemeral });
    const rows = db.prepare('SELECT * FROM tiers WHERE guild_id = ? AND mc_name = ? COLLATE NOCASE').all(interaction.guildId, mcName);
    if (!rows.length) return interaction.reply({ content: `${mcName} için silinecek tier bulunamadı.`, flags: MessageFlags.Ephemeral });
    const transaction = db.transaction(() => {
      for (const row of rows) {
        addHistory({
          guildId: interaction.guildId, kit: row.kit, mcName: row.mc_name,
          discordId: row.discord_id, discordTag: row.discord_tag,
          oldTier: row.tier, newTier: 'SIFIRLANDI', action: 'SIFIRLANDI',
          staffId: interaction.user.id, staffTag: interaction.user.tag,
          reason: 'Oyuncunun tüm tier kayıtları sıfırlandı.',
        });
      }
      db.prepare('DELETE FROM tiers WHERE guild_id = ? AND mc_name = ? COLLATE NOCASE').run(interaction.guildId, mcName);
    });
    transaction();
    await sendTierLog(interaction.guildId, baseEmbed('TIER RESET', `${mcName} oyuncusunun ${rows.length} tier kaydı ${interaction.user.tag} tarafından sıfırlandı.`));
    return interaction.reply({ content: `${mcName} oyuncusunun ${rows.length} kitteki tier kayıtları sıfırlandı. Geçmiş kayıtları korundu.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'aktar') {
    const kitFilter = interaction.options.getString('kit');
    const rows = kitFilter
      ? db.prepare('SELECT * FROM tiers WHERE guild_id = ? AND kit = ? ORDER BY kit, mc_name').all(interaction.guildId, kitFilter)
      : db.prepare('SELECT * FROM tiers WHERE guild_id = ? ORDER BY kit, mc_name').all(interaction.guildId);
    const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const header = ['Minecraft', 'Kit', 'Tier', 'Discord ID', 'Discord Tag', 'Tester', 'Reason', 'Created At', 'Updated At'];
    const csv = '\uFEFF' + [header, ...rows.map((row) => [row.mc_name, row.kit.toUpperCase(), row.tier, row.discord_id, row.discord_tag, row.tester_tag, row.reason, row.created_at, row.updated_at])]
      .map((line) => line.map(escapeCsv).join(',')).join('\n');
    const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `harlem-tier-list-${kitFilter || 'all'}.csv` });
    return interaction.reply({ content: `${rows.length} tier kaydı dışa aktarıldı.`, files: [attachment], flags: MessageFlags.Ephemeral });
  }
}

async function handleSettingsCommand(interaction) {
  if (!(await requireManager(interaction))) return;
  const sub = interaction.options.getSubcommand();
  if (sub === 'sonuc' || sub === 'log') {
    const channel = interaction.options.getChannel('kanal', true);
    setSetting(interaction.guildId, sub === 'sonuc' ? 'result_channel_id' : 'log_channel_id', channel.id);
    return interaction.reply({ content: `${sub === 'sonuc' ? 'Tier sonuç' : 'Tier log'} kanalı ${channel} olarak ayarlandı.`, flags: MessageFlags.Ephemeral });
  }
  if (sub === 'tester-rol' || sub === 'yetkili-rol') {
    const action = interaction.options.getString('islem', true);
    const role = interaction.options.getRole('rol', true);
    const type = sub === 'tester-rol' ? 'tester' : 'manager';
    if (action === 'add') {
      db.prepare('INSERT OR IGNORE INTO access_roles (guild_id, role_id, role_type, created_at) VALUES (?, ?, ?, ?)')
        .run(interaction.guildId, role.id, type, nowISO());
      return interaction.reply({ content: `${role} ${type === 'tester' ? 'tester' : 'yönetici'} rol listesine eklendi.`, flags: MessageFlags.Ephemeral });
    }
    const result = db.prepare('DELETE FROM access_roles WHERE guild_id = ? AND role_id = ? AND role_type = ?')
      .run(interaction.guildId, role.id, type);
    return interaction.reply({ content: result.changes ? `${role} rol listeden kaldırıldı.` : 'Bu rol listede bulunmuyordu.', flags: MessageFlags.Ephemeral });
  }
  if (sub === 'durum') {
    const resultId = getSetting(interaction.guildId, 'result_channel_id');
    const logId = getSetting(interaction.guildId, 'log_channel_id');
    const testerRoles = getAccessRoles(interaction.guildId, 'tester');
    const managerRoles = getAccessRoles(interaction.guildId, 'manager');
    const embed = baseEmbed('BOT CONFIGURATION');
    embed.addFields(
      { name: 'RESULT CHANNEL', value: resultId ? `<#${resultId}>` : 'Ayarlanmamış', inline: true },
      { name: 'LOG CHANNEL', value: logId ? `<#${logId}>` : 'Ayarlanmamış', inline: true },
      { name: 'TESTER ROLES', value: testerRoles.length ? testerRoles.map((id) => `<@&${id}>`).join('\n') : 'Eklenmemiş', inline: false },
      { name: 'MANAGER ROLES', value: managerRoles.length ? managerRoles.map((id) => `<@&${id}>`).join('\n') : 'Eklenmemiş', inline: false },
      { name: 'DATABASE', value: 'SQLite', inline: true },
    );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

async function handleBotCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'ping') {
    const latency = Math.round(client.ws.ping);
    const embed = baseEmbed('BOT STATUS', 'HARLEM TIER LIST sistemi aktif.');
    embed.addFields(
      { name: 'API PING', value: `${latency} ms`, inline: true },
      { name: 'UPTIME', value: `${Math.floor(process.uptime() / 60)} dakika`, inline: true },
      { name: 'DATABASE', value: 'Connected', inline: true },
    );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
  if (sub === 'yardim') {
    const embed = baseEmbed('HARLEM TIER LIST • COMMANDS');
    embed.addFields(
      { name: 'TIER', value: '`/tier ver`, `/tier bak`, `/tier sil`, `/tier duzenle`, `/tier log`, `/tier gecmis`, `/tier liste`, `/tier istatistik`, `/tier tester`, `/tier sifirla`, `/tier aktar`' },
      { name: 'WAITLIST', value: '`/waitlist kur`, `/waitlist panel`, `/waitlist kontrol`, `/waitlist sifirla`' },
      { name: 'QUEUE', value: '`/kuyruk sword` (ve diğer kitler), `/kuyruk ac`, `/kuyruk kapat`, `/kuyruk durum`, `/kuyruk liste`, `/kuyruk siradaki`, `/kuyruk cikar`, `/kuyruk temizle`, `/kuyruk sil`' },
      { name: 'TEST', value: '`/test baslat`, `/test bitir`, `/test iptal`, `/test aktif`' },
      { name: 'SETTINGS', value: '`/ayar sonuc`, `/ayar log`, `/ayar tester-rol`, `/ayar yetkili-rol`, `/ayar durum`' },
    );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}

async function handleChatCommand(interaction) {
  if (!interaction.inGuild()) return interaction.reply({ content: 'Bu komut yalnızca sunucuda kullanılabilir.', flags: MessageFlags.Ephemeral });
  switch (interaction.commandName) {
    case 'tier': return handleTierCommand(interaction);
    case 'waitlist': return handleWaitlistCommand(interaction);
    case 'kuyruk': return handleQueueCommand(interaction);
    case 'test': return handleTestCommand(interaction);
    case 'ayar': return handleSettingsCommand(interaction);
    case 'bot': return handleBotCommand(interaction);
    default: return interaction.reply({ content: 'Bilinmeyen komut.', flags: MessageFlags.Ephemeral });
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`${readyClient.user.tag} olarak giriş yapıldı.`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Slash komutları yüklenemedi:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleChatCommand(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'waitlist:select') return await handleWaitlistSelect(interaction);
    if (interaction.isButton() && interaction.customId.startsWith('queue:')) return await handleQueueButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('queue-modal:')) return await handleQueueModal(interaction);
  } catch (error) {
    console.error('Interaction hatası:', error);
    const message = 'İşlem sırasında hata oluştu. Bot izinlerini ve Render loglarını kontrol et.';
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch (replyError) {
      console.error('Hata mesajı gönderilemedi:', replyError.message);
    }
  }
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Render Web Service health check. Keep this server bound to 0.0.0.0.
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('HARLEM TIER LIST BOT ACTIVE');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
});

client.login(TOKEN);
