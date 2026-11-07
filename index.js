
require("dotenv").config();

const http = require("http");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  Colors,
} = require("discord.js");

const Database = require("better-sqlite3");

/* =====================================================
   AYARLAR
===================================================== */

const CONFIG = {
  COLOR: 0xD71920,
  WHITE: 0xFFFFFF,

  // Tier sonuçlarının gönderileceği kanal
  TIER_RESULT_CHANNEL_ID: "",

  // Tier işlemlerinin kaydedileceği log kanalı
  LOG_CHANNEL_ID: "",

  // Kuyruk ve tier yönetebilecek yetkili rol ID'leri
  // Boş bırakılırsa Yönetici / Sunucuyu Yönet yetkisi gerekir.
  STAFF_ROLE_IDS: [],

  KITS: {
    netpot: {
      name: "NETPOT",
      role: "NETPOT WAITLIST",
      queueCommand: "netpot-kuyruk",
    },
    sword: {
      name: "SWORD",
      role: "SWORD WAITLIST",
      queueCommand: "sword-kuyruk",
    },
    smp: {
      name: "SMP",
      role: "SMP WAITLIST",
      queueCommand: "smp-kuyruk",
    },
    cpvp: {
      name: "CPVP",
      role: "CPVP WAITLIST",
      queueCommand: "cpvp-kuyruk",
    },
    mace: {
      name: "MACE",
      role: "MACE WAITLIST",
      queueCommand: "mace-kuyruk",
    },
    axe: {
      name: "AXE",
      role: "AXE WAITLIST",
      queueCommand: "axe-kuyruk",
    },
    uhc: {
      name: "UHC",
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

function getQueue(kitId) {
  return db.prepare(`
    SELECT *
    FROM queues
    WHERE kit = ?
  `).get(kitId);
}

function getQueueEntries(kitId) {
  return db.prepare(`
    SELECT *
    FROM queue_entries
    WHERE kit = ?
    ORDER BY id ASC
  `).all(kitId);
}

/* =====================================================
   WAITLIST ROLLERİ
===================================================== */

async function getOrCreateWaitlistRole(guild, kit) {
  let role = guild.roles.cache.find(
    item => item.name === kit.role
  );

  if (!role) {
    role = await guild.roles.create({
      name: kit.role,
      color: CONFIG.WHITE,
      hoist: false,
      mentionable: false,
      reason: "HARLEM TIER LIST WAITLIST rolü",
    });

    console.log("WAITLIST rolü oluşturuldu:", role.name);
  }

  return role;
}

/* =====================================================
   WAITLIST PANELİ
===================================================== */

function createWaitlistEmbed() {
  const kitList = Object.values(CONFIG.KITS)
    .map(kit => `⚪ **${kit.name}**`)
    .join("\n");

  return new EmbedBuilder()
    .setColor(CONFIG.WHITE)
    .setTitle("WAITLIST")
    .setDescription(
      "WAITLIST almak istiyorsanız seçin."
    )
    .addFields({
      name: "ALL KITS",
      value: kitList,
      inline: false,
    })
    .setFooter({
      text: "HARLEM TIER LIST",
    });
}

function createWaitlistMenu() {
  const options = Object.entries(CONFIG.KITS).map(
    ([kitId, kit]) => ({
      label: kit.name,
      value: kitId,
      description: `${kit.name} WAITLIST rolünü al veya kaldır.`,
      emoji: "⚪",
    })
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId("waitlist:select")
    .setPlaceholder("Kit seçin...")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return [
    new ActionRowBuilder().addComponents(menu),
  ];
}

/* =====================================================
   KUYRUK PANELİ
===================================================== */

function createQueueEmbed(kitId, isOpen) {
  const kit = getKit(kitId);
  const entries = getQueueEntries(kitId);

  const playerList = entries.length
    ? entries.map((entry, index) =>
        `\`${index + 1}.\` **${entry.mc_name}**`
      ).join("\n")
    : "Henüz katılan oyuncu yok.";

  return new EmbedBuilder()
    .setColor(isOpen ? Colors.Green : Colors.Red)
    .setTitle(`${kit.name} KUYRUĞU`)
    .setDescription(
      isOpen
        ? "Kuyruk şu anda açık. Katılmak için aşağıdaki menüyü kullan."
        : "Kuyruk şu anda kapalı. Yeni oyuncu katılımı alınmıyor."
    )
    .addFields(
      {
        name: "Durum",
        value: isOpen ? "AÇIK" : "KAPALI",
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
      text: `HARLEM TIER LIST • ${kit.name}`,
    })
    .setTimestamp();
}

/* =====================================================
   KUYRUK BUTONLARI
===================================================== */

function createQueueButtons(kitId, isOpen) {
  const row = new ActionRowBuilder();

  if (isOpen) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue:join:${kitId}`)
        .setLabel("Kuyruğa Katıl")
        .setStyle(ButtonStyle.Success)
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:leave:${kitId}`)
      .setLabel("Kuyruktan Ayrıl")
      .setStyle(ButtonStyle.Secondary)
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:toggle:${kitId}`)
      .setLabel(isOpen ? "Kapat" : "Aç")
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

  const channel = await guild.channels.fetch(
    queue.channel_id
  ).catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  const message = await channel.messages.fetch(
    queue.message_id
  ).catch(() => null);

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
   KUYRUK AÇ / KAPAT
===================================================== */

async function toggleQueueCommand(interaction, kitId) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: "Bu kuyruğu yönetme yetkin yok.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const existing = getQueue(kitId);
  const kit = getKit(kitId);

  if (!existing) {
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
      content: `${kit.name} kuyruğu açıldı ve panel gönderildi.`,
    });
  }

  const newStatus = existing.is_open ? 0 : 1;

  db.prepare(`
    UPDATE queues
    SET is_open = ?
    WHERE kit = ?
  `).run(newStatus, kitId);

  await updateQueuePanel(interaction.guild, kitId);

  return interaction.editReply({
    content: newStatus
      ? `${kit.name} kuyruğu açıldı.`
      : `${kit.name} kuyruğu kapatıldı.`,
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
      flags: MessageFlags.Ephemeral,
    });
  }

  const cleanName = mcName.trim();
  const normalizedName = cleanName.toLowerCase();

  if (!/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) {
    return interaction.reply({
      content: "Geçerli bir Minecraft kullanıcı adı gir.",
      flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
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
    content:
      `${kit.name} kuyruğuna başarıyla katıldın.\n` +
      `Minecraft adı: \`${cleanName}\``,
    flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
  }

  const kit = getKit(kitId);

  await interaction.reply({
    content: `${kit.name} kuyruğundan ayrıldın.`,
    flags: MessageFlags.Ephemeral,
  });

  await updateQueuePanel(interaction.guild, kitId);
}

/* =====================================================
   TIER SONUÇ TASARIMI
===================================================== */

function createTierResultEmbed(data) {
  const kit = getKit(data.kitId);

  const embed = new EmbedBuilder()
    .setColor(CONFIG.COLOR)
    .setAuthor({
      name: "HARLEM TIER LIST • OFFICIAL RESULT",
    })
    .setTitle("TIER TEST RESULT")
    .setDescription(
      `**${data.playerName}** oyuncusunun tier testi sonucu açıklandı.`
    )
    .addFields(
      {
        name: "PLAYER",
        value: `\`${data.playerName}\``,
        inline: true,
      },
      {
        name: "KIT",
        value: `**${kit.name}**`,
        inline: true,
      },
      {
        name: "DISCORD",
        value: `${data.discordUser}\n\`${data.discordUser.tag}\``,
        inline: false,
      },
      {
        name: "PREVIOUS TIER",
        value: `\`${data.oldTier || "İlk kayıt"}\``,
        inline: true,
      },
      {
        name: "NEW TIER",
        value: `**${data.newTier}**`,
        inline: true,
      },
      {
        name: "TESTER",
        value: `${data.staffUser}`,
        inline: false,
      }
    )
    .setFooter({
      text: "HARLEM TIER LIST • OFFICIAL RANKING",
    })
    .setTimestamp();

  const avatar = data.discordUser.displayAvatarURL({
    extension: "png",
    size: 256,
  });

  embed.setThumbnail(avatar);

  return embed;
}

/* =====================================================
   TIER LOG TASARIMI
===================================================== */

function createTierLogEmbed(data) {
  const kit = getKit(data.kitId);

  return new EmbedBuilder()
    .setColor(CONFIG.COLOR)
    .setAuthor({
      name: "HARLEM TIER LIST • SYSTEM LOG",
    })
    .setTitle("TIER CHANGE LOG")
    .addFields(
      {
        name: "Minecraft Player",
        value: `\`${data.playerName}\``,
        inline: true,
      },
      {
        name: "Kit",
        value: kit.name,
        inline: true,
      },
      {
        name: "Previous Tier",
        value: `\`${data.oldTier || "İlk kayıt"}\``,
        inline: true,
      },
      {
        name: "New Tier",
        value: `\`${data.newTier}\``,
        inline: true,
      },
      {
        name: "Player Discord",
        value:
          `${data.discordUser.tag}\n` +
          `ID: \`${data.discordUser.id}\``,
        inline: false,
      },
      {
        name: "Staff",
        value:
          `${data.staffUser.tag}\n` +
          `ID: \`${data.staffUser.id}\``,
        inline: false,
      }
    )
    .setFooter({
      text: "HARLEM TIER LIST • LOG SYSTEM",
    })
    .setTimestamp();
}

/* =====================================================
   TIER VER
===================================================== */

async function giveTier(interaction) {
  if (!isStaff(interaction.member)) {
    return interaction.reply({
      content: "Tier verme yetkin bulunmuyor.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const kitId = interaction.options.getString("kit");
  const playerName = interaction.options.getString("oyuncu").trim();
  const newTier = interaction.options.getString("yeni_tier").trim();
  const discordUser = interaction.options.getUser("discord");

  if (!/^[A-Za-z0-9_]{3,16}$/.test(playerName)) {
    return interaction.reply({
      content: "Geçerli bir Minecraft oyuncu adı gir.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!newTier || newTier.length > 32) {
    return interaction.reply({
      content: "Geçerli bir tier adı gir.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!discordUser) {
    return interaction.reply({
      content: "Oyuncunun Discord hesabını seçmelisin.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const oldRecord = getTier(kitId, playerName);
  const oldTier = oldRecord?.tier || null;

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

  // Önce tier kaydını veritabanına kaydet.
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

  // Tier sonuç kanalını bul.
  const resultChannel = CONFIG.TIER_RESULT_CHANNEL_ID
    ? await interaction.guild.channels.fetch(
        CONFIG.TIER_RESULT_CHANNEL_ID
      ).catch(() => null)
    : interaction.channel;

  if (!resultChannel || !resultChannel.isTextBased()) {
    return interaction.editReply({
      content:
        "Tier veritabanına kaydedildi ancak TIER RESULT kanalı bulunamadı. " +
        "CONFIG içindeki TIER_RESULT_CHANNEL_ID değerini kontrol et.",
    });
  }

  // Sonuç embedini gönder.
  await resultChannel.send({
    embeds: [resultEmbed],
  });

  // Log kanalına detayları gönder.
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

  return interaction.editReply({
    content:
      `**${playerName}** oyuncusunun ${getKit(kitId).name} tierı güncellendi.\n` +
      `Eski: \`${oldTier || "İlk kayıt"}\` → Yeni: \`${newTier}\`\n` +
      `Sonuç TIER RESULT kanalına gönderildi.`,
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
      .setDescription("WAITLIST rollerini oluşturur.")
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator
      )
  );

  commands.push(
    new SlashCommandBuilder()
      .setName("waitlist-panel")
      .setDescription("WAITLIST seçim panelini gönderir.")
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator
      )
  );

  const tierCommand = new SlashCommandBuilder()
    .setName("tier")
    .setDescription("HARLEM TIER LIST tier yönetimi.");

  tierCommand.addSubcommand(sub =>
    sub
      .setName("ver")
      .setDescription("Oyuncuya yeni tier verir.")
      .addStringOption(option =>
        option
          .setName("oyuncu")
          .setDescription("Minecraft oyuncu adı")
          .setRequired(true)
      )
      .addUserOption(option =>
        option
          .setName("discord")
          .setDescription("Oyuncunun Discord hesabı")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("kit")
          .setDescription("Test edilen kit")
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
          .setName("yeni_tier")
          .setDescription("Verilecek yeni tier")
          .setRequired(true)
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

  console.log("Slash komutları başarıyla kaydedildi.");
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
    /* WAITLIST SEÇİM MENÜSÜ */

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === "waitlist:select"
    ) {
      const kitId = interaction.values[0];
      const kit = getKit(kitId);

      if (!kit) {
        return interaction.reply({
          content: "Kit bulunamadı.",
          flags: MessageFlags.Ephemeral,
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
          content: `${kit.name} WAITLIST rolün kaldırıldı.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      await member.roles.add(role);

      return interaction.reply({
        content: `${kit.name} WAITLIST rolünü aldın.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    /* KUYRUK BUTONLARI */

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("queue:")
    ) {
      const parts = interaction.customId.split(":");
      const action = parts[1];
      const kitId = parts[2];

      if (!getKit(kitId)) {
        return interaction.reply({
          content: "Kit bulunamadı.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (action === "join") {
        const queue = getQueue(kitId);

        if (!queue || !queue.is_open) {
          return interaction.reply({
            content: "Bu kuyruk kapalı.",
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.showModal(
          createJoinModal(kitId)
        );
      }

      if (action === "leave") {
        return removeQueuePlayer(interaction, kitId);
      }

      if (action === "toggle") {
        if (!isStaff(interaction.member)) {
          return interaction.reply({
            content: "Bu işlemi yapma yetkin yok.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const queue = getQueue(kitId);

        if (!queue) {
          return interaction.reply({
            content: "Kuyruk kaydı bulunamadı.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const newStatus = queue.is_open ? 0 : 1;

        db.prepare(`
          UPDATE queues
          SET is_open = ?
          WHERE kit = ?
        `).run(newStatus, kitId);

        await interaction.deferUpdate();

        await updateQueuePanel(
          interaction.guild,
          kitId
        );

        return;
      }
    }

    /* KUYRUK MODALI */

    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("queue:modal:")
    ) {
      const kitId = interaction.customId.split(":")[2];

      const mcName = interaction.fields.getTextInputValue(
        "minecraft_name"
      );

      return addQueuePlayer(
        interaction,
        kitId,
        mcName
      );
    }

    /* SLASH KOMUTLARI */

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "waitlist-kur") {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      const created = [];

      for (const kit of Object.values(CONFIG.KITS)) {
        const role = await getOrCreateWaitlistRole(
          interaction.guild,
          kit
        );

        created.push(role.name);
      }

      return interaction.editReply({
        content:
          "**WAITLIST rolleri hazır.**\n\n" +
          created.map(name => `• ${name}`).join("\n") +
          "\n\nKanal oluşturulmadı ve kanal izinleri değiştirilmedi.",
      });
    }

    if (interaction.commandName === "waitlist-panel") {
      if (!interaction.memberPermissions.has(
        PermissionFlagsBits.Administrator
      )) {
        return interaction.reply({
          content: "Bu komutu kullanma yetkin yok.",
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        embeds: [createWaitlistEmbed()],
        components: createWaitlistMenu(),
      });
    }

    if (interaction.commandName === "tier") {
      if (interaction.options.getSubcommand() === "ver") {
        return giveTier(interaction);
      }
    }

    const queueKit = Object.entries(CONFIG.KITS)
      .find(([, kit]) =>
        kit.queueCommand === interaction.commandName
      );

    if (queueKit) {
      return toggleQueueCommand(
        interaction,
        queueKit[0]
      );
    }

  } catch (error) {
    console.error("Interaction error:", error);

    const errorMessage = {
      content: "Bir hata oluştu. Bot konsolunu kontrol et.",
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

/* =====================================================
   RENDER HTTP SERVER
===================================================== */

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
  });

  res.end("HARLEM TIER LIST BOT ACTIVE");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server çalışıyor: ${PORT}`);
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
