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

import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';

const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno'];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Load lists from .env
const allowedUsers = new Set(
  process.env.ALLOWED_USERS?.split(',').map(id => id.trim()) || []
);

const authorizedCommandUsers = new Set(
  process.env.SLASH_COMMAND_USERS?.split(',').map(id => id.trim()) || []
);

// Track muted users: userId -> { expires: timestamp, challengeState, answer }
const mutedUsers = new Map();

const FREE_SPEECH_DURATION = 30 * 1000; // Optional free speech after solving
const deleteQueue = [];

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

  mutedUsers.set(userId, { state: 'waiting', answer: count, expires: mutedUsers.get(userId)?.expires || 0 });
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

// Slash command registration
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const commands = [
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Mute a user with a counting challenge')
      .addUserOption(opt => opt.setName('user').setDescription('User to mute').setRequired(true))
      .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes').setRequired(false)),

    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Unmute a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to unmute').setRequired(true))
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

// Interaction handler for slash commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!authorizedCommandUsers.has(interaction.user.id)) {
    return interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
  }

  const targetUser = interaction.options.getUser('user');
  if (!targetUser) {
    return interaction.reply({ content: 'Please specify a valid user.', ephemeral: true });
  }

  if (interaction.commandName === 'mute') {
    const durationMinutes = interaction.options.getInteger('duration') || 10;
    const expires = Date.now() + durationMinutes * 60 * 1000;

    mutedUsers.set(targetUser.id, { state: 'pending', expires });

    await sendChallenge(interaction.channel, targetUser.id);

    return interaction.reply({ content: `<@${targetUser.id}> has been muted for ${durationMinutes} minutes.`, ephemeral: true });
  }

  if (interaction.commandName === 'unmute') {
    mutedUsers.delete(targetUser.id);
    return interaction.reply({ content: `<@${targetUser.id}> has been unmuted.`, ephemeral: true });
  }
});

// Message handler
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const content = message.content.trim();

  // Always delete messages from allowed users
  if (allowedUsers.has(userId)) {
    deleteQueue.push(() => message.delete());
    return;
  }

  // Delete messages with banned words from anyone
  if (containsBannedWord(content)) {
    deleteQueue.push(() => message.delete());
    return;
  }

  // Check if user is muted and if mute is expired
  const muteInfo = mutedUsers.get(userId);
  if (muteInfo) {
    if (Date.now() > muteInfo.expires) {
      mutedUsers.delete(userId);
      return; // mute expired, allow messages
    }

    if (muteInfo.state === 'waiting') {
      const guess = parseInt(content);
      if (guess === muteInfo.answer) {
        await message.channel.send(`<@${userId}> good job, you passed the challenge!`);
        mutedUsers.set(userId, { ...muteInfo, state: 'solved' });
      } else {
        await message.channel.send(`<@${userId}> incorrect, try again.`);
        await sendChallenge(message.channel, userId, false);
      }
      deleteQueue.push(() => message.delete());
      return;
    }

    if (muteInfo.state === 'solved') {
      // Optionally, implement free speech time or just block all messages until mute expires
      deleteQueue.push(() => message.delete());
      return;
    }

    // If state is 'pending', send challenge? (Shouldn't happen normally)
    deleteQueue.push(() => message.delete());
    return;
  }

  // If user is not muted or allowed, allow messages normally
});

client.login(process.env.TOKEN);

console.log('🤖 Bot is starting...');

