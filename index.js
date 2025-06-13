import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, Collection } from 'discord.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

// Bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno'];
const allowedUserIds = new Set(process.env.ALLOWED_USERS?.split(',').map(id => id.trim()));
const authorizedCommandUsers = new Set(process.env.AUTHORIZED_COMMAND_USERS?.split(',').map(id => id.trim()));

const activeChallenges = new Map();
const freeSpeechTimers = new Map();
const deleteQueue = [];
const mutedUsers = new Map();

const FREE_SPEECH_DURATION = 30 * 1000;
const MUTE_DURATION = 3000;
const TEST_CHANNEL_ID = '1382577291015749674'; // Replace with your channel ID

client.commands = new Collection();

// Slash Commands Setup
const commands = [
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Mute a user for a set duration')
    .addUserOption(opt => opt.setName('target').setDescription('User to mute').setRequired(true))
    .addIntegerOption(opt => opt.setName('duration').setDescription('Duration in seconds').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Unmute a previously muted user')
    .addUserOption(opt => opt.setName('target').setDescription('User to unmute').setRequired(true))
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('Slash command registration failed:', err);
  }

  // Keep alive message
  setInterval(async () => {
    try {
      const ch = await client.channels.fetch(TEST_CHANNEL_ID).catch(() => null);
      if (ch?.isTextBased()) {
        ch.send('✅ Still alive').then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
      }
    } catch (e) {
      console.error('Keep-alive failed:', e.message);
    }
  }, 60 * 1000);
});

// Slash Command Handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (!authorizedCommandUsers.has(user.id)) {
    return interaction.reply({ content: '🚫 You are not authorized to use this command.', ephemeral: true });
  }

  if (commandName === 'mute') {
    const target = interaction.options.getUser('target');
    const duration = interaction.options.getInteger('duration');

    if (!target || isNaN(duration)) {
      return interaction.reply({ content: '❗ Invalid input.', ephemeral: true });
    }

    mutedUsers.set(target.id, Date.now());
    interaction.reply(`🔇 <@${target.id}> muted for ${duration} seconds`);

    setTimeout(() => mutedUsers.delete(target.id), duration * 1000);
  }

  if (commandName === 'unmute') {
    const target = interaction.options.getUser('target');
    mutedUsers.delete(target.id);
    interaction.reply(`🔊 <@${target.id}> has been unmuted`);
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const username = `<@${userId}>`;
  const content = message.content.trim();

  if (containsBannedWord(content)) {
    if (!mutedUsers.has(userId)) {
      mutedUsers.set(userId, Date.now());
      setTimeout(() => mutedUsers.delete(userId), MUTE_DURATION);

      await message.channel.send({
        content: `${username} nuh uh no no word`,
        allowedMentions: { users: [userId] }
      });

      deleteQueue.push(() => message.delete());
    }
    return;
  }

  if (!allowedUserIds.has(userId)) return;

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

function containsBannedWord(content) {
  return bannedWords.some(word => content.toLowerCase().includes(word));
}

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

  activeChallenges.set(userId, {
    state: 'waiting',
    answer: count
  });
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

client.login(process.env.TOKEN);
