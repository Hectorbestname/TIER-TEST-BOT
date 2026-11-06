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
  StringSelectMenuBuilder,
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
    queues: {},
    queueOpen: {},
    cooldowns: {},
