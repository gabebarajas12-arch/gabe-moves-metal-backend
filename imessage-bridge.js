#!/usr/bin/env node
/**
 * GABE MOVES METAL — iMessage Bridge
 * ====================================
 * Runs locally on Gabe's Mac. Polls the Messages database for new
 * inbound texts from CRM leads, auto-replies via iMessage using
 * the bilingual template system, and syncs everything to the CRM.
 *
 * Requirements:
 *   - macOS with Terminal having Full Disk Access
 *   - Messages app signed into iMessage
 *   - CRM backend running (local or on Render)
 *
 * Usage:
 *   node imessage-bridge.js
 *   OR: RENDER=1 node imessage-bridge.js  (to use live Render backend)
 */

const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

// ==================== CONFIG ====================
const CONFIG = {
  // CRM backend URL — local by default, set RENDER=1 for production
  CRM_URL: process.env.RENDER
    ? 'https://gabe-moves-metal.onrender.com'
    : 'http://localhost:3000',
  CRM_PASSWORD: process.env.CRM_PASSWORD || 'gabemovesmetal2026',

  // Messages database path
  MESSAGES_DB: path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),

  // Poll interval (seconds)
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 10,

  // iMessage service ID (discovered via AppleScript)
  IMESSAGE_SERVICE_ID: '7F42F648-81F8-47A5-9408-6A82CDFB88AD',

  // Auto-reply settings
  AUTO_REPLY_ENABLED: process.env.AUTO_REPLY !== '0', // disable with AUTO_REPLY=0
  AUTO_REPLY_DELAY_MS: parseInt(process.env.REPLY_DELAY) || 5000, // 5s delay feels natural

  // Only respond to leads in CRM (not personal contacts)
  CRM_LEADS_ONLY: true,
};

// ==================== STATE ====================
let authToken = null;
let lastMessageRowId = 0;
let crmLeads = new Map(); // phone → lead object
let processedMessages = new Set(); // rowids we've already handled
let isRunning = false;

// ==================== BILINGUAL AUTO-REPLY TEMPLATES ====================
const TEMPLATES = {
  en: {
    greeting: `Hey {name}! Thanks for reaching out! This is Gabe from Findlay Chevrolet, the #1 volume dealer west of Texas. What are you looking for today?`,
    truck: `Great taste! I work at the #1 volume Chevy dealer west of Texas so we've got a HUGE truck selection. Silverado 1500, 2500HD, or Colorado — I can pull options and pricing right now. What are you looking at?`,
    suv: `SUVs are my bread and butter! Whether you want an Equinox, Blazer, Tahoe, or Suburban — I've got them all on the lot. What size are you thinking?`,
    ev: `Love that you're looking at EVs! Chevy has incredible electric options — the Equinox EV starts under $35K and there are federal tax credits available. Want me to break down the numbers?`,
    trade: `Trade values are strong right now! I can get you a quick appraisal — just need the year, make, model, and roughly how many miles. No obligation.`,
    price: `Great question! We move a lot of metal at Findlay so our prices stay aggressive. Which specific vehicle are you looking at? I'll pull the best numbers.`,
  },
  es: {
    greeting: `¡Hola {name}! Gracias por escribirme. Soy Gabe de Findlay Chevrolet, el dealer #1 en volumen al oeste de Texas. ¿En qué te puedo ayudar hoy?`,
    truck: `¡Buena elección! Tenemos una selección enorme de trocas. Silverado 1500, 2500HD, o Colorado. ¿Cuál te interesa? Te puedo dar precios ahorita mismo.`,
    suv: `¡Las SUVs son mi especialidad! Ya sea Equinox, Blazer, Tahoe o Suburban — las tengo todas. ¿Qué tamaño buscas?`,
    ev: `¡Me encanta que estés viendo los eléctricos! El Equinox EV empieza debajo de $35K con créditos de impuestos federales. ¿Quieres que te desglose los números?`,
    trade: `¡Los valores de trade-in están muy buenos ahorita! Solo necesito el año, marca, modelo y millaje aproximado para darte una evaluación.`,
    price: `¡Buena pregunta! En Findlay movemos mucho carro así que nuestros precios son agresivos. ¿Qué vehículo te interesa? Te consigo los mejores números.`,
  },
};

const KEYWORD_MAP = {
  truck: ['truck', 'silverado', 'colorado', 'pickup', 'tow', 'towing', 'f150', 'ram', 'troca', 'camioneta', 'remolque'],
  suv: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'trailblazer', 'trax', 'traverse', 'family', 'familia'],
  ev: ['ev', 'electric', 'equinox ev', 'blazer ev', 'silverado ev', 'hybrid', 'bolt', 'charge', 'eléctrico'],
  trade: ['trade', 'trade-in', 'trade in', 'sell my car', 'selling', 'value', 'worth', 'appraisal'],
  price: ['price', 'how much', 'cost', 'payment', 'monthly', 'finance', 'deal', 'discount', 'precio', 'cuánto', 'pago', 'mensual', 'enganche'],
};

const SPANISH_INDICATORS = ['hola', 'gracias', 'quiero', 'busco', 'necesito', 'cuánto', 'cuanto', 'precio', 'camioneta', 'troca', 'carro', 'buenos días', 'buenas tardes'];

// ==================== HELPERS ====================

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function logError(msg, err) {
  const ts = new Date().toLocaleTimeString();
  console.error(`[${ts}] ❌ ${msg}`, err?.message || err || '');
}

/**
 * Open a read-only connection to the Messages database.
 * Node must have Full Disk Access in System Settings.
 */
let messagesDb = null;

function getMessagesDb() {
  if (!messagesDb) {
    try {
      messagesDb = new Database(CONFIG.MESSAGES_DB, { readonly: true, fileMustExist: true });
      log('📱 Connected to Messages database');
    } catch (err) {
      logError('Cannot open Messages database — make sure /usr/local/bin/node has Full Disk Access', err);
      return null;
    }
  }
  return messagesDb;
}

/**
 * Send an iMessage via AppleScript
 */
function sendIMessage(phoneNumber, messageText) {
  try {
    const escapedMsg = messageText.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
    const script = `
      tell application "Messages"
        set targetService to service id "${CONFIG.IMESSAGE_SERVICE_ID}"
        set targetBuddy to participant "${phoneNumber}" of targetService
        send "${escapedMsg}" to targetBuddy
      end tell
    `;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    log(`📤 Sent iMessage to ${phoneNumber}: "${messageText.substring(0, 60)}..."`);
    return true;
  } catch (err) {
    logError(`Failed to send iMessage to ${phoneNumber}`, err);
    return false;
  }
}

/**
 * Make an HTTP request to the CRM API
 */
function crmRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.CRM_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (authToken) {
      options.headers['Authorization'] = `Bearer ${authToken}`;
    }

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ==================== CORE FUNCTIONS ====================

/**
 * Authenticate with the CRM
 */
async function authenticate() {
  try {
    const result = await crmRequest('POST', '/auth/login', { password: CONFIG.CRM_PASSWORD });
    if (result.success && result.token) {
      authToken = result.token;
      log('🔑 Authenticated with CRM');
      return true;
    }
    logError('Auth failed', result.error);
    return false;
  } catch(err) {
    logError('Auth request failed', err);
    return false;
  }
}

/**
 * Load all leads from CRM and index by phone number
 */
async function loadLeads() {
  try {
    const result = await crmRequest('GET', '/api/leads');
    // API returns raw array or { leads: [...] }
    const leads = Array.isArray(result) ? result : (result.leads || []);
    if (leads.length >= 0) {
      crmLeads.clear();
      for (const lead of leads) {
        if (lead.phone) {
          // Normalize phone number: strip everything except digits, ensure +1 prefix
          const normalized = normalizePhone(lead.phone);
          if (normalized) {
            crmLeads.set(normalized, lead);
          }
        }
      }
      log(`📋 Loaded ${crmLeads.size} leads with phone numbers`);
    }
  } catch(err) {
    logError('Failed to load leads', err);
  }
}

/**
 * Normalize a phone number to +1XXXXXXXXXX format
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

/**
 * Detect language from message text
 */
function detectLanguage(text) {
  const lower = text.toLowerCase();
  const spanishHits = SPANISH_INDICATORS.filter(w => lower.includes(w));
  return spanishHits.length >= 1 ? 'es' : 'en';
}

/**
 * Generate an auto-reply based on message content
 */
function generateAutoReply(messageText, customerName, lang) {
  const lower = messageText.toLowerCase();

  // Check keyword categories
  for (const [category, keywords] of Object.entries(KEYWORD_MAP)) {
    if (keywords.some(kw => lower.includes(kw))) {
      const template = TEMPLATES[lang][category];
      return template.replace('{name}', customerName || 'there');
    }
  }

  // Default greeting
  return TEMPLATES[lang].greeting.replace('{name}', customerName || 'there');
}

/**
 * Poll for new incoming messages from CRM leads
 */
function pollNewMessages() {
  const db = getMessagesDb();
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT m.rowid, m.text, m.is_from_me, h.id as phone,
             datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as msg_date
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.rowid
      WHERE m.rowid > ?
        AND m.text IS NOT NULL
        AND m.text != ''
        AND m.is_from_me = 0
      ORDER BY m.rowid ASC
      LIMIT 50
    `).all(lastMessageRowId);

    return rows.map(r => ({
      rowid: r.rowid,
      text: r.text,
      isFromMe: r.is_from_me === 1,
      phone: r.phone,
      date: r.msg_date,
    }));
  } catch (err) {
    logError('Poll query failed', err);
    // Reconnect on next poll in case DB was locked
    messagesDb = null;
    return [];
  }
}

/**
 * Process a single incoming message
 */
async function processMessage(msg) {
  // Skip if already processed
  if (processedMessages.has(msg.rowid)) return;
  processedMessages.add(msg.rowid);

  // Update high-water mark
  if (msg.rowid > lastMessageRowId) {
    lastMessageRowId = msg.rowid;
    saveState();
  }

  // Normalize phone number
  const normalizedPhone = normalizePhone(msg.phone);
  if (!normalizedPhone) return;

  // Only process messages from CRM leads
  const lead = crmLeads.get(normalizedPhone);
  if (!lead && CONFIG.CRM_LEADS_ONLY) {
    return; // Not a CRM lead — ignore (personal message)
  }

  const customerName = lead ? lead.name?.split(' ')[0] : 'there';
  log(`📩 New message from ${customerName || msg.phone}: "${msg.text.substring(0, 80)}"`);

  // Log inbound message to CRM
  try {
    await crmRequest('POST', '/api/sms/log', {
      phone: normalizedPhone,
      leadId: lead?.id || '',
      direction: 'inbound',
      body: msg.text,
      platform: 'imessage',
    });
  } catch(e) {
    logError('Failed to log inbound to CRM', e);
  }

  // Auto-reply if enabled
  if (CONFIG.AUTO_REPLY_ENABLED && lead) {
    const lang = detectLanguage(msg.text);
    const reply = generateAutoReply(msg.text, customerName, lang);

    // Delay for natural feel
    log(`⏳ Auto-replying in ${CONFIG.AUTO_REPLY_DELAY_MS / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, CONFIG.AUTO_REPLY_DELAY_MS));

    const sent = sendIMessage(normalizedPhone, reply);

    if (sent) {
      // Log outbound to CRM
      try {
        await crmRequest('POST', '/api/sms/log', {
          phone: normalizedPhone,
          leadId: lead?.id || '',
          direction: 'outbound',
          body: reply,
          autoReply: true,
          platform: 'imessage',
        });
      } catch(e) {
        logError('Failed to log outbound to CRM', e);
      }

      // Track response time
      try {
        await crmRequest('POST', '/api/analytics/track-response', {
          leadId: lead?.id || '',
          source: 'imessage',
          autoResponded: true,
        });
      } catch(e) { /* optional tracking */ }
    }
  }
}

// ==================== STATE PERSISTENCE ====================
const STATE_FILE = path.join(os.homedir(), '.gabe-moves-metal-bridge-state.json');

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastMessageRowId,
      savedAt: new Date().toISOString(),
    }));
  } catch(e) { /* non-critical */ }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      lastMessageRowId = data.lastMessageRowId || 0;
      log(`📂 Resumed from message rowid ${lastMessageRowId}`);
    }
  } catch(e) { /* start fresh */ }
}

// ==================== MAIN LOOP ====================

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║     GABE MOVES METAL — iMessage Bridge           ║
  ║     Auto-reply from YOUR phone number            ║
  ║                                                  ║
  ║  CRM:        ${CONFIG.CRM_URL.padEnd(35)}║
  ║  Auto-Reply: ${(CONFIG.AUTO_REPLY_ENABLED ? 'ON' : 'OFF').padEnd(35)}║
  ║  Poll Rate:  Every ${String(CONFIG.POLL_INTERVAL) + 's'.padEnd(30)}║
  ║  Leads Only: ${(CONFIG.CRM_LEADS_ONLY ? 'YES (personal msgs ignored)' : 'NO').padEnd(35)}║
  ╚══════════════════════════════════════════════════╝
  `);

  // Load saved state
  loadState();

  // If no saved state, start from current latest message (don't replay history)
  if (lastMessageRowId === 0) {
    const db = getMessagesDb();
    if (db) {
      const row = db.prepare('SELECT MAX(rowid) as maxId FROM message').get();
      lastMessageRowId = row?.maxId || 0;
      log(`⏩ Starting from current position (rowid ${lastMessageRowId})`);
      saveState();
    }
  }

  // Authenticate with CRM
  const authed = await authenticate();
  if (!authed) {
    logError('Cannot connect to CRM. Make sure the backend is running.');
    process.exit(1);
  }

  // Load leads
  await loadLeads();

  // Main polling loop
  isRunning = true;
  log(`🚀 Bridge is running! Polling every ${CONFIG.POLL_INTERVAL}s for new messages from ${crmLeads.size} leads...`);
  log(`💡 Only messages from phone numbers in your CRM will be processed.`);

  setInterval(async () => {
    try {
      // Refresh leads every 5 minutes
      if (Date.now() % (5 * 60 * 1000) < CONFIG.POLL_INTERVAL * 1000) {
        await loadLeads();
      }

      // Poll for new messages
      const newMessages = pollNewMessages();
      for (const msg of newMessages) {
        await processMessage(msg);
      }
    } catch(err) {
      logError('Poll cycle error', err);
    }
  }, CONFIG.POLL_INTERVAL * 1000);

  // Re-auth every 12 hours
  setInterval(async () => {
    await authenticate();
  }, 12 * 60 * 60 * 1000);
}

// Graceful shutdown
process.on('SIGINT', () => {
  log('👋 Shutting down bridge...');
  saveState();
  if (messagesDb) try { messagesDb.close(); } catch(e) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveState();
  if (messagesDb) try { messagesDb.close(); } catch(e) {}
  process.exit(0);
});

main().catch(err => {
  logError('Fatal error', err);
  process.exit(1);
});
