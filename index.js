import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder
} from 'discord.js';
import { Octokit } from "@octokit/rest";

dotenv.config();

console.log('=== Markle Bot starting up at', new Date().toISOString());

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const pingPongLeaderboard = new Map(); // highest single-game streaks
const pingPongExchangesLeaderboard = new Map(); // total lifetime exchanges
const pingPongGames = new Map(); // userId -> { expectingResponse, exchanges, timeout }
const mutedUsers = new Set();
let isSleeping = false;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = "elslie";
const GITHUB_REPO = "markle";
const LEADERBOARD_PATH = "leaderboard.json";
const EXCHANGES_LEADERBOARD_PATH = "exchanges_leaderboard.json";
const DEFAULT_BRANCH = "main";

const PING_PONG_WIN_THRESHOLD = 5;
const INITIAL_PING_PONG_TIME = 7000; // ms, first round
const MIN_PING_PONG_TIME = 2000; // ms, fastest round

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
      sha = undefined;
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

async function saveLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongLeaderboard.entries()], null, 2);
  await saveToGitHubFile({
    path: LEADERBOARD_PATH,
    message: "Update ping pong highest streaks leaderboard",
    content,
  });
}

async function saveExchangesLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongExchangesLeaderboard.entries()], null, 2);
  await saveToGitHubFile({
    path: EXCHANGES_LEADERBOARD_PATH,
    message: "Update ping pong exchanges leaderboard",
    content,
  });
}

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
  }
}

// --- Word Response Logic ---
const wordResponses = {
  "hello": "hi!",
  "bye": "goodbye!",
};
const multiWordResponses = [
  [["good", "night"], "sleep well!"],
];

function processRandomPunctuation(text) {
  text = text.replace(/\{!\}/g, () => {
    const count = Math.floor(Math.random() * 13) + 3;
    return '!'.repeat(count);
  });
  text = text.replace(/\{\?\}/g, () => {
    const count = Math.floor(Math.random() * 13) + 3;
    return '?'.repeat(count);
  });
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
  if (/\bgm\b/i.test(originalMessage)) {
  return processRandomPunctuation('cya{!}');
  }
  if (wordResponses[lower]) {
    return processRandomPunctuation(wordResponses[lower]);
  }
  for (const [wordPair, response] of multiWordResponses) {
    const [word1, word2] = wordPair;
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

function safeDelete(msg) {
  if (msg && typeof msg.delete === 'function') {
    msg.delete().catch(console.error);
  }
}

// --- Ping Pong Core Logic ---
function handlePingPongResponse(message, content) {
  const userId = message.author.id;
  const lower = content.toLowerCase();
  const game = pingPongGames.get(userId);

  // "ping"
  if (lower === 'ping') {
    if (game && game.expectingResponse) {
      clearTimeout(game.timeout);
      const newExchanges = game.exchanges + 1;
      if (newExchanges > (pingPongLeaderboard.get(userId) || 0)) {
        pingPongLeaderboard.set(userId, newExchanges);
        saveLeaderboardToGitHub();
      }
      pingPongExchangesLeaderboard.set(userId, (pingPongExchangesLeaderboard.get(userId) || 0) + 1);
      saveExchangesLeaderboardToGitHub();

      if (newExchanges >= PING_PONG_WIN_THRESHOLD) {
        message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
        pingPongGames.delete(userId);
        return true;
      }
      message.channel.send('pong');
      startPingPongGame(message.channel, userId, false, newExchanges);
      pingPongGames.get(userId).expectingResponse = false;
      return true;
    } else if (!game) {
      message.channel.send('pong');
      startPingPongGame(message.channel, userId, false, 1);
      pingPongGames.get(userId).expectingResponse = false;
      return true;
    }
  }

  // "pong"
  if (lower === 'pong') {
    if (game && !game.expectingResponse) {
      clearTimeout(game.timeout);
      const newExchanges = game.exchanges + 1;
      if (newExchanges > (pingPongLeaderboard.get(userId) || 0)) {
        pingPongLeaderboard.set(userId, newExchanges);
        saveLeaderboardToGitHub();
      }
      pingPongExchangesLeaderboard.set(userId, (pingPongExchangesLeaderboard.get(userId) || 0) + 1);
      saveExchangesLeaderboardToGitHub();

      if (newExchanges >= PING_PONG_WIN_THRESHOLD) {
        message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
        pingPongGames.delete(userId);
        return true;
      }
      message.channel.send('ping');
      startPingPongGame(message.channel, userId, false, newExchanges);
      pingPongGames.get(userId).expectingResponse = true;
      return true;
    }
  }
  return false;
}

function startPingPongGame(channel, userId, isInitialPing = true, exchanges = 0) {
  if (pingPongGames.has(userId)) {
    const existingGame = pingPongGames.get(userId);
    if (existingGame.timeout) clearTimeout(existingGame.timeout);
  }
  // Gets faster each round
  const timeLimit = Math.max(
    isInitialPing ? INITIAL_PING_PONG_TIME : INITIAL_PING_PONG_TIME - exchanges * 750,
    MIN_PING_PONG_TIME
  );
  const timeout = setTimeout(() => {
    channel.send(`<@${userId}> you took too long! Game over with ${exchanges} exchanges.`);
    pingPongGames.delete(userId);
  }, timeLimit);
  pingPongGames.set(userId, {
    expectingResponse: isInitialPing, // true for ping, false for pong
    exchanges,
    timeout,
  });
}

// --- Express/discord.js setup ---
const app = express();
app.get('/', (req, res) => res.send('Markle bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server listening on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  loadLeaderboardFromGitHub();
  registerSlashCommands();
});

// --- Slash Command Registration ---
async function registerSlashCommands() {
  const commands = [
    new SlashCommandBuilder().setName('mute').setDescription('Mute Markle bot'),
    new SlashCommandBuilder().setName('unmute').setDescription('Unmute Markle bot'),
    new SlashCommandBuilder().setName('sleep').setDescription('Put Markle bot to sleep (no ping-pong/auto-replies)'),
    new SlashCommandBuilder().setName('wake').setDescription('Wake Markle bot up!'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('Registered slash commands.');
}

// --- Slash Command Handler ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'mute') {
    mutedUsers.add(interaction.user.id);
    await interaction.reply({ content: 'You have muted Markle!', ephemeral: true });
  }
  if (interaction.commandName === 'unmute') {
    mutedUsers.delete(interaction.user.id);
    await interaction.reply({ content: 'You have unmuted Markle!', ephemeral: true });
  }
  if (interaction.commandName === 'sleep') {
    isSleeping = true;
    await interaction.reply({ content: 'Markle is now sleeping. No ping-pong or auto-replies.', ephemeral: true });
  }
  if (interaction.commandName === 'wake') {
    isSleeping = false;
    await interaction.reply({ content: 'Markle is awake!', ephemeral: true });
  }
});

// --- Main message handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (mutedUsers.has(msg.author.id) || isSleeping) return;

  const response = checkWordResponses(msg.content);
  if (response) {
    msg.channel.send(response).then(sentMsg => {
      setTimeout(() => safeDelete(sentMsg), 5000);
    }).catch(console.error);
    return;
  }

  handlePingPongResponse(msg, msg.content);
});

client.login(TOKEN);
