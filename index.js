import './keepAlive.js';

import express from 'express';
const app = express();

app.get('/', (req, res) => {
    res.send('Bot is alive!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder } from 'discord.js';

const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno'];

const allowedUsers = new Set(
  process.env.ALLOWED_USERS?.split(',').map(id => id.trim()) || []
);

const allowedSlashCommandUsers = new Set(
  process.env.SLASH_COMMAND_USERS?.split(',').map(id => id.trim()) || []
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const activeChallenges = new Map();
const freeSpeechTimers = new Map();
const deleteQueue = [];
const muteTimeouts = new Map();
const FREE_SPEECH_DURATION = 30 * 1000;

function generateExclamations(count) {
  return '!'.repeat(count);
}

async function sendChallenge(channel, userId, intro = true) {
  const count = Math.floor(Math.random() * 21) + 10;
  const exclamations = generateExclamations(count);

  if (intro) {
    await channel.send(`hey <@${userId}> how many`);
  }
  await channel.send(`<@${userId}> count${exclamations}`);

  activeChallenges.set(userId, { state: 'waiting', answer: count });
}

function containsBannedWord(content) {
  const lower = content.toLowerCase();
  return bannedWords.some(word => lower.includes(word));
}

setInterval(async () => {
  const job = deleteQueue.shift();
  if (job) {
    try {
      await job();
    } catch (e) {
      console.error('Queue delete failed:', e.message);
    }
  }
}, 100);

const TEST_CHANNEL_ID = '1382577291015749674';

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  setInterval(async () => {
    try {
      const ch = await client.channels.fetch(TEST_CHANNEL_ID).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      ch.send('✅ Still alive')
        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000))
        .catch(() => {});
    } catch (e) {
      console.error('Keep-alive failed:', e.message);
    }
  }, 60 * 1000);

  const commands = [
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Start a !!! challenge for a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to challenge').setRequired(true))
      .addIntegerOption(opt => opt.setName('duration').setDescription('Mute duration in seconds').setRequired(false)),
    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Cancel a challenge')
      .addUserOption(opt => opt.setName('user').setDescription('User to release').setRequired(true))
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    const appId = (await rest.get(Routes.oauth2CurrentApplication()))?.id;
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('Slash command registration failed:', e);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!allowedSlashCommandUsers.has(interaction.user.id)) {
    return interaction.reply({ content: 'You are not allowed to use this command.', ephemeral: true });
  }

  const user = interaction.options.getUser('user');

  if (interaction.commandName === 'mute') {
    const channel = interaction.channel;
    await sendChallenge(channel, user.id);

    const duration = interaction.options.getInteger('duration') || 30;
    if (muteTimeouts.has(user.id)) clearTimeout(muteTimeouts.get(user.id));

    const timeout = setTimeout(() => {
      activeChallenges.delete(user.id);
      freeSpeechTimers.delete(user.id);
      muteTimeouts.delete(user.id);
      channel.send(`<@${user.id}> has been unmuted (mute duration ended).`);
    }, duration * 1000);

    muteTimeouts.set(user.id, timeout);

    interaction.reply({ content: `Challenge started for <@${user.id}> for ${duration} seconds.`, ephemeral: true });
  } else if (interaction.commandName === 'unmute') {
    activeChallenges.delete(user.id);
    freeSpeechTimers.delete(user.id);
    if (muteTimeouts.has(user.id)) clearTimeout(muteTimeouts.get(user.id));
    muteTimeouts.delete(user.id);
    interaction.reply({ content: `Challenge cleared for <@${user.id}>.`, ephemeral: true });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const username = `<@${userId}>`;
  const content = message.content.trim();

  if (allowedUsers.has(userId) || containsBannedWord(content)) {
    deleteQueue.push(() => message.delete());
    return;
  }

  const current = activeChallenges.get(userId);
  const timer = freeSpeechTimers.get(userId);

  if (timer) return;

  if (current?.state === 'solved') {
    if (Math.random() < 0.2) {
      freeSpeechTimers.set(userId, Date.now());
      const interval = setInterval(() => {
        const elapsed = Date.now() - freeSpeechTimers.get(userId);
        const remaining = Math.ceil((FREE_SPEECH_DURATION - elapsed) / 1000);

        if (remaining > 0) {
          message.channel.send(`${remaining}`);
        } else {
          message.channel.send(`${username} no more free speech`);
          freeSpeechTimers.delete(userId);
          clearInterval(interval);
        }
      }, 5000);
      await message.channel.send(`${username} congrats u now have temporary free speech`);
    }
    activeChallenges.delete(userId);
    return;
  }

  deleteQueue.push(() => message.delete());

  if (current?.state === 'waiting') {
    const guess = parseInt(content);
    if (guess === current.answer) {
      await message.channel.send(`${username} good boy`);
      activeChallenges.set(userId, { state: 'solved' });
    } else {
      await message.channel.send(`${username} nuh uh, try again`);
      await sendChallenge(message.channel, userId, false);
    }
    return;
  }

  await sendChallenge(message.channel, userId, true);
});

client.login(process.env.TOKEN);

console.log('🤖 Bot is starting...');
