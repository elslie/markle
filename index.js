import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { Octokit } from "@octokit/rest";

dotenv.config();

console.log('=== Markle Bot starting up at', new Date().toISOString());

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const pingPongLeaderboard = new Map(); // highest single-game streaks
const pingPongExchangesLeaderboard = new Map(); // total lifetime exchanges
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = "elslie";
const GITHUB_REPO = "markle";
const LEADERBOARD_PATH = "leaderboard.json";
const EXCHANGES_LEADERBOARD_PATH = "exchanges_leaderboard.json";
const DEFAULT_BRANCH = "main";

// Save leaderboard to GitHub file (highest single-game streaks)
async function saveLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongLeaderboard.entries()], null, 2);
  const contentEncoded = Buffer.from(content).toString("base64");

  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: LEADERBOARD_PATH,
    });
    sha = data.sha;
  } catch (err) {
    sha = undefined;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: LEADERBOARD_PATH,
    message: "Update ping pong highest streaks leaderboard",
    content: contentEncoded,
    sha,
    branch: DEFAULT_BRANCH,
  });
}

// Save exchanges leaderboard
async function saveExchangesLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongExchangesLeaderboard.entries()], null, 2);
  const contentEncoded = Buffer.from(content).toString("base64");

  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: EXCHANGES_LEADERBOARD_PATH,
    });
    sha = data.sha;
  } catch (err) {
    sha = undefined;
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: EXCHANGES_LEADERBOARD_PATH,
    message: "Update ping pong exchanges leaderboard",
    content: contentEncoded,
    sha,
    branch: DEFAULT_BRANCH,
  });
}

// Load highest single-game streaks leaderboard
async function loadLeaderboardFromGitHub() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: LEADERBOARD_PATH,
      ref: DEFAULT_BRANCH,
    });
    const leaderboardRaw = Buffer.from(data.content, "base64").toString();
    const leaderboardArr = JSON.parse(leaderboardRaw);
    pingPongLeaderboard.clear();
    for (const [userId, score] of leaderboardArr) {
      pingPongLeaderboard.set(userId, score);
    }
    console.log(`[Leaderboard] Loaded ${pingPongLeaderboard.size} entries from GitHub file.`);
  } catch (err) {
    console.warn("[Leaderboard] No existing GitHub leaderboard file or error loading, starting fresh.");
    pingPongLeaderboard.clear();
  }
}

// Load exchanges leaderboard
async function loadExchangesLeaderboardFromGitHub() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: EXCHANGES_LEADERBOARD_PATH,
      ref: DEFAULT_BRANCH,
    });
    const exchangesRaw = Buffer.from(data.content, "base64").toString();
    const exchangesArr = JSON.parse(exchangesRaw);
    pingPongExchangesLeaderboard.clear();
    for (const [userId, score] of exchangesArr) {
      pingPongExchangesLeaderboard.set(userId, score);
    }
    console.log(`[ExchangesLeaderboard] Loaded ${pingPongExchangesLeaderboard.size} entries from GitHub file.`);
  } catch (err) {
    console.warn("[ExchangesLeaderboard] No existing exchanges leaderboard file or error loading, starting fresh.");
    pingPongExchangesLeaderboard.clear();
  }
}

// Save every 5 minutes
setInterval(() => {
  saveLeaderboardToGitHub().catch(e => console.error('Failed to save leaderboard:', e));
  saveExchangesLeaderboardToGitHub().catch(e => console.error('Failed to save exchanges leaderboard:', e));
}, 5 * 60 * 1000);

const saveOnExit = () => {
  console.log('[Leaderboard] Saving leaderboard before exit...');
  Promise.all([
    saveLeaderboardToGitHub(),
    saveExchangesLeaderboardToGitHub()
  ]).finally(() => process.exit(0));
};

process.on('SIGINT', saveOnExit);
process.on('SIGTERM', saveOnExit);

if (!TOKEN) {
  console.error('❌ TOKEN (or DISCORD_TOKEN) is not set in environment variables');
  process.exit(1);
}

// ---- Express Keep-Alive ----
const app = express();
app.get('/', (req, res) => {
  const uptime = Math.floor(process.uptime());
  const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
  res.json({
    status: 'Bot is alive!',
    uptime: uptime,
    uptimeFormatted: uptimeFormatted,
    timestamp: new Date().toISOString()
  });
  console.log(`📡 Keep-alive ping received - Uptime: ${uptimeFormatted}`);
});
app.listen(process.env.PORT || 3000, () => console.log(`🌐 Web server running`));

// ---- Discord Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel]
});

// Simple in-memory cache to avoid processing the same message/interaction twice
const processedMessages = new Set();
const processedInteractions = new Set();

const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno', 'aoi'];
const FREE_SPEECH_DURATION = 30 * 1000;
const DELETE_QUEUE_INTERVAL = 100;
const KEEP_ALIVE_INTERVAL = 60 * 1000;
const COUNTDOWN_INTERVAL = 5000;
const TEMP_UNMUTE_DURATION = 15 * 60 * 1000;
const TEST_CHANNEL_ID = '1382577291015749674';

const wordResponses = {
  'goodnight': 'gn{!}',
  'marco': 'polo',
  "what's up": 'the sky',
  'lelll😛': 'lelll😛', 'lelll 😛': 'lelll😛',
  'never back down never what': 'never give up{!}',
  'bot': 'is that a markle reference{?}',
  'markle u seeing this': 'yeah ts is crazy', 'markle r u seeing this': 'yeah ts is crazy', 'markle you seeing this': 'yeah ts is crazy', 'markle are you seeing this': 'yeah ts is crazy',
  'pls sleep': 'fr',
  'good morning': 'good morning{!}',
  '...': '...',
  'oleje': 'oleje',
  'tick': 'tock'
};

const multiWordResponses = new Map([
  [['markle', 'shut up'], 'fuck you'],
  [['markle', 'fuck you'], 'fuck you too'],
  [['talk', 'to you'], 'oh sorry'],
  [['love you', 'markle'], 'love u too 🩷'],
  [['love u', 'markle'], 'love u too 🩷'],
  [['thank you', 'markle'], 'np 🩷'],
  [['thank u', 'markle'], 'np 🩷'],
  [['ty', 'markle'], 'np 🩷'],
]);

const allowedUsers = new Set(
  process.env.ALLOWED_USERS?.split(',').map(id => id.trim()).filter(Boolean) || []
);

const allowedSlashCommandUsers = new Set(
  process.env.SLASH_COMMAND_USERS?.split(',').map(id => id.trim()).filter(Boolean) || []
);

const INITIAL_PING_PONG_TIME = 5000;
const TIME_REDUCTION_RATE = 0.1;
const PING_PONG_WIN_THRESHOLD = 10;

const activeChallenges = new Map();
const freeSpeechTimers = new Map();
const deleteQueue = [];
const muteTimeouts = new Map();
const countdownIntervals = new Map();
const mutedUsers = new Set();
const pingPongGames = new Map();
const sleepMutedUsers = new Set();
const tempUnmuteTimeouts = new Map();

// =============================================================================
// UTILITY & MODERATION FUNCTIONS
// =============================================================================
function safeDelete(message) {
  deleteQueue.push(async () => {
    try {
      if (message.deletable) {
        await message.delete();
      }
    } catch (error) {
      if (error.code !== 10008) { // Unknown Message error
        console.error('Delete fled:', error.message);
      }
    }
  });
}

function clearUserState(userId) {
  activeChallenges.delete(userId);
  mutedUsers.delete(userId);
  sleepMutedUsers.delete(userId);
  freeSpeechTimers.delete(userId);

  const game = pingPongGames.get(userId);
  if (game?.timeout) clearTimeout(game.timeout);
  pingPongGames.delete(userId);

  const muteTimeout = muteTimeouts.get(userId);
  if (muteTimeout) {
    clearTimeout(muteTimeout);
    muteTimeouts.delete(userId);
  }

  const tempUnmuteTimeout = tempUnmuteTimeouts.get(userId);
  if (tempUnmuteTimeout) {
    clearTimeout(tempUnmuteTimeout);
    tempUnmuteTimeouts.delete(userId);
  }

  const countdownInterval = countdownIntervals.get(userId);
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownIntervals.delete(userId);
  }
}

function generateExclamations(count) {
  return '!'.repeat(count);
}

function containsBannedWord(content) {
  const lower = content.toLowerCase();
  return bannedWords.some(word => lower.includes(word));
}

function processRandomPunctuation(text) {
  text = text.replace(/\{!\}/g, () => '!'.repeat(Math.floor(Math.random() * 13) + 3));
  text = text.replace(/\{\?\}/g, () => '?'.repeat(Math.floor(Math.random() * 13) + 3));
  return text;
}

function checkWordResponses(content) {
  const lower = content.toLowerCase();
  const originalMessage = content.trim();

  if (/^markle$/i.test(originalMessage)) {
    return 'wsg';
  }
  if (/\bgn\b/i.test(originalMessage)) {
    return processRandomPunctuation('gn{!}');
  }
  if (/\bcya\b/i.test(originalMessage)) {
    return processRandomPunctuation('cya{!}');
  }
  if (/\bho\b/i.test(originalMessage)) {
    return processRandomPunctuation('ho');
  }
  if (wordResponses[lower]) {
    return processRandomPunctuation(wordResponses[lower]);
  }
  for (const [wordPr, response] of multiWordResponses) {
    const [word1, word2] = wordPr;
    if (lower.includes(word1.toLowerCase()) && lower.includes(word2.toLowerCase())) {
      return processRandomPunctuation(response);
    }
  }
  const words = lower.split(/\s+/);
  const matchedResponses = [];
  for (const [trigger, response] of Object.entries(wordResponses)) {
    if (words.includes(trigger.toLowerCase())) {
      matchedResponses.push(processRandomPunctuation(response));
    }
  }
  if (matchedResponses.length > 1) {
    return matchedResponses.join(' ');
  }
  if (matchedResponses.length === 1) {
    return matchedResponses[0];
  }
  return null;
}

// =============================================================================
// PING PONG GAME FUNCTIONS (RANDOM VERSION, SINGLE SEND)
// =============================================================================

function handlePingPongResponse(message, content) {
  const userId = message.author.id;
  const lower = content.toLowerCase();
  const game = pingPongGames.get(userId);

  if (!game) {
    if (lower === 'ping' || lower === 'pong') {
      const botWord = Math.random() < 0.5 ? 'ping' : 'pong';
      startPingPongGame(message.channel, userId, botWord, 1);
      // count first exchange for both leaderboards
      incrementPingPongExchange(userId);
      return true;
    }
    return false;
  }

  if (lower === game.expectedWord) {
    clearTimeout(game.timeout);
    const newExchanges = game.exchanges + 1;
    const nextWord = Math.random() < 0.5 ? 'ping' : 'pong';

    // increment total exchanges
    incrementPingPongExchange(userId);

    // update highest streak leaderboard
    const prev = pingPongLeaderboard.get(userId) || 0;
    if (newExchanges > prev) {
      console.log(`[Leaderboard] New high score for ${userId}: ${newExchanges} (prev: ${prev})`);
      pingPongLeaderboard.set(userId, newExchanges);
      saveLeaderboardToGitHub();
    }
    startPingPongGame(message.channel, userId, nextWord, newExchanges);
    return true;
  }

  return false;
}

function incrementPingPongExchange(userId) {
  const current = pingPongExchangesLeaderboard.get(userId) || 0;
  pingPongExchangesLeaderboard.set(userId, current + 1);
  saveExchangesLeaderboardToGitHub();
}

async function startPingPongGame(channel, userId, expectedWord = 'ping', exchanges = 0) {
  if (pingPongGames.has(userId)) {
    const existingGame = pingPongGames.get(userId);
    if (existingGame.timeout) clearTimeout(existingGame.timeout);
  }
  const timeLimit = exchanges === 0 ? INITIAL_PING_PONG_TIME :
    Math.max(1000, INITIAL_PING_PONG_TIME * Math.pow(1 - TIME_REDUCTION_RATE, exchanges));
  try {
    await channel.send(`<@${userId}> ${expectedWord}`);
  } catch (error) {
    console.error('Failed to send ping/pong message:', error);
  }
  const timeout = setTimeout(async () => {
    try {
      const prev = pingPongLeaderboard.get(userId) || 0;
      if (exchanges > prev) {
        console.log(`[Leaderboard] Timed out, new high score for ${userId}: ${exchanges} (prev: ${prev})`);
        pingPongLeaderboard.set(userId, exchanges);
        await saveLeaderboardToGitHub();
      }
      try {
        await channel.send(`ggwp <@${userId}>, you had ${exchanges} exchanges`);
      } catch (error) {
        console.error('Failed to send ping-pong timeout message:', error);
      }
      pingPongGames.delete(userId);
    } catch (error) {
      console.error('Error in ping-pong timeout:', error);
    }
  }, timeLimit);
  pingPongGames.set(userId, {
    exchanges,
    timeout,
    expectedWord
  });
}

// ... (all your other functions remain unchanged)

// =============================================================================
// SLASH COMMANDS AND STARTUP
// =============================================================================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);

  await loadLeaderboardFromGitHub();
  await loadExchangesLeaderboardFromGitHub();

  setInterval(async () => {
    try {
      const channel = await client.channels.fetch(TEST_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.error(`TEST_CHANNEL_ID ${TEST_CHANNEL_ID} not found or not text-based`);
        return;
      }
      const msg = await channel.send('✅ Still alive');
      setTimeout(() => safeDelete(msg), 5000);
    } catch (error) {
      console.error('Failed to send keep-alive message:', error);
    }
  }, KEEP_ALIVE_INTERVAL);

  const commands = [
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Start a counting challenge for a user')
      .addUserOption(opt => opt.setName('user').setDescription('User to challenge').setRequired(true))
      .addIntegerOption(opt => opt.setName('duration').setDescription('Mute duration in seconds (default: 30)').setRequired(false).setMinValue(10).setMaxValue(3600)),
    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Cancel a user\'s challenge or sleep mute')
      .addUserOption(opt => opt.setName('user').setDescription('User to release').setRequired(true))
      .addBooleanOption(opt => opt.setName('temporary').setDescription('Temporary unmute for 15 minutes (default: false)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('sleep')
      .setDescription('Put a user to sleep - complete silence with no way to speak')
      .addUserOption(opt => opt.setName('user').setDescription('User to put to sleep').setRequired(true)),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot status and active challenges'),
    new SlashCommandBuilder()
      .setName('pingpongleaderboard')
      .setDescription('Show the top 10 highest ping pong single-game interactions'),
    new SlashCommandBuilder()
      .setName('pingpongexchangesleaderboard')
      .setDescription('Show the top 10 ping pong players by total lifetime exchanges')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    const appData = await rest.get(Routes.oauth2CurrentApplication());
    await rest.put(Routes.applicationCommands(appData.id), { body: commands });
    console.log('✅ Slash commands registered successfully');
  } catch (error) {
    console.error('❌ Slash command registration failed:', error);
  }
});

// =============================================================================
// SLASH COMMAND & MESSAGE HANDLERS (NO GUARD, ATTACHED ONLY ONCE!)
// =============================================================================

client.on('interactionCreate', async interaction => {
  // Prevent duplicate interactions
      // Restrict all commands except ping pong leaderboards to allowedSlashCommandUsers
    if (
      !['pingpongleaderboard', 'pingpongexchangesleaderboard'].includes(interaction.commandName) &&
      !allowedSlashCommandUsers.has(interaction.user.id)
    ) {
      return interaction.reply({
        content: '❌ You are not authorized to use this command.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === 'mute') {
      // ... unchanged
    } else if (interaction.commandName === 'sleep') {
      // ... unchanged
    } else if (interaction.commandName === 'unmute') {
      // ... unchanged
    } else if (interaction.commandName === 'status') {
      // ... unchanged
    } else if (interaction.commandName === 'pingpongleaderboard') {
      const top = [...pingPongLeaderboard.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      await interaction.deferReply();

      if (top.length === 0) {
        await interaction.editReply('No ping pong games played yet!');
      } else {
        const leaderboard = await Promise.all(top.map(async ([userId, score], idx) => {
          let username;
          try {
            const user = await client.users.fetch(userId);
            username = user.tag;
          } catch {
            username = `Unknown (${userId})`;
          }
          return `${idx + 1}. ${username}: ${score}`;
        }));
        await interaction.editReply({
          content: `🏓 **Ping Pong Highest Interactions Leaderboard** 🏓\n${leaderboard.join('\n')}`
        });
      }
    } else if (interaction.commandName === 'pingpongexchangesleaderboard') {
      const top = [...pingPongExchangesLeaderboard.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      await interaction.deferReply();

      if (top.length === 0) {
        await interaction.editReply('No ping pong exchanges counted yet!');
      } else {
        const leaderboard = await Promise.all(top.map(async ([userId, score], idx) => {
          let username;
          try {
            const user = await client.users.fetch(userId);
            username = user.tag;
          } catch {
            username = `Unknown (${userId})`;
          }
          return `${idx + 1}. ${username}: ${score}`;
        }));
        await interaction.editReply({
          content: `🏓 **Ping Pong Total Exchanges Leaderboard** 🏓\n${leaderboard.join('\n')}`
        });
      }
    }
  } catch (error) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ An error occurred while processing the command.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: '❌ An error occurred while processing the command.', flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error('Failed to send error message to interaction:', e);
    }
    console.error('Discord slash command error:', error);
  }
});

// ... (rest of your message, moderation, and event handlers remain unchanged)

client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
