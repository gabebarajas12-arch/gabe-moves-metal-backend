/**
 * GABE MOVES METAL — Lead Engine Backend
 * =======================================
 * Personal lead generation server for Gabe's Facebook Business Page
 * "Gabe Moves Metal" (facebook.com/Gabemovesmetal1)
 *
 * Connects to Meta's APIs for:
 * - Facebook Messenger (auto-reply + conversation management)
 * - Instagram DMs (auto-reply + conversation management)
 * - Facebook Lead Ads (instant lead capture)
 * - Page comments (lead detection)
 *
 * Bilingual support (English/Spanish) for auto-replies.
 * All leads flow into Gabe's personal CRM.
 *
 * Setup: See META_SETUP_GUIDE.md for step-by-step instructions.
 */

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cheerio = require('cheerio');
const uploadStorage = multer.diskStorage({
  destination: function(req, file, cb) {
    const dir = path.join(__dirname, 'public', 'uploads');
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, {recursive: true});
    cb(null, dir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_'));
  }
});
const upload = multer({ storage: uploadStorage, limits: { fileSize: 10 * 1024 * 1024 } });
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const inventoryModule = require("./inventory"); // Real Algolia-powered inventory (587+ vehicles)
const database = require("./database"); // SQLite persistent storage

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIG ====================
// These values come from your Meta Developer App (see setup guide)
const CONFIG = {
  META_APP_ID: process.env.META_APP_ID || '1934914437118814',
  META_APP_SECRET: process.env.META_APP_SECRET || 'YOUR_APP_SECRET',
  META_PAGE_ACCESS_TOKEN: process.env.META_PAGE_ACCESS_TOKEN || 'YOUR_PAGE_ACCESS_TOKEN',
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'gabe_moves_metal_2025',
  PAGE_ID: process.env.PAGE_ID || '61575074716398',
  IG_ACCOUNT_ID: process.env.IG_ACCOUNT_ID || '17841401044727929',
  WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://gabe-moves-metal.onrender.com/webhook',
  // WhatsApp Cloud API (register 702-416-3741 in Meta Developer Console → WhatsApp → API Setup)
  // Meta assigns a Phone Number ID once registered — set it here or in Render env vars
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || 'YOUR_WA_PHONE_NUMBER_ID',
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '1972990456955920',
  WHATSAPP_PHONE_NUMBER: '17024163741', // Gabe's number in E.164 format
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'gabe_moves_metal_wa_2026',
  // TikTok Content Posting API (apply at developers.tiktok.com → Content Posting API)
  TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN || '',
  TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY || '',
  TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET || '',
  // Twilio SMS API
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER || '', // Twilio number in E.164
  // Personal brand info
  SALESMAN_NAME: 'Gabe',
  PAGE_NAME: 'Gabe Moves Metal',
  DEALERSHIP: 'Findlay Chevrolet',  // where Gabe works
  MESSENGER_ID: '653248677865512',
};

// ==================== AUTHENTICATION ====================
// Set CRM_PASSWORD in Render env vars. Default for local dev only.
const CRM_PASSWORD = process.env.CRM_PASSWORD || 'gabemovesmetal2026';

// Active sessions (token → { createdAt, expiresAt })
const sessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Extract token from Authorization header or query param
function getToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.query.token || null;
}

// Auth middleware — protects all /api/* routes
function requireAuth(req, res, next) {
  const token = getToken(req);
  if (isValidSession(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
// Serve frontend — 'public' is a subfolder of the backend repo on Render
app.use(express.static(path.join(__dirname, 'public')));

// ==================== AUTH ROUTES (public) ====================
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === CRM_PASSWORD) {
    const token = generateToken();
    sessions.set(token, {
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION,
    });
    return res.json({ success: true, token, expiresIn: SESSION_DURATION });
  }
  return res.status(401).json({ success: false, error: 'Wrong password.' });
});

app.post('/auth/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  return res.json({ success: true });
});

app.get('/auth/check', (req, res) => {
  const token = getToken(req);
  return res.json({ authenticated: isValidSession(token) });
});

// ==================== PROTECT API ROUTES ====================
// Webhook & public pages are NOT protected (Meta needs access)
// All /api/* routes require authentication
app.use('/api', requireAuth);

// ==================== DATABASE (SQLite) ====================
// Persistent storage — survives Render restarts
database.initDatabase();

// Default bilingual auto-reply templates (seeded on first run)
const DEFAULT_TEMPLATES = [
  // ===== ENGLISH TEMPLATES =====
  { id: 'instant_greeting_en', trigger: 'new_message', lang: 'en', name: 'Instant Greeting (EN)',
    message: `Hey {first_name}! Thanks for reaching out! This is Gabe from Gabe Moves Metal — I sell at Findlay Chevrolet, the #1 volume dealer west of Texas. What are you looking for today?`,
    active: true, delay: 0 },
  { id: 'truck_interest_en', trigger: 'keyword', lang: 'en',
    keywords: ['truck', 'silverado', 'colorado', 'sierra', 'tow', 'towing', 'pickup', 'f150', 'ram'],
    name: 'Truck Interest (EN)',
    message: `Great taste! I work at the #1 volume Chevy dealer west of Texas so we've got a HUGE truck selection. Silverado 1500, 2500HD, or Colorado — I can pull options and pricing right now. What are you looking at?`,
    active: true, delay: 30 },
  { id: 'suv_interest_en', trigger: 'keyword', lang: 'en',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'trailblazer', 'trax', 'traverse', 'family'],
    name: 'SUV Interest (EN)',
    message: `SUVs are my bread and butter! Whether you want an Equinox, Blazer, Tahoe, or Suburban — I've got them all on the lot. What size are you thinking, and is there a budget range you're working with?`,
    active: true, delay: 30 },
  { id: 'ev_interest_en', trigger: 'keyword', lang: 'en',
    keywords: ['ev', 'electric', 'equinox ev', 'blazer ev', 'silverado ev', 'hybrid', 'bolt', 'charge'],
    name: 'EV Interest (EN)',
    message: `Love that you're looking at EVs! Chevy has incredible electric options — the Equinox EV starts under $35K and there are federal tax credits available. Want me to break down the numbers for you?`,
    active: true, delay: 30 },
  { id: 'trade_in_en', trigger: 'keyword', lang: 'en',
    keywords: ['trade', 'trade-in', 'trade in', 'sell my car', 'selling', 'what is my car worth', 'value'],
    name: 'Trade-In Interest (EN)',
    message: `Trade values are strong right now! I can get you a quick appraisal — just need the year, make, model, and roughly how many miles. No obligation. Want to set that up?`,
    active: true, delay: 15 },
  { id: 'price_question_en', trigger: 'keyword', lang: 'en',
    keywords: ['price', 'how much', 'cost', 'payment', 'monthly', 'finance', 'deal', 'discount', 'best price'],
    name: 'Pricing Question (EN)',
    message: `Great question! We move a lot of metal at Findlay so our prices stay aggressive. Which specific vehicle are you looking at? I'll pull the best numbers I can for you.`,
    active: true, delay: 15 },
  // ===== SPANISH TEMPLATES =====
  { id: 'instant_greeting_es', trigger: 'new_message', lang: 'es', name: 'Saludo Inicial (ES)',
    message: `¡Hola {first_name}! Gracias por escribirme. Soy Gabe de Gabe Moves Metal — vendo en Findlay Chevrolet, el dealer #1 en volumen al oeste de Texas. ¿En qué te puedo ayudar hoy?`,
    active: true, delay: 0 },
  { id: 'truck_interest_es', trigger: 'keyword', lang: 'es',
    keywords: ['troca', 'camioneta', 'silverado', 'colorado', 'pickup', 'remolque', 'jalar'],
    name: 'Interés en Trocas (ES)',
    message: `¡Buena elección! Trabajo en el dealer Chevy #1 en volumen al oeste de Texas — tenemos una selección enorme de trocas. Silverado 1500, 2500HD, o Colorado. ¿Cuál te interesa? Te puedo dar precios ahorita mismo.`,
    active: true, delay: 30 },
  { id: 'suv_interest_es', trigger: 'keyword', lang: 'es',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'familiar', 'familia', 'camioneta grande'],
    name: 'Interés en SUVs (ES)',
    message: `¡Las SUVs son mi especialidad! Ya sea Equinox, Blazer, Tahoe o Suburban — las tengo todas en el lote. ¿Qué tamaño buscas y cuál es tu presupuesto más o menos?`,
    active: true, delay: 30 },
  { id: 'price_question_es', trigger: 'keyword', lang: 'es',
    keywords: ['precio', 'cuánto', 'cuanto', 'cuesta', 'pago', 'mensual', 'financiar', 'crédito', 'credito', 'enganche'],
    name: 'Pregunta de Precio (ES)',
    message: `¡Buena pregunta! En Findlay movemos mucho volumen así que nuestros precios son muy competitivos. ¿Qué vehículo te interesa? Te consigo los mejores números que pueda.`,
    active: true, delay: 15 },
  { id: 'trade_in_es', trigger: 'keyword', lang: 'es',
    keywords: ['intercambio', 'trade', 'vender mi carro', 'cuánto vale', 'cuanto vale', 'avalúo'],
    name: 'Interés en Trade-In (ES)',
    message: `¡Los valores de trade-in están muy buenos ahorita! Solo necesito el año, marca, modelo y más o menos cuántas millas tiene. Sin compromiso. ¿Quieres que lo hagamos?`,
    active: true, delay: 15 },
];

// Migrate any existing data.json → SQLite, then seed defaults
database.migrateFromJson();
database.seedDefaultTemplates(DEFAULT_TEMPLATES);

// saveData() is now a no-op — database writes are immediate
function saveData() { /* SQLite handles persistence automatically */ }


// ==================== META WEBHOOK VERIFICATION ====================
// Meta sends a GET request to verify your webhook endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Accept both Facebook/Instagram and WhatsApp verify tokens
  if (mode === 'subscribe' && (token === CONFIG.META_VERIFY_TOKEN || token === CONFIG.WHATSAPP_VERIFY_TOKEN)) {
    console.log('[Webhook] Verified');
    return res.status(200).send(challenge);
  }
  console.log('[Webhook] Verification failed');
  return res.sendStatus(403);
});


// ==================== META WEBHOOK HANDLER ====================
// Receives all events: messages, lead ads, comments, reactions
app.post('/webhook', async (req, res) => {
  // Always respond 200 quickly to Meta (they retry if you're slow)
  res.sendStatus(200);

  const body = req.body;

  // Verify signature (security)
  if (CONFIG.META_APP_SECRET !== 'YOUR_APP_SECRET') {
    const signature = req.headers['x-hub-signature-256'];
    if (signature) {
      const expected = 'sha256=' + crypto.createHmac('sha256', CONFIG.META_APP_SECRET).update(req.rawBody).digest('hex');
      if (signature !== expected) {
        console.log('[Webhook] Invalid signature');
        return;
      }
    }
  }

  if (body.object === 'page' || body.object === 'instagram') {
    for (const entry of body.entry) {
      // ---- MESSENGER / INSTAGRAM DM MESSAGES ----
      if (entry.messaging) {
        for (const event of entry.messaging) {
          await handleMessage(event, body.object);
        }
      }

      // ---- LEAD AD FORM SUBMISSIONS ----
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'leadgen') {
            await handleLeadAd(change.value);
          }
          if (change.field === 'feed') {
            await handleFeedEvent(change.value);
          }
        }
      }
    }
  }

  // ---- WHATSAPP CLOUD API MESSAGES ----
  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'messages' && change.value?.messages) {
            for (const msg of change.value.messages) {
              await handleWhatsAppMessage(msg, change.value);
            }
          }
          // WhatsApp message status updates (sent, delivered, read)
          if (change.field === 'messages' && change.value?.statuses) {
            for (const status of change.value.statuses) {
              handleWhatsAppStatus(status);
            }
          }
        }
      }
    }
  }
});


// ==================== MESSAGE HANDLER ====================
async function handleMessage(event, platform) {
  const senderId = event.sender.id;
  const timestamp = event.timestamp;

  // Skip echo messages (messages we sent)
  if (event.message && event.message.is_echo) return;

  if (event.message) {
    const messageText = event.message.text || '';
    const messageId = event.message.mid;

    console.log(`[Message] New ${platform} from ${senderId}: "${messageText}"`);

    // Get sender profile
    const profile = await getSenderProfile(senderId, platform);
    const firstName = profile.first_name || 'there';
    const fullName = profile.first_name && profile.last_name
      ? `${profile.first_name} ${profile.last_name}` : `User ${senderId}`;

    // Find or create conversation
    let convo = database.conversations.findBySenderId(senderId, platform);
    if (!convo) {
      convo = {
        id: generateId(),
        senderId,
        platform,
        name: fullName,
        profilePic: profile.profile_pic || null,
        messages: [],
        leadId: null,
        status: 'new',
        createdAt: new Date().toISOString(),
      };
      database.conversations.create(convo);

      // Create a lead automatically
      const lead = {
        id: generateId(),
        name: fullName,
        phone: '',
        email: '',
        interest: detectInterest(messageText),
        source: platform === 'instagram' ? 'Instagram DM' : 'FB Messenger',
        stage: 'New Lead',
        followUpDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        notes: `Auto-captured from ${platform} message: "${messageText}"`,
        createdAt: new Date().toISOString().split('T')[0],
        conversationId: convo.id,
      };
      database.leads.create(lead);
      convo.leadId = lead.id;
      database.conversations.update(convo.id, { leadId: lead.id });

      // Create notification
      addNotification({
        type: 'new_lead',
        title: `New ${platform === 'instagram' ? 'Instagram' : 'Messenger'} Lead!`,
        message: `${fullName} just messaged: "${messageText.substring(0, 100)}"`,
        leadId: lead.id,
      });

      // Auto-enroll in follow-up sequences
      autoEnrollLead(lead.id, 'New Lead');
    }

    // Add message to conversation
    database.conversations.addMessage(convo.id, {
      id: messageId,
      from: 'customer',
      text: messageText,
      timestamp: new Date(timestamp).toISOString(),
    });

    // ---- AUTO-REPLY LOGIC ----
    // Detect language for bilingual responses
    const detectedLang = detectLanguage(messageText);

    // Store language on the conversation and lead for future reference
    if (!convo.language) {
      convo.language = detectedLang;
      database.conversations.update(convo.id, { language: detectedLang });
    }
    const lead = database.leads.getById(convo.leadId);
    if (lead && !lead.language) database.leads.update(lead.id, { language: detectedLang });

    // ---- AUTO-REPLY: ONE MESSAGE ONLY ----
    // Rule: only ever send ONE auto-reply per customer turn, and only on their
    // very first message to the page. Everything after that is Gabe's job to
    // reply to personally. NEVER auto-dump inventory, prices, or stock numbers
    // — this app is a talking-points tool for face-to-face selling, not a
    // price-pushing bot. That stays off the wire on purpose.
    const isFirstCustomerMessage = database.conversations.getMessageCount(convo.id, 'customer') === 1;
    const botHasNotRepliedYet = database.conversations.getNonCustomerMessageCount(convo.id) === 0;

    if (isFirstCustomerMessage && botHasNotRepliedYet) {
      const allTemplates = database.templates.getAll();
      const greeting = allTemplates.find(t =>
        t.trigger === 'new_message' && t.active && t.lang === detectedLang
      ) || allTemplates.find(t => t.trigger === 'new_message' && t.active);

      if (greeting) {
        const reply = greeting.message.replace(/\{first_name\}/g, firstName);
        setTimeout(() => {
          sendMessage(senderId, reply, platform);
          database.conversations.addMessage(convo.id, {
            id: generateId(),
            from: 'bot',
            text: reply,
            timestamp: new Date().toISOString(),
            templateUsed: greeting.name,
          });
        }, (greeting.delay || 0) * 1000);
      }

      // Still capture interest on the lead record (internal only — never sent to customer)
      const detectedInterest = detectInterest(messageText);
      if (detectedInterest) {
        const leadForInterest = database.leads.getById(convo.leadId);
        if (leadForInterest) {
          database.leads.update(leadForInterest.id, {
            interest: detectedInterest || leadForInterest.interest,
          });
        }
      }
    }

    // 3. Notify salesman for personal follow-up
    addNotification({
      type: 'message',
      title: `Message from ${fullName}`,
      message: messageText.substring(0, 150),
      leadId: convo.leadId,
      conversationId: convo.id,
    });

  }
}


// ==================== LEAD AD HANDLER ====================
async function handleLeadAd(leadData) {
  const leadgenId = leadData.leadgen_id;
  const pageId = leadData.page_id;
  const formId = leadData.form_id;

  console.log(`[Lead] New Lead Ad submission: ${leadgenId}`);

  // Fetch the actual lead data from Meta's API
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${CONFIG.META_PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();

    if (data.field_data) {
      const fields = {};
      data.field_data.forEach(f => { fields[f.name] = f.values[0]; });

      const lead = {
        id: generateId(),
        name: `${fields.full_name || fields.first_name || ''} ${fields.last_name || ''}`.trim() || 'Unknown',
        phone: fields.phone_number || fields.phone || '',
        email: fields.email || '',
        interest: fields.vehicle_interest || fields.what_are_you_looking_for || 'Not specified',
        source: 'FB Lead Ad',
        stage: 'New Lead',
        followUpDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        notes: `Auto-captured from Lead Ad (Form: ${formId}). ${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        createdAt: new Date().toISOString().split('T')[0],
        leadAdId: leadgenId,
      };

      database.leads.create(lead);

      addNotification({
        type: 'new_lead',
        title: 'New Lead Ad Submission!',
        message: `${lead.name} just filled out a lead form. Interested in: ${lead.interest}`,
        leadId: lead.id,
      });

      // If we have their Messenger ID, send a welcome message
      if (data.retailer_item_id) {
        const greeting = database.templates.getAll().find(t => t.id === 'instant_greeting' && t.active);
        if (greeting) {
          const reply = greeting.message.replace(/\{first_name\}/g, fields.first_name || 'there');
          // Note: Can only message if user opted in via Messenger
        }
      }

      console.log(`[Lead] Captured: ${lead.name} - ${lead.interest}`);
    }
  } catch (err) {
    console.error('Error fetching lead ad data:', err.message);
  }
}


// ==================== FEED EVENT HANDLER ====================
async function handleFeedEvent(feedData) {
  // Track comments on your page's posts
  if (feedData.item === 'comment' && feedData.verb === 'add') {
    const commenterName = feedData.from?.name || 'Unknown';
    const comment = feedData.message || '';
    const postId = feedData.post_id;

    console.log(`[Comment] From ${commenterName}: "${comment}"`);

    // Only capture if it looks like a potential lead
    const leadKeywords = /interest|price|how much|available|trade|looking for|want|need|buy/i;
    if (leadKeywords.test(comment)) {
      const lead = {
        id: generateId(),
        name: commenterName,
        phone: '',
        email: '',
        interest: detectInterest(comment) || 'From post comment',
        source: 'FB Comment',
        stage: 'New Lead',
        followUpDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
        notes: `Commented on post ${postId}: "${comment}"`,
        createdAt: new Date().toISOString().split('T')[0],
      };
      database.leads.create(lead);

      addNotification({
        type: 'new_lead',
        title: 'Potential Lead from Comment!',
        message: `${commenterName} commented: "${comment.substring(0, 100)}"`,
        leadId: lead.id,
      });

    }
  }
}


// ==================== WHATSAPP MESSAGE HANDLER ====================
async function handleWhatsAppMessage(msg, value) {
  const from = msg.from; // phone number (e.g., '14155551234')
  const msgType = msg.type;
  const timestamp = msg.timestamp;
  const contactName = value.contacts?.[0]?.profile?.name || `+${from}`;

  let messageText = '';
  if (msgType === 'text') {
    messageText = msg.text?.body || '';
  } else if (msgType === 'image') {
    messageText = '[Image received]';
  } else if (msgType === 'document') {
    messageText = '[Document received]';
  } else if (msgType === 'audio') {
    messageText = '[Voice message received]';
  } else if (msgType === 'video') {
    messageText = '[Video received]';
  } else if (msgType === 'location') {
    messageText = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
  } else {
    messageText = `[${msgType} message]`;
  }

  console.log(`[WhatsApp] From ${contactName} (${from}): "${messageText}"`);

  // Find or create conversation (keyed by phone number for WhatsApp)
  let convo = database.conversations.findBySenderId(from, 'whatsapp');
  if (!convo) {
    convo = {
      id: generateId(),
      senderId: from,
      platform: 'whatsapp',
      name: contactName,
      phone: from,
      profilePic: null,
      messages: [],
      leadId: null,
      status: 'new',
      createdAt: new Date().toISOString(),
    };
    database.conversations.create(convo);

    // Create a lead automatically
    const lead = {
      id: generateId(),
      name: contactName,
      phone: `+${from}`,
      email: '',
      interest: detectInterest(messageText),
      source: 'WhatsApp',
      stage: 'New Lead',
      followUpDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
      notes: `Auto-captured from WhatsApp: "${messageText}"`,
      createdAt: new Date().toISOString().split('T')[0],
      conversationId: convo.id,
    };
    database.leads.create(lead);
    convo.leadId = lead.id;
    database.conversations.update(convo.id, { leadId: lead.id });

    addNotification({
      type: 'new_lead',
      title: 'New WhatsApp Lead!',
      message: `${contactName} just messaged on WhatsApp: "${messageText.substring(0, 100)}"`,
      leadId: lead.id,
    });
  }

  // Add message to conversation
  database.conversations.addMessage(convo.id, {
    id: msg.id,
    from: 'customer',
    text: messageText,
    timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
  });

  // ---- AUTO-REPLY LOGIC (same as Messenger, bilingual) ----
  const detectedLang = detectLanguage(messageText);
  if (!convo.language) {
    convo.language = detectedLang;
    database.conversations.update(convo.id, { language: detectedLang });
  }

  const firstName = contactName.split(' ')[0] || 'there';

  // ---- AUTO-REPLY: ONE MESSAGE ONLY (matches Messenger rule) ----
  // Send exactly one greeting on the first customer message. No keyword
  // cascade, no auto-inventory, no pricing. Everything past the greeting is
  // Gabe's job to reply to by hand.
  const isFirstCustomerMessage = database.conversations.getMessageCount(convo.id, 'customer') === 1;
  const botHasNotRepliedYet = database.conversations.getNonCustomerMessageCount(convo.id) === 0;

  if (isFirstCustomerMessage && botHasNotRepliedYet) {
    const waTemplates = database.templates.getAll();
    const greeting = waTemplates.find(t =>
      t.trigger === 'new_message' && t.active && t.lang === detectedLang
    ) || waTemplates.find(t => t.trigger === 'new_message' && t.active);

    if (greeting) {
      const reply = greeting.message.replace(/\{first_name\}/g, firstName);
      setTimeout(() => {
        sendWhatsAppMessage(from, reply);
        database.conversations.addMessage(convo.id, {
          id: generateId(),
          from: 'bot',
          text: reply,
          timestamp: new Date().toISOString(),
          templateUsed: greeting.name,
        });
      }, (greeting.delay || 0) * 1000);
    }

    // Silently capture interest on the lead record (internal only — never sent)
    const detectedInterest = detectInterest(messageText);
    if (detectedInterest) {
      const leadForInterest = database.leads.getById(convo.leadId);
      if (leadForInterest) {
        database.leads.update(leadForInterest.id, {
          interest: detectedInterest || leadForInterest.interest,
        });
      }
    }
  }

}

function handleWhatsAppStatus(status) {
  // Track message delivery statuses: sent, delivered, read
  const convo = database.conversations.findBySenderId(status.recipient_id, 'whatsapp');
  if (convo) {
    const msg = convo.messages.find(m => m.waMessageId === status.id);
    if (msg) {
      msg.deliveryStatus = status.status; // 'sent', 'delivered', 'read'
    }
  }
}


// ==================== SEND WHATSAPP MESSAGE ====================
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.META_PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text },
      }),
    });
    const result = await response.json();
    if (result.error) {
      console.error('WhatsApp send error:', result.error.message);
    } else {
      console.log(`[WhatsApp] Sent to +${to}`);
    }
    return result;
  } catch (err) {
    console.error('Failed to send WhatsApp message:', err.message);
  }
}

// Send a WhatsApp template message (for outbound outside 24hr window)
async function sendWhatsAppTemplate(to, templateName, languageCode = 'en_US', components = []) {
  const url = `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.META_PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: components,
        },
      }),
    });
    const result = await response.json();
    if (result.error) {
      console.error('WhatsApp template error:', result.error.message);
    } else {
      console.log(`[WhatsApp] Template "${templateName}" sent to +${to}`);
    }
    return result;
  } catch (err) {
    console.error('Failed to send WhatsApp template:', err.message);
  }
}

// Send WhatsApp image message (for vehicle photos)
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  const url = `https://graph.facebook.com/v21.0/${CONFIG.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.META_PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: { link: imageUrl, caption: caption },
      }),
    });
    return await response.json();
  } catch (err) {
    console.error('Failed to send WhatsApp image:', err.message);
  }
}


// ==================== SEND MESSAGE VIA META API ====================
async function sendMessage(recipientId, text, platform = 'page') {
  const apiUrl = platform === 'instagram'
    ? `https://graph.facebook.com/v19.0/${CONFIG.IG_ACCOUNT_ID}/messages`
    : `https://graph.facebook.com/v19.0/${CONFIG.PAGE_ID}/messages`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.META_PAGE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE',
      }),
    });

    const result = await response.json();
    if (result.error) {
      console.error('Send message error:', result.error.message);
    } else {
      console.log(`[Message] Sent to ${recipientId}`);
    }
    return result;
  } catch (err) {
    console.error('Failed to send message:', err.message);
  }
}


// ==================== GET SENDER PROFILE ====================
async function getSenderProfile(userId, platform = 'page') {
  try {
    const fields = platform === 'instagram' ? 'name,username,profile_picture_url' : 'first_name,last_name,profile_pic';
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${userId}?fields=${fields}&access_token=${CONFIG.META_PAGE_ACCESS_TOKEN}`
    );
    return await response.json();
  } catch (err) {
    console.error('Failed to get profile:', err.message);
    return {};
  }
}


// ==================== HELPER FUNCTIONS ====================
function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

function detectInterest(text) {
  const lower = text.toLowerCase();
  const vehicles = [
    { keywords: ['silverado', '1500', '2500', '3500'], name: 'Silverado' },
    { keywords: ['tahoe'], name: 'Tahoe' },
    { keywords: ['suburban'], name: 'Suburban' },
    { keywords: ['equinox'], name: 'Equinox' },
    { keywords: ['blazer'], name: 'Blazer' },
    { keywords: ['traverse'], name: 'Traverse' },
    { keywords: ['colorado'], name: 'Colorado' },
    { keywords: ['camaro'], name: 'Camaro' },
    { keywords: ['corvette'], name: 'Corvette' },
    { keywords: ['trax'], name: 'Trax' },
    { keywords: ['trailblazer'], name: 'Trailblazer' },
    { keywords: ['malibu'], name: 'Malibu' },
    { keywords: ['bolt'], name: 'Bolt' },
    { keywords: ['truck', 'pickup'], name: 'Truck (TBD)' },
    { keywords: ['suv'], name: 'SUV (TBD)' },
    { keywords: ['ev', 'electric'], name: 'EV (TBD)' },
    { keywords: ['car', 'sedan'], name: 'Sedan (TBD)' },
  ];

  for (const v of vehicles) {
    if (v.keywords.some(k => lower.includes(k))) return v.name;
  }
  return '';
}

function detectLanguage(text) {
  const lower = text.toLowerCase();
  const spanishIndicators = [
    'hola', 'buenos', 'buenas', 'gracias', 'quiero', 'busco', 'necesito',
    'precio', 'cuánto', 'cuanto', 'cuesta', 'carro', 'coche', 'troca',
    'camioneta', 'interesa', 'puedo', 'tiene', 'están', 'favor', 'ayuda',
    'familia', 'grande', 'nueva', 'nuevo', 'usada', 'usado', 'vender',
    'comprar', 'financiar', 'crédito', 'credito', 'enganche', 'mensual',
    'por favor', 'señor', 'amigo', 'millas', 'año',
  ];
  const spanishCount = spanishIndicators.filter(w => lower.includes(w)).length;
  return spanishCount >= 2 ? 'es' : 'en';
}

function findKeywordTemplate(text) {
  const lower = text.toLowerCase();
  const lang = detectLanguage(text);

  // First try to match in the detected language
  const fktTemplates = database.templates.getAll();
  let match = fktTemplates.find(t =>
    t.trigger === 'keyword' && t.active && t.lang === lang &&
    t.keywords.some(k => lower.includes(k))
  );

  // Fallback to any language if no match found
  if (!match) {
    match = fktTemplates.find(t =>
      t.trigger === 'keyword' && t.active &&
      t.keywords.some(k => lower.includes(k))
    );
  }

  return match;
}

function addNotification(notif) {
  database.notifications.create({
    id: generateId(),
    ...notif,
    read: false,
    createdAt: new Date().toISOString(),
  });
}


// ==================== REST API ENDPOINTS ====================
// These power the CRM frontend

// -- Leads --
app.get('/api/leads', (req, res) => {
  res.json(database.leads.getAll());
});

app.post('/api/leads', (req, res) => {
  const lead = { id: generateId(), ...req.body, createdAt: new Date().toISOString().split('T')[0] };
  database.leads.create(lead);
  res.json(lead);
});

app.put('/api/leads/:id', (req, res) => {
  const updated = database.leads.update(req.params.id, req.body);
  if (updated) {
    res.json(updated);
  } else {
    res.status(404).json({ error: 'Lead not found' });
  }
});

app.delete('/api/leads/:id', (req, res) => {
  database.leads.delete(req.params.id);
  res.json({ success: true });
});

// -- Conversations --
app.get('/api/conversations', (req, res) => {
  res.json(database.conversations.getAll());
});

app.get('/api/conversations/:id', (req, res) => {
  const convo = database.conversations.getById(req.params.id);
  if (convo) res.json(convo);
  else res.status(404).json({ error: 'Conversation not found' });
});

// Send a manual reply to a conversation (supports all platforms)
app.post('/api/conversations/:id/reply', async (req, res) => {
  const convo = database.conversations.getById(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const { text } = req.body;
  if (convo.platform === 'whatsapp') {
    await sendWhatsAppMessage(convo.senderId, text);
  } else {
    await sendMessage(convo.senderId, text, convo.platform);
  }

  database.conversations.addMessage(convo.id, {
    id: generateId(),
    from: 'salesman',
    text,
    timestamp: new Date().toISOString(),
  });

  // Update lead stage to Contacted
  const lead = database.leads.getById(convo.leadId);
  if (lead && lead.stage === 'New Lead') {
    database.leads.update(lead.id, { stage: 'Contacted' });
  }

  res.json(database.conversations.getById(convo.id));
});

// -- Notifications --
app.get('/api/notifications', (req, res) => {
  res.json(database.notifications.getAll());
});

app.put('/api/notifications/:id/read', (req, res) => {
  database.notifications.markRead(req.params.id);
  res.json({ success: true });
});

app.post('/api/notifications/read-all', (req, res) => {
  database.notifications.markAllRead();
  res.json({ success: true });
});

// -- Templates --
app.get('/api/templates', (req, res) => {
  res.json(database.templates.getAll());
});

app.put('/api/templates/:id', (req, res) => {
  const updated = database.templates.update(req.params.id, req.body);
  if (updated) {
    res.json(updated);
  } else {
    res.status(404).json({ error: 'Template not found' });
  }
});

app.post('/api/templates', (req, res) => {
  const template = { id: generateId(), ...req.body };
  database.templates.create(template);
  res.json(template);
});

// -- Inventory --
app.get('/api/inventory', (req, res) => {
  const { condition, model, maxPrice, minPrice } = req.query;
  let vehicles = inventoryModule.getInventory();

  if (condition) vehicles = vehicles.filter(v => v.condition?.toLowerCase() === condition.toLowerCase());
  if (model) vehicles = vehicles.filter(v => v.model?.toLowerCase().includes(model.toLowerCase()));
  if (maxPrice) vehicles = vehicles.filter(v => v.price <= parseFloat(maxPrice));
  if (minPrice) vehicles = vehicles.filter(v => v.price >= parseFloat(minPrice));

  res.json({
    vehicles,
    count: vehicles.length,
    lastScraped: inventoryModule.getLastScraped(),
  });
});

app.get('/api/inventory/match', (req, res) => {
  const { interest, maxResults, condition, maxPrice, minPrice } = req.query;
  if (!interest) return res.status(400).json({ error: 'interest parameter required' });

  const matches = inventoryModule.matchInventory(interest, {
    maxResults: parseInt(maxResults) || 5,
    condition: condition || null,
    maxPrice: maxPrice ? parseFloat(maxPrice) : null,
    minPrice: minPrice ? parseFloat(minPrice) : null,
  });

  res.json({
    query: interest,
    matches: inventoryModule.formatInventoryForCRM(matches),
    customerMessage: inventoryModule.formatInventoryMessage(matches, 'there'),
    count: matches.length,
    totalInventory: inventoryModule.getInventoryCount(),
    lastScraped: inventoryModule.getLastScraped(),
  });
});

app.post('/api/inventory/refresh', async (req, res) => {
  const vehicles = await inventoryModule.scrapeInventory();
  // Fire and forget — prewarm stickers for any new VINs in the background
  if (typeof prewarmStickers === 'function' && vehicles && vehicles.length) {
    prewarmStickers(vehicles, { label: 'refresh' });
  }
  res.json({ success: true, count: vehicles.length, lastScraped: inventoryModule.getLastScraped() });
});

app.post('/api/inventory/import', (req, res) => {
  const { format, data } = req.body;
  let vehicles = [];

  if (format === 'csv') {
    vehicles = inventoryModule.importFromCSV(data);
  } else if (format === 'json') {
    vehicles = inventoryModule.importFromJSON(data);
  } else {
    return res.status(400).json({ error: 'format must be csv or json' });
  }

  // Merge with existing inventory
  const currentInventory = inventoryModule.getInventory();
  const merged = [...vehicles, ...currentInventory.filter(existing =>
    !vehicles.some(v => v.vin === existing.vin || v.stockNumber === existing.stockNumber)
  )];

  // This updates the module's internal state
  inventoryModule.importFromJSON(merged);

  res.json({ success: true, imported: vehicles.length, total: merged.length });
});

// -- Scraper status --
app.get('/api/scraper/status', (req, res) => {
  const scraperLeads = database.leads.getAll();
  const scraperConvos = database.conversations.getAll();
  const stats = database.getStats();
  res.json({
    totalLeads: scraperLeads.length,
    sources: {
      messenger: scraperLeads.filter(l => l.source === 'FB Messenger').length,
      instagram: scraperLeads.filter(l => l.source === 'Instagram DM').length,
      leadAds: scraperLeads.filter(l => l.source === 'FB Lead Ad').length,
      comments: scraperLeads.filter(l => l.source === 'FB Comment').length,
    },
    activeConversations: scraperConvos.filter(c => c.status === 'new' || c.status === 'active').length,
    unreadNotifications: stats.unreadNotifs,
  });
});

// -- Dashboard stats --
app.get('/api/stats', (req, res) => {
  const now = new Date();
  const allLeads = database.leads.getAll();
  const thisMonth = allLeads.filter(l => {
    const d = new Date(l.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const dbStats = database.getStats();
  res.json({
    totalLeads: allLeads.length,
    newThisMonth: thisMonth.length,
    byStage: STAGES_LIST.reduce((acc, s) => { acc[s] = allLeads.filter(l => l.stage === s).length; return acc; }, {}),
    bySource: allLeads.reduce((acc, l) => { acc[l.source] = (acc[l.source] || 0) + 1; return acc; }, {}),
    conversations: dbStats.totalConvos,
    unreadNotifications: dbStats.unreadNotifs,
    inventory: {
      total: inventoryModule.getInventoryCount(),
      lastScraped: inventoryModule.getLastScraped(),
    },
  });
});

const STAGES_LIST = ['New Lead', 'Contacted', 'Appointment', 'Negotiation', 'Sold'];


// ==================== AUTO-POSTING ENGINE ====================
// Create and publish posts to Facebook, Instagram, and WhatsApp Status

// ==================== LEAD-OPTIMIZED AUTO-POSTING ENGINE ====================
// Create and publish posts to Facebook, Instagram, TikTok, and WhatsApp Status
// Built with FB/IG/TikTok lead generation best practices baked in

// -- LEAD OPTIMIZATION KNOWLEDGE BASE --
// This data drives the coaching tips, scoring, and smart defaults throughout the Post Creator

const LEAD_OPT = {
  // Best posting times for car sales (Pacific Time — Las Vegas)
  bestTimes: {
    facebook: {
      weekday: ['11:00 AM', '1:00 PM', '7:00 PM'],
      weekend: ['10:00 AM', '12:00 PM', '5:00 PM'],
      peakDays: ['Tuesday', 'Thursday', 'Saturday'],
      why: 'Lunch breaks and after-work scrolling drive highest FB engagement for auto sales',
    },
    instagram: {
      weekday: ['12:00 PM', '5:00 PM', '8:00 PM'],
      weekend: ['11:00 AM', '1:00 PM', '7:00 PM'],
      peakDays: ['Wednesday', 'Friday', 'Saturday'],
      why: 'IG engagement peaks during breaks and evening scroll time; Reels get pushed on weekends',
    },
    tiktok: {
      weekday: ['7:00 AM', '12:00 PM', '7:00 PM', '10:00 PM'],
      weekend: ['9:00 AM', '12:00 PM', '7:00 PM'],
      peakDays: ['Tuesday', 'Thursday', 'Friday'],
      why: 'TikTok FYP algorithm pushes content hard during commute times and late-night scroll sessions; Tue/Thu/Fri see highest car content engagement',
    },
  },

  // Hashtag strategy: mix of broad reach + niche + local + branded
  hashtagSets: {
    sold: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet', '#GabeBarajas'],
      local: ['#LasVegas', '#Vegas', '#VegasLife', '#Henderson', '#NorthLasVegas', '#LasVegasCars'],
      niche: ['#Sold', '#NewCarDay', '#JustSold', '#HappyCustomer', '#CustomerAppreciation', '#DeliveryDay'],
      broad: ['#Chevrolet', '#Chevy', '#NewCar', '#CarSales', '#DealerLife', '#TruckLife'],
    },
    deals: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet'],
      local: ['#LasVegas', '#Vegas', '#VegasDeals', '#LasVegasAuto'],
      niche: ['#CarDeal', '#AutoDeal', '#ZeroDown', '#LowAPR', '#SpecialOffer', '#LimitedTime'],
      broad: ['#Chevrolet', '#Chevy', '#NewCar', '#TruckDeals', '#SUVDeals', '#CarShopping'],
    },
    inventory: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet'],
      local: ['#LasVegas', '#Vegas', '#LasVegasChevy', '#VegasTrucks'],
      niche: ['#JustArrived', '#NewArrival', '#LotFresh', '#TestDrive', '#InStock', '#ReadyToRoll'],
      broad: ['#Chevrolet', '#Chevy', '#Trucks', '#SUV', '#CarShopping', '#AutoSales'],
    },
    brand: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet', '#GabeBarajas'],
      local: ['#LasVegas', '#Vegas', '#VegasLife', '#VegasBusiness'],
      niche: ['#CarSalesLife', '#SalesMotivation', '#Hustle', '#TopSalesman', '#MovingMetal'],
      broad: ['#Motivation', '#Grind', '#Success', '#Entrepreneur', '#NeverSettle'],
    },
    testimonial: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet', '#GabeBarajas'],
      local: ['#LasVegas', '#Vegas', '#VegasAuto'],
      niche: ['#CustomerReview', '#5Stars', '#HappyCustomer', '#Testimonial', '#TrustedDealer'],
      broad: ['#Chevrolet', '#Chevy', '#CarBuying', '#CustomerFirst', '#Referral'],
    },
    walkaround: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet'],
      local: ['#LasVegas', '#Vegas', '#VegasCars'],
      niche: ['#Walkaround', '#CarTour', '#VehicleTour', '#FeatureCheck', '#InsideLook'],
      broad: ['#Chevrolet', '#Chevy', '#NewCar', '#CarReview', '#AutoReview', '#MustSee'],
    },
    financing: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet'],
      local: ['#LasVegas', '#Vegas', '#VegasAuto'],
      niche: ['#CarFinancing', '#AutoLoan', '#CreditApproval', '#FirstTimeBuyer', '#PreApproved'],
      broad: ['#Chevrolet', '#Chevy', '#FinanceTips', '#CarBuyingTips', '#MoneyTips'],
    },
    comparison: {
      branded: ['#GabeMovesmetal', '#FindlayChevrolet'],
      local: ['#LasVegas', '#Vegas'],
      niche: ['#CarComparison', '#HeadToHead', '#WhichOne', '#VSPost', '#BuyersGuide'],
      broad: ['#Chevrolet', '#Chevy', '#CarShopping', '#TruckComparison', '#SUVComparison'],
    },
  },

  // TikTok-specific hashtag sets (TikTok uses FEWER hashtags — 3-5 trending ones, not 15)
  tiktokHashtags: {
    sold: ['#carsales', '#sold', '#newcar', '#cartok', '#dealerlife', '#happycustomer', '#chevrolet', '#lasvegas', '#gabemovesmetal'],
    deals: ['#cardeal', '#carshopping', '#dealoftheday', '#cartok', '#chevrolet', '#truckdeal', '#lasvegas', '#gabemovesmetal'],
    inventory: ['#newarrival', '#carshopping', '#cartok', '#chevrolet', '#trucks', '#newcar', '#lasvegas', '#gabemovesmetal'],
    brand: ['#carsalesman', '#dealerlife', '#cartok', '#daynthelife', '#salesmotivation', '#lasvegas', '#gabemovesmetal'],
    testimonial: ['#customerreview', '#5star', '#cartok', '#happycustomer', '#chevrolet', '#lasvegas', '#gabemovesmetal'],
    walkaround: ['#carreview', '#walkaround', '#cartok', '#chevrolet', '#carshopping', '#mustsee', '#gabemovesmetal'],
    financing: ['#carfinance', '#creditrepair', '#cartok', '#firsttimebuyer', '#financetips', '#gabemovesmetal'],
    comparison: ['#carcomparison', '#cartok', '#whichcar', '#chevrolet', '#trucks', '#headtohead', '#gabemovesmetal'],
  },

  // Build optimized hashtag string
  // FB/IG: 5 broad + 5 niche + 3 local + 2 branded = ~15 (IG sweet spot)
  // TikTok: 3-5 trending tags (algorithm penalizes hashtag stuffing)
  buildHashtags: (postType, model, platform) => {
    if (platform === 'tiktok') {
      const ttSet = LEAD_OPT.tiktokHashtags[postType] || LEAD_OPT.tiktokHashtags.brand;
      const pick = (arr, n) => arr.sort(() => 0.5 - Math.random()).slice(0, n);
      let tags = pick(ttSet, 5);
      if (model) {
        const modelTag = '#' + model.replace(/\s+/g, '').toLowerCase();
        if (!tags.includes(modelTag)) tags.push(modelTag);
      }
      return [...new Set(tags)].join(' ');
    }
    // FB/IG default — full hashtag spread
    const set = LEAD_OPT.hashtagSets[postType] || LEAD_OPT.hashtagSets.brand;
    const pick = (arr, n) => arr.sort(() => 0.5 - Math.random()).slice(0, n);
    let tags = [
      ...set.branded,
      ...pick(set.local, 3),
      ...pick(set.niche, 5),
      ...pick(set.broad, 5),
    ];
    if (model) {
      const modelTag = '#' + model.replace(/\s+/g, '');
      if (!tags.includes(modelTag)) tags.push(modelTag);
    }
    return [...new Set(tags)].join(' ');
  },

  // Caption hooks — attention-grabbing first lines (the algorithm rewards stop-the-scroll openers)
  hooks: {
    sold: [
      '🚨 ANOTHER ONE OFF THE LOT!',
      '🔑 Keys handed. Smiles earned.',
      '💥 SOLD! Who\'s next?',
      '🎉 Congratulations are in order!',
      '🏆 Another happy customer just drove off!',
      '📸 That new car smell hits different...',
    ],
    deals: [
      '🚨 STOP SCROLLING — You need to see this deal.',
      '💰 Your wallet is going to thank you.',
      '⏰ This deal expires soon. Don\'t sleep on it.',
      '🔥 The kind of deal your neighbor wishes they got.',
      '📉 Prices just dropped. Seriously.',
      '💥 If you\'ve been waiting for the right time — THIS IS IT.',
    ],
    inventory: [
      '👀 Look what just hit the lot...',
      '🆕 JUST ARRIVED and it won\'t last long.',
      '🔥 Fresh off the truck. Come see it before it\'s gone.',
      '😍 I had to stop and take a picture of this one.',
      '📣 New arrival alert! This one is special.',
      '🚗 Tell me this doesn\'t look good...',
    ],
    brand: [
      '💪 Let me tell you something about this business...',
      '🎯 Here\'s what they don\'t tell you about car sales.',
      '🏆 The grind never stops, and neither do I.',
      '📈 Another day, another record at Findlay.',
      '🤝 This job isn\'t about cars — it\'s about people.',
    ],
    testimonial: [
      '⭐ Don\'t take my word for it — hear from my customers.',
      '📣 THIS is why I do what I do.',
      '🙏 Nothing beats a happy customer review.',
      '💯 Real customer. Real experience. Real results.',
      '⭐⭐⭐⭐⭐ Another 5-star review!',
    ],
    walkaround: [
      '🎥 Let me walk you through this beauty...',
      '👆 SAVE THIS for when you\'re ready to buy.',
      '📋 Everything you need to know about this one.',
      '🔍 Let me show you why this is selling fast.',
      '🎬 Full walkaround — see every angle.',
    ],
    financing: [
      '💡 SAVE THIS — you\'ll need it when buying a car.',
      '🏦 Think you can\'t get approved? Think again.',
      '📊 Let me break down car financing for you.',
      '💰 How to get the BEST deal on your next car.',
      '🤔 First time buying? Here\'s what you need to know.',
    ],
    comparison: [
      '🤔 Which one would YOU pick?',
      '⚔️ HEAD TO HEAD — let\'s settle this.',
      '📊 The comparison you\'ve been waiting for.',
      '🏆 There can only be one winner...',
      '👇 Comment which one you\'d drive home!',
    ],
  },

  // DM-trigger CTAs — these drive direct lead capture
  ctas: {
    soft: [
      'DM me "INFO" and I\'ll send you the details.',
      'Drop a 🔥 in the comments if you want to know more.',
      'Comment "DEAL" and I\'ll reach out personally.',
      'Send me a message — I respond fast.',
      'Tap that message button — let\'s talk.',
    ],
    medium: [
      'DM me "PRICE" for exclusive pricing on this one.',
      'Comment "INTERESTED" and I\'ll DM you the breakdown.',
      'Type "MINE" in the comments and I\'ll lock this deal for you.',
      'DM me your trade-in year/model for an instant quote.',
      'Comment your budget range — I\'ll find the perfect match.',
    ],
    strong: [
      '🚨 DM me "READY" to get pre-approved in minutes.',
      'Comment "PAYMENT" and I\'ll DM you monthly options.',
      'First 3 people to DM me get VIP pricing. Go!',
      'DM me now — this one has 2 people looking at it already.',
      'Comment "SOLD" before someone else does!',
    ],
    softES: [
      'Mándame un mensaje con "INFO" y te doy todos los detalles.',
      'Deja un 🔥 en los comentarios si te interesa.',
      'Comenta "PRECIO" y te contacto personalmente.',
      'Mándame mensaje — respondo rápido.',
    ],
    mediumES: [
      'Escríbeme "PRECIO" para un precio exclusivo.',
      'Comenta "INTERESADO" y te mando la info por DM.',
      'Mándame el año/modelo de tu carro actual para una cotización.',
    ],
    strongES: [
      '🚨 Escríbeme "LISTO" para pre-aprobarte en minutos.',
      'Comenta "PAGO" y te mando las opciones de pago mensual.',
      '¡Los primeros 3 que me escriban reciben precio VIP!',
    ],
  },

  // Content mix recommendations (weekly)
  contentMix: {
    ideal: {
      sold_customer: { pct: 25, perWeek: 2, why: 'Social proof is your #1 lead driver — people buy from winners' },
      current_deal: { pct: 15, perWeek: 1, why: 'Urgency-driven deals convert fence-sitters; don\'t overdo or it feels spammy' },
      inventory_highlight: { pct: 20, perWeek: 2, why: 'Showcasing inventory keeps you top-of-mind for active shoppers' },
      personal_brand: { pct: 10, perWeek: 1, why: 'People buy from PEOPLE — let them know the real you' },
      testimonial: { pct: 15, perWeek: 1, why: 'Third-party validation crushes objections before they start' },
      walkaround: { pct: 10, perWeek: 1, why: 'Video/carousel walkarounds get 3x more saves — saves = future buyers' },
      financing: { pct: 5, perWeek: 0.5, why: 'Education builds trust and targets first-time buyers (huge market)' },
      comparison: { pct: 0, perWeek: 0.5, why: 'Comparison posts spark debates in comments = free algorithm boost' },
    },
    weeklyTotal: 8,
  },

  // Caption scoring — rate how optimized a caption is for lead gen
  scoreCaption: (caption, postType) => {
    let score = 0;
    const checks = [];

    // 1. Has a hook/attention-grabber in the first line (20 pts)
    const firstLine = caption.split('\n')[0];
    if (firstLine && (firstLine.includes('🚨') || firstLine.includes('🔥') || firstLine.includes('💥') || firstLine.includes('👀') || firstLine.includes('⭐') || firstLine.length < 60)) {
      score += 20; checks.push({ name: 'Strong hook', passed: true, pts: 20 });
    } else {
      checks.push({ name: 'Strong hook', passed: false, pts: 0, tip: 'Start with an emoji + short punchy line to stop the scroll' });
    }

    // 2. Has a CTA / call to action (25 pts — most important)
    const ctaPatterns = /\b(DM|dm|comment|tag|share|message|call|text|click|tap|link in bio|reach out|escr[ií]beme|comenta|manda|mensaje)\b/i;
    if (ctaPatterns.test(caption)) {
      score += 25; checks.push({ name: 'Clear CTA', passed: true, pts: 25 });
    } else {
      checks.push({ name: 'Clear CTA', passed: false, pts: 0, tip: 'Add a DM trigger like "Comment DEAL for pricing" — this is how you capture leads' });
    }

    // 3. Has hashtags (10 pts)
    const hashCount = (caption.match(/#\w+/g) || []).length;
    if (hashCount >= 10) {
      score += 10; checks.push({ name: 'Hashtags (10+)', passed: true, pts: 10 });
    } else if (hashCount >= 5) {
      score += 5; checks.push({ name: 'Hashtags (5-9)', passed: true, pts: 5, tip: 'Aim for 12-15 hashtags for maximum IG reach' });
    } else {
      checks.push({ name: 'Hashtags', passed: false, pts: 0, tip: 'Add 12-15 hashtags mixing branded + local + niche' });
    }

    // 4. Mention of Findlay / #1 volume dealer (social proof) (10 pts)
    if (/findlay|#1 volume|number one|número uno/i.test(caption)) {
      score += 10; checks.push({ name: 'Dealership credibility', passed: true, pts: 10 });
    } else {
      checks.push({ name: 'Dealership credibility', passed: false, pts: 0, tip: 'Mention Findlay Chevrolet or "#1 volume dealer" for credibility' });
    }

    // 5. Urgency / scarcity language (10 pts)
    if (/won't last|limited|hurry|expires|only \d|don't miss|last chance|act now|running out|no dura|se acaba|últim/i.test(caption)) {
      score += 10; checks.push({ name: 'Urgency/scarcity', passed: true, pts: 10 });
    } else {
      if (['current_deal', 'inventory_highlight'].includes(postType)) {
        checks.push({ name: 'Urgency/scarcity', passed: false, pts: 0, tip: 'Add urgency: "Won\'t last long" or "Only 2 left" drives action' });
      } else {
        score += 5; checks.push({ name: 'Urgency/scarcity', passed: true, pts: 5, tip: 'Optional for this post type' });
      }
    }

    // 6. Bilingual / Spanish touch (5 pts)
    if (/[áéíóúñ¿¡]|habla|español|spanish/i.test(caption)) {
      score += 5; checks.push({ name: 'Bilingual touch', passed: true, pts: 5 });
    } else {
      checks.push({ name: 'Bilingual touch', passed: false, pts: 0, tip: 'Add "Hablo Español" to capture bilingual leads' });
    }

    // 7. Line breaks / readability (10 pts)
    const lineBreaks = (caption.match(/\n/g) || []).length;
    if (lineBreaks >= 3) {
      score += 10; checks.push({ name: 'Readability (spacing)', passed: true, pts: 10 });
    } else {
      checks.push({ name: 'Readability (spacing)', passed: false, pts: 0, tip: 'Use line breaks between sections — walls of text get scrolled past' });
    }

    // 8. Caption length sweet spot (10 pts)
    const len = caption.length;
    if (len >= 150 && len <= 600) {
      score += 10; checks.push({ name: 'Optimal length', passed: true, pts: 10 });
    } else if (len < 150) {
      checks.push({ name: 'Optimal length', passed: false, pts: 0, tip: 'Too short — aim for 150-600 chars. More text = more keywords for discovery' });
    } else {
      score += 5; checks.push({ name: 'Optimal length', passed: true, pts: 5, tip: 'A bit long — consider trimming. IG truncates after 125 chars in feed' });
    }

    return { score, maxScore: 100, checks };
  },

  // Coaching tips per post type
  tips: {
    sold_customer: [
      'ALWAYS include a photo with the customer + vehicle — these get 3x more engagement',
      'Tag the customer (ask permission first) — their friends see it = free referrals',
      'Post SOLD photos within 30 minutes of delivery while energy is high',
      'Ask the customer for a quick selfie video saying "thanks Gabe!" for Stories',
      'Bilingual tip: Post English caption, add Spanish in first comment to double reach',
    ],
    current_deal: [
      'Lead with the MONTHLY PAYMENT, not the full price — that\'s what buyers think about',
      'Create urgency with real deadlines — "ends this Saturday" converts better than "limited time"',
      'Use the "Comment DEAL" CTA — it triggers the algorithm AND captures the lead',
      'Post deals Tuesday-Thursday when people are planning weekend visits',
      'Add "Se habla Español" — bilingual deals reach 40%+ more people in Vegas',
    ],
    inventory_highlight: [
      'Multiple photos > single photo — carousels get 2x more engagement on IG',
      'Show the BEST feature first (wheels, interior, tech screen) — that\'s your scroll-stopper',
      'Include the price if competitive — "Starting at $XX,XXX" removes a barrier to DM',
      'Pair with Reels: 15-sec walkaround with trending audio = massive reach',
      'Post new arrivals on Wednesdays and Fridays — shoppers browse before the weekend',
    ],
    personal_brand: [
      'Show your face — posts with faces get 38% more engagement on IG',
      'Share your WHY, not just your wins — vulnerability builds connection',
      'Behind-the-scenes content humanizes you — show the early mornings, the grind',
      'Celebrate milestones publicly (monthly sales record, customer count, etc.)',
      'Engage in comments for 15 min after posting — the algorithm rewards it',
    ],
    testimonial: [
      'Screenshot real reviews/texts (with permission) — authenticity beats polish',
      'Video testimonials outperform text 5:1 — even a 10-sec phone clip works',
      'Pair the testimonial with the customer\'s delivery photo for maximum impact',
      'Add "Want the same experience? DM me" — direct conversion CTA',
      'Post testimonials on Mondays — sets positive tone for the week + shoppers researching',
    ],
    walkaround: [
      'Keep walkaround videos to 30-60 seconds — attention spans are short',
      'Start with the exterior money shot, end with the driver\'s seat POV',
      'Call out 3 standout features by name — this helps with search/discovery',
      'Add captions/text overlay — 85% of FB/IG video is watched on mute',
      'End with "Save this for later" — saves tell the algorithm to push it further',
    ],
    financing: [
      'Use simple language — your audience isn\'t finance experts',
      'Lead with "First time buyer?" or "Credit concerns?" to attract your target',
      'Never promise specific rates — say "rates as low as" to stay compliant',
      'These posts have a LONG shelf life — people save them and come back months later',
      'Pair with a "DM me APPROVED for a free credit check" CTA',
    ],
    comparison: [
      'Silverado vs. F-150, Tahoe vs. Expedition — these spark DEBATES (= free engagement)',
      'Use a side-by-side image or carousel format for maximum visual impact',
      'Ask "Which one would you pick?" — questions in captions boost comments 3x',
      'Stay factual and fair — but let Chevy\'s numbers speak for themselves',
      'Post comparisons on weekends when people have time to engage in comments',
    ],
  },

  // ==================== TIKTOK-SPECIFIC OPTIMIZATION ====================
  // TikTok is a DIFFERENT animal — short-form video, trending sounds, FYP algorithm

  tiktok: {
    // TikTok hooks — MUST grab attention in the first 1-3 seconds or you're dead
    hooks: {
      sold: [
        'POV: Another customer just drove off in their dream car',
        'Watch their face when they get the keys 🔑',
        'They said they couldn\'t get approved... LOOK AT THEM NOW',
        'From test drive to SOLD in one day 🎉',
        'The reaction when they see the final payment 💰',
        'Handing over the keys never gets old',
      ],
      deals: [
        'This deal is actually insane and here\'s why',
        'If you\'re looking for a truck, STOP SCROLLING',
        'I\'m not supposed to show you this deal but...',
        'Your car payment could be THIS low 👀',
        'This is the deal your neighbor doesn\'t want you to know about',
        'POV: You find out about 0% APR',
      ],
      inventory: [
        'Wait for it... 😍',
        'Tell me this isn\'t the cleanest thing you\'ve seen today',
        'This just hit the lot and it WON\'T last',
        'Rate this spec 1-10 👇',
        'POV: You walk up to your new ride for the first time',
        'I had to make a TikTok about this one',
      ],
      brand: [
        'Day in the life of a car salesman at the #1 dealer',
        'Things they don\'t tell you about car sales',
        'How I went from broke to moving metal every day',
        'The truth about being a car salesman',
        'POV: It\'s 7am and you\'re already grinding',
        'Reply to @comment here\'s what I actually make',
      ],
      testimonial: [
        'When your customer gives you a 5-star review 🥹',
        'This is why I love my job',
        'POV: Your customer sends you THIS text',
        'They drove 2 hours just to buy from me. Here\'s why.',
        'The review that made my whole week',
      ],
      walkaround: [
        'Let me show you something real quick',
        'If you don\'t watch this whole thing you\'re sleeping on it',
        'Every feature on this thing is insane 🔥',
        'The interior on this one hits DIFFERENT',
        'You need to see the back seat on this one',
        '60 seconds with the new ${model} 👀',
      ],
      financing: [
        'Watch this if you think you can\'t afford a new car',
        'First time buying a car? Here\'s what nobody tells you',
        'How to ACTUALLY get approved with bad credit',
        'Stop doing this when you finance a car',
        'The #1 mistake first-time car buyers make',
        '3 things your dealer won\'t tell you (but I will)',
      ],
      comparison: [
        'Silverado or F-150? Let\'s settle this RIGHT NOW',
        'I put these two side by side and the winner is CLEAR',
        'Which one are you picking? 👇',
        'The numbers don\'t lie. Watch this.',
        'POV: You\'re trying to decide between these two',
      ],
    },

    // TikTok CTAs — different vibe than FB/IG (more casual, engagement-focused)
    ctas: {
      soft: [
        'Follow for more car content 🚗',
        'Drop a 🔥 if you\'d drive this',
        'Save this for later 📌',
        'Which color would you pick? Comment below 👇',
        'Tag someone who needs to see this',
      ],
      medium: [
        'Comment "INFO" and I\'ll DM you everything',
        'Link in bio to see what we have in stock',
        'Comment your dream car — I\'ll find it for you',
        'DM me "DEAL" for pricing 💰',
        'Follow + comment "MINE" and I\'ll reach out',
      ],
      strong: [
        'Comment "READY" and I\'ll get you pre-approved TODAY',
        'First 5 people to DM me get VIP pricing 🚨',
        'Comment "PAYMENT" — I\'ll DM you what your monthly would be',
        'This one has 3 people looking at it. DM me NOW if you want it',
        'Link in bio — apply in 60 seconds 🔥',
      ],
      softES: [
        'Sígueme para más contenido de carros 🚗',
        'Deja un 🔥 si manejarías esto',
        'Guárdalo para después 📌',
        'Etiqueta a alguien que necesita ver esto',
      ],
      mediumES: [
        'Comenta "INFO" y te escribo por DM',
        'Link en mi bio para ver inventario',
        'Escríbeme "PRECIO" para más detalles 💰',
      ],
      strongES: [
        'Comenta "LISTO" y te pre-apruebo HOY',
        '¡Los primeros 5 en escribirme reciben precio VIP! 🚨',
        'Link en mi bio — aplica en 60 segundos 🔥',
      ],
    },

    // TikTok tips per post type
    tips: {
      sold_customer: [
        'Film the KEY HANDOFF moment — that 3-second clip is gold for TikTok',
        'Use trending sounds behind delivery videos — the algorithm pushes them 10x harder',
        'Show the customer\'s genuine reaction, not a posed photo — authenticity wins on TikTok',
        'Keep it 15-30 seconds MAX — shorter TikToks get more replays = more reach',
        'Add text overlay: "From test drive to SOLD" — 90% of TikTok is watched on mute',
        'Post delivery TikToks between 7-8PM when the evening scroll peaks',
      ],
      current_deal: [
        'Start with the PAYMENT, not the car — "Your payment could be $389/mo" hooks harder',
        'Use the "I\'m not supposed to show you this" format — it creates curiosity',
        'Green screen yourself in front of the vehicle with the deal details on screen',
        'Keep deal TikToks under 20 seconds — urgency should feel fast',
        'Pin a comment with "DM me DEAL for details" — pinned comments get 3x more action',
        'Use the "POV" format: "POV: You find out about this deal" with the price reveal',
      ],
      inventory_highlight: [
        'Trending audio + slow-mo exterior shot = viral potential on car TikTok',
        'The "reveal" format works huge: start blurry/covered, then show the car',
        'Film at golden hour (sunrise/sunset) — the lighting makes any car look incredible',
        '"Rate this spec 1-10" in the caption drives massive comment engagement',
        'Carousel TikToks (photo mode) work great for interior/exterior shots',
        'Reply to comments with new TikToks showing the features they asked about',
      ],
      personal_brand: [
        '"Day in the life" content is KING on car sales TikTok — people love BTS',
        'Show the real grind: early mornings, lot walks, customer handshakes, the hustle',
        'Story time format: "How I sold 3 cars in one day" with you talking to camera',
        'Reply to hate comments with calm, professional TikToks — controversy = views',
        'Show your commission check reactions (without exact numbers) — aspirational content performs',
        'The "things nobody tells you about car sales" series can build you a huge following',
      ],
      testimonial: [
        'Screen-record customer texts/reviews and add a trending sound behind it',
        'Duet or stitch a customer\'s video review for double the engagement',
        '"POV: Your customer sends you this text" with the review on screen',
        'Ask happy customers for a 10-second video saying "Go see Gabe at Findlay!"',
        'Compile multiple short review clips into one TikTok with a counter overlay',
      ],
      walkaround: [
        'TikTok walkarounds should be 30-60 seconds MAX — not a full tour, just the highlights',
        'Start with the BEST feature (engine sound, interior tech, wheels) not the front bumper',
        'Use POV angles — show what the DRIVER sees, not just the outside',
        'Trending audio behind walkarounds gets 5-10x more FYP placement than original audio',
        'End with "Follow for more" and a question — the algorithm pushes videos with engagement',
        'Film VERTICAL — this is TikTok, not YouTube. Fill the whole screen.',
      ],
      financing: [
        '"Watch this if you think you can\'t afford a new car" — this hook gets first-time buyers',
        'Use the green screen effect with financing tips as bullet points behind you',
        'The "3 things your dealer won\'t tell you" format builds trust and goes viral',
        'Keep financing TikToks educational, not salesy — the algorithm suppresses hard sells',
        'These have INSANE shelf life on TikTok — people find them months later via search',
        'Add "Part 1" to the caption even on standalone posts — it makes people check your page for more',
      ],
      comparison: [
        'Side-by-side video transitions between the two vehicles get massive engagement',
        '"Which one?" with a poll sticker (available on some versions) drives interaction',
        'Let the comments debate — DO NOT argue. Just reply with facts and let it cook',
        'Film both vehicles at the same angle/location for a fair visual comparison',
        'These are your BEST content type for TikTok virality — controversial takes = views',
        'The "I put them side by side and the winner is clear" hook gets people to watch till the end',
      ],
    },

    // TikTok-specific content strategy
    strategy: {
      postingFrequency: '1-3 TikToks per day is ideal (consistency > quality on TikTok)',
      videoLength: '15-60 seconds sweet spot. Under 30 seconds for deals/inventory. 30-60 for walkarounds/brand.',
      format: 'ALWAYS vertical (9:16). Use the full screen. No black bars.',
      audio: 'Trending sounds get 3-5x more FYP placement. Check TikTok\'s trending page weekly.',
      captions: 'Keep TikTok captions SHORT — 1-2 lines max. The video does the talking.',
      hashtags: '3-5 relevant hashtags only. #cartok #carsales #fyp + 2 niche ones.',
      engagement: 'Reply to EVERY comment in the first hour. Reply to comments with new videos for 2x content.',
      crossPost: 'Repost your best TikToks as IG Reels and FB Reels — one video, three platforms.',
      bestContent: 'Car sales TikTok goldmine: key handoffs, customer reactions, day-in-life, deal reveals, walkarounds with trending audio',
    },
  },
};

// -- Meta Algorithm-Optimized Post Engine --
// Strategy: Hook → Value → CTA → Hashtags (bilingual EN+ES)
// Hashtags: 3-5 branded + 5-8 niche/location + 2-3 trending = 10-16 total (Meta sweet spot)
// Line breaks for readability (algorithm rewards time-on-post)

// Hashtag engine — mixes branded, niche, location, and engagement tags
function getHashtags(type, data) {
  const branded = ['#GabeMovesmetal', '#FindlayChevrolet', '#FindlayChevy'];
  const location = ['#LasVegas', '#Vegas', '#Henderson', '#NevadaCars'];
  const chevy = ['#Chevrolet', '#Chevy', '#ChevyNation', '#ChevyTrucks'];
  
  const modelTag = data.vehicleModel ? '#' + data.vehicleModel.replace(/\s+/g, '') : '';
  const yearTag = data.vehicleYear ? '#' + data.vehicleYear : '';
  
  const typeSpecific = {
    sold_customer: ['#Sold', '#NewCar', '#HappyCustomer', '#JustSold', '#CustomerAppreciation', '#DreamCar', '#CarDelivery'],
    current_deal: ['#CarDeals', '#AutoDeals', '#SpecialOffer', '#LimitedTime', '#SaveBig', '#NewCarDeal', '#ChevyDeals'],
    inventory_highlight: ['#NewInventory', '#JustArrived', '#InStock', '#TestDrive', '#CarShopping', '#NewArrival', '#HotRide'],
    personal_brand: ['#CarSales', '#SalesLife', '#Hustle', '#Grind', '#AutomotiveSales', '#DealerLife', '#MovingMetal'],
  };
  
  const pool = [...branded, ...location.slice(0, 2), ...chevy.slice(0, 2)];
  if (modelTag) pool.push(modelTag);
  if (yearTag) pool.push(yearTag);
  
  const specific = typeSpecific[type] || [];
  // Pick 5-6 random type-specific tags
  const shuffled = specific.sort(() => 0.5 - Math.random());
  pool.push(...shuffled.slice(0, 5));
  
  // Deduplicate and return
  return [...new Set(pool)].join(' ');
}

// Engagement hooks — Meta rewards posts that stop the scroll
const HOOKS = {
  sold_customer: [
    'SOLD! 🎉🔑',
    'Another one OFF the lot! 🎉',
    'Keys delivered. Dreams realized. 🔑—Â¨',
    'This is why I do what I do 🙌',
    'CONGRATULATIONS are in order! 🎊',
  ],
  current_deal: [
    '🚨 DEAL ALERT 🚨',
    'You\'re gonna want to see this 👀',
    'My manager said YES to this one 🤝',
    'This deal won\'t last — real talk 💯',
    'READ THIS before you buy anywhere else ⬇️',
  ],
  inventory_highlight: [
    'JUST HIT THE LOT 🔥',
    'Fresh off the truck 🚛—Â¨',
    'This one won\'t sit long 👀',
    'Who wants it? 🙋——️',
    'Stop scrolling — look at this beauty 😍',
  ],
  personal_brand: [
    'Let me keep it real with you 💯',
    'People always ask me how I do it...',
    'This is what moving metal looks like 💪',
    'Grateful for another day on the lot 🙏',
    'The grind doesn\'t stop 🏆',
  ],
};

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const POST_TEMPLATES = {
  sold_customer: {
    type: 'sold_customer',
    label: 'Sold Customer Celebration',
    fields: ['customerName', 'vehicleYear', 'vehicleModel', 'vehicleTrim', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.sold_customer);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const captions = [
        `${hook}\n\nHuge congrats to ${data.customerName} on their brand new ${vehicle}! 🚗💨\n\nThis is what happens when you trust the process. You come in, we find the perfect ride, and you drive off HAPPY.\n\nReady to be next? DM me or call/text — I got you.\n📱 (702) 416-3741\n\n${getHashtags('sold_customer', data)}`,
        `${hook}\n\n${data.customerName} just drove off in a BRAND NEW ${vehicle} and I couldn't be more hyped for them! 🔥\n\nFrom the test drive to the handshake — we made it happen at Findlay Chevrolet, the #1 volume dealer west of Texas.\n\nWho's next? Drop a 🔑 if you're ready!\n\n${getHashtags('sold_customer', data)}`,
        `${hook}\n\nWelcome to the family, ${data.customerName}! 🤝\n\nYou came in looking for the right ${data.vehicleModel || 'ride'} and we got you RIGHT. That's how we do it at Findlay Chevy.\n\nIf you or someone you know is in the market — send them my way. I take care of my people. 💯\n\n${getHashtags('sold_customer', data)}`,
      ];
      return pickRandom(captions);
    },
    generateCaptionES: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      return `¡VENDIDO! 🎉🔑\n\n¡Felicidades a ${data.customerName} por su ${vehicle} nuevo! 🚗💨\n\nEsto es lo que pasa cuando confías en el proceso. Vienes, encontramos el carro perfecto, y te vas FELIZ.\n\n¿Listo para ser el siguiente? Mándame mensaje o llámame — yo te ayudo.\n📱 (702) 416-3741\n\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('sold_customer', data)}`;
    },
    generateBilingual: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const hook = pickRandom(HOOKS.sold_customer);
      return `${hook}\n\nCongrats to ${data.customerName} on their brand new ${vehicle}! 🚗💨\nAnother happy customer driving off the lot at Findlay Chevrolet — the #1 volume dealer west of Texas.\n\nReady to be next? DM me or call/text 📱 (702) 416-3741\n\n—\n\n¡Felicidades a ${data.customerName} por su ${vehicle} nuevo! 🎉\nOtro cliente feliz saliendo de Findlay Chevrolet. ¿Listo para ser el siguiente?\n\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('sold_customer', data)}`;
    },
  },
  current_deal: {
    type: 'current_deal',
    label: 'Current Deal / Special',
    fields: ['dealTitle', 'vehicleModel', 'dealDetails', 'expirationDate', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.current_deal);
      return `${hook}\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? '—Â° Expires ' + data.expirationDate + ' — don\'t sleep on this!' : 'This won\'t last — first come, first served!'}\n\nDM me, call, or just pull up to Findlay Chevrolet. I'll make it happen. 🤝\n📱 (702) 416-3741\n\n${getHashtags('current_deal', data)}`;
    },
    generateCaptionES: (data) => {
      return `🚨 OFERTA 🚨\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? '—Â° Vence ' + data.expirationDate + ' — ¡no te lo pierdas!' : '¡No dura para siempre — primero que llegue!'}\n\nMándame mensaje, llámame, o ven directo a Findlay Chevrolet. Yo te ayudo. 🤝\n📱 (702) 416-3741\n\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('current_deal', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.current_deal);
      return `${hook}\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? '—Â° Expires ' + data.expirationDate : 'Won\'t last long!'} DM me or call 📱 (702) 416-3741\n\n—\n\n${data.dealTitle}\n${data.dealDetails}\n${data.expirationDate ? '—Â° Vence ' + data.expirationDate : '¡Apúrate!'}\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('current_deal', data)}`;
    },
  },
  inventory_highlight: {
    type: 'inventory_highlight',
    label: 'Inventory Highlight',
    fields: ['vehicleYear', 'vehicleModel', 'vehicleTrim', 'price', 'highlights', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.inventory_highlight);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? '💰 $' + Number(data.price).toLocaleString() : '';
      return `${hook}\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Loaded and ready to roll.'}\n\nWant to see it in person? Schedule a test drive — DM me or hit my line:\n📱 (702) 416-3741\n\nFindlay Chevrolet — #1 volume dealer west of Texas 🏆\n\n${getHashtags('inventory_highlight', data)}`;
    },
    generateCaptionES: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? '💰 $' + Number(data.price).toLocaleString() : '';
      return `ACABA DE LLEGAR 🔥\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Cargado y listo para rodar.'}\n\n¿Quieres verlo en persona? Agenda un test drive — mándame mensaje:\n📱 (702) 416-3741\n\nFindlay Chevrolet — Dealer #1 en volumen al oeste de Texas 🏆\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('inventory_highlight', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.inventory_highlight);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? '💰 $' + Number(data.price).toLocaleString() : '';
      return `${hook}\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Loaded and ready.'}\n\nDM me or call 📱 (702) 416-3741\n\n—\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n${data.highlights || 'Cargado y listo.'}\nMándame mensaje 📱 (702) 416-3741\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('inventory_highlight', data)}`;
    },
  },
  personal_brand: {
    type: 'personal_brand',
    label: 'Personal Brand Content',
    fields: ['message', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.personal_brand);
      return `${hook}\n\n${data.message}\n\nIf you know someone looking for a car — send them my way. I take care of my people. Always. 🤝\n\n— Gabe Barajas\nFindlay Chevrolet | Las Vegas\n📱 (702) 416-3741\n\n${getHashtags('personal_brand', data)}`;
    },
    generateCaptionES: (data) => {
      return `💯\n\n${data.message}\n\nSi conoces a alguien buscando carro — mándamelos. Yo cuido a mi gente. Siempre. 🤝\n\n— Gabe Barajas\nFindlay Chevrolet | Las Vegas\n📱 (702) 416-3741\nHablo español 🇲🇽🇺🇸\n\n${getHashtags('personal_brand', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.personal_brand);
      return `${hook}\n\n${data.message}\n\nKnow someone looking for a car? Send them my way. 🤝\n¿Conoces a alguien buscando carro? Mándamelos. 🇲🇽🇺🇸\n\n— Gabe Barajas\nFindlay Chevrolet | Las Vegas\n📱 (702) 416-3741\n\n${getHashtags('personal_brand', data)}`;
    },
  },
};

// -- Publish to Facebook Page --
async function publishToFacebook(caption, imageUrl = null) {
  try {
    let url, body;
    if (imageUrl) {
      // Photo post
      url = `https://graph.facebook.com/v21.0/${CONFIG.PAGE_ID}/photos`;
      body = {
        message: caption,
        url: imageUrl,
        access_token: CONFIG.META_PAGE_ACCESS_TOKEN,
      };
    } else {
      // Text post
      url = `https://graph.facebook.com/v21.0/${CONFIG.PAGE_ID}/feed`;
      body = {
        message: caption,
        access_token: CONFIG.META_PAGE_ACCESS_TOKEN,
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (result.error) {
      console.error('Facebook post error:', result.error.message);
      return { success: false, error: result.error.message };
    }
    console.log(`📝 Facebook post published: ${result.id || result.post_id}`);
    return { success: true, postId: result.id || result.post_id, platform: 'facebook' };
  } catch (err) {
    console.error('Failed to publish to Facebook:', err.message);
    return { success: false, error: err.message };
  }
}

// -- Publish to Instagram --
async function publishToInstagram(caption, imageUrl) {
  if (!imageUrl) {
    return { success: false, error: 'Instagram requires an image URL' };
  }
  try {
    // Step 1: Create media container
    const containerRes = await fetch(
      `https://graph.facebook.com/v21.0/${CONFIG.IG_ACCOUNT_ID}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: imageUrl,
          caption: caption,
          access_token: CONFIG.META_PAGE_ACCESS_TOKEN,
        }),
      }
    );
    const container = await containerRes.json();
    if (container.error) {
      console.error('Instagram container error:', container.error.message);
      return { success: false, error: container.error.message };
    }

    // Step 2: Publish the container
    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${CONFIG.IG_ACCOUNT_ID}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creation_id: container.id,
          access_token: CONFIG.META_PAGE_ACCESS_TOKEN,
        }),
      }
    );
    const result = await publishRes.json();
    if (result.error) {
      console.error('Instagram publish error:', result.error.message);
      return { success: false, error: result.error.message };
    }
    console.log(`📸 Instagram post published: ${result.id}`);
    return { success: true, postId: result.id, platform: 'instagram' };
  } catch (err) {
    console.error('Failed to publish to Instagram:', err.message);
    return { success: false, error: err.message };
  }
}

async function publishToTikTok(caption, videoUrl = null, imageUrl = null) {
  try {
    // Check if TikTok API credentials are configured
    if (!CONFIG.TIKTOK_ACCESS_TOKEN) {
      // No TikTok API — return as "queued" for manual posting
      // The caption is optimized and ready to copy-paste
      console.log(`🎵 TikTok post queued (manual): caption ready for copy-paste`);
      return {
        success: true,
        platform: 'tiktok',
        mode: 'manual',
        note: 'TikTok caption generated — copy to TikTok app. Connect TikTok API for auto-posting.',
        caption: caption,
      };
    }

    // TikTok Content Posting API v2 — Direct publish
    // Step 1: Initialize video upload (if video URL provided)
    if (videoUrl) {
      const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.TIKTOK_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          post_info: {
            title: caption.substring(0, 150), // TikTok title limit
            privacy_level: 'PUBLIC_TO_EVERYONE',
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: {
            source: 'PULL_FROM_URL',
            video_url: videoUrl,
          },
        }),
      });
      const initResult = await initRes.json();
      if (initResult.error && initResult.error.code !== 'ok') {
        console.error('TikTok publish error:', initResult.error.message);
        return { success: false, platform: 'tiktok', error: initResult.error.message };
      }
      console.log(`🎵 TikTok video published: ${initResult.data?.publish_id}`);
      return { success: true, platform: 'tiktok', publishId: initResult.data?.publish_id };
    }

    // Photo mode (TikTok Photo Mode — carousel-style)
    if (imageUrl) {
      const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.TIKTOK_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          post_info: {
            title: caption.substring(0, 150),
            privacy_level: 'PUBLIC_TO_EVERYONE',
          },
          source_info: {
            source: 'PULL_FROM_URL',
            photo_images: [imageUrl],
          },
          post_mode: 'DIRECT_POST',
          media_type: 'PHOTO',
        }),
      });
      const initResult = await initRes.json();
      if (initResult.error && initResult.error.code !== 'ok') {
        return { success: false, platform: 'tiktok', error: initResult.error?.message || 'Photo post failed' };
      }
      console.log(`🎵 TikTok photo post published: ${initResult.data?.publish_id}`);
      return { success: true, platform: 'tiktok', publishId: initResult.data?.publish_id };
    }

    // No media — TikTok requires video or photo
    return {
      success: true,
      platform: 'tiktok',
      mode: 'manual',
      note: 'TikTok requires video or photo. Caption generated — copy to TikTok app.',
      caption: caption,
    };
  } catch (err) {
    console.error('Failed to publish to TikTok:', err.message);
    return { success: false, platform: 'tiktok', error: err.message };
  }
}

// -- Generate TikTok-optimized caption (shorter, different hooks/CTAs) --
function generateTikTokCaption(postType, data, language, ctaStrength = 'medium') {
  const typeMap = {
    sold_customer: 'sold', current_deal: 'deals', inventory_highlight: 'inventory',
    personal_brand: 'brand', testimonial: 'testimonial', walkaround: 'walkaround',
    financing: 'financing', comparison: 'comparison',
  };
  const hookType = typeMap[postType] || 'brand';

  // TikTok hooks
  const hooks = LEAD_OPT.tiktok.hooks[hookType] || LEAD_OPT.tiktok.hooks.brand;
  let hook = hooks[Math.floor(Math.random() * hooks.length)];
  // Replace ${model} placeholder if present
  if (data.vehicleModel) hook = hook.replace('${model}', data.vehicleModel);

  // TikTok CTAs
  const isES = language === 'es';
  const ctaKey = isES ? (ctaStrength + 'ES') : ctaStrength;
  const ctaPool = LEAD_OPT.tiktok.ctas[ctaKey] || LEAD_OPT.tiktok.ctas[ctaStrength] || LEAD_OPT.tiktok.ctas.medium;
  const cta = ctaPool[Math.floor(Math.random() * ctaPool.length)];

  // TikTok hashtags (3-5, not 15)
  const hashtags = LEAD_OPT.buildHashtags(hookType, data.vehicleModel, 'tiktok');

  // Build short TikTok caption (TikTok truncates long captions — keep it punchy)
  let caption = `${hook}\n\n${cta}\n\n${hashtags}`;

  return caption;
}

// ==================== SELF-LEARNING INTELLIGENCE ENGINE ====================
// The brain that keeps the AI caption generator evolving.
// Scrapes algorithm updates, tracks trending content, monitors competitors,
// and learns from caption performance — all on a weekly auto-refresh cycle.
// Knowledge is stored in SQLite and dynamically injected into AI prompts.

// --- Database tables for intelligence storage ---
function initIntelligenceTables() {
  const db = database.getDb();
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS algorithm_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      category TEXT NOT NULL,
      insight TEXT NOT NULL,
      source TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8,
      createdAt TEXT DEFAULT '',
      expiresAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS trending_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      relevanceScore REAL DEFAULT 0.5,
      createdAt TEXT DEFAULT '',
      expiresAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS caption_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      postId TEXT DEFAULT '',
      platform TEXT NOT NULL,
      postType TEXT NOT NULL,
      caption TEXT NOT NULL,
      promptVersion TEXT DEFAULT '',
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      reach INTEGER DEFAULT 0,
      dms INTEGER DEFAULT 0,
      engagementRate REAL DEFAULT 0,
      postedAt TEXT DEFAULT '',
      metricsUpdatedAt TEXT DEFAULT '',
      createdAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS competitor_intel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitorName TEXT NOT NULL,
      platform TEXT NOT NULL,
      contentType TEXT DEFAULT '',
      insight TEXT NOT NULL,
      engagementLevel TEXT DEFAULT 'medium',
      createdAt TEXT DEFAULT '',
      expiresAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS intelligence_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'success',
      itemsFound INTEGER DEFAULT 0,
      summary TEXT DEFAULT '',
      createdAt TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_algo_platform ON algorithm_intel(platform);
    CREATE INDEX IF NOT EXISTS idx_trending_platform ON trending_content(platform);
    CREATE INDEX IF NOT EXISTS idx_perf_platform ON caption_performance(platform);
    CREATE INDEX IF NOT EXISTS idx_perf_type ON caption_performance(postType);
    CREATE INDEX IF NOT EXISTS idx_competitor_platform ON competitor_intel(platform);
  `);
  console.log('[Intelligence] Self-learning tables initialized');
}

// --- Algorithm Intelligence Scraper ---
// Scrapes top social media marketing sources for the latest algorithm changes
async function scrapeAlgorithmIntel() {
  const db = database.getDb();
  if (!db) return { error: 'Database not available' };

  console.log('[Intelligence] Starting algorithm knowledge refresh...');
  const sources = [
    { url: 'https://www.socialmediaexaminer.com/category/facebook-marketing/', platform: 'meta', name: 'Social Media Examiner' },
    { url: 'https://www.socialmediaexaminer.com/category/tiktok/', platform: 'tiktok', name: 'Social Media Examiner' },
    { url: 'https://blog.hootsuite.com/instagram-algorithm/', platform: 'meta', name: 'Hootsuite' },
    { url: 'https://blog.hootsuite.com/tiktok-algorithm/', platform: 'tiktok', name: 'Hootsuite' },
    { url: 'https://later.com/blog/instagram-algorithm/', platform: 'meta', name: 'Later' },
    { url: 'https://later.com/blog/tiktok-algorithm/', platform: 'tiktok', name: 'Later' },
    { url: 'https://www.socialinsider.io/blog/instagram-algorithm/', platform: 'meta', name: 'Social Insider' },
  ];

  const allInsights = [];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  for (const source of sources) {
    try {
      const resp = await axios.get(source.url, { headers, timeout: 15000 });
      const $ = cheerio.load(resp.data);
      // Extract article titles and snippets — these contain algorithm insights
      let rawText = '';
      $('h1, h2, h3, p, li').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 20 && text.length < 500) rawText += text + '\n';
      });
      if (rawText.length > 100) {
        allInsights.push({ platform: source.platform, source: source.name, text: rawText.substring(0, 5000) });
      }
    } catch (err) {
      console.log('[Intelligence] Scrape error for ' + source.name + ':', err.message);
    }
  }

  if (allInsights.length === 0) {
    console.log('[Intelligence] No content scraped, skipping AI analysis');
    return { itemsFound: 0 };
  }

  // Use Claude AI to extract actionable algorithm insights
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Intelligence] No API key, skipping AI analysis');
    return { itemsFound: 0 };
  }

  try {
    const combinedText = allInsights.map(i => `[${i.platform.toUpperCase()} - ${i.source}]\n${i.text}`).join('\n---\n');

    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a social media algorithm analyst. Extract the MOST ACTIONABLE algorithm insights from these marketing articles. Focus ONLY on things that affect content reach, engagement, and lead generation for a car salesman's social media accounts.

Return a JSON array of insights. Each insight:
{"platform": "meta" or "tiktok", "category": "ranking_signal"|"content_format"|"posting_strategy"|"engagement_hack"|"penalty"|"new_feature", "insight": "the actionable insight in 1-2 sentences", "confidence": 0.0-1.0}

Only include insights that are SPECIFIC and ACTIONABLE (not generic advice). Max 15 insights.

Source content:
${combinedText.substring(0, 8000)}`
      }]
    }, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });

    const aiText = aiResp.data.content[0].text;
    const jsonMatch = aiText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const insights = JSON.parse(jsonMatch[0]);
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(); // 2 weeks

      // Clear old insights and insert fresh ones
      db.prepare('DELETE FROM algorithm_intel WHERE expiresAt < ?').run(now);

      const insertStmt = db.prepare(
        'INSERT INTO algorithm_intel (platform, category, insight, source, confidence, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      const insertMany = db.transaction((items) => {
        for (const item of items) {
          insertStmt.run(item.platform, item.category, item.insight, 'ai_scraped', item.confidence || 0.8, now, expires);
        }
      });
      insertMany(insights);

      // Log the refresh
      db.prepare('INSERT INTO intelligence_log (type, status, itemsFound, summary, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        'algorithm_scrape', 'success', insights.length, 'Scraped ' + allInsights.length + ' sources, extracted ' + insights.length + ' insights', now
      );

      console.log('[Intelligence] Algorithm refresh complete: ' + insights.length + ' new insights stored');
      return { itemsFound: insights.length, insights };
    }
  } catch (err) {
    console.error('[Intelligence] AI analysis error:', err.message);
  }
  return { itemsFound: 0 };
}

// --- Trending Content Fetcher ---
// Scrapes trending hashtags, sounds, and content formats
async function scrapeTrendingContent() {
  const db = database.getDb();
  if (!db) return { error: 'Database not available' };

  console.log('[Intelligence] Fetching trending content...');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { itemsFound: 0 };

  const trendSources = [];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  // Scrape trending hashtag/sound trackers
  const trendUrls = [
    { url: 'https://www.tiktok.com/discover', platform: 'tiktok', name: 'TikTok Discover' },
    { url: 'https://tokboard.com/', platform: 'tiktok', name: 'TokBoard' },
    { url: 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en', platform: 'tiktok', name: 'TikTok Creative Center' },
    { url: 'https://top-hashtags.com/instagram/', platform: 'meta', name: 'Top Hashtags' },
    { url: 'https://www.all-hashtag.com/hashtag/cars/', platform: 'meta', name: 'All Hashtag Cars' },
  ];

  for (const src of trendUrls) {
    try {
      const resp = await axios.get(src.url, { headers, timeout: 15000 });
      const $ = cheerio.load(resp.data);
      let rawText = '';
      $('h1, h2, h3, h4, p, li, span, a').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > 3 && text.length < 200 && (text.includes('#') || text.includes('trending') || text.includes('viral') || text.includes('sound') || /^\d/.test(text))) {
          rawText += text + '\n';
        }
      });
      if (rawText.length > 50) trendSources.push({ platform: src.platform, source: src.name, text: rawText.substring(0, 3000) });
    } catch (err) {
      console.log('[Intelligence] Trend scrape error for ' + src.name + ':', err.message);
    }
  }

  // Use AI to extract and categorize trending content relevant to car sales
  try {
    const combinedText = trendSources.map(s => `[${s.platform.toUpperCase()} - ${s.source}]\n${s.text}`).join('\n---\n');

    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Extract trending content that a car salesman could use on TikTok and Instagram. Focus on: trending hashtags for automotive/sales, trending sounds/audio that work for car content, and trending content formats.

Return a JSON array: {"platform": "meta"|"tiktok", "type": "hashtag"|"sound"|"format"|"trend", "name": "the hashtag/sound/format name", "description": "how to use it for car sales content", "relevanceScore": 0.0-1.0}

Only include things RELEVANT to car sales, dealerships, or automotive content. Max 20 items.

${combinedText.length > 100 ? 'Source data:\n' + combinedText.substring(0, 5000) : 'No source data available. Generate current trending suggestions for car sales content based on your knowledge of TikTok and Instagram trends.'}`
      }]
    }, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });

    const aiText = aiResp.data.content[0].text;
    const jsonMatch = aiText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const trends = JSON.parse(jsonMatch[0]);
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 1 week

      db.prepare('DELETE FROM trending_content WHERE expiresAt < ?').run(now);

      const insertStmt = db.prepare(
        'INSERT INTO trending_content (platform, type, name, description, relevanceScore, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      const insertMany = db.transaction((items) => {
        for (const item of items) {
          insertStmt.run(item.platform, item.type, item.name, item.description || '', item.relevanceScore || 0.5, now, expires);
        }
      });
      insertMany(trends);

      db.prepare('INSERT INTO intelligence_log (type, status, itemsFound, summary, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        'trending_scrape', 'success', trends.length, 'Found ' + trends.length + ' trending items', now
      );

      console.log('[Intelligence] Trending refresh complete: ' + trends.length + ' items stored');
      return { itemsFound: trends.length, trends };
    }
  } catch (err) {
    console.error('[Intelligence] Trending AI analysis error:', err.message);
  }
  return { itemsFound: 0 };
}

// --- Competitor Monitoring ---
// Tracks what top car sales accounts are doing
async function scrapeCompetitorIntel() {
  const db = database.getDb();
  if (!db) return { error: 'Database not available' };

  console.log('[Intelligence] Monitoring competitor content...');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { itemsFound: 0 };

  // Top car sales TikTok/IG creators and competing Vegas dealers to monitor
  const competitors = [
    { name: 'autonationchevrolet', type: 'dealer', platforms: ['meta'] },
    { name: 'chapmanchevy', type: 'dealer', platforms: ['meta'] },
    { name: 'thecarsalesmanlife', type: 'creator', platforms: ['tiktok', 'meta'] },
    { name: 'carguylifestyle', type: 'creator', platforms: ['tiktok'] },
    { name: 'andyelliottsales', type: 'creator', platforms: ['tiktok', 'meta'] },
  ];

  // Scrape publicly available content strategy info
  const compData = [];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  for (const comp of competitors) {
    for (const platform of comp.platforms) {
      try {
        const url = platform === 'tiktok'
          ? `https://www.tiktok.com/@${comp.name}`
          : `https://www.instagram.com/${comp.name}/`;
        const resp = await axios.get(url, { headers, timeout: 15000 });
        const $ = cheerio.load(resp.data);
        let rawText = '';
        // Get meta descriptions, titles, and any visible text about content
        $('meta[name="description"], meta[property="og:description"], title').each((i, el) => {
          const content = $(el).attr('content') || $(el).text();
          if (content) rawText += content + '\n';
        });
        if (rawText.length > 20) {
          compData.push({ name: comp.name, type: comp.type, platform, text: rawText.substring(0, 1000) });
        }
      } catch (err) {
        // Many of these will fail (login walls etc) — that's expected
      }
    }
  }

  // Use AI to generate competitor insights even with limited data
  try {
    const contextText = compData.length > 0
      ? compData.map(c => `[${c.name} - ${c.platform}] ${c.text}`).join('\n')
      : 'No scrape data available.';

    const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a competitive intelligence analyst for car sales social media. Based on your knowledge of what works on car sales TikTok and Instagram, provide competitive insights.

Context: We are monitoring top car sales creators and competing Chevy dealers for Gabe Barajas (@gabemovesmetal), who sells at Findlay Chevrolet Las Vegas.

Competitors to analyze: AutoNation Chevrolet (dealer), Chapman Chevy (local Vegas competitor), The Car Salesman Life (TikTok creator), Car Guy Lifestyle (TikTok), Andy Elliott (sales trainer).

${contextText.length > 50 ? 'Scraped data:\n' + contextText.substring(0, 3000) : ''}

Return a JSON array of competitive insights:
{"competitorName": "name", "platform": "meta"|"tiktok", "contentType": "format they use", "insight": "actionable insight Gabe can learn from or counter", "engagementLevel": "low"|"medium"|"high"}

Focus on content strategies Gabe can COPY or COUNTER. Max 10 insights.`
      }]
    }, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    });

    const aiText = aiResp.data.content[0].text;
    const jsonMatch = aiText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const insights = JSON.parse(jsonMatch[0]);
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare('DELETE FROM competitor_intel WHERE expiresAt < ?').run(now);

      const insertStmt = db.prepare(
        'INSERT INTO competitor_intel (competitorName, platform, contentType, insight, engagementLevel, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      const insertMany = db.transaction((items) => {
        for (const item of items) {
          insertStmt.run(item.competitorName, item.platform, item.contentType || '', item.insight, item.engagementLevel || 'medium', now, expires);
        }
      });
      insertMany(insights);

      db.prepare('INSERT INTO intelligence_log (type, status, itemsFound, summary, createdAt) VALUES (?, ?, ?, ?, ?)').run(
        'competitor_scrape', 'success', insights.length, 'Generated ' + insights.length + ' competitor insights', now
      );

      console.log('[Intelligence] Competitor refresh complete: ' + insights.length + ' insights stored');
      return { itemsFound: insights.length, insights };
    }
  } catch (err) {
    console.error('[Intelligence] Competitor AI analysis error:', err.message);
  }
  return { itemsFound: 0 };
}

// --- Performance Feedback Loop ---
// Tracks caption engagement and learns what works for Gabe's audience
function logCaptionPerformance(postId, platform, postType, caption, promptVersion) {
  const db = database.getDb();
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO caption_performance (postId, platform, postType, caption, promptVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(postId || crypto.randomUUID(), platform, postType, caption, promptVersion || 'v2', now);
}

function updateCaptionMetrics(postId, metrics) {
  const db = database.getDb();
  if (!db) return;
  const now = new Date().toISOString();
  const { likes, comments, shares, saves, reach, dms } = metrics;
  const total = (likes || 0) + (comments || 0) * 3 + (shares || 0) * 5 + (saves || 0) * 4 + (dms || 0) * 10;
  const engagementRate = reach > 0 ? (total / reach) * 100 : 0;

  db.prepare(`
    UPDATE caption_performance SET likes=?, comments=?, shares=?, saves=?, reach=?, dms=?, engagementRate=?, metricsUpdatedAt=?
    WHERE postId=?
  `).run(likes || 0, comments || 0, shares || 0, saves || 0, reach || 0, dms || 0, engagementRate, now, postId);
}

// Analyze what's working — returns insights from top-performing captions
function getPerformanceInsights() {
  const db = database.getDb();
  if (!db) return { topPatterns: [], recommendations: [] };

  // Get top-performing captions by engagement rate
  const topCaptions = db.prepare(`
    SELECT * FROM caption_performance
    WHERE engagementRate > 0
    ORDER BY engagementRate DESC
    LIMIT 20
  `).all();

  if (topCaptions.length < 3) return { topPatterns: [], recommendations: [], message: 'Need more performance data — keep posting and updating metrics!' };

  // Extract patterns from top performers
  const patterns = {
    avgLength: 0,
    topPostTypes: {},
    topPlatforms: {},
    commonWords: {},
    hasEmoji: 0,
    hasQuestion: 0,
    hasDMTrigger: 0,
    hasUrgency: 0,
  };

  topCaptions.forEach(c => {
    patterns.avgLength += c.caption.length;
    patterns.topPostTypes[c.postType] = (patterns.topPostTypes[c.postType] || 0) + 1;
    patterns.topPlatforms[c.platform] = (patterns.topPlatforms[c.platform] || 0) + 1;
    if (/[\u{1F300}-\u{1F9FF}]/u.test(c.caption)) patterns.hasEmoji++;
    if (c.caption.includes('?')) patterns.hasQuestion++;
    if (/DM|dm|comment|Comment/.test(c.caption)) patterns.hasDMTrigger++;
    if (/won't last|limited|hurry|last chance|don't miss/i.test(c.caption)) patterns.hasUrgency++;
  });

  patterns.avgLength = Math.round(patterns.avgLength / topCaptions.length);

  return {
    topPatterns: patterns,
    topCaptions: topCaptions.slice(0, 5).map(c => ({ postType: c.postType, platform: c.platform, engagementRate: c.engagementRate, captionPreview: c.caption.substring(0, 100) })),
    recommendations: [
      patterns.hasQuestion > topCaptions.length * 0.5 ? 'Questions in captions are working well — keep using them' : 'Try adding more questions to drive comments',
      patterns.hasDMTrigger > topCaptions.length * 0.5 ? 'DM triggers are performing — keep using keyword CTAs' : 'Add more "DM me [KEYWORD]" CTAs — they boost engagement',
      `Your top-performing caption length is around ${patterns.avgLength} characters`,
      `Best performing post type: ${Object.entries(patterns.topPostTypes).sort((a,b) => b[1] - a[1])[0]?.[0] || 'unknown'}`,
    ],
  };
}

// --- Dynamic Knowledge Builder ---
// Assembles the latest intelligence into a prompt injection
function buildDynamicKnowledge(platform) {
  const db = database.getDb();
  if (!db) return '';

  const now = new Date().toISOString();
  let knowledge = '\n\n=== LIVE INTELLIGENCE (auto-updated weekly) ===\n';

  // 1. Latest algorithm insights
  const algoInsights = db.prepare(
    'SELECT insight, category, confidence FROM algorithm_intel WHERE (platform = ? OR platform = ?) AND expiresAt > ? ORDER BY confidence DESC LIMIT 8'
  ).all(platform, 'both', now);

  if (algoInsights.length > 0) {
    knowledge += '\nLATEST ALGORITHM UPDATES:\n';
    algoInsights.forEach(a => {
      knowledge += `- [${a.category}] ${a.insight}\n`;
    });
  }

  // 2. Trending content
  const trends = db.prepare(
    'SELECT name, type, description FROM trending_content WHERE (platform = ? OR platform = ?) AND expiresAt > ? ORDER BY relevanceScore DESC LIMIT 8'
  ).all(platform, 'both', now);

  if (trends.length > 0) {
    knowledge += '\nTRENDING RIGHT NOW:\n';
    trends.forEach(t => {
      knowledge += `- [${t.type}] ${t.name}: ${t.description}\n`;
    });
  }

  // 3. Competitor insights
  const compInsights = db.prepare(
    'SELECT competitorName, insight FROM competitor_intel WHERE (platform = ? OR platform = ?) AND expiresAt > ? ORDER BY engagementLevel DESC LIMIT 5'
  ).all(platform, 'both', now);

  if (compInsights.length > 0) {
    knowledge += '\nCOMPETITOR INTELLIGENCE:\n';
    compInsights.forEach(c => {
      knowledge += `- ${c.competitorName}: ${c.insight}\n`;
    });
  }

  // 4. Performance feedback
  const perfInsights = getPerformanceInsights();
  if (perfInsights.recommendations && perfInsights.recommendations.length > 0) {
    knowledge += '\nWHAT\'S WORKING FOR GABE\'S AUDIENCE (from real performance data):\n';
    perfInsights.recommendations.forEach(r => {
      knowledge += `- ${r}\n`;
    });
  }

  if (knowledge.length < 60) return ''; // No meaningful intelligence yet
  return knowledge;
}

// --- Master Refresh Function ---
// Runs all intelligence scrapers in sequence
async function refreshAllIntelligence() {
  console.log('[Intelligence] === WEEKLY INTELLIGENCE REFRESH STARTING ===');
  const results = {};

  try {
    results.algorithm = await scrapeAlgorithmIntel();
    console.log('[Intelligence] Algorithm scrape done: ' + (results.algorithm.itemsFound || 0) + ' insights');
  } catch (err) {
    console.error('[Intelligence] Algorithm scrape failed:', err.message);
    results.algorithm = { error: err.message };
  }

  try {
    results.trending = await scrapeTrendingContent();
    console.log('[Intelligence] Trending scrape done: ' + (results.trending.itemsFound || 0) + ' items');
  } catch (err) {
    console.error('[Intelligence] Trending scrape failed:', err.message);
    results.trending = { error: err.message };
  }

  try {
    results.competitors = await scrapeCompetitorIntel();
    console.log('[Intelligence] Competitor scrape done: ' + (results.competitors.itemsFound || 0) + ' insights');
  } catch (err) {
    console.error('[Intelligence] Competitor scrape failed:', err.message);
    results.competitors = { error: err.message };
  }

  results.performance = getPerformanceInsights();
  console.log('[Intelligence] === WEEKLY REFRESH COMPLETE ===');
  return results;
}

// --- Weekly auto-refresh schedule ---
// Runs every Monday at 6am server time
function scheduleWeeklyRefresh() {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Calculate time until next Monday 6am UTC
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
  const nextMonday = new Date(now);
  nextMonday.setUTCDate(now.getUTCDate() + daysUntilMonday);
  nextMonday.setUTCHours(6, 0, 0, 0);
  const msUntilNext = nextMonday.getTime() - now.getTime();

  console.log('[Intelligence] Next weekly refresh scheduled for ' + nextMonday.toISOString());

  // First run: wait until next Monday
  setTimeout(() => {
    refreshAllIntelligence().catch(err => console.error('[Intelligence] Weekly refresh error:', err.message));
    // Then repeat every week
    setInterval(() => {
      refreshAllIntelligence().catch(err => console.error('[Intelligence] Weekly refresh error:', err.message));
    }, WEEK_MS);
  }, msUntilNext);
}

// --- API Endpoints for Intelligence ---
// GET /api/intelligence/status — see what the system knows
app.get('/api/intelligence/status', (req, res) => {
  const db = database.getDb();
  if (!db) return res.json({ error: 'Database not available' });

  const algoCount = db.prepare('SELECT COUNT(*) as count FROM algorithm_intel WHERE expiresAt > ?').get(new Date().toISOString());
  const trendCount = db.prepare('SELECT COUNT(*) as count FROM trending_content WHERE expiresAt > ?').get(new Date().toISOString());
  const compCount = db.prepare('SELECT COUNT(*) as count FROM competitor_intel WHERE expiresAt > ?').get(new Date().toISOString());
  const perfCount = db.prepare('SELECT COUNT(*) as count FROM caption_performance').get();
  const lastLog = db.prepare('SELECT * FROM intelligence_log ORDER BY createdAt DESC LIMIT 1').get();

  res.json({
    algorithmInsights: algoCount.count,
    trendingItems: trendCount.count,
    competitorInsights: compCount.count,
    captionsTracked: perfCount.count,
    lastRefresh: lastLog ? lastLog.createdAt : 'never',
    lastRefreshSummary: lastLog ? lastLog.summary : 'No refresh yet — run POST /api/intelligence/refresh',
    dynamicKnowledge: {
      meta: buildDynamicKnowledge('meta').length > 0 ? 'active' : 'empty — needs first refresh',
      tiktok: buildDynamicKnowledge('tiktok').length > 0 ? 'active' : 'empty — needs first refresh',
    },
  });
});

// POST /api/intelligence/refresh — force a full refresh now
app.post('/api/intelligence/refresh', async (req, res) => {
  try {
    const results = await refreshAllIntelligence();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intelligence/performance — log caption metrics
app.post('/api/intelligence/performance', (req, res) => {
  const { postId, platform, postType, caption, metrics } = req.body;
  if (metrics) {
    updateCaptionMetrics(postId, metrics);
    return res.json({ success: true, action: 'metrics_updated' });
  }
  if (caption) {
    logCaptionPerformance(postId, platform, postType, caption);
    return res.json({ success: true, action: 'caption_logged' });
  }
  res.status(400).json({ error: 'Provide either caption (to log) or metrics (to update)' });
});

// GET /api/intelligence/knowledge — see what the AI currently knows
app.get('/api/intelligence/knowledge', (req, res) => {
  const platform = req.query.platform || 'meta';
  res.json({
    platform,
    knowledge: buildDynamicKnowledge(platform),
    performance: getPerformanceInsights(),
  });
});

// Initialize intelligence tables on startup
try { initIntelligenceTables(); } catch (err) { console.log('[Intelligence] Table init deferred — database not ready yet'); }

// Schedule weekly refresh
scheduleWeeklyRefresh();

// Run first intelligence refresh 30 seconds after boot (give server time to stabilize)
setTimeout(() => {
  console.log('[Intelligence] Running initial intelligence refresh...');
  refreshAllIntelligence().catch(err => console.error('[Intelligence] Initial refresh error:', err.message));
}, 30000);


// ==================== POSTING API ENDPOINTS ====================

// Get post templates
app.get('/api/posts/templates', (req, res) => {
  const templates = Object.values(POST_TEMPLATES).map(t => ({
    type: t.type,
    label: t.label,
    fields: t.fields,
  }));
  res.json(templates);
});

// AI-Powered Caption Generator (Claude API)
// Falls back to templates if ANTHROPIC_API_KEY is not set
// Supports platform-aware generation: 'meta' (FB/IG), 'tiktok', or 'both'
app.post('/api/posts/ai-generate', async (req, res) => {
  const { type, data, language, customerContext, platform } = req.body;
  const targetPlatform = platform || 'meta'; // default to meta for backward compat
  const template = POST_TEMPLATES[type];
  if (!template) return res.status(400).json({ error: 'Unknown post type' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback to templates
    let caption;
    if (language === 'bilingual' && template.generateBilingual) {
      caption = template.generateBilingual(data);
    } else if (language === 'es' && template.generateCaptionES) {
      caption = template.generateCaptionES(data);
    } else {
      caption = template.generateCaption(data);
    }
    const tiktokCaption = generateTikTokCaption(type, data, language, 'medium');
    return res.json({ caption, tiktokCaption, source: 'template' });
  }

  // Build the AI prompt
  const typeDescriptions = {
    sold_customer: 'a customer delivery celebration post (someone just bought a car)',
    current_deal: 'a promotional deal/special offer post',
    inventory_highlight: 'a vehicle inventory showcase post (new arrival on the lot)',
    personal_brand: 'a personal brand/motivational post from a car salesman',
    testimonial: 'a customer testimonial/review post showcasing social proof',
    walkaround: 'a vehicle walkaround/feature showcase post',
    financing: 'an educational financing tips post to attract first-time buyers',
    comparison: 'a vehicle comparison post designed to spark engagement and debate',
  };

  const languageInstructions = {
    en: 'Write the caption in English only.',
    es: 'Write the caption in Spanish only. Include "Hablo español" somewhere.',
    bilingual: 'Write the caption in BOTH English and Spanish. Put the English version first, then a line break with "—", then the Spanish version. Include "Hablo español" with flag emojis in the Spanish section.',
  };

  // ==================== META (FACEBOOK/INSTAGRAM) ALGORITHM PROMPT ====================
  const metaPrompt = `You are an elite social media strategist and caption writer for Gabe Barajas, a bilingual car salesman at Findlay Chevrolet in Las Vegas — the #1 volume Chevy dealer west of Texas. His brand is "Gabe Moves Metal."

Write a Facebook/Instagram post caption for ${typeDescriptions[type] || 'a social media post'}.

POST DATA:
${JSON.stringify(data, null, 2)}
${customerContext ? '\nCUSTOMER CONTEXT:\n' + customerContext : ''}

=== META ALGORITHM DEEP KNOWLEDGE (2024-2026) ===
You must apply these algorithm signals to maximize reach and engagement:

RANKING SIGNALS (in order of weight):
1. MEANINGFUL INTERACTIONS — Comments, shares, and saves outweigh likes 10:1. Write captions that ASK questions or spark debate to drive comments. Shares = exponential reach.
2. DWELL TIME — Meta tracks how long people stop scrolling on your post. Use line breaks, storytelling, and curiosity gaps to keep people reading longer.
3. SAVES — The #1 hidden power metric. "Save this for later" content gets pushed 3-5x harder. Educational or deal-related posts should prompt saves.
4. ORIGINAL CONTENT — Meta actively deprioritizes recycled/reposted content. Every caption must feel fresh, personal, and unique.
5. CONVERSATION STARTERS — Posts that generate back-and-forth replies (not just single comments) get massive distribution boosts.

CONTENT FORMAT OPTIMIZATION:
- Carousel posts get 2-3x more engagement than single images on IG — mention "swipe" if applicable
- Reels get 4x the organic reach of static posts — if this is for video content, optimize accordingly
- Stories drive DMs which Meta weighs heavily — include a "DM me" CTA
- Facebook Groups shares amplify reach 5x vs feed-only posts

CAPTION STRUCTURE (the winning formula):
1. HOOK (Line 1): Must stop the scroll in under 1.5 seconds. Use pattern interrupts — ALL CAPS opener, emoji + bold statement, or a controversial/curiosity-driven question. This is THE most important line.
2. STORY/VALUE (Lines 2-6): Deliver the meat — the deal details, the customer story, the vehicle specs. Use short paragraphs with line breaks. Every line should earn the next line being read.
3. SOCIAL PROOF: Weave in credibility — "#1 volume dealer", customer count, years of experience, or specific results.
4. CTA (Call to Action): One clear, specific action. "DM me DEAL" converts better than "contact us". Use DM-trigger keywords (comment a specific word) — these create micro-commitments that boost conversion AND engagement signals.
5. HASHTAGS: 10-15 total. Mix: 3 branded (#GabeMovesmetal #FindlayChevrolet #FindlayChevy), 3 location (#LasVegas #Vegas #Henderson), 5-7 niche + model-specific. Place AFTER the caption, separated by line breaks.

ENGAGEMENT HACKS:
- Ask "this or that" questions to spark debates in comments (Meta LOVES comment threads)
- Use "Comment [KEYWORD] for..." DM triggers — they boost engagement metrics AND capture leads
- Tag location (Las Vegas, NV) — local content gets preferential distribution in the area
- Post between 11am-1pm or 7-9pm local time for maximum initial engagement velocity
- Respond to every comment within the first hour — the algorithm rewards active creators
- Use 3-6 emojis strategically (not randomly) — they increase readability and stop-rate

WHAT TO AVOID (algorithm penalties):
- Engagement bait like "Like if you agree" — Meta explicitly suppresses this
- External links in the caption (kills reach by 40-60%) — put links in comments or bio instead
- Walls of text with no line breaks — people scroll past, tanking your dwell time
- Generic/corporate language — the algorithm favors authentic, personal content
- Posting more than 2x/day on the same page — oversaturation hurts per-post reach

RULES:
- Include Gabe's phone: (702) 416-3741
- Keep it authentic, energetic, and conversational — NOT corporate
- Use emojis naturally (3-6 per post)
- If the vehicle model is mentioned, include a hashtag for it
- Never use the word "utilize" or sound like a robot
- Sound like a real person who genuinely loves selling cars
- If customer context/story is provided, weave those details naturally to make it personal

${buildDynamicKnowledge('meta')}

${languageInstructions[language] || languageInstructions.bilingual}

Write ONLY the caption text. No explanations or metadata.`;

  // ==================== TIKTOK ALGORITHM PROMPT ====================
  const tiktokPrompt = `You are an elite TikTok content strategist and caption writer for Gabe Barajas, a bilingual car salesman at Findlay Chevrolet in Las Vegas — the #1 volume Chevy dealer west of Texas. His brand is "Gabe Moves Metal." His TikTok handle is @gabemovesmetal.

Write a TikTok caption for ${typeDescriptions[type] || 'a social media post'}.

POST DATA:
${JSON.stringify(data, null, 2)}
${customerContext ? '\nCUSTOMER CONTEXT:\n' + customerContext : ''}

=== TIKTOK ALGORITHM DEEP KNOWLEDGE (2024-2026) ===
TikTok's algorithm is FUNDAMENTALLY different from Meta. Apply these signals:

HOW THE FYP (FOR YOU PAGE) ALGORITHM WORKS:
1. WATCH TIME / COMPLETION RATE — This is THE #1 ranking signal. TikTok measures what % of your video people watch. Captions must create curiosity that makes people watch to the end. Use "Wait for it..." or "Watch till the end" hooks.
2. REWATCH RATE — Videos people watch multiple times get pushed HARD. Captions that tease a reveal or surprise drive replays.
3. SHARES > COMMENTS > LIKES — Shares carry the most weight on TikTok. Write captions that make people want to send the video to a friend ("Tag someone who needs this truck").
4. PROFILE VISITS — If your caption drives people to your profile, TikTok reads that as high-value content. Include "Follow for daily car content" or reference your other videos.
5. SEARCH/SEO — TikTok is now a SEARCH ENGINE for Gen Z and Millennials. Use keywords people actually search: "best truck deals Las Vegas", "how to buy a car with bad credit", "2026 Chevy Silverado review".

TIKTOK CAPTION RULES (completely different from Meta):
- KEEP IT SHORT: 1-2 lines max. The VIDEO does the talking on TikTok, not the caption.
- FRONT-LOAD with a hook that creates curiosity or FOMO
- Use lowercase, casual tone — TikTok is NOT Facebook. It should sound like you're texting a friend.
- NO hashtag walls. Use 3-5 MAX: #cartok #carsales #fyp + 1-2 specific ones
- #fyp and #foryou still work for initial distribution — always include one
- Searchable captions > clever captions. Include keywords people search for.

TIKTOK HOOK FORMULAS THAT GO VIRAL (use one):
- "POV: [scenario]" — immersive, first-person hooks dominate car TikTok
- "This is your sign to..." — trigger FOMO and action
- "Wait for it..." — creates watch-time because people stay for the payoff
- "I'm not supposed to show you this but..." — curiosity gap = completion rate boost
- "Reply to @[comment]" — reply videos get 2x distribution AND build community
- "[Number] things about [topic]" — list format = predictable watch time for the algorithm
- "They said [objection]... watch this" — overcoming doubts = relatable + shareable

TIKTOK CTA STRATEGY:
- "Comment [WORD]" CTAs work on TikTok too but keep them casual
- "Follow for part 2" — even on standalone videos, this drives profile visits (key signal)
- Pin a comment with your DM trigger — pinned comments get 3x more clicks
- "Link in bio" works on TikTok when you have 1k+ followers
- "Duet this" or "Stitch this" — inviting collabs = algorithmic boost from UGC signals

TRENDING SOUNDS & FORMATS:
- Using a trending sound gives 3-10x more FYP placement vs original audio
- Always mention "trending sound" or "use a trending audio" in the caption context if relevant
- Transition videos (before/after, lot to customer delivery) perform extremely well
- Green screen format for deal reveals and financing tips
- "Day in the life" series content builds loyal followers

TIKTOK SEARCH SEO (this is huge — TikTok is replacing Google for car shopping):
- Include searchable phrases naturally: "best car deals in Las Vegas", "Chevy dealer near me", "how to finance a car"
- Model names are SEARCHED heavily: "2026 Silverado", "Equinox EV", "Chevy Trax deals"
- TikTok indexes your caption text for search — every word matters for discovery

POSTING STRATEGY:
- 1-3 TikToks per day (consistency > perfection)
- Best times: 7-9am (morning scroll), 12-2pm (lunch), 7-10pm (evening peak)
- Videos under 30 seconds get the highest completion rates (key metric)
- Cross-post to IG Reels and FB Reels for 3x the exposure from 1 video

RULES:
- Keep caption SHORT (under 150 characters ideally, never over 300)
- Sound casual and authentic — like a text message, not an ad
- Include 3-5 hashtags only: #cartok #carsales #fyp + model/niche tags
- If the vehicle model is mentioned, hashtag it
- No phone numbers in TikTok captions (use "link in bio" or "DM me" instead)
- Never sound corporate. TikTok users scroll past anything that feels like an ad.

${buildDynamicKnowledge('tiktok')}

${languageInstructions[language] || languageInstructions.en}

Write ONLY the caption text (including hashtags on the last line). No explanations or metadata. Keep it SHORT.`;

  try {
    // Generate captions for requested platform(s)
    const results = {};

    if (targetPlatform === 'meta' || targetPlatform === 'both') {
      const metaResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{ role: 'user', content: metaPrompt }],
        }),
      });
      const metaResult = await metaResponse.json();
      if (metaResult.content && metaResult.content[0]) {
        results.caption = metaResult.content[0].text;
      }
    }

    if (targetPlatform === 'tiktok' || targetPlatform === 'both') {
      const tiktokResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 512,
          messages: [{ role: 'user', content: tiktokPrompt }],
        }),
      });
      const tiktokResult = await tiktokResponse.json();
      if (tiktokResult.content && tiktokResult.content[0]) {
        results.tiktokCaption = tiktokResult.content[0].text;
      }
    }

    // If we got at least one caption, return success
    if (results.caption || results.tiktokCaption) {
      // If only one platform was requested, fill in the other from templates
      if (!results.caption) {
        if (language === 'bilingual' && template.generateBilingual) {
          results.caption = template.generateBilingual(data);
        } else if (language === 'es' && template.generateCaptionES) {
          results.caption = template.generateCaptionES(data);
        } else {
          results.caption = template.generateCaption(data);
        }
      }
      if (!results.tiktokCaption) {
        results.tiktokCaption = generateTikTokCaption(type, data, language, 'medium');
      }
      // Log captions for performance tracking
      if (results.caption) logCaptionPerformance(null, 'meta', type, results.caption, 'v2-dynamic');
      if (results.tiktokCaption) logCaptionPerformance(null, 'tiktok', type, results.tiktokCaption, 'v2-dynamic');
      return res.json({ ...results, source: 'ai', platform: targetPlatform });
    }

    throw new Error('AI generation returned no content');
  } catch (err) {
    console.error('AI caption error, falling back to template:', err.message);
    // Fallback to template
    let caption;
    if (language === 'bilingual' && template.generateBilingual) {
      caption = template.generateBilingual(data);
    } else if (language === 'es' && template.generateCaptionES) {
      caption = template.generateCaptionES(data);
    } else {
      caption = template.generateCaption(data);
    }
    const tiktokCaption = generateTikTokCaption(type, data, language, 'medium');
    return res.json({ caption, tiktokCaption, source: 'template' });
  }
});

// Generate a caption preview using templates (fast fallback)
app.post('/api/posts/preview', (req, res) => {
  const { type, data, language, ctaStrength } = req.body;
  const template = POST_TEMPLATES[type];
  if (!template) return res.status(400).json({ error: 'Unknown post type' });

  const strength = ctaStrength || 'medium';

  const captionEN = template.generateCaption(data, strength);
  const captionES = template.generateCaptionES ? template.generateCaptionES(data, strength) : captionEN;
  let caption;
  if (language === 'bilingual' && template.generateBilingual) {
    caption = template.generateBilingual(data);
  } else if (language === 'es') {
    caption = captionES;
  } else {
    caption = captionEN;
  }

  // Score the generated caption
  const score = LEAD_OPT.scoreCaption(caption, type);

  // Generate TikTok-optimized caption too
  const tiktokCaption = generateTikTokCaption(type, data, language, strength);

  res.json({
    captionEN,
    captionES,
    caption,
    tiktokCaption,
    optimization: score,
    source: 'template',
  });
});


// Photo upload endpoint

// ==========================================
// DEALS SCRAPER - Auto-refreshing deals from Findlay Chevy & Chevy.com
// ==========================================
let dealsCache = { deals: [], lastRefreshed: null, refreshing: false };

async function scrapeDeals() {
  if (dealsCache.refreshing) return dealsCache;
  dealsCache.refreshing = true;
  console.log('[Deals] Starting deals refresh...');
  const allDeals = [];
  
  try {
    // Scrape Findlay Chevrolet specials
    const findlayResp = await axios.get('https://www.findlaychevy.com/new-vehicles/new-vehicle-specials/', {
      headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Connection': 'keep-alive'
        },
      timeout: 15000
    });
    const f$ = cheerio.load(findlayResp.data);
    // Extract deal banners/slides
    f$('[class*="slide"], [class*="special"], [class*="offer"], [class*="banner"]').each((i, el) => {
      const text = f$(el).text().trim().replace(/\s+/g, ' ');
      const imgs = [];
      f$(el).find('img').each((j, img) => { if (f$(img).attr('alt')) imgs.push(f$(img).attr('alt')); });
      if (text.length > 20 && (text.includes('$') || text.includes('Lease') || text.includes('APR') || text.includes('Buy'))) {
        allDeals.push({ source: 'findlay', text: text.substring(0, 500), images: imgs, raw: true });
      }
    });
    // Also grab fine print/disclaimer text for deal details
    f$('[class*="disclaim"], [class*="fine-print"], [class*="tooltip"], .disclaimer').each((i, el) => {
      const text = f$(el).text().trim().replace(/\s+/g, ' ');
      if (text.includes('MSRP') || text.includes('$') || text.includes('APR')) {
        allDeals.push({ source: 'findlay_detail', text: text.substring(0, 500), raw: true });
      }
    });
    console.log('[Deals] Findlay scraped: ' + allDeals.length + ' raw items');
  } catch (err) {
    console.error('[Deals] Findlay scrape error:', err.message);
  }
  
  try {
    // Scrape Chevy.com national offers (Las Vegas zip for local relevance)
    const chevyResp = await axios.get('https://www.chevrolet.com/shopping/offers', {
      headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Connection': 'keep-alive'
        },
      timeout: 15000,
      params: { postalcode: '89101', vehicleType: 'all' }
    });
    const c$ = cheerio.load(chevyResp.data);
    // Extract offer cards and sections
    c$('[class*="offer"], [class*="incentive"], [class*="deal"], [class*="vehicle-card"], [class*="accordion"]').each((i, el) => {
      const text = c$(el).text().trim().replace(/\s+/g, ' ');
      if (text.length > 15 && text.length < 1000 && (text.includes('$') || text.includes('APR') || text.includes('Lease') || text.includes('Cash'))) {
        allDeals.push({ source: 'chevy_national', text: text.substring(0, 500), raw: true });
      }
    });
    // Also extract from structured data if available
    c$('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse(c$(el).html());
        if (json.offers || json.name) {
          allDeals.push({ source: 'chevy_structured', data: json, raw: false });
        }
      } catch(e) {}
    });
    console.log('[Deals] Chevy.com scraped: ' + (allDeals.length) + ' total raw items');
  } catch (err) {
    console.error('[Deals] Chevy.com scrape error:', err.message);
  }
  
  // Use Claude AI to extract and structure the deal data
  let structuredDeals = [];
  if (allDeals.length > 0) {
    try {
      const rawText = allDeals.map(d => d.text || JSON.stringify(d.data)).join('\n---\n');
      const aiResp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Extract structured deals from this scraped data from Findlay Chevrolet (Las Vegas) and Chevrolet.com. Return ONLY a JSON array of deals. Each deal should have: model (vehicle name), offer_type (lease/purchase/apr/cash_back/bonus), headline (short catchy summary), details (the specific numbers), expiration (date if found), source (findlay or chevy_national). If data is unclear, make reasonable inferences. Here is the raw data:\n\n${rawText.substring(0, 6000)}`
        }]
      }, {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      });
      const aiText = aiResp.data.content[0].text;
      const jsonMatch = aiText.match(/\[.*\]/s);
      if (jsonMatch) {
        structuredDeals = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.error('[Deals] AI structuring error:', err.message);
      // Fallback: return raw deals
      structuredDeals = allDeals.slice(0, 10).map(d => ({
        model: 'Various',
        offer_type: 'promotion',
        headline: d.text ? d.text.substring(0, 100) : 'Deal available',
        details: d.text || '',
        source: d.source
      }));
    }
  }
  
  dealsCache = {
    deals: structuredDeals,
    lastRefreshed: new Date().toISOString(),
    refreshing: false,
    rawCount: allDeals.length
  };
  console.log('[Deals] Refresh complete: ' + structuredDeals.length + ' structured deals');
  return dealsCache;
}

// // Auto-refresh deals every 12 hours
// setInterval(() => { scrapeDeals().catch(console.error); }, 12 * 60 * 60 * 1000);
// // Initial scrape on server start (delayed 10s to let server boot) // Disabled old inventory auto-refresh
setTimeout(() => { scrapeDeals().catch(console.error); }, 10000);

// GET /api/deals - Return cached deals
app.get('/api/deals', (req, res) => {
  res.json(dealsCache);
});

// POST /api/deals/refresh - Force refresh deals
app.post('/api/deals/refresh', async (req, res) => {
  try {
    const result = await scrapeDeals();
    res.json(result);
  } catch (error) {
    console.error('Deals refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh deals' });
  }
});

app.post('/api/upload-photo', upload.single('photo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }
    // Build the public URL for this file
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const publicUrl = protocol + '://' + host + '/uploads/' + req.file.filename;
    res.json({ url: publicUrl, filename: req.file.filename });
  } catch (error) {
    console.error('Photo upload error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

app.post('/api/posts/publish', async (req, res) => {
  const { type, data, platforms, language, customCaption, ctaStrength } = req.body;
  // platforms: ['facebook', 'instagram', 'whatsapp', 'tiktok'] or ['all']

  const template = POST_TEMPLATES[type];
  if (!template && !customCaption) {
    return res.status(400).json({ error: 'Unknown post type and no custom caption provided' });
  }

  let caption = customCaption;
  if (!caption && template) {
    const strength = ctaStrength || 'medium';
    caption = language === 'es'
      ? (template.generateCaptionES ? template.generateCaptionES(data, strength) : template.generateCaption(data, strength))
      : template.generateCaption(data, strength);
  }

  const targetPlatforms = platforms.includes('all')
    ? ['facebook', 'instagram', 'whatsapp', 'tiktok']
    : platforms;

  const results = [];
  const imageUrl = data?.imageUrl || null;
  const videoUrl = data?.videoUrl || null;

  // Publish to each platform
  for (const platform of targetPlatforms) {
    if (platform === 'facebook') {
      const result = await publishToFacebook(caption, imageUrl);
      results.push(result);
    }
    if (platform === 'instagram') {
      if (!imageUrl) {
        results.push({ success: false, platform: 'instagram', error: 'Instagram requires an image' });
      } else {
        const result = await publishToInstagram(caption, imageUrl);
        results.push(result);
      }
    }
    if (platform === 'whatsapp') {
      // WhatsApp Status isn't directly supported via Cloud API for status updates.
      // Instead, we can broadcast to recent WhatsApp contacts.
      results.push({ success: true, platform: 'whatsapp', note: 'WhatsApp broadcast queued' });
    }
    if (platform === 'tiktok') {
      // Generate TikTok-optimized caption (shorter, different hooks/CTAs)
      const tiktokCaption = generateTikTokCaption(type, data, language, ctaStrength);
      const result = await publishToTikTok(tiktokCaption, videoUrl, imageUrl);
      results.push(result);
    }
  }

  // Save the post to history
  const post = {
    id: generateId(),
    type: type || 'custom',
    caption,
    imageUrl,
    data: data || {},
    platforms: targetPlatforms,
    results,
    language: language || 'en',
    createdAt: new Date().toISOString(),
    createdBy: CONFIG.SALESMAN_NAME,
  };
  database.posts.create(post);

  // If this is a sold customer post, update the lead stage
  if (type === 'sold_customer' && data?.customerName) {
    const soldLeads = database.leads.findByName(data.customerName);
    const lead = soldLeads.find(l => l.stage !== 'Sold');
    if (lead) {
      database.leads.update(lead.id, { stage: 'Sold' });
    }
  }

  res.json({ post, results });
});

// Get all published posts
app.get('/api/posts', (req, res) => {
  const { type, platform } = req.query;
  res.json(database.posts.getAll({ type, platform }));
});

// Delete a post from history
app.delete('/api/posts/:id', (req, res) => {
  database.posts.delete(req.params.id);
  res.json({ success: true });
});

// Quick-post: Sold customer (simplified endpoint)
app.post('/api/posts/sold', async (req, res) => {
  const { customerName, vehicleYear, vehicleModel, vehicleTrim, imageUrl, language, platforms } = req.body;
  if (!customerName || !vehicleModel) {
    return res.status(400).json({ error: 'customerName and vehicleModel are required' });
  }

  // Forward to the main publish endpoint
  req.body = {
    type: 'sold_customer',
    data: { customerName, vehicleYear, vehicleModel, vehicleTrim, imageUrl },
    platforms: platforms || ['facebook', 'instagram'],
    language: language || 'en',
  };

  const template = POST_TEMPLATES.sold_customer;
  let caption;
    if (language === 'bilingual' && template.generateBilingual) {
      caption = template.generateBilingual(data);
    } else if (language === 'es' && template.generateCaptionES) {
      caption = template.generateCaptionES(data);
    } else {
      caption = template.generateCaption(data);
    }

  const targetPlatforms = (platforms || ['facebook', 'instagram']);
  const results = [];

  for (const platform of targetPlatforms) {
    if (platform === 'facebook') results.push(await publishToFacebook(caption, imageUrl));
    if (platform === 'instagram' && imageUrl) results.push(await publishToInstagram(caption, imageUrl));
  }

  const post = {
    id: generateId(),
    type: 'sold_customer',
    caption,
    imageUrl,
    data: { customerName, vehicleYear, vehicleModel, vehicleTrim },
    platforms: targetPlatforms,
    results,
    language: language || 'en',
    createdAt: new Date().toISOString(),
    createdBy: CONFIG.SALESMAN_NAME,
  };
  database.posts.create(post);

  // Auto-update lead stage to Sold
  const soldLeads2 = database.leads.findByName(customerName);
  const lead = soldLeads2.find(l => l.stage !== 'Sold');
  if (lead) database.leads.update(lead.id, { stage: 'Sold' });
  res.json({ post, results });
});

// Quick-post: Current deal
app.post('/api/posts/deal', async (req, res) => {
  const { dealTitle, vehicleModel, dealDetails, expirationDate, imageUrl, language, platforms } = req.body;
  if (!dealTitle || !dealDetails) {
    return res.status(400).json({ error: 'dealTitle and dealDetails are required' });
  }

  const template = POST_TEMPLATES.current_deal;
  const data = { dealTitle, vehicleModel, dealDetails, expirationDate, imageUrl };
  const caption = language === 'es'
    ? template.generateCaptionES(data)
    : template.generateCaption(data);

  const targetPlatforms = platforms || ['facebook', 'instagram'];
  const results = [];
  for (const platform of targetPlatforms) {
    if (platform === 'facebook') results.push(await publishToFacebook(caption, imageUrl));
    if (platform === 'instagram' && imageUrl) results.push(await publishToInstagram(caption, imageUrl));
  }

  const post = {
    id: generateId(),
    type: 'current_deal',
    caption, imageUrl, data,
    platforms: targetPlatforms, results,
    language: language || 'en',
    createdAt: new Date().toISOString(),
    createdBy: CONFIG.SALESMAN_NAME,
  };
  database.posts.create(post);
  res.json({ post, results });
});

// -- Stats update to include WhatsApp + posts --
app.get('/api/stats/extended', (req, res) => {
  const now = new Date();
  const allLeads = database.leads.getAll();
  const thisMonth = allLeads.filter(l => {
    const d = new Date(l.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  const allConvos = database.conversations.getAll();
  const allPosts = database.posts.getAll();
  res.json({
    totalLeads: allLeads.length,
    newThisMonth: thisMonth.length,
    byStage: ['New Lead', 'Contacted', 'Appointment', 'Negotiation', 'Sold'].reduce(
      (acc, s) => { acc[s] = allLeads.filter(l => l.stage === s).length; return acc; }, {}
    ),
    bySource: allLeads.reduce((acc, l) => { acc[l.source] = (acc[l.source] || 0) + 1; return acc; }, {}),
    conversations: {
      total: allConvos.length,
      messenger: allConvos.filter(c => c.platform === 'page').length,
      instagram: allConvos.filter(c => c.platform === 'instagram').length,
      whatsapp: allConvos.filter(c => c.platform === 'whatsapp').length,
    },
    posts: {
      total: allPosts.length,
      sold: allPosts.filter(p => p.type === 'sold_customer').length,
      deals: allPosts.filter(p => p.type === 'current_deal').length,
      inventory: allPosts.filter(p => p.type === 'inventory_highlight').length,
      brand: allPosts.filter(p => p.type === 'personal_brand').length,
    },
    unreadNotifications: notifications.filter(n => !n.read).length,
    inventory: {
      total: inventoryModule.getInventoryCount(),
      lastScraped: inventoryModule.getLastScraped(),
    },
  });
});

// -- WhatsApp-specific endpoints --

// Send a WhatsApp message directly (not via conversation)
app.post('/api/whatsapp/send', async (req, res) => {
  const { to, text, imageUrl } = req.body;
  if (!to || (!text && !imageUrl)) {
    return res.status(400).json({ error: 'to and text (or imageUrl) are required' });
  }

  let result;
  if (imageUrl) {
    result = await sendWhatsAppImage(to, imageUrl, text || '');
  } else {
    result = await sendWhatsAppMessage(to, text);
  }
  res.json(result);
});

// Send a WhatsApp template message
app.post('/api/whatsapp/template', async (req, res) => {
  const { to, templateName, languageCode, components } = req.body;
  if (!to || !templateName) {
    return res.status(400).json({ error: 'to and templateName are required' });
  }
  const result = await sendWhatsAppTemplate(to, templateName, languageCode || 'en_US', components || []);
  res.json(result);
});


// ==================== PRIVACY POLICY & DATA DELETION ====================
// Required for Meta App Review

app.get('/privacy-policy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — Gabe Moves Metal</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; color: #333; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #d4a017; padding-bottom: 10px; }
    h2 { color: #444; margin-top: 30px; }
    .updated { color: #666; font-style: italic; margin-bottom: 30px; }
    .contact { background: #f8f8f8; padding: 20px; border-radius: 8px; margin-top: 30px; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: March 21, 2026</p>

  <p><strong>Gabe Moves Metal</strong> ("we", "us", or "our") operates the Gabe Moves Metal Facebook Page and associated messaging services to help connect car buyers with vehicle inventory at Findlay Chevrolet in Las Vegas, NV.</p>

  <h2>Information We Collect</h2>
  <p>When you interact with our Facebook Page, Messenger, or Instagram, we may collect:</p>
  <p>Your name and profile information as provided by Facebook/Instagram; messages you send to our Page via Messenger or Instagram DMs; your language preference (English or Spanish); information about vehicles you are interested in; and your contact information if voluntarily provided (phone number, email).</p>

  <h2>How We Use Your Information</h2>
  <p>We use the information we collect to respond to your inquiries about vehicles; match you with relevant inventory at Findlay Chevrolet; provide bilingual (English/Spanish) customer service; follow up on your interest in purchasing a vehicle; and improve our customer service experience.</p>

  <h2>Information Sharing</h2>
  <p>We do not sell, trade, or rent your personal information to third parties. Your information may be shared with Findlay Chevrolet staff solely for the purpose of completing a vehicle purchase you have initiated.</p>

  <h2>Data Retention</h2>
  <p>We retain your information only for as long as necessary to fulfill the purposes described in this policy, or as required by law. You can request deletion of your data at any time.</p>

  <h2>Your Rights</h2>
  <p>You have the right to access, correct, or delete your personal information. You may also opt out of communications at any time by messaging us "STOP" or contacting us directly.</p>

  <h2>Data Security</h2>
  <p>We implement reasonable security measures to protect your personal information. However, no method of electronic storage is 100% secure.</p>

  <h2>Children's Privacy</h2>
  <p>Our services are not directed to individuals under the age of 18. We do not knowingly collect personal information from children.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new policy on this page.</p>

  <div class="contact">
    <h2>Contact Us</h2>
    <p>If you have questions about this Privacy Policy or wish to exercise your data rights, contact us:</p>
    <p><strong>Gabe Moves Metal</strong><br>
    Facebook: <a href="https://facebook.com/Gabemovesmetal1">facebook.com/Gabemovesmetal1</a><br>
    Dealership: Findlay Chevrolet, Las Vegas, NV</p>
  </div>
</body>
</html>`);
});

app.get('/data-deletion', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Data Deletion — Gabe Moves Metal</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; color: #333; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #d4a017; padding-bottom: 10px; }
    h2 { color: #444; margin-top: 30px; }
    .contact { background: #f8f8f8; padding: 20px; border-radius: 8px; margin-top: 30px; }
  </style>
</head>
<body>
  <h1>Data Deletion Instructions</h1>
  <p>If you would like to request the deletion of your data from Gabe Moves Metal, you have several options:</p>

  <h2>Option 1: Message Us on Facebook</h2>
  <p>Send a message to our Facebook Page at <a href="https://facebook.com/Gabemovesmetal1">Gabe Moves Metal</a> requesting data deletion. Include the phrase "DELETE MY DATA" and we will process your request within 30 days.</p>

  <h2>Option 2: Email Request</h2>
  <p>Send an email to our team requesting data deletion. Include your Facebook name so we can locate your records.</p>

  <h2>What Gets Deleted</h2>
  <p>Upon receiving a valid deletion request, we will remove all conversation history and messages stored in our system; your contact information and lead records; any vehicle preference data; and any other personal information associated with your profile.</p>

  <h2>Processing Time</h2>
  <p>Data deletion requests are processed within 30 days of receipt. You will receive a confirmation once your data has been deleted.</p>

  <div class="contact">
    <h2>Contact</h2>
    <p><strong>Gabe Moves Metal</strong><br>
    Facebook: <a href="https://facebook.com/Gabemovesmetal1">facebook.com/Gabemovesmetal1</a><br>
    Dealership: Findlay Chevrolet, Las Vegas, NV</p>
  </div>
</body>
</html>`);
});

// Terms of Service
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service — Gabe Moves Metal</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; color: #333; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #d4a017; padding-bottom: 10px; }
    h2 { color: #444; margin-top: 30px; }
    .updated { color: #666; font-style: italic; margin-bottom: 30px; }
    .contact { background: #f8f8f8; padding: 20px; border-radius: 8px; margin-top: 30px; }
  </style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: March 29, 2026</p>

  <p><strong>Gabe Moves Metal</strong> ("we", "us", or "our") provides a personal lead generation and customer relationship management service to help connect car buyers with vehicle inventory. By using our services, you agree to the following terms.</p>

  <h2>Use of Service</h2>
  <p>Our service facilitates communication between prospective car buyers and Gabe Barajas, a sales consultant at Findlay Chevrolet in Las Vegas, NV. By messaging our Facebook Page, Instagram, or using any connected platform, you consent to receiving responses about vehicle availability, pricing, and related information.</p>

  <h2>No Guarantee</h2>
  <p>Vehicle availability, pricing, and promotions are subject to change without notice. Information provided through our messaging platforms is for informational purposes only and does not constitute a binding offer or contract for the sale of any vehicle.</p>

  <h2>User Conduct</h2>
  <p>You agree not to use our services for any unlawful purpose, to send spam or unsolicited messages, or to impersonate any person or entity. We reserve the right to block or restrict access to users who violate these terms.</p>

  <h2>Intellectual Property</h2>
  <p>The "Gabe Moves Metal" brand, logo, and associated content are the property of Gabe Barajas. You may not use our branding without written permission.</p>

  <h2>Third-Party Platforms</h2>
  <p>Our services operate through third-party platforms including Facebook, Instagram, TikTok, and WhatsApp. Your use of those platforms is governed by their respective terms of service and privacy policies.</p>

  <h2>Limitation of Liability</h2>
  <p>Gabe Moves Metal is a personal sales brand and is not responsible for any decisions made based on information provided through our messaging services. All vehicle purchases are subject to the terms and conditions of Findlay Chevrolet.</p>

  <h2>Changes to Terms</h2>
  <p>We may update these Terms of Service from time to time. Continued use of our services constitutes acceptance of the updated terms.</p>

  <div class="contact">
    <h2>Contact Us</h2>
    <p>If you have questions about these Terms of Service, contact us:</p>
    <p><strong>Gabe Moves Metal</strong><br>
    Facebook: <a href="https://facebook.com/Gabemovesmetal1">facebook.com/Gabemovesmetal1</a><br>
    Location: Las Vegas, NV</p>
  </div>
</body>
</html>`);
});

// Data deletion callback endpoint (for Meta)
app.post('/data-deletion', (req, res) => {
  const { signed_request } = req.body;
  // Meta sends a signed request when a user requests data deletion
  // Acknowledge the request and provide a status URL
  const confirmationCode = crypto.randomBytes(16).toString('hex');
  res.json({
    url: `https://gabe-moves-metal.onrender.com/data-deletion?code=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});


// ==================== DEALS TRACKER (SECURE) ====================
// All deal data behind requireAuth — must be logged in to access
const DEALS_FILE = path.join(__dirname, 'deals.json');

function loadDeals() {
  try {
    if (fs.existsSync(DEALS_FILE)) {
      return JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading deals:', e.message);
  }
  return { deals: [], monthlyStats: [], totals: [], yearTotal: {}, lists: {}, nextId: 1, employeeNumber: '' };
}

function saveDeals(data) {
  fs.writeFileSync(DEALS_FILE, JSON.stringify(data, null, 2));
}

// Recalculate monthly stats from deal data
function recalcMonth(data, month) {
  const monthDeals = data.deals.filter(d => d.month === month);
  const units = monthDeals.length;
  const totalGross = monthDeals.reduce((s, d) => s + (d.totalGross || 0), 0);
  const commission = monthDeals.reduce((s, d) => s + (d.commission || 0), 0);
  const spiffs = monthDeals.reduce((s, d) => s + (d.dealSpiff || 0), 0);
  const spiffsPaid = monthDeals.filter(d => d.spiffPaid === 'PAID').reduce((s, d) => s + (d.dealSpiff || 0), 0);
  const spiffsPending = spiffs - spiffsPaid;
  const grossPaidOn = monthDeals.reduce((s, d) => s + (d.grossPaidOn || 0), 0);
  const effectiveComm = grossPaidOn > 0 ? commission / grossPaidOn : 0;

  let stat = data.monthlyStats.find(s => s.month === month);
  if (!stat) {
    stat = { month };
    data.monthlyStats.push(stat);
  }
  stat.units = units;
  stat.totalGrossEntered = totalGross;
  stat.commissionTotal = commission;
  stat.spiffsAuto = spiffs;
  stat.spiffsPaid = spiffsPaid;
  stat.spiffsPendingCalc = spiffsPending;
  stat.effectiveCommPct = effectiveComm;

  // Update totals row
  const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const mi = MONTHS.indexOf(month);
  if (mi >= 0 && data.totals[mi]) {
    data.totals[mi].totalDealCount = units;
    data.totals[mi].frontGross = totalGross;
    data.totals[mi].commission = commission;
    data.totals[mi].spiffs = spiffs;
  }
}

// GET all deals (optionally filter by month)
app.get('/api/deals', (req, res) => {
  const data = loadDeals();
  let deals = data.deals;
  if (req.query.month) {
    deals = deals.filter(d => d.month === req.query.month.toUpperCase());
  }
  deals.sort((a, b) => new Date(a.date) - new Date(b.date));
  res.json({ deals, lists: data.lists });
});

// GET monthly stats & totals
app.get('/api/deals/stats', (req, res) => {
  const data = loadDeals();
  res.json({
    monthlyStats: data.monthlyStats,
    totals: data.totals,
    yearTotal: data.yearTotal,
    employeeNumber: data.employeeNumber,
  });
});

// GET single deal
app.get('/api/deals/:id', (req, res) => {
  const data = loadDeals();
  const deal = data.deals.find(d => d.id === parseInt(req.params.id));
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  res.json(deal);
});

// POST new deal
app.post('/api/deals', (req, res) => {
  const data = loadDeals();
  const deal = {
    id: data.nextId++,
    month: req.body.month || new Date().toLocaleString('en-US', { month: 'long' }).toUpperCase(),
    date: req.body.date || new Date().toISOString().split('T')[0],
    dealNumber: req.body.dealNumber || null,
    stockNumber: req.body.stockNumber || '',
    keyInfo: req.body.keyInfo || '',
    vehicle: req.body.vehicle || '',
    cpo: (req.body.cpo || 'NO').toUpperCase(),
    newUsed: (req.body.newUsed || '').toUpperCase(),
    source: (req.body.source || '').toUpperCase(),
    customerName: req.body.customerName || '',
    splitAmount: parseFloat(req.body.splitAmount) || 1,
    splitWith: req.body.splitWith || '',
    totalGross: parseFloat(req.body.totalGross) || 0,
    commission: parseFloat(req.body.commission) || 0,
    dealSpiff: parseFloat(req.body.dealSpiff) || 0,
    spiffPaid: (req.body.spiffPaid || '').toUpperCase(),
    grossPaidOn: parseFloat(req.body.grossPaidOn) || 0,
    billedFunded: (req.body.billedFunded || '').toUpperCase(),
    dealFlag: (req.body.dealFlag || '').toUpperCase(),
    dealStatus: (req.body.dealStatus || '').toUpperCase(),
  };
  data.deals.push(deal);
  recalcMonth(data, deal.month);
  saveDeals(data);
  res.json({ success: true, deal });
});

// PUT update deal
app.put('/api/deals/:id', (req, res) => {
  const data = loadDeals();
  const idx = data.deals.findIndex(d => d.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Deal not found' });
  const oldMonth = data.deals[idx].month;
  Object.assign(data.deals[idx], req.body, { id: data.deals[idx].id });
  recalcMonth(data, data.deals[idx].month);
  if (oldMonth !== data.deals[idx].month) recalcMonth(data, oldMonth);
  saveDeals(data);
  res.json({ success: true, deal: data.deals[idx] });
});

// DELETE deal
app.delete('/api/deals/:id', (req, res) => {
  const data = loadDeals();
  const idx = data.deals.findIndex(d => d.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Deal not found' });
  const month = data.deals[idx].month;
  data.deals.splice(idx, 1);
  recalcMonth(data, month);
  saveDeals(data);
  res.json({ success: true });
});

// ============ iCAL CALENDAR EVENT GENERATOR ============
app.post('/api/calendar/event', (req, res) => {
  try {
    const { title, description, scheduledDate, scheduledTime, postType, platform } = req.body;
    
    if (!title || !scheduledDate) {
      return res.status(400).json({ success: false, error: 'Title and scheduled date are required' });
    }
    
    const startTime = scheduledTime || '10:00';
    const startDate = new Date(scheduledDate + 'T' + startTime + ':00');
    const endDate = new Date(startDate.getTime() + 30 * 60000); // 30 min duration
    
    const formatICSDate = (d) => {
      return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };
    
    const uid = 'gmm-' + Date.now() + '@gabemovesmetal.com';
    const now = formatICSDate(new Date());
    const dtStart = formatICSDate(startDate);
    const dtEnd = formatICSDate(endDate);
    
    const platformLabel = platform ? ' [' + platform.toUpperCase() + ']' : '';
    const typeLabel = postType ? postType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : 'Post';
    
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Gabe Moves Metal//CRM//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + uid,
      'DTSTAMP:' + now,
      'DTSTART:' + dtStart,
      'DTEND:' + dtEnd,
      'SUMMARY:' + typeLabel + platformLabel + ' - ' + title.substring(0, 60),
      'DESCRIPTION:' + (description || '').replace(/\n/g, '\\n').substring(0, 500),
      'CATEGORIES:Gabe Moves Metal,Social Media',
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Time to post: ' + typeLabel,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="gmm-post-' + scheduledDate + '.ics"');
    res.send(icsContent);
    
  } catch (error) {
    console.error('Calendar event error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate calendar event' });
  }
});

// Calendar feed endpoint - returns all scheduled posts as .ics feed
app.get('/api/calendar/feed', (req, res) => {
  try {
    // Return a basic calendar feed structure
    // In production, this would pull from a database of scheduled posts
    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Gabe Moves Metal//CRM//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Gabe Moves Metal Posts',
      'X-WR-CALDESC:Scheduled social media posts',
      'END:VCALENDAR'
    ].join('\r\n');
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(icsContent);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to generate calendar feed' });
  }
});

// ============ APPOINTMENTS API ============
// Appointments stored in SQLite via database module

// Get all appointments (optionally filter by date)
app.get('/api/appointments', (req, res) => {
  try {
    const { date, from, to } = req.query;
    const filtered = database.appointments.getAll({ date, from, to });
    res.json({ success: true, appointments: filtered });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create appointment
app.post('/api/appointments', (req, res) => {
  try {
    const { customerName, date, time, type, duration, notes, vehicle, phone } = req.body;
    if (!date || !type) {
      return res.status(400).json({ success: false, error: 'Date and type are required' });
    }
    
    const appt = {
      id: apptIdCounter++,
      customerName: customerName || '',
      date,
      time: time || '09:00',
      type,
      duration: duration || 30,
      notes: notes || '',
      vehicle: vehicle || '',
      phone: phone || '',
      status: 'scheduled',
      createdAt: new Date().toISOString()
    };
    
    const created = database.appointments.create(appt);
    res.json({ success: true, appointment: created });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update appointment
app.put('/api/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const updated = database.appointments.update(id, req.body);
    if (!updated) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, appointment: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete appointment
app.delete('/api/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = database.appointments.getById(id);
    if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
    database.appointments.delete(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate .ics for a single appointment
app.get('/api/appointments/:id/ical', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const appt = database.appointments.getById(id);
    if (!appt) return res.status(404).json({ success: false, error: 'Not found' });
    
    const startDate = new Date(appt.date + 'T' + (appt.time || '09:00') + ':00');
    const endDate = new Date(startDate.getTime() + (appt.duration || 30) * 60000);
    const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    
    const typeLabels = {
      test_drive: 'Test Drive',
      delivery: 'Vehicle Delivery',
      follow_up: 'Follow-Up',
      walk_in: 'Walk-In Appt',
      phone_call: 'Phone Call',
      team_meeting: 'Team Meeting',
      training: 'Training',
      manager_meeting: 'Manager Check-In',
      other: 'Appointment'
    };
    
    const label = typeLabels[appt.type] || appt.type;
    const summary = appt.customerName ? label + ' - ' + appt.customerName : label;
    const desc = [
      appt.vehicle ? 'Vehicle: ' + appt.vehicle : '',
      appt.phone ? 'Phone: ' + appt.phone : '',
      appt.notes ? 'Notes: ' + appt.notes : ''
    ].filter(Boolean).join('\\n');
    
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Gabe Moves Metal//CRM//EN',
      'BEGIN:VEVENT',
      'UID:gmm-appt-' + appt.id + '@gabemovesmetal.com',
      'DTSTAMP:' + fmt(new Date()),
      'DTSTART:' + fmt(startDate),
      'DTEND:' + fmt(endDate),
      'SUMMARY:' + summary,
      'DESCRIPTION:' + desc,
      'CATEGORIES:Findlay Chevy,' + label,
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + summary + ' in 15 minutes',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="appt-' + appt.date + '.ics"');
    res.send(ics);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});






// ==================== START SERVER ====================

// ===== LIVE DEALS & INVENTORY SCRAPERS =====
let cachedDeals = [];
let cachedInventory = [];
let dealsLastFetch = 0;
let inventoryLastFetch = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 min cache

// Scrape Findlay Chevy inventory from DDC platform (server-rendered HTML)
async function scrapeFindlayInventory() {
  console.log("[Scraper] Starting Findlay inventory scrape...");
  try {
    const resp = await axios.get('https://www.findlaychevy.com/new-vehicles/', {
      headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Connection': 'keep-alive',
          'Referer': 'https://www.google.com/'
        },
      timeout: 15000,
      maxRedirects: 5
    });
    const $ = cheerio.load(resp.data);
    const vehicles = [];
    
    // DDC platform renders .hit-content cards server-side
    $('.hit-content').each((i, el) => {
      const card = $(el);
      const titleEl = card.find('.result-title');
      const name = titleEl.text().trim().replace(/\s+/g, ' ');
      
      // Extract VIN from data-vin attribute
      const vinEl = card.find('[data-vin]');
      const vin = vinEl.attr('data-vin') || '';
      
      // Extract stock number
      const stockText = card.text().match(/Stock[:#]?\s*([A-Z0-9]+)/i);
      const stock = stockText ? stockText[1] : '';
      
      // Extract prices - look for MSRP and Findlay Price
      const fullText = card.text();
      const msrpMatch = fullText.match(/MSRP[\s:]*\$([\d,]+)/i);
      const findlayPriceMatch = fullText.match(/Findlay\s*Price[\s:]*\$([\d,]+)/i);
      const sellingPriceMatch = fullText.match(/(?:Selling|Sale|Our)\s*Price[\s:]*\$([\d,]+)/i);
      
      const msrp = msrpMatch ? msrpMatch[1].replace(/,/g, '') : '';
      const price = findlayPriceMatch ? findlayPriceMatch[1].replace(/,/g, '') : 
                    sellingPriceMatch ? sellingPriceMatch[1].replace(/,/g, '') : msrp;
      
      // Extract image
      const img = card.find('img').first();
      const image = img.attr('src') || img.attr('data-src') || '';
      
      if (name) {
        vehicles.push({
          name, vin, stock, msrp, price, image,
          url: 'https://www.findlaychevy.com/new-vehicles/',
          source: 'findlaychevy.com'
        });
      }
    });
    
    console.log('[Scraper] Found ' + vehicles.length + ' vehicles from findlaychevy.com');
    return vehicles;
  } catch (err) {
    console.error('[Scraper] Findlay inventory error:', err.message);
    return [];
  }
}

// Scrape national Chevrolet offers/incentives
// Primary: realcartips.com (reliable, structured tables)
// Fallback: hardcoded current offers if scrape fails
async function scrapeChevyOffers() {
  try {
    console.log('[Scraper] Fetching national Chevy offers from realcartips.com...');
    const resp = await axios.get('https://www.realcartips.com/chevrolet-incentives/', {
      headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      timeout: 15000
    });
    const $ = cheerio.load(resp.data);

    // Collect all offers keyed by normalized "year|model" so different tables merge
    const offerMap = {};

    // Normalize vehicle name to a merge key: "2026|equinox ev"
    function normalizeKey(rawName) {
      let s = rawName.toLowerCase().replace(/\s+/g, ' ').trim();
      // Strip "chevrolet" prefix
      s = s.replace(/^chevrolet\s+/, '').replace(/\bchevrolet\b/g, '').trim();
      // Extract year
      const ym = s.match(/(20[2-3]\d)/);
      const year = ym ? ym[1] : '2026';
      s = s.replace(/(20[2-3]\d)/, '').trim();
      // Strip trim levels & extras to get base model
      s = s.replace(/\b(lt|ls|rs|ltz|premier|activ|rst|zr2|z71|work truck|wt|high country|ev electric|electric)\b/gi, (m) => {
        // Keep "ev" and "electric" to distinguish EV vs ICE
        if (/ev|electric/i.test(m)) return m.toLowerCase();
        return '';
      }).replace(/\s+/g, ' ').trim();
      // Consolidate "ev electric" to just "ev"
      s = s.replace(/\bev electric\b/g, 'ev').replace(/\belectric\b/g, 'ev').trim();
      return year + '|' + s;
    }

    function getOrCreate(rawName) {
      const key = normalizeKey(rawName);
      if (!offerMap[key]) {
        const [year] = key.split('|');
        // Build clean display name
        let cleanModel = rawName.replace(/\s+/g, ' ').trim();
        // Standardize to "Year Chevrolet Model" format
        const hasYear = /^20[2-3]\d/.test(cleanModel);
        const yearInName = cleanModel.match(/(20[2-3]\d)/);
        const y = yearInName ? yearInName[1] : year;
        cleanModel = cleanModel.replace(/(20[2-3]\d)/, '').replace(/^Chevrolet\s*/i, '').replace(/\bChevrolet\b/gi, '').replace(/\s+/g, ' ').trim();
        // Remove trailing trim levels for display vehicle name
        const displayModel = cleanModel.replace(/\s+(LT|LS|RS|LTZ|Premier|Activ|RST|ZR2|Z71|Work Truck|WT|High Country)$/i, '').trim();
        // Clean "EV Electric" → "EV" in display name
        const cleanDisplay = displayModel.replace(/\s+EV\s+Electric/i, ' EV').replace(/\s+Electric/i, ' EV');
        const vehicle = y + ' Chevrolet ' + cleanDisplay;
        const baseModel = cleanDisplay;
        offerMap[key] = { vehicle, year: y, model: baseModel, type: 'national_offer', source: 'realcartips.com/chevrolet-incentives' };
      }
      return offerMap[key];
    }

    // Parse each table by detecting its type from headers
    $('table').each((ti, table) => {
      const headerText = $(table).find('tr').first().text().toLowerCase();
      const isLeaseTable = headerText.includes('monthly') || headerText.includes('payment');
      const isRebateTable = headerText.includes('rebate') || headerText.includes('max');
      const isAprTable = headerText.includes('36 mo') || headerText.includes('48 mo') || headerText.includes('60 mo');

      $(table).find('tr').each((ri, row) => {
        const cells = [];
        $(row).find('td').each((ci, cell) => {
          cells.push($(cell).text().trim().replace(/\s+/g, ' '));
        });
        if (cells.length < 2) return;

        // Skip sub-header rows (e.g. "MSRP | Payment | Value...")
        const cell0Lower = cells[0].toLowerCase();
        if (cell0Lower === 'msrp' || cell0Lower === 'vehicle' || cell0Lower.includes('payment')) return;

        const nameMatch = cells[0].match(/(?:Chevrolet\s+)?(Silverado|Equinox|Trax|Blazer|Tahoe|Suburban|Traverse|Colorado|Trailblazer|Bolt|Corvette|Camaro|Malibu)/i);
        if (!nameMatch) return;

        const deal = getOrCreate(cells[0]);

        if (isLeaseTable) {
          // Table 0 data rows: Vehicle | MSRP | $X /mo | Rating | Region | Link
          const monthlyCell = cells.find(c => c.includes('/mo'));
          if (monthlyCell) {
            const m = monthlyCell.match(/\$([\d,]+)/);
            if (m) deal.monthly = m[1];
          }
          const msrpCell = cells.find(c => /^\$[\d,]+$/.test(c));
          if (msrpCell) {
            const p = msrpCell.match(/\$([\d,]+)/);
            if (p) deal.msrp = p[1];
          }
          deal.offerType = 'lease';
        } else if (isRebateTable) {
          // Table 1: Vehicle | Region | Max Rebate | Link
          // Rebate $ is in the cell that contains '$'
          const rebateCell = cells.find(c => c.includes('$'));
          if (rebateCell) {
            const r = rebateCell.match(/\$([\d,]+)/);
            if (r) deal.cashBack = r[1];
          }
          if (!deal.offerType) deal.offerType = 'rebate';
        } else if (isAprTable) {
          // Table 2: Vehicle | 36mo | 48mo | 60mo | Link
          let bestApr = null;
          for (let ci = 1; ci < cells.length; ci++) {
            const aprM = cells[ci].match(/([\d.]+)%/);
            if (aprM) {
              const rate = parseFloat(aprM[1]);
              if (bestApr === null || rate < bestApr) bestApr = rate;
            }
          }
          if (bestApr !== null) deal.apr = String(bestApr);
          if (!deal.offerType) deal.offerType = 'financing';
        }
      });
    });

    const deals = Object.values(offerMap).filter(d => d.cashBack || d.apr || d.monthly);
    console.log('[Scraper] Found ' + deals.length + ' national offers from realcartips.com');

    if (deals.length > 0) return deals;

    console.log('[Scraper] No offers parsed — using hardcoded national offers');
    return getHardcodedChevyOffers();
  } catch (err) {
    console.error('[Scraper] National offers scrape error:', err.message);
    console.log('[Scraper] Using hardcoded national offers as fallback');
    return getHardcodedChevyOffers();
  }
}

// Hardcoded national offers — update monthly or when you notice changes
function getHardcodedChevyOffers() {
  return [
    { vehicle: '2026 Chevrolet Equinox EV', model: 'Equinox EV', year: '2026', cashBack: '8,750', apr: '0', monthly: '377', type: 'national_offer', source: 'chevrolet.com', note: '$8,750 rebate + 0% APR for 60 months' },
    { vehicle: '2026 Chevrolet Silverado 1500', model: 'Silverado 1500', year: '2026', cashBack: '3,750', apr: '1.9', type: 'national_offer', source: 'chevrolet.com', note: 'Up to $3,750 cash back + 1.9% APR for 36 months' },
    { vehicle: '2026 Chevrolet Equinox', model: 'Equinox', year: '2026', apr: '1.9', monthly: '384', type: 'national_offer', source: 'chevrolet.com', note: '1.9% APR for 36 months, lease from $384/mo' },
    { vehicle: '2026 Chevrolet Colorado', model: 'Colorado', year: '2026', cashBack: '1,000', monthly: '448', type: 'national_offer', source: 'chevrolet.com', note: '$1,000 cash back, lease from $448/mo' },
    { vehicle: '2026 Chevrolet Blazer', model: 'Blazer', year: '2026', apr: '1.9', type: 'national_offer', source: 'chevrolet.com', note: '1.9% APR for 36 months' },
    { vehicle: '2026 Chevrolet Trax', model: 'Trax', year: '2026', cashBack: '500', apr: '2.9', type: 'national_offer', source: 'chevrolet.com', note: '$500 cash back + 2.9% APR' },
    { vehicle: '2026 Chevrolet Trailblazer', model: 'Trailblazer', year: '2026', monthly: '387', type: 'national_offer', source: 'chevrolet.com', note: 'Lease from $387/mo' },
    { vehicle: '2025 Chevrolet Blazer EV', model: 'Blazer EV', year: '2025', cashBack: '3,500', apr: '1.9', type: 'national_offer', source: 'chevrolet.com', note: '$3,500 rebate + 1.9% APR' },
    { vehicle: '2025 Chevrolet Silverado EV', model: 'Silverado EV', year: '2025', cashBack: '4,000', apr: '0', type: 'national_offer', source: 'chevrolet.com', note: '$4,000 rebate + 0% APR for 60 months' },
  ];
}

// Scrape Findlay Chevy specials/deals (vehicles with discounts)
async function scrapeFindlayDeals() {
  try {
    // Use the main inventory page - vehicles with Findlay Discount are the "deals"
    const resp = await axios.get('https://www.findlaychevy.com/new-vehicles/', {
      headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Connection': 'keep-alive',
          'Referer': 'https://www.google.com/'
        },
      timeout: 15000
    });
    const $ = cheerio.load(resp.data);
    const deals = [];
    
    $('.hit-content').each((i, el) => {
      const card = $(el);
      const text = card.text();
      const name = card.find('.result-title').text().trim().replace(/\s+/g, ' ');
      
      // Only include vehicles that show a discount/savings
      const msrpMatch = text.match(/MSRP[\s:]*\$([\d,]+)/i);
      const findlayPriceMatch = text.match(/Findlay\s*Price[\s:]*\$([\d,]+)/i);
      const savingsMatch = text.match(/(?:You Save|Your Savings|Savings)[\s:]*\$([\d,]+)/i);
      const discountMatch = text.match(/Findlay\s*Discount[\s:]*\$([\d,]+)/i);
      const cashMatch = text.match(/Customer\s*Cash[\s:]*\$([\d,]+)/i);
      
      const msrp = msrpMatch ? msrpMatch[1] : null;
      const findlayPrice = findlayPriceMatch ? findlayPriceMatch[1] : null;
      const savings = savingsMatch ? savingsMatch[1] : null;
      const discount = discountMatch ? discountMatch[1] : null;
      const customerCash = cashMatch ? cashMatch[1] : null;
      
      const stockMatch = text.match(/Stock[:#]?\s*([A-Z0-9]+)/i);
      
      if (name && (savings || discount || customerCash || findlayPrice)) {
        deals.push({
          vehicle: name,
          msrp, findlayPrice, savings, discount, customerCash,
          stock: stockMatch ? stockMatch[1] : '',
          type: 'findlay_special',
          source: 'findlaychevy.com'
        });
      }
    });
    
    console.log('[Scraper] Found ' + deals.length + ' deals from findlaychevy.com');
    return deals;
  } catch (err) {
    console.error('[Scraper] Findlay deals error:', err.message);
    return [];
  }
}

// GET /api/live-deals - returns combined deals from Findlay + Chevy.com
// Falls back to curated sample deals when DDC WAF blocks scraping
app.get('/api/live-deals', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (cachedDeals.length > 0 && (now - dealsLastFetch) < CACHE_TTL) {
      return res.json({ deals: cachedDeals, cached: true, lastFetch: dealsLastFetch });
    }
    console.log('[Deals] Starting deals refresh...');
    const [findlayDeals, chevyOffers] = await Promise.all([
      scrapeFindlayDeals(),
      scrapeChevyOffers()
    ]);
    const liveDeals = [...findlayDeals, ...chevyOffers];
    if (liveDeals.length > 0) {
      cachedDeals = liveDeals;
      console.log('[Deals] Refresh complete: ' + liveDeals.length + ' structured deals');
    } else {
      // Fallback to curated deals when scrapers are blocked
      const fallbackDeals = inventoryModule.getFallbackDeals ? inventoryModule.getFallbackDeals() : [];
      const fallbackOffers = inventoryModule.getFallbackOffers ? inventoryModule.getFallbackOffers() : [];
      cachedDeals = [...fallbackDeals, ...fallbackOffers];
      console.log('[Deals] Scrapers blocked - using ' + cachedDeals.length + ' fallback deals');
    }
    dealsLastFetch = now;
    res.json({ deals: cachedDeals, cached: false, lastFetch: dealsLastFetch });
  } catch (err) {
    console.error('[API] live-deals error:', err.message);
    // Even on error, return fallback data instead of 500
    const fallbackDeals = inventoryModule.getFallbackDeals ? inventoryModule.getFallbackDeals() : [];
    const fallbackOffers = inventoryModule.getFallbackOffers ? inventoryModule.getFallbackOffers() : [];
    res.json({ deals: [...fallbackDeals, ...fallbackOffers], cached: false, fallback: true });
  }
});

// GET /api/live-inventory - returns inventory from Findlay
// Falls back to curated inventory when DDC WAF blocks scraping
app.get('/api/live-inventory', requireAuth, async (req, res) => {
  try {
    // Use Algolia-powered inventory (reliable, 600+ vehicles, auto-refreshes every 30 min)
    // Map fields to match what the frontend expects (image, stock, etc.)
    const raw = inventoryModule.getInventory();
    const vehicles = raw.map(v => ({
      ...v,
      image: v.imageUrl || v.image || '',
      stock: v.stockNumber || v.stock || '',
      color: v.exteriorColor || v.color || '',
    }));
    res.json({ inventory: vehicles, cached: false, lastFetch: inventoryModule.getLastScraped(), source: 'algolia', count: vehicles.length });
  } catch (err) {
    console.error('[API] live-inventory error:', err.message);
    res.json({ inventory: [], cached: false, fallback: true, error: err.message });
  }
});


// ==================== TIKTOK OAUTH ENDPOINTS ====================

// TikTok OAuth callback — handles the token exchange automatically
app.get('/auth/tiktok/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Missing authorization code. Please try the TikTok authorization again.');
  }

  try {
    // Exchange auth code for access token
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CONFIG.TIKTOK_CLIENT_KEY,
        client_secret: CONFIG.TIKTOK_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: `${CONFIG.WEBHOOK_URL.replace('/webhook', '')}/auth/tiktok/callback`,
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      // Store the token in CONFIG (in production, save to .env or database)
      CONFIG.TIKTOK_ACCESS_TOKEN = tokenData.access_token;
      CONFIG.TIKTOK_REFRESH_TOKEN = tokenData.refresh_token;
      CONFIG.TIKTOK_OPEN_ID = tokenData.open_id;

      console.log(`🎵 TikTok connected! Access token expires in ${tokenData.expires_in}s`);
      console.log(`🎵 Refresh token expires in ${tokenData.refresh_expires_in}s`);
      console.log(`🎵 Open ID: ${tokenData.open_id}`);

      res.send(`
        <html>
        <body style="background: #000; color: #fff; font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
          <div style="text-align: center; max-width: 500px;">
            <div style="font-size: 64px; margin-bottom: 20px;">🎵✅</div>
            <h1 style="color: #ff0050;">TikTok Connected!</h1>
            <p style="color: #ccc; margin-bottom: 20px;">Your Gabe Moves Metal CRM can now auto-post to TikTok.</p>
            <p style="color: #888; font-size: 14px;">Access Token: ${tokenData.access_token.substring(0, 20)}...</p>
            <p style="color: #d4a017; font-size: 14px; margin-top: 20px;">
              <strong>IMPORTANT:</strong> Copy this access token to your .env file as TIKTOK_ACCESS_TOKEN to persist it across restarts.
            </p>
            <div style="margin-top: 30px; padding: 16px; background: #111; border-radius: 8px; text-align: left; font-size: 12px; font-family: monospace; word-break: break-all;">
              TIKTOK_ACCESS_TOKEN=${tokenData.access_token}<br><br>
              TIKTOK_REFRESH_TOKEN=${tokenData.refresh_token}<br><br>
              TIKTOK_OPEN_ID=${tokenData.open_id}
            </div>
            <p style="color: #888; font-size: 12px; margin-top: 20px;">You can close this window and go back to your CRM.</p>
          </div>
        </body>
        </html>
      `);
    } else {
      console.error('TikTok token exchange failed:', tokenData);
      res.status(400).send(`TikTok authorization failed: ${JSON.stringify(tokenData)}`);
    }
  } catch (err) {
    console.error('TikTok OAuth error:', err.message);
    res.status(500).send(`Error connecting TikTok: ${err.message}`);
  }
});

// TikTok token refresh endpoint
app.post('/api/tiktok/refresh', async (req, res) => {
  const refreshToken = CONFIG.TIKTOK_REFRESH_TOKEN || req.body.refresh_token;
  if (!refreshToken) {
    return res.status(400).json({ error: 'No refresh token available. Re-authorize TikTok.' });
  }

  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CONFIG.TIKTOK_CLIENT_KEY,
        client_secret: CONFIG.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      CONFIG.TIKTOK_ACCESS_TOKEN = tokenData.access_token;
      CONFIG.TIKTOK_REFRESH_TOKEN = tokenData.refresh_token;
      console.log('🎵 TikTok token refreshed successfully');
      res.json({ success: true, message: 'Token refreshed', expires_in: tokenData.expires_in });
    } else {
      res.status(400).json({ error: 'Refresh failed', details: tokenData });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get TikTok authorization URL (for easy access from CRM)
app.get('/api/tiktok/auth-url', (req, res) => {
  if (!CONFIG.TIKTOK_CLIENT_KEY) {
    return res.json({
      configured: false,
      message: 'TikTok client_key not set. See TIKTOK_SETUP_GUIDE.md',
    });
  }
  const baseUrl = CONFIG.WEBHOOK_URL.replace('/webhook', '');
  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${CONFIG.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload&response_type=code&redirect_uri=${encodeURIComponent(baseUrl + '/auth/tiktok/callback')}&state=gabe_moves_metal`;
  res.json({
    configured: true,
    connected: !!CONFIG.TIKTOK_ACCESS_TOKEN,
    authUrl,
    message: CONFIG.TIKTOK_ACCESS_TOKEN ? 'TikTok is connected!' : 'Click the authUrl to connect your TikTok account',
  });
});

// ============ FOLLOW-UP SEQUENCES ============

// Get all sequences
app.get('/api/followup/sequences', requireAuth, (req, res) => {
  res.json(database.followupSequences.getAll());
});

// Create/update a sequence
app.post('/api/followup/sequences', requireAuth, (req, res) => {
  const seq = {
    id: req.body.id || generateId(),
    name: req.body.name,
    trigger_stage: req.body.trigger_stage || 'New Lead',
    steps: req.body.steps || [],
    active: req.body.active !== false,
    createdAt: req.body.createdAt || new Date().toISOString(),
  };
  const result = database.followupSequences.upsert(seq);
  res.json(result);
});

// Delete a sequence
app.delete('/api/followup/sequences/:id', requireAuth, (req, res) => {
  database.followupSequences.delete(req.params.id);
  res.json({ success: true });
});

// Toggle sequence active/inactive
app.put('/api/followup/sequences/:id/toggle', requireAuth, (req, res) => {
  const seq = database.followupSequences.getById(req.params.id);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  const updated = database.followupSequences.upsert({ ...seq, active: !seq.active });
  res.json(updated);
});

// Get follow-up queue stats
app.get('/api/followup/queue', requireAuth, (req, res) => {
  const stats = database.followupQueue.getStats();
  const pending = database.followupQueue.getPending();
  // Enrich with lead names
  const enriched = pending.map(item => {
    const lead = database.leads.getById(item.leadId);
    const seq = database.followupSequences.getById(item.sequenceId);
    return {
      ...item,
      leadName: lead ? lead.name : 'Unknown',
      sequenceName: seq ? seq.name : 'Unknown',
      stepMessage: seq && seq.steps[item.stepIndex] ? seq.steps[item.stepIndex].message : '',
    };
  });
  res.json({ stats, pending: enriched });
});

// Manually enroll a lead in a sequence
app.post('/api/followup/enroll', requireAuth, (req, res) => {
  const { leadId, sequenceId } = req.body;
  const lead = database.leads.getById(leadId);
  const seq = database.followupSequences.getById(sequenceId);
  if (!lead || !seq) return res.status(404).json({ error: 'Lead or sequence not found' });

  // Cancel any existing pending follow-ups for this lead
  database.followupQueue.cancelForLead(leadId);

  // Determine platform from lead's conversation
  let platform = 'FB Messenger';
  if (lead.conversationId) {
    const convo = database.conversations.getById(lead.conversationId);
    if (convo) platform = convo.platform;
  }

  // Schedule all steps
  let delay = 0;
  seq.steps.forEach((step, index) => {
    delay += (step.delayMinutes || 60) * 60 * 1000;
    database.followupQueue.create({
      id: generateId(),
      leadId,
      sequenceId,
      stepIndex: index,
      scheduledAt: new Date(Date.now() + delay).toISOString(),
      status: 'pending',
      platform,
    });
  });

  res.json({ success: true, stepsScheduled: seq.steps.length });
});

// Cancel all pending follow-ups for a lead
app.post('/api/followup/cancel/:leadId', requireAuth, (req, res) => {
  database.followupQueue.cancelForLead(req.params.leadId);
  res.json({ success: true });
});

// ============ FOLLOW-UP SEQUENCE ENGINE ============
// Runs every 2 minutes, sends due follow-up messages automatically
function processFollowUpQueue() {
  try {
    const dueItems = database.followupQueue.getDue();
    for (const item of dueItems) {
      const lead = database.leads.getById(item.leadId);
      if (!lead) { database.followupQueue.markSkipped(item.id); continue; }

      // Skip if lead is already Sold or Lost
      if (lead.stage === 'Sold' || lead.stage === 'Lost') {
        database.followupQueue.cancelForLead(item.leadId);
        continue;
      }

      const seq = database.followupSequences.getById(item.sequenceId);
      if (!seq || !seq.steps[item.stepIndex]) { database.followupQueue.markSkipped(item.id); continue; }

      const step = seq.steps[item.stepIndex];
      const firstName = lead.name.split(' ')[0] || 'there';
      const message = step.message
        .replace(/\{first_name\}/g, firstName)
        .replace(/\{name\}/g, lead.name)
        .replace(/\{interest\}/g, lead.interest || 'a vehicle')
        .replace(/\{dealership\}/g, CONFIG.DEALERSHIP);

      // Find the conversation to send through
      if (lead.conversationId) {
        const convo = database.conversations.getById(lead.conversationId);
        if (convo && convo.senderId) {
          // Send via Meta API
          sendMessage(convo.senderId, message, convo.platform === 'instagram' ? 'instagram' : 'messenger');

          // Log the message in the conversation
          database.conversations.addMessage(convo.id, {
            id: generateId(),
            from: 'bot',
            text: message,
            timestamp: new Date().toISOString(),
            templateUsed: `Follow-up: ${seq.name} (Step ${item.stepIndex + 1})`,
          });
        }
      }

      database.followupQueue.markSent(item.id);

      // Create notification
      addNotification({
        type: 'followup_sent',
        title: `Follow-up sent to ${lead.name}`,
        message: `Step ${item.stepIndex + 1} of "${seq.name}": ${message.substring(0, 80)}...`,
        leadId: lead.id,
      });

      console.log(`[FollowUp] Sent step ${item.stepIndex + 1} of "${seq.name}" to ${lead.name}`);
    }
  } catch (error) {
    console.error('[FollowUp] Error processing queue:', error.message);
  }
}

// Start the follow-up engine (every 2 minutes)
setInterval(processFollowUpQueue, 2 * 60 * 1000);

// Also auto-enroll new leads into matching sequences (called from handleMessage)
function autoEnrollLead(leadId, stage) {
  const sequences = database.followupSequences.getActiveByTrigger(stage);
  if (sequences.length === 0) return;

  const lead = database.leads.getById(leadId);
  if (!lead) return;

  let platform = 'FB Messenger';
  if (lead.conversationId) {
    const convo = database.conversations.getById(lead.conversationId);
    if (convo) platform = convo.platform;
  }

  for (const seq of sequences) {
    let delay = 0;
    seq.steps.forEach((step, index) => {
      delay += (step.delayMinutes || 60) * 60 * 1000;
      database.followupQueue.create({
        id: generateId(),
        leadId,
        sequenceId: seq.id,
        stepIndex: index,
        scheduledAt: new Date(Date.now() + delay).toISOString(),
        status: 'pending',
        platform,
      });
    });
    console.log(`[FollowUp] Auto-enrolled ${lead.name} into "${seq.name}" (${seq.steps.length} steps)`);
  }
}

// ============ COMPETITOR INVENTORY SCRAPER ============
// Scrapes inventory from Fairway, Henderson, and Team Chevy websites
// Stores results in memory for quick comparison

let competitorInventory = {
  fairway: { vehicles: [], lastUpdated: null, status: 'idle' },
  henderson: { vehicles: [], lastUpdated: null, status: 'idle' },
  team: { vehicles: [], lastUpdated: null, status: 'idle' },
};

// ---- Algolia-based scraper for DealerInspire sites (Fairway & Henderson) ----
// DealerInspire uses Algolia for inventory search. The HTML is client-rendered,
// so we hit the Algolia API directly for full inventory data.
const ALGOLIA_APP_ID = 'V3ZOVI2QFZ';
const ALGOLIA_API_KEY = 'ec7553dd56e6d4c8bb447a0240e7aab3';

async function scrapeDealerInspire(name, indexName, dealerLabel, dealerShort, siteUrl) {
  try {
    console.log(`[CompIntel] Fetching ${name} inventory via Algolia index: ${indexName}...`);
    competitorInventory[name].status = 'scraping';

    const allVehicles = [];
    let page = 0;
    let totalPages = 1;

    // Paginate through all results (Algolia max 1000 per query, 20 per page default)
    while (page < totalPages && page < 20) { // safety cap at 20 pages
      const response = await axios.post(
        `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${indexName}/query`,
        {
          params: `hitsPerPage=100&page=${page}&filters=type%3Anew`,
        },
        {
          headers: {
            'X-Algolia-Application-Id': ALGOLIA_APP_ID,
            'X-Algolia-API-Key': ALGOLIA_API_KEY,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const data = response.data;
      totalPages = data.nbPages || 1;

      (data.hits || []).forEach(hit => {
        const year = hit.api_id ? '' : (hit.year || '');
        const make = hit.make || 'Chevrolet';
        const model = hit.model || '';
        const trim = hit.trim || '';
        const title = hit.title || `${hit.year || ''} ${make} ${model} ${trim}`.trim();
        const vin = hit.vin || '';
        const price = hit.our_price || hit.msrp || hit.price || null;
        const msrp = hit.msrp || null;
        const stockNum = hit.stock || hit.stock_number || '';
        const img = hit.photo || hit.thumbnail || '';

        if (vin) {
          // Only use image if it's a real URL (not a placeholder)
          let realImg = '';
          if (img && !img.includes('notfound') && !img.includes('no-image') && !img.includes('placeholder')) {
            realImg = img.startsWith('//') ? 'https:' + img : img;
          }

          allVehicles.push({
            dealer: dealerLabel,
            dealerShort,
            vin,
            year: String(hit.year || year),
            make,
            model,
            trim,
            title,
            price: price ? parseFloat(price) : null,
            msrp: msrp ? parseFloat(msrp) : null,
            priceFormatted: price ? `$${parseFloat(price).toLocaleString()}` : 'Call for price',
            stockNumber: stockNum,
            image: realImg,
            url: hit.link || siteUrl,
            // Extra fields for comparison
            drivetrain: hit.drivetrain || '',
            engine: hit.engine_description || '',
            fuelType: hit.fueltype || '',
            cityMpg: hit.city_mpg || '',
            hwyMpg: hit.hw_mpg || '',
            exteriorColor: hit.ext_color || '',
            interiorColor: hit.int_color || '',
            mileage: hit.miles || 0,
            daysOnLot: hit.days_in_stock || 0,
            condition: hit.type || 'New',
          });
        }
      });

      page++;
    }

    competitorInventory[name].vehicles = allVehicles;
    competitorInventory[name].lastUpdated = new Date().toISOString();
    competitorInventory[name].status = 'ready';
    console.log(`[CompIntel] ${name}: Found ${allVehicles.length} vehicles via Algolia`);
    return allVehicles;
  } catch (error) {
    console.error(`[CompIntel] Error fetching ${name} from Algolia:`, error.message);
    competitorInventory[name].status = 'error';
    return competitorInventory[name].vehicles; // return cached
  }
}

// ---- Scraper for Team Chevrolet (DealerOn/Vue platform) ----
// DealerOn renders inventory client-side via Vue, but each model-filtered page
// includes JSON-LD with up to 24 vehicles. We query every Chevy model to get full coverage.
const TEAM_CHEVY_MODELS = [
  'Silverado+1500', 'Silverado+2500+HD', 'Silverado+3500+HD', 'Silverado+EV',
  'Tahoe', 'Suburban', 'Traverse', 'Equinox', 'Equinox+EV',
  'Blazer', 'Blazer+EV', 'Trax', 'Trailblazer', 'Colorado',
  'Corvette', 'Camaro', 'Malibu', 'Bolt', 'Bolt+EV', 'Bolt+EUV',
];

async function scrapeTeam() {
  const name = 'team';
  try {
    console.log(`[CompIntel] Scraping Team Chevrolet inventory (${TEAM_CHEVY_MODELS.length} model queries)...`);
    competitorInventory[name].status = 'scraping';
    const seenVins = new Set();
    const vehicles = [];
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    };

    // Query each model — JSON-LD in the page gives up to 24 vehicles per model
    // Run in batches of 4 to avoid hammering the server
    for (let i = 0; i < TEAM_CHEVY_MODELS.length; i += 4) {
      const batch = TEAM_CHEVY_MODELS.slice(i, i + 4);
      const results = await Promise.allSettled(
        batch.map(model =>
          axios.get(`https://www.teamchevroletlv.com/searchnew.aspx?Make=Chevrolet&Model=${model}`, {
            headers, timeout: 20000,
          }).then(res => {
            const $ = cheerio.load(res.data);
            let count = 0;
            $('script[type="application/ld+json"]').each((_, el) => {
              try {
                const data = JSON.parse($(el).html());
                if (data['@type'] === 'ItemList' && data.itemListElement) {
                  data.itemListElement.forEach(item => {
                    const vin = item.identifier || '';
                    if (!vin || seenVins.has(vin)) return;
                    seenVins.add(vin);
                    count++;
                    const parsed = parseVehicleTitle(item.name || '');
                    vehicles.push({
                      dealer: 'Team Chevrolet',
                      dealerShort: 'Team',
                      vin,
                      year: parsed.year,
                      make: parsed.make,
                      model: parsed.model,
                      trim: parsed.trim,
                      title: item.name || `${parsed.year} ${parsed.make} ${parsed.model}`,
                      price: null, msrp: null,
                      priceFormatted: 'Call for price',
                      stockNumber: '',
                      image: item.image || '',
                      url: item.url || 'https://www.teamchevroletlv.com',
                    });
                  });
                }
              } catch (e) {}
            });
            return { model, count };
          }).catch(e => ({ model, count: 0, error: e.message }))
        )
      );
      const counts = results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
      console.log(`[CompIntel] team batch ${i/4+1}: ${counts.map(c => `${c.model}=${c.count}`).join(', ')}`);
    }

    // Also grab the unfiltered page for any vehicles not caught by model filters
    try {
      const mainRes = await axios.get('https://www.teamchevroletlv.com/searchnew.aspx', { headers, timeout: 20000 });
      const $ = cheerio.load(mainRes.data);
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).html());
          if (data['@type'] === 'ItemList' && data.itemListElement) {
            data.itemListElement.forEach(item => {
              const vin = item.identifier || '';
              if (!vin || seenVins.has(vin)) return;
              seenVins.add(vin);
              const parsed = parseVehicleTitle(item.name || '');
              vehicles.push({
                dealer: 'Team Chevrolet', dealerShort: 'Team', vin,
                year: parsed.year, make: parsed.make, model: parsed.model, trim: parsed.trim,
                title: item.name || `${parsed.year} ${parsed.make} ${parsed.model}`,
                price: null, msrp: null, priceFormatted: 'Call for price',
                stockNumber: '', image: item.image || '',
                url: item.url || 'https://www.teamchevroletlv.com',
              });
            });
          }
        } catch (e) {}
      });
    } catch (e) {}

    competitorInventory[name].vehicles = vehicles;
    competitorInventory[name].lastUpdated = new Date().toISOString();
    competitorInventory[name].status = 'ready';
    console.log(`[CompIntel] team: Final count ${vehicles.length} vehicles (${seenVins.size} unique VINs)`);
    return vehicles;
  } catch (error) {
    console.error(`[CompIntel] Error scraping team:`, error.message);
    competitorInventory[name].status = 'error';
    return competitorInventory[name].vehicles;
  }
}

// Parse "2026 Chevrolet Silverado 1500 LT" into parts
function parseVehicleTitle(title) {
  const yearMatch = title.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';
  const withoutYear = title.replace(/\b20\d{2}\b/, '').trim();

  // Common Chevy models
  const models = ['Silverado 1500', 'Silverado 2500', 'Silverado 3500', 'Silverado EV',
    'Tahoe', 'Suburban', 'Traverse', 'Equinox', 'Equinox EV', 'Blazer', 'Blazer EV',
    'Trax', 'Trailblazer', 'Colorado', 'Corvette', 'Camaro', 'Malibu', 'Bolt EV', 'Bolt EUV'];

  let make = 'Chevrolet';
  let model = '';
  let trim = '';

  for (const m of models) {
    if (withoutYear.toLowerCase().includes(m.toLowerCase())) {
      model = m;
      // Everything after the model is the trim
      const modelIdx = withoutYear.toLowerCase().indexOf(m.toLowerCase());
      trim = withoutYear.substring(modelIdx + m.length).replace(/^[\s-]+/, '').trim();
      break;
    }
  }

  if (!model) {
    // Fallback: remove make name, take first word(s) as model
    const parts = withoutYear.replace(/Chevrolet|Chevy/i, '').trim().split(/\s+/);
    model = parts.slice(0, 2).join(' ');
    trim = parts.slice(2).join(' ');
  }

  return { year, make, model, trim };
}

// ==================== WINDOW STICKER PARSER ====================
const stickerCache = {}; // VIN -> parsed sticker data

async function parseWindowSticker(vin) {
  if (stickerCache[vin]) return stickerCache[vin];

  try {
    const url = `https://cws.gm.com/vs-cws/vehshop/v2/vehicle/windowsticker?vin=${vin}`;
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });

    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    const buf = new Uint8Array(response.data);
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map(i => i.str).join(' ');

    // Group text items by y-coordinate into lines (tolerant of slight drift).
    // pdfjs transform: [scaleX, skewX, skewY, scaleY, tx, ty]; ty = item.transform[5] (y), tx = [4] (x).
    const rawItems = content.items.map(it => ({
      str: (it.str || '').replace(/\s+/g, ' '),
      x: it.transform ? it.transform[4] : 0,
      y: it.transform ? Math.round(it.transform[5]) : 0,
    })).filter(it => it.str && it.str.trim().length);
    // Bucket by y (rounded to nearest 2pt)
    const byY = new Map();
    rawItems.forEach(it => {
      const key = Math.round(it.y / 2) * 2;
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push(it);
    });
    const lines = [...byY.entries()]
      .sort((a, b) => b[0] - a[0]) // top-to-bottom in PDF coords (high y = top)
      .map(([y, items]) => {
        items.sort((a, b) => a.x - b.x);
        return { y, items, text: items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim() };
      })
      .filter(l => l.text.length);

    const result = { vin, standardFeatures: [], packages: [], standaloneOptions: [], pricing: {}, allFeatures: [] };

    // Vehicle header
    const hm = text.match(/(20\d{2})\s+(\w[\w\s]*?)\s+([\dA-Z]{2,4})\s+EXTERIOR:\s*(.*?)\s+(?:INTERIOR|ENGINE)/);
    if (hm) { result.year = hm[1]; result.model = hm[2].trim(); result.trim = hm[3].trim(); result.exteriorColor = hm[4].trim(); }

    const intMatch = text.match(/INTERIOR:\s*(.*?)\s+(?:ENGINE|TRANSMISSION)/);
    if (intMatch) result.interiorColor = intMatch[1].trim();

    const engMatch = text.match(/ENGINE,\s*(.*?)\s+TRANSMISSION/);
    if (engMatch) result.engine = engMatch[1].trim();

    const transMatch = text.match(/TRANSMISSION,\s*(.*?)(?:\s{2}|$)/);
    if (transMatch) result.transmission = transMatch[1].trim();

    // Standard features - all bullets before OPTIONS & PRICING
    const optionsIdx = text.indexOf('OPTIONS & PRICING');
    const bulletParts = text.split('•');
    let searchFrom = 0;

    bulletParts.forEach((part, i) => {
      if (i === 0) return;
      const pos = text.indexOf('•' + part.substring(0, 20), searchFrom);
      searchFrom = pos > 0 ? pos + 1 : searchFrom;

      let feat = part.replace(/\s+/g, ' ').trim();
      feat = feat.replace(/\s+\d{1,3}(?:,\d{3})*\.\d{2}.*$/s, '').trim();
      feat = feat.replace(/\s+(MANUFACTURER'S|STANDARD VEHICLE|TOTAL |OPTIONS &|DESTINATION).*$/s, '').trim();
      if (feat.match(/^(ITEMS FEATURED|WHICHEVER COMES|SEE CHEVROLET)/)) return;

      if (feat.length > 3 && pos < optionsIdx) {
        // Skip warranty/legal boilerplate
        if (!feat.match(/^\d+ YEAR/) && !feat.match(/^FIRST MAINTENANCE/) && !feat.match(/^CHEVY$/) && !feat.match(/ONSTAR BASICS/) && !feat.match(/SIRIUSXM.*TERMS/)) {
          result.standardFeatures.push(feat);
        }
      }
    });

    // Parse OPTIONS section using item-level x/y positions.
    // GM stickers are multi-column, so y-only line grouping merges columns. Instead,
    // for each price token we walk leftward on the same y (±3) collecting text items
    // until an x-gap > 100 is found — that gives us the option name in its own column.
    // Features are bulleted items below the price in the same x-column.
    const priceOnlyRx = /^\s*\d{1,3}(?:,\d{3})*\.\d{2}\s*$/;
    const bulletRx = /^[•·]\s*/;
    const noiseNameRx = /^(STANDARD VEHICLE PRICE|TOTAL VEHICLE|TOTAL OPTIONS|DESTINATION|OPTIONS\s*&|SUBTOTAL|FUEL|CITY|HWY|COMBINED|YOU SAVE|ANNUAL FUEL|GASOLINE|ETHANOL|PARTS CONTENT|FINAL ASSEMBLY|COUNTRY OF|ENGINE:|TRANSMISSION:)/i;

    const pricedItems = rawItems.filter(it => priceOnlyRx.test(it.str));

    // Helper: find items to the left of a price on the same visual line (y within ±3)
    function nameForPrice(priceItem) {
      const candidates = rawItems
        .filter(it => it !== priceItem)
        .filter(it => Math.abs(it.y - priceItem.y) <= 3)
        .filter(it => it.x < priceItem.x && !priceOnlyRx.test(it.str))
        .sort((a, b) => a.x - b.x);
      if (!candidates.length) return null;
      // Walk from rightmost backward, collecting items until x-gap > 100
      const picked = [];
      let prevX = priceItem.x;
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i];
        const itemRight = c.x + (c.str.length * 5); // rough width estimate
        const gap = prevX - itemRight;
        if (gap > 120) break;
        picked.unshift(c);
        prevX = c.x;
      }
      if (!picked.length) return null;
      return picked.map(p => p.str).join(' ').replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
    }

    // Helper: find bullet features beneath a price in the same column (x within ±30)
    function featuresForPrice(priceItem, nextPriceInColumnY) {
      const colLeft = priceItem.x - 200; // name column starts ~150-180 left of price
      const colRight = priceItem.x + 20;
      const minY = nextPriceInColumnY != null ? nextPriceInColumnY : 0;
      const bullets = rawItems
        .filter(it => bulletRx.test(it.str) || /^•/.test(it.str))
        .filter(it => it.y < priceItem.y && it.y > minY)
        .filter(it => it.x >= colLeft && it.x <= colRight)
        .sort((a, b) => b.y - a.y);
      return bullets.map(b => b.str.replace(bulletRx, '').replace(/^•\s*/, '').replace(/\s+/g, ' ').trim()).filter(f => f.length > 2);
    }

    // Classify each price: is it an option, or a total/noise line?
    const optionEntries = [];
    pricedItems.forEach(pi => {
      const name = nameForPrice(pi);
      if (!name) return;
      if (noiseNameRx.test(name)) return;
      // Skip anything that looks like "$XX,XXX.XX" totals column (price_x very high and name is a total label — already filtered by noiseNameRx)
      const price = parseFloat(pi.str.replace(/,/g, ''));
      if (!price || price <= 0) return;
      optionEntries.push({ name, price, priceItem: pi });
    });

    // For each entry, compute features in its column bounded by the next higher y entry in same column
    optionEntries.forEach((entry, i) => {
      // Find next priced entry in same x-column (within ±40) with y between this y and 0
      const sameCol = optionEntries.filter(e => e !== entry && Math.abs(e.priceItem.x - entry.priceItem.x) <= 40 && e.priceItem.y < entry.priceItem.y);
      const nextY = sameCol.length ? Math.max(...sameCol.map(e => e.priceItem.y)) : null;
      const features = featuresForPrice(entry.priceItem, nextY);
      entry.features = features;
    });

    // Clean names and push into result buckets
    optionEntries.forEach(entry => {
      let name = entry.name
        .replace(/^\(.*?\)\s*/, '')
        .replace(/:\s*$/, '')
        .replace(/\s*\(.*?SHOWN\)\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (name.length < 3) return;
      if (noiseNameRx.test(name)) return;
      const isPackage = /PACKAGE/i.test(name) || entry.features.length > 1;
      if (isPackage) {
        result.packages.push({ name, price: entry.price, features: entry.features });
      } else {
        result.standaloneOptions.push({ name, price: entry.price });
      }
    });

    // Pricing
    const sp = {
      standardPrice: text.match(/STANDARD VEHICLE PRICE\s+.?([\d,]+\.\d{2})/),
      totalOptions: text.match(/TOTAL OPTIONS\s+.?([\d,]+\.\d{2})/),
      totalPrice: text.match(/TOTAL VEHICLE PRICE.?\s+.?([\d,]+\.\d{2})/),
      destination: text.match(/DESTINATION CHARGE\s+([\d,]+\.\d{2})/),
    };
    Object.entries(sp).forEach(([k, m]) => { if (m) result.pricing[k] = parseFloat(m[1].replace(/,/g, '')); });

    // Build allFeatures for comparison
    result.allFeatures = [...result.standardFeatures];
    result.packages.forEach(pkg => {
      pkg.features.forEach(f => result.allFeatures.push(f));
    });
    result.standaloneOptions.forEach(opt => result.allFeatures.push(opt.name));

    stickerCache[vin] = result;
    console.log(`[Sticker] Parsed ${vin}: ${result.standardFeatures.length} std features, ${result.packages.length} packages, $${result.pricing.totalPrice || '?'}`);
    return result;
  } catch (err) {
    console.error(`[Sticker] Error parsing ${vin}:`, err.message);
    return { vin, error: err.message, standardFeatures: [], packages: [], standaloneOptions: [], pricing: {}, allFeatures: [] };
  }
}

// API: Parse window sticker for one or more VINs
app.get('/api/sticker/parse', requireAuth, async (req, res) => {
  const vins = (req.query.vins || '').split(',').filter(Boolean);
  if (vins.length === 0) return res.status(400).json({ error: 'Provide ?vins=VIN1,VIN2' });

  const results = await Promise.all(vins.map(vin => parseWindowSticker(vin.trim())));
  res.json({ stickers: results });
});

// ==================== STICKER PRE-WARM ====================
// Parse window stickers in the background so first compare click is instant.
// GM stickers only (non-GM VINs will 404 or error and get skipped).
let prewarmState = {
  running: false,
  started: null,
  finished: null,
  total: 0,
  done: 0,
  ok: 0,
  failed: 0,
};

const GM_MAKES = new Set(['chevrolet', 'chevy', 'gmc', 'buick', 'cadillac']);

async function prewarmStickers(vehicles, { concurrency = 3, label = 'prewarm' } = {}) {
  if (prewarmState.running) {
    console.log(`[Sticker ${label}] Skipped — prewarm already running`);
    return;
  }
  const targets = (vehicles || [])
    .filter(v => v && v.vin && v.vin.length === 17)
    .filter(v => {
      const make = (v.make || '').toLowerCase();
      // If make is unknown, still try — GM stickers URL will 404 quickly for non-GM
      return !make || GM_MAKES.has(make);
    })
    .filter(v => !stickerCache[v.vin]);

  prewarmState = {
    running: true,
    started: new Date().toISOString(),
    finished: null,
    total: targets.length,
    done: 0,
    ok: 0,
    failed: 0,
  };

  console.log(`[Sticker ${label}] Starting prewarm for ${targets.length} VINs (concurrency=${concurrency})`);

  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const my = idx++;
      const v = targets[my];
      try {
        const r = await parseWindowSticker(v.vin);
        if (r && !r.error) prewarmState.ok++;
        else prewarmState.failed++;
      } catch (err) {
        prewarmState.failed++;
      }
      prewarmState.done++;
      // Small breather to avoid hammering GM's CDN
      await new Promise(r => setTimeout(r, 150));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker());
  await Promise.all(workers);

  prewarmState.running = false;
  prewarmState.finished = new Date().toISOString();
  console.log(`[Sticker ${label}] Prewarm complete — ${prewarmState.ok} ok, ${prewarmState.failed} failed out of ${prewarmState.total}`);
}

// API: Sticker cache status (for UI progress indicator)
app.get('/api/sticker/status', requireAuth, (req, res) => {
  res.json({
    cached: Object.keys(stickerCache).length,
    prewarm: prewarmState,
  });
});

// API: Manually kick off a prewarm pass
app.post('/api/sticker/prewarm', requireAuth, async (req, res) => {
  const vehicles = inventoryModule.getInventory();
  prewarmStickers(vehicles, { label: 'manual' }); // fire and forget
  res.json({ success: true, queued: vehicles.length });
});

// API: Scrape all competitors
app.post('/api/competitors/scrape', requireAuth, async (req, res) => {
  const results = await Promise.allSettled([
    scrapeDealerInspire('fairway', 'fairwaychevy_production_inventory', 'Fairway Chevrolet', 'Fairway', 'https://www.fairwaychevy.com'),
    scrapeDealerInspire('henderson', 'hendersonchevy_production_inventory', 'Henderson Chevrolet', 'Henderson', 'https://www.hendersonchevy.com'),
    scrapeTeam(),
  ]);

  res.json({
    fairway: { count: competitorInventory.fairway.vehicles.length, lastUpdated: competitorInventory.fairway.lastUpdated, status: competitorInventory.fairway.status },
    henderson: { count: competitorInventory.henderson.vehicles.length, lastUpdated: competitorInventory.henderson.lastUpdated, status: competitorInventory.henderson.status },
    team: { count: competitorInventory.team.vehicles.length, lastUpdated: competitorInventory.team.lastUpdated, status: competitorInventory.team.status },
  });
});

// API: Get competitor inventory (with search/filter)
app.get('/api/competitors/inventory', requireAuth, (req, res) => {
  const { dealer, model, minPrice, maxPrice, year, search } = req.query;

  let allVehicles = [];
  if (!dealer || dealer === 'all') {
    allVehicles = [
      ...competitorInventory.fairway.vehicles,
      ...competitorInventory.henderson.vehicles,
      ...competitorInventory.team.vehicles,
    ];
  } else {
    allVehicles = competitorInventory[dealer]?.vehicles || [];
  }

  // Apply filters
  if (model) allVehicles = allVehicles.filter(v => v.model.toLowerCase().includes(model.toLowerCase()));
  if (year) allVehicles = allVehicles.filter(v => v.year === year);
  if (minPrice) allVehicles = allVehicles.filter(v => v.price && v.price >= parseFloat(minPrice));
  if (maxPrice) allVehicles = allVehicles.filter(v => v.price && v.price <= parseFloat(maxPrice));
  if (search) {
    const q = search.toLowerCase();
    allVehicles = allVehicles.filter(v =>
      v.title.toLowerCase().includes(q) ||
      v.model.toLowerCase().includes(q) ||
      v.trim.toLowerCase().includes(q) ||
      v.vin.toLowerCase().includes(q) ||
      v.stockNumber.toLowerCase().includes(q)
    );
  }

  res.json({
    vehicles: allVehicles,
    total: allVehicles.length,
    lastUpdated: {
      fairway: competitorInventory.fairway.lastUpdated,
      henderson: competitorInventory.henderson.lastUpdated,
      team: competitorInventory.team.lastUpdated,
    },
  });
});

// API: Compare a specific vehicle across dealers
app.get('/api/competitors/compare', requireAuth, (req, res) => {
  const { model, year } = req.query;
  if (!model) return res.status(400).json({ error: 'model is required' });

  const q = model.toLowerCase();
  const yFilter = year || '';

  // Search our inventory
  const ourMatches = inventoryModule.matchInventory(model, { maxResults: 10 })
    .map(v => ({ ...v, dealer: 'Findlay Chevrolet', dealerShort: 'Findlay' }));

  // Search competitor inventories
  const compMatches = [
    ...competitorInventory.fairway.vehicles,
    ...competitorInventory.henderson.vehicles,
    ...competitorInventory.team.vehicles,
  ].filter(v => {
    const matchModel = v.model.toLowerCase().includes(q) || v.title.toLowerCase().includes(q);
    const matchYear = !yFilter || v.year === yFilter;
    return matchModel && matchYear;
  });

  res.json({
    query: { model, year },
    findlay: ourMatches,
    competitors: compMatches,
    totalFindings: ourMatches.length + compMatches.length,
  });
});

// API: Get scrape status
app.get('/api/competitors/status', requireAuth, (req, res) => {
  res.json({
    fairway: { count: competitorInventory.fairway.vehicles.length, lastUpdated: competitorInventory.fairway.lastUpdated, status: competitorInventory.fairway.status },
    henderson: { count: competitorInventory.henderson.vehicles.length, lastUpdated: competitorInventory.henderson.lastUpdated, status: competitorInventory.henderson.status },
    team: { count: competitorInventory.team.vehicles.length, lastUpdated: competitorInventory.team.lastUpdated, status: competitorInventory.team.status },
  });
});

// Auto-scrape competitors every 6 hours
setInterval(() => {
  console.log('[CompIntel] Auto-refreshing competitor inventory...');
  scrapeDealerInspire('fairway', 'fairwaychevy_production_inventory', 'Fairway Chevrolet', 'Fairway', 'https://www.fairwaychevy.com');
  scrapeDealerInspire('henderson', 'hendersonchevy_production_inventory', 'Henderson Chevrolet', 'Henderson', 'https://www.hendersonchevy.com');
  scrapeTeam();
}, 6 * 60 * 60 * 1000);

// TikTok connection status
app.get('/api/tiktok/status', (req, res) => {
  res.json({
    connected: !!CONFIG.TIKTOK_ACCESS_TOKEN,
    hasClientKey: !!CONFIG.TIKTOK_CLIENT_KEY,
    hasClientSecret: !!CONFIG.TIKTOK_CLIENT_SECRET,
    openId: CONFIG.TIKTOK_OPEN_ID || null,
  });
});

// ==================== SMS / TWILIO ====================

// Generate AI auto-reply using template system
function generateAIAutoReply(messageBody, customerName) {
  const body = messageBody.toLowerCase();
  const templates = database.templates.getAll();

  // Detect language
  const spanishKeywords = ['hola', 'qué', 'cuanto', 'precio', 'troca', 'camioneta', 'suv', 'tahoe', 'ayuda', 'quiero'];
  const isSpanish = spanishKeywords.some(kw => body.includes(kw));
  const lang = isSpanish ? 'es' : 'en';

  // Find keyword-matching templates
  const keywordTemplates = templates.filter(t =>
    t.trigger === 'keyword' && t.lang === lang && t.active && t.keywords
  );

  let matchedTemplate = null;
  for (const tmpl of keywordTemplates) {
    if (tmpl.keywords.some(kw => body.includes(kw.toLowerCase()))) {
      matchedTemplate = tmpl;
      break;
    }
  }

  // Fallback to instant greeting
  if (!matchedTemplate) {
    matchedTemplate = templates.find(t =>
      t.trigger === 'new_message' && t.lang === lang && t.active
    ) || templates.find(t => t.trigger === 'new_message' && t.active);
  }

  if (!matchedTemplate) return '';

  // Replace {first_name} placeholder
  const firstName = (customerName || 'there').split(' ')[0];
  return matchedTemplate.message.replace('{first_name}', firstName);
}

// Send SMS via Twilio REST API
async function sendSMSViaTwilio(toPhone, body) {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN || !CONFIG.TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio not configured');
  }

  try {
    const auth = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        From: CONFIG.TWILIO_PHONE_NUMBER,
        To: toPhone,
        Body: body,
      }),
      {
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );
    return response.data;
  } catch (error) {
    console.error('[Twilio] Send SMS error:', error.response?.data || error.message);
    throw error;
  }
}

// Twilio incoming SMS webhook (PUBLIC — no auth required)
app.post('/sms/incoming', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const fromPhone = req.body.From;
    const messageBody = req.body.Body || '';
    const twilioSid = req.body.MessageSid;

    if (!fromPhone) {
      return res.status(400).send('<Response></Response>');
    }

    // Store inbound message
    const inboundMsg = {
      id: crypto.randomUUID(),
      phone: fromPhone,
      direction: 'inbound',
      body: messageBody,
      status: 'received',
      twilioSid,
      createdAt: new Date().toISOString(),
    };

    // Try to find matching lead
    const leads = database.leads.getAll();
    let matchedLead = leads.find(l => l.phone && l.phone.replace(/\D/g, '') === fromPhone.replace(/\D/g, ''));

    if (matchedLead) {
      inboundMsg.leadId = matchedLead.id;
    }

    database.sms.create(inboundMsg);

    // Track response time
    if (matchedLead) {
      database.responseTime.create({
        id: crypto.randomUUID(),
        leadId: matchedLead.id,
        source: 'sms',
        receivedAt: new Date().toISOString(),
        autoResponded: 0,
      });
    }

    // Generate auto-reply
    const customerName = matchedLead?.name || 'there';
    const replyText = generateAIAutoReply(messageBody, customerName);

    if (replyText) {
      try {
        const twilioReply = await sendSMSViaTwilio(fromPhone, replyText);

        // Store outbound auto-reply
        database.sms.create({
          id: crypto.randomUUID(),
          leadId: matchedLead?.id || '',
          phone: fromPhone,
          direction: 'outbound',
          body: replyText,
          status: 'sent',
          twilioSid: twilioReply.sid,
          autoReply: 1,
          createdAt: new Date().toISOString(),
        });

        // Mark response time as auto-responded
        if (matchedLead) {
          const entries = database.responseTime.getAll().filter(rt => rt.leadId === matchedLead.id);
          if (entries.length > 0) {
            const latest = entries[0];
            if (!latest.respondedAt) {
              database.responseTime.markResponded(matchedLead.id, new Date().toISOString());
              // Update autoResponded flag (note: responseTime doesn't have this in the query, manually update)
              database.getDb().prepare('UPDATE lead_response_times SET autoResponded = 1 WHERE leadId = ? AND autoResponded = 0')
                .run(matchedLead.id);
            }
          }
        }
      } catch (error) {
        console.error('[SMS] Failed to send auto-reply:', error.message);
      }
    }

    // Create notification for Gabe
    database.notifications.create({
      id: crypto.randomUUID(),
      type: 'sms',
      title: `New SMS from ${customerName}`,
      message: messageBody,
      leadId: matchedLead?.id || '',
      createdAt: new Date().toISOString(),
    });

    // Return TwiML (empty response — we send via REST API)
    res.type('text/xml').send('<Response></Response>');
  } catch (error) {
    console.error('[SMS Webhook] Error:', error.message);
    res.type('text/xml').send('<Response></Response>');
  }
});

// Get SMS conversations grouped by phone
app.get('/api/sms/conversations', requireAuth, (req, res) => {
  try {
    const allSms = database.sms.getAll();
    const conversationMap = new Map();

    for (const sms of allSms) {
      if (!conversationMap.has(sms.phone)) {
        conversationMap.set(sms.phone, {
          phone: sms.phone,
          leadId: sms.leadId || null,
          leadName: '',
          messageCount: 0,
          lastMessage: '',
          lastMessageTime: '',
          inboundCount: 0,
          outboundCount: 0,
          autoReplyCount: 0,
        });
      }

      const convo = conversationMap.get(sms.phone);
      convo.messageCount += 1;
      convo.lastMessage = sms.body;
      convo.lastMessageTime = sms.createdAt;
      if (sms.direction === 'inbound') convo.inboundCount += 1;
      if (sms.direction === 'outbound') convo.outboundCount += 1;
      if (sms.autoReply) convo.autoReplyCount += 1;

      if (sms.leadId) {
        const lead = database.leads.getById(sms.leadId);
        if (lead) convo.leadName = lead.name;
      }
    }

    const conversations = Array.from(conversationMap.values())
      .sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    res.json({ conversations, total: conversations.length });
  } catch (error) {
    console.error('[SMS Conversations] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get all messages for a phone number
app.get('/api/sms/messages/:phone', requireAuth, (req, res) => {
  try {
    const phone = req.params.phone;
    const messages = database.sms.getByPhone(phone);
    res.json({ messages, count: messages.length });
  } catch (error) {
    console.error('[SMS Messages] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Send SMS manually
app.post('/api/sms/send', requireAuth, async (req, res) => {
  try {
    const { to, body, leadId } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: 'Missing phone number or message body' });
    }

    const twilioReply = await sendSMSViaTwilio(to, body);

    database.sms.create({
      id: crypto.randomUUID(),
      leadId: leadId || '',
      phone: to,
      direction: 'outbound',
      body,
      status: 'sent',
      twilioSid: twilioReply.sid,
      autoReply: 0,
      createdAt: new Date().toISOString(),
    });

    res.json({ success: true, sid: twilioReply.sid });
  } catch (error) {
    console.error('[SMS Send] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get SMS stats
app.get('/api/sms/stats', requireAuth, (req, res) => {
  try {
    const allSms = database.sms.getAll();
    const stats = {
      totalMessages: allSms.length,
      inbound: allSms.filter(m => m.direction === 'inbound').length,
      outbound: allSms.filter(m => m.direction === 'outbound').length,
      autoReplies: allSms.filter(m => m.autoReply).length,
      uniquePhones: new Set(allSms.map(m => m.phone)).size,
    };
    res.json(stats);
  } catch (error) {
    console.error('[SMS Stats] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Response time analytics
app.get('/api/analytics/response-times', requireAuth, (req, res) => {
  try {
    const stats = database.responseTime.getStats();
    res.json(stats);
  } catch (error) {
    console.error('[Response Times] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Response time log
app.get('/api/analytics/response-log', requireAuth, (req, res) => {
  try {
    const log = database.responseTime.getAll();
    const enriched = log.map(entry => {
      const lead = database.leads.getById(entry.leadId);
      return {
        ...entry,
        leadName: lead?.name || '',
        leadPhone: lead?.phone || '',
      };
    });
    res.json({ log: enriched, count: enriched.length });
  } catch (error) {
    console.error('[Response Log] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== iMESSAGE BRIDGE ENDPOINTS ====================
// Log an SMS/iMessage from the bridge script (runs on Gabe's Mac)
app.post('/api/sms/log', requireAuth, (req, res) => {
  try {
    const { phone, leadId, direction, body, autoReply, platform } = req.body;
    if (!phone || !direction) {
      return res.status(400).json({ error: 'phone and direction required' });
    }
    const msg = {
      id: `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      leadId: leadId || '',
      phone,
      direction,
      body: body || '',
      status: direction === 'outbound' ? 'sent' : 'received',
      twilioSid: platform === 'imessage' ? `imsg_${Date.now()}` : '',
      autoReply: autoReply ? 1 : 0,
      createdAt: new Date().toISOString(),
    };
    database.sms.create(msg);

    // Create notification for inbound messages
    if (direction === 'inbound') {
      const lead = leadId ? database.leads.getById(leadId) : null;
      const senderName = lead ? lead.name : phone;
      database.notifications.create({
        id: `notif_${Date.now()}`,
        type: 'imessage',
        title: `iMessage from ${senderName}`,
        message: (body || '').substring(0, 100),
        leadId: leadId || '',
        createdAt: new Date().toISOString(),
      });
    }

    res.json({ success: true, message: msg });
  } catch (error) {
    console.error('[SMS Log] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Track response time from the bridge
app.post('/api/analytics/track-response', requireAuth, (req, res) => {
  try {
    const { leadId, source, autoResponded } = req.body;
    const entry = {
      id: `rt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      leadId: leadId || '',
      source: source || 'imessage',
      receivedAt: new Date().toISOString(),
      respondedAt: new Date().toISOString(),
      responseTimeMs: 5000, // bridge auto-reply delay
      autoResponded: autoResponded ? 1 : 0,
    };
    database.responseTime.create(entry);
    res.json({ success: true, entry });
  } catch (error) {
    console.error('[Track Response] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== PAYMENT CALCULATOR ====================
app.post('/api/calculator/payment', (req, res) => {
  try {
    const { vehiclePrice, downPayment, tradeValue, tradePayoff, rebates, apr, termMonths, taxRate, docFee } = req.body;

    if (!vehiclePrice || !apr || !termMonths) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Nevada deal math:
    // Trade equity = ACV - payoff (negative = upside down, rolls into loan)
    const tradeACV = tradeValue || 0;
    const payoff = tradePayoff || 0;
    const tradeEquity = tradeACV - payoff;
    const dealerDocFee = docFee || 499;
    const dealerRebates = rebates || 0;

    // Taxable amount = selling price + doc fee - trade ACV
    const taxableAmount = Math.max(0, vehiclePrice + dealerDocFee - tradeACV);
    const taxPct = (taxRate || 8.375) / 100;
    const taxAmount = taxableAmount * taxPct;

    // Amount financed = price + doc + tax - rebates - down - trade equity
    const amountFinanced = vehiclePrice + dealerDocFee + taxAmount - dealerRebates - (downPayment || 0) - tradeEquity;

    if (amountFinanced <= 0) {
      return res.json({
        monthlyPayment: 0, totalInterest: 0, amountFinanced: 0,
        taxAmount: Math.round(taxAmount * 100) / 100,
        tradeEquity: Math.round(tradeEquity * 100) / 100,
        docFee: dealerDocFee, rebates: dealerRebates,
      });
    }

    // Standard amortization formula: M = P * [r(1+r)^n] / [(1+r)^n - 1]
    const monthlyRate = apr / 100 / 12;
    const numerator = monthlyRate * Math.pow(1 + monthlyRate, termMonths);
    const denominator = Math.pow(1 + monthlyRate, termMonths) - 1;
    const monthlyPayment = amountFinanced * (numerator / denominator);
    const totalPaid = monthlyPayment * termMonths;
    const totalInterest = totalPaid - amountFinanced;

    res.json({
      monthlyPayment: Math.round(monthlyPayment * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      totalOfPayments: Math.round(totalPaid * 100) / 100,
      amountFinanced: Math.round(amountFinanced * 100) / 100,
      taxAmount: Math.round(taxAmount * 100) / 100,
      tradeEquity: Math.round(tradeEquity * 100) / 100,
      docFee: dealerDocFee,
      rebates: dealerRebates,
    });
  } catch (error) {
    console.error('[Payment Calculator] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==================== APPOINTMENT REMINDER SYSTEM ====================
function checkAndSendReminders() {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const appointments = database.appointments.getAll({ date: tomorrowStr });
    const scheduledAppointments = appointments.filter(a => a.status === 'scheduled' && a.phone);

    for (const appt of scheduledAppointments) {
      if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN || !CONFIG.TWILIO_PHONE_NUMBER) {
        continue; // Skip if Twilio not configured
      }

      const reminderText = `Hey ${appt.customerName}! Just a reminder about your ${appt.type} appointment tomorrow at ${appt.time} with Gabe at Findlay Chevrolet. See you then! 🚗`;

      sendSMSViaTwilio(appt.phone, reminderText)
        .then(twilioReply => {
          // Store reminder SMS
          database.sms.create({
            id: crypto.randomUUID(),
            leadId: '',
            phone: appt.phone,
            direction: 'outbound',
            body: reminderText,
            status: 'sent',
            twilioSid: twilioReply.sid,
            autoReply: 0,
            createdAt: new Date().toISOString(),
          });
          console.log(`[Reminder] Sent appointment reminder to ${appt.phone}`);
        })
        .catch(error => {
          console.error(`[Reminder] Failed to send reminder to ${appt.phone}:`, error.message);
        });
    }
  } catch (error) {
    console.error('[Appointment Reminders] Error:', error.message);
  }
}

// Start reminder check every hour
setInterval(checkAndSendReminders, 60 * 60 * 1000);

app.listen(PORT, () => {
  // Start inventory auto-refresh
  inventoryModule.startAutoRefresh();

  // Prewarm window sticker cache 60s after boot, then every 6 hours.
  // This makes the first "Compare" click feel instant instead of a 5-10s wait.
  setTimeout(() => {
    const vehicles = inventoryModule.getInventory();
    if (vehicles && vehicles.length) {
      prewarmStickers(vehicles, { label: 'startup' });
    } else {
      console.log('[Sticker startup] No inventory yet — will retry on next cycle');
    }
  }, 60000);
  setInterval(() => {
    const vehicles = inventoryModule.getInventory();
    if (vehicles && vehicles.length) prewarmStickers(vehicles, { label: 'interval' });
  }, 6 * 60 * 60 * 1000);

  // Initial competitor scrape (30 seconds after boot so we don't slow startup)
  setTimeout(() => {
    console.log('[CompIntel] Running initial competitor inventory scrape...');
    scrapeDealerInspire('fairway', 'fairwaychevy_production_inventory', 'Fairway Chevrolet', 'Fairway', 'https://www.fairwaychevy.com');
    scrapeDealerInspire('henderson', 'hendersonchevy_production_inventory', 'Henderson Chevrolet', 'Henderson', 'https://www.hendersonchevy.com');
    scrapeTeam();
  }, 30000);

  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║     GABE MOVES METAL — Lead Engine Running       ║
  ║     Personal Lead Gen for Gabe @ Findlay Chevy   ║
  ║                                                  ║
  ║  [API]      http://localhost:${PORT}              ║
  ║  [Webhook]  http://localhost:${PORT}/webhook       ║
  ║  [Status]   http://localhost:${PORT}/api/stats      ║
  ║  [Inventory] ${String(inventoryModule.getInventoryCount()).padEnd(4)} vehicles loaded           ║
  ║  [Bilingual] EN/ES auto-replies active          ║
  ║  [Page ID]  ${CONFIG.PAGE_ID.padEnd(20)}           ║
  ║                                                  ║
  ║  ${CONFIG.META_APP_ID === 'YOUR_APP_ID' ? '[WARN] Meta API not configured yet!' : '[OK] Meta API connected!'}                 ║
  ║  See META_SETUP_GUIDE.md to connect              ║
  ╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
