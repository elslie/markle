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

const pingPongLeaderboard = new Map();
const pingPongExchangesLeaderboard = new Map();
const pingPongGames = new Map();

const mutedUsers = new Map(); // userId -> { expiresAt, challenge, free }
let isSleeping = false;

// --- Banned Words Setup ---
const bannedWords = new Set([
  "badword1",
  "badword2",
]);

function containsBannedWord(content) {
  const words = content.toLowerCase().split(/\s+/);
  return words.some(word => bannedWords.has(word));
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = "elslie";
const GITHUB_REPO = "markle";
const LEADERBOARD_PATH = "leaderboard.json";
const EXCHANGES_LEADERBOARD_PATH = "exchanges_leaderboard.json";
const DEFAULT_BRANCH = "main";

const PING_PONG_WIN_THRESHOLD = 5;
const INITIAL_PING_PONG_TIME = 7000;
const MIN_PING_PONG_TIME = 2000;

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
  const timeLimit = Math.max(
    isInitialPing ? INITIAL_PING_PONG_TIME : INITIAL_PING_PONG_TIME - exchanges * 750,
    MIN_PING_PONG_TIME
  );
  const timeout = setTimeout(() => {
    channel.send(`<@${userId}> you took too long! Game over with ${exchanges} exchanges.`);
    pingPongGames.delete(userId);
  }, timeLimit);
  pingPongGames.set(userId, {
    expectingResponse: isInitialPing,
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
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Mute a user with a challenge')
      .addUserOption(option =>
        option.setName('target')
          .setDescription('User to mute')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName('minutes')
          .setDescription('Minutes to mute for (optional)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Unmute a user')
      .addUserOption(option =>
        option.setName('target')
          .setDescription('User to unmute')
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName('sleep').setDescription('Put Markle bot to sleep (no ping-pong/auto-replies)'),
    new SlashCommandBuilder().setName('wake').setDescription('Wake Markle bot up!'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (!CLIENT_ID) {
    throw new Error('CLIENT_ID environment variable is missing!');
  }

  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: commands }
  );
  console.log('Registered global slash commands.');
}

// --- Slash Command Handler ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'mute') {
    const target = interaction.options.getUser('target');
    const minutes = interaction.options.getInteger('minutes');
    const expiresAt = minutes ? Date.now() + minutes * 60 * 1000 : null;
    const challengeCount = Math.floor(Math.random() * 10) + 3;
    mutedUsers.set(target.id, {
      expiresAt,
      challenge: challengeCount,
      free: false,
    });
    await interaction.reply({ content: `🔇 Muted <@${target.id}>${minutes ? ` for ${minutes} minute(s)` : ' indefinitely'}!`, allowedMentions: { users: [target.id] } });
    if (expiresAt) {
      setTimeout(() => {
        if (mutedUsers.has(target.id) && mutedUsers.get(target.id).expiresAt === expiresAt) {
          mutedUsers.delete(target.id);
        }
      }, minutes * 60 * 1000 + 1000); // Add a second for safety
    }
  }
  if (interaction.commandName === 'unmute') {
    const target = interaction.options.getUser('target');
    mutedUsers.delete(target.id);
    await interaction.reply({ content: `🔊 Unmuted <@${target.id}>!`, allowedMentions: { users: [target.id] } });
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

// --- Muted User Message Handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (isSleeping) return;
  if (containsBannedWord(msg.content)) return;

  // Muted user logic
  const muted = mutedUsers.get(msg.author.id);
  if (muted) {
    // Clean up expired mutes
    if (muted.expiresAt && Date.now() > muted.expiresAt) {
      mutedUsers.delete(msg.author.id);
      return;
    }

    // If user has a "free" message, allow it and reset free
    if (muted.free) {
      muted.free = false;
      return;
    }

    // Is this a reply to the challenge?
    const expected = '!'.repeat(muted.challenge);
    if (msg.content.trim() === expected) {
      // Correct!
      muted.free = true; // allow one message
      muted.challenge = Math.floor(Math.random() * 10) + 3; // new challenge next time
      await msg.channel.send(`<@${msg.author.id}> correct! You get one free message.`);
    } else if (/^!+$/.test(msg.content.trim())) {
      // Incorrect number of exclamation marks
      await msg.channel.send('nuh uh');
    } else {
      // Send the challenge!
      await msg.channel.send(`<@${msg.author.id}> count(${expected})`);
    }

    // Delete their message to keep channel clean
    safeDelete(msg);
    return;
  }

  // Normal bot features
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
