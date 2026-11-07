
require('dotenv').config();

const http = require('http');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Events,
  REST,
  Routes,
} = require('discord.js');

// ==========================================
//              BOT AYARLARI
// ==========================================

const {
  DISCORD_TOKEN,
  GUILD_ID,
  TESTER_ROLE_ID,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID) {
  throw new Error('DISCORD_TOKEN veya GUILD_ID eksik!');
}

const KITS = {
  sword: {
    name: 'SWORD',
    emoji: '⚔️',
    color: 0x3498DB,
    description: 'Sword kitini alarak Sword test kanalına erişim kazan.',
  },
  crystal: {
    name: 'CRYSTAL',
    emoji: '💎',
    color: 0x9B59B6,
    description: 'Crystal kitini alarak Crystal test kanalına erişim kazan.',
  },
  axe: {
    name: 'AXE',
    emoji: '🪓',
    color: 0xE67E22,
    description: 'Axe kitini alarak Axe test kanalına erişim kazan.',
  },
  pot: {
    name: 'POT',
    emoji: '🧪',
    color: 0x2ECC71,
    description: 'Pot kitini alarak Pot test kanalına erişim kazan.',
  },
  nethpot: {
    name: 'NETHPOT',
    emoji: '🔥',
    color: 0xE74C3C,
    description: 'NethPot kitini alarak NethPot test kanalına erişim kazan.',
  },
  smp: {
    name: 'SMP',
    emoji: '🛡️',
    color: 0xF1C40F,
    description: 'SMP kitini alarak SMP test kanalına erişim kazan.',
  },
  uhc: {
    name: 'UHC',
    emoji: '🏹',
    color: 0x1ABC9C,
    description: 'UHC kitini alarak UHC test kanalına erişim kazan.',
  },
  vanilla: {
    name: 'VANILLA',
    emoji: '🌿',
    color: 0x95A5A6,
    description: 'Vanilla kitini alarak Vanilla test kanalına erişim kazan.',
  },
};

// ==========================================
//              DISCORD CLIENT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// ==========================================
//              SLASH KOMUTLARI
// ==========================================

const kitChoices = Object.entries(KITS).map(([key, kit]) => ({
  name: `${kit.emoji} ${kit.name}`,
  value: key,
}));

const commands = [
  new SlashCommandBuilder()
    .setName('kuyruk')
    .setDescription('Bir kit için WAITLIST paneli oluşturur.')
    .addStringOption(option =>
      option
        .setName('kit')
        .setDescription('WAITLIST kurulacak kit')
        .setRequired(true)
        .addChoices(...kitChoices)
    ),

  new SlashCommandBuilder()
    .setName('waitlist')
    .setDescription('Seçilen kitin WAITLIST listesini gösterir.')
    .addStringOption(option =>
      option
        .setName('kit')
        .setDescription('Görüntülenecek kit')
        .setRequired(true)
        .addChoices(...kitChoices)
    ),
].map(command => command.toJSON());

// ==========================================
//              YETKİ KONTROLÜ
// ==========================================

async function testerMi(interaction) {
  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!member) return false;

  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  if (TESTER_ROLE_ID && member.roles.cache.has(TESTER_ROLE_ID)) {
    return true;
  }

  return false;
}

// ==========================================
//              WAITLIST ROLÜ
// ==========================================

async function rolBulVeyaOlustur(guild, kitKey) {
  const kit = KITS[kitKey];
  const roleName = `${kit.name} WAITLIST`;

  let role = guild.roles.cache.find(
    role => role.name === roleName
  );

  if (!role) {
    role = await guild.roles.create({
      name: roleName,
      color: kit.color,
      reason: `${kit.name} WAITLIST sistemi`,
    });

    console.log(`Yeni rol oluşturuldu: ${roleName}`);
  }

  return role;
}

// ==========================================
//              WAITLIST PANELİ
// ==========================================

function panelOlustur(kitKey) {
  const kit = KITS[kitKey];

  const embed = new EmbedBuilder()
    .setColor(kit.color)
    .setTitle(`${kit.emoji} ${kit.name} WAITLIST`)
    .setDescription(
      [
        '```ansi',
        '  ✦ TIER TEST WAITLIST ✦',
        '```',
        `**${kit.description}**`,
        '',
        '┏━━━━━━━━━━━━━━━━━━━━━━┓',
        `┃ ${kit.emoji}  **KIT:** ${kit.name}`,
        '┃',
        '┃  Aşağıdaki butona basarak',
        '┃  bu kitin WAITLIST rolünü alabilirsin.',
        '┗━━━━━━━━━━━━━━━━━━━━━━┛',
        '',
        '• Rolü aldıktan sonra ilgili kit kanalını görebilirsin.',
        '• Kitten ayrılmak için butona tekrar basabilirsin.',
      ].join('\n')
    )
    .setFooter({
      text: 'TIER TEST SYSTEM • WAITLIST',
    })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`waitlist:${kitKey}`)
      .setLabel(`${kit.name} KİTİNİ AL`)
      .setEmoji(kit.emoji)
      .setStyle(ButtonStyle.Primary)
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

// ==========================================
//              WAITLIST LİSTESİ
// ==========================================

async function waitlistGoster(interaction, kitKey) {
  const kit = KITS[kitKey];

  await interaction.deferReply({ ephemeral: true });

  const role = await rolBulVeyaOlustur(
    interaction.guild,
    kitKey
  );

  // Sunucudaki üyeleri getir.
  await interaction.guild.members.fetch();

  const members = role.members;

  const liste = members.map((member, index) => {
    return `**${index + 1}.** ${member} — \`${member.user.username}\``;
  });

  const embed = new EmbedBuilder()
    .setColor(kit.color)
    .setTitle(`${kit.emoji} ${kit.name} WAITLIST`)
    .setDescription(
      liste.length
        ? liste.slice(0, 25).join('\n')
        : '*Şu anda bu kitte kimse bulunmuyor.*'
    )
    .addFields({
      name: 'Toplam Oyuncu',
      value: `**${members.size}**`,
      inline: true,
    })
    .setFooter({
      text: 'TIER TEST SYSTEM • WAITLIST',
    })
    .setTimestamp();

  if (members.size > 25) {
    embed.setFooter({
      text: `İlk 25 oyuncu gösteriliyor • Toplam ${members.size} oyuncu`,
    });
  }

  return interaction.editReply({
    embeds: [embed],
  });
}

// ==========================================
//              KOMUT İŞLEMLERİ
// ==========================================

client.on(Events.InteractionCreate, async interaction => {
  try {
    // SLASH COMMANDS
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) {
        return interaction.reply({
          content: 'Bu komut sadece sunucuda kullanılabilir.',
          ephemeral: true,
        });
      }

      const kitKey = interaction.options.getString('kit');
      const kit = KITS[kitKey];

      if (!kit) {
        return interaction.reply({
          content: 'Geçersiz kit.',
          ephemeral: true,
        });
      }

      // /kuyruk
      if (interaction.commandName === 'kuyruk') {
        if (!(await testerMi(interaction))) {
          return interaction.reply({
            content: 'Bu komutu sadece testerlar ve yöneticiler kullanabilir.',
            ephemeral: true,
          });
        }

        await rolBulVeyaOlustur(interaction.guild, kitKey);

        await interaction.reply({
          ...panelOlustur(kitKey),
        });

        console.log(
          `${interaction.user.tag} ${kit.name} WAITLIST panelini oluşturdu.`
        );

        return;
      }

      // /waitlist
      if (interaction.commandName === 'waitlist') {
        if (!(await testerMi(interaction))) {
          return interaction.reply({
            content: 'Bu komutu sadece testerlar ve yöneticiler kullanabilir.',
            ephemeral: true,
          });
        }

        return waitlistGoster(interaction, kitKey);
      }
    }

    // WAITLIST BUTTON
    if (interaction.isButton()) {
      if (!interaction.customId.startsWith('waitlist:')) return;

      if (!interaction.inGuild()) return;

      const kitKey = interaction.customId.split(':')[1];
      const kit = KITS[kitKey];

      if (!kit) {
        return interaction.reply({
          content: 'Bu kit artık mevcut değil.',
          ephemeral: true,
        });
      }

      const role = await rolBulVeyaOlustur(
        interaction.guild,
        kitKey
      );

      const member = await interaction.guild.members.fetch(
        interaction.user.id
      );

      // Rol varsa kaldır, yoksa ver.
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role);

        return interaction.reply({
          content:
            `${kit.emoji} **${kit.name} WAITLIST** rolünden ayrıldın.`,
          ephemeral: true,
        });
      }

      await member.roles.add(role);

      return interaction.reply({
        content:
          `${kit.emoji} **${kit.name} WAITLIST** rolünü aldın!\n` +
          'Artık bu kit için izin verilen kanalları görebilirsin.',
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error('INTERACTION ERROR:', error);

    const message =
      'Bir hata oluştu. Bot izinlerini ve rol sıralamasını kontrol et.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: message,
        ephemeral: true,
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

// ==========================================
//              KOMUT KAYDI
// ==========================================

client.once(Events.ClientReady, async () => {
  console.log(`Bot giriş yaptı: ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(
      DISCORD_TOKEN
    );

    await rest.put(
      Routes.applicationGuildCommands(
        client.user.id,
        GUILD_ID
      ),
      { body: commands }
    );

    console.log('Slash komutları başarıyla kaydedildi.');
  } catch (error) {
    console.error('KOMUT KAYIT HATASI:', error);
  }
});

// ==========================================
//              RENDER HTTP SERVER
// ==========================================

http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
  });

  res.end('TIER TEST BOT ONLINE');
}).listen(process.env.PORT || 3000, () => {
  console.log('HTTP server çalışıyor.');
});

// ==========================================
//              BOT LOGIN
// ==========================================

client.login(DISCORD_TOKEN);
