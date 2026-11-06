// ==========================================================================
//  TIER TEST BOT - discord.js v14 (geliştirilmiş sürüm)
// ==========================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  Events,
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
  StringSelectMenuBuilder,
} = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('DISCORD_TOKEN ve GUILD_ID ortam değişkenleri zorunlu!');
  process.exit(1);
}

const TIERLER = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
const TIER_SIRA = Object.fromEntries(TIERLER.map((t, n) => [t, n]));
const VARSAYILAN_KITLER = ['Crystal', 'Sword', 'Axe', 'Pot', 'NethPot', 'SMP', 'UHC', 'Vanilla'];
const RENK = { ana: 0x5865f2, basari: 0x2ecc71, uyari: 0xf1c40f, hata: 0xe74c3c, gri: 0x95a5a6 };
const GUN = 86400000;
const GIZLI = MessageFlags.Ephemeral;
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;
const KIT_REGEX = /^[A-Za-z0-9 _+-]{1,20}$/;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const GECICI_DOSYA = `${DATA_FILE}.tmp`;

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
    queues: {},
    queueOpen: {},
    cooldowns: {},
    results: {},
    activeTesters: {},
    tickets: {},
    stats: {},
    panel: null,
  };
}

let state = varsayilanDurum();

// ==========================================================================
// KAYIT SİSTEMİ (atomik yazma + bozuk dosya yedeği)
// ==========================================================================

function yukle() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const kayit = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const v = varsayilanDurum();
    state = { ...v, ...kayit, settings: { ...v.settings, ...(kayit.settings || {}) } };

    for (const k of ['testerRoleId', 'resultChannelId', 'ticketCategoryId', 'logChannelId']) {
      state.settings[k] = (kayit.settings && kayit.settings[k]) || v.settings[k];
    }

    if (!Array.isArray(state.settings.kits) || !state.settings.kits.length) {
      state.settings.kits = [...VARSAYILAN_KITLER];
    }

    // Eski tek kuyruk verisini Sword kuyruğuna taşı.
    if (!state.queues || typeof state.queues !== 'object') state.queues = {};
    if (Array.isArray(kayit.queue) && kayit.queue.length && !state.queues.Sword) {
      state.queues.Sword = kayit.queue.map((x) => ({ ...x, kit: 'Sword' }));
    }
    delete state.queue;
    if (!state.queueOpen || typeof state.queueOpen !== 'object') state.queueOpen = {};
    for (const kit of state.settings.kits) {
      if (!Array.isArray(state.queues[kit])) state.queues[kit] = [];
      if (typeof state.queueOpen[kit] !== 'boolean') state.queueOpen[kit] = true;
    }
    console.log('data.json yüklendi.');
  } catch (e) {
    console.log('data.json okunamadı, sıfırdan başlanıyor:', e.message);
    try {
      const yedek = `${DATA_FILE}.bozuk-${Date.now()}`;
      fs.copyFileSync(DATA_FILE, yedek);
      console.log(`Bozuk dosya yedeklendi: ${yedek}`);
    } catch (_) {
      // Yedek alınamadı.
    }
    state = varsayilanDurum();
  }
}

function hemenKaydet() {
  try {
    // Önce geçici dosyaya yaz, sonra yeniden adlandır: yazarken çökerse veri bozulmaz.
    fs.writeFileSync(GECICI_DOSYA, JSON.stringify(state, null, 2));
    fs.renameSync(GECICI_DOSYA, DATA_FILE);
  } catch (e) {
    console.log('data.json yazılamadı:', e.message);
  }
}

let kaydetZamanlayici = null;

function kaydet() {
  clearTimeout(kaydetZamanlayici);
  kaydetZamanlayici = setTimeout(hemenKaydet, 1500);
}

// ==========================================================================
// YARDIMCI FONKSİYONLAR
// ==========================================================================

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

// Aynı anda iki kişi katılınca aynı rolün iki kez oluşmasını engeller.
const rolKilitleri = new Map();

async function rolBulVeyaOlustur(guild, ad, sebep) {
  const mevcut = guild.roles.cache.find((r) => r.name.toLowerCase() === ad.toLowerCase());
  if (mevcut) return mevcut;

  const anahtar = `${guild.id}:${ad.toLowerCase()}`;
  if (!rolKilitleri.has(anahtar)) {
    const islem = guild.roles
      .create({ name: ad, reason: sebep })
      .finally(() => rolKilitleri.delete(anahtar));
    rolKilitleri.set(anahtar, islem);
  }
  return rolKilitleri.get(anahtar);
}

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
  try {
    const yeni =
      tierRoluBul(guild, kit, tier) ||
      (await rolBulVeyaOlustur(guild, `${kit} ${tier}`, `Otomatik tier rolü: ${kit} ${tier}`));

    const eskiler = TIERLER.map((t) => tierRoluBul(guild, kit, t)).filter(
      (r) => r && r.id !== yeni.id && uye.roles.cache.has(r.id)
    );

    if (eskiler.length) {
      await uye.roles.remove(eskiler, `${kit} tier güncellendi`);
    }

    await uye.roles.add(yeni, `${kit} ${tier} tier rolü verildi`);

    return `Rol verildi: ${yeni}`;
  } catch (e) {
    console.error('Tier rolü oluşturulamadı/verilemedi:', e);
    return 'Rol verilemedi. Botta Rolleri Yönet izni olmalı ve botun rolü, verilecek rollerin üstünde bulunmalı.';
  }
}

// ==========================================================================
// KIT BAZLI KUYRUK SİSTEMİ
// ==========================================================================

// Her kullanıcının panelde seçtiği kit (bellekte tutulur).
const secilenKitler = new Map();
// Aynı oyuncu için aynı anda iki test kanalı açılmasını engeller.
const testAcilanlar = new Set();

function kuyrukGetir(kit) {
  if (!Array.isArray(state.queues[kit])) state.queues[kit] = [];
  if (typeof state.queueOpen[kit] !== 'boolean') state.queueOpen[kit] = true;
  return state.queues[kit];
}

function waitlistRolAdi(kit) {
  return `${kit.toUpperCase()} WAITLIST`;
}

async function waitlistRoluBulVeyaOlustur(guild, kit) {
  return rolBulVeyaOlustur(guild, waitlistRolAdi(kit), `${kit} waitlist rolü`);
}

async function waitlistRolKaldir(guild, userId, kit) {
  try {
    const ad = waitlistRolAdi(kit).toLowerCase();
    const rol = guild.roles.cache.find((r) => r.name.toLowerCase() === ad);
    if (!rol) return;
    const uye = await guild.members.fetch(userId).catch(() => null);
    if (uye && uye.roles.cache.has(rol.id)) {
      await uye.roles.remove(rol, 'Waitlist kuyruğundan ayrıldı/test başladı');
    }
  } catch (e) {
    console.log('Waitlist rolü kaldırılamadı:', e.message);
  }
}

function siraBul(userId, kit) {
  const idx = kuyrukGetir(kit).findIndex((k) => k.userId === userId);
  return idx === -1 ? 0 : idx + 1;
}

async function kuyrugaEkle(guild, userId, nick, kit) {
  if (!NICK_REGEX.test(nick)) {
    return { ok: false, msg: 'Geçersiz Minecraft kullanıcı adı (3-16 karakter; harf, rakam ve _).' };
  }
  if (!kitBul(kit)) return { ok: false, msg: 'Geçersiz kit.' };
  if (state.queueOpen[kit] === false) return { ok: false, msg: `${kit} kuyruğu şu anda kapalı.` };

  const cd = cooldownKalan(userId, kit);
  if (cd) return { ok: false, msg: `**${kit}** için cooldown'dasın. Tekrar katılabilirsin: ${zaman(cd)}.` };

  if (acikTestVarMi(userId, kit)) {
    return { ok: false, msg: `**${kit}** için zaten açık bir test kanalın var.` };
  }

  const liste = kuyrukGetir(kit);
  if (liste.some((k) => k.userId === userId)) {
    return { ok: false, msg: `${kit} kuyruğunda zaten varsın. Sıran: ${siraBul(userId, kit)}.` };
  }
  if (liste.length >= S().maxQueue) return { ok: false, msg: `Kuyruk dolu (${S().maxQueue} kişi).` };

  const kayit = { userId, nick, joined: Date.now(), kit };
  liste.push(kayit);

  try {
    const rol = await waitlistRoluBulVeyaOlustur(guild, kit);
    const uye = await guild.members.fetch(userId);
    if (!uye.roles.cache.has(rol.id)) await uye.roles.add(rol, `${kit} waitlist kuyruğuna katıldı`);
  } catch (e) {
    // Başkasının kaydını silmemek için pop() yerine kendi kaydımızı bulup çıkarıyoruz.
    const guncel = kuyrukGetir(kit);
    const idx = guncel.indexOf(kayit);
    if (idx !== -1) guncel.splice(idx, 1);
    console.log('Waitlist rolü verilemedi:', e.message);
    return { ok: false, msg: 'WAITLIST rolü verilemedi. Botta Rolleri Yönet izni ve rol hiyerarşisi gerekli.' };
  }

  kaydet();
  panelGuncelle();
  return { ok: true, msg: `${kit} kuyruğuna katıldın. Sıran: ${siraBul(userId, kit)}.` };
}

async function kuyruktanCikar(guild, userId, kit) {
  const liste = kuyrukGetir(kit);
  const idx = liste.findIndex((k) => k.userId === userId);
  if (idx === -1) return false;
  liste.splice(idx, 1);
  kaydet();
  panelGuncelle();
  await waitlistRolKaldir(guild, userId, kit);
  return true;
}

function panelEmbed() {
  const satirlar = S().kits.map((kit) => {
    const liste = kuyrukGetir(kit);
    const durum = state.queueOpen[kit] === false ? 'Kapalı' : 'Açık';
    return `**${kit}** — ${durum} • **${liste.length}** kişi`;
  });

  return new EmbedBuilder()
    .setTitle('WAITLIST PANEL')
    .setColor(RENK.ana)
    .setDescription(
      'Test olmak istediğin kiti aşağıdan seç. Ardından **Katıl** veya **Çık** butonunu kullan.\n\n' +
        satirlar.join('\n')
    )
    .setFooter({ text: 'Her kitin kuyruğu birbirinden bağımsızdır.' })
    .setTimestamp();
}

function panelBilesenleri() {
  const secenekler = S().kits.slice(0, 25).map((kit) => ({
    label: kit,
    value: kit,
    description: `${kuyrukGetir(kit).length} kişi • ${state.queueOpen[kit] === false ? 'Kapalı' : 'Açık'}`,
  }));

  const secim = new StringSelectMenuBuilder()
    .setCustomId('wl_kit_select')
    .setPlaceholder('Test olmak istediğin kiti seç')
    .addOptions(secenekler);

  return [
    new ActionRowBuilder().addComponents(secim),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wl_join').setLabel('Katıl').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('wl_leave').setLabel('Çık').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('wl_toggle')
        .setLabel('Kuyruğu Aç/Kapat (Tester)')
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
      await mesaj.edit({ embeds: [panelEmbed()], components: panelBilesenleri() });
    } catch (e) {
      console.log('Panel güncellenemedi:', e.message);
      // Kanal veya mesaj silinmişse bir daha boşuna denemesin.
      if (e.code === 10003 || e.code === 10008) {
        state.panel = null;
        kaydet();
      }
    }
  }, 1000);
}

// ==========================================================================
// SLASH KOMUTLARI
// ==========================================================================

const kitOpt = (o, zorunlu = true) =>
  o.setName('kit').setDescription('Kit seç').setRequired(zorunlu).setAutocomplete(true);

const tierOpt = (o) =>
  o
    .setName('tier')
    .setDescription('Tier')
    .setRequired(true)
    .addChoices(...TIERLER.map((t) => ({ name: t, value: t })));

const YONETIM = PermissionFlagsBits.ManageGuild;
const METIN_KANALLARI = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const komutTanimlari = [
  new SlashCommandBuilder()
    .setName('kuyruk-liste')
    .setDescription('Bir kitin kuyruğundaki oyuncuları göster')
    .addStringOption((o) => kitOpt(o)),

  new SlashCommandBuilder().setName('siram').setDescription('Kuyruktaki sıranı göster'),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Bir oyuncunun tierlerini göster')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu (boşsa sen)')),

  new SlashCommandBuilder()
    .setName('liderlik')
    .setDescription('Bir kitin en iyi oyuncuları')
    .addStringOption((o) => kitOpt(o)),

  new SlashCommandBuilder().setName('istatistik').setDescription('Test istatistikleri'),

  new SlashCommandBuilder()
    .setName('test-baslat')
    .setDescription('[Tester] Sıradaki oyuncuyla test kanalı aç')
    .addStringOption((o) => kitOpt(o))
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Belirli bir oyuncuyu al (boşsa sıradaki)')
    ),

  new SlashCommandBuilder()
    .setName('tier-ver')
    .setDescription('[Tester] Oyuncuya tier ver (test kanalında oyuncu/kit/nick otomatik)')
    .addStringOption((o) => tierOpt(o))
    .addUserOption((o) =>
      o.setName('oyuncu').setDescription('Oyuncu (test kanalında boş bırakılabilir)')
    )
    .addStringOption((o) => kitOpt(o, false))
    .addStringOption((o) =>
      o.setName('nick').setDescription('Minecraft nicki (test kanalında boş bırakılabilir)')
    ),

  new SlashCommandBuilder().setName('kapat').setDescription('[Tester] Test kanalını kapat'),

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
    .addSubcommand((s) => s.setName('liste').setDescription('Aktif testerları göster')),

  new SlashCommandBuilder()
    .setName('kuyruk-at')
    .setDescription('[Tester] Bir oyuncuyu kuyruktan çıkar')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true)),

  new SlashCommandBuilder()
    .setName('cooldown-sifirla')
    .setDescription('[Tester] Oyuncunun cooldown süresini sıfırla')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true))
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
    .setDescription('[Yönetici] Bir kitin veya tüm kuyrukların listesini temizle')
    .setDefaultMemberPermissions(YONETIM)
    .addStringOption((o) => kitOpt(o, false)),

  new SlashCommandBuilder()
    .setName('tier-sil')
    .setDescription('[Yönetici] Oyuncunun bir kitteki tier kaydını ve rolünü sil')
    .setDefaultMemberPermissions(YONETIM)
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true))
    .addStringOption((o) => kitOpt(o)),

  new SlashCommandBuilder()
    .setName('ayar')
    .setDescription('[Yönetici] Bot ayarları')
    .setDefaultMemberPermissions(YONETIM)
    .addSubcommand((s) => s.setName('goster').setDescription('Mevcut ayarları göster'))
    .addSubcommand((s) =>
      s
        .setName('tester-rol')
        .setDescription('Tester rolünü belirle')
        .addRoleOption((o) => o.setName('rol').setDescription('Tester rolü').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('sonuc-kanal')
        .setDescription('Sonuçların duyurulacağı kanal')
        .addChannelOption((o) =>
          o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...METIN_KANALLARI)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('log-kanal')
        .setDescription('Bot kayıtlarının yazılacağı kanal')
        .addChannelOption((o) =>
          o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...METIN_KANALLARI)
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
          o.setName('gun').setDescription('Gün (0 = kapalı)').setRequired(true).setMinValue(0).setMaxValue(90)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('max-kuyruk')
        .setDescription('Her kit kuyruğundaki en fazla kişi')
        .addIntegerOption((o) =>
          o.setName('adet').setDescription('Adet').setRequired(true).setMinValue(1).setMaxValue(200)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('kit-ekle')
        .setDescription('Yeni kit ekle')
        .addStringOption((o) =>
          o.setName('isim').setDescription('Kit adı (en fazla 20 karakter)').setRequired(true).setMaxLength(20)
        )
    )
    .addSubcommand((s) =>
      s.setName('kit-sil').setDescription('Bir kiti sil').addStringOption((o) => kitOpt(o))
    )
    .addSubcommand((s) =>
      s
        .setName('rol-esle')
        .setDescription('Kit + tier için hazır bir rolü eşle')
        .addStringOption((o) => kitOpt(o))
        .addStringOption((o) => tierOpt(o))
        .addRoleOption((o) => o.setName('rol').setDescription('Hazır rol').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('rol-esle-sil')
        .setDescription('Rol eşlemesini kaldır')
        .addStringOption((o) => kitOpt(o))
        .addStringOption((o) => tierOpt(o))
    )
    .addSubcommand((s) =>
      s.setName('rol-kontrol').setDescription('Hangi kit/tier rolleri bulunuyor, hangileri eksik')
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

const YONETICI_KOMUTLARI = new Set(['panel-kur', 'kuyruk-temizle', 'tier-sil', 'ayar']);

// ==========================================================================
// KOMUT İŞLEYİCİLERİ
// ==========================================================================

const komutlar = {};

komutlar['kuyruk-liste'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: 'Bu kit mevcut değil.', flags: GIZLI });

  const liste = kuyrukGetir(kit);
  const satirlar = liste
    .slice(0, 20)
    .map((k, n) => `**${n + 1}.** <@${k.userId}> • \`${k.nick}\` • ${zaman(k.joined)}`);

  const embed = new EmbedBuilder()
    .setTitle(`${kit} Kuyruğu (${liste.length})`)
    .setColor(RENK.ana)
    .setDescription(satirlar.length ? satirlar.join('\n') : 'Kuyruk boş.');

  if (liste.length > 20) embed.setFooter({ text: `... ve ${liste.length - 20} kişi daha` });

  return i.reply({ embeds: [embed], flags: GIZLI, allowedMentions: { parse: [] } });
};

komutlar.siram = async (i) => {
  const satirlar = S()
    .kits.map((kit) => {
      const sira = siraBul(i.user.id, kit);
      if (!sira) return null;
      const liste = kuyrukGetir(kit);
      return `**${kit}** — sıra **${sira}** / ${liste.length} • \`${liste[sira - 1].nick}\``;
    })
    .filter(Boolean);

  return i.reply({
    content: satirlar.length ? satirlar.join('\n') : 'Herhangi bir kitin kuyruğunda değilsin.',
    flags: GIZLI,
  });
};

komutlar.profil = async (i) => {
  const uye = i.options.getUser('oyuncu') ? i.options.getMember('oyuncu') : i.member;
  if (!uye) return i.reply({ content: 'Oyuncu sunucuda bulunamadı.', flags: GIZLI });

  const tierler = {};
  let nick = null;

  for (const kit of S().kits) {
    const kayit = state.results[`${uye.id}:${kit}`];
    if (kayit) {
      tierler[kit] = kayit.tier;
      nick = kayit.nick;
    }
  }

  for (const [kit, tier] of Object.entries(rolTierleri(uye))) {
    if (!tierler[kit]) tierler[kit] = tier;
  }

  const kitler = Object.keys(tierler).sort((a, b) => TIER_SIRA[tierler[a]] - TIER_SIRA[tierler[b]]);

  if (!kitler.length) {
    return i.reply({ content: `${uye.displayName} henüz test olmamış.`, flags: GIZLI });
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

komutlar.liderlik = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: 'Bu kit mevcut değil.', flags: GIZLI });

  const sirali = Object.entries(state.results)
    .filter(([anahtar]) => anahtar.slice(anahtar.indexOf(':') + 1) === kit)
    .map(([anahtar, r]) => ({ id: anahtar.slice(0, anahtar.indexOf(':')), ...r }))
    .sort((a, b) => TIER_SIRA[a.tier] - TIER_SIRA[b.tier] || a.at - b.at)
    .slice(0, 10);

  if (!sirali.length) {
    return i.reply({ content: `${kit} için henüz tier verilmemiş.`, flags: GIZLI });
  }

  const embed = new EmbedBuilder()
    .setTitle(`${kit} Liderlik Tablosu`)
    .setColor(RENK.uyari)
    .setDescription(
      sirali.map((r, n) => `**${n + 1}.** <@${r.id}> • \`${r.nick}\` • **${r.tier}**`).join('\n')
    );

  return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
};

komutlar.istatistik = async (i) => {
  const toplam = Object.values(state.stats).reduce((a, s) => a + s.tests, 0);

  const ilk = Object.entries(state.stats)
    .sort((a, b) => b[1].tests - a[1].tests)
    .slice(0, 5)
    .map(([id, s], n) => `**${n + 1}.** <@${id}> • ${s.tests} test`);

  const embed = new EmbedBuilder()
    .setTitle('Test İstatistikleri')
    .setColor(RENK.ana)
    .addFields(
      { name: 'Toplam test', value: String(toplam), inline: true },
      {
        name: 'Kuyrukta bekleyen',
        value: String(S().kits.reduce((n, kit) => n + kuyrukGetir(kit).length, 0)),
        inline: true,
      },
      { name: 'Açık test kanalı', value: String(Object.keys(state.tickets).length), inline: true },
      { name: 'En aktif testerlar', value: ilk.length ? ilk.join('\n') : 'Henüz test yapılmadı' }
    );

  return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
};

// ==========================================================================
// TEST BAŞLAT
// ==========================================================================

komutlar['test-baslat'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.editReply('Bu kit mevcut değil.');

  const hedef = i.options.getUser('oyuncu');
  const liste = kuyrukGetir(kit);
  if (!hedef && !liste.length) return i.editReply(`${kit} kuyruğu boş.`);

  const hedefId = hedef ? hedef.id : liste[0].userId;
  const kayitli = liste.find((k) => k.userId === hedefId);
  const giris = kayitli || { userId: hedefId, kit, nick: hedef.username };

  if (hedefId === i.user.id && !yoneticiMi(i.member)) {
    return i.editReply('Kendi kendinin testini alamazsın.');
  }

  const cd = cooldownKalan(hedefId, kit);
  if (cd) {
    return i.editReply(
      `Bu oyuncu **${kit}** için cooldown'da. Süre: ${zaman(cd)}. Kuyruktaki kaydı korunuyor.`
    );
  }

  if (acikTestVarMi(hedefId, kit)) {
    return i.editReply('Bu oyuncunun bu kitte zaten açık bir test kanalı var.');
  }

  // Aynı anda iki tester aynı oyuncuyu almasın (await'ten önce kilitlenir).
  const kilit = `${hedefId}:${kit}`;
  if (testAcilanlar.has(kilit)) {
    return i.editReply('Bu oyuncu için test kanalı zaten açılıyor, birkaç saniye sonra tekrar dene.');
  }
  testAcilanlar.add(kilit);

  try {
    const uye = await i.guild.members.fetch(hedefId).catch(() => null);

    if (!uye) {
      const guncel = kuyrukGetir(kit);
      const n = guncel.findIndex((k) => k.userId === hedefId);
      if (n !== -1) guncel.splice(n, 1);
      kaydet();
      panelGuncelle();
      return i.editReply('Oyuncu sunucudan ayrılmış, kuyruktan silindi. Tekrar dene.');
    }

    const izin = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ];

    const izinler = [
      { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: uye.id, allow: izin },
      { id: i.user.id, allow: izin },
      { id: client.user.id, allow: [...izin, PermissionFlagsBits.ManageChannels] },
    ];

    if (S().testerRoleId && i.guild.roles.cache.has(S().testerRoleId)) {
      izinler.push({ id: S().testerRoleId, allow: izin });
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

    // Kanal açıldıktan hemen sonra (await'siz) kuyruktan çıkar ve bileti kaydet.
    const guncel = kuyrukGetir(kit);
    const n = guncel.findIndex((k) => k.userId === hedefId);
    if (n !== -1) guncel.splice(n, 1);

    state.tickets[kanal.id] = {
      userId: uye.id,
      testerId: i.user.id,
      kit,
      nick: giris.nick,
      at: Date.now(),
      tierVerildi: false,
    };

    kaydet();
    panelGuncelle();
    await waitlistRolKaldir(i.guild, hedefId, kit);

    const embed = new EmbedBuilder()
      .setTitle(`${kit} Testi`)
      .setColor(RENK.ana)
      .addFields(
        { name: 'Oyuncu', value: `${uye}`, inline: true },
        { name: 'Tester', value: `${i.user}`, inline: true },
        { name: 'Nick', value: `\`${giris.nick}\``, inline: true }
      )
      .setDescription(
        'Test bitince tester `/tier-ver` (sadece tier seçmesi yeterli) ve ardından `/kapat` kullanacak.'
      );

    await kanal.send({ content: `${uye} test sırası sende!`, embeds: [embed] });

    await logla(
      i.guild,
      `${i.user.tag} → ${uye.user.tag} için **${kit}** testi başlattı (#${kanal.name}).`
    );

    const sonraki = kuyrukGetir(kit)[0];

    return i.editReply(
      `Kanal açıldı: ${kanal}${
        sonraki
          ? `\nSıradaki oyuncu: <@${sonraki.userId}> (\`${sonraki.nick}\`)`
          : '\nKuyrukta başka kimse yok.'
      }`
    );
  } finally {
    testAcilanlar.delete(kilit);
  }
};

// ==========================================================================
// TIER VER
// ==========================================================================

komutlar['tier-ver'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const tier = i.options.getString('tier');
  const bilet = state.tickets[i.channelId] || null;

  const kit = kitBul(i.options.getString('kit') || (bilet && bilet.kit));
  const hedefKullanici = i.options.getUser('oyuncu');
  const uyeId = hedefKullanici ? hedefKullanici.id : bilet && bilet.userId;
  const nick = (i.options.getString('nick') || (bilet && bilet.nick) || '').trim();

  if (!TIERLER.includes(tier)) return i.editReply('Geçersiz tier.');
  if (!kit) return i.editReply('Kit belirtmelisin (test kanalı dışında zorunlu).');
  if (!uyeId) return i.editReply('Oyuncu belirtmelisin (test kanalı dışında zorunlu).');
  if (!NICK_REGEX.test(nick)) {
    return i.editReply('Geçerli bir Minecraft nicki gerekli (3-16 karakter; harf, rakam ve _).');
  }

  const uye = await i.guild.members.fetch(uyeId).catch(() => null);
  if (!uye) return i.editReply('Oyuncu sunucuda bulunamadı.');
  if (uye.user.bot) return i.editReply('Botlara tier verilemez.');
  if (uye.id === i.user.id && !yoneticiMi(i.member)) {
    return i.editReply('Kendine tier veremezsin.');
  }

  const anahtar = `${uye.id}:${kit}`;
  const onceki = state.results[anahtar] ? state.results[anahtar].tier : null;

  state.results[anahtar] = { tier, nick, testerId: i.user.id, at: Date.now() };

  if (S().cooldownDays > 0) {
    state.cooldowns[anahtar] = Date.now() + S().cooldownDays * GUN;
  }

  const st = state.stats[i.user.id] || { tests: 0, last: 0 };
  st.tests += 1;
  st.last = Date.now();
  state.stats[i.user.id] = st;

  if (bilet && bilet.userId === uye.id && bilet.kit === kit) bilet.tierVerildi = true;

  kaydet();

  const rolNotu = await rolVer(i.guild, uye, kit, tier);

  const embed = new EmbedBuilder()
    .setTitle('Test Sonucu')
    .setColor(RENK.basari)
    .setThumbnail(`https://minotar.net/helm/${encodeURIComponent(nick)}/100.png`)
    .addFields(
      { name: 'Oyuncu', value: `${uye} (\`${nick}\`)`, inline: true },
      { name: 'Kit', value: kit, inline: true },
      {
        name: 'Tier',
        value: onceki && onceki !== tier ? `${onceki} → **${tier}**` : `**${tier}**`,
        inline: true,
      }
    )
    .setFooter({ text: `Tester: ${i.member.displayName}` })
    .setTimestamp();

  let duyuru = '';

  try {
    const sonucKanali = S().resultChannelId
      ? await i.guild.channels.fetch(S().resultChannelId).catch(() => null)
      : null;

    if (sonucKanali) {
      await sonucKanali.send({ embeds: [embed] });
    } else {
      duyuru = '\nSonuç kanalı ayarlı değil, duyuru yapılamadı (`/ayar sonuc-kanal`).';
    }
  } catch (e) {
    console.log('Sonuç duyurulamadı:', e.message);
    duyuru = '\nSonuç kanalına mesaj gönderilemedi, botun kanal iznini kontrol et.';
  }

  await logla(i.guild, `${i.user.tag} → ${uye.user.tag}: **${kit} ${tier}**`);

  const kapatNotu = bilet ? '\nİş bitince `/kapat` ile kanalı kapatabilirsin.' : '';

  return i.editReply(`Tier verildi: **${kit} ${tier}**\n${rolNotu}${duyuru}${kapatNotu}`);
};

// ==========================================================================
// TIER SİL
// ==========================================================================

komutlar['tier-sil'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kit = kitBul(i.options.getString('kit'));
  const hedef = i.options.getUser('oyuncu');
  if (!kit) return i.editReply('Bu kit mevcut değil.');

  const anahtar = `${hedef.id}:${kit}`;
  let silindi = false;

  if (state.results[anahtar]) {
    delete state.results[anahtar];
    silindi = true;
  }
  delete state.cooldowns[anahtar];

  const uye = await i.guild.members.fetch(hedef.id).catch(() => null);
  if (uye) {
    const roller = TIERLER.map((t) => tierRoluBul(i.guild, kit, t)).filter(
      (r) => r && uye.roles.cache.has(r.id)
    );
    if (roller.length) {
      try {
        await uye.roles.remove(roller, `${kit} tier kaydı silindi`);
        silindi = true;
      } catch (e) {
        console.log('Tier rolü kaldırılamadı:', e.message);
      }
    }
  }

  kaydet();

  if (!silindi) return i.editReply('Bu oyuncunun bu kitte tier kaydı veya rolü yok.');

  await logla(i.guild, `${i.user.tag}, ${hedef.tag} kullanıcısının **${kit}** tierini sildi.`);
  return i.editReply(`${hedef} için ${kit} tier kaydı ve rolü silindi.`);
};

// ==========================================================================
// TEST KANALINI KAPAT
// ==========================================================================

komutlar.kapat = async (i) => {
  const kayitli = state.tickets[i.channelId];

  // Kayıt kaybolmuşsa (ör. veri sıfırlanması) yalnızca "test-" kanallarına izin ver.
  const kategoriMi =
    S().ticketCategoryId &&
    i.channel.parentId === S().ticketCategoryId &&
    i.channel.name.startsWith('test-');

  if (!kayitli && !kategoriMi) {
    return i.reply({ content: 'Bu bir test kanalı değil.', flags: GIZLI });
  }

  await i.reply('Kanal kapatılıyor...');

  delete state.tickets[i.channelId];
  kaydet();

  const uyari = kayitli && !kayitli.tierVerildi ? ' (tier verilmeden kapatıldı)' : '';
  await logla(i.guild, `${i.user.tag} test kanalını kapattı (#${i.channel.name})${uyari}.`);

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
    if (!kit) return i.reply({ content: 'Bu kit mevcut değil.', flags: GIZLI });

    const mevcut = state.activeTesters[i.user.id] || [];
    if (!mevcut.includes(kit)) mevcut.push(kit);

    state.activeTesters[i.user.id] = mevcut;
    kaydet();

    return i.reply({
      content: `${kit} için aktif oldun. Aktif kitlerin: ${mevcut.join(', ')}`,
      flags: GIZLI,
    });
  }

  if (sub === 'pasif') {
    const kitAdi = i.options.getString('kit');

    if (kitAdi) {
      const kit = kitBul(kitAdi);
      if (!kit) return i.reply({ content: 'Bu kit mevcut değil.', flags: GIZLI });

      const kalan = (state.activeTesters[i.user.id] || []).filter((k) => k !== kit);
      if (kalan.length) state.activeTesters[i.user.id] = kalan;
      else delete state.activeTesters[i.user.id];
    } else {
      delete state.activeTesters[i.user.id];
    }

    kaydet();

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
      return t.length ? `**${kit}**: ${t.map((id) => `<@${id}>`).join(', ')}` : null;
    })
    .filter(Boolean);

  return i.reply({
    content: satirlar.length ? satirlar.join('\n') : 'Şu an aktif tester yok.',
    flags: GIZLI,
    allowedMentions: { parse: [] },
  });
};

// ==========================================================================
// KUYRUKTAN OYUNCU AT
// ==========================================================================

komutlar['kuyruk-at'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const hedef = i.options.getUser('oyuncu');
  let cikti = false;

  for (const kit of S().kits) {
    if (await kuyruktanCikar(i.guild, hedef.id, kit)) cikti = true;
  }

  if (cikti) {
    await logla(i.guild, `${i.user.tag}, ${hedef.tag} kullanıcısını kuyruktan çıkardı.`);
  }

  return i.editReply(cikti ? `${hedef} kuyruktan çıkarıldı.` : 'Oyuncu kuyrukta değil.');
};

// ==========================================================================
// COOLDOWN SIFIRLA
// ==========================================================================

komutlar['cooldown-sifirla'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  const hedef = i.options.getUser('oyuncu');

  if (!kit) return i.reply({ content: 'Bu kit mevcut değil.', flags: GIZLI });

  const anahtar = `${hedef.id}:${kit}`;

  if (!state.cooldowns[anahtar]) {
    return i.reply({ content: 'Bu oyuncunun cooldown süresi yok.', flags: GIZLI });
  }

  delete state.cooldowns[anahtar];
  kaydet();

  await logla(i.guild, `${i.user.tag}, ${hedef.tag} için ${kit} cooldown süresini sıfırladı.`);

  return i.reply({ content: `${hedef} için ${kit} cooldown süresi sıfırlandı.`, flags: GIZLI });
};

// ==========================================================================
// PANEL KUR
// ==========================================================================

komutlar['panel-kur'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kanal = i.options.getChannel('kanal') || i.channel;

  if (state.panel) {
    try {
      const eskiKanal = await client.channels.fetch(state.panel.channelId);
      const eskiMesaj = await eskiKanal.messages.fetch(state.panel.messageId);
      await eskiMesaj.delete();
    } catch (e) {
      // Eski panel zaten silinmiş olabilir.
    }
  }

  const mesaj = await kanal.send({ embeds: [panelEmbed()], components: panelBilesenleri() });

  state.panel = { channelId: kanal.id, messageId: mesaj.id };
  kaydet();

  return i.editReply(`Bekleme listesi paneli ${kanal} kanalına gönderildi. Otomatik güncellenir.`);
};

// ==========================================================================
// KUYRUĞU TEMİZLE
// ==========================================================================

komutlar['kuyruk-temizle'] = async (i) => {
  await i.deferReply({ flags: GIZLI });

  const kit = i.options.getString('kit');
  const hedefKit = kit ? kitBul(kit) : null;
  if (kit && !hedefKit) return i.editReply('Bu kit mevcut değil.');

  const secilenler = hedefKit ? [hedefKit] : S().kits;
  const silinen = secilenler.reduce((n, k) => n + kuyrukGetir(k).length, 0);

  for (const k of secilenler) {
    const oyuncular = [...kuyrukGetir(k)];
    state.queues[k] = [];
    for (const oyuncu of oyuncular) await waitlistRolKaldir(i.guild, oyuncu.userId, k);
  }

  kaydet();
  panelGuncelle();

  await logla(i.guild, `${i.user.tag} ${hedefKit || 'tüm'} kuyrukları temizledi (${silinen} kişi).`);

  return i.editReply(`${hedefKit || 'Tüm'} kuyruklar temizlendi (${silinen} kişi).`);
};

// ==========================================================================
// AYAR KOMUTLARI
// ==========================================================================

komutlar.ayar = async (i) => {
  const sub = i.options.getSubcommand();
  const s = S();

  const yanit = (metin) =>
    i.deferred || i.replied
      ? i.editReply({ content: metin })
      : i.reply({ content: metin, flags: GIZLI });

  const tamam = (metin) => {
    kaydet();
    return yanit(metin);
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
          { name: 'Cooldown', value: s.cooldownDays ? `${s.cooldownDays} gün` : 'Kapalı', inline: true },
          { name: 'Kuyruk limiti (kit başına)', value: String(s.maxQueue), inline: true },
          { name: 'Otomatik rol', value: 'Her zaman açık', inline: true },
          { name: 'Özel rol eşlemeleri', value: String(Object.keys(s.roleMap).length), inline: true },
          {
            name: 'Panel',
            value: state.panel ? `<#${state.panel.channelId}>` : 'Kurulmadı (/panel-kur)',
            inline: true,
          },
          { name: `Kitler (${s.kits.length})`, value: s.kits.join(', ') }
        );

      return i.reply({ embeds: [embed], flags: GIZLI });
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
      return tamam(`Test kanalları ${kategori.name} kategorisinde açılacak.`);
    }

    case 'cooldown': {
      s.cooldownDays = i.options.getInteger('gun');
      return tamam(s.cooldownDays ? `Cooldown ${s.cooldownDays} gün oldu.` : 'Cooldown kapatıldı.');
    }

    case 'max-kuyruk': {
      s.maxQueue = i.options.getInteger('adet');
      return tamam(`Her kit için kuyruk limiti ${s.maxQueue} oldu.`);
    }

    case 'kit-ekle': {
      const isim = i.options.getString('isim').trim();

      if (!KIT_REGEX.test(isim)) {
        return yanit('Kit adı sadece harf, rakam, boşluk, _ + - içerebilir (en fazla 20).');
      }
      if (kitBul(isim)) return yanit('Bu kit zaten var.');
      if (s.kits.length >= 25) return yanit('En fazla 25 kit eklenebilir.');

      s.kits.push(isim);
      state.queues[isim] = [];
      state.queueOpen[isim] = true;
      panelGuncelle();

      return tamam(`${isim} kiti eklendi.`);
    }

    case 'kit-sil': {
      await i.deferReply({ flags: GIZLI });

      const kit = kitBul(i.options.getString('kit'));
      if (!kit) return yanit('Bu kit mevcut değil.');
      if (s.kits.length <= 1) return yanit('En az 1 kit kalmalı.');

      // Kuyruktaki oyuncuların WAITLIST rolünü temizle.
      const bekleyenler = [...kuyrukGetir(kit)];

      s.kits = s.kits.filter((k) => k !== kit);
      delete state.queues[kit];
      delete state.queueOpen[kit];

      for (const anahtar of Object.keys(s.roleMap)) {
        if (anahtar.startsWith(`${kit}:`)) delete s.roleMap[anahtar];
      }

      for (const [id, kitler] of Object.entries(state.activeTesters)) {
        const kalan = kitler.filter((k) => k !== kit);
        if (kalan.length) state.activeTesters[id] = kalan;
        else delete state.activeTesters[id];
      }

      panelGuncelle();
      kaydet();

      for (const oyuncu of bekleyenler) await waitlistRolKaldir(i.guild, oyuncu.userId, kit);

      return yanit(`${kit} kiti silindi.`);
    }

    case 'rol-esle': {
      const kit = kitBul(i.options.getString('kit'));
      const tier = i.options.getString('tier');
      const rol = i.options.getRole('rol');

      if (!kit) return yanit('Bu kit mevcut değil.');

      s.roleMap[`${kit}:${tier}`] = rol.id;
      return tamam(`${kit} ${tier} rolü ${rol} ile eşlendi.`);
    }

    case 'rol-esle-sil': {
      const kit = kitBul(i.options.getString('kit'));
      const tier = i.options.getString('tier');

      if (!kit || !s.roleMap[`${kit}:${tier}`]) return yanit('Bu kit/tier için eşleme yok.');

      delete s.roleMap[`${kit}:${tier}`];
      return tamam(`${kit} ${tier} eşlemesi kaldırıldı.`);
    }

    case 'rol-kontrol': {
      const eksik = [];
      let bulunan = 0;

      for (const kit of s.kits) {
        for (const tier of TIERLER) {
          if (tierRoluBul(i.guild, kit, tier)) bulunan += 1;
          else eksik.push(`${kit} ${tier}`);
        }
      }

      const toplam = s.kits.length * TIERLER.length;
      let metin = `Bulunan rol: **${bulunan} / ${toplam}**`;

      if (eksik.length) {
        let liste = eksik.join(', ');
        if (liste.length > 1500) liste = `${liste.slice(0, 1500)}...`;
        metin += `\nEksik: ${liste}\nEksik roller bir tier verildiğinde otomatik oluşturulur; hazır rolün varsa /ayar rol-esle ile eşleyebilirsin.`;
      }

      return yanit(metin);
    }

    default:
      return yanit('Bilinmeyen ayar.');
  }
};

// ==========================================================================
// KUYRUK BUTONLARI VE MINECRAFT NICK MODALI
// ==========================================================================

async function panelModal(i, kit) {
  // Rol oluşturma/verme 3 saniyeden uzun sürebilir, bu yüzden önce yanıtı erteliyoruz.
  await i.deferReply({ flags: GIZLI });
  const nick = i.fields.getTextInputValue('nick').trim();
  const sonuc = await kuyrugaEkle(i.guild, i.user.id, nick, kit);
  return i.editReply(sonuc.msg);
}

async function panelButon(i) {
  if (!i.customId.startsWith('wl_')) return;

  if (i.customId === 'wl_kit_select') {
    const kit = kitBul(i.values[0]);
    if (!kit) return i.reply({ content: 'Bu kit artık mevcut değil.', flags: GIZLI });

    secilenKitler.set(i.user.id, kit);

    const liste = kuyrukGetir(kit);
    const sira = siraBul(i.user.id, kit);

    const satirlar = [
      `Seçilen kit: **${kit}**`,
      `Durum: **${state.queueOpen[kit] === false ? 'Kapalı' : 'Açık'}**`,
      `Bekleyen: **${liste.length}** kişi`,
    ];
    if (sira) satirlar.push(`Senin sıran: **${sira}**`);

    return i.reply({ content: satirlar.join('\n'), flags: GIZLI });
  }

  const kit = secilenKitler.get(i.user.id);
  if (!kit || !kitBul(kit)) {
    return i.reply({ content: 'Önce panelden test olmak istediğin kiti seç.', flags: GIZLI });
  }

  if (i.customId === 'wl_toggle') {
    if (!testerMi(i.member)) {
      return i.reply({
        content: 'Bu butonu yalnızca testerlar ve yöneticiler kullanabilir.',
        flags: GIZLI,
      });
    }

    state.queueOpen[kit] = state.queueOpen[kit] === false;
    kaydet();
    panelGuncelle();

    await logla(i.guild, `${i.user.tag}, ${kit} kuyruğunu ${state.queueOpen[kit] ? 'açtı' : 'kapattı'}.`);

    return i.reply({
      content: `${kit} kuyruğu ${state.queueOpen[kit] ? 'açıldı' : 'kapatıldı'}.`,
      flags: GIZLI,
    });
  }

  if (i.customId === 'wl_join') {
    if (state.queueOpen[kit] === false) {
      return i.reply({ content: `${kit} kuyruğu kapalı.`, flags: GIZLI });
    }
    if (kuyrukGetir(kit).some((k) => k.userId === i.user.id)) {
      return i.reply({
        content: `Zaten ${kit} kuyruğundasın. Sıran: ${siraBul(i.user.id, kit)}.`,
        flags: GIZLI,
      });
    }

    const cd = cooldownKalan(i.user.id, kit);
    if (cd) {
      return i.reply({
        content: `**${kit}** için cooldown'dasın. Tekrar katılabilirsin: ${zaman(cd)}.`,
        flags: GIZLI,
      });
    }
    if (acikTestVarMi(i.user.id, kit)) {
      return i.reply({ content: `**${kit}** için zaten açık bir test kanalın var.`, flags: GIZLI });
    }

    const modal = new ModalBuilder()
      .setCustomId(`wl_nick:${kit}`)
      .setTitle(`${kit} WAITLIST`)
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
    await i.deferReply({ flags: GIZLI });
    const cikti = await kuyruktanCikar(i.guild, i.user.id, kit);
    return i.editReply(cikti ? `${kit} kuyruğundan çıkarıldın.` : `${kit} kuyruğunda değilsin.`);
  }
}

// ==========================================================================
// BOT BAŞLATMA VE OLAYLAR
// ==========================================================================

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function komutCalistir(i) {
  const ad = i.commandName;
  const fn = komutlar[ad];

  if (!fn) return;

  if (YONETICI_KOMUTLARI.has(ad) && !yoneticiMi(i.member)) {
    return i.reply({ content: 'Bu komut sadece yöneticiler için.', flags: GIZLI });
  }

  if (TESTER_KOMUTLARI.has(ad) && !testerMi(i.member)) {
    return i.reply({ content: 'Bu komut sadece testerlar için.', flags: GIZLI });
  }

  return fn(i);
}

async function otomatikTamamla(i) {
  const odak = i.options.getFocused().toLowerCase();

  const liste = S()
    .kits.filter((k) => k.toLowerCase().includes(odak))
    .slice(0, 25)
    .map((k) => ({ name: k, value: k }));

  return i.respond(liste);
}

async function hataYanit(i, err) {
  console.error('Etkileşim hatası:', err);

  const msg = 'Bir hata oluştu. Botun izinlerini (Rolleri/Kanalları Yönet) ve ayarları kontrol et.';

  try {
    if (i.deferred || i.replied) {
      await i.editReply({ content: msg });
    } else if (i.isRepliable()) {
      await i.reply({ content: msg, flags: GIZLI });
    }
  } catch (e) {
    // Yanıt verilemedi.
  }
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete()) return await otomatikTamamla(i);

    if (i.isChatInputCommand()) return await komutCalistir(i);

    if (i.isButton() || i.isStringSelectMenu()) return await panelButon(i);

    if (i.isModalSubmit() && i.customId.startsWith('wl_nick:')) {
      const kit = kitBul(i.customId.slice('wl_nick:'.length));
      if (!kit) return i.reply({ content: 'Bu kit artık mevcut değil.', flags: GIZLI });
      return await panelModal(i, kit);
    }
  } catch (err) {
    await hataYanit(i, err);
  }
});

client.on(Events.ChannelDelete, (kanal) => {
  if (state.tickets[kanal.id]) {
    delete state.tickets[kanal.id];
    kaydet();
  }
});

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(komutTanimlari);
    console.log(`${client.user.tag} hazır, ${komutTanimlari.length} komut kaydedildi.`);
  } catch (e) {
    console.log('KOMUT KAYIT HATASI:', e.message);
  }

  client.user.setActivity('Tier Test');

  panelGuncelle();

  // Süresi dolan cooldownları saatte bir temizle.
  setInterval(() => {
    const simdi = Date.now();
    let temizlendi = false;

    for (const [anahtar, bitis] of Object.entries(state.cooldowns)) {
      if (bitis <= simdi) {
        delete state.cooldowns[anahtar];
        temizlendi = true;
      }
    }

    if (temizlendi) kaydet();
  }, 3600000);
});

client.on('error', (e) => {
  console.log('Client hatası:', e.message);
});

process.on('unhandledRejection', (e) => {
  console.log('Yakalanmamış hata:', e);
});

for (const sinyal of ['SIGTERM', 'SIGINT']) {
  process.on(sinyal, () => {
    hemenKaydet();
    process.exit(0);
  });
}

// ==========================================================================
// RENDER HTTP SUNUCUSU
// ==========================================================================

http.createServer((req, res) => res.end('Bot calisiyor')).listen(process.env.PORT || 3000);

yukle();
client.login(DISCORD_TOKEN);
