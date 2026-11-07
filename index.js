
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Colors,
} = require("discord.js");

const Database = require("better-sqlite3");

/* =====================================================
   AYARLAR
===================================================== */

const CONFIG = {
  COLOR: 0xD71920,

  // Bu kanallara kanal ID'lerini yaz.
  // Boş bırakırsan tier sonucu komutun yazıldığı kanala gider.
  TIER_RESULT_CHANNEL_ID: "",
  LOG_CHANNEL_ID: "",

  // Kuyruk yönetebilecek rollerin ID'leri.
  // Boş bırakılırsa yalnızca Yönetici yetkisi olanlar yönetebilir.
  STAFF_ROLE_IDS: [],

  KITS: {
    netpot: {
      name: "NETPOT",
      emoji: "🛡️",
      role: "NETPOT WAITLIST",
      queueCommand: "netpot-kuyruk",
    },
    sword: {
      name: "SWORD",
      emoji: "⚔️",
      role: "SWORD WAITLIST",
      queueCommand: "sword-kuyruk",
    },
    smp: {
      name: "SMP",
      emoji: "🌍",
      role: "SMP WAITLIST",
      queueCommand: "smp-kuyruk",
    },
    cpvp: {
      name: "CPVP",
      emoji: "💎",
      role: "CPVP WAITLIST",
      queueCommand: "cpvp-kuyruk",
    },
    mace: {
      name: "MACE",
      emoji: "🔨",
      role: "MACE WAITLIST",
      queueCommand: "mace-kuyruk",
    },
    axe: {
      name: "AXE",
      emoji: "🪓",
      role: "AXE WAITLIST",
      queueCommand: "axe-kuyruk",
    },
    uhc: {
      name: "UHC",
      emoji: "❤️",
      role: "UHC WAITLIST",
      queueCommand: "uhc-kuyruk",
    },
  },
};

/* =====================================================
   VERİTABANI
===================================================== */

const db = new Database("waitlist.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tiers (
    kit TEXT NOT NULL,
    player TEXT NOT NULL,
    tier TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT,
    PRIMARY KEY (kit, player)
  );

  CREATE TABLE IF NOT EXISTS queues (
    kit TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kit TEXT NOT NULL,
    mc_name TEXT NOT NULL,
    mc_key TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    discord_tag TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    UNIQUE (kit, mc_key)
  );
`);

/* =====================================================
   DISCORD CLIENT
===================================================== */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

/* =====================================================
   YARDIMCI FONKSİYONLAR
===================================================== */

function getKit(kitId) {
  return CONFIG.KITS[kitId] || null;
}

function getKitEntries(kitId) {
  return db.prepare(`
    SELECT *
    FROM queue_entries
    WHERE kit = ?
    ORDER BY id ASC
  `).all(kitId);
}

function getQueue(kitId) {
  return db.prepare(`
    SELECT *
    FROM queues
    WHERE kit = ?
  `).get(kitId);
}

function isStaff(member) {
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  if (!CONFIG.STAFF_ROLE_IDS.length) {
    return false;
  }

  return CONFIG.STAFF_ROLE_IDS.some(roleId =>
    member.roles.cache.has(roleId)
  );
}

function getTier(kitId, playerName) {
  return db.prepare(`
    SELECT tier
    FROM tiers
    WHERE kit = ? AND player = ?
  `).get(kitId, playerName.toLowerCase());
}

function getQueueCount(kitId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM queue_entries
    WHERE kit = ?
  `).get(kitId).count;
}

/* =====================================================
   ROL OLUŞTURMA / BULMA
   Kanal oluşturulmaz ve kanal izinlerine dokunulmaz.
===================================================== */

async function getOrCreateWaitlistRole(guild, kit) {
  let role = guild.roles.cache.find(
    item => item.name === kit.role
  );

  if (!role) {
    role = await guild.roles.create({
      name: kit.role,
      color: CONFIG.COLOR,
      hoist: false,
      mentionable: false,
      reason: "WAITLIST rolü",
    });
  }

  return role;
}

/* =====================================================
   WAITLIST PANELİ
===================================================== */

function createWaitlistEmbed() {
  const embed = new EmbedBuilder()
    .setColor(CONFIG.COLOR)
    .setTitle("WAITLIST")
    .setDescription(
      "Almak istediğin kiti aşağıdan seç.\n" +
      "Seçtiğin kitin WAITLIST rolü hesabına verilir.\n\n" +
      "Aynı butona tekrar basarak rolünü kaldırabilirsin."
    )
    .setFooter({
      text: "WAITLIST • Kit Selection",
    })
    .setTimestamp();

  for (const kit of Object.values(CONFIG.KITS)) {
    embed.addFields({
      name: `${kit.emoji} ${kit.name}`,
      value: `\`${kit.role}\``,
      inline: true,
    });
  }

  return embed;
}

function createWaitlistButtons() {
  const kits = Object.entries(CONFIG.KITS);
  const rows = [];

  for (let i = 0; i < kits.length; i += 5) {
    const row = new ActionRowBuilder();

    for (const [kitId, kit] of kits.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`waitlist:${kitId}`)
          .setLabel(kit.name)
          .setEmoji(kit.emoji)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    rows.push(row);
  }

  return rows;
}

/* =====================================================
   KUYRUK PANELİ EMBED
===================================================== */

function createQueueEmbed(kitId, isOpen) {
  const kit = getKit(kitId);
  const entries = getQueueEntries(kitId);

  const playerList = entries.length
    ? entries.map((entry, index) =>
        `\`${index + 1}.\` **${entry.mc_name}**`
      ).join("\n")
    : "Henüz katılan oyuncu yok.";

  const embed = new EmbedBuilder()
    .setColor(isOpen ? Colors.Green : Colors.Red)
    .setTitle(`${kit.emoji} ${kit.name} KUYRUĞU`)
    .setDescription(
      isOpen
        ? "Kuyruk şu anda açık. Katılmak için aşağıdaki butonu kullan."
        : "Kuyruk şu anda kapalı. Yeni oyuncu katılımı alınmıyor."
    )
    .addFields(
      {
        name: "Durum",
        value: isOpen ? "🟢 AÇIK" : "🔴 KAPALI",
        inline: true,
      },
      {
        name: "Oyuncu Sayısı",
        value: `**${entries.length}**`,
        inline: true,
      },
      {
        name: "Katılımcılar",
        value: playerList.slice(0, 1024),
        inline: false,
      }
    )
    .setFooter({
      text: `${kit.name} • Independent Queue`,
    })
    .setTimestamp();

  return embed;
}

function getQueueEntries(kitId) {
  return getQueueEntriesStatement.all(kitId);
}

const getQueueEntriesStatement = db.prepare(`
  SELECT *
  FROM queue_entries
  WHERE kit = ?
  ORDER BY id ASC
`);

/* =====================================================
   KUYRUK PANELİ BUTONLARI
===================================================== */

function createQueueButtons(kitId, isOpen) {
  const row = new ActionRowBuilder();

  if (isOpen) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue:join:${kitId}`)
        .setLabel("Kuyruğa Katıl")
        .setEmoji("➕")
        .setStyle(ButtonStyle.Success)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:leave:${kitId}`)
      .setLabel("Kuyruktan Ayrıl")
      .setEmoji("➖")
      .setStyle(ButtonStyle.Secondary)
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:toggle:${kitId}`)
      .setLabel(isOpen ? "Kapat" : "Aç")
      .setEmoji(isOpen ? "🔒" : "🔓")
      .setStyle(isOpen ? ButtonStyle.Danger : ButtonStyle.Success)
    );

  return [row];
}

/* =====================================================
   KUYRUK PANELİNİ GÜNCELLE
===================================================== */

async function updateQueuePanel(guild, kitId) {
  const queue = getQueue(kitId);

  if (!queue) return;

  const channel = await guild.channels.fetch(queue.channel_id)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  const message = await channel.messages.fetch(queue.message_id)
    .catch(() => null);

  if (!message) return;

  await message.edit({
    embeds: [
      createQueueEmbed(kitId, Boolean(queue.is_open)),
    ],
    components: createQueueButtons(
      kitId,
      Boolean(queue.is_open)
    ),
  });
}

/* =====================================================
   KUYRUK AÇ / KAPAT KOMUTU
===================================================== */

async function toggleQueueCommand(interaction, kitId) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: "Bu kuyruğu yönetme yetkin yok.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const existing = getQueue(kitId);

  if (!existing) {
    const kit = getKit(kitId);

    const message = await interaction.channel.send({
      embeds: [createQueueEmbed(kitId, true)],
      components: createQueueButtons(kitId, true),
    });

    db.prepare(`
      INSERT INTO queues (kit, channel_id, message_id, is_open)
      VALUES (?, ?, ?, 1)
    `).run(
      kitId,
      interaction.channel.id,
      message.id
    );

    return interaction.editReply({
      content: `${kit.emoji} **${kit.name}** kuyruğu açıldı ve panel gönderildi.`,
    });
  }

  const newStatus = existing.is_open ? 0 : 1;

  db.prepare(`
    UPDATE queues
    SET is_open = ?
    WHERE kit = ?
  `).run(newStatus, kitId);

  await updateQueuePanel(interaction.guild, kitId);

  const kit = getKit(kitId);

  return interaction.editReply({
    content: newStatus
      ? `${kit.emoji} **${kit.name}** kuyruğu açıldı.`
      : `${kit.emoji} **${kit.name}** kuyruğu kapatıldı.`,
  });
}

/* =====================================================
   KUYRUK KATILIM MODALI
===================================================== */

function createJoinModal(kitId) {
  const kit = getKit(kitId);

  const modal = new ModalBuilder()
    .setCustomId(`queue:modal:${kitId}`)
    .setTitle(`${kit.name} Kuyruğuna Katıl`);

  const nameInput = new TextInputBuilder()
    .setCustomId("minecraft_name")
    .setLabel("Minecraft kullanıcı adın")
    .setPlaceholder("Örnek: Steve123")
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(16)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput)
  );

  return modal;
}

/* =====================================================
   KUYRUĞA OYUNCU EKLE
===================================================== */

async function addQueuePlayer(interaction, kitId, mcName) {
  const queue = getQueue(kitId);
  const kit = getKit(kitId);

  if (!queue || !queue.is_open) {
    return interaction.reply({
      content: "Bu kuyruk şu anda kapalı.",
      ephemeral: true,
    });
  }

  const cleanName = mcName.trim();
  const normalizedName = cleanName.toLowerCase();

  if (!/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) {
    return interaction.reply({
      content: "Geçerli bir Minecraft kullanıcı adı gir.",
      ephemeral: true,
    });
  }

  const existing = db.prepare(`
    SELECT id
    FROM queue_entries
    WHERE kit = ? AND (mc_key = ? OR discord_id = ?)
  `).get(
    kitId,
    normalizedName,
    interaction.user.id
  );

  if (existing) {
    return interaction.reply({
      content: "Bu kuyrukta zaten kaydın bulunuyor.",
      ephemeral: true,
    });
  }

  db.prepare(`
    INSERT INTO queue_entries (
      kit,
      mc_name,
      mc_key,
      discord_id,
      discord_tag,
      joined_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    kitId,
    cleanName,
    normalizedName,
    interaction.user.id,
    interaction.user.tag,
    new Date().toISOString()
  );

  await interaction.reply({
    content: `${kit.emoji} **${kit.name}** kuyruğuna başarıyla katıldın.\nMinecraft adı: \`${cleanName}\``,
    ephemeral: true,
  });

  await updateQueuePanel(interaction.guild, kitId);
}

/* =====================================================
   KUYRUKTAN AYRIL
===================================================== */

async function removeQueuePlayer(interaction, kitId) {
  const result = db.prepare(`
    DELETE FROM queue_entries
    WHERE kit = ? AND discord_id = ?
  `).run(
    kitId,
    interaction.user.id
  );

  if (!result.changes) {
    return interaction.reply({
      content: "Bu kitin kuyruğunda kaydın bulunmuyor.",
      ephemeral: true,
    });
  }

  const kit = getKit(kitId);

  await interaction.reply({
    content: `${kit.emoji} **${kit.name}** kuyruğundan ayrıldın.`,
    ephemeral: true,
  });

  await updateQueuePanel(interaction.guild, kitId);
}

/* =====================================================
   TIER SONUÇ EMBED
===================================================== */

function createTierResultEmbed({
  kitId,
  playerName,
  oldTier,
  newTier,
  discordUser,
  staffUser,
}) {
  const kit = getKit(kitId);

  return new EmbedBuilder()
    .setColor(CONFIG.COLOR)
    .setTitle("🏆 TIER TEST SONUCU")
    .setDescription(
      `**${playerName}** oyuncusunun tier sonucu güncellendi.`
    )
    .addFields(
      {
        name: "Oyuncu",
        value: `\`${playerName}\``,
        inline: true,
      },
      {
        name: "Kit",
        value: `${kit.emoji} **${kit.name}**`,
        inline: true,
      },
      {
        name: "Eski Tier",
        value: `\`${oldTier || "İlk kayıt"}\``,
        inline: true,
      },
      {
        name: "Yeni Tier",
        value: `**${newTier}**`,
        inline: true,
      },
      {
        name: "Discord",
        value: discordUser
          ? `${discordUser} (\`${discordUser.tag}\`)`
          : "Belirtilmedi",
        inline: false,
      },
      {
        name: "Test Yetkilisi",
        value: `${staffUser} (\`${staffUser.tag}\`)`,
        inline: false,
      }
    )
    .setFooter({
      text: "Tier Results • HARLEM PVP",
    })
    .setTimestamp();
}

/* =====================================================
   TIER LOG EMBED
===================================================== */

function createTierLogEmbed(data) {
  const kit = getKit(data.kitId);

  return new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle("TIER DEĞİŞİKLİĞİ LOG")
    .addFields(
      {
        name: "Minecraft Oyuncusu",
        value: `\`${data.playerName}\``,
        inline: true,
      },
      {
        name: "Kit",
        value: `${kit.emoji} ${kit.name}`,
        inline: true,
      },
      {
        name: "Eski Tier",
        value: `\`${data.oldTier || "İlk kayıt"}\``,
        inline: true,
      },
      {
        name: "Yeni Tier",
        value: `\`${data.newTier}\``,
        inline: true,
      },
      {
        name: "Oyuncunun Discord'u",
        value: data.discordUser
          ? `${data.discordUser.tag}\nID: \`${data.discordUser.id}\``
          : "Belirtilmedi",
        inline: false,
      },
      {
        name: "İşlemi Yapan",
        value: `${data.staffUser.tag}\nID: \`${data.staffUser.id}\``,
        inline: false,
      }
    )
    .setTimestamp();
}

/* =====================================================
   TIER VER
===================================================== */

async function giveTier(interaction) {
  const kitId = interaction.options.getString("kit");
  const playerName = interaction.options.getString("oyuncu").trim();
  const newTier = interaction.options.getString("yeni_tier").trim();
  const discordUser = interaction.options.getUser("discord");

  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: "Tier verme yetkin bulunmuyor.",
      ephemeral: true,
    });
  }

  if (!/^[A-Za-z0-9_]{3,16}$/.test(playerName)) {
    return interaction.reply({
      content: "Geçerli bir Minecraft oyuncu adı gir.",
      ephemeral: true,
    });
  }

  if (newTier.length > 32) {
    return interaction.reply({
      content: "Tier adı en fazla 32 karakter olabilir.",
      ephemeral: true,
    });
  }

  const oldRecord = getTier(kitId, playerName);
  const oldTier = oldRecord?.tier || null;

  db.prepare(`
    INSERT INTO tiers (
      kit,
      player,
      tier,
      updated_by,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kit, player)
    DO UPDATE SET
      tier = excluded.tier,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(
    kitId,
    playerName.toLowerCase(),
    newTier,
    interaction.user.id,
    new Date().toISOString()
  );

  const data = {
    kitId,
    playerName,
    oldTier,
    newTier,
    discordUser,
    staffUser: interaction.user,
  };

  const resultEmbed = createTierResultEmbed(data);
  const logEmbed = createTierLogEmbed(data);

  const resultChannel = CONFIG.TIER_RESULT_CHANNEL_ID
    ? await interaction.guild.channels.fetch(
        CONFIG.TIER_RESULT_CHANNEL_ID
      ).catch(() => null)
    : interaction.channel;

  if (resultChannel?.isTextBased()) {
    await resultChannel.send({
      embeds: [resultEmbed],
    });
  }

  if (CONFIG.LOG_CHANNEL_ID) {
    const logChannel = await interaction.guild.channels.fetch(
      CONFIG.LOG_CHANNEL_ID
    ).catch(() => null);

    if (logChannel?.isTextBased()) {
      await logChannel.send({
        embeds: [logEmbed],
      });
    }
  }

  return interaction.reply({
    content:
      `**${playerName}** oyuncusunun ${getKit(kitId).name} tier'ı güncellendi.\n` +
      `Eski: \`${oldTier || "İlk kayıt"}\` → Yeni: \`${newTier}\``,
    ephemeral: true,
  });
}

/* =====================================================
   SLASH KOMUTLARI
===================================================== */

function buildCommands() {
  const commands = [];

  commands.push(
    new SlashCommandBuilder()
      .setName("waitlist-kur")
      .setDescription("7 kitin WAITLIST rollerini oluşturur.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("waitlist-panel")
      .setDescription("WAITLIST rol seçim panelini gönderir.")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  );

  const tierCommand = new SlashCommandBuilder()
    .setName("tier")
    .setDescription("Oyuncunun tier bilgisini yönetir.");

  tierCommand.addSubcommand(sub =>
    sub
      .setName("ver")
      .setDescription("Oyuncuya yeni tier verir.")
      .addStringOption(option =>
        option
          .setName("kit")
          .setDescription("Kit seç")
          .setRequired(true)
          .addChoices(
            ...Object.entries(CONFIG.KITS).map(([id, kit]) => ({
              name: kit.name,
              value: id,
            }))
          )
      )
      .addStringOption(option =>
        option
          .setName("oyuncu")
          .setDescription("Minecraft oyuncu adı")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("yeni_tier")
          .setDescription("Verilecek yeni tier")
          .setRequired(true)
      )
      .addUserOption(option =>
        option
          .setName("discord")
          .setDescription("Oyuncunun Discord hesabı")
          .setRequired(false)
      )
  );

  commands.push(tierCommand);

  for (const [kitId, kit] of Object.entries(CONFIG.KITS)) {
    commands.push(
      new SlashCommandBuilder()
        .setName(kit.queueCommand)
        .setDescription(`${kit.name} kuyruğunu açar veya kapatır.`)
    );
  }

  return commands.map(command => command.toJSON());
}

/* =====================================================
   SLASH KOMUTLARINI KAYDET
===================================================== */

async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(process.env.TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    {
      body: buildCommands(),
    }
  );

  console.log("Slash komutları kaydedildi.");
}

/* =====================================================
   BOT HAZIR
===================================================== */

client.once("ready", async () => {
  console.log("--------------------------------");
  console.log(`Bot aktif: ${client.user.tag}`);
  console.log("--------------------------------");

  try {
    await registerCommands();
  } catch (error) {
    console.error("Komut kayıt hatası:", error);
  }
});

/* =====================================================
   INTERACTION HANDLER
===================================================== */

client.on("interactionCreate", async interaction => {
  try {
    /* WAITLIST BUTONLARI */

    if (interaction.isButton() &&
        interaction.customId.startsWith("waitlist:")) {
      const kitId = interaction.customId.split(":")[1];
      const kit = getKit(kitId);

      if (!kit) {
        return interaction.reply({
          content: "Kit bulunamadı.",
          ephemeral: true,
        });
      }

      const role = await getOrCreateWaitlistRole(
        interaction.guild,
        kit
      );

      const member = await interaction.guild.members.fetch(
        interaction.user.id
      );

      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role);

        return interaction.reply({
          content: `${kit.emoji} **${kit.name} WAITLIST** rolün kaldırıldı.`,
          ephemeral: true,
        });
      }

      await member.roles.add(role);

      return interaction.reply({
        content: `${kit.emoji} **${kit.name} WAITLIST** rolünü aldın.`,
        ephemeral: true,
      });
    }

    /* KUYRUK BUTONLARI */

    if (interaction.isButton() &&
        interaction.customId.startsWith("queue:")) {
      const parts = interaction.customId.split(":");
      const action = parts[1];
      const kitId = parts[2];

      if (!getKit(kitId)) {
        return interaction.reply({
          content: "Kit bulunamadı.",
          ephemeral: true,
        });
      }

      if (action === "join") {
        const queue = getQueue(kitId);

        if (!queue || !queue.is_open) {
          return interaction.reply({
            content: "Bu kuyruk kapalı.",
            ephemeral: true,
          });
        }

        return interaction.showModal(createJoinModal(kitId));
      }

      if (action === "leave") {
        return removeQueuePlayer(interaction, kitId);
      }

      if (action === "toggle") {
        if (!isStaff(interaction.member)) {
          return interaction.reply({
            content: "Bu butonu kullanma yetkin yok.",
            ephemeral: true,
          });
        }

        const queue = getQueue(kitId);

        if (!queue) {
          return interaction.reply({
            content: "Kuyruk kaydı bulunamadı.",
            ephemeral: true,
          });
        }

        const newStatus = queue.is_open ? 0 : 1;

        db.prepare(`
          UPDATE queues
          SET is_open = ?
          WHERE kit = ?
        `).run(newStatus, kitId);

        await interaction.deferUpdate();
        await updateQueuePanel(interaction.guild, kitId);

        return;
      }
    }

    /* KUYRUK MODALI */

    if (interaction.isModalSubmit() &&
        interaction.customId.startsWith("queue:modal:")) {
      const kitId = interaction.customId.split(":")[2];
      const mcName = interaction.fields.getTextInputValue(
        "minecraft_name"
      );

      return addQueuePlayer(interaction, kitId, mcName);
    }

    /* SLASH KOMUTLARI */

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "waitlist-kur") {
      await interaction.deferReply({ ephemeral: true });

      const created = [];

      for (const kit of Object.values(CONFIG.KITS)) {
        const role = await getOrCreateWaitlistRole(
          interaction.guild,
          kit
        );

        created.push(`${kit.emoji} ${role.name}`);
      }

      return interaction.editReply({
        content:
          "**WAITLIST rolleri hazır.**\n\n" +
          created.map(item => `• ${item}`).join("\n") +
          "\n\nHiçbir kanal oluşturulmadı veya kanal izni değiştirilmedi.",
      });
    }

    if (interaction.commandName === "waitlist-panel") {
      if (!interaction.memberPermissions.has(
        PermissionFlagsBits.Administrator
      )) {
        return interaction.reply({
          content: "Bu komutu kullanma yetkin yok.",
          ephemeral: true,
        });
      }

      await interaction.reply({
        embeds: [createWaitlistEmbed()],
        components: createWaitlistButtons(),
      });

      return;
    }

    if (interaction.commandName === "tier") {
      if (interaction.options.getSubcommand() === "ver") {
        return giveTier(interaction);
      }
    }

    const queueKit = Object.entries(CONFIG.KITS)
      .find(([, kit]) => kit.queueCommand === interaction.commandName);

    if (queueKit) {
      return toggleQueueCommand(interaction, queueKit[0]);
    }

  } catch (error) {
    console.error("Interaction error:", error);

    const errorMessage = {
      content: "Bir hata oluştu. Bot konsolunu kontrol et.",
      ephemeral: true,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

/* =====================================================
   SİSTEM HATALARI
===================================================== */

process.on("unhandledRejection", error => {
  console.error("Unhandled Rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught Exception:", error);
});

/* =====================================================
   BOT GİRİŞ
===================================================== */

if (!process.env.TOKEN) {
  console.error("TOKEN eksik.");
  process.exit(1);
}

if (!process.env.CLIENT_ID) {
  console.error("CLIENT_ID eksik.");
  process.exit(1);
}

if (!process.env.GUILD_ID) {
  console.error("GUILD_ID eksik.");
  process.exit(1);
}

client.login(process.env.TOKEN);
