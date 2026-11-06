// ==========================================================================
//  TIER TEST BOT - discord.js v14
// ==========================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('DISCORD_TOKEN ve GUILD_ID ortam değişkenleri zorunlu!');
  process.exit(1);
}

const TIERLER = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
const VARSAYILAN_KITLER = ['Crystal', 'Sword', 'Axe', 'Pot', 'NethPot', 'SMP', 'UHC', 'Vanilla'];
const RENK = { ana: 0x5865f2, basari: 0x2ecc71, uyari: 0xf1c40f, hata: 0xe74c3c, gri: 0x95a5a6 };
const GUN = 86400000;
const GIZLI = MessageFlags.Ephemeral;
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;
const KIT_REGEX = /^[A-Za-z0-9 _+-]{1,20}$/;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

function varsayilanDurum() {
  return {
    settings: {
      testerRoleId: process.env.TESTER_ROLE_ID || '',
      resultChannelId: process.env.RESULT_CHANNEL_ID || '',
      ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
      logChannelId: process.env.LOG_CHANNEL_ID || '',
      cooldownDays: 14,
      maxQueue: 50,
      autoRole: true,
      kits: [...VARSAYILAN_KITLER],
      roleMap: {},
    },
    queue: [],
    cooldowns: {},
    results: {},
    activeTesters: {},
    tickets: {},
    stats: {},
    panel: null,
  };
}

let state = varsayilanDurum();

function yukle() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const kayit = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const v = varsayilanDurum();
    state = { ...v, ...kayit, settings: { ...v.settings, ...(kayit.settings || {}) } };

    for (const k of ['testerRoleId', 'resultChannelId', 'ticketCategoryId', 'logChannelId']) {
      state.settings[k] = (kayit.settings && kayit.settings[k]) || v.settings[k];
    }

    if (!Array.isArray(state.settings.kits) || !state.settings.kits.length) {
      state.settings.kits = [...VARSAYILAN_KITLER];
    }

    console.log('data.json yüklendi.');
  } catch (e) {
    console.log('data.json okunamadı, sıfırdan başlanıyor:', e.message);
  }
}

function hemenKaydet() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.log('data.json yazılamadı:', e.message);
  }
}

let kaydetZamanlayici = null;

function kaydet() {
  clearTimeout(kaydetZamanlayici);
  kaydetZamanlayici = setTimeout(hemenKaydet, 1500);
}

const S = () => state.settings;
const zaman = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

function kitBul(ad) {
  if (!ad) return null;
  return S().kits.find((k) => k.toLowerCase() === String(ad).toLowerCase()) || null;
}

function yoneticiMi(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function testerMi(member) {
  if (yoneticiMi(member)) return true;
  return Boolean(S().testerRoleId) && member.roles.cache.has(S().testerRoleId);
}

function cooldownKalan(userId, kit) {
  const bitis = state.cooldowns[`${userId}:${kit}`];
  return bitis && bitis > Date.now() ? bitis : null;
}

function aktifTesterler(kit) {
  return Object.entries(state.activeTesters)
    .filter(([, kitler]) => kitler.includes(kit))
    .map(([id]) => id);
}

function acikTestVarMi(userId, kit) {
  return Object.values(state.tickets).some((t) => t.userId === userId && t.kit === kit);
}

async function logla(guild, metin) {
  if (!S().logChannelId) return;
  try {
    const kanal = await guild.channels.fetch(S().logChannelId);
    if (kanal) await kanal.send({ content: metin, allowedMentions: { parse: [] } });
  } catch (e) {
    console.log('Log gönderilemedi:', e.message);
  }
}

// ==========================================================================
// ROL SİSTEMİ
// Rol yoksa otomatik oluşturur. Örnek: Crystal HT1
// ==========================================================================

function tierRoluBul(guild, kit, tier) {
  const eslesen = S().roleMap[`${kit}:${tier}`];

  if (eslesen) {
    const rol = guild.roles.cache.get(eslesen);
    if (rol) return rol;
  }

  const ad = `${kit} ${tier}`.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === ad) || null;
}

function rolTierleri(member) {
  const sonuc = {};

  for (const kit of S().kits) {
    for (const tier of TIERLER) {
      const rol = tierRoluBul(member.guild, kit, tier);

      if (rol && member.roles.cache.has(rol.id) && !sonuc[kit]) {
        sonuc[kit] = tier;
      }
    }
  }

  return sonuc;
}

async function rolVer(guild, uye, kit, tier) {
  let yeni = tierRoluBul(guild, kit, tier);

  try {
    if (!yeni) {
      yeni = await guild.roles.create({
        name: `${kit} ${tier}`,
        reason: `Otomatik tier rolü: ${kit} ${tier}`,
      });
    }

    const eskiler = TIERLER.map((t) => tierRoluBul(guild, kit, t)).filter(
      (r) => r && r.id !== yeni.id && uye.roles.cache.has(r.id)
    );

    if (eskiler.length) {
      await uye.roles.remove(eskiler, `${kit} tier güncellendi`);
    }

    await uye.roles.add(yeni, `${kit} ${tier} tier rolü verildi`);

    return `Rol oluşturuldu/verildi: ${yeni}`;
  } catch (e) {
    console.error('Tier rolü oluşturulamadı/verilemedi:', e);
    return 'Rol verilemedi. Botta Rolleri Yönet izni olmalı ve botun rolü, verilecek rollerin üstünde bulunmalı.';
  }
}

// ==========================================================================
// KUYRUK SİSTEMİ - TEK GENEL KUYRUK
// ==========================================================================

function kuyrugaEkle(userId, nick) {
  if (!NICK_REGEX.test(nick)) {
    return {
      ok: false,
      msg: 'Geçersiz Minecraft kullanıcı adı (3-16 karakter; harf, rakam ve _).',
    };
  }

  if (state.queue.some((k) => k.userId === userId)) {
    return { ok: false, msg: 'Zaten kuyruktasın.' };
  }

  if (state.queue.length >= S().maxQueue) {
    return {
      ok: false,
      msg: `Kuyruk dolu (${S().maxQueue} kişi). Daha sonra tekrar dene.`,
    };
  }

  state.queue.push({
    userId,
    nick,
    joined: Date.now(),
    kit: null,
  });

  kaydet();
  panelGuncelle();

  return {
    ok: true,
    msg: `Kuyruğa katıldın. Sıran: ${siraBul(userId)}.`,
  };
}

function kuyruktanCikar(userId) {
  const idx = state.queue.findIndex((k) => k.userId === userId);

  if (idx === -1) return false;

  state.queue.splice(idx, 1);
  kaydet();
  panelGuncelle();

  return true;
}

function siraBul(userId) {
  const idx = state.queue.findIndex((k) => k.userId === userId);
  return idx === -1 ? 0 : idx + 1;
}

function kuyrukListesi() {
  return state.queue;
}

// ==========================================================================
// KUYRUK PANELİ
// ==========================================================================

function panelEmbed() {
  const liste = kuyrukListesi();

  const aciklama = liste.length
    ? liste
        .slice(0, 25)
        .map(
          (k, n) =>
            `**${n + 1}.** <@${k.userId}> • \`${k.nick}\` • ${zaman(k.joined)}`
        )
        .join('\n') +
      (liste.length > 25 ? `\n... ve ${liste.length - 25} kişi daha` : '')
    : 'Kuyruk şu anda boş.';

  return new EmbedBuilder()
    .setTitle('Tier Test Kuyruğu')
    .setColor(RENK.ana)
    .setDescription(
      'Test sırasına girmek için **Katıl** butonuna basıp Minecraft kullanıcı adını yaz.\n' +
        'Kuyruktan ayrılmak için **Çık** butonunu kullan.\n\n' +
        `**Bekleyen oyuncu:** ${liste.length}\n\n${aciklama}`
    )
    .setFooter({ text: 'Kuyruk otomatik güncellenir.' })
    .setTimestamp();
}

function panelBilesenleri() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('wl_join')
        .setLabel('Katıl')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('wl_leave')
        .setLabel('Çık')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

let panelZamanlayici = null;

function panelGuncelle() {
  clearTimeout(panelZamanlayici);

  panelZamanlayici = setTimeout(async () => {
    if (!state.panel) return;

    try {
      const kanal = await client.channels.fetch(state.panel.channelId);
      const mesaj = await kanal.messages.fetch(state.panel.messageId);

      await mesaj.edit({
        embeds: [panelEmbed()],
        components: panelBilesenleri(),
      });
    } catch (e) {
      console.log('Panel güncellenemedi:', e.message);
    }
  }, 1200);
}

// ==========================================================================
// SLASH KOMUTLARI
// ==========================================================================

const kitOpt = (o, zorunlu = true) =>
  o
    .setName('kit')
    .setDescription('Kit seç')
    .setRequired(zorunlu)
    .setAutocomplete(true);

const tierOpt = (o) =>
  o
    .setName('tier')
    .setDescription('Tier')
    .setRequired(true)
    .addChoices(...TIERLER.map((t) => ({ name: t, value: t })));

const YONETIM = PermissionFlagsBits.ManageGuild;

const komutTanimlari = [
  new SlashCommandBuilder()
    .setName('kuyruk')
    .setDescription('Katıl/Çık butonlarıyla test kuyruğunu aç'),

  new SlashCommandBuilder()
    .setName('siram')
    .setDescription('Kuyruktaki sıranı göster'),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Bir oyuncunun tierlerini göster')
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Oyuncu (boşsa sen)')
    ),

  new SlashCommandBuilder()
    .setName('istatistik')
    .setDescription('Test istatistikleri'),

  new SlashCommandBuilder()
    .setName('test-baslat')
    .setDescription('[Tester] Sıradaki oyuncuyla test kanalı aç')
    .addStringOption((o) => kitOpt(o))
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Belirli bir oyuncuyu al (boşsa sıradaki)')
    ),

  new SlashCommandBuilder()
    .setName('tier-ver')
    .setDescription('[Tester] Oyuncuya tier ver')
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Oyuncu').setRequired(true)
    )
    .addStringOption((o) => kitOpt(o))
    .addStringOption((o) => tierOpt(o))
    .addStringOption((o) =>
      o.setName('nick').setDescription('Minecraft nicki').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('kapat')
    .setDescription('[Tester] Test kanalını kapat'),

  new SlashCommandBuilder()
    .setName('tester')
    .setDescription('[Tester] Aktif/pasif durumu')
    .addSubcommand((s) =>
      s
        .setName('aktif')
        .setDescription('Bir kitte test almaya hazırım')
        .addStringOption((o) => kitOpt(o))
    )
    .addSubcommand((s) =>
      s
        .setName('pasif')
        .setDescription('Aktifliği kapat (kit yazmazsan hepsi)')
        .addStringOption((o) => kitOpt(o, false))
    )
    .addSubcommand((s) =>
      s.setName('liste').setDescription('Aktif testerları göster')
    ),

  new SlashCommandBuilder()
    .setName('kuyruk-at')
    .setDescription('[Tester] Bir oyuncuyu kuyruktan çıkar')
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Oyuncu').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('cooldown-sifirla')
    .setDescription('[Tester] Oyuncunun cooldown süresini sıfırla')
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Oyuncu').setRequired(true)
    )
    .addStringOption((o) => kitOpt(o)),

  new SlashCommandBuilder()
    .setName('panel-kur')
    .setDescription('[Yönetici] Bekleme listesi panelini gönder')
    .setDefaultMemberPermissions(YONETIM)
    .addChannelOption((o) =>
      o
        .setName('kanal')
        .setDescription('Panelin gönderileceği kanal (boşsa bu kanal)')
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName('kuyruk-temizle')
    .setDescription('[Yönetici] Genel kuyruğu tamamen boşalt')
    .setDefaultMemberPermissions(YONETIM),

  new SlashCommandBuilder()
    .setName('ayar')
    .setDescription('[Yönetici] Bot ayarları')
    .setDefaultMemberPermissions(YONETIM)
    .addSubcommand((s) =>
      s.setName('goster').setDescription('Mevcut ayarları göster')
    )
    .addSubcommand((s) =>
      s
        .setName('tester-rol')
        .setDescription('Tester rolünü belirle')
        .addRoleOption((o) =>
          o.setName('rol').setDescription('Tester rolü').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('sonuc-kanal')
        .setDescription('Sonuçların duyurulacağı kanal')
        .addChannelOption((o) =>
          o
            .setName('kanal')
            .setdescription?.('Kanal')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('log-kanal')
        .setDescription('Bot kayıtlarının yazılacağı kanal')
        .addChannelOption((o) =>
          o
            .setName('kanal')
            .setDescription('Kanal')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('ticket-kategori')
        .setDescription('Test kanallarının açılacağı kategori')
        .addChannelOption((o) =>
          o
            .setName('kategori')
            .setDescription('Kategori')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('cooldown')
        .setDescription('Tekrar test bekleme süresi (gün)')
        .addIntegerOption((o) =>
          o
            .setName('gun')
            .setDescription('Gün (0 = kapalı)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(90)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('max-kuyruk')
        .setDescription('Genel kuyruktaki en fazla kişi')
        .addIntegerOption((o) =>
          o
            .setName('adet')
            .setDescription('Adet')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(200)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('kit-ekle')
        .setDescription('Yeni kit ekle')
        .addStringOption((o) =>
          o
            .setName('isim')
            .setDescription('Kit adı (en fazla 20 karakter)')
            .setRequired(true)
            .setMaxLength(20)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('kit-sil')
        .setDescription('Bir kiti sil')
        .addStringOption((o) => kitOpt(o))
    )
    .addSubcommand((s) =>
      s
        .setName('rol-esle')
        .setDescription('Kit + tier için hazır bir rolü eşle')
        .addStringOption((o) => kitOpt(o))
        .addStringOption((o) => tierOpt(o))
        .addRoleOption((o) =>
          o.setName('rol').setDescription('Hazır rol').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('rol-esle-sil')
        .setDescription('Rol eşlemesini kaldır')
        .addStringOption((o) => kitOpt(o))
        .addStringOption((o) => tierOpt(o))
    )
    .addSubcommand((s) =>
      s
        .setName('rol-kontrol')
        .setDescription('Hangi kit/tier rolleri bulunuyor, hangileri eksik')
    ),
].map((c) => c.toJSON());

const TESTER_KOMUTLARI = new Set([
  'test-baslat',
  'tier-ver',
  'kapat',
  'tester',
  'kuyruk-at',
  'cooldown-sifirla',
]);

const YONETICI_KOMUTLARI = new Set([
  'panel-kur',
  'kuyruk-temizle',
  'ayar',
]);

// ==========================================================================
// KOMUT İŞLEYİCİLERİ
// ==========================================================================

const komutlar = {};

komutlar.kuyruk = async (i) => {
  const mesaj = await i.channel.send({
    embeds: [panelEmbed()],
    components: panelBilesenleri(),
  });

  state.panel = {
    channelId: i.channelId,
    messageId: mesaj.id,
  };

  kaydet();

  return i.reply({
    content: 'Kuyruk paneli gönderildi.',
    flags: GIZLI,
  });
};

komutlar.siram = async (i) => {
  const sira = siraBul(i.user.id);
  const kayit = state.queue.find((k) => k.userId === i.user.id);

  return i.reply({
    content: sira
      ? `Kuyruktaki sıran: **${sira}** • Minecraft: \`${kayit.nick}\` • Toplam: **${state.queue.length}** kişi.`
      : 'Kuyrukta değilsin.',
    flags: GIZLI,
  });
};

komutlar.profil = async (i) => {
  const uye = i.options.getMember('oyuncu') || i.member;
  const tierler = {};
  let nick = null;

  for (const kit of S().kits) {
    const kayit = state.results[`${uye.id}:${kit}`];

    if (kayit) {
      tierler[kit] = kayit.tier;
      nick = kayit.nick;
    }
  }

  const roller = rolTierleri(uye);

  for (const [kit, tier] of Object.entries(roller)) {
    if (!tierler[kit]) tierler[kit] = tier;
  }

  const kitler = Object.keys(tierler);

  if (!kitler.length) {
    return i.reply({
      content: `${uye.displayName} henüz test olmamış.`,
      flags: GIZLI,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`${nick || uye.displayName} - Tierler`)
    .setColor(RENK.uyari)
    .setThumbnail(uye.displayAvatarURL());

  for (const kit of kitler) {
    const cd = cooldownKalan(uye.id, kit);

    embed.addFields({
      name: kit,
      value: `**${tierler[kit]}**${cd ? `\nCooldown: ${zaman(cd)}` : ''}`,
      inline: true,
    });
  }

  return i.reply({ embeds: [embed] });
};

komutlar.istatistik = async (i) => {
  const toplam = Object.values(state.stats).reduce(
    (a, s) => a + s.tests,
    0
  );

  const ilk = Object.entries(state.stats)
    .sort((a, b) => b[1].tests - a[1].tests)
    .slice(0, 5)
    .map(
      ([id, s], n) => `**${n + 1}.** <@${id}> • ${s.tests} test`
    );

  const embed = new EmbedBuilder()
    .setTitle('Test İstatistikleri')
    .setColor(RENK.ana)
    .addFields(
      {
        name: 'Toplam test',
        value: String(toplam),
        inline: true,
      },
      {
        name: 'Kuyrukta bekleyen',
        value: String(state.queue.length),
        inline: true,
      },
      {
        name: 'Açık test kanalı',
        value: String(Object.keys(state.tickets).length),
        inline: true,
      },
      {
        name: 'En aktif testerlar',
        value: ilk.length ? ilk.join('\n') : 'Henüz test yapılmadı',
      }
    );

  return i.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
};

// ==========================================================================
// TEST BAŞLAT
// ==========================================================================

komutlar['test-baslat'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kit = kitBul(i.options.getString('kit'));

  if (!kit) {
    return i.editReply('Bu kit mevcut değil.');
  }

  const hedef = i.options.getUser('oyuncu');
  let idx;
  let giris;

  if (hedef) {
    idx = state.queue.findIndex((k) => k.userId === hedef.id);

    giris =
      idx !== -1
        ? state.queue[idx]
        : {
            userId: hedef.id,
            kit,
            nick: hedef.username,
          };
  } else {
    idx = state.queue.length ? 0 : -1;

    if (idx === -1) {
      return i.editReply('Genel kuyruk boş.');
    }

    giris = state.queue[idx];
  }

  giris.kit = kit;

  const cd = cooldownKalan(giris.userId, kit);

  if (cd) {
    return i.editReply(
      `Bu oyuncu **${kit}** için cooldown'da. Süre: ${zaman(cd)}. Kuyruktaki kaydı korunuyor.`
    );
  }

  if (acikTestVarMi(giris.userId, kit)) {
    return i.editReply(
      'Bu oyuncunun bu kitte zaten açık bir test kanalı var.'
    );
  }

  const uye = await i.guild.members.fetch(giris.userId).catch(() => null);

  if (!uye) {
    if (idx !== -1) {
      state.queue.splice(idx, 1);
    }

    kaydet();
    panelGuncelle();

    return i.editReply(
      'Oyuncu sunucudan ayrılmış, kuyruktan silindi. Tekrar dene.'
    );
  }

  const izinler = [
    {
      id: i.guild.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: uye.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: i.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];

  if (S().testerRoleId && i.guild.roles.cache.has(S().testerRoleId)) {
    izinler.push({
      id: S().testerRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const kanalAdi = `test-${giris.nick}-${kit}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 90);

  const kanal = await i.guild.channels.create({
    name: kanalAdi,
    type: ChannelType.GuildText,
    parent: S().ticketCategoryId || null,
    permissionOverwrites: izinler,
  });

  if (idx !== -1) {
    state.queue.splice(idx, 1);
  }

  state.tickets[kanal.id] = {
    userId: uye.id,
    testerId: i.user.id,
    kit,
    nick: giris.nick,
    at: Date.now(),
  };

  kaydet();
  panelGuncelle();

  const embed = new EmbedBuilder()
    .setTitle(`${kit} Testi`)
    .setColor(RENK.ana)
    .addFields(
      {
        name: 'Oyuncu',
        value: `${uye}`,
        inline: true,
      },
      {
        name: 'Tester',
        value: `${i.user}`,
        inline: true,
      },
      {
        name: 'Nick',
        value: `\`${giris.nick}\``,
        inline: true,
      }
    )
    .setDescription(
      'Test bitince tester `/tier-ver` ve ardından `/kapat` kullanacak.'
    );

  await kanal.send({
    content: `${uye} test sırası sende!`,
    embeds: [embed],
  });

  await logla(
    i.guild,
    `${i.user.tag} → ${uye.user.tag} için **${kit}** testi başlattı (#${kanal.name}).`
  );

  const sonraki = kuyrukListesi()[0];

  return i.editReply(
    `Kanal açıldı: ${kanal}${
      sonraki
        ? `\nSıradaki oyuncu: <@${sonraki.userId}> (\`${sonraki.nick}\`)`
        : '\nKuyrukta başka kimse yok.'
    }`
  );
};

// ==========================================================================
// TIER VER
// ==========================================================================

komutlar['tier-ver'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kit = kitBul(i.options.getString('kit'));
  const tier = i.options.getString('tier');
  const nick = i.options.getString('nick').trim();
  const uye = i.options.getMember('oyuncu');

  if (!kit) return i.editReply('Bu kit mevcut değil.');
  if (!uye) return i.editReply('Oyuncu sunucuda bulunamadı.');
  if (!TIERLER.includes(tier)) return i.editReply('Geçersiz tier.');

  const anahtar = `${uye.id}:${kit}`;
  const onceki = state.results[anahtar]
    ? state.results[anahtar].tier
    : null;

  state.results[anahtar] = {
    tier,
    nick,
    testerId: i.user.id,
    at: Date.now(),
  };

  if (S().cooldownDays > 0) {
    state.cooldowns[anahtar] =
      Date.now() + S().cooldownDays * GUN;
  }

  const st = state.stats[i.user.id] || {
    tests: 0,
    last: 0,
  };

  st.tests += 1;
  st.last = Date.now();
  state.stats[i.user.id] = st;

  kaydet();

  const rolNotu = await rolVer(i.guild, uye, kit, tier);

  const embed = new EmbedBuilder()
    .setTitle('Test Sonucu')
    .setColor(RENK.basari)
    .setThumbnail(
      `https://minotar.net/helm/${encodeURIComponent(nick)}/100.png`
    )
    .addFields(
      {
        name: 'Oyuncu',
        value: `${uye} (\`${nick}\`)`,
        inline: true,
      },
      {
        name: 'Kit',
        value: kit,
        inline: true,
      },
      {
        name: 'Tier',
        value:
          onceki && onceki !== tier
            ? `${onceki} → **${tier}**`
            : `**${tier}**`,
        inline: true,
      }
    )
    .setFooter({
      text: `Tester: ${i.member.displayName}`,
    })
    .setTimestamp();

  let duyuru = '';

  const sonucKanali = S().resultChannelId
    ? await i.guild.channels.fetch(S().resultChannelId).catch(() => null)
    : null;

  if (sonucKanali) {
    await sonucKanali.send({ embeds: [embed] });
  } else {
    duyuru =
      '\nSonuç kanalı ayarlı değil, duyuru yapılamadı (`/ayar sonuc-kanal`).';
  }

  await logla(
    i.guild,
    `${i.user.tag} → ${uye.user.tag}: **${kit} ${tier}**`
  );

  const kapatNotu = state.tickets[i.channelId]
    ? '\nİş bitince `/kapat` ile kanalı kapatabilirsin.'
    : '';

  return i.editReply(
    `Tier verildi: **${kit} ${tier}**\n${rolNotu}${duyuru}${kapatNotu}`
  );
};

// ==========================================================================
// TEST KANALINI KAPAT
// ==========================================================================

komutlar.kapat = async (i) => {
  const kayitli = state.tickets[i.channelId];

  const kategoriMi =
    S().ticketCategoryId &&
    i.channel.parentId === S().ticketCategoryId;

  if (!kayitli && !kategoriMi) {
    return i.reply({
      content: 'Bu bir test kanalı değil.',
      flags: GIZLI,
    });
  }

  await i.reply('Kanal kapatılıyor...');

  delete state.tickets[i.channelId];
  kaydet();

  await logla(
    i.guild,
    `${i.user.tag} test kanalını kapattı (#${i.channel.name}).`
  );

  return i.channel.delete().catch((e) => {
    console.log('Kanal silinemedi:', e.message);
  });
};

// ==========================================================================
// TESTER AKTİF / PASİF
// ==========================================================================

komutlar.tester = async (i) => {
  const sub = i.options.getSubcommand();

  if (sub === 'aktif') {
    const kit = kitBul(i.options.getString('kit'));

    if (!kit) {
      return i.reply({
        content: 'Bu kit mevcut değil.',
        flags: GIZLI,
      });
    }

    const mevcut = state.activeTesters[i.user.id] || [];

    if (!mevcut.includes(kit)) {
      mevcut.push(kit);
    }

    state.activeTesters[i.user.id] = mevcut;
    kaydet();
    panelGuncelle();

    return i.reply({
      content: `${kit} için aktif oldun. Aktif kitlerin: ${mevcut.join(', ')}`,
      flags: GIZLI,
    });
  }

  if (sub === 'pasif') {
    const kitAdi = i.options.getString('kit');

    if (kitAdi) {
      const kit = kitBul(kitAdi);

      const kalan = (state.activeTesters[i.user.id] || []).filter(
        (k) => k !== kit
      );

      if (kalan.length) {
        state.activeTesters[i.user.id] = kalan;
      } else {
        delete state.activeTesters[i.user.id];
      }
    } else {
      delete state.activeTesters[i.user.id];
    }

    kaydet();
    panelGuncelle();

    const kalanlar = state.activeTesters[i.user.id];

    return i.reply({
      content: kalanlar
        ? `Pasif oldun. Hâlâ aktif: ${kalanlar.join(', ')}`
        : 'Tüm kitlerde pasif oldun.',
      flags: GIZLI,
    });
  }

  const satirlar = S()
    .kits.map((kit) => {
      const t = aktifTesterler(kit);

      return t.length
        ? `**${kit}**: ${t.map((id) => `<@${id}>`).join(', ')}`
        : null;
    })
    .filter(Boolean);

  return i.reply({
    content: satirlar.length
      ? satirlar.join('\n')
      : 'Şu an aktif tester yok.',
    flags: GIZLI,
    allowedMentions: { parse: [] },
  });
};

// ==========================================================================
// KUYRUKTAN OYUNCU AT
// ==========================================================================

komutlar['kuyruk-at'] = async (i) => {
  const hedef = i.options.getUser('oyuncu');
  const cikti = kuyruktanCikar(hedef.id);

  if (cikti) {
    await logla(
      i.guild,
      `${i.user.tag}, ${hedef.tag} kullanıcısını kuyruktan çıkardı.`
    );
  }

  return i.reply({
    content: cikti
      ? `${hedef} kuyruktan çıkarıldı.`
      : 'Oyuncu kuyrukta değil.',
    flags: GIZLI,
  });
};

// ==========================================================================
// COOLDOWN SIFIRLA
// ==========================================================================

komutlar['cooldown-sifirla'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  const hedef = i.options.getUser('oyuncu');

  if (!kit) {
    return i.reply({
      content: 'Bu kit mevcut değil.',
      flags: GIZLI,
    });
  }

  const anahtar = `${hedef.id}:${kit}`;

  if (!state.cooldowns[anahtar]) {
    return i.reply({
      content: 'Bu oyuncunun cooldown süresi yok.',
      flags: GIZLI,
    });
  }

  delete state.cooldowns[anahtar];
  kaydet();

  await logla(
    i.guild,
    `${i.user.tag}, ${hedef.tag} için ${kit} cooldown süresini sıfırladı.`
  );

  return i.reply({
    content: `${hedef} için ${kit} cooldown süresi sıfırlandı.`,
    flags: GIZLI,
  });
};

// ==========================================================================
// PANEL KUR
// ==========================================================================

komutlar['panel-kur'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kanal = i.options.getChannel('kanal') || i.channel;

  if (state.panel) {
    try {
      const eskiKanal = await client.channels.fetch(
        state.panel.channelId
      );

      const eskiMesaj = await eskiKanal.messages.fetch(
        state.panel.messageId
      );

      await eskiMesaj.delete();
    } catch (e) {
      // Eski panel zaten silinmiş olabilir.
    }
  }

  const mesaj = await kanal.send({
    embeds: [panelEmbed()],
    components: panelBilesenleri(),
  });

  state.panel = {
    channelId: kanal.id,
    messageId: mesaj.id,
  };

  kaydet();

  return i.editReply(
    `Bekleme listesi paneli ${kanal} kanalına gönderildi. Otomatik güncellenir.`
  );
};

// ==========================================================================
// KUYRUĞU TEMİZLE
// ==========================================================================

komutlar['kuyruk-temizle'] = async (i) => {
  const silinen = state.queue.length;

  state.queue = [];

  kaydet();
  panelGuncelle();

  await logla(
    i.guild,
    `${i.user.tag} genel kuyruğu temizledi (${silinen} kişi).`
  );

  return i.reply({
    content: `Genel kuyruk temizlendi (${silinen} kişi).`,
    flags: GIZLI,
  });
};

// ==========================================================================
// AYAR KOMUTLARI
// ==========================================================================

komutlar.ayar = async (i) => {
  const sub = i.options.getSubcommand();
  const s = S();

  const tamam = (metin) => {
    kaydet();

    return i.reply({
      content: metin,
      flags: GIZLI,
    });
  };

  switch (sub) {
    case 'goster': {
      const embed = new EmbedBuilder()
        .setTitle('Bot Ayarları')
        .setColor(RENK.gri)
        .addFields(
          {
            name: 'Tester rolü',
            value: s.testerRoleId ? `<@&${s.testerRoleId}>` : 'Ayarlı değil',
            inline: true,
          },
          {
            name: 'Sonuç kanalı',
            value: s.resultChannelId ? `<#${s.resultChannelId}>` : 'Ayarlı değil',
            inline: true,
          },
          {
            name: 'Log kanalı',
            value: s.logChannelId ? `<#${s.logChannelId}>` : 'Ayarlı değil',
            inline: true,
          },
          {
            name: 'Test kategorisi',
            value: s.ticketCategoryId ? `<#${s.ticketCategoryId}>` : 'Ayarlı değil',
            inline: true,
          },
          {
            name: 'Cooldown',
            value: s.cooldownDays ? `${s.cooldownDays} gün` : 'Kapalı',
            inline: true,
          },
          {
            name: 'Kuyruk limiti',
            value: String(s.maxQueue),
            inline: true,
          },
          {
            name: 'Otomatik rol',
            value: 'Her zaman açık',
            inline: true,
          },
          {
            name: 'Özel rol eşlemeleri',
            value: String(Object.keys(s.roleMap).length),
            inline: true,
          },
          {
            name: 'Panel',
            value: state.panel
              ? `<#${state.panel.channelId}>`
              : 'Kurulmadı (/panel-kur)',
            inline: true,
          },
          {
            name: `Kitler (${s.kits.length})`,
            value: s.kits.join(', '),
          }
        );

      return i.reply({
        embeds: [embed],
        flags: GIZLI,
      });
    }

    case 'tester-rol': {
      const rol = i.options.getRole('rol');
      s.testerRoleId = rol.id;

      return tamam(`Tester rolü ${rol} olarak ayarlandı.`);
    }

    case 'sonuc-kanal': {
      const kanal = i.options.getChannel('kanal');
      s.resultChannelId = kanal.id;

      return tamam(`Sonuç kanalı ${kanal} olarak ayarlandı.`);
    }

    case 'log-kanal': {
      const kanal = i.options.getChannel('kanal');
      s.logChannelId = kanal.id;

      return tamam(`Log kanalı ${kanal} olarak ayarlandı.`);
    }

    case 'ticket-kategori': {
      const kategori = i.options.getChannel('kategori');
      s.ticketCategoryId = kategori.id;

      return tamam(
        `Test kanalları ${kategori.name} kategorisinde açılacak.`
      );
    }

    case 'cooldown': {
      s.cooldownDays = i.options.getInteger('gun');

      return tamam(
        s.cooldownDays
          ? `Cooldown ${s.cooldownDays} gün oldu.`
          : 'Cooldown kapatıldı.'
      );
    }

    case 'max-kuyruk': {
      s.maxQueue = i.options.getInteger('adet');

      return tamam(
        `Genel kuyruk limiti ${s.maxQueue} oldu.`
      );
    }

    case 'kit-ekle': {
      const isim = i.options.getString('isim').trim();

      if (!KIT_REGEX.test(isim)) {
        return i.reply({
          content:
            'Kit adı sadece harf, rakam, boşluk, _ + - içerebilir (en fazla 20).',
          flags: GIZLI,
        });
      }

      if (kitBul(isim)) {
        return i.reply({
          content: 'Bu kit zaten var.',
          flags: GIZLI,
        });
      }

      if (s.kits.length >= 25) {
        return i.reply({
          content: 'En fazla 25 kit eklenebilir.',
          flags: GIZLI,
        });
      }

      s.kits.push(isim);
      panelGuncelle();

      return tamam(`${isim} kiti eklendi.`);
    }

    case 'kit-sil': {
      const kit = kitBul(i.options.getString('kit'));

      if (!kit) {
        return i.reply({
          content: 'Bu kit mevcut değil.',
          flags: GIZLI,
        });
      }

      if (s.kits.length <= 1) {
        return i.reply({
          content: 'En az 1 kit kalmalı.',
          flags: GIZLI,
        });
      }

      s.kits = s.kits.filter((k) => k !== kit);

      for (const anahtar of Object.keys(s.roleMap)) {
        if (anahtar.startsWith(`${kit}:`)) {
          delete s.roleMap[anahtar];
        }
      }

      for (const [id, kitler] of Object.entries(state.activeTesters)) {
        const kalan = kitler.filter((k) => k !== kit);

        if (kalan.length) {
          state.activeTesters[id] = kalan;
        } else {
          delete state.activeTesters[id];
        }
      }

      panelGuncelle();

      return tamam(`${kit} kiti silindi.`);
    }

    case 'rol-esle': {
      const kit = kitBul(i.options.getString('kit'));
      const tier = i.options.getString('tier');
      const rol = i.options.getRole('rol');

      if (!kit) {
        return i.reply({
          content: 'Bu kit mevcut değil.',
          flags: GIZLI,
        });
      }

      s.roleMap[`${kit}:${tier}`] = rol.id;

      return tamam(`${kit} ${tier} rolü ${rol} ile eşlendi.`);
    }

    case 'rol-esle-sil': {
      const kit = kitBul(i.options.getString('kit'));
      const tier = i.options.getString('tier');

      if (!kit || !s.roleMap[`${kit}:${tier}`]) {
        return i.reply({
          content: 'Bu kit/tier için eşleme yok.',
          flags: GIZLI,
        });
      }

      delete s.roleMap[`${kit}:${tier}`];

      return tamam(`${kit} ${tier} eşlemesi kaldırıldı.`);
    }

    case 'rol-kontrol': {
      const eksik = [];
      let bulunan = 0;

      for (const kit of s.kits) {
        for (const tier of TIERLER) {
          if (tierRoluBul(i.guild, kit, tier)) {
            bulunan += 1;
          } else {
            eksik.push(`${kit} ${tier}`);
          }
        }
      }

      const toplam = s.kits.length * TIERLER.length;

      let metin = `Bulunan rol: **${bulunan} / ${toplam}**`;

      if (eksik.length) {
        let liste = eksik.join(', ');

        if (liste.length > 1500) {
          liste = `${liste.slice(0, 1500)}...`;
        }

        metin += `\nEksik: ${liste}\nRolleri /ayar rol-esle ile eşleyebilirsin veya "Kit Tier" adıyla oluşturabilirsin.`;
      }

      return i.reply({
        content: metin,
        flags: GIZLI,
      });
    }

    default:
      return i.reply({
        content: 'Bilinmeyen ayar.',
        flags: GIZLI,
      });
  }
};

// ==========================================================================
// KUYRUK BUTONLARI VE MINECRAFT NICK MODALI
// ==========================================================================

async function panelModal(i) {
  const nick = i.fields.getTextInputValue('nick').trim();
  const sonuc = kuyrugaEkle(i.user.id, nick);

  return i.reply({
    content: sonuc.msg,
    flags: GIZLI,
  });
}

async function panelButon(i) {
  if (i.customId === 'wl_join') {
    if (state.queue.some((k) => k.userId === i.user.id)) {
      return i.reply({
        content: `Zaten kuyruktasın. Sıran: ${siraBul(i.user.id)}.`,
        flags: GIZLI,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('wl_nick')
      .setTitle('Kuyruğa Katıl')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('nick')
            .setLabel('Minecraft kullanıcı adın')
            .setPlaceholder('Minecraft kullanıcı adını yaz')
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(16)
            .setRequired(true)
        )
      );

    return i.showModal(modal);
  }

  if (i.customId === 'wl_leave') {
    const cikti = kuyruktanCikar(i.user.id);

    return i.reply({
      content: cikti
        ? 'Kuyruktan çıkarıldın.'
        : 'Zaten kuyrukta değilsin.',
      flags: GIZLI,
    });
  }
}

// ==========================================================================
// BOT BAŞLATMA VE OLAYLAR
// ==========================================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function komutCalistir(i) {
  const ad = i.commandName;
  const fn = komutlar[ad];

  if (!fn) return;

  if (YONETICI_KOMUTLARI.has(ad) && !yoneticiMi(i.member)) {
    return i.reply({
      content: 'Bu komut sadece yöneticiler için.',
      flags: GIZLI,
    });
  }

  if (TESTER_KOMUTLARI.has(ad) && !testerMi(i.member)) {
    return i.reply({
      content: 'Bu komut sadece testerlar için.',
      flags: GIZLI,
    });
  }

  return fn(i);
}

async function otomatikTamamla(i) {
  const odak = i.options.getFocused().toLowerCase();

  const liste = S()
    .kits.filter((k) => k.toLowerCase().includes(odak))
    .slice(0, 25)
    .map((k) => ({
      name: k,
      value: k,
    }));

  return i.respond(liste);
}

async function hataYanit(i, err) {
  console.error('Etkileşim hatası:', err);

  const msg =
    'Bir hata oluştu. Botun izinlerini (Rolleri/Kanalları Yönet) ve ayarları kontrol et.';

  try {
    if (i.deferred || i.replied) {
      await i.editReply({ content: msg });
    } else if (i.isRepliable()) {
      await i.reply({
        content: msg,
        flags: GIZLI,
      });
    }
  } catch (e) {
    // Yanıt verilemedi.
  }
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete()) {
      return await otomatikTamamla(i);
    }

    if (i.isChatInputCommand()) {
      return await komutCalistir(i);
    }

    if (i.isButton()) {
      return await panelButon(i);
    }

    if (i.isModalSubmit() && i.customId === 'wl_nick') {
      return await panelModal(i);
    }
  } catch (err) {
    await hataYanit(i, err);
  }
});

client.on('channelDelete', (kanal) => {
  if (state.tickets[kanal.id]) {
    delete state.tickets[kanal.id];
    kaydet();
  }
});

client.once('clientReady', async () => {
  yukle();

  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    await guild.commands.set(komutTanimlari);

    console.log(
      `${client.user.tag} hazır, ${komutTanimlari.length} komut kaydedildi.`
    );
  } catch (e) {
    console.log('KOMUT KAYIT HATASI:', e.message);
  }

  client.user.setActivity('Tier Test');

  panelGuncelle();

  setInterval(() => {
    const simdi = Date.now();
    let temizlendi = false;

    for (const [anahtar, bitis] of Object.entries(state.cooldowns)) {
      if (bitis <= simdi) {
        delete state.cooldowns[anahtar];
        temizlendi = true;
      }
    }

    if (temizlendi) {
      kaydet();
    }
  }, 3600000);
});

client.on('error', (e) => {
  console.log('Client hatası:', e.message);
});

process.on('unhandledRejection', (e) => {
  console.log('Yakalanmamış hata:', e);
});

process.on('SIGTERM', () => {
  hemenKaydet();
  process.exit(0);
});

// ==========================================================================
// RENDER HTTP SUNUCUSU
// ==========================================================================

http
  .createServer((req, res) => res.end('Bot calisiyor'))
  .listen(process.env.PORT || 3000);

client.login(DISCORD_TOKEN);
