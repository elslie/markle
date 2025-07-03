import './keepAlive.js';
import express from 'express';
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import { Octokit } from "@octokit/rest";

dotenv.config();

console.log('=== Markle Bot starting up at', new Date().toISOString());

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const pingPongLeaderboard = new Map(); // highest single-game streaks
const pingPongExchangesLeaderboard = new Map(); // total lifetime exchanges
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const GITHUB_OWNER = "elslie";
const GITHUB_REPO = "markle";
const LEADERBOARD_PATH = "leaderboard.json";
const EXCHANGES_LEADERBOARD_PATH = "exchanges_leaderboard.json";
const DEFAULT_BRANCH = "main";

// --- Robust GitHub File Save (with 409 retry) ---
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
      sha = undefined; // file doesn't exist yet
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

// Save leaderboard to GitHub file (highest single-game streaks)
async function saveLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongLeaderboard.entries()], null, 2);
  await saveToGitHubFile({
    path: LEADERBOARD_PATH,
    message: "Update ping pong highest streaks leaderboard",
    content,
  });
}

// Save exchanges leaderboard
async function saveExchangesLeaderboardToGitHub() {
  const content = JSON.stringify([...pingPongExchangesLeaderboard.entries()], null, 2);
  await saveToGitHubFile({
    path: EXCHANGES_LEADERBOARD_PATH,
    message: "Update ping pong exchanges leaderboard",
    content,
  });
}

// Load highest single-game streaks leaderboard
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
}

// --- FIX: Define safeDelete ---
function safeDelete(msg) {
  if (msg && typeof msg.delete === 'function') {
    msg.delete().catch(console.error);
  }
}

// ...rest of your code...

// Example usage (fixing your error)
setTimeout(() => safeDelete(msg), 5000);
