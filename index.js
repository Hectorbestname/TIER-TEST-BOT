// ==========================================================================
//  TIER TEST BOT  -  discord.js v14
//  Özellikler: kuyruk, bekleme listesi paneli, test kanalı, tier verme,
//  cooldown, tester aktif/pasif, istatistik, yönetici ayar komutları.
//  Bot HİÇBİR ZAMAN rol oluşturmaz. Hazır rolleri kullanır (istersen).
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
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

// --------------------------------------------------------------------------
//  1) TEMEL AYARLAR
//  Zorunlu: DISCORD_TOKEN ve GUILD_ID (Render > Environment).
//  Diğerleri (TESTER_ROLE_ID, RESULT_CHANNEL_ID, TICKET_CATEGORY_ID,
//  LOG_CHANNEL_ID) isteğe bağlı: sonradan /ayar komutlarıyla da girilebilir.
// --------------------------------------------------------------------------
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

// --------------------------------------------------------------------------
//  2) VERİ KATMANI (data.json)
//  Not: Render ücretsiz planda disk kalıcı değildir. Deploy/restart olunca
//  data.json silinir. Ayarları ve kuyruğu kalıcı yapmak için Render'da
//  "Disk" ekleyip DATA_DIR değişkenini disk yoluna ver (örn. /data).
// --------------------------------------------------------------------------
function varsayilanDurum() {
  return {
    settings: {
      testerRoleId: process.env.TESTER_ROLE_ID || '',
      resultChannelId: process.env.RESULT_CHANNEL_ID || '',
      ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
      logChannelId: process.env.LOG_CHANNEL_ID || '',
      cooldownDays: 14,
      maxQueue: 50,
      autoRole: false, // false: bot rol vermez, tester elle verir
      kits: [...VARSAYILAN_KITLER],
      roleMap: {}, // "Kit:Tier" -> rol ID (hazır roller için eşleme)
    },
    queue: [], // { userId, kit, nick, joined }
    cooldowns: {}, // "userId:kit" -> bitiş zamanı (ms)
    results: {}, // "userId:kit" -> { tier, nick, testerId, at }
    activeTesters: {}, // testerId -> [kit, kit]
    tickets: {}, // kanalId -> { userId, testerId, kit, nick, at }
    stats: {}, // testerId -> { tests, last }
    panel: null, // { channelId, messageId }
  };
}

let state = varsayilanDurum();

function yukle() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const kayit = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const v = varsayilanDurum();
    state = { ...v, ...kayit, settings: { ...v.settings, ...(kayit.settings || {}) } };
    // Kayıtlı ID boşsa ortam değişkenindeki değeri kullan
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

// --------------------------------------------------------------------------
//  3) YARDIMCI FONKSİYONLAR
// --------------------------------------------------------------------------
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

function kuyrukListesi(kit) {
  return state.queue.filter((k) => k.kit === kit);
}

function siraBul(userId, kit) {
  const idx = kuyrukListesi(kit).findIndex((k) => k.userId === userId);
  return idx === -1 ? 0 : idx + 1;
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

// --------------------------------------------------------------------------
//  4) ROL YARDIMCILARI  (bot ASLA rol oluşturmaz, sadece var olanı bulur)
//  Rol bulma sırası: 1) /ayar rol-esle ile eşlenmiş rol  2) "Kit Tier" adlı rol
// --------------------------------------------------------------------------
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
      if (rol && member.roles.cache.has(rol.id) && !sonuc[kit]) sonuc[kit] = tier;
    }
  }
  return sonuc;
}

async function rolVer(guild, uye, kit, tier) {
  if (!S().autoRole) return 'ℹ️ Otomatik rol kapalı, rolü elle ver.';
  const yeni = tierRoluBul(guild, kit, tier);
  if (!yeni) {
    return `⚠️ **${kit} ${tier}** rolü bulunamadı (bot rol oluşturmaz). \`/ayar rol-esle\` ile eşle ya da elle ver.`;
  }
  const eskiler = TIERLER.map((t) => tierRoluBul(guild, kit, t)).filter(
    (r) => r && r.id !== yeni.id && uye.roles.cache.has(r.id)
  );
  try {
    if (eskiler.length) await uye.roles.remove(eskiler);
    await uye.roles.add(yeni);
    return `🎭 Rol verildi: ${yeni}`;
  } catch (e) {
    return '⚠️ Rol verilemedi. Botun rolü, verilecek rolün üstünde olmalı ve Rolleri Yönet izni olmalı.';
  }
}

// --------------------------------------------------------------------------
//  5) KUYRUK MANTIĞI
// --------------------------------------------------------------------------
function kuyrugaEkle(userId, kitAdi, nick) {
  const kit = kitBul(kitAdi);
  if (!kit) return { ok: false, msg: '❌ Bu kit mevcut değil.' };
  if (!NICK_REGEX.test(nick)) {
    return { ok: false, msg: '❌ Geçersiz Minecraft nicki (3-16 karakter, sadece harf, rakam ve _).' };
  }
  const cd = cooldownKalan(userId, kit);
  if (cd) return { ok: false, msg: `⏳ **${kit}** için cooldown'dasın. Tekrar test: ${zaman(cd)}` };
  const sira = siraBul(userId, kit);
  if (sira) return { ok: false, msg: `Zaten **${kit}** kuyruğundasın (sıra: **${sira}**).` };
  if (acikTestVarMi(userId, kit)) {
    return { ok: false, msg: `**${kit}** için zaten açık bir test kanalın var.` };
  }
  if (kuyrukListesi(kit).length >= S().maxQueue) {
    return { ok: false, msg: `❌ **${kit}** kuyruğu dolu (${S().maxQueue} kişi). Daha sonra tekrar dene.` };
  }
  state.queue.push({ userId, kit, nick, joined: Date.now() });
  kaydet();
  panelGuncelle();
  return { ok: true, msg: `✅ **${kit}** kuyruğuna girdin. Sıran: **${siraBul(userId, kit)}**` };
}

function kuyruktanCikar(userId, kit) {
  const idx = state.queue.findIndex((k) => k.userId === userId && k.kit === kit);
  if (idx === -1) return false;
  state.queue.splice(idx, 1);
  kaydet();
  panelGuncelle();
  return true;
}

// --------------------------------------------------------------------------
//  6) BEKLEME LİSTESİ PANELİ (waitlist)
//  Kanalda duran, otomatik güncellenen mesaj: kit menüsü + butonlar.
// --------------------------------------------------------------------------
function panelEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('📋 Tier Test Bekleme Listesi')
    .setColor(RENK.ana)
    .setDescription(
      'Test olmak için aşağıdaki menüden **kit seç**, açılan pencereye **Minecraft nickini** yaz.\n' +
        'Sıran gelince bir tester seninle özel kanal açacak.'
    )
    .setFooter({ text: 'Son güncelleme' })
    .setTimestamp();
  for (const kit of S().kits) {
    const testerler = aktifTesterler(kit)
      .slice(0, 5)
      .map((id) => `<@${id}>`);
    embed.addFields({
      name: kit,
      value: `👥 Kuyruk: **${kuyrukListesi(kit).length}**\n🧑‍⚖️ ${testerler.length ? testerler.join(', ') : 'Aktif tester yok'}`,
      inline: true,
    });
  }
  return embed;
}

function panelBilesenleri() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('wl_join')
    .setPlaceholder('Kuyruğa girmek için kit seç')
    .addOptions(
      S().kits.map((k) => ({
        label: k,
        value: k,
        description: `${kuyrukListesi(k).length} kişi bekliyor`,
      }))
    );
  const butonlar = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wl_leave').setLabel('Kuyruktan Çık').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wl_pos').setLabel('Sıram').setStyle(ButtonStyle.Secondary)
  );
  return [new ActionRowBuilder().addComponents(menu), butonlar];
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
    }
  }, 2000);
}

// --------------------------------------------------------------------------
//  7) KOMUT TANIMLARI
// --------------------------------------------------------------------------
const kitOpt = (o, zorunlu = true) =>
  o.setName('kit').setDescription('Kit seç').setRequired(zorunlu).setAutocomplete(true);
const tierOpt = (o) =>
  o
    .setName('tier')
    .setDescription('Tier')
    .setRequired(true)
    .addChoices(...TIERLER.map((t) => ({ name: t, value: t })));
const YONETIM = PermissionFlagsBits.ManageGuild;

const komutTanimlari = [
  // ---- Oyuncu komutları ----
  new SlashCommandBuilder()
    .setName('kuyruga-gir')
    .setDescription('Test kuyruğuna katıl')
    .addStringOption((o) => kitOpt(o))
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nickin').setRequired(true)),
  new SlashCommandBuilder()
    .setName('kuyruktan-cik')
    .setDescription('Kuyruktan ayrıl')
    .addStringOption((o) => kitOpt(o)),
  new SlashCommandBuilder()
    .setName('kuyruk')
    .setDescription('Bir kitin kuyruğunu göster')
    .addStringOption((o) => kitOpt(o)),
  new SlashCommandBuilder().setName('siram').setDescription('Hangi kuyruklarda kaçıncı sıradasın'),
  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Bir oyuncunun tierlerini göster')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu (boşsa sen)')),
  new SlashCommandBuilder().setName('istatistik').setDescription('Test istatistikleri'),

  // ---- Tester komutları ----
  new SlashCommandBuilder()
    .setName('test-baslat')
    .setDescription('[Tester] Sıradaki oyuncuyla test kanalı aç')
    .addStringOption((o) => kitOpt(o))
    .addUserOption((o) => o.setName('oyuncu').setDescription('Belirli bir oyuncuyu al (boşsa sıradaki)')),
  new SlashCommandBuilder()
    .setName('tier-ver')
    .setDescription('[Tester] Oyuncuya tier ver')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true))
    .addStringOption((o) => kitOpt(o))
    .addStringOption((o) => tierOpt(o))
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nicki').setRequired(true)),
  new SlashCommandBuilder().setName('kapat').setDescription('[Tester] Test kanalını kapat'),
  new SlashCommandBuilder()
    .setName('tester')
    .setDescription('[Tester] Aktif/pasif durumu')
    .addSubcommand((s) =>
      s.setName('aktif').setDescription('Bir kitte test almaya hazırım').addStringOption((o) => kitOpt(o))
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
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true))
    .addStringOption((o) => kitOpt(o)),
  new SlashCommandBuilder()
    .setName('cooldown-sifirla')
    .setDescription('[Tester] Oyuncunun cooldown süresini sıfırla')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true))
    .addStringOption((o) => kitOpt(o)),

  // ---- Yönetici komutları ----
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
    .setDescription('[Yönetici] Bir kitin kuyruğunu tamamen boşalt')
    .setDefaultMemberPermissions(YONETIM)
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
          o
            .setName('kanal')
            .setDescription('Kanal')
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
          o.setName('gun').setDescription('Gün (0 = kapalı)').setRequired(true).setMinValue(0).setMaxValue(90)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('max-kuyruk')
        .setDescription('Kit başına en fazla kuyruk kişisi')
        .addIntegerOption((o) =>
          o.setName('adet').setDescription('Adet').setRequired(true).setMinValue(1).setMaxValue(200)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('otomatik-rol')
        .setDescription('Tier verilince bot hazır rolü versin mi')
        .addBooleanOption((o) => o.setName('durum').setDescription('Açık / Kapalı').setRequired(true))
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

const TESTER_KOMUTLARI = new Set(['test-baslat', 'tier-ver', 'kapat', 'tester', 'kuyruk-at', 'cooldown-sifirla']);
const YONETICI_KOMUTLARI = new Set(['panel-kur', 'kuyruk-temizle', 'ayar']);

// --------------------------------------------------------------------------
//  8) KOMUT İŞLEYİCİLERİ
// --------------------------------------------------------------------------
const komutlar = {};

// ---------- Oyuncu komutları ----------
komutlar['kuyruga-gir'] = async (i) => {
  const sonuc = kuyrugaEkle(i.user.id, i.options.getString('kit'), i.options.getString('nick').trim());
  return i.reply({ content: sonuc.msg, flags: GIZLI });
};

komutlar['kuyruktan-cik'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const cikti = kuyruktanCikar(i.user.id, kit);
  return i.reply({
    content: cikti ? `**${kit}** kuyruğundan çıkarıldın.` : `**${kit}** kuyruğunda değilsin.`,
    flags: GIZLI,
  });
};

komutlar.kuyruk = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const liste = kuyrukListesi(kit);
  const testerler = aktifTesterler(kit);
  let aciklama = 'Kuyruk boş.';
  if (liste.length) {
    aciklama = liste
      .slice(0, 20)
      .map((k, n) => `**${n + 1}.** <@${k.userId}> • \`${k.nick}\` • ${zaman(k.joined)}`)
      .join('\n');
    if (liste.length > 20) aciklama += `\n... ve ${liste.length - 20} kişi daha`;
  }
  const embed = new EmbedBuilder()
    .setTitle(`${kit} Kuyruğu`)
    .setColor(RENK.ana)
    .setDescription(aciklama)
    .addFields({
      name: 'Aktif testerlar',
      value: testerler.length ? testerler.map((id) => `<@${id}>`).join(', ') : 'Şu an aktif tester yok',
    })
    .setFooter({ text: `Toplam: ${liste.length} kişi` });
  return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
};

komutlar.siram = async (i) => {
  const satirlar = S()
    .kits.map((kit) => ({ kit, sira: siraBul(i.user.id, kit) }))
    .filter((x) => x.sira)
    .map((x) => `• **${x.kit}**: ${x.sira}. sıra (toplam ${kuyrukListesi(x.kit).length})`);
  return i.reply({
    content: satirlar.length ? `Kuyruk durumun:\n${satirlar.join('\n')}` : 'Hiçbir kuyrukta değilsin.',
    flags: GIZLI,
  });
};

komutlar.profil = async (i) => {
  const uye = i.options.getMember('oyuncu') || i.member;
  const tierler = {};
  let nick = null;
  // 1) Bot üzerinden verilen kayıtlar
  for (const kit of S().kits) {
    const kayit = state.results[`${uye.id}:${kit}`];
    if (kayit) {
      tierler[kit] = kayit.tier;
      nick = kayit.nick;
    }
  }
  // 2) Hazır rollerden okunanlar (kayıt yoksa tamamlar)
  const roller = rolTierleri(uye);
  for (const [kit, tier] of Object.entries(roller)) {
    if (!tierler[kit]) tierler[kit] = tier;
  }
  const kitler = Object.keys(tierler);
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

komutlar.istatistik = async (i) => {
  const toplam = Object.values(state.stats).reduce((a, s) => a + s.tests, 0);
  const ilk = Object.entries(state.stats)
    .sort((a, b) => b[1].tests - a[1].tests)
    .slice(0, 5)
    .map(([id, s], n) => `**${n + 1}.** <@${id}> • ${s.tests} test`);
  const embed = new EmbedBuilder()
    .setTitle('📊 Test İstatistikleri')
    .setColor(RENK.ana)
    .addFields(
      { name: 'Toplam test', value: String(toplam), inline: true },
      { name: 'Kuyrukta bekleyen', value: String(state.queue.length), inline: true },
      { name: 'Açık test kanalı', value: String(Object.keys(state.tickets).length), inline: true },
      { name: 'En aktif testerlar', value: ilk.length ? ilk.join('\n') : 'Henüz test yapılmadı' }
    );
  return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
};

// ---------- Tester komutları ----------
komutlar['test-baslat'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.editReply('❌ Bu kit mevcut değil.');

  const hedef = i.options.getUser('oyuncu');
  let idx;
  let giris;
  if (hedef) {
    idx = state.queue.findIndex((k) => k.userId === hedef.id && k.kit === kit);
    giris = idx !== -1 ? state.queue[idx] : { userId: hedef.id, kit, nick: hedef.username };
  } else {
    idx = state.queue.findIndex((k) => k.kit === kit);
    if (idx === -1) return i.editReply(`**${kit}** kuyruğu boş.`);
    giris = state.queue[idx];
  }
  if (acikTestVarMi(giris.userId, kit)) {
    return i.editReply('Bu oyuncunun bu kitte zaten açık bir test kanalı var.');
  }

  const uye = await i.guild.members.fetch(giris.userId).catch(() => null);
  if (!uye) {
    if (idx !== -1) state.queue.splice(idx, 1);
    kaydet();
    panelGuncelle();
    return i.editReply('Oyuncu sunucudan ayrılmış, kuyruktan silindi. Tekrar dene.');
  }

  const izinler = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: uye.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: i.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
    },
  ];
  if (S().testerRoleId && i.guild.roles.cache.has(S().testerRoleId)) {
    izinler.push({
      id: S().testerRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
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

  // Kanal başarıyla açıldı: şimdi kuyruktan düş ve kaydı tut
  if (idx !== -1) state.queue.splice(idx, 1);
  state.tickets[kanal.id] = { userId: uye.id, testerId: i.user.id, kit, nick: giris.nick, at: Date.now() };
  kaydet();
  panelGuncelle();

  const embed = new EmbedBuilder()
    .setTitle(`🧪 ${kit} Testi`)
    .setColor(RENK.ana)
    .addFields(
      { name: 'Oyuncu', value: `${uye}`, inline: true },
      { name: 'Tester', value: `${i.user}`, inline: true },
      { name: 'Nick', value: `\`${giris.nick}\``, inline: true }
    )
    .setDescription('Test bitince tester `/tier-ver` ve ardından `/kapat` kullanacak.');
  await kanal.send({ content: `${uye} test sırası sende!`, embeds: [embed] });
  await logla(i.guild, `🧪 ${i.user.tag} → ${uye.user.tag} için **${kit}** testi başlattı (#${kanal.name}).`);

  const sonraki = kuyrukListesi(kit)[0];
  return i.editReply(
    `Kanal açıldı: ${kanal}${sonraki ? `\nSıradaki oyuncu: <@${sonraki.userId}> (\`${sonraki.nick}\`)` : '\nKuyrukta başka kimse yok.'}`
  );
};

komutlar['tier-ver'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const kit = kitBul(i.options.getString('kit'));
  const tier = i.options.getString('tier');
  const nick = i.options.getString('nick').trim();
  const uye = i.options.getMember('oyuncu');
  if (!kit) return i.editReply('❌ Bu kit mevcut değil.');
  if (!uye) return i.editReply('❌ Oyuncu sunucuda bulunamadı.');
  if (!TIERLER.includes(tier)) return i.editReply('❌ Geçersiz tier.');

  const anahtar = `${uye.id}:${kit}`;
  const onceki = state.results[anahtar] ? state.results[anahtar].tier : null;
  state.results[anahtar] = { tier, nick, testerId: i.user.id, at: Date.now() };
  if (S().cooldownDays > 0) state.cooldowns[anahtar] = Date.now() + S().cooldownDays * GUN;
  const st = state.stats[i.user.id] || { tests: 0, last: 0 };
  st.tests += 1;
  st.last = Date.now();
  state.stats[i.user.id] = st;
  kaydet();

  const rolNotu = await rolVer(i.guild, uye, kit, tier);

  const embed = new EmbedBuilder()
    .setTitle('Test Sonucu')
    .setColor(RENK.basari)
    .setThumbnail(`https://minotar.net/helm/${encodeURIComponent(nick)}/100.png`)
    .addFields(
      { name: 'Oyuncu', value: `${uye} (\`${nick}\`)`, inline: true },
      { name: 'Kit', value: kit, inline: true },
      { name: 'Tier', value: onceki && onceki !== tier ? `${onceki} → **${tier}**` : `**${tier}**`, inline: true }
    )
    .setFooter({ text: `Tester: ${i.member.displayName}` })
    .setTimestamp();

  let duyuru = '';
  const sonucKanali = S().resultChannelId
    ? await i.guild.channels.fetch(S().resultChannelId).catch(() => null)
    : null;
  if (sonucKanali) {
    await sonucKanali.send({ embeds: [embed] });
  } else {
    duyuru = '\n⚠️ Sonuç kanalı ayarlı değil, duyuru yapılamadı (`/ayar sonuc-kanal`).';
  }
  await logla(i.guild, `🏅 ${i.user.tag} → ${uye.user.tag}: **${kit} ${tier}**`);
  const kapatNotu = state.tickets[i.channelId] ? '\nİş bitince `/kapat` ile kanalı kapatabilirsin.' : '';
  return i.editReply(`Tier verildi ✅ **${kit} ${tier}**\n${rolNotu}${duyuru}${kapatNotu}`);
};

komutlar.kapat = async (i) => {
  const kayitli = state.tickets[i.channelId];
  const kategoriMi = S().ticketCategoryId && i.channel.parentId === S().ticketCategoryId;
  if (!kayitli && !kategoriMi) {
    return i.reply({ content: '❌ Bu bir test kanalı değil.', flags: GIZLI });
  }
  await i.reply('Kanal kapatılıyor...');
  delete state.tickets[i.channelId];
  kaydet();
  await logla(i.guild, `🔒 ${i.user.tag} test kanalını kapattı (#${i.channel.name}).`);
  return i.channel.delete().catch((e) => console.log('Kanal silinemedi:', e.message));
};

komutlar.tester = async (i) => {
  const sub = i.options.getSubcommand();
  if (sub === 'aktif') {
    const kit = kitBul(i.options.getString('kit'));
    if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
    const mevcut = state.activeTesters[i.user.id] || [];
    if (!mevcut.includes(kit)) mevcut.push(kit);
    state.activeTesters[i.user.id] = mevcut;
    kaydet();
    panelGuncelle();
    return i.reply({ content: `🟢 **${kit}** için aktif oldun. Aktif kitlerin: ${mevcut.join(', ')}`, flags: GIZLI });
  }
  if (sub === 'pasif') {
    const kitAdi = i.options.getString('kit');
    if (kitAdi) {
      const kit = kitBul(kitAdi);
      const kalan = (state.activeTesters[i.user.id] || []).filter((k) => k !== kit);
      if (kalan.length) state.activeTesters[i.user.id] = kalan;
      else delete state.activeTesters[i.user.id];
    } else {
      delete state.activeTesters[i.user.id];
    }
    kaydet();
    panelGuncelle();
    const kalanlar = state.activeTesters[i.user.id];
    return i.reply({
      content: kalanlar ? `🔴 Pasif oldun. Hâlâ aktif: ${kalanlar.join(', ')}` : '🔴 Tüm kitlerde pasif oldun.',
      flags: GIZLI,
    });
  }
  // liste
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

komutlar['kuyruk-at'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  const hedef = i.options.getUser('oyuncu');
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const cikti = kuyruktanCikar(hedef.id, kit);
  if (cikti) await logla(i.guild, `🗑️ ${i.user.tag}, ${hedef.tag} kullanıcısını **${kit}** kuyruğundan çıkardı.`);
  return i.reply({
    content: cikti ? `${hedef} **${kit}** kuyruğundan çıkarıldı.` : 'Oyuncu bu kuyrukta değil.',
    flags: GIZLI,
  });
};

komutlar['cooldown-sifirla'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  const hedef = i.options.getUser('oyuncu');
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const anahtar = `${hedef.id}:${kit}`;
  if (!state.cooldowns[anahtar]) return i.reply({ content: 'Bu oyuncunun cooldown süresi yok.', flags: GIZLI });
  delete state.cooldowns[anahtar];
  kaydet();
  await logla(i.guild, `♻️ ${i.user.tag}, ${hedef.tag} için **${kit}** cooldown süresini sıfırladı.`);
  return i.reply({ content: `${hedef} için **${kit}** cooldown süresi sıfırlandı.`, flags: GIZLI });
};

// ---------- Yönetici komutları ----------
komutlar['panel-kur'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const kanal = i.options.getChannel('kanal') || i.channel;
  // Eski panel varsa silmeyi dene
  if (state.panel) {
    try {
      const eskiKanal = await client.channels.fetch(state.panel.channelId);
      const eskiMesaj = await eskiKanal.messages.fetch(state.panel.messageId);
      await eskiMesaj.delete();
    } catch (e) {
      /* eski panel zaten yok */
    }
  }
  const mesaj = await kanal.send({ embeds: [panelEmbed()], components: panelBilesenleri() });
  state.panel = { channelId: kanal.id, messageId: mesaj.id };
  kaydet();
  return i.editReply(`✅ Bekleme listesi paneli ${kanal} kanalına gönderildi. Otomatik güncellenir.`);
};

komutlar['kuyruk-temizle'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const onceki = state.queue.length;
  state.queue = state.queue.filter((k) => k.kit !== kit);
  const silinen = onceki - state.queue.length;
  kaydet();
  panelGuncelle();
  await logla(i.guild, `🧹 ${i.user.tag} **${kit}** kuyruğunu temizledi (${silinen} kişi).`);
  return i.reply({ content: `**${kit}** kuyruğu temizlendi (${silinen} kişi).`, flags: GIZLI });
};

komutlar.ayar = async (i) => {
  const sub = i.options.getSubcommand();
  const s = S();
  const tamam = (metin) => {
    kaydet();
    return i.reply({ content: `✅ ${metin}`, flags: GIZLI });
  };

  switch (sub) {
    case 'goster': {
      const embed = new EmbedBuilder()
        .setTitle('⚙️ Bot Ayarları')
        .setColor(RENK.gri)
        .addFields(
          { name: 'Tester rolü', value: s.testerRoleId ? `<@&${s.testerRoleId}>` : 'Ayarlı değil', inline: true },
          { name: 'Sonuç kanalı', value: s.resultChannelId ? `<#${s.resultChannelId}>` : 'Ayarlı değil', inline: true },
          { name: 'Log kanalı', value: s.logChannelId ? `<#${s.logChannelId}>` : 'Ayarlı değil', inline: true },
          { name: 'Test kategorisi', value: s.ticketCategoryId ? `<#${s.ticketCategoryId}>` : 'Ayarlı değil', inline: true },
          { name: 'Cooldown', value: s.cooldownDays ? `${s.cooldownDays} gün` : 'Kapalı', inline: true },
          { name: 'Kit başına kuyruk', value: String(s.maxQueue), inline: true },
          { name: 'Otomatik rol', value: s.autoRole ? 'Açık' : 'Kapalı', inline: true },
          { name: 'Rol eşlemeleri', value: String(Object.keys(s.roleMap).length), inline: true },
          { name: 'Panel', value: state.panel ? `<#${state.panel.channelId}>` : 'Kurulmadı (/panel-kur)', inline: true },
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
      return tamam(`Test kanalları **${kategori.name}** kategorisinde açılacak.`);
    }
    case 'cooldown': {
      s.cooldownDays = i.options.getInteger('gun');
      return tamam(s.cooldownDays ? `Cooldown **${s.cooldownDays} gün** oldu.` : 'Cooldown kapatıldı.');
    }
    case 'max-kuyruk': {
      s.maxQueue = i.options.getInteger('adet');
      return tamam(`Kit başına kuyruk limiti **${s.maxQueue}** oldu.`);
    }
    case 'otomatik-rol': {
      s.autoRole = i.options.getBoolean('durum');
      return tamam(
        s.autoRole
          ? 'Otomatik rol **açıldı**. Bot sadece var olan rolleri verir, rol oluşturmaz.'
          : 'Otomatik rol **kapatıldı**. Roller elle verilecek.'
      );
    }
    case 'kit-ekle': {
      const isim = i.options.getString('isim').trim();
      if (!KIT_REGEX.test(isim)) {
        return i.reply({ content: '❌ Kit adı sadece harf, rakam, boşluk, _ + - içerebilir (en fazla 20).', flags: GIZLI });
      }
      if (kitBul(isim)) return i.reply({ content: '❌ Bu kit zaten var.', flags: GIZLI });
      if (s.kits.length >= 25) return i.reply({ content: '❌ En fazla 25 kit eklenebilir.', flags: GIZLI });
      s.kits.push(isim);
      panelGuncelle();
      return tamam(`**${isim}** kiti eklendi.`);
    }
    case 'kit-sil': {
      const kit = kitBul(i.options.getString('kit'));
      if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
      if (s.kits.length <= 1) return i.reply({ content: '❌ En az 1 kit kalmalı.', flags: GIZLI });
      s.kits = s.kits.filter((k) => k !== kit);
      state.queue = state.queue.filter((k) => k.kit !== kit);
      for (const anahtar of Object.keys(s.roleMap)) {
        if (anahtar.startsWith(`${kit}:`)) delete s.roleMap[anahtar];
      }
      for (const [id, kitler] of Object.entries(state.activeTesters)) {
        const kalan = kitler.filter((k) => k !== kit);
        if (kalan.length) state.activeTesters[id] = kalan;
        else delete state.activeTesters[id];
      }
      panelGuncelle();
      return tamam(`**${kit}** kiti silindi (kuyruğu ve rol eşlemeleri de temizlendi).`);
    }
    case 'rol-esle': {
      const kit = kitBul(i.options.getString('kit'));
      const tier = i.options.getString('tier');
      const rol = i.options.getRole('rol');
      if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
      s.roleMap[`${kit}:${tier}`] = rol.id;
      return tamam(`**${kit} ${tier}** → ${rol} eşlendi.`);
    }
    case 'rol-esle-sil': {
      const kit = kitBul(i.options.getString('kit'));
      const tier = i.options.getString('tier');
      if (!kit || !s.roleMap[`${kit}:${tier}`]) {
        return i.reply({ content: 'Bu kit/tier için eşleme yok.', flags: GIZLI });
      }
      delete s.roleMap[`${kit}:${tier}`];
      return tamam(`**${kit} ${tier}** eşlemesi kaldırıldı.`);
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
        metin += `\nEksik: ${liste}\nRolleri \`/ayar rol-esle\` ile eşleyebilirsin (ya da "Kit Tier" adıyla adlandır).`;
      }
      return i.reply({ content: metin, flags: GIZLI });
    }
    default:
      return i.reply({ content: 'Bilinmeyen ayar.', flags: GIZLI });
  }
};

// --------------------------------------------------------------------------
//  9) PANEL ETKİLEŞİMLERİ (menü, buton, pencere)
// --------------------------------------------------------------------------
async function panelSecim(i) {
  const kit = kitBul(i.values[0]);
  if (!kit) return i.reply({ content: '❌ Bu kit artık mevcut değil.', flags: GIZLI });
  const cd = cooldownKalan(i.user.id, kit);
  if (cd) return i.reply({ content: `⏳ **${kit}** için cooldown'dasın. Tekrar test: ${zaman(cd)}`, flags: GIZLI });
  const sira = siraBul(i.user.id, kit);
  if (sira) return i.reply({ content: `Zaten **${kit}** kuyruğundasın (sıra: **${sira}**).`, flags: GIZLI });

  const modal = new ModalBuilder()
    .setCustomId(`wl_nick:${kit}`)
    .setTitle(`${kit} - Kuyruğa Gir`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nick')
          .setLabel('Minecraft Nicki')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(16)
          .setRequired(true)
      )
    );
  return i.showModal(modal);
}

async function panelModal(i) {
  const kit = i.customId.slice('wl_nick:'.length);
  const nick = i.fields.getTextInputValue('nick').trim();
  const sonuc = kuyrugaEkle(i.user.id, kit, nick);
  return i.reply({ content: sonuc.msg, flags: GIZLI });
}

async function panelButon(i) {
  if (i.customId === 'wl_leave') {
    const onceki = state.queue.length;
    state.queue = state.queue.filter((k) => k.userId !== i.user.id);
    const silinen = onceki - state.queue.length;
    if (silinen) {
      kaydet();
      panelGuncelle();
    }
    return i.reply({
      content: silinen ? `${silinen} kuyruktan çıkarıldın.` : 'Hiçbir kuyrukta değilsin.',
      flags: GIZLI,
    });
  }
  if (i.customId === 'wl_pos') {
    return komutlar.siram(i);
  }
}

// --------------------------------------------------------------------------
//  10) İSTEMCİ VE OLAYLAR
// --------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function komutCalistir(i) {
  const ad = i.commandName;
  const fn = komutlar[ad];
  if (!fn) return;
  if (YONETICI_KOMUTLARI.has(ad) && !yoneticiMi(i.member)) {
    return i.reply({ content: '🔒 Bu komut sadece yöneticiler için.', flags: GIZLI });
  }
  if (TESTER_KOMUTLARI.has(ad) && !testerMi(i.member)) {
    return i.reply({ content: '🔒 Bu komut sadece testerlar için.', flags: GIZLI });
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
  const msg = '❌ Bir hata oluştu. Botun izinlerini (Rolleri/Kanalları Yönet) ve ayarları kontrol et.';
  try {
    if (i.deferred || i.replied) await i.editReply({ content: msg });
    else if (i.isRepliable()) await i.reply({ content: msg, flags: GIZLI });
  } catch (e) {
    /* yanıt verilemedi */
  }
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete()) return await otomatikTamamla(i);
    if (i.isChatInputCommand()) return await komutCalistir(i);
    if (i.isStringSelectMenu() && i.customId === 'wl_join') return await panelSecim(i);
    if (i.isButton()) return await panelButon(i);
    if (i.isModalSubmit() && i.customId.startsWith('wl_nick:')) return await panelModal(i);
  } catch (err) {
    await hataYanit(i, err);
  }
});

// Silinen test kanallarının kaydını temizle (elle silinirse)
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
    console.log(`${client.user.tag} hazır, ${komutTanimlari.length} komut kaydedildi.`);
  } catch (e) {
    console.log('KOMUT KAYIT HATASI:', e.message);
  }
  client.user.setActivity('Tier Test');
  panelGuncelle();

  // Her saat süresi dolan cooldown kayıtlarını temizle
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

client.on('error', (e) => console.log('Client hatası:', e.message));
process.on('unhandledRejection', (e) => console.log('Yakalanmamış hata:', e));
process.on('SIGTERM', () => {
  hemenKaydet();
  process.exit(0);
});

// --------------------------------------------------------------------------
//  11) RENDER İÇİN KÜÇÜK HTTP SUNUCUSU (UptimeRobot buraya ping atar)
// --------------------------------------------------------------------------
http
  .createServer((req, res) => res.end('Bot calisiyor'))
  .listen(process.env.PORT || 3000);

client.login(DISCORD_TOKEN);
