//nts: copilot prompt
//you know that discord has these special commands <t:1750440945:F> like that to make the time accurate for everyone despite time zones, 
//can you make it so that when anyone says a time, like 9pm or like 9 pm, 
//markle will say a message in this format <t:1750440945:F> to make it accurate and clear for everyone

// =============================================================================
// DISCORD MODERATION BOT + GROQ AI INTEGRATION - MAIN CONFIGURATION
// =============================================================================

// ---- Imports and Setup ----
import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import axios from 'axios';
import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

dotenv.config();

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const pingPongLeaderboard = new Map(); // userId -> highest exchanges
const userTimezones = new Map();

if (!TOKEN) {
    console.error('❌ TOKEN (or DISCORD_TOKEN) is not set in environment variables');
    process.exit(1);
}
if (!GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY is not set in environment variables');
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

const GROQ_API_URL = 'https://api.groq.com/open/v1/chat/completions';
const userCooldowns = new Map();
const COOLDOWN_TIME = 5000;
const serverPersonalities = new Map();
const serverMessages = new Map();
const MAX_MESSAGES_PER_SERVER = 200;

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

function contnsBannedWord(content) {
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
// PING PONG GAME FUNCTIONS (ALTERNATING VERSION)
// =============================================================================

function handlePingPongResponse(message, content) {
    const userId = message.author.id;
    const lower = content.toLowerCase();
    const game = pingPongGames.get(userId);

    // If no game, start one: user can start with "ping" or "pong"
    if (!game) {
        if (lower === 'ping' || lower === 'pong') {
            const botWord = lower === 'ping' ? 'pong' : 'ping';
            message.channel.send(`<@${userId}> ${botWord}`);
            startPingPongGame(message.channel, userId, botWord, 1);
            return true;
        }
        return false;
    }

    // User must respond with the expected word
    if (lower === game.expectedWord) {
        clearTimeout(game.timeout);
        const newExchanges = game.exchanges + 1;
        const nextWord = game.expectedWord === 'ping' ? 'pong' : 'ping';

        if (newExchanges % PING_PONG_WIN_THRESHOLD === 0) {
            message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
            const prev = pingPongLeaderboard.get(userId) || 0;
            if (newExchanges > prev) {
                pingPongLeaderboard.set(userId, newExchanges);
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
            .setDescription('Show the top 10 longest ping pong streaks'),
        new SlashCommandBuilder()
            .setName('timezone')
            .setDescription('Set your timezone for accurate time conversion (e.g., America/New_York)')
            .addStringOption(opt =>
            opt.setName('zone')
                .setDescription('Your IANA timezone, e.g., America/New_York or Europe/Berlin')
                .setRequired(true)),
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
            if (top.length === 0) {
                await interaction.reply('No ping pong games played yet!');
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
                await interaction.deferReply();
                await interaction.editReply({
                    content: `🏓 **Ping Pong Leaderboard** 🏓\n${leaderboard.join('\n')}`
                });
            }
        }
        else if (interaction.commandName === 'timezone') {
            const zone = interaction.options.getString('zone');
            // Validate with luxon
            try {
                const { DateTime } = await import('luxon');
                if (!DateTime.local().setZone(zone).isValid) {
                    return interaction.reply({ content: "❌ Invalid timezone. Please use a valid IANA timezone like America/New_York.", ephemeral: true });
                }
                userTimezones.set(interaction.user.id, zone);
                await interaction.reply({ content: `✅ Your timezone has been set to **${zone}**!`, ephemeral: true });
            } catch (err) {
                await interaction.reply({ content: "❌ Error setting timezone.", ephemeral: true });
            }
        }
    } catch (error) {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ An error occurred while processing the command.', flags: MessageFlags.Ephemeral });
        }
    }
});

// =============================================================================
// AI INTEGRATION FUNCTIONS
// =============================================================================

/*function addServerMessage(guildId, message, username) {
    if (!serverMessages.has(guildId)) {
        serverMessages.set(guildId, []);
    }
    const messages = serverMessages.get(guildId);
    messages.push({ content: message, username: username, timestamp: Date.now() });
    if (messages.length > MAX_MESSAGES_PER_SERVER) {
        messages.shift();
    }
}

function analyzeServerPersonality(guildId) {
    const messages = serverMessages.get(guildId) || [];
    if (messages.length < 10) {
        return {
            tone: "casual and friendly",
            style: "conversational",
            examples: []
        };
    }
    const recentMessages = messages.slice(-50);
    const messageTexts = recentMessages.map(m => m.content);
    let casualCount = 0, formalCount = 0, emojiCount = 0, capsCount = 0, contractionCount = 0, slangCount = 0;
    const slangWords = ['lol', 'lmao', 'bruh', 'fr', 'ngl', 'tbh', 'smh', 'imo', 'rn', 'af', 'sus', 'cap', 'no cap', 'bet', 'fam', 'lowkey', 'highkey'];
    const casualWords = ['yeah', 'yep', 'nah', 'gonna', 'wanna', 'kinda', 'sorta'];
    messageTexts.forEach(msg => {
        const lower = msg.toLowerCase();
        if (/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u2600-\u26FF]|[\u2700-\u27BF]/u.test(msg)) emojiCount++;
        if (msg !== msg.toLowerCase() && msg.length > 3) capsCount++;
        if (/\b(don't|won't|can't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|wouldn't|couldn't|shouldn't|mustn't|needn't|daren't|mayn't|oughtn't|mightn't|'ll|'re|'ve|'d|'m|'s)\b/i.test(msg)) contractionCount++;
        slangWords.forEach(slang => { if (lower.includes(slang)) slangCount++; });
        casualWords.forEach(casual => { if (lower.includes(casual)) casualCount++; });
        if (/\b(however|therefore|furthermore|nevertheless|consequently|moreover|additionally)\b/i.test(msg)) formalCount++;
    });
    const totalMessages = messageTexts.length;
    const emojiRate = emojiCount / totalMessages;
    const slangRate = slangCount / totalMessages;
    const casualRate = casualCount / totalMessages;
    const contractionRate = contractionCount / totalMessages;
    let tone = "casual and friendly";
    let style = "conversational";
    if (slangRate > 0.3 || emojiRate > 0.4) {
        tone = "very casual and expressive";
        style = "informal with slang and emojis";
    } else if (casualRate > 0.2 && contractionRate > 0.3) {
        tone = "relaxed and conversational";
        style = "casual with contractions";
    } else if (formalCount > casualCount) {
        tone = "more formal and polite";
        style = "structured and proper";
    }
    return {
        tone: tone,
        style: style,
        examples: messageTexts.slice(-10),
        stats: {
            emojiRate: Math.round(emojiRate * 100),
            slangRate: Math.round(slangRate * 100),
            casualRate: Math.round(casualRate * 100),
            contractionRate: Math.round(contractionRate * 100)
        }
    };
}

async function callGroqAI(message, username, guildId) {
    try {
        const personality = guildId ? analyzeServerPersonality(guildId) : null;
        let systemPrompt = `You are a helpful AI assistant in a Discord server. Keep responses conversational, friendly, and under 2000 characters. The user's name is ${username}. Be engaging and helpful.`;
        if (personality) {
            systemPrompt += ` The server has a ${personality.tone} communication style that is ${personality.style}.`;
        }
        const requestData = {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message }
            ],
            model: 'llama3-8b-8192',
            temperature: 0.7,
            max_tokens: 500,
        };
        const response = await axios.post(
            GROQ_API_URL,
            requestData,
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        return 'Sorry, I encountered an error while processing your request. Please try again later.';
    }
}

function isOnCooldown(userId) {
    if (userCooldowns.has(userId)) {
        const expirationTime = userCooldowns.get(userId) + COOLDOWN_TIME;
        if (Date.now() < expirationTime) return true;
    }
    return false;
}
function setCooldown(userId) {
    userCooldowns.set(userId, Date.now());
}
*/
// =============================================================================
// MAIN MESSAGE PROCESSING LOGIC
// =============================================================================
client.on('messageCreate', async (message) => {
    // Ignore bot messages and DMs for moderation
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;

    const content = message.content.trim();
    
    // Get user's timezone or default to UTC
    const zone = userTimezones.get(userId) || 'UTC';
    
    // Parse times in the user's message
    const timeResults = chrono.parse(content, new Date(), { forwardDate: true });
    
    // Only trigger on explicit clock-like times (not "morning", "now", etc.)
    const explicitTimeRegex = /\b((1[0-2]|0?[1-9]):([0-5][0-9])\s?(am|pm)|([01]?[0-9]|2[0-3])(:[0-5][0-9])?\s?(am|pm)?|(noon|midnight))\b/i;
    if (explicitTimeRegex.test(content)) {
        const timeResults = chrono.parse(content, new Date(), { forwardDate: true });
        if (timeResults.length > 0) {
            const original = timeResults[0].start;
            let userTime = DateTime.fromObject({
                year: original.get('year'),
                month: original.get('month'),
                day: original.get('day'),
                hour: original.get('hour'),
                minute: original.get('minute') || 0,
                second: original.get('second') || 0,
            }, { zone });
    
            if (!userTime.isValid) {
                userTime = DateTime.fromJSDate(original.date()).setZone(zone, { keepLocalTime: true });
            }
    
            const unixTimestamp = Math.floor(userTime.toSeconds());
            const discordTimestamp = `<t:${unixTimestamp}:F>`;
            try {
                await message.reply(`You mentioned a time: ${discordTimestamp}`);
            } catch (e) {}
        }
    }

    if (containsBannedWord(content)) {
        safeDelete(message);
        try { await message.channel.send(`<@${userId}> nuh uh no no word`); } catch (error) { }
        return;
    }
    if (allowedUsers.has(userId)) {
        if (handlePingPongResponse(message, content)) return;
        const response = checkWordResponses(content);
        if (response) {
            try { await message.channel.send(response); } catch (error) { }
        }
        return;
    }
    if (sleepMutedUsers.has(userId)) {
        safeDelete(message);
        return;
    }
    if (!mutedUsers.has(userId)) {
        if (handlePingPongResponse(message, content)) return;
        const response = checkWordResponses(content);
        if (response) {
            try { await message.channel.send(response); } catch (error) { }
        }
        if (message.mentions.has(client.user)) {
            if (isOnCooldown(userId)) {
                message.reply(`⏰ Please wait a few seconds before asking another question.`);
                return;
            }
            setCooldown(userId);
            await message.channel.sendTyping();
            try {
                let cleanContent = message.content
                    .replace(/<@!?\d+>/g, '')
                    .replace(/<@&\d+>/g, '')
                    .replace(/<#\d+>/g, '')
                    .trim();
                if (!cleanContent) cleanContent = "Hello! How can I help you?";
                const groqResponse = await callGroqAI(
                    cleanContent,
                    message.author.displayName || message.author.username,
                    message.guild?.id || null
                );
                await message.reply(groqResponse);
            } catch (error) {
                await message.reply('❌ Sorry, I encountered an error while processing your request.');
            }
        }
        if (message.author.id !== client.user.id && message.guild) {
            if (!message.mentions.has(client.user) && message.content.length > 3) {
                addServerMessage(
                    message.guild.id,
                    message.content,
                    message.author.displayName || message.author.username
                );
            }
        }
        return;
    }

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
