import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { Octokit } from "@octokit/rest";

dotenv.config();

console.log('=== Markle Bot starting up at', new Date().toISOString());

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const pingPongLeaderboard = new Map();
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = "elslie";
const GITHUB_REPO = "markle";
const LEADERBOARD_PATH = "leaderboard.json";
const DEFAULT_BRANCH = "main";

// Save leaderboard to GitHub file
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
    message: "Update ping pong leaderboard",
    content: contentEncoded,
    sha,
    branch: DEFAULT_BRANCH,
  });
}

// Load leaderboard from GitHub file
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

// Save every 5 minutes
setInterval(() => {
  saveLeaderboardToGitHub().catch(e => console.error('Failed to save leaderboard:', e));
}, 5 * 60 * 1000);

const saveOnExit = () => {
  console.log('[Leaderboard] Saving leaderboard before exit...');
  saveLeaderboardToGitHub().finally(() => process.exit(0));
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
  'oleje': 'oleje'
  'tick': 'tock'
};

const multiWordResponses = new Map([
  [['markle', 'shut up'], 'fuck you'],
  [['markle', 'fuck you'], 'fuck you too'],
  [['talk', 'to you'], 'oh sorry'],
  [['love you', 'markle'], 'love u too 🩷'],
  [['love u', 'markle'], 'love u too 🩷']
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
      return true;
    }
    return false;
  }

  if (lower === game.expectedWord) {
    clearTimeout(game.timeout);
    const newExchanges = game.exchanges + 1;
    const nextWord = Math.random() < 0.5 ? 'ping' : 'pong';

    if (newExchanges % PING_PONG_WIN_THRESHOLD === 0) {
      message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`)
        .catch(error => console.error('Failed to send ping pong win message:', error));
      const prev = pingPongLeaderboard.get(userId) || 0;
      if (newExchanges > prev) {
        console.log(`[Leaderboard] New high score for ${userId}: ${newExchanges} (prev: ${prev})`);
        pingPongLeaderboard.set(userId, newExchanges);
        // Await the save so leaderboard state is reliable after a win
        return saveLeaderboardToGitHub();
      }
    }
    startPingPongGame(message.channel, userId, nextWord, newExchanges);
    return true;
  }

  return false;
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

// =============================================================================
// OTHER GAME AND MODERATION FUNCTIONS
// =============================================================================
async function sendChallenge(channel, userId, intro = true) {
  try {
    const count = Math.floor(Math.random() * 21) + 10;
    const exclamations = generateExclamations(count);
    if (intro) {
      try {
        await channel.send(`hey <@${userId}> how many`);
      } catch (error) {
        console.error('Failed to send challenge intro:', error);
      }
    }
    try {
      await channel.send(`<@${userId}> count${exclamations}`);
    } catch (error) {
      console.error('Failed to send challenge count:', error);
    }
    activeChallenges.set(userId, {
      state: 'wting',
      answer: count,
      timestamp: Date.now()
    });
    mutedUsers.add(userId);
  } catch (error) {
    console.error('Error in sendChallenge:', error);
  }
}

async function startFreeSpeechCountdown(channel, userId) {
  const startTime = Date.now();
  freeSpeechTimers.set(userId, startTime);
  const interval = setInterval(async () => {
    try {
      const elapsed = Date.now() - startTime;
      const remning = Math.ceil((FREE_SPEECH_DURATION - elapsed) / 1000);
      if (remning > 0) {
        try {
          const msg = await channel.send(`${remning}`);
          setTimeout(() => safeDelete(msg), 3000);
        } catch (error) {
          console.error('Failed to send countdown message:', error);
        }
      } else {
        try {
          await channel.send(`<@${userId}> no more free speech`);
        } catch (error) {
          console.error('Failed to send free speech end message:', error);
        }
        freeSpeechTimers.delete(userId);
        countdownIntervals.delete(userId);
        clearInterval(interval);
      }
    } catch (error) {
      clearInterval(interval);
      countdownIntervals.delete(userId);
      console.error('Error in free speech countdown:', error);
    }
  }, COUNTDOWN_INTERVAL);
  countdownIntervals.set(userId, interval);
}

// =============================================================================
// DELETE QUEUE PROCESSOR
// =============================================================================
setInterval(async () => {
  const job = deleteQueue.shift();
  if (job) {
    try {
      await job();
    } catch (error) {
      console.error('Error in delete queue processor:', error);
    }
  }
}, DELETE_QUEUE_INTERVAL);

// =============================================================================
// SLASH COMMANDS AND STARTUP
// =============================================================================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}!`);

  await loadLeaderboardFromGitHub();

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
      .setDescription('Show the top 10 longest ping pong streaks')
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
  if (processedInteractions.has(interaction.id)) return;
  processedInteractions.add(interaction.id);

  if (!interaction.isChatInputCommand()) return;

  try {
    if (
      ['mute', 'unmute', 'sleep'].includes(interaction.commandName) &&
      !allowedSlashCommandUsers.has(interaction.user.id)
    ) {
      return interaction.reply({
        content: '❌ You are not authorized to use this command.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === 'mute') {
      const user = interaction.options.getUser('user');
      const duration = interaction.options.getInteger('duration') || 30;
      const channel = interaction.channel;

      clearUserState(user.id);
      await sendChallenge(channel, user.id);

      const timeout = setTimeout(() => {
        clearUserState(user.id);
        channel.send(`<@${user.id}> has been automatically unmuted (time expired).`)
          .catch(error => console.error('Failed to send unmute message:', error));
      }, duration * 1000);

      muteTimeouts.set(user.id, timeout);
      await interaction.reply({
        content: `✅ Challenge started for <@${user.id}> (Duration: ${duration}s)`,
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.commandName === 'sleep') {
      const user = interaction.options.getUser('user');
      const channel = interaction.channel;
      clearUserState(user.id);
      sleepMutedUsers.add(user.id);
      try {
        await channel.send(`go to sleep <@${user.id}>`);
      } catch (error) {
        console.error('Failed to send sleep message:', error);
      }
      await interaction.reply({
        content: `😴 <@${user.id}> has been put to sleep (permanent mute until manually unmuted)`,
        flags: MessageFlags.Ephemeral
      });
    } else if (interaction.commandName === 'unmute') {
      const user = interaction.options.getUser('user');
      const temporary = interaction.options.getBoolean('temporary') || false;
      const channel = interaction.channel;
      if (temporary && sleepMutedUsers.has(user.id)) {
        sleepMutedUsers.delete(user.id);
        const timeout = setTimeout(() => {
          sleepMutedUsers.add(user.id);
          channel.send(`<@${user.id}> temporary unmute expired - go back to sleep`)
            .catch(error => console.error('Failed to send temp remute message:', error));
        }, TEMP_UNMUTE_DURATION);
        tempUnmuteTimeouts.set(user.id, timeout);
        await interaction.reply({
          content: `⏰ <@${user.id}> temporarily unmuted for 15 minutes`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        clearUserState(user.id);
        await interaction.reply({
          content: `✅ <@${user.id}> has been completely unmuted`,
          flags: MessageFlags.Ephemeral
        });
      }
    } else if (interaction.commandName === 'status') {
      const embed = new EmbedBuilder()
        .setTitle('🤖 Bot Status')
        .setColor(0x00ff00)
        .addFields(
          { name: 'Active Challenges', value: activeChallenges.size.toString(), inline: true },
          { name: 'Muted Users', value: mutedUsers.size.toString(), inline: true },
          { name: 'Sleep Muted Users', value: sleepMutedUsers.size.toString(), inline: true },
          { name: 'Free Speech Timers', value: freeSpeechTimers.size.toString(), inline: true },
          { name: 'Ping-Pong Games', value: pingPongGames.size.toString(), inline: true },
          { name: 'Delete Queue', value: deleteQueue.length.toString(), inline: true },
          { name: 'Temp Unmute Timers', value: tempUnmuteTimeouts.size.toString(), inline: true }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
          content: `🏓 **Ping Pong Leaderboard** 🏓\n${leaderboard.join('\n')}`
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

client.on('messageCreate', async (message) => {
  // Prevent duplicate message processing
  if (processedMessages.has(message.id)) return;
  processedMessages.add(message.id);

  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const content = message.content.trim();

  if (containsBannedWord(content)) {
    safeDelete(message);
    try {
      await message.channel.send(`<@${userId}> nuh uh no no word`);
    } catch (error) {
      console.error('Failed to send banned word message:', error);
    }
    return;
  }

  let handled = false;

  if (allowedUsers.has(userId)) {
    if (await handlePingPongResponse(message, content)) {
      handled = true;
    } else {
      const response = checkWordResponses(content);
      if (response) {
        try {
          await message.channel.send(response);
        } catch (error) {
          console.error('Failed to send allowed user response:', error);
        }
        handled = true;
      }
    }
    if (handled) return;
  }

  if (sleepMutedUsers.has(userId)) {
    safeDelete(message);
    return;
  }

  if (!mutedUsers.has(userId)) {
    if (await handlePingPongResponse(message, content)) {
      handled = true;
    } else {
      const response = checkWordResponses(content);
      if (response) {
        try {
          await message.channel.send(response);
        } catch (error) {
          console.error('Failed to send unmuted user response:', error);
        }
        handled = true;
      }
    }
    if (handled) return;
    return;
  }

  // --- Only the code BELOW runs if the user IS muted! ---
  const challenge = activeChallenges.get(userId);
  const freeSpeechTimer = freeSpeechTimers.get(userId);
  if (freeSpeechTimer) return;
  if (challenge?.state === 'solved') {
    if (Math.random() < 0.2) {
      await startFreeSpeechCountdown(message.channel, userId);
      try {
        await message.channel.send(`<@${userId}> congrats u now have temporary free speech`);
      } catch (error) {
        console.error('Failed to send temporary free speech message:', error);
      }
    }
    activeChallenges.delete(userId);
    return;
  }
  safeDelete(message);
  if (challenge?.state === 'waiting') {
    const guess = parseInt(content, 10);
    if (!isNaN(guess) && guess === challenge.answer) {
      try {
        await message.channel.send(`<@${userId}> good boy`);
      } catch (error) {
        console.error('Failed to send good boy message:', error);
      }
      activeChallenges.set(userId, { state: 'solved' });
    } else {
      try {
        await message.channel.send(`<@${userId}> nuh uh, try again`);
      } catch (error) {
        console.error('Failed to send try again message:', error);
      }
      await sendChallenge(message.channel, userId, false);
    }
    return;
  }
  await sendChallenge(message.channel, userId, true);
});

client.on('error', error => console.error('Discord client error:', error));
client.on('warn', warning => console.warn('Discord client warning:', warning));

// =============================================================================
// PROCESS AND EXIT HANDLERS
// =============================================================================
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

client.login(TOKEN).catch(error => {
  console.error('Failed to login:', error);
  process.exit(1);
});
