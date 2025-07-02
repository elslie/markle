import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
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

// --- Robust GitHub File Save (with 409 retry) ---
async function saveToGitHubFile({ path, message, content }) {
  let attempts = 0;
  let sha;
  while (attempts < 3) {
    attempts++;
    try {
      const { data } = await octokit.repos.getContent({
        owner: GITHUB_OWNER, repo: GITHUB_REPO, path,
      });
      sha = data.sha;
    } catch (err) {
      sha = undefined; // file doesn't exist yet
    }
    try {
      await octokit.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path,
        message,
        content: Buffer.from(content).toString("base64"),
        sha,
        branch: DEFAULT_BRANCH,
      });
      return;
    } catch (err) {
      if (err.status === 409 && attempts < 3) {
        console.warn(`[GitHub] 409 on ${path}, retrying...`);
        continue;
      }
      console.error(`[GitHub] Failed to save ${path}:`, err);
      throw err;
    }
  }
}

// Save leaderboard to GitHub file (highest single-game streaks)
async function saveLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongLeaderboard.entries()], null, 2);
  await saveToGitHubFile({
    path: LEADERBOARD_PATH,
    message: "Update ping pong highest streaks leaderboard",
    content,
  });
}

// Save exchanges leaderboard
async function saveExchangesLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongExchangesLeaderboard.entries()], null, 2);
  await saveToGitHubFile({
    path: EXCHANGES_LEADERBOARD_PATH,
    message: "Update ping pong exchanges leaderboard",
    content,
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
setInterval(() => {
  processedMessages.clear();
  processedInteractions.clear();
  console.log('[Deduplication] cleared processedMessages and processedInteractions sets');
}, 5 * 60 * 1000);

// ... (moderation/util functions unchanged) ...

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

// --- Utility & moderation fns unchanged ---
// ... (leave safeDelete, clearUserState, etc. as you have them) ...

// --- PING PONG LOGIC (unchanged from your last version) ---
let globalGameId = 0;

function handlePingPongResponse(message, content) {
  const userId = message.author.id;
  const lower = content.toLowerCase();
  const game = pingPongGames.get(userId);

  console.log(`[PingPong] Received "${content}" from ${userId}, current game:`, game);

  if (!game) {
    if (lower === 'ping' || lower === 'pong') {
      const botWord = Math.random() < 0.5 ? 'ping' : 'pong';
      startPingPongGame(message.channel, userId, botWord, 1);
      incrementPingPongExchange(userId);
      return true;
    }
    return false;
  }

  if (lower === game.expectedWord && game.active) {
    game.active = false;
    clearTimeout(game.timeout);

    const newExchanges = game.exchanges + 1;
    const nextWord = Math.random() < 0.5 ? 'ping' : 'pong';

    incrementPingPongExchange(userId);

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
  const timeLimit = exchanges === 0 ? 7000 : Math.max(1200, INITIAL_PING_PONG_TIME * Math.pow(1 - TIME_REDUCTION_RATE, exchanges));
  const myGameId = ++globalGameId;

  pingPongGames.set(userId, {
    exchanges,
    timeout: null,
    expectedWord,
    active: true,
    gameId: myGameId,
  });

  try {
    await channel.send(`<@${userId}> ${expectedWord}`);
  } catch (error) {
    console.error('Failed to send ping/pong message:', error);
  }

  const timeout = setTimeout(async () => {
    const game = pingPongGames.get(userId);
    if (!game || !game.active || game.gameId !== myGameId) return;
    game.active = false;
    const prev = pingPongLeaderboard.get(userId) || 0;
    if (game.exchanges > prev) {
      console.log(`[Leaderboard] Timed out, new high score for ${userId}: ${game.exchanges} (prev: ${prev})`);
      pingPongLeaderboard.set(userId, game.exchanges);
      await saveLeaderboardToGitHub();
    }
    try {
      await channel.send(`ggwp <@${userId}>, you had ${game.exchanges} exchanges`);
    } catch (error) {
      console.error('Failed to send ping-pong timeout message:', error);
    }
    pingPongGames.delete(userId);
    console.log(`[PingPong] Game ended for ${userId} by timeout at ${game.exchanges} exchanges.`);
  }, timeLimit);

  const game = pingPongGames.get(userId);
  if (game) game.timeout = timeout;
  console.log(`[PingPong] Started/continued game for ${userId}: expecting "${expectedWord}", exchanges: ${exchanges}, gameId: ${myGameId}`);
}

// --- SLASH COMMANDS & STARTUP ---
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
      .setName('pingpongleaderboard')
      .setDescription('Show the top 10 highest ping pong single-game interactions'),
    new SlashCommandBuilder()
      .setName('pingpongexchangesleaderboard')
      .setDescription('Show the top 10 ping pong players by total lifetime exchanges'),
    // Add others as needed
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (processedInteractions.has(interaction.id)) {
    console.log(`[Deduplication] Skipping already-processed interaction ${interaction.id}`);
    return;
  }
  processedInteractions.add(interaction.id);

  try {
    const userId = interaction.user.id;
    if (
      !['pingpongleaderboard', 'pingpongexchangesleaderboard'].includes(interaction.commandName) &&
      !allowedSlashCommandUsers.has(userId)
    ) {
      return interaction.reply({
        content: '❌ You are not authorized to use this command.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === 'pingpongleaderboard') {
      const sorted = [...pingPongLeaderboard.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      const embed = new EmbedBuilder()
        .setTitle('🏓 Ping Pong Leaderboard')
        .setDescription(
          sorted.map(([user, score], i) => `${i + 1}. <@${user}> — ${score} exchanges`).join('\n') ||
          "*No scores yet*"
        );
      return interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'pingpongexchangesleaderboard') {
      const sorted = [...pingPongExchangesLeaderboard.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      const embed = new EmbedBuilder()
        .setTitle('🏓 Ping Pong Lifetime Exchanges')
        .setDescription(
          sorted.map(([user, score], i) => `${i + 1}. <@${user}> — ${score} total`).join('\n') ||
          "*No scores yet*"
        );
      return interaction.reply({ embeds: [embed] });
    }

    // ... Add logic for other commands as needed ...

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

// --- MESSAGE HANDLER UNCHANGED FROM YOUR VERSION ---

client.on('messageCreate', async (message) => {
  console.log(`[Message] ${message.id} from ${message.author.tag}: "${message.content}"`);

  if (message.author.bot) {
    console.log(`[Skip] Ignoring bot message from ${message.author.tag}`);
    return;
  }

  if (processedMessages.has(message.id)) {
    console.log(`[Deduplication] Skipping already-processed message ${message.id}`);
    return;
  }
  processedMessages.add(message.id);

  if (allowedUsers.size > 0 && !allowedUsers.has(message.author.id)) {
    console.log(`[Auth] User ${message.author.tag} (${message.author.id}) not in allowedUsers`);
    return;
  }

  const content = message.content.trim();

  if (await handlePingPongResponse(message, content)) {
    console.log(`[PingPong] Responded to ping/pong from ${message.author.tag}`);
    return;
  }

  const resp = checkWordResponses(content);
  if (resp) {
    await message.reply(resp);
    console.log(`[Respond] Triggered response for "${content}" from ${message.author.tag}`);
    return;
  }

  console.log(`[No Reply] No trigger matched for ${message.author.tag}: "${content}"`);
});

client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
