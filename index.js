// Message handler with additional debugging
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const userId = message.author.id;
    const content = message.content.trim();

    // Debug logging for all messages (you can remove this later)
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
