import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import pkg from 'pg';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

dotenv.config();

console.log('=== Markle Bot starting up at', new Date().toISOString());

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const pingPongLeaderboard = new Map();

// ----------- POSTGRESQL SETUP -----------
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initLeaderboardTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leaderboard (
        userId TEXT PRIMARY KEY,
        score INTEGER NOT NULL
      )
    `);
}

async function loadLeaderboard() {
    pingPongLeaderboard.clear();
    const res = await pool.query('SELECT userId, score FROM leaderboard');
    res.rows.forEach(row => {
        pingPongLeaderboard.set(row.userId, row.score);
    });
    console.log(`[Leaderboard] Loaded ${pingPongLeaderboard.size} entries from database.`);
}

async function saveLeaderboard() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [userId, score] of pingPongLeaderboard.entries()) {
            // FIX: skip null/undefined userId to avoid DB errors
            if (!userId) {
                console.error('[Leaderboard] Skipping entry with null/undefined userId');
                continue;
            }
            await client.query(
                'INSERT INTO leaderboard (userId, score) VALUES ($1, $2) ON CONFLICT (userId) DO UPDATE SET score = EXCLUDED.score',
                [userId, score]
            );
        }
        await client.query('COMMIT');
        console.log(`[Leaderboard] Saved ${pingPongLeaderboard.size} entries to database.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error saving leaderboard:', err);
    } finally {
        client.release();
    }
}

// Save every 5 minutes
setInterval(() => saveLeaderboard(), 5 * 60 * 1000);

const saveOnExit = () => {
    console.log('[Leaderboard] Saving leaderboard before exit...');
    saveLeaderboard().finally(() => process.exit(0));
};
process.on('SIGINT', saveOnExit);
process.on('SIGTERM', saveOnExit);

if (!TOKEN) {
    console.error('❌ TOKEN (or DISCORD_TOKEN) is not set in environment variables');
    process.exit(1);
}

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
    '...': '...',
    'oleje': 'oleje'
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
            message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
            const prev = pingPongLeaderboard.get(userId) || 0;
            if (newExchanges > prev) {
                pingPongLeaderboard.set(userId, newExchanges);
                saveLeaderboard();
            }
        }

        // FIX: ONLY send ping/pong in startPingPongGame
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
    await channel.send(`<@${userId}> ${expectedWord}`);
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
// ... (rest of your code remains unchanged)
