import './keepAlive.js';

import express from 'express';
const app = express();

app.get('/', (req, res) => {
    res.send('Bot is alive!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});

import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';

// Configuration
const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno'];
const FREE_SPEECH_DURATION = 30 * 1000;
const DELETE_QUEUE_INTERVAL = 100;
const KEEP_ALIVE_INTERVAL = 60 * 1000;
const COUNTDOWN_INTERVAL = 5000;
const TEST_CHANNEL_ID = '1382577291015749674';

// Word/phrase responses - add your custom responses here
const wordResponses = {
    'gn': 'gn{!}', 'goodnight': 'gn{!}',
    'lelll😛': 'lelll😛', 'lelll 😛': 'lelll😛',
    'ping': 'pong',
    'bot': 'is that a markle reference{?}',
    'marco': 'polo',
    'markle u seeing this': 'yeah ts is crazy', 'markle r u seeing this': 'yeah ts is crazy', 'markle you seeing this': 'yeah ts is crazy', 'markle are you seeing this': 'yeah ts is crazy', 'markle are u seeing this': 'yeah ts is crazy', 'markle r you seeing this': 'yeah ts is crazy',
    'never back down never what': 'never give up{!}',
    'what\'s up': 'the sky', 
    'get a load of this guy': 'blud is not him',
    // Add more word/phrase responses here
    // 'trigger word': 'response message',
    // Use {!} for random exclamation marks, {?} for random question marks
};

// Multi-word combinations (order doesn't matter)
const multiWordResponses = new Map([
    [['markle', 'shut up'], 'fuck you'],
    [['markle', 'fuck you'], 'fuck you too'],
    [['talk', 'to you'], 'oh sorry']
    // Add more combinations here
    // [['word1', 'word2'], 'response when both words are present'],
]);

// User sets
const allowedUsers = new Set(
    process.env.ALLOWED_USERS?.split(',').map(id => id.trim()).filter(Boolean) || []
);

const allowedSlashCommandUsers = new Set(
    process.env.SLASH_COMMAND_USERS?.split(',').map(id => id.trim()).filter(Boolean) || []
);

// Client setup with error handling
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// Storage maps
const activeChallenges = new Map();
const freeSpeechTimers = new Map();
const deleteQueue = [];
const muteTimeouts = new Map();
const countdownIntervals = new Map();
const mutedUsers = new Set(); // Track who is currently muted

// Ping-pong game state
const pingPongGames = new Map(); // userId -> { timeLimit, exchanges, timeout }
const INITIAL_PING_PONG_TIME = 5000; // 5 seconds initially
const TIME_REDUCTION_RATE = 0.1; // 10% reduction each round
const PING_PONG_WIN_THRESHOLD = 10; // Win after 10 successful exchanges

// Utility functions
function generateExclamations(count) {
    return '!'.repeat(count);
}

function containsBannedWord(content) {
    const lower = content.toLowerCase();
    return bannedWords.some(word => lower.includes(word));
}

function processRandomPunctuation(text) {
    // Replace {!} with random number of exclamation marks (3-15)
    text = text.replace(/\{!\}/g, () => {
        const count = Math.floor(Math.random() * 13) + 3; // 3-15 exclamation marks
        return '!'.repeat(count);
    });
    
    // Replace {?} with random number of question marks (3-15)
    text = text.replace(/\{\?\}/g, () => {
        const count = Math.floor(Math.random() * 13) + 3; // 3-15 question marks
        return '?'.repeat(count);
    });
    
    return text;
}

function checkWordResponses(content) {
    const lower = content.toLowerCase();
    
    // Check for exact matches first
    if (wordResponses[lower]) {
        return processRandomPunctuation(wordResponses[lower]);
    }
    
    // Check for multi-word combinations (order doesn't matter)
    for (const [wordPair, response] of multiWordResponses) {
        const [word1, word2] = wordPair;
        if (lower.includes(word1.toLowerCase()) && lower.includes(word2.toLowerCase())) {
            return processRandomPunctuation(response);
        }
    }
    
    // Collect all matching single triggers
    const matchedTriggers = [];
    const matchedResponses = [];
    
    for (const [trigger, response] of Object.entries(wordResponses)) {
        if (lower.includes(trigger.toLowerCase())) {
            matchedTriggers.push(trigger);
            matchedResponses.push(processRandomPunctuation(response));
        }
    }
    
    // Different response strategies:
    if (matchedResponses.length > 1) {
        // Option 1: Join all responses (current implementation)
        return matchedResponses.join(' ');
        
        // Option 2: Special message for multiple triggers
        // return `Multiple triggers detected: ${matchedResponses.join(' | ')}`;
        
        // Option 3: Random response from matched ones
        // return matchedResponses[Math.floor(Math.random() * matchedResponses.length)];
        
        // Option 4: Count-based response
        // return `Wow, ${matchedResponses.length} triggers! ${matchedResponses.join(' ')}`;
    }
    
    // Single match (original behavior)
    if (matchedResponses.length === 1) {
        return matchedResponses[0];
    }
    
    return null; // No matching response found
}

function handlePingPongResponse(message, content) {
    const userId = message.author.id;
    const lower = content.toLowerCase();
    
    // Check if user has an active ping-pong game
    const game = pingPongGames.get(userId);
    
    if (lower === 'ping') {
        if (game && game.expectingResponse) {
            // User responded with "ping" in time! Continue the game
            clearTimeout(game.timeout);
            
            // Check if user won
            if (game.exchanges >= PING_PONG_WIN_THRESHOLD) {
                message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${game.exchanges} exchanges)`);
                
                try {
                    const user = client.users.fetch(userId);
                    user.then(u => console.log(`🏆 User @${u.username} (${userId}) WON ping-pong game with ${game.exchanges} exchanges!`));
                } catch (error) {
                    console.log(`🏆 User ${userId} WON ping-pong game with ${game.exchanges} exchanges!`);
                }
                
                pingPongGames.delete(userId);
                return true;
            }
            
            // Send "pong" and start next round
            message.channel.send('pong');
            startPingPongGame(message.channel, userId, false);
            return true; // Handled as ping-pong
        } else if (!game) {
            // Start new ping-pong game
            message.channel.send('pong');
            startPingPongGame(message.channel, userId, false);
            return true; // Handled as ping-pong
        }
    }
    
    if (lower === 'pong') {
        if (game && !game.expectingResponse) {
            // User responded with "pong" in time! Continue the game
            clearTimeout(game.timeout);
            
            // Check if user won
            if (game.exchanges >= PING_PONG_WIN_THRESHOLD) {
                message.channel.send(`<@${userId}> wow you actually won the ping pong game! 🏆 (${game.exchanges} exchanges)`);
                
                try {
                    const user = client.users.fetch(userId);
                    user.then(u => console.log(`🏆 User @${u.username} (${userId}) WON ping-pong game with ${game.exchanges} exchanges!`));
                } catch (error) {
                    console.log(`🏆 User ${userId} WON ping-pong game with ${game.exchanges} exchanges!`);
                }
                
                pingPongGames.delete(userId);
                return true;
            }
            
            // Send "ping" and start next round
            message.channel.send('ping');
            startPingPongGame(message.channel, userId, false);
            pingPongGames.get(userId).expectingResponse = true;
            return true; // Handled as ping-pong
        }
    }
    
    return false; // Not handled as ping-pong
}

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

async function clearUserState(userId) {
    const hadChallenge = activeChallenges.has(userId);
    const hadFreeSpeech = freeSpeechTimers.has(userId);
    const wasMuted = mutedUsers.has(userId);
    const hadPingPong = pingPongGames.has(userId);
    
    activeChallenges.delete(userId);
    freeSpeechTimers.delete(userId);
    mutedUsers.delete(userId); // Remove from muted users
    
    // Clear ping-pong game
    if (pingPongGames.has(userId)) {
        const game = pingPongGames.get(userId);
        if (game.timeout) {
            clearTimeout(game.timeout);
        }
        pingPongGames.delete(userId);
    }
    
    if (muteTimeouts.has(userId)) {
        clearTimeout(muteTimeouts.get(userId));
        muteTimeouts.delete(userId);
    }
    
    if (countdownIntervals.has(userId)) {
        clearInterval(countdownIntervals.get(userId));
        countdownIntervals.delete(userId);
    }
    
    if (hadChallenge || hadFreeSpeech || wasMuted || hadPingPong) {
        try {
            const user = await client.users.fetch(userId);
            console.log(`🧹 Cleared state for @${user.username} (${userId}) - Challenge: ${hadChallenge}, FreeSpeech: ${hadFreeSpeech}, Muted: ${wasMuted}, PingPong: ${hadPingPong}`);
        } catch (error) {
            console.log(`🧹 Cleared state for user ${userId} - Challenge: ${hadChallenge}, FreeSpeech: ${hadFreeSpeech}, Muted: ${wasMuted}, PingPong: ${hadPingPong}`);
        }
    }
}

async function sendChallenge(channel, userId, intro = true) {
    try {
        const count = Math.floor(Math.random() * 21) + 10; // 10-30
        const exclamations = generateExclamations(count);

        if (intro) {
            await channel.send(`hey <@${userId}> how many`);
        }
        await channel.send(`<@${userId}> count${exclamations}`);

        activeChallenges.set(userId, { 
            state: 'waiting', 
            answer: count,
            timestamp: Date.now()
        });
        
        mutedUsers.add(userId); // Add user to muted set
        
        // Console logging with username
        try {
            const user = await client.users.fetch(userId);
            console.log(`🎯 User @${user.username} (${userId}) got challenged, answer is ${count}`);
        } catch (error) {
            console.log(`🎯 User ${userId} got challenged, answer is ${count}`);
        }
    } catch (error) {
        console.error('Failed to send challenge:', error.message);
    }
}

async function startFreeSpeechCountdown(channel, userId) {
    const startTime = Date.now();
    freeSpeechTimers.set(userId, startTime);
    
    try {
        const user = await client.users.fetch(userId);
        console.log(`🗣️ User @${user.username} (${userId}) granted free speech for ${FREE_SPEECH_DURATION / 1000}s`);
    } catch (error) {
        console.log(`🗣️ User ${userId} granted free speech for ${FREE_SPEECH_DURATION / 1000}s`);
    }
    
    const interval = setInterval(async () => {
        try {
            const elapsed = Date.now() - startTime;
            const remaining = Math.ceil((FREE_SPEECH_DURATION - elapsed) / 1000);

            if (remaining > 0) {
                const msg = await channel.send(`${remaining}`);
                // Auto-delete countdown messages
                setTimeout(() => safeDelete(msg), 3000);
            } else {
                await channel.send(`<@${userId}> no more free speech`);
                try {
                    const user = await client.users.fetch(userId);
                    console.log(`⏰ User @${user.username} (${userId}) free speech expired`);
                } catch (error) {
                    console.log(`⏰ User ${userId} free speech expired`);
                }
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

async function startPingPongGame(channel, userId, isInitialPing = true) {
    // Clear any existing ping-pong game for this user
    if (pingPongGames.has(userId)) {
        const existingGame = pingPongGames.get(userId);
        if (existingGame.timeout) {
            clearTimeout(existingGame.timeout);
        }
    }

    const currentGame = pingPongGames.get(userId) || { exchanges: 0 };
    const timeLimit = isInitialPing ? INITIAL_PING_PONG_TIME : 
                     Math.max(1000, INITIAL_PING_PONG_TIME * Math.pow(1 - TIME_REDUCTION_RATE, currentGame.exchanges));
    
    const exchanges = isInitialPing ? 0 : currentGame.exchanges + 1;
    
    // Set up timeout for losing
    const timeout = setTimeout(async () => {
        try {
            await channel.send(`<@${userId}> haha you lose (${exchanges} exchanges)`);
            
            try {
                const user = await client.users.fetch(userId);
                console.log(`🏓 User @${user.username} (${userId}) lost ping-pong game after ${exchanges} exchanges (timeout: ${(timeLimit/1000).toFixed(1)}s)`);
            } catch (error) {
                console.log(`🏓 User ${userId} lost ping-pong game after ${exchanges} exchanges (timeout: ${(timeLimit/1000).toFixed(1)}s)`);
            }
            
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
        expectingResponse: !isInitialPing // If not initial ping, we're expecting "ping" response
    });

    try {
        const user = await client.users.fetch(userId);
        console.log(`🏓 User @${user.username} (${userId}) ping-pong game - Exchange: ${exchanges}/${PING_PONG_WIN_THRESHOLD}, Time limit: ${(timeLimit/1000).toFixed(1)}s`);
    } catch (error) {
        console.log(`🏓 User ${userId} ping-pong game - Exchange: ${exchanges}/${PING_PONG_WIN_THRESHOLD}, Time limit: ${(timeLimit/1000).toFixed(1)}s`);
    }
}

// Delete queue processor
setInterval(async () => {
    const job = deleteQueue.shift();
    if (job) {
        try {
            await job();
        } catch (error) {
            if (error.code !== 10008) { // Ignore "Unknown Message" errors
                console.error('Queue delete failed:', error.message);
            }
        }
    }
}, DELETE_QUEUE_INTERVAL);

// Bot ready event
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    
    // Keep-alive mechanism
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
            .addUserOption(opt => 
                opt.setName('user')
                   .setDescription('User to challenge')
                   .setRequired(true)
            )
            .addIntegerOption(opt => 
                opt.setName('duration')
                   .setDescription('Mute duration in seconds (default: 30)')
                   .setRequired(false)
                   .setMinValue(10)
                   .setMaxValue(3600)
            ),
        new SlashCommandBuilder()
            .setName('unmute')
            .setDescription('Cancel a user\'s challenge')
            .addUserOption(opt => 
                opt.setName('user')
                   .setDescription('User to release')
                   .setRequired(true)
            ),
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

// Slash command handler
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

            // Clear any existing state
            clearUserState(user.id);

            // Start challenge
            await sendChallenge(channel, user.id);

            // Set timeout
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
            const user = interaction.options.getUser('user');
            
            clearUserState(user.id);
            
            await interaction.reply({ 
                content: `✅ Challenge cleared for <@${user.id}>`, 
                flags: MessageFlags.Ephemeral 
            });

        } else if (interaction.commandName === 'status') {
            const embed = new EmbedBuilder()
                .setTitle('🤖 Bot Status')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Active Challenges', value: activeChallenges.size.toString(), inline: true },
                    { name: 'Muted Users', value: mutedUsers.size.toString(), inline: true },
                    { name: 'Free Speech Timers', value: freeSpeechTimers.size.toString(), inline: true },
                    { name: 'Ping-Pong Games', value: pingPongGames.size.toString(), inline: true },
                    { name: 'Delete Queue', value: deleteQueue.length.toString(), inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    } catch (error) {
        console.error('Interaction error:', error);
        
        const errorMsg = interaction.replied || interaction.deferred 
            ? 'An error occurred while processing the command.'
            : '❌ An error occurred while processing the command.';
            
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
        }
    }
});

// Message handler with fixes and debugging
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const content = message.content.trim();

    // Debug logging for all messages (you can remove this later if it gets too spammy)
    console.log(`📝 Message from @${message.author.username} (${userId}): "${content}"`);

    // Handle banned words for all users (including allowed users)
    if (containsBannedWord(content)) {
        safeDelete(message);
        
        // More robust console logging with debug info
        const username = message.author.username || message.author.tag || 'Unknown';
        console.log(`🚫 User @${username} (${userId}) used banned word: "${content}"`);
        console.log(`🔍 Debug - Message ID: ${message.id}, Channel: ${message.channel.name || message.channel.id}`);
        
        try {
            await message.channel.send(`<@${userId}> nuh uh no no word`);
            console.log(`✅ Banned word warning sent successfully for user ${userId}`);
        } catch (error) {
            console.error('Failed to send banned word warning:', error.message);
        }
        // IMPORTANT: Return here to prevent further processing
        return;
    }

    // Handle allowed users - they can always speak freely (after banned word check)
    if (allowedUsers.has(userId)) {
        // Check for ping-pong game first (even for allowed users)
        if (handlePingPongResponse(message, content)) {
            return; // Ping-pong handled
        }
        
        // Check for word responses even for allowed users
        const response = checkWordResponses(content);
        if (response) {
            try {
                await message.channel.send(response);
                console.log(`🤖 Bot responded to @${message.author.username} (${userId}) with: "${response}"`);
            } catch (error) {
                console.error('Failed to send word response:', error.message);
            }
        }
        return; // Don't interfere with allowed users
    }

    // Check if this user is currently muted
    if (!mutedUsers.has(userId)) {
        // Check for ping-pong game first (for non-muted users)
        if (handlePingPongResponse(message, content)) {
            return; // Ping-pong handled
        }
        
        // Check for word responses for non-muted users
        const response = checkWordResponses(content);
        if (response) {
            try {
                await message.channel.send(response);
                console.log(`🤖 Bot responded to @${message.author.username} (${userId}) with: "${response}"`);
            } catch (error) {
                console.error('Failed to send word response:', error.message);
            }
        }
        return; // User is not muted, let them speak freely
    }

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

    // This shouldn't happen, but if a muted user has no active challenge, start one
    await sendChallenge(message.channel, userId, true);
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.on('warn', warning => {
    console.warn('Discord client warning:', warning);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

// Start the bot
client.login(process.env.TOKEN).catch(error => {
    console.error('Failed to login:', error);
    process.exit(1);
});

console.log('🤖 Bot is starting...');
