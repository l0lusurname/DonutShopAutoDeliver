require('dotenv').config();
const mineflayer = require('mineflayer');

/**
 * This is a slimmed-down version of the bot that focuses only on 
 * staying logged in and performing the periodic /home1 command.
 */

const MC_CONFIG = {
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USERNAME,
    version: process.env.MC_VERSION || '1.20.1',
};

let bot;
let homeTimer = null;

function createBot() {
    console.log(`\n🚀 Connecting to ${MC_CONFIG.host}:${MC_CONFIG.port} as ${MC_CONFIG.username}...`);

    bot = mineflayer.createBot({
        host: MC_CONFIG.host,
        port: MC_CONFIG.port,
        username: MC_CONFIG.username,
        version: MC_CONFIG.version,
        auth: 'microsoft' // Reuses cached session if available
    });

    bot.once('spawn', () => {
        console.log('✅ Bot is in the server.');
        
        // Start the 1-minute loop
        if (!homeTimer) {
            console.log('⏰ /home1 loop started (60s)');
            homeTimer = setInterval(() => {
                if (bot && bot.entity) {
                    bot.chat('/home1');
                    console.log('📨 Sent command: /home1');
                }
            }, 60000);
        }
    });

    // Handle disconnection and auto-reconnect
    bot.on('end', () => {
        console.log('❌ Disconnected. Reconnecting in 5 seconds...');
        if (homeTimer) {
            clearInterval(homeTimer);
            homeTimer = null;
        }
        setTimeout(createBot, 5000);
    });

    bot.on('kicked', (reason) => {
        console.log('⚠️ Kicked for:', reason);
    });

    bot.on('error', (err) => {
        console.error('🛑 Error:', err.message);
    });

    // Auto-respawn logic
    bot.on('death', () => {
        console.log('💀 Bot died. Respawning...');
        setTimeout(() => bot.chat('/respawn'), 2000);
    });
}

// Ensure username is provided
if (!MC_CONFIG.username) {
    console.error('❌ Error: MC_USERNAME not found in .env file.');
    process.exit(1);
}

createBot();