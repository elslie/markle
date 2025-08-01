import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder
} from 'discord.js';
import { Octokit } from "@octokit/rest";

dotenv.config();

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const ALLOWED_USERS = [
  '1333226098128846949'
];

const pingPongLeaderboard = new Map();
const pingPongExchangesLeaderboard = new Map();
const pingPongGames = new Map();
const mutedUsers = new Map();
let isSleeping = false;

const bannedWords = new Set([
  "yaoi",
  "fag",
  "retard",
  "nig"
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

const INITIAL_PING_PONG_TIME = 7000;
const MIN_PING_PONG_TIME = 600;

// --- Utility: Robust Discord Interaction Reply ---
async function safeReply(interaction, data) {
  let tried = 0;
  while (tried < 3) {
    tried++;
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(data);
      } else {
        await interaction.reply(data);
      }
      return true;
    } catch (err) {
      if (tried < 3) continue;
      console.error("[Discord] Failed to reply:", err);
    }
  }
  return false;
}

// --- Utility: Sleep for ms ---
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

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
    console.log(`[Exchanges Leaderboard] Loaded ${pingPongExchangesLeaderboard.size} entries from GitHub file.`);
  } catch (err) {
    console.warn("[Exchanges Leaderboard] No existing GitHub exchanges leaderboard file or error loading, starting fresh.");
  }
}

const wordResponses = {
  "good morning": "gm{!}", "gm": "gm{!}"
  "goodnight": "gn{!}", "good night": "gn{!}", 
  "bye": "bye{!}", "goodbye": "goodbye{!}",
  "ho": "ho",
  "lelll😛": "lelll😛",
  "marco": "polo",
  "hbu": "nothing much", "wbu": "nothing much",
  "bot": "is that a markle reference{?}",
  "awesomesauce": "awesomesauce{!}", "awesome sauce": "awesomesauce{!}",
  "everypony": "everypony{!}",
  "shup up": "shup up",
  "...": "...",
  "fuck": "*flip",
  "clanker": "what didd u just say{?}" 
};
const multiWordResponses = [
  [["fuck you", "markle"], "fuck you too"], [["fuck u", "markle"], "fuck you too"],
  [["shut up", "markle"], "fuck you"],
  [["love you", "markle"], "love u too :pink_heart:"], [["love u", "markle"], "love u too :pink_heart:"], 
  [["thank you", "markle"], "np :pink_heart:"], [["thanks", "markle"], "np :pink_heart:"],
  [["markle", "seeing this"], "yeah ts is crazy"],
  [["markle", "to you"], "mb gang"],
];

function processRandomPunctuation(text, forceLength) {
  const dynamicPunctuation = {
    '{!}': '!',
    '{?}': '?',
    '{a}': 'a',
    '{i}': 'i'
  };

  for (const token in dynamicPunctuation) {
    const char = dynamicPunctuation[token];
    if (forceLength && text.includes(token)) {
      text = text.replace(token, char.repeat(forceLength));
    } else {
      while (text.includes(token)) {
        const count = Math.floor(Math.random() * 13) + 3;
        text = text.replace(token, char.repeat(count));
      }
    }
  }
  return text;
}

// --- Normalization helper to handle weird characters ---
function normalizeText(text) {
  return text.normalize("NFKD")
             .replace(/[\u0300-\u036f]/g, "") // strip diacritics
             .replace(/[\u043E]/g, "o")       // Cyrillic small o → Latin o
             .replace(/[\u0430]/g, "a")       // Cyrillic small a → Latin a
             .replace(/[\u0410]/g, "A")       // Cyrillic capital A → Latin A
             .replace(/[\u03BF]/g, "o")       // Greek omicron → Latin o
             .replace(/[\u041E]/g, "O")       // Cyrillic capital O → Latin O
             .toLowerCase();
}

// --- Palindrome check, for aibohphobia ---
function isPalindrome(word) {
  if (!word || word.length < 3) return false;
  const normalized = word.toLowerCase();
  if (/^([a-z])\1*$/.test(normalized)) return false; // skip if all same letter
  return normalized === normalized.split('').reverse().join('');
}

function checkWordResponses(content) {
  const lower = content.toLowerCase().trim();
  const originalMessage = content.trim();
  const normalized = normalizeText(originalMessage);

  // --- Regex-based triggers ---
  // "rahhh" dynamic: length scales output
  const rahRegex = /^ra+h+$/i;
  if (rahRegex.test(normalized)) {
    const rahLen = normalized.length;
    // Always lowercase, scale a/h/!
    const aCount = Math.max(1, Math.floor(rahLen / 5));
    const hCount = Math.max(3, Math.floor(rahLen / 2));
    const exclCount = Math.max(3, Math.floor(rahLen / 3));
    const out = "r" + "a".repeat(aCount) + "h".repeat(hCount) + "!".repeat(exclCount);
    return out;
  }

  const regexTriggers = [
    [/^cwaizi+$/i, "cwaizi{!}"],
    [/^gn$/i, "gn{!}"],
    [/^cya$/i, "cya{!}"],
  ];
  for (const [regex, response] of regexTriggers) {
    if (regex.test(normalized)) {
      return processRandomPunctuation(response);
    }
  }

  // --- Exact single-word triggers ---
  if (/^markle$/i.test(originalMessage)) {
    return 'wsg';
  }
  if (wordResponses[lower]) {
    return processRandomPunctuation(wordResponses[lower]);
  }

  // --- Multi-word triggers ---
  for (const [wordPair, response] of multiWordResponses) {
    const [word1, word2] = wordPair;
    if (lower.includes(word1.toLowerCase()) && lower.includes(word2.toLowerCase())) {
      return processRandomPunctuation(response);
    }
  }

  // --- Partial matches from wordResponses ---
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

// --- Ping Pong Game Logic ---
function startPingPongGame(channel, userId, exchanges = 0, lastBotMessageType = "ping") {
  if (pingPongGames.has(userId)) {
    const existingGame = pingPongGames.get(userId);
    if (existingGame.timeout) clearTimeout(existingGame.timeout);
  }
  let timeLimit = Math.max(INITIAL_PING_PONG_TIME * Math.pow(0.9, exchanges), MIN_PING_PONG_TIME);

  const timeout = setTimeout(async () => {
    const word = exchanges === 1 ? "exchange" : "exchanges";
    channel.send(`<@${userId}> ggwp u had ${exchanges} ${word}`).catch(console.error);
    pingPongGames.delete(userId);
  }, timeLimit);

  pingPongGames.set(userId, {
    exchanges,
    timeout,
    lastBotMessageType
  });
}

// --- Handle User Ping Pong Response ---
function handlePingPongResponse(msg, content) {
  if (!msg || !msg.channel || !msg.author) return false;
  const userId = msg.author.id;
  const lower = content.trim().toLowerCase();
  const username = msg.author.username;

  // Only allow "ping" or "pong"
  if (lower !== "ping" && lower !== "pong") {
    return;
  }

  const currentGame = pingPongGames.get(userId);

  // If no game is active, start a new one
  if (!currentGame) {
    const botStartsWith = Math.random() < 0.5 ? "ping" : "pong";
    msg.channel.send(botStartsWith).catch(console.error);
    startPingPongGame(msg.channel, userId, 0, botStartsWith);
    return;
  }

  const expected = currentGame.lastBotMessageType === "ping" ? "pong" : "ping";

  // Wrong move: end the game and notify
  if (lower !== expected) {
    msg.channel.send(`<@${userId}> wrong move—expected **${expected}**!`).catch(console.error);
    clearTimeout(currentGame.timeout);
    pingPongGames.delete(userId);
    return;
  }

  // Success! Continue the game
  clearTimeout(currentGame.timeout);
  const updatedStreak = currentGame.exchanges + 1;

  // Update lifetime total
  const previousTotal = pingPongExchangesLeaderboard.get(userId) || 0;
  pingPongExchangesLeaderboard.set(userId, previousTotal + 1);

  // Update highest streak if needed
  const bestStreak = pingPongLeaderboard.get(userId) || 0;
  if (updatedStreak > bestStreak) {
    pingPongLeaderboard.set(userId, updatedStreak);
    saveLeaderboardToGitHub().catch(console.error);
  }

  saveExchangesLeaderboardToGitHub().catch(console.error);

  // Bot replies
  const botNext = Math.random() < 0.5 ? "ping" : "pong";
  msg.channel.send(botNext).catch(console.error);
  startPingPongGame(msg.channel, userId, updatedStreak, botNext);
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
    new SlashCommandBuilder().setName('pingpongleaderboard').setDescription('Show ping-pong highest streak leaderboard'),
    new SlashCommandBuilder().setName('pingpongexchangesleaderboard').setDescription('Show ping-pong total exchanges leaderboard'),
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
  const userId = interaction.user.id.toString();

  // Admin-only commands
  if (
    ['mute', 'unmute', 'sleep', 'wake'].includes(interaction.commandName)
    && !ALLOWED_USERS.includes(userId)
  ) {
    await safeReply(interaction, {
      content: "❌ You are not allowed to use this command.",
      ephemeral: true
    });
    return;
  }

  // --- Mute Command ---
  if (interaction.commandName === 'mute') {
    try {
      const target = interaction.options.getUser('target');
      const minutes = interaction.options.getInteger('minutes') || 3;
      if (!target) {
        await safeReply(interaction, "No target user.");
        return;
      }
      const challenge = Math.floor(Math.random() * 10) + 3;
      const expiresAt = Date.now() + minutes * 60 * 1000;
      mutedUsers.set(target.id, { challenge, expiresAt, free: false });
      await safeReply(interaction, `Muted <@${target.id}> for ${minutes} minutes. They must send \`${"!".repeat(challenge)}\` to talk once.`);
    } catch (err) {
      console.error("Mute failed:", err);
      await safeReply(interaction, "The bot failed to respond (mute error). Try again or check bot permissions.");
    }
    return;
  }

  // --- Unmute Command ---
  if (interaction.commandName === 'unmute') {
    try {
      const target = interaction.options.getUser('target');
      mutedUsers.delete(target.id);
      await safeReply(interaction, `Unmuted <@${target.id}>.`);
    } catch (err) {
      console.error("Unmute failed:", err);
      await safeReply(interaction, "The bot failed to respond (unmute error). Try again or check bot permissions.");
    }
    return;
  }

  // --- Sleep Command ---
  if (interaction.commandName === 'sleep') {
    try {
      isSleeping = true;
      await safeReply(interaction, "Markle bot is now sleeping.");
    } catch (err) {
      console.error("Sleep failed:", err);
      await safeReply(interaction, "The bot failed to respond (sleep error). Try again or check bot permissions.");
    }
    return;
  }

  // --- Wake Command ---
  if (interaction.commandName === 'wake') {
    try {
      isSleeping = false;
      await safeReply(interaction, "Markle bot is awake!");
    } catch (err) {
      console.error("Wake failed:", err);
      await safeReply(interaction, "The bot failed to respond (wake error). Try again or check bot permissions.");
    }
    return;
  }

  // Filter entries: only users with more than 1 exchange show up!
  if (interaction.commandName === 'pingpongleaderboard') {
    await interaction.deferReply({ ephemeral: false });
    const items = [...pingPongLeaderboard.entries()]
      .filter(([_, score]) => score > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (items.length === 0) {
      await interaction.editReply('No games played yet!');
      return;
    }
    let text = '**🏆 Ping-Pong Highest Streaks 🏆**\n';
    let rank = 1;
    for (const [userId, score] of items) {
      text += `${rank}. <@${userId}> — ${score}\n`;
      rank++;
    }
    await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.commandName === 'pingpongexchangesleaderboard') {
    await interaction.deferReply({ ephemeral: false });
    const items = [...pingPongExchangesLeaderboard.entries()]
      .filter(([_, score]) => score > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (items.length === 0) {
      await interaction.editReply('No exchanges recorded yet!');
      return;
    }
    let text = '**🏓 Ping-Pong Total Exchanges 🏓**\n';
    let rank = 1;
    for (const [userId, score] of items) {
      text += `${rank}. <@${userId}> — ${score}\n`;
      rank++;
    }
    await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    return;
  }
});

// --- Custom User Triggers ---
const CUSTOM_TRIGGER_USERS = new Set([
  '706947985095000086',
]);
const TRIGGER_RESPONSES = {
  astolfo: "get a load of this guy",
};

// --- Markle you seeing this triggers (separate mapping) ---
const SEEING_THIS_USERS = new Set([
  // Add user IDs here who should trigger the "markle you seeing this" response
  '850321119377620992'
]);
const SEEING_THIS_TRIGGER = new Set([
  "markle you seeing this",
  "markle u seeing this",
  "markle you seeing ts",
  "markle u seeing ts"
]);
const SEEING_THIS_RESPONSE = "yh ts is cwaizi";

// --- Message Handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (isSleeping) return;

  // --- Banned words ---
  if (containsBannedWord(msg.content)) {
    try {
      await msg.delete();
      await msg.channel.send(`<@${msg.author.id}> nuh uh no no word`);
    } catch (err) {
      console.error('Failed to delete message or send warning:', err);
    }
    return;
  }

  // --- Muted user logic ---
  const muted = mutedUsers.get(msg.author.id);
  if (muted) {
    if (muted.expiresAt && Date.now() > muted.expiresAt) {
      mutedUsers.delete(msg.author.id);
      return;
    }
    if (muted.free) {
      muted.free = false;
      return;
    }
    const expected = '!'.repeat(muted.challenge);
    if (msg.content.trim() === expected) {
      muted.free = true;
      muted.challenge = Math.floor(Math.random() * 10) + 3;
      await msg.channel.send(`<@${msg.author.id}> correct! you get one message.`);
    } else if (/^!+$/.test(msg.content.trim())) {
      await msg.channel.send('nuh uh');
    } else {
      await msg.channel.send(`<@${msg.author.id}> count(${expected})`);
    }
    safeDelete(msg);
    return;
  }

  // --- Aibohphobia: Palindrome panic ---
  const words = msg.content.split(/\s+/);
  for (const word of words) {
    if (isPalindrome(word)) {
      // Randomize h and ! count
      const hCount = Math.floor(Math.random() * 8) + 4;
      const exclCount = Math.floor(Math.random() * 6) + 3;
      await msg.channel.send("ah" + "h".repeat(hCount) + "!".repeat(exclCount));
      break;
    }
  }

  // --- Custom triggers ---
  // Astolfo for allowed users
  const normalized = normalizeText(msg.content);
  for (const keyword in TRIGGER_RESPONSES) {
    if (
      CUSTOM_TRIGGER_USERS.has(msg.author.id) &&
      normalized.includes(keyword)
    ) {
      await msg.channel.send(TRIGGER_RESPONSES[keyword]);
      return;
    }
  }

  // "markle you seeing this" for specific users, do not merge!
  if (
    SEEING_THIS_USERS.has(msg.author.id) &&
    normalized.includes(SEEING_THIS_TRIGGER)
  ) {
    await msg.channel.send(SEEING_THIS_RESPONSE);
    return;
  }

  // Normal bot features
  const response = checkWordResponses(msg.content);
  if (response) {
    msg.channel.send(response).catch(console.error);
    return;
  }

  // Ping pong game
  handlePingPongResponse(msg, msg.content);
});

// Handle unhandled promise rejections globally
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

client.login(TOKEN);
