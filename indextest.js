// =============================================================================
// DISCORD MODERATION BOT - MAIN CONFIGURATION
// =============================================================================
// This bot provides word filtering, counting challenges, ping-pong games,
// temporary free speech rewards, and productivity lock-in timer for Discord servers.

// Basic imports and setup (you won't need to change these)
import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

dotenv.config();

// =============================================================================
// CUSTOMIZABLE SETTINGS - MODIFY THESE TO FIT YOUR SERVER
// =============================================================================

// Words that will trigger automatic deletion and warnings
const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno', 'aoi'];
// Add or remove words as needed: ['word1', 'word2', 'word3']

// Timing settings (in milliseconds)
const FREE_SPEECH_DURATION = 30 * 1000;    // How long free speech lasts (30 seconds)
const DELETE_QUEUE_INTERVAL = 100;         // Delay between deletions (prevents rate limits)
const KEEP_ALIVE_INTERVAL = 60 * 1000;     // Keep-alive ping frequency (60 seconds)
const COUNTDOWN_INTERVAL = 5000;           // How often countdown updates (5 seconds)
const LOCK_IN_BREAK_DURATION = 5 * 60 * 1000; // 5 minutes break duration
const LOCK_IN_BREAK_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown between breaks

// Your test channel ID (where keep-alive messages are sent)
const TEST_CHANNEL_ID = '1382577291015749674';

// =============================================================================
// WORD RESPONSE SYSTEM - CUSTOMIZE YOUR BOT'S PERSONALITY
// =============================================================================
// When users type these words/phrases, bot responds automatically
// {!} = 3-15 random exclamation marks, {?} = 3-15 random question marks

const wordResponses = {
    'goodnight': 'gn{!}',
    'marco': 'polo',
    'what\'s up': 'the sky',
    'lelll😛': 'lelll😛', 'lelll 😛': 'lelll😛',
    'never back down never what': 'never give up{!}',
    'bot': 'is that a markle reference{?}',
    'markle u seeing this': 'yeah ts is crazy',  'markle r u seeing this': 'yeah ts is crazy',  'markle you seeing this': 'yeah ts is crazy',  'markle are you seeing this': 'yeah ts is crazy', 'markle are u seeing this': 'yeah ts is crazy', 'markle r you seeing this': 'yeah ts is crazy',
    'pls sleep': 'fr',
    'good morning': 'good morning{!}',
    'lelll🤑': 'get a load of this guy lmao', 'lelll 🤑': 'get a load of this guy lmao',
    // ADD YOUR CUSTOM RESPONSES HERE:
    // 'trigger phrase': 'bot response{!}',
    // 'hello': 'hi there{!}',
    // 'bye': 'see you later{!}',
};

// Multi-word combinations (triggers when BOTH words appear in message)
const multiWordResponses = new Map([
    [['markle', 'shut up'], 'fuck you'],
    [['markle', 'fuck you'], 'fuck you too'],
    [['talk', 'to you'], 'oh sorry'],
    
    // ADD YOUR MULTI-WORD TRIGGERS HERE:
    // [['word1', 'word2'], 'response when both words are present'],
    // [['good', 'morning'], 'good morning to you too{!}'],
]);

// =============================================================================
// USER PERMISSIONS - SET WHO CAN DO WHAT
// =============================================================================
// Users who bypass all muting/challenges (get these from your .env file)
const allowedUsers = new Set(
    process.env.ALLOWED_USERS?.split(',').map(id => id.trim()).filter(Boolean) || []
);

// Users who can use slash commands (/mute, /unmute, /status)
const allowedSlashCommandUsers = new Set(
    process.env.SLASH_COMMAND_USERS?.split(',').map(id => id.trim()).filter(Boolean) || []
);

// =============================================================================
// PING-PONG GAME SETTINGS
// =============================================================================
const INITIAL_PING_PONG_TIME = 5000;       // Starting time limit (5 seconds)
const TIME_REDUCTION_RATE = 0.1;           // Gets 10% faster each round
const PING_PONG_WIN_THRESHOLD = 10;        // Win after 10 successful exchanges

// =============================================================================
// BOT INITIALIZATION (Don't modify unless you know what you're doing)
// =============================================================================
const app = express();
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 Web server running`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel]
});

// =============================================================================
// DATA STORAGE (Bot memory - resets when bot restarts)
// =============================================================================
const activeChallenges = new Map();    // userId -> challenge info
const freeSpeechTimers = new Map();     // userId -> timer start time
const deleteQueue = [];                 // Queue of messages to delete
const muteTimeouts = new Map();         // userId -> timeout for auto-unmute
const countdownIntervals = new Map();   // userId -> countdown interval
const mutedUsers = new Set();           // Set of currently muted users
const pingPongGames = new Map();        // userId -> ping-pong game state
const lockInSessions = new Map();       // userId -> lock-in session data
const lockInBreaks = new Map();         // userId -> break state data

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Safely deletes a message
 */
function safeDelete(message) {
    deleteQueue.push(async () => {
        try {
            if (message.deletable) {
                await message.delete();
            }
        } catch (error) {
            if (error.code !== 10008) { // Unknown Message error
                console.error('Delete failed:', error.message);
            }
        }
    });
}

/**
 * Clears all user state (challenges, timers, games)
 */
function clearUserState(userId) {
    activeChallenges.delete(userId);
    mutedUsers.delete(userId);
    freeSpeechTimers.delete(userId);
    
    // Clear ping-pong game
    const game = pingPongGames.get(userId);
    if (game?.timeout) clearTimeout(game.timeout);
    pingPongGames.delete(userId);
    
    // Clear mute timeout
    const muteTimeout = muteTimeouts.get(userId);
    if (muteTimeout) {
        clearTimeout(muteTimeout);
        muteTimeouts.delete(userId);
    }
    
    // Clear countdown interval
    const countdownInterval = countdownIntervals.get(userId);
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownIntervals.delete(userId);
    }
}

/**
 * Clears lock-in session data for a user
 */
function clearLockInState(userId) {
    const session = lockInSessions.get(userId);
    if (session) {
        if (session.breakTimer) clearTimeout(session.breakTimer);
        if (session.breakCooldownTimer) clearTimeout(session.breakCooldownTimer);
        lockInSessions.delete(userId);
    }
    lockInBreaks.delete(userId);
}

/**
 * Creates a string of repeated exclamation marks
 */
function generateExclamations(count) {
    return '!'.repeat(count);
}

/**
 * Checks if message contains any banned words
 */
function containsBannedWord(content) {
    const lower = content.toLowerCase();
    return bannedWords.some(word => lower.includes(word));
}

/**
 * Replaces {!} and {?} with random amounts of punctuation
 * {!} becomes 3-15 exclamation marks, {?} becomes 3-15 question marks
 */
function processRandomPunctuation(text) {
    // Replace {!} with 3-15 exclamation marks
    text = text.replace(/\{!\}/g, () => {
        const count = Math.floor(Math.random() * 13) + 3;
        return '!'.repeat(count);
    });
    
    // Replace {?} with 3-15 question marks
    text = text.replace(/\{\?\}/g, () => {
        const count = Math.floor(Math.random() * 13) + 3;
        return '?'.repeat(count);
    });
    
    return text;
}

/**
 * Checks if message should trigger an automatic response
 * Returns the response text or null if no match
 */
function checkWordResponses(content) {
    const lower = content.toLowerCase();
    const originalMessage = content.trim(); // Keep original for exact matching

    if (/^markle$/i.test(originalMessage)) {
        return 'wsg';
    }

    // SPECIAL CASE: Message contains "gn" as a separate word (not part of another word)
    if (/\bgn\b/i.test(originalMessage)) {
        return processRandomPunctuation('gn{!}');
    }

    if (/\bcya\b/i.test(originalMessage)) {
        return processRandomPunctuation('cya{!}');
    }

    // Check for exact phrase matches first (highest priority)
    if (wordResponses[lower]) {
        return processRandomPunctuation(wordResponses[lower]);
    }
    
    // Check multi-word combinations (both words must be present)
    for (const [wordPair, response] of multiWordResponses) {
        const [word1, word2] = wordPair;
        if (lower.includes(word1.toLowerCase()) && lower.includes(word2.toLowerCase())) {
            return processRandomPunctuation(response);
        }
    }
    
    // Check for EXACT WORD matches only (prevents "humping" triggering "ping")
    const words = lower.split(/\s+/); // Split message into individual words
    const matchedResponses = [];
    
    for (const [trigger, response] of Object.entries(wordResponses)) {
        // Check if any word in the message exactly matches the trigger
        if (words.includes(trigger.toLowerCase())) {
            matchedResponses.push(processRandomPunctuation(response));
        }
    }
    
    // Handle multiple matches
    if (matchedResponses.length > 1) {
        return matchedResponses.join(' '); // Combine all responses
    }
    
    if (matchedResponses.length === 1) {
        return matchedResponses[0];
    }
    
    return null; // No matching response
}

/**
 * Handles ping-pong game logic
 * Returns true if message was part of ping-pong game, false otherwise
 */
function handlePingPongResponse(message, content) {
    const userId = message.author.id;
    const lower = content.toLowerCase();
    const game = pingPongGames.get(userId);
    
    // Handle "ping" messages
    if (lower === 'ping') {
        if (game && game.expectingResponse) {
            // User responded in time! Continue game
            clearTimeout(game.timeout);
            
            // Increment exchanges since user successfully responded
            const newExchanges = game.exchanges + 1;
            
            // Check for victory
            if (newExchanges >= PING_PONG_WIN_THRESHOLD) {
                message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
                console.log(`🏆 User ${userId} WON ping-pong game with ${newExchanges} exchanges!`);
                pingPongGames.delete(userId);
                return true;
            }
            
            // Continue game - bot responds with "pong" and waits for user's "pong"
            message.channel.send('pong');
            startPingPongGame(message.channel, userId, false, newExchanges);
            // Set expectingResponse to false because now we expect user to say "pong"
            pingPongGames.get(userId).expectingResponse = false;
            return true;
        } else if (!game) {
            // Start new game - bot responds with "pong" and waits for user's "pong"
            message.channel.send('pong');
            startPingPongGame(message.channel, userId, false, 1);
            pingPongGames.get(userId).expectingResponse = false;
            return true;
        }
    }
    
    // Handle "pong" messages
    if (lower === 'pong') {
        if (game && !game.expectingResponse) {
            // User responded in time! Continue game
            clearTimeout(game.timeout);
            
            // Increment exchanges since user successfully responded
            const newExchanges = game.exchanges + 1;
            
            // Check for victory
            if (newExchanges >= PING_PONG_WIN_THRESHOLD) {
                message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${newExchanges} exchanges)`);
                console.log(`🏆 User ${userId} WON ping-pong game with ${newExchanges} exchanges!`);
                pingPongGames.delete(userId);
                return true;
            }
            
            // Continue game - bot responds with "ping" and waits for user's "ping"
            message.channel.send('ping');
            startPingPongGame(message.channel, userId, false, newExchanges);
            // Set expectingResponse to true because now we expect user to say "ping"
            pingPongGames.get(userId).expectingResponse = true;
            return true;
        }
    }
    
    return false; // Not handled as ping-pong
}

/**
 * Starts or continues a ping-pong game
 * Game gets faster each round, user wins after PING_PONG_WIN_THRESHOLD exchanges
 */
async function startPingPongGame(channel, userId, isInitialPing = true, exchanges = 0) {
    // Clear existing game timeout if any
    if (pingPongGames.has(userId)) {
        const existingGame = pingPongGames.get(userId);
        if (existingGame.timeout) clearTimeout(existingGame.timeout);
    }
    
    // Calculate time limit (gets faster each round)
    const timeLimit = isInitialPing ? INITIAL_PING_PONG_TIME : 
                     Math.max(1000, INITIAL_PING_PONG_TIME * Math.pow(1 - TIME_REDUCTION_RATE, exchanges));
    
    // Set timeout for losing
    const timeout = setTimeout(async () => {
        try {
            await channel.send(`<@${userId}> haha you lose (${exchanges} exchanges)`);
            console.log(`🏓 User ${userId} lost ping-pong game after ${exchanges} exchanges`);
            pingPongGames.delete(userId);
        } catch (error) {
            console.error('Failed to send ping-pong loss message:', error.message);
        }
    }, timeLimit);

    // Store game state
    pingPongGames.set(userId, {
        timeLimit,
        exchanges,
        timeout,
        expectingResponse: isInitialPing // For initial ping, we expect response
    });

    console.log(`🏓 User ${userId} ping-pong game - Exchange: ${exchanges}/${PING_PONG_WIN_THRESHOLD}, Time: ${(timeLimit/1000).toFixed(1)}s`);
}

/**
 * Sends a counting challenge to a user
 * User must count the exclamation marks to get unmuted
 */
async function sendChallenge(channel, userId, intro = true) {
    try {
        // Generate 10-30 exclamation marks
        const count = Math.floor(Math.random() * 21) + 10;
        const exclamations = generateExclamations(count);

        // Send intro message if requested
        if (intro) {
            await channel.send(`hey <@${userId}> how many`);
        }
        
        // Send the challenge
        await channel.send(`<@${userId}> count${exclamations}`);

        // Store challenge data
        activeChallenges.set(userId, { 
            state: 'waiting',
            answer: count,
            timestamp: Date.now()
        });
        
        // Mark user as muted
        mutedUsers.add(userId);
        
        console.log(`🎯 User ${userId} got challenged, answer is ${count}`);
    } catch (error) {
        console.error('Failed to send challenge:', error.message);
    }
}

/**
 * Starts the free speech countdown timer
 * User can speak freely for FREE_SPEECH_DURATION milliseconds
 */
async function startFreeSpeechCountdown(channel, userId) {
    const startTime = Date.now();
    freeSpeechTimers.set(userId, startTime);
    
    console.log(`🗣️ User ${userId} granted free speech for ${FREE_SPEECH_DURATION / 1000}s`);
    
    // Countdown interval
    const interval = setInterval(async () => {
        try {
            const elapsed = Date.now() - startTime;
            const remaining = Math.ceil((FREE_SPEECH_DURATION - elapsed) / 1000);

            if (remaining > 0) {
                // Send countdown number
                const msg = await channel.send(`${remaining}`);
                setTimeout(() => safeDelete(msg), 3000); // Auto-delete after 3 seconds
            } else {
                // Time's up!
                await channel.send(`<@${userId}> no more free speech`);
                console.log(`⏰ User ${userId} free speech expired`);
                
                // Cleanup
                freeSpeechTimers.delete(userId);
                countdownIntervals.delete(userId);
                clearInterval(interval);
            }
        } catch (error) {
            console.error('Countdown error:', error.message);
            clearInterval(interval);
            countdownIntervals.delete(userId);
        }
    }, COUNTDOWN_INTERVAL);
    
    countdownIntervals.set(userId, interval);
}

/**
 * Starts a lock-in session for a user
 */
async function startLockInSession(channel, userId) {
    // Clear any existing session
    clearLockInState(userId);
    
    // Create lock-in session
    lockInSessions.set(userId, {
        startTime: Date.now(),
        onBreak: false,
        canTakeBreak: true,
        lastBreakTime: null,
        breakTimer: null,
        breakCooldownTimer: null
    });
    
    // Mute the user with exclamation marks challenge
    mutedUsers.add(userId);
    await sendChallenge(channel, userId, true);
    
    console.log(`🔒 User ${userId} started lock-in session`);
    await channel.send(`<@${userId}> lock-in session started! you are now muted. focus mode activated 🔥`);
}

/**
 * Ends a lock-in session for a user
 */
async function endLockInSession(channel, userId) {
    const session = lockInSessions.get(userId);
    if (!session) return false;
    
    const duration = Math.floor((Date.now() - session.startTime) / 60000); // minutes
    
    // Clear all states
    clearLockInState(userId);
    clearUserState(userId);
    
    console.log(`🔓 User ${userId} ended lock-in session after ${duration} minutes`);
    await channel.send(`<@${userId}> lock-in session ended! you were locked in for ${duration} minutes. great work! 💪`);
    
    return true;
}

/**
 * Sends break offer to user during lock-in
 */
async function sendBreakOffer(channel, userId) {
    const session = lockInSessions.get(userId);
    if (!session || !session.canTakeBreak) return;
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`break_yes_${userId}`)
                .setLabel('yeah')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`break_no_${userId}`)
                .setLabel('nah')
                .setStyle(ButtonStyle.Danger)
        );
    
    try {
        await channel.send({
            content: `<@${userId}> do you want to take a break for 5 mins (you cannot take another break for 5 mins after this break)`,
            components: [row]
        });
    } catch (error) {
        console.error('Failed to send break offer:', error.message);
    }
}

/**
 * Starts a break for a user during lock-in
 */
async function startLockInBreak(channel, userId) {
    const session = lockInSessions.get(userId);
    if (!session) return;
    
    // Update session state
    session.onBreak = true;
    session.canTakeBreak = false;
    session.lastBreakTime = Date.now();
    
    // Unmute user temporarily
    mutedUsers.delete(userId);
    clearUserState(userId);
    
    console.log(`☕ User ${userId} started lock-in break`);
    await channel.send(`<@${userId}> break time! you have 5 minutes to chill 😎`);
    
    // Set timer to end break
    session.breakTimer = setTimeout(async () => {
        await endLockInBreak(channel, userId);
    }, LOCK_IN_BREAK_DURATION);
    
    // Set cooldown timer
    session.breakCooldownTimer = setTimeout(() => {
        const currentSession = lockInSessions.get(userId);
        if (currentSession && !currentSession.onBreak) {
            currentSession.canTakeBreak = true;
            console.log(`⏰ User ${userId} can take break again`);
        }
    }, LOCK_IN_BREAK_COOLDOWN);
}

/**
 * Ends a break during lock-in session
 */
async function endLockInBreak(channel, userId) {
    const session = lockInSessions.get(userId);
    if (!session || !session.onBreak) return;
    
    // Update session state
    session.onBreak = false;
    
    // Mute user again
    mutedUsers.add(userId);
    await sendChallenge(channel, userId, true);
    
    console.log(`🔒 User ${userId} break ended, back to lock-in`);
    await channel.send(`<@${userId}> break's over! back to work 💪 (can't take another break for 5 more minutes)`);
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
            if (error.code !== 10008) {
                console.error('Queue delete failed:', error.message);
            }
        }
    }
}, DELETE_QUEUE_INTERVAL);

// =============================================================================
// BOT STARTUP AND SLASH COMMANDS
// =============================================================================
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    
    // Keep-alive mechanism for hosting services
    setInterval(async () => {
        try {
            const channel = await client.channels.fetch(TEST_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.isTextBased()) return;
            
            const msg = await channel.send('✅ Still alive');
            setTimeout(() => safeDelete(msg), 5000);
        } catch (error) {
            console.error('Keep-alive failed:', error.message);
        }
    }, KEEP_ALIVE_INTERVAL);

    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('mute')
            .setDescription('Start a counting challenge for a user')
            .addUserOption(opt => opt.setName('user').setDescription('User to challenge').setRequired(true))
            .addIntegerOption(opt => opt.setName('duration').setDescription('Mute duration in seconds (default: 30)').setRequired(false).setMinValue(10).setMaxValue(3600)),
        new SlashCommandBuilder()
            .setName('unmute')
            .setDescription('Cancel a user\'s challenge')
            .addUserOption(opt => opt.setName('user').setDescription('User to release').setRequired(true)),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Show bot status and active challenges'),
        new SlashCommandBuilder()
            .setName('lock-in')
            .setDescription('Start or end a productivity lock-in session')
            .addStringOption(opt => 
                opt.setName('action')
                   .setDescription('Action to perform')
                   .setRequired(false)
                   .addChoices(
                       { name: 'Start', value: 'start' },
                       { name: 'End', value: 'end' }
                   ))
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    
    try {
        const app = await rest.get(Routes.oauth2CurrentApplication());
        await rest.put(Routes.applicationCommands(app.id), { body: commands });
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
        if (interaction.commandName === 'mute') {
            // Permission check
            if (!allowedSlashCommandUsers.has(interaction.user.id)) {
                return interaction.reply({ 
                    content: '❌ You are not authorized to use this command.', 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const user = interaction.options.getUser('user');
            const duration = interaction.options.getInteger('duration') || 30;
            const channel = interaction.channel;

            clearUserState(user.id);
            await sendChallenge(channel, user.id);

            // Auto-unmute after duration
            const timeout = setTimeout(() => {
                clearUserState(user.id);
                channel.send(`<@${user.id}> has been automatically unmuted (time expired).`);
            }, duration * 1000);

            muteTimeouts.set(user.id, timeout);
            await interaction.reply({ 
                content: `✅ Challenge started for <@${user.id}> (Duration: ${duration}s)`, 
                flags: MessageFlags.Ephemeral 
            });

        } else if (interaction.commandName === 'unmute') {
            // Permission check
            if (!allowedSlashCommandUsers.has(interaction.user.id)) {
                return interaction.reply({ 
                    content: '❌ You are not authorized to use this command.', 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const user = interaction.options.getUser('user');
            clearUserState(user.id);
            await interaction.reply({ 
                content: `✅ Challenge cleared for <@${user.id}>`, 
                flags: MessageFlags.Ephemeral 
            });

        } else if (interaction.commandName === 'status') {
            // Permission check
            if (!allowedSlashCommandUsers.has(interaction.user.id)) {
                return interaction.reply({ 
                    content: '❌ You are not authorized to use this command.', 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const embed = new EmbedBuilder()
                .setTitle('🤖 Bot Status')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Active Challenges', value: activeChallenges.size.toString(), inline: true },
                    { name: 'Muted Users', value: mutedUsers.size.toString(), inline: true },
                    { name: 'Free Speech Timers', value: freeSpeechTimers.size.toString(), inline: true },
                    { name: 'Ping-Pong Games', value: pingPongGames.size.toString(), inline: true },
                    { name: 'Lock-In Sessions', value: lockInSessions.size.toString(), inline: true },
                    { name: 'Delete Queue', value: deleteQueue.length.toString(), inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

        } else if (interaction.commandName === 'lock-in') {
            const action = interaction.options.getString('action');
            const userId = interaction.user.id;
            const channel = interaction.channel;

            if (action === 'end') {
                // End existing session
                const ended = await endLockInSession(channel, userId);
                if (ended) {
                    await interaction.reply({ 
                        content: '✅ Lock-in session ended!', 
                        flags: MessageFlags.Ephemeral 
                    });
                } else {
                    await interaction.reply({ 
                        content: '❌ You don\'t have an active lock-in session.', 
                        flags: MessageFlags.Ephemeral 
                    });
                }
                return;
            }

            // Check if user already has an active session
            if (lockInSessions.has(userId)) {
                await interaction.reply({ 
                    content: '❌ You already have an active lock-in session! Use `/lock-in action:End` to end it.', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Show confirmation prompt
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`lockin_yes_${userId}`)
                        .setLabel('yeah')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`lockin_no_${userId}`)
                        .setLabel('nah')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.reply({
                content: 'do u wanna lock in rn',
                components: [row],
                flags
