// ==========================================================================
//  TIER TEST BOT  -  discord.js v14
//
//  SİSTEM ÖZETİ
//  1) WAITLIST paneli (tek panel, 7 kit butonu):
//       Oyuncu kit butonuna basar -> o kitin HAZIR rolünü alır -> kanalı görür.
//       Tekrar basarsa rol kaldırılır (ve o kuyruktan da çıkarılır).
//  2) 7 AYRI KUYRUK: NETPOT, SWORD, SMP, CPVP, MACE, AXE, UHC
//       Her kitin kendi kanalı ve kendi paneli vardır.
//       KATIL butonu -> Minecraft adı -> sıraya girer.
//  3) YÖNETİM: her kuyruk bağımsız açılıp kapatılır.
//       Yönetim butonlarını sadece tester/yönetici kullanabilir.
//  Özet: WAITLIST kanal erişimi verir, kuyruk test sırasını belirler.
//
//  Bot HİÇBİR ZAMAN rol oluşturmaz, sadece var olan rolleri verir/alır.
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

// --------------------------------------------------------------------------
//  1) TEMEL AYARLAR
//  Zorunlu: DISCORD_TOKEN ve GUILD_ID (Render > Environment).
//  İsteğe bağlı (sonradan /ayar ile de girilir):
//    TESTER_ROLE_ID, RESULT_CHANNEL_ID, TICKET_CATEGORY_ID, LOG_CHANNEL_ID
//    KIT_ROLE_NETPOT, KIT_CHANNEL_NETPOT ... (her kit için WAITLIST rolü/kanalı)
// --------------------------------------------------------------------------
const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('DISCORD_TOKEN ve GUILD_ID ortam değişkenleri zorunlu!');
  process.exit(1);
}

const KITLER = ['NETPOT', 'SWORD', 'SMP', 'CPVP', 'MACE', 'AXE', 'UHC'];
const TIERLER = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
const RENK = { ana: 0x5865f2, basari: 0x2ecc71, uyari: 0xf1c40f, hata: 0xe74c3c, gri: 0x95a5a6 };
const GUN = 86400000;
const GIZLI = MessageFlags.Ephemeral;
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

// --------------------------------------------------------------------------
//  2) VERİ KATMANI (data.json)
//  Not: Render ücretsiz planda disk kalıcı değildir; deploy/restart olunca
//  data.json silinir. Bu yüzden rol/kanal ID'lerini Render Environment'a da
//  yazabilirsin (KIT_ROLE_*, KIT_CHANNEL_*). Kalıcı disk için DATA_DIR ver.
// --------------------------------------------------------------------------
function envKitHaritasi(onek) {
  const harita = {};
  for (const kit of KITLER) {
    const deger = process.env[`${onek}_${kit}`];
    if (deger) harita[kit] = deger;
  }
  return harita;
}

function varsayilanDurum() {
  return {
    settings: {
      testerRoleId: process.env.TESTER_ROLE_ID || '',
      resultChannelId: process.env.RESULT_CHANNEL_ID || '',
      ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
      logChannelId: process.env.LOG_CHANNEL_ID || '',
      cooldownDays: 14,
      maxQueue: 50,
      autoRole: false, // false: tier rolünü bot vermez, tester elle verir
      kitRoles: envKitHaritasi('KIT_ROLE'), // kit -> WAITLIST rol ID
      kitChannels: envKitHaritasi('KIT_CHANNEL'), // kit -> kuyruk kanal ID
      roleMap: {}, // "Kit:Tier" -> tier rol ID (hazır roller için eşleme)
    },
    kitOpen: {}, // kit -> false ise kuyruk kapalı (varsayılan açık)
    queue: [], // { userId, kit, nick, joined }
    cooldowns: {}, // "userId:kit" -> bitiş zamanı (ms)
    results: {}, // "userId:kit" -> { tier, nick, testerId, at }
    tickets: {}, // kanalId -> { userId, testerId, kit, nick, at }
    stats: {}, // testerId -> { tests, last }
    panels: { waitlist: null, kits: {} }, // mesaj konumları
  };
}

let state = varsayilanDurum();

function yukle() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const kayit = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const v = varsayilanDurum();
    const ks = kayit.settings || {};
    state = {
      ...v,
      ...kayit,
      settings: {
        ...v.settings,
        ...ks,
        kitRoles: { ...v.settings.kitRoles, ...(ks.kitRoles || {}) },
        kitChannels: { ...v.settings.kitChannels, ...(ks.kitChannels || {}) },
        roleMap: ks.roleMap || {},
      },
      panels: {
        waitlist: (kayit.panels && kayit.panels.waitlist) || null,
        kits: (kayit.panels && kayit.panels.kits) || {},
      },
    };
    // Kayıtlı ID boşsa ortam değişkenindeki değeri kullan
    for (const k of ['testerRoleId', 'resultChannelId', 'ticketCategoryId', 'logChannelId']) {
      state.settings[k] = ks[k] || v.settings[k];
    }
    // Artık var olmayan kitlere ait kuyruk kayıtlarını at
    state.queue = state.queue.filter((k) => KITLER.includes(k.kit));
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
  return KITLER.find((k) => k.toLowerCase() === String(ad).toLowerCase()) || null;
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

function kitAcikMi(kit) {
  return state.kitOpen[kit] !== false;
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
//  4) TIER ROLÜ YARDIMCILARI  (bot ASLA rol oluşturmaz)
//  Rol bulma sırası: 1) /ayar rol-esle ile eşlenmiş rol  2) "KIT TIER" adlı rol
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
  for (const kit of KITLER) {
    for (const tier of TIERLER) {
      const rol = tierRoluBul(member.guild, kit, tier);
      if (rol && member.roles.cache.has(rol.id) && !sonuc[kit]) sonuc[kit] = tier;
    }
  }
  return sonuc;
}

async function rolVer(guild, uye, kit, tier) {
  if (!S().autoRole) return 'ℹ️ Otomatik tier rolü kapalı, rolü elle ver.';
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
// Katılmaya engel bir durum varsa mesajını döner, yoksa null
function kuyrukHata(member, kit) {
  if (!kitAcikMi(kit)) return `🔴 **${kit}** kuyruğu şu an kapalı.`;
  const rolId = S().kitRoles[kit];
  if (rolId && !member.roles.cache.has(rolId)) {
    return `❌ Önce WAITLIST panelinden **${kit}** rolünü almalısın.`;
  }
  const cd = cooldownKalan(member.id, kit);
  if (cd) return `⏳ **${kit}** için cooldown'dasın. Tekrar test: ${zaman(cd)}`;
  const sira = siraBul(member.id, kit);
  if (sira) return `Zaten **${kit}** kuyruğundasın (sıra: **${sira}**).`;
  if (acikTestVarMi(member.id, kit)) return `**${kit}** için zaten açık bir test kanalın var.`;
  if (kuyrukListesi(kit).length >= S().maxQueue) {
    return `❌ **${kit}** kuyruğu dolu (${S().maxQueue} kişi). Daha sonra tekrar dene.`;
  }
  return null;
}

function kuyrugaEkle(member, kit, nick) {
  const hata = kuyrukHata(member, kit);
  if (hata) return { ok: false, msg: hata };
  if (!NICK_REGEX.test(nick)) {
    return { ok: false, msg: '❌ Geçersiz Minecraft nicki (3-16 karakter, sadece harf, rakam ve _).' };
  }
  state.queue.push({ userId: member.id, kit, nick, joined: Date.now() });
  kaydet();
  panelGuncelle(kit);
  return { ok: true, msg: `✅ **${kit}** kuyruğuna girdin. Sıran: **${siraBul(member.id, kit)}**` };
}

function kuyruktanCikar(userId, kit) {
  const idx = state.queue.findIndex((k) => k.userId === userId && k.kit === kit);
  if (idx === -1) return false;
  state.queue.splice(idx, 1);
  kaydet();
  panelGuncelle(kit);
  return true;
}

// --------------------------------------------------------------------------
//  6) PANELLER
//  a) WAITLIST paneli: tek mesaj, 7 kit butonu (rol al / bırak)
//  b) Kit paneli: her kitin kendi kanalında (KATIL, AYRIL + yönetim)
// --------------------------------------------------------------------------
function waitlistEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('📋 WAITLIST')
    .setColor(RENK.ana)
    .setDescription(
      'Katılmak istediğin kitin butonuna bas: **o kitin rolünü alırsın ve kuyruk kanalını görürsün.**\n' +
        'Butona tekrar basarsan rol kaldırılır.\n\n' +
        'Sıraya girmek için kitin kanalındaki panelden **KATIL** butonunu kullan.'
    )
    .setFooter({ text: 'Son güncelleme' })
    .setTimestamp();
  for (const kit of KITLER) {
    const kanalId = S().kitChannels[kit];
    embed.addFields({
      name: kit,
      value:
        `${kanalId ? `<#${kanalId}>` : 'Kanal ayarlı değil'}\n` +
        `${kitAcikMi(kit) ? '🟢 Açık' : '🔴 Kapalı'} • 👥 ${kuyrukListesi(kit).length}`,
      inline: true,
    });
  }
  return embed;
}

function waitlistBilesenleri() {
  const butonlar = KITLER.map((kit) =>
    new ButtonBuilder().setCustomId(`wl_rol:${kit}`).setLabel(kit).setStyle(ButtonStyle.Primary)
  );
  const satirlar = [];
  for (let n = 0; n < butonlar.length; n += 5) {
    satirlar.push(new ActionRowBuilder().addComponents(butonlar.slice(n, n + 5)));
  }
  return satirlar;
}

function kitPanelEmbed(kit) {
  const acik = kitAcikMi(kit);
  const liste = kuyrukListesi(kit);
  let siraMetni = 'Kuyruk boş.';
  if (liste.length) {
    siraMetni = liste
      .slice(0, 15)
      .map((k, n) => `**${n + 1}.** <@${k.userId}> • \`${k.nick}\``)
      .join('\n');
    if (liste.length > 15) siraMetni += `\n... ve ${liste.length - 15} kişi daha`;
  }
  return new EmbedBuilder()
    .setTitle(`⚔️ ${kit} Kuyruğu`)
    .setColor(acik ? RENK.basari : RENK.hata)
    .setDescription(
      acik
        ? 'Kuyruk **açık**. **KATIL** butonuna basıp Minecraft adını gir.'
        : '🔴 Kuyruk şu an **kapalı**. Yeni katılım alınmıyor.'
    )
    .addFields(
      { name: 'Durum', value: acik ? '🟢 Açık' : '🔴 Kapalı', inline: true },
      { name: 'Bekleyen', value: String(liste.length), inline: true },
      { name: 'Sıra', value: siraMetni }
    )
    .setFooter({ text: 'Son güncelleme' })
    .setTimestamp();
}

function kitPanelBilesenleri(kit) {
  const acik = kitAcikMi(kit);
  const oyuncu = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q_join:${kit}`)
      .setLabel('KATIL')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!acik),
    new ButtonBuilder().setCustomId(`q_leave:${kit}`).setLabel('AYRIL').setStyle(ButtonStyle.Danger)
  );
  const yonetim = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q_toggle:${kit}`)
      .setLabel(acik ? 'Kuyruğu Kapat' : 'Kuyruğu Aç')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`q_next:${kit}`).setLabel('Sıradakini Al').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`q_clear:${kit}`).setLabel('Temizle').setStyle(ButtonStyle.Secondary)
  );
  return [oyuncu, yonetim];
}

// Panel güncellemeleri biriktirilir ve 2 saniyede bir toplu yapılır (rate limit)
const kirliKitler = new Set();
let panelZamanlayici = null;

async function mesajDuzenle(konum, icerik) {
  const kanal = await client.channels.fetch(konum.channelId);
  const mesaj = await kanal.messages.fetch(konum.messageId);
  await mesaj.edit(icerik);
}

function panelGuncelle(kit) {
  if (kit) kirliKitler.add(kit);
  else KITLER.forEach((k) => kirliKitler.add(k));
  clearTimeout(panelZamanlayici);
  panelZamanlayici = setTimeout(async () => {
    const kitler = [...kirliKitler];
    kirliKitler.clear();
    for (const k of kitler) {
      const konum = state.panels.kits[k];
      if (!konum) continue;
      try {
        await mesajDuzenle(konum, { embeds: [kitPanelEmbed(k)], components: kitPanelBilesenleri(k) });
      } catch (e) {
        console.log(`${k} paneli güncellenemedi:`, e.message);
      }
    }
    if (state.panels.waitlist) {
      try {
        await mesajDuzenle(state.panels.waitlist, {
          embeds: [waitlistEmbed()],
          components: waitlistBilesenleri(),
        });
      } catch (e) {
        console.log('WAITLIST paneli güncellenemedi:', e.message);
      }
    }
  }, 2000);
}

async function eskiMesajiSil(konum) {
  if (!konum) return;
  try {
    const kanal = await client.channels.fetch(konum.channelId);
    const mesaj = await kanal.messages.fetch(konum.messageId);
    await mesaj.delete();
  } catch (e) {
    /* eski mesaj zaten yok */
  }
}

// --------------------------------------------------------------------------
//  7) TEST KANALI AÇMA (slash komutu ve "Sıradakini Al" butonu ortak kullanır)
//  i: zaten deferReply yapılmış etkileşim, hedef: istenirse belirli oyuncu
// --------------------------------------------------------------------------
async function testAc(i, kit, hedef) {
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
    panelGuncelle(kit);
    return i.editReply('Oyuncu sunucudan ayrılmış, kuyruktan silindi. Tekrar dene.');
  }

  const gorunum = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  const izinler = [
    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: uye.id, allow: gorunum },
    { id: i.user.id, allow: gorunum },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
    },
  ];
  if (S().testerRoleId && i.guild.roles.cache.has(S().testerRoleId)) {
    izinler.push({ id: S().testerRoleId, allow: gorunum });
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
  panelGuncelle(kit);

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
}

// --------------------------------------------------------------------------
//  8) KOMUT TANIMLARI
// --------------------------------------------------------------------------
const kitOpt = (o, zorunlu = true) =>
  o
    .setName('kit')
    .setDescription('Kit seç')
    .setRequired(zorunlu)
    .addChoices(...KITLER.map((k) => ({ name: k, value: k })));
const tierOpt = (o) =>
  o
    .setName('tier')
    .setDescription('Tier')
    .setRequired(true)
    .addChoices(...TIERLER.map((t) => ({ name: t, value: t })));
const YONETIM = PermissionFlagsBits.ManageGuild;
const kanalTipleri = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const komutTanimlari = [
  // ---- Oyuncu komutları ----
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
    .setName('kuyruk-durum')
    .setDescription('[Tester] Bir kuyruğu aç veya kapat')
    .addStringOption((o) => kitOpt(o))
    .addBooleanOption((o) => o.setName('acik').setDescription('Açık mı?').setRequired(true)),
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
    .setName('waitlist-kur')
    .setDescription('[Yönetici] WAITLIST panelini gönder')
    .setDefaultMemberPermissions(YONETIM)
    .addChannelOption((o) =>
      o.setName('kanal').setDescription('Panelin kanalı (boşsa bu kanal)').addChannelTypes(...kanalTipleri)
    ),
  new SlashCommandBuilder()
    .setName('kuyruk-panel-kur')
    .setDescription('[Yönetici] Kuyruk panellerini kitlerin kanallarına gönder')
    .setDefaultMemberPermissions(YONETIM)
    .addStringOption((o) => kitOpt(o, false)),
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
          o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...kanalTipleri)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('log-kanal')
        .setDescription('Bot kayıtlarının yazılacağı kanal')
        .addChannelOption((o) =>
          o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...kanalTipleri)
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
        .setName('kit-rol')
        .setDescription('Bir kitin WAITLIST rolünü belirle (hazır rol)')
        .addStringOption((o) => kitOpt(o))
        .addRoleOption((o) => o.setName('rol').setDescription('Hazır rol').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('kit-kanal')
        .setDescription('Bir kitin kuyruk kanalını belirle')
        .addStringOption((o) => kitOpt(o))
        .addChannelOption((o) =>
          o.setName('kanal').setDescription('Kuyruk kanalı').setRequired(true).addChannelTypes(...kanalTipleri)
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
        .setDescription('Tier verilince bot hazır tier rolünü versin mi')
        .addBooleanOption((o) => o.setName('durum').setDescription('Açık / Kapalı').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('rol-esle')
        .setDescription('Kit + tier için hazır bir tier rolünü eşle')
        .addStringOption((o) => kitOpt(o))
        .addStringOption((o) => tierOpt(o))
        .addRoleOption((o) => o.setName('rol').setDescription('Hazır rol').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('rol-esle-sil')
        .setDescription('Tier rol eşlemesini kaldır')
        .addStringOption((o) => kitOpt(o))
        .addStringOption((o) => tierOpt(o))
    )
    .addSubcommand((s) =>
      s.setName('rol-kontrol').setDescription('Hangi kit/tier rolleri bulunuyor, hangileri eksik')
    ),
].map((c) => c.toJSON());

const TESTER_KOMUTLARI = new Set(['test-baslat', 'tier-ver', 'kapat', 'kuyruk-durum', 'kuyruk-at', 'cooldown-sifirla']);
const YONETICI_KOMUTLARI = new Set(['waitlist-kur', 'kuyruk-panel-kur', 'kuyruk-temizle', 'ayar']);

// --------------------------------------------------------------------------
//  9) KOMUT İŞLEYİCİLERİ
// --------------------------------------------------------------------------
const komutlar = {};

// ---------- Oyuncu komutları ----------
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
  const embed = kitPanelEmbed(kit);
  return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
};

komutlar.siram = async (i) => {
  const satirlar = KITLER.map((kit) => ({ kit, sira: siraBul(i.user.id, kit) }))
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
  for (const kit of KITLER) {
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
  return testAc(i, kit, i.options.getUser('oyuncu'));
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

komutlar['kuyruk-durum'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const acik = i.options.getBoolean('acik');
  state.kitOpen[kit] = acik;
  kaydet();
  panelGuncelle(kit);
  await logla(i.guild, `${acik ? '🟢' : '🔴'} ${i.user.tag} **${kit}** kuyruğunu ${acik ? 'açtı' : 'kapattı'}.`);
  return i.reply({ content: `**${kit}** kuyruğu ${acik ? 'açıldı 🟢' : 'kapatıldı 🔴'}.`, flags: GIZLI });
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
komutlar['waitlist-kur'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const kanal = i.options.getChannel('kanal') || i.channel;
  await eskiMesajiSil(state.panels.waitlist);
  const mesaj = await kanal.send({ embeds: [waitlistEmbed()], components: waitlistBilesenleri() });
  state.panels.waitlist = { channelId: kanal.id, messageId: mesaj.id };
  kaydet();
  const eksikler = KITLER.filter((k) => !S().kitRoles[k]);
  const uyari = eksikler.length
    ? `\n⚠️ Rolü ayarlanmamış kitler: ${eksikler.join(', ')} (\`/ayar kit-rol\`)`
    : '';
  return i.editReply(`✅ WAITLIST paneli ${kanal} kanalına gönderildi.${uyari}`);
};

komutlar['kuyruk-panel-kur'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const secili = kitBul(i.options.getString('kit'));
  const kitler = secili ? [secili] : KITLER;
  const sonuc = [];
  for (const kit of kitler) {
    const kanalId = S().kitChannels[kit];
    if (!kanalId) {
      sonuc.push(`⚠️ ${kit}: kanal ayarlı değil (\`/ayar kit-kanal\`)`);
      continue;
    }
    try {
      const kanal = await i.guild.channels.fetch(kanalId);
      await eskiMesajiSil(state.panels.kits[kit]);
      const mesaj = await kanal.send({ embeds: [kitPanelEmbed(kit)], components: kitPanelBilesenleri(kit) });
      state.panels.kits[kit] = { channelId: kanal.id, messageId: mesaj.id };
      sonuc.push(`✅ ${kit}: ${kanal}`);
    } catch (e) {
      sonuc.push(`❌ ${kit}: gönderilemedi (botun o kanalı görme/yazma izni var mı?)`);
    }
  }
  kaydet();
  panelGuncelle();
  return i.editReply(sonuc.join('\n'));
};

komutlar['kuyruk-temizle'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const onceki = state.queue.length;
  state.queue = state.queue.filter((k) => k.kit !== kit);
  const silinen = onceki - state.queue.length;
  kaydet();
  panelGuncelle(kit);
  await logla(i.guild, `🧹 ${i.user.tag} **${kit}** kuyruğunu temizledi (${silinen} kişi).`);
  return i.reply({ content: `**${kit}** kuyruğu temizlendi (${silinen} kişi).`, flags: GIZLI });
};

komutlar.ayar = async (i) => {
  const sub = i.options.getSubcommand();
  const s = S();
  const tamam = (metin) => {
    kaydet();
    panelGuncelle();
    return i.reply({ content: `✅ ${metin}`, flags: GIZLI });
  };

  switch (sub) {
    case 'goster': {
      const kitSatirlari = KITLER.map((kit) => {
        const rol = s.kitRoles[kit] ? `<@&${s.kitRoles[kit]}>` : 'rol yok';
        const kanal = s.kitChannels[kit] ? `<#${s.kitChannels[kit]}>` : 'kanal yok';
        return `**${kit}**: ${rol} • ${kanal} • ${kitAcikMi(kit) ? '🟢' : '🔴'}`;
      }).join('\n');
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
          { name: 'Otomatik tier rolü', value: s.autoRole ? 'Açık' : 'Kapalı', inline: true },
          { name: 'Tier rol eşlemeleri', value: String(Object.keys(s.roleMap).length), inline: true },
          {
            name: 'WAITLIST paneli',
            value: state.panels.waitlist ? `<#${state.panels.waitlist.channelId}>` : 'Kurulmadı',
            inline: true,
          },
          { name: 'Kitler (WAITLIST rolü • kuyruk kanalı • durum)', value: kitSatirlari }
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
    case 'kit-rol': {
      const kit = kitBul(i.options.getString('kit'));
      const rol = i.options.getRole('rol');
      if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
      s.kitRoles[kit] = rol.id;
      return tamam(`**${kit}** WAITLIST rolü ${rol} olarak ayarlandı.`);
    }
    case 'kit-kanal': {
      const kit = kitBul(i.options.getString('kit'));
      const kanal = i.options.getChannel('kanal');
      if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
      s.kitChannels[kit] = kanal.id;
      return tamam(
        `**${kit}** kuyruk kanalı ${kanal} olarak ayarlandı. Paneli göndermek için \`/kuyruk-panel-kur\` kullan.`
      );
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
          ? 'Otomatik tier rolü **açıldı**. Bot sadece var olan rolleri verir, rol oluşturmaz.'
          : 'Otomatik tier rolü **kapatıldı**. Tier rolleri elle verilecek.'
      );
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
      for (const kit of KITLER) {
        for (const tier of TIERLER) {
          if (tierRoluBul(i.guild, kit, tier)) bulunan += 1;
          else eksik.push(`${kit} ${tier}`);
        }
      }
      const toplam = KITLER.length * TIERLER.length;
      let metin = `Bulunan tier rolü: **${bulunan} / ${toplam}**`;
      if (eksik.length) {
        let liste = eksik.join(', ');
        if (liste.length > 1500) liste = `${liste.slice(0, 1500)}...`;
        metin += `\nEksik: ${liste}\nRolleri \`/ayar rol-esle\` ile eşleyebilirsin (ya da "KIT TIER" adıyla adlandır).`;
      }
      return i.reply({ content: metin, flags: GIZLI });
    }
    default:
      return i.reply({ content: 'Bilinmeyen ayar.', flags: GIZLI });
  }
};

// --------------------------------------------------------------------------
//  10) BUTON VE PENCERE İŞLEYİCİLERİ
// --------------------------------------------------------------------------
// WAITLIST: kit rolünü ver / kaldır
async function waitlistRolToggle(i, kit) {
  await i.deferReply({ flags: GIZLI });
  const rolId = S().kitRoles[kit];
  const rol = rolId ? i.guild.roles.cache.get(rolId) : null;
  if (!rol) {
    return i.editReply(`❌ **${kit}** için WAITLIST rolü ayarlanmamış. Bir yöneticiye haber ver (\`/ayar kit-rol\`).`);
  }
  const kanalNotu = S().kitChannels[kit] ? ` <#${S().kitChannels[kit]}> kanalını artık görebilirsin.` : '';
  try {
    if (i.member.roles.cache.has(rol.id)) {
      await i.member.roles.remove(rol);
      kuyruktanCikar(i.user.id, kit); // rol gidince kuyruktan da çık
      return i.editReply(`➖ **${kit}** rolü kaldırıldı, kuyruk kanalına erişimin kapandı.`);
    }
    await i.member.roles.add(rol);
    return i.editReply(`✅ **${kit}** rolünü aldın.${kanalNotu}\nSıraya girmek için kanaldaki **KATIL** butonunu kullan.`);
  } catch (e) {
    console.log('WAITLIST rol hatası:', e.message);
    return i.editReply('❌ Rol işlemi yapılamadı. Botun rolü bu rolün üstünde olmalı ve **Rolleri Yönet** izni olmalı.');
  }
}

// KATIL: önce kontrol, sonra Minecraft adı penceresi
async function kuyrukKatilButon(i, kit) {
  const hata = kuyrukHata(i.member, kit);
  if (hata) return i.reply({ content: hata, flags: GIZLI });
  const modal = new ModalBuilder()
    .setCustomId(`q_nick:${kit}`)
    .setTitle(`${kit} - Kuyruğa Katıl`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nick')
          .setLabel('Minecraft Adın')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(16)
          .setRequired(true)
      )
    );
  return i.showModal(modal);
}

async function nickPenceresi(i) {
  const kit = kitBul(i.customId.slice('q_nick:'.length));
  if (!kit) return i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });
  const nick = i.fields.getTextInputValue('nick').trim();
  const sonuc = kuyrugaEkle(i.member, kit, nick);
  return i.reply({ content: sonuc.msg, flags: GIZLI });
}

const BUTON_TURLERI = new Set(['wl_rol', 'q_join', 'q_leave', 'q_toggle', 'q_next', 'q_clear']);

async function butonIsle(i) {
  const [tur, kitAdi] = i.customId.split(':');
  if (!BUTON_TURLERI.has(tur)) return;
  const kit = kitBul(kitAdi);
  if (!kit) return i.reply({ content: '❌ Bu kit artık mevcut değil.', flags: GIZLI });

  switch (tur) {
    case 'wl_rol':
      return waitlistRolToggle(i, kit);
    case 'q_join':
      return kuyrukKatilButon(i, kit);
    case 'q_leave': {
      const cikti = kuyruktanCikar(i.user.id, kit);
      return i.reply({
        content: cikti ? `**${kit}** kuyruğundan çıkarıldın.` : `**${kit}** kuyruğunda değilsin.`,
        flags: GIZLI,
      });
    }
    default:
      break;
  }

  // Buradan sonrası YÖNETİM butonları: sadece tester / yönetici
  if (!testerMi(i.member)) {
    return i.reply({ content: '🔒 Bu buton sadece testerlar ve yöneticiler için.', flags: GIZLI });
  }

  if (tur === 'q_toggle') {
    state.kitOpen[kit] = !kitAcikMi(kit);
    kaydet();
    panelGuncelle(); // WAITLIST panelindeki durum da güncellensin
    await logla(
      i.guild,
      `${kitAcikMi(kit) ? '🟢' : '🔴'} ${i.user.tag} **${kit}** kuyruğunu ${kitAcikMi(kit) ? 'açtı' : 'kapattı'}.`
    );
    return i.update({ embeds: [kitPanelEmbed(kit)], components: kitPanelBilesenleri(kit) });
  }
  if (tur === 'q_next') {
    await i.deferReply({ flags: GIZLI });
    return testAc(i, kit, null);
  }
  if (tur === 'q_clear') {
    const onceki = state.queue.length;
    state.queue = state.queue.filter((k) => k.kit !== kit);
    const silinen = onceki - state.queue.length;
    kaydet();
    panelGuncelle(kit);
    await logla(i.guild, `🧹 ${i.user.tag} **${kit}** kuyruğunu temizledi (${silinen} kişi).`);
    return i.reply({ content: `**${kit}** kuyruğu temizlendi (${silinen} kişi).`, flags: GIZLI });
  }
}

// --------------------------------------------------------------------------
//  11) İSTEMCİ VE OLAYLAR
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
    if (i.isChatInputCommand()) return await komutCalistir(i);
    if (i.isButton()) return await butonIsle(i);
    if (i.isModalSubmit() && i.customId.startsWith('q_nick:')) return await nickPenceresi(i);
  } catch (err) {
    await hataYanit(i, err);
  }
});

// Elle silinen test kanallarının kaydını temizle
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
//  12) RENDER İÇİN KÜÇÜK HTTP SUNUCUSU (UptimeRobot buraya ping atar)
// --------------------------------------------------------------------------
http
  .createServer((req, res) => res.end('Bot calisiyor'))
  .listen(process.env.PORT || 3000);

client.login(DISCORD_TOKEN);
