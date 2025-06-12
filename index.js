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

import { Client, GatewayIntentBits, Partials } from 'discord.js';

const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno'];
const allowedUserIds = new Set(
  process.env.ALLOWED_USERS?.split(',').map(id => id.trim()) || []
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
const mutedUsers = new Map();

const FREE_SPEECH_DURATION = 30 * 1000; // 30 seconds
const MUTE_DURATION = 3000; // 3 seconds

function generateExclamations(count) {
  return '!'.repeat(count);
}

async function sendChallenge(channel, userId, intro = true) {
  const count = Math.floor(Math.random() * 21) + 10; // 10–30
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

// 👇 Add your test server text channel ID here
const TEST_CHANNEL_ID = '1382577291015749674'; // ← Replace with your test channel ID

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // 👇 Every minute, send a message to keep bot alive
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
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const username = `<@${userId}>`;
  const content = message.content.trim();

  // 🔐 Banned word filter (for all users)
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
    // 20% chance of temporary free speech
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
