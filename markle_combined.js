// =============================================================================
// DISCORD MODERATION BOT - MAIN CONFIGURATION
// =============================================================================
// This bot provides word filtering, counting challenges, ping-pong games,
// and temporary free speech rewards for Discord servers.

// Basic imports and setup (you won't need to change these)
import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

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
const TEMP_UNMUTE_DURATION = 15 * 60 * 1000; // Temporary unmute duration (15 minutes)

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

// Users who can use slash commands (/mute, /unmute, /status, /sleep)
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
const sleepMutedUsers = new Set();      // Set of users muted with /sleep command
const tempUnmuteTimeouts = new Map();   // userId -> timeout for temporary unmute

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
    sleepMutedUsers.delete(userId);
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
    
    // Clear temporary unmute timeout
    const tempUnmuteTimeout = tempUnmuteTimeouts.get(userId);
    if (tempUnmuteTimeout) {
        clearTimeout(tempUnmuteTimeout);
        tempUnmuteTimeouts.delete(userId);
    }
    
    // Clear countdown interval
    const countdownInterval = countdownIntervals.get(userId);
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownIntervals.delete(userId);
    }
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
            .setDescription('Cancel a user\'s challenge or sleep mute')
            .addUserOption(opt => opt.setName('user').setDescription('User to release').setRequired(true))
            .addBooleanOption(opt => opt.setName('temporary').setDescription('Temporary unmute for 15 minutes (default: false)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('sleep')
            .setDescription('Put a user to sleep - complete silence with no way to speak')
            .addUserOption(opt => opt.setName('user').setDescription('User to put to sleep').setRequired(true)),
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Show bot status and active challenges')
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

    // Permission check
    if (!allowedSlashCommandUsers.has(interaction.user.id)) {
        return interaction.reply({ 
            content: '❌ You are not authorized to use this command.', 
            flags: MessageFlags.Ephemeral 
        });
    }

    try {
        if (interaction.commandName === 'mute') {
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

        } else if (interaction.commandName === 'sleep') {
            const user = interaction.options.getUser('user');
            const channel = interaction.channel;

            // Clear any existing state and add to sleep mute
            clearUserState(user.id);
            sleepMutedUsers.add(user.id);

            await channel.send(`go to sleep <@${user.id}>`);
            await interaction.reply({ 
                content: `😴 <@${user.id}> has been put to sleep (permanent mute until manually unmuted)`, 
                flags: MessageFlags.Ephemeral 
            });

            console.log(`😴 User ${user.id} put to sleep by ${interaction.user.username}`);

        } else if (interaction.commandName === 'unmute') {
            const user = interaction.options.getUser('user');
            const temporary = interaction.options.getBoolean('temporary') || false;
            const channel = interaction.channel;

            if (temporary && sleepMutedUsers.has(user.id)) {
                // Temporary unmute for sleep-muted users
                sleepMutedUsers.delete(user.id);
                
                // Set timeout to re-apply sleep mute after 15 minutes
                const timeout = setTimeout(() => {
                    sleepMutedUsers.add(user.id);
                    channel.send(`<@${user.id}> temporary unmute expired - go back to sleep`);
                    console.log(`😴 User ${user.id} temporary unmute expired - back to sleep`);
                }, TEMP_UNMUTE_DURATION);

                tempUnmuteTimeouts.set(user.id, timeout);
                
                await interaction.reply({ 
                    content: `⏰ <@${user.id}> temporarily unmuted for 15 minutes`, 
                    flags: MessageFlags.Ephemeral 
                });
                
                console.log(`⏰ User ${user.id} temporarily unmuted for 15 minutes`);
            } else {
                // Permanent unmute
                clearUserState(user.id);
                await interaction.reply({ 
                    content: `✅ <@${user.id}> has been completely unmuted`, 
                    flags: MessageFlags.Ephemeral 
                });
                
                console.log(`✅ User ${user.id} permanently unmuted by ${interaction.user.username}`);
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
        }
    } catch (error) {
        console.error('Interaction error:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ An error occurred while processing the command.', flags: MessageFlags.Ephemeral });
        }
    }
});

// =============================================================================
// MAIN MESSAGE PROCESSING LOGIC
// =============================================================================
client.on('messageCreate', async (message) => {
    // Ignore bot messages and DMs
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const content = message.content.trim();

    console.log(`📝 Message from @${message.author.username} (${userId}): "${content}"`);

    // STEP 1: Check for banned words (applies to ALL users)
    if (containsBannedWord(content)) {
        safeDelete(message);
        console.log(`🚫 User @${message.author.username} (${userId}) used banned word`);
        
        try {
            await message.channel.send(`<@${userId}> nuh uh no no word`);
        } catch (error) {
            console.error('Failed to send banned word warning:', error.message);
        }
        return; // Stop processing this message
    }

    // STEP 2: Handle allowed users (they can speak freely after banned word check)
    if (allowedUsers.has(userId)) {
        // Check ping-pong game even for allowed users
        if (handlePingPongResponse(message, content)) {
            return;
        }
        
        // Check word responses for allowed users
        const response = checkWordResponses(content);
        if (response) {
            try {
                await message.channel.send(response);
                console.log(`🤖 Bot responded to @${message.author.username} with: "${response}"`);
            } catch (error) {
                console.error('Failed to send word response:', error.message);
            }
        }
        return; // Don't interfere with allowed users
    }

    // STEP 3: Handle sleep-muted users (complete silence)
    if (sleepMutedUsers.has(userId)) {
        safeDelete(message);
        console.log(`😴 Sleep-muted user @${message.author.username} (${userId}) message deleted`);
        return; // No way to speak at all when sleep-muted
    }

    // STEP 4: Handle non-muted users
    if (!mutedUsers.has(userId)) {
        // Check ping-pong game
        if (handlePingPongResponse(message, content)) {
            return;
        }
        
        // Check word responses
        const response = checkWordResponses(content);
        if (response) {
            try {
                await message.channel.send(response);
                console.log(`🤖 Bot responded to @${message.author.username} with: "${response}"`);
            } catch (error) {
                console.error('Failed to send word response:', error.message);
            }
        }
        return; // User is not muted, let them speak freely
    }

    // STEP 5: Handle muted users (regular mute with challenges)
    const challenge = activeChallenges.get(userId);
    const freeSpeechTimer = freeSpeechTimers.get(userId);

    // User has active free speech - don't interfere
    if (freeSpeechTimer) return;

    // Handle solved challenge state
    if (challenge?.state === 'solved') {
        // 20% chance to grant free speech
        if (Math.random() < 0.2) {
            await startFreeSpeechCountdown(message.channel, userId);
            await message.channel.send(`<@${userId}> congrats u now have temporary free speech`);
        } else {
            console.log(`🎲 User @${message.author.username} (${userId}) didn't get free speech (20% chance failed)`);
        }
        activeChallenges.delete(userId);
        return;
    }

    // Delete messages from muted users (except during free speech)
    safeDelete(message);

    // Handle challenge response
    if (challenge?.state === 'waiting') {
        const guess = parseInt(content, 10);
        
        if (!isNaN(guess) && guess === challenge.answer) {
            console.log(`✅ User @${message.author.username} (${userId}) solved challenge correctly! (Answer: ${challenge.answer})`);
            await message.channel.send(`<@${userId}> good boy`);
            activeChallenges.set(userId, { state: 'solved' });
        } else {
            console.log(`❌ User @${message.author.username} (${userId}) guessed wrong: ${guess} (Correct: ${challenge.answer})`);
            await message.channel.send(`<@${userId}> nuh uh, try again`);
            await sendChallenge(message.channel, userId, false);
        }
        return;
    }

    // If muted user has no active challenge, start one
    await sendChallenge(message.channel, userId, true);
});

// =============================================================================
// ERROR HANDLING AND STARTUP
// =============================================================================
client.on('error', error => console.error('Discord client error:', error));
client.on('warn', warning => console.warn('Discord client warning:', warning));

process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

// Start the bot
client.login(process.env.TOKEN).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});

console.log('🤖 Bot is starting...');

//================================================================================
// AI INTEGRATION SECTION (Merged from markleai.js)
//================================================================================

require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

console.log('🚀 Starting Discord bot...');
console.log('📋 Loading environment variables...');

// Express server for keep-alive
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

// Discord client setup
console.log('🔧 Setting up Discord client...');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Groq API configuration
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Rate limiting map to prevent spam
const userCooldowns = new Map();
const COOLDOWN_TIME = 5000; // 5 seconds

// Server personality analysis storage
const serverPersonalities = new Map();
const serverMessages = new Map();
const MAX_MESSAGES_PER_SERVER = 200; // Store last 200 messages per server

// Function to add message to server training data
function addServerMessage(guildId, message, username) {
    if (!serverMessages.has(guildId)) {
        serverMessages.set(guildId, []);
        console.log(`📊 Initialized message storage for server: ${guildId}`);
    }
    
    const messages = serverMessages.get(guildId);
    messages.push({
        content: message,
        username: username,
        timestamp: Date.now()
    });
    
    console.log(`💬 Stored message from ${username} in server ${guildId} (${messages.length}/${MAX_MESSAGES_PER_SERVER})`);
    
    // Keep only recent messages
    if (messages.length > MAX_MESSAGES_PER_SERVER) {
        messages.shift();
        console.log(`🗑️ Removed oldest message from server ${guildId} storage`);
    }
}

// Function to analyze server personality
function analyzeServerPersonality(guildId) {
    console.log(`🧠 Analyzing personality for server: ${guildId}`);
    
    const messages = serverMessages.get(guildId) || [];
    if (messages.length < 10) {
        console.log(`⚠️ Not enough messages for analysis (${messages.length}/10) - using default personality`);
        return {
            tone: "casual and friendly",
            style: "conversational",
            examples: []
        };
    }
    
    // Analyze recent messages for patterns
    const recentMessages = messages.slice(-50);
    const messageTexts = recentMessages.map(m => m.content);
    
    console.log(`📈 Analyzing ${messageTexts.length} recent messages for patterns...`);
    
    // Count patterns
    let casualCount = 0;
    let formalCount = 0;
    let emojiCount = 0;
    let capsCount = 0;
    let contractionCount = 0;
    let slangCount = 0;
    
    const slangWords = ['lol', 'lmao', 'bruh', 'fr', 'ngl', 'tbh', 'smh', 'imo', 'rn', 'af', 'sus', 'cap', 'no cap', 'bet', 'fam', 'lowkey', 'highkey'];
    const casualWords = ['yeah', 'yep', 'nah', 'gonna', 'wanna', 'kinda', 'sorta'];
    
    messageTexts.forEach(msg => {
        const lower = msg.toLowerCase();
        
        // Check for emojis
        if (/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u.test(msg)) {
            emojiCount++;
        }
        
        // Check for caps
        if (msg !== msg.toLowerCase() && msg.length > 3) {
            capsCount++;
        }
        
        // Check for contractions
        if (/\b(don't|won't|can't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|wouldn't|couldn't|shouldn't|mustn't|needn't|daren't|mayn't|oughtn't|mightn't|'ll|'re|'ve|'d|'m|'s)\b/i.test(msg)) {
            contractionCount++;
        }
        
        // Check for slang
        slangWords.forEach(slang => {
            if (lower.includes(slang)) {
                slangCount++;
            }
        });
        
        // Check for casual words
        casualWords.forEach(casual => {
            if (lower.includes(casual)) {
                casualCount++;
            }
        });
        
        // Check for formal indicators
        if (/\b(however|therefore|furthermore|nevertheless|consequently|moreover|additionally)\b/i.test(msg)) {
            formalCount++;
        }
    });
    
    // Determine personality
    const totalMessages = messageTexts.length;
    const emojiRate = emojiCount / totalMessages;
    const slangRate = slangCount / totalMessages;
    const casualRate = casualCount / totalMessages;
    const contractionRate = contractionCount / totalMessages;
    
    console.log(`📊 Analysis results:
    - Emoji rate: ${Math.round(emojiRate * 100)}%
    - Slang rate: ${Math.round(slangRate * 100)}%
    - Casual rate: ${Math.round(casualRate * 100)}%
    - Contraction rate: ${Math.round(contractionRate * 100)}%`);
    
    let tone = "casual and friendly";
    let style = "conversational";
    
    if (slangRate > 0.3 || emojiRate > 0.4) {
        tone = "very casual and expressive";
        style = "informal with slang and emojis";
        console.log(`🎭 Server personality: Very casual and expressive`);
    } else if (casualRate > 0.2 && contractionRate > 0.3) {
        tone = "relaxed and conversational";
        style = "casual with contractions";
        console.log(`🎭 Server personality: Relaxed and conversational`);
    } else if (formalCount > casualCount) {
        tone = "more formal and polite";
        style = "structured and proper";
        console.log(`🎭 Server personality: Formal and polite`);
    } else {
        console.log(`🎭 Server personality: Default casual and friendly`);
    }
    
    return {
        tone: tone,
        style: style,
        examples: messageTexts.slice(-10), // Last 10 messages as examples
        stats: {
            emojiRate: Math.round(emojiRate * 100),
            slangRate: Math.round(slangRate * 100),
            casualRate: Math.round(casualRate * 100),
            contractionRate: Math.round(contractionRate * 100)
        }
    };
}

async function callGroqAI(message, username, guildId) {
    console.log(`🤖 Calling Groq AI for user: ${username}`);
    console.log(`📝 Message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);
    
    try {
        const personality = guildId ? analyzeServerPersonality(guildId) : null;
        let systemPrompt = `You are a helpful AI assistant in a Discord server. Keep responses conversational, friendly, and under 2000 characters. The user's name is ${username}. Be engaging and match the tone of the conversation.`;
        
        if (personality) {
            systemPrompt += ` The server has a ${personality.tone} communication style that is ${personality.style}.`;
            console.log(`🎨 Using server personality: ${personality.tone}`);
        }
        
        const requestData = {
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: message
                }
            ],
            model: 'llama3-8b-8192',
            temperature: 0.7,
            max_tokens: 500,
        };
        
        console.log(`📤 Sending request to Groq API...`);
        const startTime = Date.now();
        
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

        const responseTime = Date.now() - startTime;
        const aiResponse = response.data.choices[0].message.content;
        
        console.log(`✅ Groq API response received in ${responseTime}ms`);
        console.log(`📋 Response: "${aiResponse.substring(0, 150)}${aiResponse.length > 150 ? '...' : ''}"`);
        console.log(`📊 Token usage - Prompt: ${response.data.usage?.prompt_tokens || 'N/A'}, Completion: ${response.data.usage?.completion_tokens || 'N/A'}`);
        
        return aiResponse;
    } catch (error) {
        console.error('❌ Error calling Groq AI:', error.response?.data || error.message);
        if (error.response?.status) {
            console.error(`📊 HTTP Status: ${error.response.status}`);
        }
        return 'Sorry, I encountered an error while processing your request. Please try again later.';
    }
}

// Function to check if user is on cooldown
function isOnCooldown(userId) {
    if (userCooldowns.has(userId)) {
        const expirationTime = userCooldowns.get(userId) + COOLDOWN_TIME;
        if (Date.now() < expirationTime) {
            const remainingTime = Math.ceil((expirationTime - Date.now()) / 1000);
            console.log(`⏰ User ${userId} is on cooldown for ${remainingTime} more seconds`);
            return true;
        }
    }
    return false;
}

// Function to set user cooldown
function setCooldown(userId) {
    userCooldowns.set(userId, Date.now());
    console.log(`⏰ Set cooldown for user: ${userId}`);
}

// Bot ready event
client.once('ready', () => {
    console.log(`\n🎉 SUCCESS! Bot is now online!`);
    console.log(`🤖 Bot: ${client.user.tag}`);
    console.log(`🆔 Bot ID: ${client.user.id}`);
    console.log(`📊 Connected to ${client.guilds.cache.size} server(s):`);
    
    client.guilds.cache.forEach(guild => {
        console.log(`   • ${guild.name} (${guild.memberCount} members)`);
    });
    
    // Set bot status
    client.user.setActivity('for @mentions | Powered by Groq AI', { type: 'WATCHING' });
    console.log(`✅ Bot status set successfully`);
    console.log(`\n🔍 Monitoring messages and waiting for mentions...\n`);
});

// Guild events for logging
client.on('guildCreate', (guild) => {
    console.log(`➕ Joined new server: ${guild.name} (${guild.memberCount} members)`);
});

client.on('guildDelete', (guild) => {
    console.log(`➖ Left server: ${guild.name}`);
    // Clean up stored data for this server
    if (serverMessages.has(guild.id)) {
        serverMessages.delete(guild.id);
        console.log(`🗑️ Cleaned up stored messages for ${guild.name}`);
    }
});

// Message event handler
client.on('messageCreate', async (message) => {
    // Ignore messages from bots (but not the bot's own messages for analysis)
    if (message.author.bot && message.author.id !== client.user.id) return;
    
    const serverName = message.guild ? message.guild.name : 'DM';
    const channelName = message.channel.name || 'DM';
    const userName = message.author.displayName || message.author.username;
    
    // Don't analyze the bot's own responses, but analyze all other messages
    if (message.author.id !== client.user.id && message.guild) {
        // Add every message to server training data (except bot mentions)
        if (!message.mentions.has(client.user) && message.content.length > 3) {
            console.log(`👂 Listening in ${serverName}/#${channelName} - ${userName}: "${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}"`);
            addServerMessage(
                message.guild.id, 
                message.content, 
                userName
            );
        }
    }

    // Only respond when mentioned
    if (!message.mentions.has(client.user)) return;

    console.log(`\n🔔 BOT MENTIONED!`);
    console.log(`📍 Server: ${serverName}`);
    console.log(`📍 Channel: #${channelName}`);
    console.log(`👤 User: ${userName} (${message.author.id})`);
    console.log(`💬 Full message: "${message.content}"`);

    // Check cooldown
    if (isOnCooldown(message.author.id)) {
        const remainingTime = Math.ceil((userCooldowns.get(message.author.id) + COOLDOWN_TIME - Date.now()) / 1000);
        console.log(`🚫 User on cooldown, sending cooldown message`);
        message.reply(`⏰ Please wait ${remainingTime} more seconds before asking another question.`);
        return;
    }

    // Set cooldown
    setCooldown(message.author.id);

    // Show typing indicator
    console.log(`⌨️ Showing typing indicator...`);
    await message.channel.sendTyping();

    try {
        // Clean the message content (remove mentions)
        let cleanContent = message.content
            .replace(/<@!?\d+>/g, '') // Remove user mentions
            .replace(/<@&\d+>/g, '')  // Remove role mentions
            .replace(/<#\d+>/g, '')   // Remove channel mentions
            .trim();

        console.log(`🧹 Cleaned message: "${cleanContent}"`);

        // If no content after cleaning mentions, provide a default response
        if (!cleanContent) {
            cleanContent = "Hello! How can I help you?";
            console.log(`🔄 Using default message: "${cleanContent}"`);
        }

        // Get response from Groq AI with server personality
        const groqResponse = await callGroqAI(
            cleanContent, 
            userName, 
            message.guild?.id || null
        );

        // Send plain text response
        console.log(`📤 Sending response to Discord...`);
        const sentMessage = await message.reply(groqResponse);
        console.log(`✅ Response sent successfully! Message ID: ${sentMessage.id}`);
        console.log(`📏 Response length: ${groqResponse.length} characters\n`);

    } catch (error) {
        console.error('❌ Error processing message:', error);
        console.error('📋 Error details:', error.stack);
        await message.reply('❌ Sorry, I encountered an error while processing your request. Please try again later.');
    }
});

// Error handling
client.on('error', (error) => {
    console.error('❌ Discord client error:', error);
});

client.on('warn', (warning) => {
    console.warn('⚠️ Discord client warning:', warning);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Graceful shutdown
const shutdown = () => {
    console.log('\n🛑 Shutting down gracefully...');
    console.log('📊 Final stats:');
    console.log(`   • Servers: ${client.guilds?.cache.size || 0}`);
    console.log(`   • Stored server data: ${serverMessages.size}`);
    console.log(`   • Active cooldowns: ${userCooldowns.size}`);
    
    client.destroy();
    console.log('✅ Discord client destroyed');
    console.log('👋 Goodbye!');
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Validation and login
console.log('🔍 Validating environment variables...');

if (!DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN is not set in environment variables');
    console.error('💡 Make sure to set DISCORD_TOKEN in your .env file');
    process.exit(1);
}

if (!GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY is not set in environment variables');
    console.error('💡 Make sure to set GROQ_API_KEY in your .env file');
    process.exit(1);
}

console.log('✅ Environment variables validated');
console.log('🔐 Attempting to login to Discord...');

client.login(DISCORD_TOKEN).catch((error) => {
    console.error('❌ Failed to login to Discord:', error);
    console.error('💡 Check if your DISCORD_TOKEN is valid');
    process.exit(1);
});