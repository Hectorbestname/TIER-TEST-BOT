// ==========================================================================
//  TIER TEST BOT v2  -  discord.js v14
//
//  AKIŞ
//  1) #waitlist panelinde kit butonuna bas -> o kitin WAITLIST rolünü alırsın
//     ve kitin KENDİ ÖZEL KANALI açılır. Bot kanalı linkle gösterir.
//  2) O kanalda KATIL -> Minecraft adın -> sıraya girersin.
//  3) Tester "Sıradakini Al" der -> özel test kanalı açılır.
//  4) /tier-ver -> tier kaydedilir, TIER ROLÜ OTOMATİK VERİLİR, sonuç duyurulur.
//
//  KURULUM: sunucuda /kurulum yaz. Bot roller, kategoriler, kanallar ve
//  panelleri kendisi oluşturur. Tekrar çalıştırırsan mevcut olanları bulur,
//  kopya oluşturmaz (Render'da data.json silinse bile güvenle tekrar çalıştır).
//
//  Gerekli ortam değişkenleri: DISCORD_TOKEN, GUILD_ID
//  Botun izinleri: Rolleri Yönet, Kanalları Yönet (en kolayı: Administrator)
//  ÖNEMLİ: Botun rolü, verdiği rollerin ÜSTÜNDE olmalı (Sunucu Ayarları > Roller).
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
  PermissionFlagsBits: P,
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

// Kit listesini istediğin gibi değiştirebilirsin (en fazla 25)
const KITLER = ['NETPOT', 'SWORD', 'SMP', 'CPVP', 'MACE', 'AXE', 'UHC'];
const TIERLER = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
const RENK = { ana: 0x5865f2, basari: 0x2ecc71, uyari: 0xf1c40f, hata: 0xe74c3c, gri: 0x95a5a6 };
const TIER_RENK = { 1: 0xf1c40f, 2: 0xe67e22, 3: 0x3498db, 4: 0x2ecc71, 5: 0x95a5a6 };
const GUN = 86400000;
const GIZLI = MessageFlags.Ephemeral;
const NICK_REGEX = /^[A-Za-z0-9_]{3,16}$/;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --------------------------------------------------------------------------
//  VERİ
// --------------------------------------------------------------------------
function varsayilanDurum() {
  return {
    settings: {
      testerRoleId: process.env.TESTER_ROLE_ID || '',
      resultChannelId: process.env.RESULT_CHANNEL_ID || '',
      logChannelId: process.env.LOG_CHANNEL_ID || '',
      ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
      cooldownDays: 14,
      maxQueue: 50,
      autoRole: true, // tier verilince rol otomatik verilir (yoksa oluşturulur)
      kitRoles: {}, // kit -> WAITLIST rol ID
      kitChannels: {}, // kit -> kuyruk kanalı ID
    },
    kitOpen: {}, // kit -> false ise kapalı
    queue: [], // { userId, kit, nick, joined }
    cooldowns: {}, // "userId:kit" -> bitiş (ms)
    results: {}, // "userId:kit" -> { tier, nick, testerId, at }
    tickets: {}, // kanalId -> { userId, testerId, kit, nick, at }
    stats: {}, // testerId -> { tests, last }
    panels: { waitlist: null, kits: {} },
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
        kitRoles: ks.kitRoles || {},
        kitChannels: ks.kitChannels || {},
      },
      panels: {
        waitlist: (kayit.panels && kayit.panels.waitlist) || null,
        kits: (kayit.panels && kayit.panels.kits) || {},
      },
    };
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
//  YARDIMCILAR
// --------------------------------------------------------------------------
const S = () => state.settings;
const zaman = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const kitBul = (ad) => (ad ? KITLER.find((k) => k.toLowerCase() === String(ad).toLowerCase()) || null : null);
const yoneticiMi = (m) => m.permissions.has(P.Administrator) || m.permissions.has(P.ManageGuild);
const testerMi = (m) => yoneticiMi(m) || (Boolean(S().testerRoleId) && m.roles.cache.has(S().testerRoleId));
const kitAcikMi = (kit) => state.kitOpen[kit] !== false;
const kuyrukListesi = (kit) => state.queue.filter((k) => k.kit === kit);
const acikTestVarMi = (userId, kit) => Object.values(state.tickets).some((t) => t.userId === userId && t.kit === kit);

function cooldownKalan(userId, kit) {
  const bitis = state.cooldowns[`${userId}:${kit}`];
  return bitis && bitis > Date.now() ? bitis : null;
}
function siraBul(userId, kit) {
  const idx = kuyrukListesi(kit).findIndex((k) => k.userId === userId);
  return idx === -1 ? 0 : idx + 1;
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
//  ROL / KANAL BUL-VEYA-OLUŞTUR
// --------------------------------------------------------------------------
async function rolBulVeyaOlustur(guild, ad, ekstra = {}) {
  await guild.roles.fetch();
  let rol = guild.roles.cache.find((r) => r.name.toLowerCase() === ad.toLowerCase());
  if (!rol) rol = await guild.roles.create({ name: ad, reason: 'Tier bot', ...ekstra });
  return rol;
}

async function kanalBulVeyaOlustur(guild, ad, tip, parent, izinler) {
  await guild.channels.fetch();
  let kanal = guild.channels.cache.find(
    (c) => c.name === ad && c.type === tip && (tip === ChannelType.GuildCategory || c.parentId === (parent || null))
  );
  if (kanal) {
    if (izinler) await kanal.permissionOverwrites.set(izinler).catch(() => {});
    return kanal;
  }
  return guild.channels.create({
    name: ad,
    type: tip,
    parent: parent || null,
    permissionOverwrites: izinler || [],
    reason: 'Tier bot kurulumu',
  });
}

// Tier rolü: "KIT TIER" adıyla bulunur, yoksa oluşturulur
function tierRoluBul(guild, kit, tier) {
  const ad = `${kit} ${tier}`.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === ad) || null;
}

async function tierRoluAl(guild, kit, tier) {
  await guild.roles.fetch();
  const var_ = tierRoluBul(guild, kit, tier);
  if (var_) return var_;
  const num = Number(tier.slice(2));
  return guild.roles.create({
    name: `${kit} ${tier}`,
    color: TIER_RENK[num] || 0x95a5a6,
    mentionable: false,
    reason: 'Tier bot: tier rolü',
  });
}

async function rolVer(guild, uye, kit, tier) {
  if (!S().autoRole) return 'ℹ️ Otomatik tier rolü kapalı (`/ayar otomatik-rol`), rolü elle ver.';
  try {
    const yeni = await tierRoluAl(guild, kit, tier);
    const eskiler = TIERLER.map((t) => tierRoluBul(guild, kit, t)).filter(
      (r) => r && r.id !== yeni.id && uye.roles.cache.has(r.id)
    );
    if (eskiler.length) await uye.roles.remove(eskiler);
    await uye.roles.add(yeni);
    return `🎭 Rol verildi: ${yeni}`;
  } catch (e) {
    console.log('Tier rolü hatası:', e.message);
    return '⚠️ Rol verilemedi. Botun rolünü Sunucu Ayarları > Roller listesinde en üste taşı ve **Rolleri Yönet** izni ver.';
  }
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

// --------------------------------------------------------------------------
//  KUYRUK MANTIĞI
// --------------------------------------------------------------------------
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
  if (kuyrukListesi(kit).length >= S().maxQueue) return `❌ **${kit}** kuyruğu dolu (${S().maxQueue} kişi).`;
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

function kuyrukTemizle(kit) {
  const onceki = state.queue.length;
  state.queue = state.queue.filter((k) => k.kit !== kit);
  kaydet();
  panelGuncelle(kit);
  return onceki - state.queue.length;
}

// --------------------------------------------------------------------------
//  PANELLER
// --------------------------------------------------------------------------
function waitlistEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('📋 WAITLIST')
    .setColor(RENK.ana)
    .setDescription(
      '**Nasıl çalışır?**\n' +
        '1️⃣ Test olmak istediğin kitin butonuna bas.\n' +
        '2️⃣ Kitin **özel kuyruk kanalı** sana açılır.\n' +
        '3️⃣ O kanaldaki **KATIL** butonuyla Minecraft adını girip sıraya gir.\n\n' +
        'Aynı anda birden fazla kite girebilirsin. Butona tekrar basarsan o kitten ayrılırsın.'
    )
    .setFooter({ text: 'Son güncelleme' })
    .setTimestamp();
  for (const kit of KITLER) {
    const kanalId = S().kitChannels[kit];
    embed.addFields({
      name: kit,
      value:
        `${kanalId ? `<#${kanalId}>` : '`kanal yok`'}\n` +
        `${kitAcikMi(kit) ? '🟢 Açık' : '🔴 Kapalı'} • 👥 ${kuyrukListesi(kit).length}`,
      inline: true,
    });
  }
  return embed;
}

function waitlistBilesenleri() {
  const butonlar = KITLER.map((kit) =>
    new ButtonBuilder().setCustomId(`wl:${kit}`).setLabel(kit).setStyle(ButtonStyle.Primary)
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
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`q_join:${kit}`).setLabel('KATIL').setStyle(ButtonStyle.Success).setDisabled(!acik),
      new ButtonBuilder().setCustomId(`q_leave:${kit}`).setLabel('AYRIL').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`q_toggle:${kit}`)
        .setLabel(acik ? 'Kuyruğu Kapat' : 'Kuyruğu Aç')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`q_next:${kit}`).setLabel('Sıradakini Al').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`q_clear:${kit}`).setLabel('Temizle').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function mesajDuzenle(konum, icerik) {
  const kanal = await client.channels.fetch(konum.channelId);
  const mesaj = await kanal.messages.fetch(konum.messageId);
  await mesaj.edit(icerik);
}

async function eskiMesajiSil(konum) {
  if (!konum) return;
  try {
    const kanal = await client.channels.fetch(konum.channelId);
    const mesaj = await kanal.messages.fetch(konum.messageId);
    await mesaj.delete();
  } catch (e) {
    /* zaten yok */
  }
}

async function waitlistPanelGonder(kanal) {
  await eskiMesajiSil(state.panels.waitlist);
  const mesaj = await kanal.send({ embeds: [waitlistEmbed()], components: waitlistBilesenleri() });
  state.panels.waitlist = { channelId: kanal.id, messageId: mesaj.id };
  kaydet();
}

async function kitPanelGonder(kit, kanal) {
  await eskiMesajiSil(state.panels.kits[kit]);
  const mesaj = await kanal.send({ embeds: [kitPanelEmbed(kit)], components: kitPanelBilesenleri(kit) });
  state.panels.kits[kit] = { channelId: kanal.id, messageId: mesaj.id };
  kaydet();
}

// Güncellemeler biriktirilir, 2 saniyede bir toplu yapılır (rate limit)
const kirliKitler = new Set();
let panelZamanlayici = null;
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
        await mesajDuzenle(state.panels.waitlist, { embeds: [waitlistEmbed()], components: waitlistBilesenleri() });
      } catch (e) {
        console.log('WAITLIST paneli güncellenemedi:', e.message);
      }
    }
  }, 2000);
}

// --------------------------------------------------------------------------
//  TEST KANALI AÇMA
// --------------------------------------------------------------------------
const kilitliKitler = new Set(); // aynı anda iki tester aynı oyuncuyu almasın

async function testAc(i, kit, hedef) {
  if (kilitliKitler.has(kit)) return i.editReply('Başka bir tester şu an bu kuyruktan oyuncu alıyor, birkaç saniye sonra tekrar dene.');
  kilitliKitler.add(kit);
  try {
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
    if (acikTestVarMi(giris.userId, kit)) return i.editReply('Bu oyuncunun bu kitte zaten açık bir test kanalı var.');

    const uye = await i.guild.members.fetch(giris.userId).catch(() => null);
    if (!uye) {
      if (idx !== -1) state.queue.splice(idx, 1);
      kaydet();
      panelGuncelle(kit);
      return i.editReply('Oyuncu sunucudan ayrılmış, kuyruktan silindi. Tekrar dene.');
    }

    const gorunum = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory];
    const izinler = [
      { id: i.guild.id, deny: [P.ViewChannel] },
      { id: uye.id, allow: gorunum },
      { id: i.user.id, allow: gorunum },
      { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels] },
    ];
    if (S().testerRoleId && i.guild.roles.cache.has(S().testerRoleId)) {
      izinler.push({ id: S().testerRoleId, allow: gorunum });
    }

    const kanalAdi = `test-${giris.nick}-${kit}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
    const kanal = await i.guild.channels.create({
      name: kanalAdi,
      type: ChannelType.GuildText,
      parent: S().ticketCategoryId || null,
      permissionOverwrites: izinler,
    });

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
      .setDescription('Test bitince tester `/tier-ver tier:<tier>` yazar (oyuncu, kit ve nick bu kanaldan otomatik alınır), ardından `/kapat` kullanır.');
    await kanal.send({ content: `${uye} test sırası sende!`, embeds: [embed] });
    await logla(i.guild, `🧪 ${i.user.tag} → ${uye.user.tag} için **${kit}** testi başlattı (#${kanal.name}).`);

    const sonraki = kuyrukListesi(kit)[0];
    return i.editReply(
      `Kanal açıldı: ${kanal}${sonraki ? `\nSıradaki oyuncu: <@${sonraki.userId}> (\`${sonraki.nick}\`)` : '\nKuyrukta başka kimse yok.'}`
    );
  } finally {
    kilitliKitler.delete(kit);
  }
}

// --------------------------------------------------------------------------
//  KOMUT TANIMLARI
// --------------------------------------------------------------------------
const kitOpt = (o, zorunlu = true) =>
  o.setName('kit').setDescription('Kit seç').setRequired(zorunlu).addChoices(...KITLER.map((k) => ({ name: k, value: k })));
const tierOpt = (o, zorunlu = true) =>
  o.setName('tier').setDescription('Tier').setRequired(zorunlu).addChoices(...TIERLER.map((t) => ({ name: t, value: t })));
const kanalTipleri = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const komutTanimlari = [
  // ---- Oyuncu ----
  new SlashCommandBuilder().setName('kuyruktan-cik').setDescription('Kuyruktan ayrıl').addStringOption((o) => kitOpt(o)),
  new SlashCommandBuilder().setName('kuyruk').setDescription('Bir kitin kuyruğunu göster').addStringOption((o) => kitOpt(o)),
  new SlashCommandBuilder().setName('siram').setDescription('Hangi kuyruklarda kaçıncı sıradasın'),
  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Bir oyuncunun tierlerini göster')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu (boşsa sen)')),
  new SlashCommandBuilder().setName('istatistik').setDescription('Test istatistikleri'),

  // ---- Tester ----
  new SlashCommandBuilder()
    .setName('test-baslat')
    .setDescription('[Tester] Sıradaki oyuncuyla test kanalı aç')
    .addStringOption((o) => kitOpt(o))
    .addUserOption((o) => o.setName('oyuncu').setDescription('Belirli bir oyuncuyu al (boşsa sıradaki)')),
  new SlashCommandBuilder()
    .setName('tier-ver')
    .setDescription('[Tester] Oyuncuya tier ver (test kanalında oyuncu/kit/nick otomatik)')
    .addStringOption((o) => tierOpt(o))
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu (test kanalında boş bırakılabilir)'))
    .addStringOption((o) => kitOpt(o, false))
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nicki (test kanalında boş bırakılabilir)')),
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

  // ---- Yönetici ----
  new SlashCommandBuilder()
    .setName('kurulum')
    .setDescription('[Yönetici] Roller, kanallar ve panelleri otomatik kur')
    .setDefaultMemberPermissions(P.ManageGuild),
  new SlashCommandBuilder()
    .setName('panel-yenile')
    .setDescription('[Yönetici] WAITLIST ve kuyruk panellerini yeniden gönder')
    .setDefaultMemberPermissions(P.ManageGuild),
  new SlashCommandBuilder()
    .setName('kuyruk-temizle')
    .setDescription('[Yönetici] Bir kitin kuyruğunu boşalt')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addStringOption((o) => kitOpt(o)),
  new SlashCommandBuilder()
    .setName('ayar')
    .setDescription('[Yönetici] Bot ayarları')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('goster').setDescription('Mevcut ayarları göster'))
    .addSubcommand((s) =>
      s.setName('tester-rol').setDescription('Tester rolünü belirle').addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('sonuc-kanal')
        .setDescription('Sonuç kanalı')
        .addChannelOption((o) => o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...kanalTipleri))
    )
    .addSubcommand((s) =>
      s
        .setName('log-kanal')
        .setDescription('Log kanalı')
        .addChannelOption((o) => o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...kanalTipleri))
    )
    .addSubcommand((s) =>
      s
        .setName('ticket-kategori')
        .setDescription('Test kanallarının açılacağı kategori')
        .addChannelOption((o) =>
          o.setName('kategori').setDescription('Kategori').setRequired(true).addChannelTypes(ChannelType.GuildCategory)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('kit-rol')
        .setDescription('Bir kitin WAITLIST rolünü elle belirle')
        .addStringOption((o) => kitOpt(o))
        .addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('kit-kanal')
        .setDescription('Bir kitin kuyruk kanalını elle belirle')
        .addStringOption((o) => kitOpt(o))
        .addChannelOption((o) => o.setName('kanal').setDescription('Kanal').setRequired(true).addChannelTypes(...kanalTipleri))
    )
    .addSubcommand((s) =>
      s
        .setName('cooldown')
        .setDescription('Tekrar test bekleme süresi (gün)')
        .addIntegerOption((o) => o.setName('gun').setDescription('Gün (0 = kapalı)').setRequired(true).setMinValue(0).setMaxValue(90))
    )
    .addSubcommand((s) =>
      s
        .setName('max-kuyruk')
        .setDescription('Kit başına en fazla kuyruk kişisi')
        .addIntegerOption((o) => o.setName('adet').setDescription('Adet').setRequired(true).setMinValue(1).setMaxValue(200))
    )
    .addSubcommand((s) =>
      s
        .setName('otomatik-rol')
        .setDescription('Tier verilince bot tier rolünü versin mi')
        .addBooleanOption((o) => o.setName('durum').setDescription('Açık / Kapalı').setRequired(true))
    ),
].map((c) => c.toJSON());

const TESTER_KOMUTLARI = new Set(['test-baslat', 'tier-ver', 'kapat', 'kuyruk-durum', 'kuyruk-at', 'cooldown-sifirla']);
const YONETICI_KOMUTLARI = new Set(['kurulum', 'panel-yenile', 'kuyruk-temizle', 'ayar']);

// --------------------------------------------------------------------------
//  KOMUTLAR
// --------------------------------------------------------------------------
const komutlar = {};
const kitYok = (i) => i.reply({ content: '❌ Bu kit mevcut değil.', flags: GIZLI });

// ---------- Oyuncu ----------
komutlar['kuyruktan-cik'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return kitYok(i);
  const cikti = kuyruktanCikar(i.user.id, kit);
  return i.reply({ content: cikti ? `**${kit}** kuyruğundan çıkarıldın.` : `**${kit}** kuyruğunda değilsin.`, flags: GIZLI });
};

komutlar.kuyruk = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return kitYok(i);
  return i.reply({ embeds: [kitPanelEmbed(kit)], allowedMentions: { parse: [] } });
};

komutlar.siram = async (i) => {
  const satirlar = KITLER.map((kit) => ({ kit, sira: siraBul(i.user.id, kit) }))
    .filter((x) => x.sira)
    .map((x) => `• **${x.kit}**: ${x.sira}. sıra (toplam ${kuyrukListesi(x.kit).length})`);
  return i.reply({ content: satirlar.length ? `Kuyruk durumun:\n${satirlar.join('\n')}` : 'Hiçbir kuyrukta değilsin.', flags: GIZLI });
};

komutlar.profil = async (i) => {
  const uye = i.options.getMember('oyuncu') || i.member;
  const tierler = {};
  let nick = null;
  for (const kit of KITLER) {
    const kayit = state.results[`${uye.id}:${kit}`];
    if (kayit) {
      tierler[kit] = kayit.tier;
      nick = kayit.nick;
    }
  }
  for (const [kit, tier] of Object.entries(rolTierleri(uye))) {
    if (!tierler[kit]) tierler[kit] = tier;
  }
  const kitler = Object.keys(tierler);
  if (!kitler.length) return i.reply({ content: `${uye.displayName} henüz test olmamış.`, flags: GIZLI });
  const embed = new EmbedBuilder().setTitle(`${nick || uye.displayName} - Tierler`).setColor(RENK.uyari).setThumbnail(uye.displayAvatarURL());
  for (const kit of kitler) {
    const cd = cooldownKalan(uye.id, kit);
    embed.addFields({ name: kit, value: `**${tierler[kit]}**${cd ? `\nCooldown: ${zaman(cd)}` : ''}`, inline: true });
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

// ---------- Tester ----------
komutlar['test-baslat'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return i.editReply('❌ Bu kit mevcut değil.');
  return testAc(i, kit, i.options.getUser('oyuncu'));
};

komutlar['tier-ver'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const bilet = state.tickets[i.channelId];
  const tier = i.options.getString('tier');
  if (!TIERLER.includes(tier)) return i.editReply('❌ Geçersiz tier.');

  const kit = kitBul(i.options.getString('kit')) || (bilet ? bilet.kit : null);
  if (!kit) return i.editReply('❌ Kit belirtmelisin (test kanalı dışındasın).');

  const uye =
    i.options.getMember('oyuncu') || (bilet ? await i.guild.members.fetch(bilet.userId).catch(() => null) : null);
  if (!uye) return i.editReply('❌ Oyuncu bulunamadı. Test kanalı dışındaysan `oyuncu` seçmelisin.');

  const anahtar = `${uye.id}:${kit}`;
  const nick = (i.options.getString('nick') || (bilet && bilet.nick) || (state.results[anahtar] && state.results[anahtar].nick) || '').trim();
  if (!NICK_REGEX.test(nick)) return i.editReply('❌ Geçerli bir Minecraft nicki gerekli (`nick` seçeneğini doldur).');

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
  const sonucKanali = S().resultChannelId ? await i.guild.channels.fetch(S().resultChannelId).catch(() => null) : null;
  if (sonucKanali) await sonucKanali.send({ embeds: [embed] });
  else duyuru = '\n⚠️ Sonuç kanalı ayarlı değil (`/kurulum` ya da `/ayar sonuc-kanal`).';
  await logla(i.guild, `🏅 ${i.user.tag} → ${uye.user.tag}: **${kit} ${tier}**`);
  const kapatNotu = bilet ? '\nİş bitince `/kapat` ile kanalı kapat.' : '';
  return i.editReply(`Tier verildi ✅ **${kit} ${tier}**\n${rolNotu}${duyuru}${kapatNotu}`);
};

komutlar.kapat = async (i) => {
  // Sadece botun açtığı (kayıtlı) test kanalları kapatılabilir
  if (!state.tickets[i.channelId]) return i.reply({ content: '❌ Bu bir test kanalı değil.', flags: GIZLI });
  await i.reply('Kanal kapatılıyor...');
  delete state.tickets[i.channelId];
  kaydet();
  await logla(i.guild, `🔒 ${i.user.tag} test kanalını kapattı (#${i.channel.name}).`);
  return i.channel.delete().catch((e) => console.log('Kanal silinemedi:', e.message));
};

komutlar['kuyruk-durum'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return kitYok(i);
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
  if (!kit) return kitYok(i);
  const cikti = kuyruktanCikar(hedef.id, kit);
  if (cikti) await logla(i.guild, `🗑️ ${i.user.tag}, ${hedef.tag} kullanıcısını **${kit}** kuyruğundan çıkardı.`);
  return i.reply({ content: cikti ? `${hedef} **${kit}** kuyruğundan çıkarıldı.` : 'Oyuncu bu kuyrukta değil.', flags: GIZLI });
};

komutlar['cooldown-sifirla'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  const hedef = i.options.getUser('oyuncu');
  if (!kit) return kitYok(i);
  const anahtar = `${hedef.id}:${kit}`;
  if (!state.cooldowns[anahtar]) return i.reply({ content: 'Bu oyuncunun cooldown süresi yok.', flags: GIZLI });
  delete state.cooldowns[anahtar];
  kaydet();
  await logla(i.guild, `♻️ ${i.user.tag}, ${hedef.tag} için **${kit}** cooldown süresini sıfırladı.`);
  return i.reply({ content: `${hedef} için **${kit}** cooldown süresi sıfırlandı.`, flags: GIZLI });
};

// ---------- Yönetici ----------
komutlar.kurulum = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const g = i.guild;
  const s = S();
  const botIzin = { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.EmbedLinks] };
  try {
    // Roller
    await g.roles.fetch();
    let tester = s.testerRoleId ? g.roles.cache.get(s.testerRoleId) : null;
    if (!tester) tester = await rolBulVeyaOlustur(g, 'Tester', { color: RENK.ana });
    s.testerRoleId = tester.id;

    // Kategoriler
    const herkesOkur = (ekstra = []) => [
      { id: g.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
      botIzin,
      ...ekstra,
    ];
    const anaKat = await kanalBulVeyaOlustur(g, 'TIER TEST', ChannelType.GuildCategory, null, null);
    const kuyrukKat = await kanalBulVeyaOlustur(g, 'KUYRUKLAR', ChannelType.GuildCategory, null, null);
    const testKat = await kanalBulVeyaOlustur(g, 'TEST KANALLARI', ChannelType.GuildCategory, null, [
      { id: g.id, deny: [P.ViewChannel] },
      { id: tester.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
      botIzin,
    ]);
    s.ticketCategoryId = testKat.id;

    // Ortak kanallar
    const waitlistKanal = await kanalBulVeyaOlustur(g, 'waitlist', ChannelType.GuildText, anaKat.id, herkesOkur());
    const sonucKanal = await kanalBulVeyaOlustur(g, 'sonuclar', ChannelType.GuildText, anaKat.id, herkesOkur());
    const logKanal = await kanalBulVeyaOlustur(g, 'tester-log', ChannelType.GuildText, anaKat.id, [
      { id: g.id, deny: [P.ViewChannel] },
      { id: tester.id, allow: [P.ViewChannel, P.ReadMessageHistory] },
      botIzin,
    ]);
    s.resultChannelId = sonucKanal.id;
    s.logChannelId = logKanal.id;

    // Her kit için: WAITLIST rolü + özel kuyruk kanalı
    for (const kit of KITLER) {
      const rol = await rolBulVeyaOlustur(g, `${kit} Waitlist`);
      s.kitRoles[kit] = rol.id;
      const kanal = await kanalBulVeyaOlustur(g, `${kit.toLowerCase()}-kuyruk`, ChannelType.GuildText, kuyrukKat.id, [
        { id: g.id, deny: [P.ViewChannel] },
        { id: rol.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
        { id: tester.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
        botIzin,
      ]);
      s.kitChannels[kit] = kanal.id;
    }
    kaydet();

    // Paneller
    await waitlistPanelGonder(waitlistKanal);
    for (const kit of KITLER) {
      const kanal = await g.channels.fetch(s.kitChannels[kit]);
      await kitPanelGonder(kit, kanal);
    }
    panelGuncelle();
    return i.editReply(
      `✅ Kurulum tamam.\n• Waitlist paneli: ${waitlistKanal}\n• Sonuçlar: ${sonucKanal}\n• Tester rolü: ${tester}\n` +
        `• ${KITLER.length} kit için rol + özel kuyruk kanalı + panel hazır.\n` +
        '⚠️ Botun rolünü Roller listesinde en üste taşımayı unutma, yoksa rol veremez.'
    );
  } catch (e) {
    console.error('Kurulum hatası:', e);
    kaydet();
    return i.editReply(`❌ Kurulum yarıda kaldı: ${e.message}\nBotun **Rolleri Yönet** ve **Kanalları Yönet** izni olmalı. Düzeltip \`/kurulum\` komutunu tekrar çalıştır, kaldığı yerden devam eder.`);
  }
};

komutlar['panel-yenile'] = async (i) => {
  await i.deferReply({ flags: GIZLI });
  const sonuc = [];
  try {
    if (state.panels.waitlist) {
      const wk = await i.guild.channels.fetch(state.panels.waitlist.channelId);
      await waitlistPanelGonder(wk);
      sonuc.push(`✅ WAITLIST: ${wk}`);
    } else {
      sonuc.push('⚠️ WAITLIST paneli yok, `/kurulum` çalıştır.');
    }
  } catch (e) {
    sonuc.push('❌ WAITLIST paneli gönderilemedi.');
  }
  for (const kit of KITLER) {
    const id = S().kitChannels[kit];
    if (!id) {
      sonuc.push(`⚠️ ${kit}: kanal yok`);
      continue;
    }
    try {
      const kanal = await i.guild.channels.fetch(id);
      await kitPanelGonder(kit, kanal);
      sonuc.push(`✅ ${kit}: ${kanal}`);
    } catch (e) {
      sonuc.push(`❌ ${kit}: gönderilemedi`);
    }
  }
  return i.editReply(sonuc.join('\n'));
};

komutlar['kuyruk-temizle'] = async (i) => {
  const kit = kitBul(i.options.getString('kit'));
  if (!kit) return kitYok(i);
  const silinen = kuyrukTemizle(kit);
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
          { name: 'Kitler (WAITLIST rolü • kanal • durum)', value: kitSatirlari }
        );
      return i.reply({ embeds: [embed], flags: GIZLI });
    }
    case 'tester-rol': {
      const rol = i.options.getRole('rol');
      s.testerRoleId = rol.id;
      return tamam(`Tester rolü ${rol} oldu.`);
    }
    case 'sonuc-kanal': {
      const kanal = i.options.getChannel('kanal');
      s.resultChannelId = kanal.id;
      return tamam(`Sonuç kanalı ${kanal} oldu.`);
    }
    case 'log-kanal': {
      const kanal = i.options.getChannel('kanal');
      s.logChannelId = kanal.id;
      return tamam(`Log kanalı ${kanal} oldu.`);
    }
    case 'ticket-kategori': {
      const kat = i.options.getChannel('kategori');
      s.ticketCategoryId = kat.id;
      return tamam(`Test kanalları **${kat.name}** kategorisinde açılacak.`);
    }
    case 'kit-rol': {
      const kit = kitBul(i.options.getString('kit'));
      if (!kit) return kitYok(i);
      const rol = i.options.getRole('rol');
      s.kitRoles[kit] = rol.id;
      return tamam(`**${kit}** WAITLIST rolü ${rol} oldu.`);
    }
    case 'kit-kanal': {
      const kit = kitBul(i.options.getString('kit'));
      if (!kit) return kitYok(i);
      const kanal = i.options.getChannel('kanal');
      s.kitChannels[kit] = kanal.id;
      return tamam(`**${kit}** kuyruk kanalı ${kanal} oldu. Paneli göndermek için \`/panel-yenile\` kullan.`);
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
      return tamam(s.autoRole ? 'Otomatik tier rolü **açıldı** (rol yoksa bot oluşturur).' : 'Otomatik tier rolü **kapatıldı**.');
    }
    default:
      return i.reply({ content: 'Bilinmeyen ayar.', flags: GIZLI });
  }
};

// --------------------------------------------------------------------------
//  BUTONLAR VE PENCERE
// --------------------------------------------------------------------------
// WAITLIST: kit rolünü ver (kanal açılır) / kaldır
async function waitlistButon(i, kit) {
  await i.deferReply({ flags: GIZLI });
  const rolId = S().kitRoles[kit];
  const rol = rolId ? i.guild.roles.cache.get(rolId) : null;
  if (!rol) return i.editReply(`❌ **${kit}** için WAITLIST rolü yok. Bir yönetici \`/kurulum\` çalıştırmalı.`);
  const kanalId = S().kitChannels[kit];
  try {
    if (i.member.roles.cache.has(rol.id)) {
      await i.member.roles.remove(rol);
      kuyruktanCikar(i.user.id, kit);
      return i.editReply(`➖ **${kit}** waitlist'inden ayrıldın, kanal erişimin kapandı.`);
    }
    await i.member.roles.add(rol);
    return i.editReply(
      `✅ **${kit}** waitlist'ine girdin.\n` +
        (kanalId ? `👉 Kuyruk kanalın: <#${kanalId}>\nOrada **KATIL** butonuna basıp Minecraft adını gir.` : 'Kuyruk kanalı henüz ayarlanmamış.')
    );
  } catch (e) {
    console.log('WAITLIST rol hatası:', e.message);
    return i.editReply('❌ Rol verilemedi. Botun rolü, WAITLIST rolünün üstünde olmalı ve **Rolleri Yönet** izni olmalı.');
  }
}

async function katilButon(i, kit) {
  const hata = kuyrukHata(i.member, kit);
  if (hata) return i.reply({ content: hata, flags: GIZLI });
  const onceki = state.results[`${i.user.id}:${kit}`];
  const alan = new TextInputBuilder()
    .setCustomId('nick')
    .setLabel('Minecraft Adın')
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(16)
    .setRequired(true);
  if (onceki && NICK_REGEX.test(onceki.nick)) alan.setValue(onceki.nick);
  const modal = new ModalBuilder()
    .setCustomId(`q_nick:${kit}`)
    .setTitle(`${kit} - Kuyruğa Katıl`)
    .addComponents(new ActionRowBuilder().addComponents(alan));
  return i.showModal(modal);
}

async function nickPenceresi(i) {
  const kit = kitBul(i.customId.slice('q_nick:'.length));
  if (!kit) return kitYok(i);
  const sonuc = kuyrugaEkle(i.member, kit, i.fields.getTextInputValue('nick').trim());
  return i.reply({ content: sonuc.msg, flags: GIZLI });
}

const BUTON_TURLERI = new Set(['wl', 'q_join', 'q_leave', 'q_toggle', 'q_next', 'q_clear']);

async function butonIsle(i) {
  const [tur, kitAdi] = i.customId.split(':');
  if (!BUTON_TURLERI.has(tur)) return;
  const kit = kitBul(kitAdi);
  if (!kit) return i.reply({ content: '❌ Bu kit artık mevcut değil.', flags: GIZLI });

  if (tur === 'wl') return waitlistButon(i, kit);
  if (tur === 'q_join') return katilButon(i, kit);
  if (tur === 'q_leave') {
    const cikti = kuyruktanCikar(i.user.id, kit);
    return i.reply({ content: cikti ? `**${kit}** kuyruğundan çıkarıldın.` : `**${kit}** kuyruğunda değilsin.`, flags: GIZLI });
  }

  // Yönetim butonları: sadece tester / yönetici
  if (!testerMi(i.member)) return i.reply({ content: '🔒 Bu buton sadece testerlar ve yöneticiler için.', flags: GIZLI });

  if (tur === 'q_toggle') {
    state.kitOpen[kit] = !kitAcikMi(kit);
    kaydet();
    await i.update({ embeds: [kitPanelEmbed(kit)], components: kitPanelBilesenleri(kit) });
    panelGuncelle(); // WAITLIST panelindeki durum da güncellensin
    return logla(i.guild, `${kitAcikMi(kit) ? '🟢' : '🔴'} ${i.user.tag} **${kit}** kuyruğunu ${kitAcikMi(kit) ? 'açtı' : 'kapattı'}.`);
  }
  if (tur === 'q_next') {
    await i.deferReply({ flags: GIZLI });
    return testAc(i, kit, null);
  }
  if (tur === 'q_clear') {
    const silinen = kuyrukTemizle(kit);
    await logla(i.guild, `🧹 ${i.user.tag} **${kit}** kuyruğunu temizledi (${silinen} kişi).`);
    return i.reply({ content: `**${kit}** kuyruğu temizlendi (${silinen} kişi).`, flags: GIZLI });
  }
}

// --------------------------------------------------------------------------
//  OLAYLAR
// --------------------------------------------------------------------------
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
  const msg = '❌ Bir hata oluştu. Botun izinlerini (Rolleri/Kanalları Yönet) kontrol et.';
  try {
    if (i.deferred || i.replied) await i.editReply({ content: msg });
    else if (i.isRepliable()) await i.reply({ content: msg, flags: GIZLI });
  } catch (e) {
    /* yanıt verilemedi */
  }
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) return await komutCalistir(i);
    if (i.isButton()) return await butonIsle(i);
    if (i.isModalSubmit() && i.customId.startsWith('q_nick:')) return await nickPenceresi(i);
  } catch (err) {
    await hataYanit(i, err);
  }
});

// Elle silinen test kanallarının kaydını temizle
client.on(Events.ChannelDelete, (kanal) => {
  if (state.tickets[kanal.id]) {
    delete state.tickets[kanal.id];
    kaydet();
  }
});

// Biri WAITLIST rolünü elle alırsa kuyruktan da düşsün
client.on(Events.GuildMemberUpdate, (eski, yeni) => {
  for (const kit of KITLER) {
    const rolId = S().kitRoles[kit];
    if (rolId && eski.roles && eski.roles.cache.has(rolId) && !yeni.roles.cache.has(rolId)) {
      kuyruktanCikar(yeni.id, kit);
    }
  }
});

// discord.js sürümünden bağımsız çalışır (ready / clientReady)
client.once(Events.ClientReady, async () => {
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

// Render için küçük HTTP sunucusu (UptimeRobot ping)
http.createServer((req, res) => res.end('Bot calisiyor')).listen(process.env.PORT || 3000);

client.login(DISCORD_TOKEN);
