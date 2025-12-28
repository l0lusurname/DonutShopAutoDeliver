require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');
const bodyParser = require('body-parser');

// Configuration loaded from environment variables
const CONFIG = {
  // Minecraft Bot Settings
  minecraft: {
    host: process.env.MC_HOST || 'localhost',
    port: parseInt(process.env.MC_PORT) || 25565,
    username: process.env.MC_USERNAME,
    password: process.env.MC_PASSWORD, // Optional, comment out if offline mode
    version: process.env.MC_VERSION || '1.20.1',
  },

  // Discord Webhook Settings
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  },

  // Product Configuration
  products: parseProductConfig(process.env.PRODUCT_CONFIG),

  // Server Settings
  server: {
    port: parseInt(process.env.SERVER_PORT) || 3000,
  },

  // Custom Field Name
  customFieldName: process.env.CUSTOM_FIELD_NAME || 'in_game_name',
};

// Parse product configuration from JSON string
function parseProductConfig(configString) {
  if (!configString) {
    console.warn('⚠ No PRODUCT_CONFIG found, using default configuration');
    return {
      'default': {
        name: 'Default Package',
        amountPerUnit: 1000000,
        onPurchaseCommand: '/afk 33',
      }
    };
  }

  try {
    return JSON.parse(configString);
  } catch (error) {
    console.error('✗ Failed to parse PRODUCT_CONFIG:', error.message);
    process.exit(1);
  }
}

// Validate required configuration
function validateConfig() {
  const required = [
    { key: 'MC_USERNAME', value: CONFIG.minecraft.username },
    { key: 'DISCORD_WEBHOOK_URL', value: CONFIG.discord.webhookUrl },
  ];

  const missing = required.filter(r => !r.value);

  if (missing.length > 0) {
    console.error('✗ Missing required environment variables:');
    missing.forEach(m => console.error(`  - ${m.key}`));
    console.error('\nPlease check your .env file');
    process.exit(1);
  }

  console.log('✓ Configuration validated');
}

// Initialize Minecraft Bot
let bot = null;
let isReady = false;
let commandQueue = [];

function createBot() {
  const botOptions = {
    host: CONFIG.minecraft.host,
    port: CONFIG.minecraft.port,
    username: CONFIG.minecraft.username,
    version: CONFIG.minecraft.version,
  };

  // Only add password if it's set
  if (CONFIG.minecraft.password) {
    botOptions.password = CONFIG.minecraft.password;
  }

  bot = mineflayer.createBot(botOptions);

  bot.once('spawn', () => {
    console.log('✓ Bot connected to Minecraft server');
    isReady = true;
    processCommandQueue();
  });

  bot.on('kicked', (reason) => {
    console.log('✗ Bot was kicked:', reason);
    isReady = false;
    setTimeout(createBot, 5000);
  });

  bot.on('end', () => {
    console.log('✗ Bot disconnected');
    isReady = false;
    setTimeout(createBot, 5000);
  });

  bot.on('error', (err) => {
    console.error('✗ Bot error:', err);
  });

  bot.on('message', (message) => {
    console.log('Chat:', message.toString());
  });
}

// Command Queue System
function queueCommand(command) {
  commandQueue.push(command);
  if (isReady) {
    processCommandQueue();
  }
}

function processCommandQueue() {
  while (commandQueue.length > 0 && isReady) {
    const command = commandQueue.shift();
    executeCommand(command);
  }
}

function executeCommand(command) {
  if (!isReady || !bot) {
    console.log('⚠ Bot not ready, queueing command:', command);
    commandQueue.unshift(command);
    return;
  }

  console.log('→ Executing command:', command);
  bot.chat(command);

  return new Promise(resolve => setTimeout(resolve, 500));
}

// Send Discord Notification
async function sendDiscordNotification(type, data) {
  if (!CONFIG.discord.webhookUrl) {
    console.log('⚠ Discord webhook not configured, skipping notification');
    return;
  }

  let embed;

  switch (type) {
    case 'payment_success':
      embed = {
        title: '💰 Payment Processed',
        color: 0x00ff00,
        fields: [
          { name: 'Player', value: data.inGameName, inline: true },
          { name: 'Amount', value: data.amount, inline: true },
          { name: 'Product', value: data.productName, inline: false },
          { name: 'Quantity', value: data.quantity.toString(), inline: true },
          { name: 'Invoice ID', value: data.invoiceId, inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      break;

    case 'payment_error':
      embed = {
        title: '❌ Payment Error',
        color: 0xff0000,
        description: data.error,
        fields: [
          { name: 'Invoice ID', value: data.invoiceId || 'Unknown', inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      break;

    case 'bot_status':
      embed = {
        title: data.connected ? '✅ Bot Connected' : '⚠️ Bot Disconnected',
        color: data.connected ? 0x00ff00 : 0xff9900,
        fields: [
          { name: 'Server', value: `${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`, inline: true },
          { name: 'Username', value: CONFIG.minecraft.username, inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      break;
  }

  try {
    const response = await fetch(CONFIG.discord.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!response.ok) {
      console.error('Failed to send Discord notification:', response.statusText);
    }
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
}

// Parse Discord webhook data
function parseDiscordWebhook(body) {
  // Check if this is from a SellAuth Discord notification
  if (!body.embeds || body.embeds.length === 0) {
    return null;
  }

  const embed = body.embeds[0];
  
  // Extract data from embed fields
  const data = {
    invoiceId: null,
    productName: null,
    quantity: 1,
    inGameName: null,
    productId: null,
    status: 'completed',
  };

  // Parse embed title to check if it's a purchase notification
  if (!embed.title || !embed.title.toLowerCase().includes('purchase')) {
    return null;
  }

  // Parse fields from the embed
  if (embed.fields) {
    for (const field of embed.fields) {
      const name = field.name.toLowerCase();
      const value = field.value;

      if (name.includes('invoice') || name.includes('order')) {
        data.invoiceId = value;
      } else if (name.includes('product') || name.includes('item')) {
        data.productName = value;
      } else if (name.includes('quantity') || name.includes('amount')) {
        const qty = parseInt(value);
        if (!isNaN(qty)) data.quantity = qty;
      } else if (name.includes(CONFIG.customFieldName) || name.includes('username') || name.includes('ign')) {
        data.inGameName = value;
      } else if (name.includes('product id') || name.includes('id')) {
        data.productId = value;
      }
    }
  }

  // Also check description for information
  if (embed.description) {
    const lines = embed.description.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes(CONFIG.customFieldName) || line.toLowerCase().includes('username')) {
        const match = line.match(/:\s*(.+)/);
        if (match && !data.inGameName) {
          data.inGameName = match[1].trim();
        }
      }
    }
  }

  return data;
}

// Process Purchase from Discord webhook
async function processPurchase(data) {
  console.log('\n=== Processing Purchase ===');
  console.log('Invoice ID:', data.invoiceId || 'Unknown');
  console.log('Product:', data.productName);
  console.log('Quantity:', data.quantity);

  if (!data.inGameName) {
    const error = 'No in-game name found in webhook data';
    console.error('✗', error);
    await sendDiscordNotification('payment_error', {
      error,
      invoiceId: data.invoiceId,
    });
    return;
  }

  console.log('Player:', data.inGameName);

  // Find product configuration
  let productConfig = null;
  let matchedProductId = null;

  // Try to match by product ID first
  if (data.productId && CONFIG.products[data.productId]) {
    productConfig = CONFIG.products[data.productId];
    matchedProductId = data.productId;
  } else {
    // Try to match by product name
    for (const [productId, config] of Object.entries(CONFIG.products)) {
      if (config.name.toLowerCase() === data.productName.toLowerCase()) {
        productConfig = config;
        matchedProductId = productId;
        break;
      }
    }
  }

  if (!productConfig) {
    const error = `No configuration found for product: ${data.productName}`;
    console.log('⚠', error);
    await sendDiscordNotification('payment_error', {
      error,
      invoiceId: data.invoiceId,
    });
    return;
  }

  console.log('Matched Product ID:', matchedProductId);

  // Execute the on-purchase command (e.g., /afk 33)
  if (productConfig.onPurchaseCommand) {
    queueCommand(productConfig.onPurchaseCommand);
  }

  // Calculate total amount to pay
  const totalAmount = productConfig.amountPerUnit * data.quantity;
  const formattedAmount = formatAmount(totalAmount);

  // Execute payment command
  const payCommand = `/pay ${data.inGameName} ${formattedAmount}`;
  queueCommand(payCommand);

  console.log(`✓ Queued payment: ${formattedAmount} to ${data.inGameName}`);

  // Send success notification
  await sendDiscordNotification('payment_success', {
    inGameName: data.inGameName,
    amount: formattedAmount,
    productName: data.productName,
    quantity: data.quantity,
    invoiceId: data.invoiceId || 'Unknown',
  });
}

// Format amount (convert 1000000 to "1m", 5000000 to "5m", etc.)
function formatAmount(amount) {
  if (amount >= 1000000) {
    return `${amount / 1000000}m`;
  } else if (amount >= 1000) {
    return `${amount / 1000}k`;
  }
  return amount.toString();
}

// Webhook Server
const app = express();
app.use(bodyParser.json());

// Webhook endpoint for Discord
app.post('/webhook/discord', async (req, res) => {
  console.log('\n=== Discord Webhook Received ===');

  try {
    const purchaseData = parseDiscordWebhook(req.body);

    if (!purchaseData) {
      console.log('⚠ Not a purchase notification, ignoring');
      return res.status(200).send('OK');
    }

    await processPurchase(purchaseData);
    res.status(200).send('OK');
  } catch (error) {
    console.error('✗ Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Manual purchase endpoint (for testing or manual triggers)
app.post('/webhook/manual', async (req, res) => {
  console.log('\n=== Manual Purchase Trigger ===');

  const { inGameName, productId, quantity } = req.body;

  if (!inGameName || !productId) {
    return res.status(400).json({ error: 'Missing required fields: inGameName, productId' });
  }

  try {
    await processPurchase({
      inGameName,
      productId,
      productName: CONFIG.products[productId]?.name || 'Unknown Product',
      quantity: quantity || 1,
      invoiceId: 'MANUAL',
    });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('✗ Error processing manual purchase:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    botConnected: isReady,
    queuedCommands: commandQueue.length,
    productsConfigured: Object.keys(CONFIG.products).length,
  });
});

// Test Discord notification endpoint
app.post('/test/discord', async (req, res) => {
  await sendDiscordNotification('bot_status', { connected: true });
  res.json({ success: true, message: 'Test notification sent' });
});

// Start the bot and server
function start() {
  console.log('=== SellAuth Minecraft Payment Bot (Discord Mode) ===\n');

  // Validate configuration
  validateConfig();

  // Display configuration (without secrets)
  console.log('\nConfiguration:');
  console.log(`  Minecraft Server: ${CONFIG.minecraft.host}:${CONFIG.minecraft.port}`);
  console.log(`  Bot Username: ${CONFIG.minecraft.username}`);
  console.log(`  Using Password: ${CONFIG.minecraft.password ? 'Yes' : 'No'}`);
  console.log(`  Discord Webhook: ${CONFIG.discord.webhookUrl ? 'Configured' : 'Not configured'}`);
  console.log(`  Products Configured: ${Object.keys(CONFIG.products).length}`);
  console.log(`  Custom Field Name: ${CONFIG.customFieldName}`);
  console.log('');

  // Create Minecraft bot
  createBot();

  // Send bot connected notification
  bot.once('spawn', () => {
    sendDiscordNotification('bot_status', { connected: true });
  });

  // Start webhook server
  app.listen(CONFIG.server.port, () => {
    console.log(`✓ Webhook server running on port ${CONFIG.server.port}`);
    console.log(`Discord Webhook URL: http://your-server:${CONFIG.server.port}/webhook/discord`);
    console.log(`Manual Trigger URL: http://your-server:${CONFIG.server.port}/webhook/manual`);
    console.log('\nSetup Instructions:');
    console.log('1. In SellAuth, go to Settings > Integrations > Discord');
    console.log('2. Set your Discord webhook URL (get from Discord channel settings)');
    console.log('3. SellAuth will send purchase notifications to Discord');
    console.log('4. Forward those notifications to this bot using a Discord webhook proxy or Zapier\n');
  });
}

start();