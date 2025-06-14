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

import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';

// Configuration
const bannedWords = ['yao', 'fag', 'retard', 'cunt', 'bashno'];
const FREE_SPEECH_DURATION = 30 * 1000;
const DELETE_QUEUE_INTERVAL = 100;
const KEEP_ALIVE_INTERVAL = 60 * 1000;
const COUNTDOWN_INTERVAL = 5000;
const TEST_CHANNEL_ID = '1382577291015749674';

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

// Utility functions
function generateExclamations(count) {
    return '!'.repeat(count);
}

function containsBannedWord(content) {
    const lower = content.toLowerCase();
    return bannedWords.some(word => lower.includes(word));
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

function clearUserState(userId) {
    activeChallenges.delete(userId);
    freeSpeechTimers.delete(userId);
    mutedUsers.delete(userId); // Remove from muted users
    
    if (muteTimeouts.has(userId)) {
        clearTimeout(muteTimeouts.get(userId));
        muteTimeouts.delete(userId);
    }
    
    if (countdownIntervals.has(userId)) {
        clearInterval(countdownIntervals.get(userId));
        countdownIntervals.delete(userId);
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
    } catch (error) {
        console.error('Failed to send challenge:', error.message);
    }
}

function startFreeSpeechCountdown(channel, userId) {
    const startTime = Date.now();
    freeSpeechTimers.set(userId, startTime);
    
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
            ephemeral: true 
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
                ephemeral: true 
            });

        } else if (interaction.commandName === 'unmute') {
            const user = interaction.options.getUser('user');
            
            clearUserState(user.id);
            
            await interaction.reply({ 
                content: `✅ Challenge cleared for <@${user.id}>`, 
                ephemeral: true 
            });

        } else if (interaction.commandName === 'status') {
            const embed = new EmbedBuilder()
                .setTitle('🤖 Bot Status')
                .setColor(0x00ff00)
                .addFields(
                    { name: 'Active Challenges', value: activeChallenges.size.toString(), inline: true },
                    { name: 'Muted Users', value: mutedUsers.size.toString(), inline: true },
                    { name: 'Free Speech Timers', value: freeSpeechTimers.size.toString(), inline: true },
                    { name: 'Delete Queue', value: deleteQueue.length.toString(), inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    } catch (error) {
        console.error('Interaction error:', error);
        
        const errorMsg = interaction.replied || interaction.deferred 
            ? 'An error occurred while processing the command.'
            : '❌ An error occurred while processing the command.';
            
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: errorMsg, ephemeral: true });
        }
    }
});

// Message handler
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const content = message.content.trim();

    // Handle banned words for all users
    if (containsBannedWord(content)) {
        safeDelete(message);
        return;
    }

    // Handle allowed users - they can always speak freely
    if (allowedUsers.has(userId)) {
        return; // Don't interfere with allowed users
    }

    // Check if this user is currently muted
    if (!mutedUsers.has(userId)) {
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
            startFreeSpeechCountdown(message.channel, userId);
            await message.channel.send(`<@${userId}> congrats u now have temporary free speech`);
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
            await message.channel.send(`<@${userId}> good boy`);
            activeChallenges.set(userId, { state: 'solved' });
        } else {
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
