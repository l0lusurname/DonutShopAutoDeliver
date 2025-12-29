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
    port: parseInt(process.env.PORT || process.env.SERVER_PORT || '3001'),
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
    auth: 'microsoft', // Use Microsoft authentication
  };

  console.log('\n🔐 Starting Microsoft authentication...');
  console.log('You will receive a code to enter at https://microsoft.com/link\n');
  
  bot = mineflayer.createBot(botOptions);

  // Listen for Microsoft auth events
  bot._client.on('session', (session) => {
    console.log('✓ Microsoft authentication successful!');
    console.log('Session saved for future use.');
  });

  bot.once('spawn', () => {
    console.log('✓ Bot connected to Minecraft server');
    isReady = true;
    processCommandQueue();
  });

  bot.on('kicked', (reason) => {
    console.log('✗ Bot was kicked:', reason);
    isReady = false;
    bot = null;
    console.log('⏳ Reconnecting in 5 seconds...');
    setTimeout(createBot, 5000);
  });

  bot.on('end', () => {
    console.log('✗ Bot disconnected');
    isReady = false;
    bot = null;
    console.log('⏳ Reconnecting in 5 seconds...');
    setTimeout(createBot, 5000);
  });

  bot.on('error', (err) => {
    console.error('✗ Bot error:', err);
    // Don't reconnect on error, let 'end' event handle it
  });

  bot.on('death', () => {
    console.log('💀 Bot died, respawning...');
    setTimeout(() => {
      if (bot && isReady) {
        bot.chat('/respawn');
      }
    }, 2000);
  });

  bot.on('message', (message) => {
    const msg = message.toString();
    console.log('💬 [Minecraft Chat]:', msg);

    // Log if it's a system message (often contains payment confirmations)
    if (msg.includes('paid') || msg.includes('received') || msg.includes('balance')) {
      console.log('💰 [Payment Related]:', msg);
    }
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

  console.log('🎮 [Executing Command]:', command);
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

// Parse Discord webhook data from SellAuth
function parseDiscordWebhook(body) {
  console.log('\n🔍 Parsing Discord webhook...');
  
  // Check if this is from a SellAuth Discord notification
  if (!body.embeds || body.embeds.length === 0) {
    console.log('⚠ No embeds found');
    return null;
  }

  const embed = body.embeds[0];
  
  // Check if this is a "New Sale" notification
  if (!embed.title || !embed.title.toLowerCase().includes('sale')) {
    console.log('⚠ Not a sale notification, title:', embed.title);
    return null;
  }

  const data = {
    invoiceId: null,
    productName: null,
    quantity: 1,
    inGameName: null,
    productId: null,
    status: 'completed',
    price: 0,
  };

  // Parse fields (SellAuth uses fields format)
  if (embed.fields && Array.isArray(embed.fields)) {
    console.log('📋 Found fields:', embed.fields.length);
    
    for (const field of embed.fields) {
      const fieldName = field.name.trim();
      const fieldValue = typeof field.value === 'string' ? field.value.trim() : String(field.value);
      
      console.log(`  Field: "${fieldName}" = "${fieldValue}"`);
      
      // Invoice ID
      if (fieldName === 'Invoice ID') {
        data.invoiceId = fieldValue;
        console.log('✓ Found Invoice ID:', data.invoiceId);
      }
      
      // Product Name
      else if (fieldName === 'Product') {
        data.productName = fieldValue;
        console.log('✓ Found Product:', data.productName);
      }
      
      // Price (contains quantity info like "30 x $0.15")
      else if (fieldName === 'Price') {
        data.price = fieldValue;
        
        // Parse "30 x $0.15" format
        const match = fieldValue.match(/(\d+)\s*x/);
        if (match) {
          data.quantity = parseInt(match[1]);
          console.log('✓ Found Quantity:', data.quantity);
        }
      }
      
      // In game name - check exact match
      else if (fieldName === 'In game name') {
        data.inGameName = fieldValue;
        console.log('✓ Found In game name:', data.inGameName);
      }
      // Also try with the CONFIG custom field name
      else if (fieldName === CONFIG.customFieldName) {
        data.inGameName = fieldValue;
        console.log('✓ Found custom field:', data.inGameName);
      }
    }
  }

  // Validate we have the required data
  if (!data.inGameName) {
    console.log('⚠ Missing in-game name in webhook');
    if (embed.fields) {
      console.log('Available fields:', embed.fields.map(f => f.name));
    }
    return null;
  }

  console.log('✅ Successfully parsed purchase data:', data);
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
    return;
  }

  console.log('Matched Product ID:', matchedProductId);

  // Calculate total amount to pay
  const totalAmount = productConfig.amountPerUnit * data.quantity;
  const formattedAmount = formatAmount(totalAmount);

  // Execute payment command
  const payCommand = `/pay ${data.inGameName} ${formattedAmount}`;
  queueCommand(payCommand);

  console.log(`✓ Queued payment: ${formattedAmount} to ${data.inGameName}`);
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

// Webhook endpoint for SellAuth Direct HTTP
app.post('/webhook/sellauth', async (req, res) => {
  console.log('\n=== SellAuth Direct Webhook Received ===');
  console.log('📦 Raw Request Body:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('=====================================\n');

  try {
    const invoice = req.body;
    
    // Extract invoice data
    const data = {
      invoiceId: invoice.id || invoice.invoice_id,
      productName: null,
      quantity: 1,
      inGameName: null,
      status: invoice.status,
    };

    console.log('📋 Parsed Invoice Data:');
    console.log(`  Invoice ID: ${data.invoiceId}`);
    console.log(`  Status: ${data.status}`);

    // Only process completed invoices
    if (data.status !== 'completed') {
      console.log('⚠ Invoice not completed, skipping');
      return res.status(200).send('OK');
    }

    // Extract custom field (in-game name)
    console.log('\n🔍 Looking for custom field:', CONFIG.customFieldName);
    console.log('Custom fields in invoice:', invoice.custom_fields);
    console.log('Custom field values in invoice:', invoice.custom_field_values);

    if (invoice.custom_fields && typeof invoice.custom_fields === 'object') {
      data.inGameName = invoice.custom_fields[CONFIG.customFieldName];
      console.log('✓ Found in custom_fields:', data.inGameName);
    } else if (invoice.custom_field_values && Array.isArray(invoice.custom_field_values)) {
      const field = invoice.custom_field_values.find(f => f.name === CONFIG.customFieldName);
      if (field) {
        data.inGameName = field.value;
        console.log('✓ Found in custom_field_values:', data.inGameName);
      }
    }

    if (!data.inGameName) {
      console.error('✗ No in-game name found in invoice');
      console.error('Available custom fields:', Object.keys(invoice.custom_fields || {}));
      return res.status(200).send('OK');
    }

    // Process invoice items
    console.log('\n📦 Processing items...');
    if (invoice.items && Array.isArray(invoice.items)) {
      for (const item of invoice.items) {
        console.log(`\n  Item:`, item);
        data.productName = item.product_name || item.name;
        data.quantity = item.quantity || 1;
        console.log(`  Product: ${data.productName}`);
        console.log(`  Quantity: ${data.quantity}`);

        await processPurchase(data);
      }
    } else {
      console.log('⚠ No items found in invoice');
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('✗ Error processing SellAuth webhook:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).send('Internal Server Error');
  }
});

// Webhook endpoint for Discord (updated parser)
app.post('/webhook/discord', async (req, res) => {
  console.log('\n=== Discord Webhook Received ===');
  console.log('📦 Raw Request Body:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('=====================================\n');

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
    console.error('Stack trace:', error.stack);
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
    console.log(`\n📡 Webhook Endpoints:`);
    console.log(`   SellAuth Direct: http://localhost:${CONFIG.server.port}/webhook/sellauth`);
    console.log(`   Discord Forward:  http://localhost:${CONFIG.server.port}/webhook/discord`);
    console.log(`   Manual Trigger:   http://localhost:${CONFIG.server.port}/webhook/manual`);
    console.log(`\n🚀 Setup with ngrok:`);
    console.log(`   1. Run: ngrok http ${CONFIG.server.port}`);
    console.log(`   2. Copy the https URL (e.g., https://abc123.ngrok.io)`);
    console.log(`   3. In SellAuth: Settings > Notifications > Order Completed > HTTP`);
    console.log(`   4. Enter: https://abc123.ngrok.io/webhook/sellauth\n`);
  });
}

start();