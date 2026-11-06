const http = require('http');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { MongoClient } = require('mongodb');

// ================== AYARLAR (Render'da Environment Variables) ==================
const {
  DISCORD_TOKEN,
  GUILD_ID,
  MONGO_URI,
  TESTER_ROLE_ID,
  RESULT_CHANNEL_ID,
  TICKET_CATEGORY_ID,
} = process.env;
const COOLDOWN_GUN = 14; // Aynı kitte tekrar test süresi

const KITLER = ['Crystal', 'Sword', 'Axe', 'Pot', 'NethPot', 'SMP', 'UHC', 'Vanilla'];
const TIERLER = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
// ===============================================================================

const toChoices = (arr) => arr.map((x) => ({ name: x, value: x }));

const commands = [
  new SlashCommandBuilder()
    .setName('kuyruga-gir')
    .setDescription('Test kuyruğuna katıl')
    .addStringOption((o) => o.setName('kit').setDescription('Kit').setRequired(true).addChoices(...toChoices(KITLER)))
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nickin').setRequired(true)),
  new SlashCommandBuilder()
    .setName('kuyruktan-cik')
    .setDescription('Kuyruktan ayrıl')
    .addStringOption((o) => o.setName('kit').setDescription('Kit').setRequired(true).addChoices(...toChoices(KITLER))),
  new SlashCommandBuilder()
    .setName('kuyruk')
    .setDescription('Kuyruğu göster')
    .addStringOption((o) => o.setName('kit').setDescription('Kit').setRequired(true).addChoices(...toChoices(KITLER))),
  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Bir oyuncunun tierlerini göster')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu')),
  new SlashCommandBuilder()
    .setName('test-baslat')
    .setDescription('[Tester] Sıradaki oyuncuyla test başlat')
    .addStringOption((o) => o.setName('kit').setDescription('Kit').setRequired(true).addChoices(...toChoices(KITLER))),
  new SlashCommandBuilder()
    .setName('tier-ver')
    .setDescription('[Tester] Oyuncuya tier ver')
    .addUserOption((o) => o.setName('oyuncu').setDescription('Oyuncu').setRequired(true))
    .addStringOption((o) => o.setName('kit').setDescription('Kit').setRequired(true).addChoices(...toChoices(KITLER)))
    .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true).addChoices(...toChoices(TIERLER)))
    .addStringOption((o) => o.setName('nick').setDescription('Minecraft nicki').setRequired(true)),
  new SlashCommandBuilder().setName('kapat').setDescription('[Tester] Test kanalını kapat'),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let queue, tiers;

const testerMi = (member) => member.roles.cache.has(TESTER_ROLE_ID);

async function kalanCooldown(userId, kit) {
  const kayit = await tiers.findOne({ userId, kit });
  if (!kayit) return null;
  const bitis = kayit.testedAt + COOLDOWN_GUN * 86400000;
  if (Date.now() < bitis) return Math.ceil((bitis - Date.now()) / 86400000);
  return null;
}

client.once('clientReady', async () => {
  // --- MONGO KONTROL (şifreyi yazdırmaz, sadece uzunluğunu gösterir) ---
  try {
    const u = new URL(MONGO_URI);
    console.log('MONGO kullanici:', u.username, '| sifre uzunlugu:', u.password.length, '| host:', u.hostname);
  } catch (e) {
    console.log('MONGO_URI okunamadi veya bos:', typeof MONGO_URI);
  }

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  const db = mongo.db('tiertest');
  queue = db.collection('queue');
  tiers = db.collection('tiers');
  await queue.createIndex({ userId: 1, kit: 1 }, { unique: true });
  await tiers.createIndex({ userId: 1, kit: 1 }, { unique: true });

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set(commands);
  console.log(`${client.user.tag} hazır.`);
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    const kit = i.options.getString('kit');

    // ---------- OYUNCU KOMUTLARI ----------
    if (i.commandName === 'kuyruga-gir') {
      const nick = i.options.getString('nick');
      const kalan = await kalanCooldown(i.user.id, kit);
      if (kalan) {
        return i.reply({ content: `⏳ ${kit} için cooldown'dasın. **${kalan} gün** sonra tekrar deneyebilirsin.`, ephemeral: true });
      }
      const joined = Date.now();
      try {
        await queue.insertOne({ userId: i.user.id, kit, nick, joined });
      } catch (e) {
        if (e.code === 11000) return i.reply({ content: `Zaten ${kit} kuyruğundasın.`, ephemeral: true });
        throw e;
      }
      const sira = await queue.countDocuments({ kit, joined: { $lte: joined } });
      return i.reply({ content: `✅ **${kit}** kuyruğuna girdin. Sıran: **${sira}**`, ephemeral: true });
    }

    if (i.commandName === 'kuyruktan-cik') {
      const r = await queue.deleteOne({ userId: i.user.id, kit });
      return i.reply({ content: r.deletedCount ? 'Kuyruktan çıkarıldın.' : 'Bu kitte kuyrukta değilsin.', ephemeral: true });
    }

    if (i.commandName === 'kuyruk') {
      const liste = await queue.find({ kit }).sort({ joined: 1 }).limit(15).toArray();
      if (!liste.length) return i.reply(`${kit} kuyruğu boş.`);
      const toplam = await queue.countDocuments({ kit });
      const embed = new EmbedBuilder()
        .setTitle(`${kit} Kuyruğu (${toplam} kişi)`)
        .setDescription(liste.map((k, n) => `**${n + 1}.** <@${k.userId}> (\`${k.nick}\`)`).join('\n'))
        .setColor(0x5865f2);
      return i.reply({ embeds: [embed] });
    }

    if (i.commandName === 'profil') {
      const kullanici = i.options.getUser('oyuncu') || i.user;
      const liste = await tiers.find({ userId: kullanici.id }).toArray();
      if (!liste.length) return i.reply({ content: `${kullanici.username} henüz test olmamış.`, ephemeral: true });
      const embed = new EmbedBuilder().setTitle(`${liste[0].nick} - Tierler`).setColor(0xf1c40f);
      liste.forEach((t) => embed.addFields({ name: t.kit, value: `**${t.tier}**`, inline: true }));
      return i.reply({ embeds: [embed] });
    }

    // ---------- TESTER KOMUTLARI ----------
    if (!testerMi(i.member)) {
      return i.reply({ content: 'Bu komut sadece testerlar için.', ephemeral: true });
    }

    if (i.commandName === 'test-baslat') {
      await i.deferReply({ ephemeral: true });
      const siradaki = await queue.findOneAndDelete({ kit }, { sort: { joined: 1 } });
      if (!siradaki) return i.editReply('Kuyruk boş.');

      const oyuncu = await i.guild.members.fetch(siradaki.userId).catch(() => null);
      if (!oyuncu) return i.editReply('Oyuncu sunucudan ayrılmış, kuyruktan silindi. Tekrar dene.');

      const kanal = await i.guild.channels.create({
        name: `test-${siradaki.nick}-${kit}`.toLowerCase(),
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: oyuncu.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
      await kanal.send(
        `${oyuncu} test sırası sende! Tester: ${i.user}\n**Kit:** ${kit} | **Nick:** \`${siradaki.nick}\`\nTest bitince tester \`/tier-ver\` ve \`/kapat\` kullanacak.`
      );
      return i.editReply(`Kanal açıldı: ${kanal}`);
    }

    if (i.commandName === 'tier-ver') {
      await i.deferReply({ ephemeral: true });
      const oyuncu = i.options.getMember('oyuncu');
      if (!oyuncu) return i.editReply('Oyuncu sunucuda bulunamadı.');
      const tier = i.options.getString('tier');
      const nick = i.options.getString('nick');

      await tiers.updateOne(
        { userId: oyuncu.id, kit },
        { $set: { tier, nick, testerId: i.user.id, testedAt: Date.now() } },
        { upsert: true }
      );

      // Eski tier rolünü kaldır, yenisini ver (rol yoksa oluşturur)
      const eski = oyuncu.roles.cache.filter((r) => new RegExp(`^${kit} (HT|LT)\\d$`).test(r.name));
      if (eski.size) await oyuncu.roles.remove(eski);
      const rolAdi = `${kit} ${tier}`;
      const rol = i.guild.roles.cache.find((r) => r.name === rolAdi) || (await i.guild.roles.create({ name: rolAdi }));
      await oyuncu.roles.add(rol);

      const embed = new EmbedBuilder()
        .setTitle('Test Sonucu')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Oyuncu', value: `${oyuncu} (\`${nick}\`)`, inline: true },
          { name: 'Kit', value: kit, inline: true },
          { name: 'Tier', value: `**${tier}**`, inline: true }
        )
        .setFooter({ text: `Tester: ${i.member.displayName}` });
      const sonucKanali = await i.guild.channels.fetch(RESULT_CHANNEL_ID).catch(() => null);
      if (sonucKanali) await sonucKanali.send({ embeds: [embed] });
      return i.editReply('Tier verildi ✅');
    }

    if (i.commandName === 'kapat') {
      if (i.channel.parentId !== TICKET_CATEGORY_ID) {
        return i.reply({ content: 'Bu bir test kanalı değil.', ephemeral: true });
      }
      await i.reply('Kanal kapatılıyor...');
      return i.channel.delete();
    }
  } catch (err) {
    console.error(err);
    const msg = 'Bir hata oluştu, bot izinlerini ve ayarları kontrol et.';
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
    else i.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
});

// Render Web Service'in port istemesi ve uyumaması için küçük HTTP sunucusu
http
  .createServer((req, res) => res.end('Bot calisiyor'))
  .listen(process.env.PORT || 3000);

client.login(DISCORD_TOKEN);
