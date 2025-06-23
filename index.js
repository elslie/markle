import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

dotenv.config();

console.log('Bot process started at', new Date().toISOString());

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const pingPongLeaderboard = new Map();

// ---- SQLite Leaderboard ----
const db = new Database('leaderboard.db');
db.prepare(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    userId TEXT PRIMARY KEY,
    score INTEGER NOT NULL
  )
`).run();

function loadLeaderboard() {
    pingPongLeaderboard.clear();
    for (const row of db.prepare('SELECT userId, score FROM leaderboard').all()) {
        pingPongLeaderboard.set(row.userId, row.score);
    }
    console.log(`[Leaderboard] Loaded ${pingPongLeaderboard.size} entries from database.`);
}

function saveLeaderboard() {
    const insert = db.prepare(
        'INSERT INTO leaderboard (userId, score) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET score=excluded.score'
    );
    for (const [userId, score] of pingPongLeaderboard.entries()) {
        insert.run(userId, score);
    }
    console.log(`[Leaderboard] Saved ${pingPongLeaderboard.size} entries to database.`);
}

// Load on boot
loadLeaderboard();

// Save every 5 minutes
setInterval(saveLeaderboard, 5 * 60 * 1000);

// Save on exit
const saveOnExit = () => {
    console.log('[Leaderboard] Saving leaderboard before exit...');
    saveLeaderboard();
    process.exit(0);
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
    const uptimeFormatted = `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`;
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

// =============================================================================
// BOT CONFIGURATION AND VARIABLES
// =============================================================================

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
    'lelll🤑': 'get a load of this guy lmao', 'lelll 🤑': 'get a load of this guy lmao',
    '...': '...'
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
            if (error.code !== 10008) {
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
// PING PONG GAME FUNCTIONS
// =============================================================================

function handlePingPongResponse(message, content) {
    const userId = message.author.id;
    const lower = content.toLowerCase();
    const game = pingPongGames.get(userId);

    if (!game) {
        if (lower === 'ping' || lower === 'pong') {
            const botWord = lower === 'ping' ? 'pong' : 'ping';
            message.channel.send(`<@${userId}> ${botWord}`);
            startPingPongGame(message.channel, userId, botWord, 1);
            return true;
        }
        return false;
    }

    if (lower === game.expectedWord) {
        clearTimeout(game.timeout);
        const newExchanges = game.exchanges + 1;
        const nextWord = game.expectedWord === 'ping' ? 'pong' : 'ping';

        if (newExchanges % PING_PONG_WIN_THRESHOLD === 0) {
            message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
            const prev = pingPongLeaderboard.get(userId) || 0;
            if (newExchanges > prev) {
                pingPongLeaderboard.set(userId, newExchanges);
                saveLeaderboard();
            }
        }

        message.channel.send(`<@${userId}> ${nextWord}`);
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
    const timeout = setTimeout(async () => {
        try {
            const prev = pingPongLeaderboard.get(userId) || 0;
            if (exchanges > prev) {
                pingPongLeaderboard.set(userId, exchanges);
                saveLeaderboard();
            }
            await channel.send(`ggwp <@${userId}>, you had ${exchanges} exchanges`);
            pingPongGames.delete(userId);
        } catch (error) { }
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
            await channel.send(`hey <@${userId}> how many`);
        }
        await channel.send(`<@${userId}> count${exclamations}`);
        activeChallenges.set(userId, {
            state: 'wting',
            answer: count,
            timestamp: Date.now()
        });
        mutedUsers.add(userId);
    } catch (error) { }
}

async function startFreeSpeechCountdown(channel, userId) {
    const startTime = Date.now();
    freeSpeechTimers.set(userId, startTime);
    const interval = setInterval(async () => {
        try {
            const elapsed = Date.now() - startTime;
            const remning = Math.ceil((FREE_SPEECH_DURATION - elapsed) / 1000);
            if (remning > 0) {
                const msg = await channel.send(`${remning}`);
                setTimeout(() => safeDelete(msg), 3000);
            } else {
                await channel.send(`<@${userId}> no more free speech`);
                freeSpeechTimers.delete(userId);
                countdownIntervals.delete(userId);
                clearInterval(interval);
            }
        } catch (error) {
            clearInterval(interval);
            countdownIntervals.delete(userId);
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
        } catch (error) { }
    }
}, DELETE_QUEUE_INTERVAL);

// =============================================================================
// SLASH COMMANDS AND STARTUP
// =============================================================================
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);

    setInterval(async () => {
        try {
            const channel = await client.channels.fetch(TEST_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.isTextBased()) return;
            const msg = await channel.send('✅ Still alive');
            setTimeout(() => safeDelete(msg), 5000);
        } catch (error) { }
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
// SLASH COMMAND HANDLER
// =============================================================================
client.on('interactionCreate', async interaction => {
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
                channel.send(`<@${user.id}> has been automatically unmuted (time expired).`);
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
            await channel.send(`go to sleep <@${user.id}>`);
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
                    channel.send(`<@${user.id}> temporary unmute expired - go back to sleep`);
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
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ An error occurred while processing the command.', flags: MessageFlags.Ephemeral });
        }
        console.error('Discord slash command error:', error);
    }
});

// =============================================================================
// MAIN MESSAGE PROCESSING LOGIC
// =============================================================================
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const content = message.content.trim();

    // --- 1. Handle banned words ---
    if (containsBannedWord(content)) {
        safeDelete(message);
        try { await message.channel.send(`<@${userId}> nuh uh no no word`); } catch (error) { }
        return;
    }

    // --- 2. Handle allowed users (ping pong, keywords) ---
    if (allowedUsers.has(userId)) {
        if (handlePingPongResponse(message, content)) return;
        const response = checkWordResponses(content);
        if (response) {
            try { await message.channel.send(response); } catch (error) { }
            return;
        }
        return;
    }

    // --- 3. Handle sleep muted users ---
    if (sleepMutedUsers.has(userId)) {
        safeDelete(message);
        return;
    }

    // --- 4. Handle regular users not muted ---
    if (!mutedUsers.has(userId)) {
        if (handlePingPongResponse(message, content)) return;
        const response = checkWordResponses(content);
        if (response) {
            try { await message.channel.send(response); } catch (error) { }
            return;
        }
        return;
    }

    // --- 5. Handle muted users with challenges ---
    const challenge = activeChallenges.get(userId);
    const freeSpeechTimer = freeSpeechTimers.get(userId);
    if (freeSpeechTimer) return;
    if (challenge?.state === 'solved') {
        if (Math.random() < 0.2) {
            await startFreeSpeechCountdown(message.channel, userId);
            await message.channel.send(`<@${userId}> congrats u now have temporary free speech`);
        }
        activeChallenges.delete(userId);
        return;
    }
    safeDelete(message);
    if (challenge?.state === 'waiting') {
        const guess = parseInt(content, 10);
        if (!isNaN(guess) && guess === challenge.answer) {
            await message.channel.send(`<@${userId}> good boy`);
            activeChallenges.set(userId, { state: 'solved' });
        } else {
            await message.channel.send(`<@${userId}> nuh uh, try again`);
            await sendChallenge(message.channel, userId, false);
        }
        return;
    }
    await sendChallenge(message.channel, userId, true);
});

// =============================================================================
// ERROR HANDLING AND SHUTDOWN
// =============================================================================
client.on('error', error => console.error('Discord client error:', error));
client.on('warn', warning => console.warn('Discord client warning:', warning));
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

// =============================================================================
// BOT LOGIN
// =============================================================================
client.login(TOKEN).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});

/*
===============================================================================
NOTE: If you deploy to Render, Heroku, Vercel, or similar, the leaderboard file
      will NOT persist between deploys/restarts. Use a real database for
      production storage!
===============================================================================
*/
