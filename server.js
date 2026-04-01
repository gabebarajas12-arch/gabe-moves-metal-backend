/**
 * GABE MOVES METAL â Lead Engine Backend
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
  // WhatsApp Cloud API (register 702-416-3741 in Meta Developer Console â WhatsApp â API Setup)
  // Meta assigns a Phone Number ID once registered â set it here or in Render env vars
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || 'YOUR_WA_PHONE_NUMBER_ID',
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '1972990456955920',
  WHATSAPP_PHONE_NUMBER: '17024163741', // Gabe's number in E.164 format
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'gabe_moves_metal_wa_2026',
  // TikTok Content Posting API (apply at developers.tiktok.com â Content Posting API)
  TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN || '',
  TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY || '',
  TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET || '',
  // Personal brand info
  SALESMAN_NAME: 'Gabe',
  PAGE_NAME: 'Gabe Moves Metal',
  DEALERSHIP: 'Findlay Chevrolet',  // where Gabe works
  MESSENGER_ID: '653248677865512',
};

// ==================== AUTHENTICATION ====================
// Set CRM_PASSWORD in Render env vars. Default for local dev only.
const CRM_PASSWORD = process.env.CRM_PASSWORD || 'gabemovesmetal2026';

// Active sessions (token â { createdAt, expiresAt })
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

// Auth middleware â protects all /api/* routes
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
// Serve frontend â 'public' is a subfolder of the backend repo on Render
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
// Persistent storage â survives Render restarts
database.initDatabase();

// Default bilingual auto-reply templates (seeded on first run)
const DEFAULT_TEMPLATES = [
  // ===== ENGLISH TEMPLATES =====
  { id: 'instant_greeting_en', trigger: 'new_message', lang: 'en', name: 'Instant Greeting (EN)',
    message: `Hey {first_name}! Thanks for reaching out! This is Gabe from Gabe Moves Metal â I sell at Findlay Chevrolet, the #1 volume dealer west of Texas. What are you looking for today?`,
    active: true, delay: 0 },
  { id: 'truck_interest_en', trigger: 'keyword', lang: 'en',
    keywords: ['truck', 'silverado', 'colorado', 'sierra', 'tow', 'towing', 'pickup', 'f150', 'ram'],
    name: 'Truck Interest (EN)',
    message: `Great taste! I work at the #1 volume Chevy dealer west of Texas so we've got a HUGE truck selection. Silverado 1500, 2500HD, or Colorado â I can pull options and pricing right now. What are you looking at?`,
    active: true, delay: 30 },
  { id: 'suv_interest_en', trigger: 'keyword', lang: 'en',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'trailblazer', 'trax', 'traverse', 'family'],
    name: 'SUV Interest (EN)',
    message: `SUVs are my bread and butter! Whether you want an Equinox, Blazer, Tahoe, or Suburban â I've got them all on the lot. What size are you thinking, and is there a budget range you're working with?`,
    active: true, delay: 30 },
  { id: 'ev_interest_en', trigger: 'keyword', lang: 'en',
    keywords: ['ev', 'electric', 'equinox ev', 'blazer ev', 'silverado ev', 'hybrid', 'bolt', 'charge'],
    name: 'EV Interest (EN)',
    message: `Love that you're looking at EVs! Chevy has incredible electric options â the Equinox EV starts under $35K and there are federal tax credits available. Want me to break down the numbers for you?`,
    active: true, delay: 30 },
  { id: 'trade_in_en', trigger: 'keyword', lang: 'en',
    keywords: ['trade', 'trade-in', 'trade in', 'sell my car', 'selling', 'what is my car worth', 'value'],
    name: 'Trade-In Interest (EN)',
    message: `Trade values are strong right now! I can get you a quick appraisal â just need the year, make, model, and roughly how many miles. No obligation. Want to set that up?`,
    active: true, delay: 15 },
  { id: 'price_question_en', trigger: 'keyword', lang: 'en',
    keywords: ['price', 'how much', 'cost', 'payment', 'monthly', 'finance', 'deal', 'discount', 'best price'],
    name: 'Pricing Question (EN)',
    message: `Great question! We move a lot of metal at Findlay so our prices stay aggressive. Which specific vehicle are you looking at? I'll pull the best numbers I can for you.`,
    active: true, delay: 15 },
  // ===== SPANISH TEMPLATES =====
  { id: 'instant_greeting_es', trigger: 'new_message', lang: 'es', name: 'Saludo Inicial (ES)',
    message: `Â¡Hola {first_name}! Gracias por escribirme. Soy Gabe de Gabe Moves Metal â vendo en Findlay Chevrolet, el dealer #1 en volumen al oeste de Texas. Â¿En quÃ© te puedo ayudar hoy?`,
    active: true, delay: 0 },
  { id: 'truck_interest_es', trigger: 'keyword', lang: 'es',
    keywords: ['troca', 'camioneta', 'silverado', 'colorado', 'pickup', 'remolque', 'jalar'],
    name: 'InterÃ©s en Trocas (ES)',
    message: `Â¡Buena elecciÃ³n! Trabajo en el dealer Chevy #1 en volumen al oeste de Texas â tenemos una selecciÃ³n enorme de trocas. Silverado 1500, 2500HD, o Colorado. Â¿CuÃ¡l te interesa? Te puedo dar precios ahorita mismo.`,
    active: true, delay: 30 },
  { id: 'suv_interest_es', trigger: 'keyword', lang: 'es',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'familiar', 'familia', 'camioneta grande'],
    name: 'InterÃ©s en SUVs (ES)',
    message: `Â¡Las SUVs son mi especialidad! Ya sea Equinox, Blazer, Tahoe o Suburban â las tengo todas en el lote. Â¿QuÃ© tamaÃ±o buscas y cuÃ¡l es tu presupuesto mÃ¡s o menos?`,
    active: true, delay: 30 },
  { id: 'price_question_es', trigger: 'keyword', lang: 'es',
    keywords: ['precio', 'cuÃ¡nto', 'cuanto', 'cuesta', 'pago', 'mensual', 'financiar', 'crÃ©dito', 'credito', 'enganche'],
    name: 'Pregunta de Precio (ES)',
    message: `Â¡Buena pregunta! En Findlay movemos mucho volumen asÃ­ que nuestros precios son muy competitivos. Â¿QuÃ© vehÃ­culo te interesa? Te consigo los mejores nÃºmeros que pueda.`,
    active: true, delay: 15 },
  { id: 'trade_in_es', trigger: 'keyword', lang: 'es',
    keywords: ['intercambio', 'trade', 'vender mi carro', 'cuÃ¡nto vale', 'cuanto vale', 'avalÃºo'],
    name: 'InterÃ©s en Trade-In (ES)',
    message: `Â¡Los valores de trade-in estÃ¡n muy buenos ahorita! Solo necesito el aÃ±o, marca, modelo y mÃ¡s o menos cuÃ¡ntas millas tiene. Sin compromiso. Â¿Quieres que lo hagamos?`,
    active: true, delay: 15 },
];

// Migrate any existing data.json â SQLite, then seed defaults
database.migrateFromJson();
database.seedDefaultTemplates(DEFAULT_TEMPLATES);

// saveData() is now a no-op â database writes are immediate
function saveData() { /* SQLite handles persistence automatically */ }


// ==================== META WEBHOOK VERIFICATION ====================
// Meta sends a GET request to verify your webhook endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Accept both Facebook/Instagram and WhatsApp verify tokens
  if (mode === 'subscribe' && (token === CONFIG.META_VERIFY_TOKEN || token === CONFIG.WHATSAPP_VERIFY_TOKEN)) {
    console.log('â Webhook verified!');
    return res.status(200).send(challenge);
  }
  console.log('â Webhook verification failed');
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
        console.log('â Invalid webhook signature');
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

    console.log(`ð© New ${platform} message from ${senderId}: "${messageText}"`);

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

    // 1. If this is the first message, send instant greeting in detected language
    if (database.conversations.getMessageCount(convo.id, 'customer') === 1) {
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
        }, greeting.delay * 1000);
      }
    }

    // 2. Check for keyword-matched templates
    const keywordTemplate = findKeywordTemplate(messageText);
    if (keywordTemplate && database.conversations.getNonCustomerMessageCount(convo.id) <= 1) {
      const reply = keywordTemplate.message.replace(/\{first_name\}/g, firstName);
      setTimeout(() => {
        sendMessage(senderId, reply, platform);
        database.conversations.addMessage(convo.id, {
          id: generateId(),
          from: 'bot',
          text: reply,
          timestamp: new Date().toISOString(),
          templateUsed: keywordTemplate.name,
        });

        // Update lead interest based on keyword match
        const leadForInterest = database.leads.getById(convo.leadId);
        if (leadForInterest) {
          database.leads.update(leadForInterest.id, { interest: detectInterest(messageText) || leadForInterest.interest });
        }
      }, (keywordTemplate.delay || 30) * 1000);
    }

    // 2.5. Inventory matching â send matching vehicles from the lot
    const detectedInterest = detectInterest(messageText);
    if (detectedInterest) {
      const matches = inventoryModule.matchInventory(detectedInterest, { maxResults: 3 });
      if (matches.length > 0) {
        const inventoryMsg = inventoryModule.formatInventoryMessage(matches, firstName);
        setTimeout(() => {
          sendMessage(senderId, inventoryMsg, platform);
          database.conversations.addMessage(convo.id, {
            id: generateId(),
            from: 'bot',
            text: inventoryMsg,
            timestamp: new Date().toISOString(),
            templateUsed: 'Inventory Match',
          });
        }, 60 * 1000); // Send 60 seconds after, so it feels natural after the keyword reply
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

  console.log(`ð New Lead Ad submission: ${leadgenId}`);

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

      console.log(`â Lead captured: ${lead.name} - ${lead.interest}`);
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

    console.log(`ð¬ New comment from ${commenterName}: "${comment}"`);

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

  console.log(`ð± WhatsApp message from ${contactName} (${from}): "${messageText}"`);

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

  // First message â send greeting
  if (database.conversations.getMessageCount(convo.id, 'customer') === 1) {
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
      }, greeting.delay * 1000);
    }
  }

  // Keyword-matched auto-reply
  const keywordTemplate = findKeywordTemplate(messageText);
  if (keywordTemplate && database.conversations.getNonCustomerMessageCount(convo.id) <= 1) {
    const reply = keywordTemplate.message.replace(/\{first_name\}/g, firstName);
    setTimeout(() => {
      sendWhatsAppMessage(from, reply);
      database.conversations.addMessage(convo.id, {
        id: generateId(),
        from: 'bot',
        text: reply,
        timestamp: new Date().toISOString(),
        templateUsed: keywordTemplate.name,
      });
    }, (keywordTemplate.delay || 30) * 1000);
  }

  // Inventory matching
  const detectedInterest = detectInterest(messageText);
  if (detectedInterest) {
    const matches = inventoryModule.matchInventory(detectedInterest, { maxResults: 3 });
    if (matches.length > 0) {
      const inventoryMsg = inventoryModule.formatInventoryMessage(matches, firstName);
      setTimeout(() => {
        sendWhatsAppMessage(from, inventoryMsg);
        database.conversations.addMessage(convo.id, {
          id: generateId(),
          from: 'bot',
          text: inventoryMsg,
          timestamp: new Date().toISOString(),
          templateUsed: 'Inventory Match',
        });
      }, 60 * 1000);
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
      console.log(`ð¤ WhatsApp sent to +${to}`);
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
      console.log(`ð¤ WhatsApp template "${templateName}" sent to +${to}`);
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
      console.log(`ð¤ Sent message to ${recipientId}`);
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
    'precio', 'cuÃ¡nto', 'cuanto', 'cuesta', 'carro', 'coche', 'troca',
    'camioneta', 'interesa', 'puedo', 'tiene', 'estÃ¡n', 'favor', 'ayuda',
    'familia', 'grande', 'nueva', 'nuevo', 'usada', 'usado', 'vender',
    'comprar', 'financiar', 'crÃ©dito', 'credito', 'enganche', 'mensual',
    'por favor', 'seÃ±or', 'amigo', 'millas', 'aÃ±o',
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
  // Best posting times for car sales (Pacific Time â Las Vegas)
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

  // TikTok-specific hashtag sets (TikTok uses FEWER hashtags â 3-5 trending ones, not 15)
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
    // FB/IG default â full hashtag spread
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

  // Caption hooks â attention-grabbing first lines (the algorithm rewards stop-the-scroll openers)
  hooks: {
    sold: [
      'ð¨ ANOTHER ONE OFF THE LOT!',
      'ð Keys handed. Smiles earned.',
      'ð¥ SOLD! Who\'s next?',
      'ð Congratulations are in order!',
      'ð Another happy customer just drove off!',
      'ð¸ That new car smell hits different...',
    ],
    deals: [
      'ð¨ STOP SCROLLING â You need to see this deal.',
      'ð° Your wallet is going to thank you.',
      'â° This deal expires soon. Don\'t sleep on it.',
      'ð¥ The kind of deal your neighbor wishes they got.',
      'ð Prices just dropped. Seriously.',
      'ð¥ If you\'ve been waiting for the right time â THIS IS IT.',
    ],
    inventory: [
      'ð Look what just hit the lot...',
      'ð JUST ARRIVED and it won\'t last long.',
      'ð¥ Fresh off the truck. Come see it before it\'s gone.',
      'ð I had to stop and take a picture of this one.',
      'ð£ New arrival alert! This one is special.',
      'ð Tell me this doesn\'t look good...',
    ],
    brand: [
      'ðª Let me tell you something about this business...',
      'ð¯ Here\'s what they don\'t tell you about car sales.',
      'ð The grind never stops, and neither do I.',
      'ð Another day, another record at Findlay.',
      'ð¤ This job isn\'t about cars â it\'s about people.',
    ],
    testimonial: [
      'â­ Don\'t take my word for it â hear from my customers.',
      'ð£ THIS is why I do what I do.',
      'ð Nothing beats a happy customer review.',
      'ð¯ Real customer. Real experience. Real results.',
      'â­â­â­â­â­ Another 5-star review!',
    ],
    walkaround: [
      'ð¥ Let me walk you through this beauty...',
      'ð SAVE THIS for when you\'re ready to buy.',
      'ð Everything you need to know about this one.',
      'ð Let me show you why this is selling fast.',
      'ð¬ Full walkaround â see every angle.',
    ],
    financing: [
      'ð¡ SAVE THIS â you\'ll need it when buying a car.',
      'ð¦ Think you can\'t get approved? Think again.',
      'ð Let me break down car financing for you.',
      'ð° How to get the BEST deal on your next car.',
      'ð¤ First time buying? Here\'s what you need to know.',
    ],
    comparison: [
      'ð¤ Which one would YOU pick?',
      'âï¸ HEAD TO HEAD â let\'s settle this.',
      'ð The comparison you\'ve been waiting for.',
      'ð There can only be one winner...',
      'ð Comment which one you\'d drive home!',
    ],
  },

  // DM-trigger CTAs â these drive direct lead capture
  ctas: {
    soft: [
      'DM me "INFO" and I\'ll send you the details.',
      'Drop a ð¥ in the comments if you want to know more.',
      'Comment "DEAL" and I\'ll reach out personally.',
      'Send me a message â I respond fast.',
      'Tap that message button â let\'s talk.',
    ],
    medium: [
      'DM me "PRICE" for exclusive pricing on this one.',
      'Comment "INTERESTED" and I\'ll DM you the breakdown.',
      'Type "MINE" in the comments and I\'ll lock this deal for you.',
      'DM me your trade-in year/model for an instant quote.',
      'Comment your budget range â I\'ll find the perfect match.',
    ],
    strong: [
      'ð¨ DM me "READY" to get pre-approved in minutes.',
      'Comment "PAYMENT" and I\'ll DM you monthly options.',
      'First 3 people to DM me get VIP pricing. Go!',
      'DM me now â this one has 2 people looking at it already.',
      'Comment "SOLD" before someone else does!',
    ],
    softES: [
      'MÃ¡ndame un mensaje con "INFO" y te doy todos los detalles.',
      'Deja un ð¥ en los comentarios si te interesa.',
      'Comenta "PRECIO" y te contacto personalmente.',
      'MÃ¡ndame mensaje â respondo rÃ¡pido.',
    ],
    mediumES: [
      'EscrÃ­beme "PRECIO" para un precio exclusivo.',
      'Comenta "INTERESADO" y te mando la info por DM.',
      'MÃ¡ndame el aÃ±o/modelo de tu carro actual para una cotizaciÃ³n.',
    ],
    strongES: [
      'ð¨ EscrÃ­beme "LISTO" para pre-aprobarte en minutos.',
      'Comenta "PAGO" y te mando las opciones de pago mensual.',
      'Â¡Los primeros 3 que me escriban reciben precio VIP!',
    ],
  },

  // Content mix recommendations (weekly)
  contentMix: {
    ideal: {
      sold_customer: { pct: 25, perWeek: 2, why: 'Social proof is your #1 lead driver â people buy from winners' },
      current_deal: { pct: 15, perWeek: 1, why: 'Urgency-driven deals convert fence-sitters; don\'t overdo or it feels spammy' },
      inventory_highlight: { pct: 20, perWeek: 2, why: 'Showcasing inventory keeps you top-of-mind for active shoppers' },
      personal_brand: { pct: 10, perWeek: 1, why: 'People buy from PEOPLE â let them know the real you' },
      testimonial: { pct: 15, perWeek: 1, why: 'Third-party validation crushes objections before they start' },
      walkaround: { pct: 10, perWeek: 1, why: 'Video/carousel walkarounds get 3x more saves â saves = future buyers' },
      financing: { pct: 5, perWeek: 0.5, why: 'Education builds trust and targets first-time buyers (huge market)' },
      comparison: { pct: 0, perWeek: 0.5, why: 'Comparison posts spark debates in comments = free algorithm boost' },
    },
    weeklyTotal: 8,
  },

  // Caption scoring â rate how optimized a caption is for lead gen
  scoreCaption: (caption, postType) => {
    let score = 0;
    const checks = [];

    // 1. Has a hook/attention-grabber in the first line (20 pts)
    const firstLine = caption.split('\n')[0];
    if (firstLine && (firstLine.includes('ð¨') || firstLine.includes('ð¥') || firstLine.includes('ð¥') || firstLine.includes('ð') || firstLine.includes('â­') || firstLine.length < 60)) {
      score += 20; checks.push({ name: 'Strong hook', passed: true, pts: 20 });
    } else {
      checks.push({ name: 'Strong hook', passed: false, pts: 0, tip: 'Start with an emoji + short punchy line to stop the scroll' });
    }

    // 2. Has a CTA / call to action (25 pts â most important)
    const ctaPatterns = /\b(DM|dm|comment|tag|share|message|call|text|click|tap|link in bio|reach out|escr[iÃ­]beme|comenta|manda|mensaje)\b/i;
    if (ctaPatterns.test(caption)) {
      score += 25; checks.push({ name: 'Clear CTA', passed: true, pts: 25 });
    } else {
      checks.push({ name: 'Clear CTA', passed: false, pts: 0, tip: 'Add a DM trigger like "Comment DEAL for pricing" â this is how you capture leads' });
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
    if (/findlay|#1 volume|number one|nÃºmero uno/i.test(caption)) {
      score += 10; checks.push({ name: 'Dealership credibility', passed: true, pts: 10 });
    } else {
      checks.push({ name: 'Dealership credibility', passed: false, pts: 0, tip: 'Mention Findlay Chevrolet or "#1 volume dealer" for credibility' });
    }

    // 5. Urgency / scarcity language (10 pts)
    if (/won't last|limited|hurry|expires|only \d|don't miss|last chance|act now|running out|no dura|se acaba|Ãºltim/i.test(caption)) {
      score += 10; checks.push({ name: 'Urgency/scarcity', passed: true, pts: 10 });
    } else {
      if (['current_deal', 'inventory_highlight'].includes(postType)) {
        checks.push({ name: 'Urgency/scarcity', passed: false, pts: 0, tip: 'Add urgency: "Won\'t last long" or "Only 2 left" drives action' });
      } else {
        score += 5; checks.push({ name: 'Urgency/scarcity', passed: true, pts: 5, tip: 'Optional for this post type' });
      }
    }

    // 6. Bilingual / Spanish touch (5 pts)
    if (/[Ã¡Ã©Ã­Ã³ÃºÃ±Â¿Â¡]|habla|espaÃ±ol|spanish/i.test(caption)) {
      score += 5; checks.push({ name: 'Bilingual touch', passed: true, pts: 5 });
    } else {
      checks.push({ name: 'Bilingual touch', passed: false, pts: 0, tip: 'Add "Hablo EspaÃ±ol" to capture bilingual leads' });
    }

    // 7. Line breaks / readability (10 pts)
    const lineBreaks = (caption.match(/\n/g) || []).length;
    if (lineBreaks >= 3) {
      score += 10; checks.push({ name: 'Readability (spacing)', passed: true, pts: 10 });
    } else {
      checks.push({ name: 'Readability (spacing)', passed: false, pts: 0, tip: 'Use line breaks between sections â walls of text get scrolled past' });
    }

    // 8. Caption length sweet spot (10 pts)
    const len = caption.length;
    if (len >= 150 && len <= 600) {
      score += 10; checks.push({ name: 'Optimal length', passed: true, pts: 10 });
    } else if (len < 150) {
      checks.push({ name: 'Optimal length', passed: false, pts: 0, tip: 'Too short â aim for 150-600 chars. More text = more keywords for discovery' });
    } else {
      score += 5; checks.push({ name: 'Optimal length', passed: true, pts: 5, tip: 'A bit long â consider trimming. IG truncates after 125 chars in feed' });
    }

    return { score, maxScore: 100, checks };
  },

  // Coaching tips per post type
  tips: {
    sold_customer: [
      'ALWAYS include a photo with the customer + vehicle â these get 3x more engagement',
      'Tag the customer (ask permission first) â their friends see it = free referrals',
      'Post SOLD photos within 30 minutes of delivery while energy is high',
      'Ask the customer for a quick selfie video saying "thanks Gabe!" for Stories',
      'Bilingual tip: Post English caption, add Spanish in first comment to double reach',
    ],
    current_deal: [
      'Lead with the MONTHLY PAYMENT, not the full price â that\'s what buyers think about',
      'Create urgency with real deadlines â "ends this Saturday" converts better than "limited time"',
      'Use the "Comment DEAL" CTA â it triggers the algorithm AND captures the lead',
      'Post deals Tuesday-Thursday when people are planning weekend visits',
      'Add "Se habla EspaÃ±ol" â bilingual deals reach 40%+ more people in Vegas',
    ],
    inventory_highlight: [
      'Multiple photos > single photo â carousels get 2x more engagement on IG',
      'Show the BEST feature first (wheels, interior, tech screen) â that\'s your scroll-stopper',
      'Include the price if competitive â "Starting at $XX,XXX" removes a barrier to DM',
      'Pair with Reels: 15-sec walkaround with trending audio = massive reach',
      'Post new arrivals on Wednesdays and Fridays â shoppers browse before the weekend',
    ],
    personal_brand: [
      'Show your face â posts with faces get 38% more engagement on IG',
      'Share your WHY, not just your wins â vulnerability builds connection',
      'Behind-the-scenes content humanizes you â show the early mornings, the grind',
      'Celebrate milestones publicly (monthly sales record, customer count, etc.)',
      'Engage in comments for 15 min after posting â the algorithm rewards it',
    ],
    testimonial: [
      'Screenshot real reviews/texts (with permission) â authenticity beats polish',
      'Video testimonials outperform text 5:1 â even a 10-sec phone clip works',
      'Pair the testimonial with the customer\'s delivery photo for maximum impact',
      'Add "Want the same experience? DM me" â direct conversion CTA',
      'Post testimonials on Mondays â sets positive tone for the week + shoppers researching',
    ],
    walkaround: [
      'Keep walkaround videos to 30-60 seconds â attention spans are short',
      'Start with the exterior money shot, end with the driver\'s seat POV',
      'Call out 3 standout features by name â this helps with search/discovery',
      'Add captions/text overlay â 85% of FB/IG video is watched on mute',
      'End with "Save this for later" â saves tell the algorithm to push it further',
    ],
    financing: [
      'Use simple language â your audience isn\'t finance experts',
      'Lead with "First time buyer?" or "Credit concerns?" to attract your target',
      'Never promise specific rates â say "rates as low as" to stay compliant',
      'These posts have a LONG shelf life â people save them and come back months later',
      'Pair with a "DM me APPROVED for a free credit check" CTA',
    ],
    comparison: [
      'Silverado vs. F-150, Tahoe vs. Expedition â these spark DEBATES (= free engagement)',
      'Use a side-by-side image or carousel format for maximum visual impact',
      'Ask "Which one would you pick?" â questions in captions boost comments 3x',
      'Stay factual and fair â but let Chevy\'s numbers speak for themselves',
      'Post comparisons on weekends when people have time to engage in comments',
    ],
  },

  // ==================== TIKTOK-SPECIFIC OPTIMIZATION ====================
  // TikTok is a DIFFERENT animal â short-form video, trending sounds, FYP algorithm

  tiktok: {
    // TikTok hooks â MUST grab attention in the first 1-3 seconds or you're dead
    hooks: {
      sold: [
        'POV: Another customer just drove off in their dream car',
        'Watch their face when they get the keys ð',
        'They said they couldn\'t get approved... LOOK AT THEM NOW',
        'From test drive to SOLD in one day ð',
        'The reaction when they see the final payment ð°',
        'Handing over the keys never gets old',
      ],
      deals: [
        'This deal is actually insane and here\'s why',
        'If you\'re looking for a truck, STOP SCROLLING',
        'I\'m not supposed to show you this deal but...',
        'Your car payment could be THIS low ð',
        'This is the deal your neighbor doesn\'t want you to know about',
        'POV: You find out about 0% APR',
      ],
      inventory: [
        'Wait for it... ð',
        'Tell me this isn\'t the cleanest thing you\'ve seen today',
        'This just hit the lot and it WON\'T last',
        'Rate this spec 1-10 ð',
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
        'When your customer gives you a 5-star review ð¥¹',
        'This is why I love my job',
        'POV: Your customer sends you THIS text',
        'They drove 2 hours just to buy from me. Here\'s why.',
        'The review that made my whole week',
      ],
      walkaround: [
        'Let me show you something real quick',
        'If you don\'t watch this whole thing you\'re sleeping on it',
        'Every feature on this thing is insane ð¥',
        'The interior on this one hits DIFFERENT',
        'You need to see the back seat on this one',
        '60 seconds with the new ${model} ð',
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
        'Which one are you picking? ð',
        'The numbers don\'t lie. Watch this.',
        'POV: You\'re trying to decide between these two',
      ],
    },

    // TikTok CTAs â different vibe than FB/IG (more casual, engagement-focused)
    ctas: {
      soft: [
        'Follow for more car content ð',
        'Drop a ð¥ if you\'d drive this',
        'Save this for later ð',
        'Which color would you pick? Comment below ð',
        'Tag someone who needs to see this',
      ],
      medium: [
        'Comment "INFO" and I\'ll DM you everything',
        'Link in bio to see what we have in stock',
        'Comment your dream car â I\'ll find it for you',
        'DM me "DEAL" for pricing ð°',
        'Follow + comment "MINE" and I\'ll reach out',
      ],
      strong: [
        'Comment "READY" and I\'ll get you pre-approved TODAY',
        'First 5 people to DM me get VIP pricing ð¨',
        'Comment "PAYMENT" â I\'ll DM you what your monthly would be',
        'This one has 3 people looking at it. DM me NOW if you want it',
        'Link in bio â apply in 60 seconds ð¥',
      ],
      softES: [
        'SÃ­gueme para mÃ¡s contenido de carros ð',
        'Deja un ð¥ si manejarÃ­as esto',
        'GuÃ¡rdalo para despuÃ©s ð',
        'Etiqueta a alguien que necesita ver esto',
      ],
      mediumES: [
        'Comenta "INFO" y te escribo por DM',
        'Link en mi bio para ver inventario',
        'EscrÃ­beme "PRECIO" para mÃ¡s detalles ð°',
      ],
      strongES: [
        'Comenta "LISTO" y te pre-apruebo HOY',
        'Â¡Los primeros 5 en escribirme reciben precio VIP! ð¨',
        'Link en mi bio â aplica en 60 segundos ð¥',
      ],
    },

    // TikTok tips per post type
    tips: {
      sold_customer: [
        'Film the KEY HANDOFF moment â that 3-second clip is gold for TikTok',
        'Use trending sounds behind delivery videos â the algorithm pushes them 10x harder',
        'Show the customer\'s genuine reaction, not a posed photo â authenticity wins on TikTok',
        'Keep it 15-30 seconds MAX â shorter TikToks get more replays = more reach',
        'Add text overlay: "From test drive to SOLD" â 90% of TikTok is watched on mute',
        'Post delivery TikToks between 7-8PM when the evening scroll peaks',
      ],
      current_deal: [
        'Start with the PAYMENT, not the car â "Your payment could be $389/mo" hooks harder',
        'Use the "I\'m not supposed to show you this" format â it creates curiosity',
        'Green screen yourself in front of the vehicle with the deal details on screen',
        'Keep deal TikToks under 20 seconds â urgency should feel fast',
        'Pin a comment with "DM me DEAL for details" â pinned comments get 3x more action',
        'Use the "POV" format: "POV: You find out about this deal" with the price reveal',
      ],
      inventory_highlight: [
        'Trending audio + slow-mo exterior shot = viral potential on car TikTok',
        'The "reveal" format works huge: start blurry/covered, then show the car',
        'Film at golden hour (sunrise/sunset) â the lighting makes any car look incredible',
        '"Rate this spec 1-10" in the caption drives massive comment engagement',
        'Carousel TikToks (photo mode) work great for interior/exterior shots',
        'Reply to comments with new TikToks showing the features they asked about',
      ],
      personal_brand: [
        '"Day in the life" content is KING on car sales TikTok â people love BTS',
        'Show the real grind: early mornings, lot walks, customer handshakes, the hustle',
        'Story time format: "How I sold 3 cars in one day" with you talking to camera',
        'Reply to hate comments with calm, professional TikToks â controversy = views',
        'Show your commission check reactions (without exact numbers) â aspirational content performs',
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
        'TikTok walkarounds should be 30-60 seconds MAX â not a full tour, just the highlights',
        'Start with the BEST feature (engine sound, interior tech, wheels) not the front bumper',
        'Use POV angles â show what the DRIVER sees, not just the outside',
        'Trending audio behind walkarounds gets 5-10x more FYP placement than original audio',
        'End with "Follow for more" and a question â the algorithm pushes videos with engagement',
        'Film VERTICAL â this is TikTok, not YouTube. Fill the whole screen.',
      ],
      financing: [
        '"Watch this if you think you can\'t afford a new car" â this hook gets first-time buyers',
        'Use the green screen effect with financing tips as bullet points behind you',
        'The "3 things your dealer won\'t tell you" format builds trust and goes viral',
        'Keep financing TikToks educational, not salesy â the algorithm suppresses hard sells',
        'These have INSANE shelf life on TikTok â people find them months later via search',
        'Add "Part 1" to the caption even on standalone posts â it makes people check your page for more',
      ],
      comparison: [
        'Side-by-side video transitions between the two vehicles get massive engagement',
        '"Which one?" with a poll sticker (available on some versions) drives interaction',
        'Let the comments debate â DO NOT argue. Just reply with facts and let it cook',
        'Film both vehicles at the same angle/location for a fair visual comparison',
        'These are your BEST content type for TikTok virality â controversial takes = views',
        'The "I put them side by side and the winner is clear" hook gets people to watch till the end',
      ],
    },

    // TikTok-specific content strategy
    strategy: {
      postingFrequency: '1-3 TikToks per day is ideal (consistency > quality on TikTok)',
      videoLength: '15-60 seconds sweet spot. Under 30 seconds for deals/inventory. 30-60 for walkarounds/brand.',
      format: 'ALWAYS vertical (9:16). Use the full screen. No black bars.',
      audio: 'Trending sounds get 3-5x more FYP placement. Check TikTok\'s trending page weekly.',
      captions: 'Keep TikTok captions SHORT â 1-2 lines max. The video does the talking.',
      hashtags: '3-5 relevant hashtags only. #cartok #carsales #fyp + 2 niche ones.',
      engagement: 'Reply to EVERY comment in the first hour. Reply to comments with new videos for 2x content.',
      crossPost: 'Repost your best TikToks as IG Reels and FB Reels â one video, three platforms.',
      bestContent: 'Car sales TikTok goldmine: key handoffs, customer reactions, day-in-life, deal reveals, walkarounds with trending audio',
    },
  },
};

// -- Meta Algorithm-Optimized Post Engine --
// Strategy: Hook â Value â CTA â Hashtags (bilingual EN+ES)
// Hashtags: 3-5 branded + 5-8 niche/location + 2-3 trending = 10-16 total (Meta sweet spot)
// Line breaks for readability (algorithm rewards time-on-post)

// Hashtag engine â mixes branded, niche, location, and engagement tags
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

// Engagement hooks â Meta rewards posts that stop the scroll
const HOOKS = {
  sold_customer: [
    'SOLD! ðð',
    'Another one OFF the lot! ð',
    'Keys delivered. Dreams realized. ðâÂÃÂ¨',
    'This is why I do what I do ð',
    'CONGRATULATIONS are in order! ð',
  ],
  current_deal: [
    'ð¨ DEAL ALERT ð¨',
    'You\'re gonna want to see this ð',
    'My manager said YES to this one ð¤',
    'This deal won\'t last â real talk ð¯',
    'READ THIS before you buy anywhere else â¬Âï¸',
  ],
  inventory_highlight: [
    'JUST HIT THE LOT ð¥',
    'Fresh off the truck ðâÂÃÂ¨',
    'This one won\'t sit long ð',
    'Who wants it? ðâÂÂâÂÂï¸',
    'Stop scrolling â look at this beauty ð',
  ],
  personal_brand: [
    'Let me keep it real with you ð¯',
    'People always ask me how I do it...',
    'This is what moving metal looks like ðª',
    'Grateful for another day on the lot ð',
    'The grind doesn\'t stop ð',
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
        `${hook}\n\nHuge congrats to ${data.customerName} on their brand new ${vehicle}! ðð¨\n\nThis is what happens when you trust the process. You come in, we find the perfect ride, and you drive off HAPPY.\n\nReady to be next? DM me or call/text â I got you.\nð± (702) 416-3741\n\n${getHashtags('sold_customer', data)}`,
        `${hook}\n\n${data.customerName} just drove off in a BRAND NEW ${vehicle} and I couldn't be more hyped for them! ð¥\n\nFrom the test drive to the handshake â we made it happen at Findlay Chevrolet, the #1 volume dealer west of Texas.\n\nWho's next? Drop a ð if you're ready!\n\n${getHashtags('sold_customer', data)}`,
        `${hook}\n\nWelcome to the family, ${data.customerName}! ð¤\n\nYou came in looking for the right ${data.vehicleModel || 'ride'} and we got you RIGHT. That's how we do it at Findlay Chevy.\n\nIf you or someone you know is in the market â send them my way. I take care of my people. ð¯\n\n${getHashtags('sold_customer', data)}`,
      ];
      return pickRandom(captions);
    },
    generateCaptionES: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      return `Â¡VENDIDO! ðð\n\nÂ¡Felicidades a ${data.customerName} por su ${vehicle} nuevo! ðð¨\n\nEsto es lo que pasa cuando confÃ­as en el proceso. Vienes, encontramos el carro perfecto, y te vas FELIZ.\n\nÂ¿Listo para ser el siguiente? MÃ¡ndame mensaje o llÃ¡mame â yo te ayudo.\nð± (702) 416-3741\n\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('sold_customer', data)}`;
    },
    generateBilingual: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const hook = pickRandom(HOOKS.sold_customer);
      return `${hook}\n\nCongrats to ${data.customerName} on their brand new ${vehicle}! ðð¨\nAnother happy customer driving off the lot at Findlay Chevrolet â the #1 volume dealer west of Texas.\n\nReady to be next? DM me or call/text ð± (702) 416-3741\n\nâ\n\nÂ¡Felicidades a ${data.customerName} por su ${vehicle} nuevo! ð\nOtro cliente feliz saliendo de Findlay Chevrolet. Â¿Listo para ser el siguiente?\n\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('sold_customer', data)}`;
    },
  },
  current_deal: {
    type: 'current_deal',
    label: 'Current Deal / Special',
    fields: ['dealTitle', 'vehicleModel', 'dealDetails', 'expirationDate', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.current_deal);
      return `${hook}\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? 'âÂÃÂ° Expires ' + data.expirationDate + ' â don\'t sleep on this!' : 'This won\'t last â first come, first served!'}\n\nDM me, call, or just pull up to Findlay Chevrolet. I'll make it happen. ð¤\nð± (702) 416-3741\n\n${getHashtags('current_deal', data)}`;
    },
    generateCaptionES: (data) => {
      return `ð¨ OFERTA ð¨\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? 'âÂÃÂ° Vence ' + data.expirationDate + ' â Â¡no te lo pierdas!' : 'Â¡No dura para siempre â primero que llegue!'}\n\nMÃ¡ndame mensaje, llÃ¡mame, o ven directo a Findlay Chevrolet. Yo te ayudo. ð¤\nð± (702) 416-3741\n\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('current_deal', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.current_deal);
      return `${hook}\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? 'âÂÃÂ° Expires ' + data.expirationDate : 'Won\'t last long!'} DM me or call ð± (702) 416-3741\n\nâ\n\n${data.dealTitle}\n${data.dealDetails}\n${data.expirationDate ? 'âÂÃÂ° Vence ' + data.expirationDate : 'Â¡ApÃºrate!'}\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('current_deal', data)}`;
    },
  },
  inventory_highlight: {
    type: 'inventory_highlight',
    label: 'Inventory Highlight',
    fields: ['vehicleYear', 'vehicleModel', 'vehicleTrim', 'price', 'highlights', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.inventory_highlight);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? 'ð° $' + Number(data.price).toLocaleString() : '';
      return `${hook}\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Loaded and ready to roll.'}\n\nWant to see it in person? Schedule a test drive â DM me or hit my line:\nð± (702) 416-3741\n\nFindlay Chevrolet â #1 volume dealer west of Texas ð\n\n${getHashtags('inventory_highlight', data)}`;
    },
    generateCaptionES: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? 'ð° $' + Number(data.price).toLocaleString() : '';
      return `ACABA DE LLEGAR ð¥\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Cargado y listo para rodar.'}\n\nÂ¿Quieres verlo en persona? Agenda un test drive â mÃ¡ndame mensaje:\nð± (702) 416-3741\n\nFindlay Chevrolet â Dealer #1 en volumen al oeste de Texas ð\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('inventory_highlight', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.inventory_highlight);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? 'ð° $' + Number(data.price).toLocaleString() : '';
      return `${hook}\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Loaded and ready.'}\n\nDM me or call ð± (702) 416-3741\n\nâ\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n${data.highlights || 'Cargado y listo.'}\nMÃ¡ndame mensaje ð± (702) 416-3741\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('inventory_highlight', data)}`;
    },
  },
  personal_brand: {
    type: 'personal_brand',
    label: 'Personal Brand Content',
    fields: ['message', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.personal_brand);
      return `${hook}\n\n${data.message}\n\nIf you know someone looking for a car â send them my way. I take care of my people. Always. ð¤\n\nâ Gabe Barajas\nFindlay Chevrolet | Las Vegas\nð± (702) 416-3741\n\n${getHashtags('personal_brand', data)}`;
    },
    generateCaptionES: (data) => {
      return `ð¯\n\n${data.message}\n\nSi conoces a alguien buscando carro â mÃ¡ndamelos. Yo cuido a mi gente. Siempre. ð¤\n\nâ Gabe Barajas\nFindlay Chevrolet | Las Vegas\nð± (702) 416-3741\nHablo espaÃ±ol ð²ð½ðºð¸\n\n${getHashtags('personal_brand', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.personal_brand);
      return `${hook}\n\n${data.message}\n\nKnow someone looking for a car? Send them my way. ð¤\nÂ¿Conoces a alguien buscando carro? MÃ¡ndamelos. ð²ð½ðºð¸\n\nâ Gabe Barajas\nFindlay Chevrolet | Las Vegas\nð± (702) 416-3741\n\n${getHashtags('personal_brand', data)}`;
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
    console.log(`ð Facebook post published: ${result.id || result.post_id}`);
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
    console.log(`ð¸ Instagram post published: ${result.id}`);
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
      // No TikTok API â return as "queued" for manual posting
      // The caption is optimized and ready to copy-paste
      console.log(`ðµ TikTok post queued (manual): caption ready for copy-paste`);
      return {
        success: true,
        platform: 'tiktok',
        mode: 'manual',
        note: 'TikTok caption generated â copy to TikTok app. Connect TikTok API for auto-posting.',
        caption: caption,
      };
    }

    // TikTok Content Posting API v2 â Direct publish
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
      console.log(`ðµ TikTok video published: ${initResult.data?.publish_id}`);
      return { success: true, platform: 'tiktok', publishId: initResult.data?.publish_id };
    }

    // Photo mode (TikTok Photo Mode â carousel-style)
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
      console.log(`ðµ TikTok photo post published: ${initResult.data?.publish_id}`);
      return { success: true, platform: 'tiktok', publishId: initResult.data?.publish_id };
    }

    // No media â TikTok requires video or photo
    return {
      success: true,
      platform: 'tiktok',
      mode: 'manual',
      note: 'TikTok requires video or photo. Caption generated â copy to TikTok app.',
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

  // Build short TikTok caption (TikTok truncates long captions â keep it punchy)
  let caption = `${hook}\n\n${cta}\n\n${hashtags}`;

  return caption;
}

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
    es: 'Write the caption in Spanish only. Include "Hablo espa\u00f1ol" somewhere.',
    bilingual: 'Write the caption in BOTH English and Spanish. Put the English version first, then a line break with "\u2014", then the Spanish version. Include "Hablo espa\u00f1ol" with flag emojis in the Spanish section.',
  };

  // ==================== META (FACEBOOK/INSTAGRAM) ALGORITHM PROMPT ====================
  const metaPrompt = `You are an elite social media strategist and caption writer for Gabe Barajas, a bilingual car salesman at Findlay Chevrolet in Las Vegas \u2014 the #1 volume Chevy dealer west of Texas. His brand is "Gabe Moves Metal."

Write a Facebook/Instagram post caption for \${typeDescriptions[type] || 'a social media post'}.

POST DATA:
\${JSON.stringify(data, null, 2)}
\${customerContext ? '\nCUSTOMER CONTEXT:\n' + customerContext : ''}

=== META ALGORITHM DEEP KNOWLEDGE (2024-2026) ===
You must apply these algorithm signals to maximize reach and engagement:

RANKING SIGNALS (in order of weight):
1. MEANINGFUL INTERACTIONS \u2014 Comments, shares, and saves outweigh likes 10:1. Write captions that ASK questions or spark debate to drive comments. Shares = exponential reach.
2. DWELL TIME \u2014 Meta tracks how long people stop scrolling on your post. Use line breaks, storytelling, and curiosity gaps to keep people reading longer.
3. SAVES \u2014 The #1 hidden power metric. "Save this for later" content gets pushed 3-5x harder. Educational or deal-related posts should prompt saves.
4. ORIGINAL CONTENT \u2014 Meta actively deprioritizes recycled/reposted content. Every caption must feel fresh, personal, and unique.
5. CONVERSATION STARTERS \u2014 Posts that generate back-and-forth replies (not just single comments) get massive distribution boosts.

CONTENT FORMAT OPTIMIZATION:
- Carousel posts get 2-3x more engagement than single images on IG \u2014 mention "swipe" if applicable
- Reels get 4x the organic reach of static posts \u2014 if this is for video content, optimize accordingly
- Stories drive DMs which Meta weighs heavily \u2014 include a "DM me" CTA
- Facebook Groups shares amplify reach 5x vs feed-only posts

CAPTION STRUCTURE (the winning formula):
1. HOOK (Line 1): Must stop the scroll in under 1.5 seconds. Use pattern interrupts \u2014 ALL CAPS opener, emoji + bold statement, or a controversial/curiosity-driven question. This is THE most important line.
2. STORY/VALUE (Lines 2-6): Deliver the meat \u2014 the deal details, the customer story, the vehicle specs. Use short paragraphs with line breaks. Every line should earn the next line being read.
3. SOCIAL PROOF: Weave in credibility \u2014 "#1 volume dealer", customer count, years of experience, or specific results.
4. CTA (Call to Action): One clear, specific action. "DM me DEAL" converts better than "contact us". Use DM-trigger keywords (comment a specific word) \u2014 these create micro-commitments that boost conversion AND engagement signals.
5. HASHTAGS: 10-15 total. Mix: 3 branded (#GabeMovesmetal #FindlayChevrolet #FindlayChevy), 3 location (#LasVegas #Vegas #Henderson), 5-7 niche + model-specific. Place AFTER the caption, separated by line breaks.

ENGAGEMENT HACKS:
- Ask "this or that" questions to spark debates in comments (Meta LOVES comment threads)
- Use "Comment [KEYWORD] for..." DM triggers \u2014 they boost engagement metrics AND capture leads
- Tag location (Las Vegas, NV) \u2014 local content gets preferential distribution in the area
- Post between 11am-1pm or 7-9pm local time for maximum initial engagement velocity
- Respond to every comment within the first hour \u2014 the algorithm rewards active creators
- Use 3-6 emojis strategically (not randomly) \u2014 they increase readability and stop-rate

WHAT TO AVOID (algorithm penalties):
- Engagement bait like "Like if you agree" \u2014 Meta explicitly suppresses this
- External links in the caption (kills reach by 40-60%) \u2014 put links in comments or bio instead
- Walls of text with no line breaks \u2014 people scroll past, tanking your dwell time
- Generic/corporate language \u2014 the algorithm favors authentic, personal content
- Posting more than 2x/day on the same page \u2014 oversaturation hurts per-post reach

RULES:
- Include Gabe's phone: (702) 416-3741
- Keep it authentic, energetic, and conversational \u2014 NOT corporate
- Use emojis naturally (3-6 per post)
- If the vehicle model is mentioned, include a hashtag for it
- Never use the word "utilize" or sound like a robot
- Sound like a real person who genuinely loves selling cars
- If customer context/story is provided, weave those details naturally to make it personal

\${languageInstructions[language] || languageInstructions.bilingual}

Write ONLY the caption text. No explanations or metadata.`;

  // ==================== TIKTOK ALGORITHM PROMPT ====================
  const tiktokPrompt = `You are an elite TikTok content strategist and caption writer for Gabe Barajas, a bilingual car salesman at Findlay Chevrolet in Las Vegas \u2014 the #1 volume Chevy dealer west of Texas. His brand is "Gabe Moves Metal." His TikTok handle is @gabemovesmetal.

Write a TikTok caption for \${typeDescriptions[type] || 'a social media post'}.

POST DATA:
\${JSON.stringify(data, null, 2)}
\${customerContext ? '\nCUSTOMER CONTEXT:\n' + customerContext : ''}

=== TIKTOK ALGORITHM DEEP KNOWLEDGE (2024-2026) ===
TikTok's algorithm is FUNDAMENTALLY different from Meta. Apply these signals:

HOW THE FYP (FOR YOU PAGE) ALGORITHM WORKS:
1. WATCH TIME / COMPLETION RATE \u2014 This is THE #1 ranking signal. TikTok measures what % of your video people watch. Captions must create curiosity that makes people watch to the end. Use "Wait for it..." or "Watch till the end" hooks.
2. REWATCH RATE \u2014 Videos people watch multiple times get pushed HARD. Captions that tease a reveal or surprise drive replays.
3. SHARES > COMMENTS > LIKES \u2014 Shares carry the most weight on TikTok. Write captions that make people want to send the video to a friend ("Tag someone who needs this truck").
4. PROFILE VISITS \u2014 If your caption drives people to your profile, TikTok reads that as high-value content. Include "Follow for daily car content" or reference your other videos.
5. SEARCH/SEO \u2014 TikTok is now a SEARCH ENGINE for Gen Z and Millennials. Use keywords people actually search: "best truck deals Las Vegas", "how to buy a car with bad credit", "2026 Chevy Silverado review".

TIKTOK CAPTION RULES (completely different from Meta):
- KEEP IT SHORT: 1-2 lines max. The VIDEO does the talking on TikTok, not the caption.
- FRONT-LOAD with a hook that creates curiosity or FOMO
- Use lowercase, casual tone \u2014 TikTok is NOT Facebook. It should sound like you're texting a friend.
- NO hashtag walls. Use 3-5 MAX: #cartok #carsales #fyp + 1-2 specific ones
- #fyp and #foryou still work for initial distribution \u2014 always include one
- Searchable captions > clever captions. Include keywords people search for.

TIKTOK HOOK FORMULAS THAT GO VIRAL (use one):
- "POV: [scenario]" \u2014 immersive, first-person hooks dominate car TikTok
- "This is your sign to..." \u2014 trigger FOMO and action
- "Wait for it..." \u2014 creates watch-time because people stay for the payoff
- "I'm not supposed to show you this but..." \u2014 curiosity gap = completion rate boost
- "Reply to @[comment]" \u2014 reply videos get 2x distribution AND build community
- "[Number] things about [topic]" \u2014 list format = predictable watch time for the algorithm
- "They said [objection]... watch this" \u2014 overcoming doubts = relatable + shareable

TIKTOK CTA STRATEGY:
- "Comment [WORD]" CTAs work on TikTok too but keep them casual
- "Follow for part 2" \u2014 even on standalone videos, this drives profile visits (key signal)
- Pin a comment with your DM trigger \u2014 pinned comments get 3x more clicks
- "Link in bio" works on TikTok when you have 1k+ followers
- "Duet this" or "Stitch this" \u2014 inviting collabs = algorithmic boost from UGC signals

TRENDING SOUNDS & FORMATS:
- Using a trending sound gives 3-10x more FYP placement vs original audio
- Always mention "trending sound" or "use a trending audio" in the caption context if relevant
- Transition videos (before/after, lot to customer delivery) perform extremely well
- Green screen format for deal reveals and financing tips
- "Day in the life" series content builds loyal followers

TIKTOK SEARCH SEO (this is huge \u2014 TikTok is replacing Google for car shopping):
- Include searchable phrases naturally: "best car deals in Las Vegas", "Chevy dealer near me", "how to finance a car"
- Model names are SEARCHED heavily: "2026 Silverado", "Equinox EV", "Chevy Trax deals"
- TikTok indexes your caption text for search \u2014 every word matters for discovery

POSTING STRATEGY:
- 1-3 TikToks per day (consistency > perfection)
- Best times: 7-9am (morning scroll), 12-2pm (lunch), 7-10pm (evening peak)
- Videos under 30 seconds get the highest completion rates (key metric)
- Cross-post to IG Reels and FB Reels for 3x the exposure from 1 video

RULES:
- Keep caption SHORT (under 150 characters ideally, never over 300)
- Sound casual and authentic \u2014 like a text message, not an ad
- Include 3-5 hashtags only: #cartok #carsales #fyp + model/niche tags
- If the vehicle model is mentioned, hashtag it
- No phone numbers in TikTok captions (use "link in bio" or "DM me" instead)
- Never sound corporate. TikTok users scroll past anything that feels like an ad.

\${languageInstructions[language] || languageInstructions.en}

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
  <title>Privacy Policy â Gabe Moves Metal</title>
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
  <title>Data Deletion â Gabe Moves Metal</title>
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
  <title>Terms of Service â Gabe Moves Metal</title>
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
// All deal data behind requireAuth â must be logged in to access
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
        // Clean "EV Electric" â "EV" in display name
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

    console.log('[Scraper] No offers parsed â using hardcoded national offers');
    return getHardcodedChevyOffers();
  } catch (err) {
    console.error('[Scraper] National offers scrape error:', err.message);
    console.log('[Scraper] Using hardcoded national offers as fallback');
    return getHardcodedChevyOffers();
  }
}

// Hardcoded national offers â update monthly or when you notice changes
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

// TikTok OAuth callback â handles the token exchange automatically
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

      console.log(`ðµ TikTok connected! Access token expires in ${tokenData.expires_in}s`);
      console.log(`ðµ Refresh token expires in ${tokenData.refresh_expires_in}s`);
      console.log(`ðµ Open ID: ${tokenData.open_id}`);

      res.send(`
        <html>
        <body style="background: #000; color: #fff; font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
          <div style="text-align: center; max-width: 500px;">
            <div style="font-size: 64px; margin-bottom: 20px;">ðµâ</div>
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
      console.log('ðµ TikTok token refreshed successfully');
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

// TikTok connection status
app.get('/api/tiktok/status', (req, res) => {
  res.json({
    connected: !!CONFIG.TIKTOK_ACCESS_TOKEN,
    hasClientKey: !!CONFIG.TIKTOK_CLIENT_KEY,
    hasClientSecret: !!CONFIG.TIKTOK_CLIENT_SECRET,
    openId: CONFIG.TIKTOK_OPEN_ID || null,
  });
});
app.listen(PORT, () => {
  // Start inventory auto-refresh
  inventoryModule.startAutoRefresh();

  console.log(`
  ââââââââââââââââââââââââââââââââââââââââââââââââââââ
  â     GABE MOVES METAL â Lead Engine Running       â
  â     Personal Lead Gen for Gabe @ Findlay Chevy   â
  â                                                  â
  â  ð API:      http://localhost:${PORT}              â
  â  ð Webhook:  http://localhost:${PORT}/webhook       â
  â  ð Status:   http://localhost:${PORT}/api/stats      â
  â  ð¦ Inventory: ${String(inventoryModule.getInventoryCount()).padEnd(4)} vehicles loaded           â
  â  ð Bilingual: EN/ES auto-replies active         â
  â  ð Page ID:  ${CONFIG.PAGE_ID.padEnd(20)}           â
  â                                                  â
  â  ${CONFIG.META_APP_ID === 'YOUR_APP_ID' ? 'â ï¸  Meta API not configured yet!' : 'â  Meta API connected!'}                 â
  â  See META_SETUP_GUIDE.md to connect              â
  ââââââââââââââââââââââââââââââââââââââââââââââââââââ
  `);
});

module.exports = app;
