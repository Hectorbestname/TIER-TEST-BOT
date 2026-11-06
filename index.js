const http = require('http');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

// ================== AYARLAR (Render'da Environment Variables) ==================
const {
  DISCORD_TOKEN,
  GUILD_ID,
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

// Bellekte tutulan veriler (bot yeniden başlarsa sıfırlanır)
const queue = []; // { userId, kit, nick, joined }
const cooldowns = new Map(); // "userId:kit" -> bitiş zamanı (ms)

const testerMi = (member) => member.roles.cache.has(TESTER_ROLE_ID);

function kalanCooldown(userId, kit) {
  const bitis = cooldowns.get(`${userId}:${kit}`);
  if (bitis && Date.now() < bitis) return Math.ceil((bitis - Date.now()) / 86400000);
  return null;
}

client.once('clientReady', async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(commands);
    console.log(`${client.user.tag} hazır, komutlar kaydedildi.`);
  } catch (e) {
    console.log('KOMUT KAYIT HATASI:', e.message);
  }
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    const kit = i.options.getString('kit');

    // ---------- OYUNCU KOMUTLARI ----------
    if (i.commandName === 'kuyruga-gir') {
      const nick = i.options.getString('nick');
      const kalan = kalanCooldown(i.user.id, kit);
      if (kalan) {
        return i.reply({ content: `⏳ ${kit} için cooldown'dasın. **${kalan} gün** sonra tekrar deneyebilirsin.`, ephemeral: true });
      }
      if (queue.some((k) => k.userId === i.user.id && k.kit === kit)) {
        return i.reply({ content: `Zaten ${kit} kuyruğundasın.`, ephemeral: true });
      }
      queue.push({ userId: i.user.id, kit, nick, joined: Date.now() });
      const sira = queue.filter((k) => k.kit === kit).length;
      return i.reply({ content: `✅ **${kit}** kuyruğuna girdin. Sıran: **${sira}**`, ephemeral: true });
    }

    if (i.commandName === 'kuyruktan-cik') {
      const idx = queue.findIndex((k) => k.userId === i.user.id && k.kit === kit);
      if (idx === -1) return i.reply({ content: 'Bu kitte kuyrukta değilsin.', ephemeral: true });
      queue.splice(idx, 1);
      return i.reply({ content: 'Kuyruktan çıkarıldın.', ephemeral: true });
    }

    if (i.commandName === 'kuyruk') {
      const liste = queue.filter((k) => k.kit === kit);
      if (!liste.length) return i.reply(`${kit} kuyruğu boş.`);
      const embed = new EmbedBuilder()
        .setTitle(`${kit} Kuyruğu (${liste.length} kişi)`)
        .setDescription(liste.slice(0, 15).map((k, n) => `**${n + 1}.** <@${k.userId}> (\`${k.nick}\`)`).join('\n'))
        .setColor(0x5865f2);
      return i.reply({ embeds: [embed] });
    }

    if (i.commandName === 'profil') {
      const uye = i.options.getMember('oyuncu') || i.member;
      const tierRolleri = uye.roles.cache.filter((r) => {
        const [k, t] = r.name.split(' ');
        return KITLER.includes(k) && TIERLER.includes(t);
      });
      if (!tierRolleri.size) {
        return i.reply({ content: `${uye.displayName} henüz test olmamış.`, ephemeral: true });
      }
      const embed = new EmbedBuilder().setTitle(`${uye.displayName} - Tierler`).setColor(0xf1c40f);
      tierRolleri.forEach((r) => {
        const [k, t] = r.name.split(' ');
        embed.addFields({ name: k, value: `**${t}**`, inline: true });
      });
      return i.reply({ embeds: [embed] });
    }

    // ---------- TESTER KOMUTLARI ----------
    if (!testerMi(i.member)) {
      return i.reply({ content: 'Bu komut sadece testerlar için.', ephemeral: true });
    }

    if (i.commandName === 'test-baslat') {
      await i.deferReply({ ephemeral: true });
      const idx = queue.findIndex((k) => k.kit === kit);
      if (idx === -1) return i.editReply('Kuyruk boş.');
      const siradaki = queue.splice(idx, 1)[0];

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

      // Eski tier rolünü kaldır, yenisini ver (rol yoksa oluşturur)
      const eski = oyuncu.roles.cache.filter((r) => new RegExp(`^${kit} (HT|LT)\\d$`).test(r.name));
      if (eski.size) await oyuncu.roles.remove(eski);
      const rolAdi = `${kit} ${tier}`;
      const rol = i.guild.roles.cache.find((r) => r.name === rolAdi) || (await i.guild.roles.create({ name: rolAdi }));
      await oyuncu.roles.add(rol);

      cooldowns.set(`${oyuncu.id}:${kit}`, Date.now() + COOLDOWN_GUN * 86400000);

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
