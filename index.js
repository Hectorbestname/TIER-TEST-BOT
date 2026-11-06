'use strict';

/**
 * Tier Test Bot
 * Waitlist-based Minecraft PvP tier testing for Discord (discord.js v14).
 *
 * Flow:
 *   1. Every kit has its own waitlist text channel with a live panel (Join / Leave buttons).
 *   2. Players press "Join Waitlist", enter their Minecraft username in a form and are queued.
 *   3. A tester runs /next <kit>: the first player is pulled and a private test channel is opened.
 *   4. The tester submits /result: tier role is assigned, result is posted, cooldown starts.
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits: P,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

const CONFIG = {
  kits: ['Crystal', 'Sword', 'Axe', 'Pot', 'NethPot', 'SMP', 'UHC', 'Vanilla'],
  tiers: ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'],
  cooldownDays: 14,
  maxQueueSize: 100,
  ticketCloseDelayMs: 15_000,
  names: {
    testerRole: 'Tester',
    waitlistCategory: 'WAITLISTS',
    ticketCategory: 'TESTS',
    results: 'results',
    logs: 'tier-logs',
  },
};

const { TOKEN, GUILD_ID, PORT } = process.env;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.json');

if (!TOKEN) {
  console.error('Missing TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const COLORS = { open: 0x57f287, locked: 0xed4245, info: 0x5865f2 };
const TIER_COLORS = { 1: 0xf1c40f, 2: 0xe67e22, 3: 0x3498db, 4: 0x2ecc71, 5: 0x95a5a6 };
const tierColor = (tier) => TIER_COLORS[Number(tier.slice(2))] ?? COLORS.info;

const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const NO_PERM = '⛔ This command is for testers only.';

/* -------------------------------------------------------------------------- */
/*  Persistence (JSON file, debounced + atomic writes)                        */
/* -------------------------------------------------------------------------- */

function loadDb() {
  const base = {
    queues: {}, // kit -> [{ userId, nick, joinedAt }]
    locked: {}, // kit -> boolean
    panels: {}, // kit -> { channelId, messageId }
    cooldowns: {}, // `${userId}:${kit}` -> timestamp
    tiers: {}, // userId -> kit -> { tier, nick, testerId, at, score? }
    blacklist: {}, // userId -> { reason, by, at }
    tickets: {}, // channelId -> { playerId, testerId, kit, nick }
    channels: {}, // key -> channelId (results, logs)
  };
  try {
    return { ...base, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    return base;
  }
}

const db = loadDb();
for (const kit of CONFIG.kits) {
  db.queues[kit] ??= [];
  db.locked[kit] ??= false;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${DB_PATH}.tmp`;
    fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
      if (err) return console.error('DB write failed:', err);
      fs.rename(tmp, DB_PATH, (e) => e && console.error('DB rename failed:', e));
    });
  }, 250);
}

function flushSync() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('DB flush failed:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const EPHEMERAL = MessageFlags.Ephemeral;
const cdKey = (userId, kit) => `${userId}:${kit}`;
const stamp = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

const cooldownEnd = (userId, kit) => {
  const end = db.cooldowns[cdKey(userId, kit)];
  return end && end > Date.now() ? end : 0;
};

const isTester = (member) =>
  member.permissions.has(P.Administrator) ||
  member.roles.cache.some((r) => r.name === CONFIG.names.testerRole);

/** Reply ephemerally, or edit the reply if the interaction was already acknowledged. */
function say(i, content) {
  const payload = typeof content === 'string' ? { content } : content;
  return i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, flags: EPHEMERAL });
}

async function log(guild, text) {
  const channel = await getTextChannel(guild, 'logs');
  if (channel) await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

/* -------------------------------------------------------------------------- */
/*  Channels & roles                                                          */
/* -------------------------------------------------------------------------- */

const botOverwrite = () => ({
  id: client.user.id,
  type: OverwriteType.Member,
  allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageChannels],
});

const readOnlyFor = (guild) => [
  {
    id: guild.roles.everyone.id,
    type: OverwriteType.Role,
    allow: [P.ViewChannel, P.ReadMessageHistory],
    deny: [P.SendMessages],
  },
  botOverwrite(),
];

async function findOrCreateRole(guild, name, color) {
  const roles = await guild.roles.fetch();
  return (
    roles.find((r) => r.name === name) ??
    guild.roles.create({ name, color, mentionable: false, reason: 'Tier bot: auto role' })
  );
}

async function ensureCategory(guild, name) {
  const channels = await guild.channels.fetch();
  const found = channels.find((c) => c?.type === ChannelType.GuildCategory && c.name === name);
  return found ?? guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function getTextChannel(guild, key) {
  const id = db.channels[key];
  const byId = id ? await guild.channels.fetch(id).catch(() => null) : null;
  if (byId) return byId;
  return (
    guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === CONFIG.names[key]) ?? null
  );
}

async function ensureTextChannel(guild, key, overwrites) {
  const existing = await getTextChannel(guild, key);
  if (existing) return existing;
  const channel = await guild.channels.create({
    name: CONFIG.names[key],
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
  });
  db.channels[key] = channel.id;
  save();
  return channel;
}

/** Removes the old tier role of this kit and gives the new one (roles are auto-created). */
async function applyTier(guild, member, kit, tier) {
  const prefix = `${kit} `;
  const role = await findOrCreateRole(guild, `${kit} ${tier}`, tierColor(tier));
  const stale = member.roles.cache.filter(
    (r) => r.name.startsWith(prefix) && CONFIG.tiers.includes(r.name.slice(prefix.length)) && r.id !== role.id,
  );
  if (stale.size) await member.roles.remove(stale, `Tier bot: ${kit} tier update`);
  if (!member.roles.cache.has(role.id)) await member.roles.add(role, `Tier bot: ${kit} ${tier}`);
}

/* -------------------------------------------------------------------------- */
/*  Waitlist panel                                                            */
/* -------------------------------------------------------------------------- */

function formatQueue(kit, limit = 20) {
  const queue = db.queues[kit];
  if (!queue.length) return '*Nobody is waiting.*';
  const lines = queue.slice(0, limit).map((e, n) => `**${n + 1}.** <@${e.userId}> · \`${e.nick}\``);
  if (queue.length > limit) lines.push(`…and ${queue.length - limit} more`);
  return lines.join('\n');
}

function buildPanel(kit) {
  const locked = db.locked[kit];
  const embed = new EmbedBuilder()
    .setTitle(`${kit} Waitlist`)
    .setDescription(formatQueue(kit))
    .setColor(locked ? COLORS.locked : COLORS.open)
    .addFields(
      { name: 'Status', value: locked ? '🔒 Closed' : '🟢 Open', inline: true },
      { name: 'Waiting', value: String(db.queues[kit].length), inline: true },
    )
    .setFooter({ text: 'Press Join Waitlist and enter your Minecraft username' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl:join:${kit}`)
      .setLabel('Join Waitlist')
      .setStyle(ButtonStyle.Success)
      .setDisabled(locked),
    new ButtonBuilder().setCustomId(`wl:leave:${kit}`).setLabel('Leave').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function refreshPanel(guild, kit) {
  const saved = db.panels[kit];
  if (!saved) return;
  const channel = await guild.channels.fetch(saved.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(saved.messageId).catch(() => null);
  if (message) return message.edit(buildPanel(kit)).catch(() => {});
  const fresh = await channel.send(buildPanel(kit)).catch(() => null);
  if (fresh) {
    saved.messageId = fresh.id;
    save();
  }
}

const refreshAll = (guild) => Promise.all(CONFIG.kits.map((kit) => refreshPanel(guild, kit)));

/** Creates the kit's waitlist channel + panel, or refreshes the panel if it already exists. */
async function ensureKitChannel(guild, kit) {
  const saved = db.panels[kit];
  const existing = saved ? await guild.channels.fetch(saved.channelId).catch(() => null) : null;
  if (existing) {
    await refreshPanel(guild, kit);
    return { channel: existing, created: false };
  }

  const category = await ensureCategory(guild, CONFIG.names.waitlistCategory);
  const channel = await guild.channels.create({
    name: `${kit.toLowerCase()}-waitlist`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${kit} tier test waitlist. Use the button below to join.`,
    permissionOverwrites: readOnlyFor(guild),
  });
  const message = await channel.send(buildPanel(kit));
  db.panels[kit] = { channelId: channel.id, messageId: message.id };
  save();
  return { channel, created: true };
}

/* -------------------------------------------------------------------------- */
/*  Join / leave (buttons + modal)                                            */
/* -------------------------------------------------------------------------- */

function joinError(userId, kit) {
  if (db.blacklist[userId]) return '⛔ You are blacklisted from tier testing.';
  if (db.locked[kit]) return `🔒 The **${kit}** waitlist is closed right now.`;
  if (db.queues[kit].some((e) => e.userId === userId)) return 'You are already on this waitlist.';
  if (Object.values(db.tickets).some((t) => t.playerId === userId && t.kit === kit)) {
    return 'You already have an active test for this kit.';
  }
  const end = cooldownEnd(userId, kit);
  if (end) return `⏳ You can test **${kit}** again ${stamp(end)}.`;
  if (db.queues[kit].length >= CONFIG.maxQueueSize) return 'The waitlist is full.';
  return null;
}

async function onJoinButton(i, kit) {
  const error = joinError(i.user.id, kit);
  if (error) return say(i, error);

  const modal = new ModalBuilder()
    .setCustomId(`wl:modal:${kit}`)
    .setTitle(`${kit} Waitlist`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nick')
          .setLabel('Minecraft Username')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(16)
          .setPlaceholder('Steve')
          .setRequired(true),
      ),
    );
  return i.showModal(modal);
}

async function onNickModal(i, kit) {
  const nick = i.fields.getTextInputValue('nick').trim();
  if (!NICK_RE.test(nick)) {
    return say(i, '❌ Invalid username. Use 3–16 characters: letters, numbers and underscore only.');
  }
  const error = joinError(i.user.id, kit); // state may have changed while the form was open
  if (error) return say(i, error);

  db.queues[kit].push({ userId: i.user.id, nick, joinedAt: Date.now() });
  save();
  await say(i, `✅ You joined the **${kit}** waitlist as \`${nick}\`. Position: **#${db.queues[kit].length}**`);
  await refreshPanel(i.guild, kit);
  await log(i.guild, `➕ ${i.user.tag} joined **${kit}** waitlist as \`${nick}\``);
}

async function onLeaveButton(i, kit) {
  const before = db.queues[kit].length;
  db.queues[kit] = db.queues[kit].filter((e) => e.userId !== i.user.id);
  if (db.queues[kit].length === before) return say(i, 'You are not on this waitlist.');
  save();
  await say(i, `You left the **${kit}** waitlist.`);
  await refreshPanel(i.guild, kit);
}

/* -------------------------------------------------------------------------- */
/*  Command definitions                                                       */
/* -------------------------------------------------------------------------- */

const kitOption = (required = true) => (o) =>
  o
    .setName('kit')
    .setDescription('Game mode')
    .setRequired(required)
    .addChoices(...CONFIG.kits.map((k) => ({ name: k, value: k })));

const tierOption = (o) =>
  o
    .setName('tier')
    .setDescription('Tier')
    .setRequired(true)
    .addChoices(...CONFIG.tiers.map((t) => ({ name: t, value: t })));

const playerOption = (o) => o.setName('player').setDescription('Player').setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create roles, channels and the waitlist of every kit')
    .setDefaultMemberPermissions(P.Administrator),

  new SlashCommandBuilder()
    .setName('kuyruk')
    .setDescription('[Tester] Create or refresh the waitlist channel of a kit')
    .addStringOption(kitOption()),

  new SlashCommandBuilder()
    .setName('waitlist')
    .setDescription('Show a kit waitlist (or all of them)')
    .addStringOption(kitOption(false)),

  new SlashCommandBuilder()
    .setName('next')
    .setDescription('[Tester] Start a test with the next player in line')
    .addStringOption(kitOption()),

  new SlashCommandBuilder()
    .setName('result')
    .setDescription('[Tester] Submit a test result')
    .addUserOption(playerOption)
    .addStringOption(kitOption())
    .addStringOption(tierOption)
    .addStringOption((o) => o.setName('score').setDescription('Match score, e.g. 5-3').setMaxLength(20)),

  new SlashCommandBuilder()
    .setName('tier')
    .setDescription('Tier commands')
    .addSubcommand((s) =>
      s
        .setName('ver')
        .setDescription('[Tester] Give a tier role directly (no result post, no cooldown)')
        .addUserOption(playerOption)
        .addStringOption(kitOption())
        .addStringOption(tierOption),
    )
    .addSubcommand((s) =>
      s
        .setName('goster')
        .setDescription('Show tiers of a player')
        .addUserOption((o) => o.setName('player').setDescription('Player (default: you)')),
    ),

  new SlashCommandBuilder().setName('close').setDescription('[Tester] Close this test channel without a result'),

  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Close a kit waitlist')
    .addStringOption(kitOption())
    .setDefaultMemberPermissions(P.ManageGuild),

  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('Open a kit waitlist')
    .addStringOption(kitOption())
    .setDefaultMemberPermissions(P.ManageGuild),

  new SlashCommandBuilder()
    .setName('clearqueue')
    .setDescription('Remove everyone from a kit waitlist')
    .addStringOption(kitOption())
    .setDefaultMemberPermissions(P.ManageGuild),

  new SlashCommandBuilder()
    .setName('resetcooldown')
    .setDescription('Reset the test cooldown of a player')
    .addUserOption(playerOption)
    .addStringOption(kitOption())
    .setDefaultMemberPermissions(P.ManageGuild),

  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Block players from tier testing')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Blacklist a player')
        .addUserOption(playerOption)
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Unblacklist a player').addUserOption(playerOption)),
];

/* -------------------------------------------------------------------------- */
/*  Command handlers                                                          */
/* -------------------------------------------------------------------------- */

const handlers = {
  async setup(i) {
    await i.deferReply({ flags: EPHEMERAL });
    const guild = i.guild;

    const tester = await findOrCreateRole(guild, CONFIG.names.testerRole, 0x9b59b6);
    const results = await ensureTextChannel(guild, 'results', readOnlyFor(guild));
    const logs = await ensureTextChannel(guild, 'logs', [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
      { id: tester.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory] },
      botOverwrite(),
    ]);

    const kitChannels = [];
    for (const kit of CONFIG.kits) {
      const { channel } = await ensureKitChannel(guild, kit);
      kitChannels.push(`${channel}`);
    }

    return i.editReply(
      [
        '✅ Setup complete.',
        `**Tester role:** ${tester}`,
        `**Results:** ${results}  ·  **Logs:** ${logs}`,
        `**Waitlists:** ${kitChannels.join(' ')}`,
        '',
        'Give your testers the Tester role. Keep the bot role **above** the tier roles.',
      ].join('\n'),
    );
  },

  async kuyruk(i) {
    if (!isTester(i.member)) return say(i, NO_PERM);
    await i.deferReply({ flags: EPHEMERAL });
    const kit = i.options.getString('kit');
    const { channel, created } = await ensureKitChannel(i.guild, kit);
    return i.editReply(created ? `✅ Waitlist created: ${channel}` : `🔄 Waitlist refreshed: ${channel}`);
  },

  async waitlist(i) {
    const kit = i.options.getString('kit');
    if (kit) {
      const embed = new EmbedBuilder()
        .setTitle(`${kit} Waitlist`)
        .setDescription(formatQueue(kit, 25))
        .setColor(db.locked[kit] ? COLORS.locked : COLORS.open);
      return i.reply({ embeds: [embed] });
    }
    const lines = CONFIG.kits.map(
      (k) => `**${k}** — ${db.queues[k].length} waiting${db.locked[k] ? ' 🔒' : ''}`,
    );
    const embed = new EmbedBuilder().setTitle('Waitlists').setDescription(lines.join('\n')).setColor(COLORS.info);
    return i.reply({ embeds: [embed] });
  },

  async next(i) {
    if (!isTester(i.member)) return say(i, NO_PERM);
    const kit = i.options.getString('kit');
    if (Object.values(db.tickets).some((t) => t.testerId === i.user.id)) {
      return say(i, 'You already have an active test. Finish it with `/result` or `/close` first.');
    }
    await i.deferReply({ flags: EPHEMERAL });

    // Pull the first player who is still in the server.
    let entry = null;
    let member = null;
    while (db.queues[kit].length && !member) {
      entry = db.queues[kit].shift();
      member = await i.guild.members.fetch(entry.userId).catch(() => null);
    }
    save();
    if (!member) {
      await refreshPanel(i.guild, kit);
      return i.editReply(`The **${kit}** waitlist is empty.`);
    }

    const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles];
    let channel;
    try {
      const category = await ensureCategory(i.guild, CONFIG.names.ticketCategory);
      channel = await i.guild.channels.create({
        name: `${kit.toLowerCase()}-${entry.nick.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `${kit} test · ${entry.nick}`,
        permissionOverwrites: [
          { id: i.guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
          { id: member.id, type: OverwriteType.Member, allow },
          { id: i.user.id, type: OverwriteType.Member, allow },
          botOverwrite(),
        ],
      });
    } catch (err) {
      db.queues[kit].unshift(entry); // give the player their spot back
      save();
      throw err;
    }

    db.tickets[channel.id] = { playerId: member.id, testerId: i.user.id, kit, nick: entry.nick };
    save();

    const embed = new EmbedBuilder()
      .setTitle(`${kit} Tier Test`)
      .setColor(COLORS.info)
      .setDescription('Play the match. When it is over the tester submits the result with `/result`.')
      .addFields(
        { name: 'Player', value: `<@${member.id}>`, inline: true },
        { name: 'Minecraft', value: `\`${entry.nick}\``, inline: true },
        { name: 'Tester', value: `<@${i.user.id}>`, inline: true },
      );
    await channel.send({ content: `<@${member.id}> <@${i.user.id}>`, embeds: [embed] });

    await refreshPanel(i.guild, kit);
    await log(i.guild, `🎮 ${i.user.tag} started a **${kit}** test with ${member.user.tag} (\`${entry.nick}\`)`);
    return i.editReply(`✅ Test channel opened: ${channel}`);
  },

  async result(i) {
    if (!isTester(i.member)) return say(i, NO_PERM);
    await i.deferReply({ flags: EPHEMERAL });

    const user = i.options.getUser('player');
    const kit = i.options.getString('kit');
    const tier = i.options.getString('tier');
    const score = i.options.getString('score');

    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.editReply('That user is not in this server.');

    const ticket = db.tickets[i.channelId];
    const previous = db.tiers[user.id]?.[kit];
    const nick =
      (ticket?.playerId === user.id ? ticket.nick : null) ??
      db.queues[kit].find((e) => e.userId === user.id)?.nick ??
      previous?.nick ??
      null;

    await applyTier(i.guild, member, kit, tier);

    db.tiers[user.id] ??= {};
    db.tiers[user.id][kit] = { tier, nick, testerId: i.user.id, at: Date.now(), ...(score && { score }) };
    db.cooldowns[cdKey(user.id, kit)] = Date.now() + CONFIG.cooldownDays * 86_400_000;
    db.queues[kit] = db.queues[kit].filter((e) => e.userId !== user.id);
    save();

    const embed = new EmbedBuilder()
      .setTitle(`${member.displayName} — ${kit} Result`)
      .setColor(tierColor(tier))
      .setThumbnail(nick ? `https://mc-heads.net/avatar/${nick}/128` : member.displayAvatarURL())
      .addFields(
        { name: 'Minecraft', value: nick ? `\`${nick}\`` : '—', inline: true },
        { name: 'Previous', value: previous?.tier ?? 'Unranked', inline: true },
        { name: 'Earned', value: `**${tier}**`, inline: true },
        ...(score ? [{ name: 'Score', value: score, inline: true }] : []),
        { name: 'Tester', value: `<@${i.user.id}>`, inline: true },
      )
      .setTimestamp();

    const results = await getTextChannel(i.guild, 'results');
    if (results) await results.send({ content: `<@${member.id}>`, embeds: [embed] });

    await refreshPanel(i.guild, kit);
    await log(i.guild, `🏆 ${i.user.tag} gave ${member.user.tag} **${kit} ${tier}**${score ? ` (${score})` : ''}`);

    if (ticket?.playerId === user.id) {
      delete db.tickets[i.channelId];
      save();
      const seconds = Math.round(CONFIG.ticketCloseDelayMs / 1000);
      await i.channel.send(`✅ Result submitted. This channel closes in ${seconds}s.`).catch(() => {});
      setTimeout(() => i.channel.delete('Test finished').catch(() => {}), CONFIG.ticketCloseDelayMs);
    }

    return i.editReply(
      results
        ? `✅ **${kit} ${tier}** given to ${member}.`
        : `✅ **${kit} ${tier}** given to ${member}. (No results channel found, run /setup.)`,
    );
  },

  async 'tier:ver'(i) {
    if (!isTester(i.member)) return say(i, NO_PERM);
    await i.deferReply({ flags: EPHEMERAL });

    const user = i.options.getUser('player');
    const kit = i.options.getString('kit');
    const tier = i.options.getString('tier');
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.editReply('That user is not in this server.');

    await applyTier(i.guild, member, kit, tier);
    db.tiers[user.id] ??= {};
    db.tiers[user.id][kit] = {
      tier,
      nick: db.tiers[user.id][kit]?.nick ?? null,
      testerId: i.user.id,
      at: Date.now(),
      manual: true,
    };
    save();
    await log(i.guild, `🏷️ ${i.user.tag} set ${member.user.tag} to **${kit} ${tier}** (manual)`);
    return i.editReply(`✅ ${member} is now **${kit} ${tier}**.`);
  },

  async 'tier:goster'(i) {
    const user = i.options.getUser('player') ?? i.user;
    const lines = CONFIG.kits.map((kit) => {
      const data = db.tiers[user.id]?.[kit];
      const end = cooldownEnd(user.id, kit);
      return `**${kit}:** ${data ? data.tier : 'Unranked'}${end ? ` · retest ${stamp(end)}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`${user.username} — Tiers`)
      .setThumbnail(user.displayAvatarURL())
      .setDescription(lines.join('\n'))
      .setColor(COLORS.info);
    return i.reply({ embeds: [embed] });
  },

  async close(i) {
    if (!isTester(i.member)) return say(i, NO_PERM);
    if (!db.tickets[i.channelId]) return say(i, 'This is not an active test channel.');
    const { kit, nick } = db.tickets[i.channelId];
    delete db.tickets[i.channelId];
    save();
    await i.reply('Test closed without a result. Deleting this channel in 5 seconds...');
    await log(i.guild, `🚫 ${i.user.tag} closed a **${kit}** test (\`${nick}\`) without a result`);
    setTimeout(() => i.channel.delete('Test closed').catch(() => {}), 5000);
  },

  async lock(i) {
    const kit = i.options.getString('kit');
    db.locked[kit] = true;
    save();
    await refreshPanel(i.guild, kit);
    return say(i, `🔒 **${kit}** waitlist closed.`);
  },

  async unlock(i) {
    const kit = i.options.getString('kit');
    db.locked[kit] = false;
    save();
    await refreshPanel(i.guild, kit);
    return say(i, `🟢 **${kit}** waitlist opened.`);
  },

  async clearqueue(i) {
    const kit = i.options.getString('kit');
    const count = db.queues[kit].length;
    db.queues[kit] = [];
    save();
    await refreshPanel(i.guild, kit);
    await log(i.guild, `🧹 ${i.user.tag} cleared the **${kit}** waitlist (${count} players)`);
    return say(i, `🧹 Removed ${count} player(s) from **${kit}**.`);
  },

  async resetcooldown(i) {
    const user = i.options.getUser('player');
    const kit = i.options.getString('kit');
    delete db.cooldowns[cdKey(user.id, kit)];
    save();
    return say(i, `✅ Cooldown of ${user} for **${kit}** reset.`);
  },

  async 'blacklist:add'(i) {
    const user = i.options.getUser('player');
    const reason = i.options.getString('reason') ?? 'No reason given';
    db.blacklist[user.id] = { reason, by: i.user.id, at: Date.now() };
    for (const kit of CONFIG.kits) {
      db.queues[kit] = db.queues[kit].filter((e) => e.userId !== user.id);
    }
    save();
    await refreshAll(i.guild);
    await log(i.guild, `⛔ ${i.user.tag} blacklisted ${user.tag}: ${reason}`);
    return say(i, `⛔ ${user} blacklisted.`);
  },

  async 'blacklist:remove'(i) {
    const user = i.options.getUser('player');
    if (!db.blacklist[user.id]) return say(i, 'That player is not blacklisted.');
    delete db.blacklist[user.id];
    save();
    return say(i, `✅ ${user} removed from the blacklist.`);
  },
};

/* -------------------------------------------------------------------------- */
/*  Event wiring                                                              */
/* -------------------------------------------------------------------------- */

async function onError(i, err) {
  console.error(`[${i.commandName ?? i.customId}]`, err);
  const message =
    err?.code === 50013
      ? '❌ Missing permissions. Put the bot role **above** the tier roles and give it Manage Roles and Manage Channels.'
      : '❌ Something went wrong. Check the bot console.';
  await say(i, message).catch(() => {});
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.inGuild()) return;
  try {
    if (i.isChatInputCommand()) {
      const sub = i.options.getSubcommand(false);
      const handler = handlers[sub ? `${i.commandName}:${sub}` : i.commandName];
      return await handler?.(i);
    }

    if ((i.isButton() || i.isModalSubmit()) && i.customId.startsWith('wl:')) {
      const [, action, kit] = i.customId.split(':');
      if (!CONFIG.kits.includes(kit)) return;
      if (i.isButton() && action === 'join') return await onJoinButton(i, kit);
      if (i.isButton() && action === 'leave') return await onLeaveButton(i, kit);
      if (i.isModalSubmit() && action === 'modal') return await onNickModal(i, kit);
    }
  } catch (err) {
    await onError(i, err);
  }
});

// A test channel deleted by hand must not block the tester forever.
client.on(Events.ChannelDelete, (channel) => {
  if (db.tickets[channel.id]) {
    delete db.tickets[channel.id];
    save();
  }
});

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(c.user.id, GUILD_ID)
    : Routes.applicationCommands(c.user.id);
  await rest.put(route, { body: commands.map((cmd) => cmd.toJSON()) });
  console.log(`${c.user.tag} is online. ${commands.length} commands registered${GUILD_ID ? ' (guild)' : ' (global)'}.`);
});

/* -------------------------------------------------------------------------- */
/*  Process lifecycle                                                         */
/* -------------------------------------------------------------------------- */

// Optional health endpoint for hosts that need an open port (e.g. Render web services).
if (PORT) {
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    })
    .listen(PORT, () => console.log(`Health server listening on :${PORT}`));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flushSync();
    client.destroy();
    process.exit(0);
  });
}
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(TOKEN);
