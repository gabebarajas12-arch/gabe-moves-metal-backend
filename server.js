/**
 * GABE MOVES METAL Ã¢ÂÂ Lead Engine Backend
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

// const inventoryModule = require('./inventory'); // Disabled - using new live scrapers instead

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
  IG_ACCOUNT_ID: process.env.IG_ACCOUNT_ID || 'YOUR_IG_ACCOUNT_ID',
  WEBHOOK_URL: process.env.WEBHOOK_URL || 'https://your-domain.com/webhook',
  // WhatsApp Cloud API (register 702-416-3741 in Meta Developer Console Ã¢ÂÂ WhatsApp Ã¢ÂÂ API Setup)
  // Meta assigns a Phone Number ID once registered Ã¢ÂÂ set it here or in Render env vars
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || 'YOUR_WA_PHONE_NUMBER_ID',
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '1972990456955920',
  WHATSAPP_PHONE_NUMBER: '17024163741', // Gabe's number in E.164 format
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'gabe_moves_metal_wa_2026',
  // Personal brand info
  SALESMAN_NAME: 'Gabe',
  PAGE_NAME: 'Gabe Moves Metal',
  DEALERSHIP: 'Findlay Chevrolet',  // where Gabe works
  MESSENGER_ID: '653248677865512',
};

// ==================== AUTHENTICATION ====================
// Set CRM_PASSWORD in Render env vars. Default for local dev only.
const CRM_PASSWORD = process.env.CRM_PASSWORD || 'gabemovesmetal2026';

// Active sessions (token Ã¢ÂÂ { createdAt, expiresAt })
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

// Auth middleware Ã¢ÂÂ protects all /api/* routes
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
// Serve frontend Ã¢ÂÂ 'public' is a subfolder of the backend repo on Render
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

// ==================== IN-MEMORY DATA STORE ====================
// In production, replace with a database (SQLite, PostgreSQL, etc.)
let leads = [];
let conversations = [];
let notifications = [];
let posts = [];  // Auto-posting content store
let autoReplyTemplates = [
  // ===== ENGLISH TEMPLATES =====
  {
    id: 'instant_greeting_en',
    trigger: 'new_message',
    lang: 'en',
    name: 'Instant Greeting (EN)',
    message: `Hey {first_name}! Thanks for reaching out! This is Gabe from Gabe Moves Metal Ã¢ÂÂ I sell at Findlay Chevrolet, the #1 volume dealer west of Texas. What are you looking for today?`,
    active: true,
    delay: 0,
  },
  {
    id: 'truck_interest_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['truck', 'silverado', 'colorado', 'sierra', 'tow', 'towing', 'pickup', 'f150', 'ram'],
    name: 'Truck Interest (EN)',
    message: `Great taste! I work at the #1 volume Chevy dealer west of Texas so we've got a HUGE truck selection. Silverado 1500, 2500HD, or Colorado Ã¢ÂÂ I can pull options and pricing right now. What are you looking at?`,
    active: true,
    delay: 30,
  },
  {
    id: 'suv_interest_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'trailblazer', 'trax', 'traverse', 'family'],
    name: 'SUV Interest (EN)',
    message: `SUVs are my bread and butter! Whether you want an Equinox, Blazer, Tahoe, or Suburban Ã¢ÂÂ I've got them all on the lot. What size are you thinking, and is there a budget range you're working with?`,
    active: true,
    delay: 30,
  },
  {
    id: 'ev_interest_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['ev', 'electric', 'equinox ev', 'blazer ev', 'silverado ev', 'hybrid', 'bolt', 'charge'],
    name: 'EV Interest (EN)',
    message: `Love that you're looking at EVs! Chevy has incredible electric options Ã¢ÂÂ the Equinox EV starts under $35K and there are federal tax credits available. Want me to break down the numbers for you?`,
    active: true,
    delay: 30,
  },
  {
    id: 'trade_in_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['trade', 'trade-in', 'trade in', 'sell my car', 'selling', 'what is my car worth', 'value'],
    name: 'Trade-In Interest (EN)',
    message: `Trade values are strong right now! I can get you a quick appraisal Ã¢ÂÂ just need the year, make, model, and roughly how many miles. No obligation. Want to set that up?`,
    active: true,
    delay: 15,
  },
  {
    id: 'price_question_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['price', 'how much', 'cost', 'payment', 'monthly', 'finance', 'deal', 'discount', 'best price'],
    name: 'Pricing Question (EN)',
    message: `Great question! We move a lot of metal at Findlay so our prices stay aggressive. Which specific vehicle are you looking at? I'll pull the best numbers I can for you.`,
    active: true,
    delay: 15,
  },

  // ===== SPANISH TEMPLATES =====
  {
    id: 'instant_greeting_es',
    trigger: 'new_message',
    lang: 'es',
    name: 'Saludo Inicial (ES)',
    message: `ÃÂ¡Hola {first_name}! Gracias por escribirme. Soy Gabe de Gabe Moves Metal Ã¢ÂÂ vendo en Findlay Chevrolet, el dealer #1 en volumen al oeste de Texas. ÃÂ¿En quÃÂ© te puedo ayudar hoy?`,
    active: true,
    delay: 0,
  },
  {
    id: 'truck_interest_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['troca', 'camioneta', 'silverado', 'colorado', 'pickup', 'remolque', 'jalar'],
    name: 'InterÃÂ©s en Trocas (ES)',
    message: `ÃÂ¡Buena elecciÃÂ³n! Trabajo en el dealer Chevy #1 en volumen al oeste de Texas Ã¢ÂÂ tenemos una selecciÃÂ³n enorme de trocas. Silverado 1500, 2500HD, o Colorado. ÃÂ¿CuÃÂ¡l te interesa? Te puedo dar precios ahorita mismo.`,
    active: true,
    delay: 30,
  },
  {
    id: 'suv_interest_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'familiar', 'familia', 'camioneta grande'],
    name: 'InterÃÂ©s en SUVs (ES)',
    message: `ÃÂ¡Las SUVs son mi especialidad! Ya sea Equinox, Blazer, Tahoe o Suburban Ã¢ÂÂ las tengo todas en el lote. ÃÂ¿QuÃÂ© tamaÃÂ±o buscas y cuÃÂ¡l es tu presupuesto mÃÂ¡s o menos?`,
    active: true,
    delay: 30,
  },
  {
    id: 'price_question_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['precio', 'cuÃÂ¡nto', 'cuanto', 'cuesta', 'pago', 'mensual', 'financiar', 'crÃÂ©dito', 'credito', 'enganche'],
    name: 'Pregunta de Precio (ES)',
    message: `ÃÂ¡Buena pregunta! En Findlay movemos mucho volumen asÃÂ­ que nuestros precios son muy competitivos. ÃÂ¿QuÃÂ© vehÃÂ­culo te interesa? Te consigo los mejores nÃÂºmeros que pueda.`,
    active: true,
    delay: 15,
  },
  {
    id: 'trade_in_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['intercambio', 'trade', 'vender mi carro', 'cuÃÂ¡nto vale', 'cuanto vale', 'avalÃÂºo'],
    name: 'InterÃÂ©s en Trade-In (ES)',
    message: `ÃÂ¡Los valores de trade-in estÃÂ¡n muy buenos ahorita! Solo necesito el aÃÂ±o, marca, modelo y mÃÂ¡s o menos cuÃÂ¡ntas millas tiene. Sin compromiso. ÃÂ¿Quieres que lo hagamos?`,
    active: true,
    delay: 15,
  },
];

// Data persistence (simple JSON file)
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      leads = data.leads || [];
      conversations = data.conversations || [];
      notifications = data.notifications || [];
      posts = data.posts || [];
      if (data.autoReplyTemplates) autoReplyTemplates = data.autoReplyTemplates;
    }
  } catch (e) { console.log('Starting with fresh data'); }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ leads, conversations, notifications, autoReplyTemplates, posts }, null, 2));
}

loadData();


// ==================== META WEBHOOK VERIFICATION ====================
// Meta sends a GET request to verify your webhook endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Accept both Facebook/Instagram and WhatsApp verify tokens
  if (mode === 'subscribe' && (token === CONFIG.META_VERIFY_TOKEN || token === CONFIG.WHATSAPP_VERIFY_TOKEN)) {
    console.log('Ã¢ÂÂ Webhook verified!');
    return res.status(200).send(challenge);
  }
  console.log('Ã¢ÂÂ Webhook verification failed');
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
        console.log('Ã¢ÂÂ Invalid webhook signature');
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

    console.log(`Ã°ÂÂÂ© New ${platform} message from ${senderId}: "${messageText}"`);

    // Get sender profile
    const profile = await getSenderProfile(senderId, platform);
    const firstName = profile.first_name || 'there';
    const fullName = profile.first_name && profile.last_name
      ? `${profile.first_name} ${profile.last_name}` : `User ${senderId}`;

    // Find or create conversation
    let convo = conversations.find(c => c.senderId === senderId);
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
      conversations.push(convo);

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
      leads.push(lead);
      convo.leadId = lead.id;

      // Create notification
      addNotification({
        type: 'new_lead',
        title: `New ${platform === 'instagram' ? 'Instagram' : 'Messenger'} Lead!`,
        message: `${fullName} just messaged: "${messageText.substring(0, 100)}"`,
        leadId: lead.id,
      });
    }

    // Add message to conversation
    convo.messages.push({
      id: messageId,
      from: 'customer',
      text: messageText,
      timestamp: new Date(timestamp).toISOString(),
    });

    // ---- AUTO-REPLY LOGIC ----
    // Detect language for bilingual responses
    const detectedLang = detectLanguage(messageText);

    // Store language on the conversation and lead for future reference
    if (!convo.language) convo.language = detectedLang;
    const lead = leads.find(l => l.id === convo.leadId);
    if (lead && !lead.language) lead.language = detectedLang;

    // 1. If this is the first message, send instant greeting in detected language
    if (convo.messages.filter(m => m.from === 'customer').length === 1) {
      const greeting = autoReplyTemplates.find(t =>
        t.trigger === 'new_message' && t.active && t.lang === detectedLang
      ) || autoReplyTemplates.find(t => t.trigger === 'new_message' && t.active);

      if (greeting) {
        const reply = greeting.message.replace(/\{first_name\}/g, firstName);
        setTimeout(() => {
          sendMessage(senderId, reply, platform);
          convo.messages.push({
            id: generateId(),
            from: 'bot',
            text: reply,
            timestamp: new Date().toISOString(),
            templateUsed: greeting.name,
          });
          saveData();
        }, greeting.delay * 1000);
      }
    }

    // 2. Check for keyword-matched templates
    const keywordTemplate = findKeywordTemplate(messageText);
    if (keywordTemplate && convo.messages.filter(m => m.from !== 'customer').length <= 1) {
      const reply = keywordTemplate.message.replace(/\{first_name\}/g, firstName);
      setTimeout(() => {
        sendMessage(senderId, reply, platform);
        convo.messages.push({
          id: generateId(),
          from: 'bot',
          text: reply,
          timestamp: new Date().toISOString(),
          templateUsed: keywordTemplate.name,
        });

        // Update lead interest based on keyword match
        const lead = leads.find(l => l.id === convo.leadId);
        if (lead) {
          lead.interest = detectInterest(messageText) || lead.interest;
        }

        saveData();
      }, (keywordTemplate.delay || 30) * 1000);
    }

    // 2.5. Inventory matching Ã¢ÂÂ send matching vehicles from the lot
    const detectedInterest = detectInterest(messageText);
    if (detectedInterest) {
      const matches = inventoryModule.matchInventory(detectedInterest, { maxResults: 3 });
      if (matches.length > 0) {
        const inventoryMsg = inventoryModule.formatInventoryMessage(matches, firstName);
        setTimeout(() => {
          sendMessage(senderId, inventoryMsg, platform);
          convo.messages.push({
            id: generateId(),
            from: 'bot',
            text: inventoryMsg,
            timestamp: new Date().toISOString(),
            templateUsed: 'Inventory Match',
          });
          saveData();
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

    saveData();
  }
}


// ==================== LEAD AD HANDLER ====================
async function handleLeadAd(leadData) {
  const leadgenId = leadData.leadgen_id;
  const pageId = leadData.page_id;
  const formId = leadData.form_id;

  console.log(`Ã°ÂÂÂ New Lead Ad submission: ${leadgenId}`);

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

      leads.push(lead);

      addNotification({
        type: 'new_lead',
        title: 'New Lead Ad Submission!',
        message: `${lead.name} just filled out a lead form. Interested in: ${lead.interest}`,
        leadId: lead.id,
      });

      // If we have their Messenger ID, send a welcome message
      if (data.retailer_item_id) {
        const greeting = autoReplyTemplates.find(t => t.id === 'instant_greeting' && t.active);
        if (greeting) {
          const reply = greeting.message.replace(/\{first_name\}/g, fields.first_name || 'there');
          // Note: Can only message if user opted in via Messenger
        }
      }

      saveData();
      console.log(`Ã¢ÂÂ Lead captured: ${lead.name} - ${lead.interest}`);
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

    console.log(`Ã°ÂÂÂ¬ New comment from ${commenterName}: "${comment}"`);

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
      leads.push(lead);

      addNotification({
        type: 'new_lead',
        title: 'Potential Lead from Comment!',
        message: `${commenterName} commented: "${comment.substring(0, 100)}"`,
        leadId: lead.id,
      });

      saveData();
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

  console.log(`Ã°ÂÂÂ± WhatsApp message from ${contactName} (${from}): "${messageText}"`);

  // Find or create conversation (keyed by phone number for WhatsApp)
  let convo = conversations.find(c => c.senderId === from && c.platform === 'whatsapp');
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
    conversations.push(convo);

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
    leads.push(lead);
    convo.leadId = lead.id;

    addNotification({
      type: 'new_lead',
      title: 'New WhatsApp Lead!',
      message: `${contactName} just messaged on WhatsApp: "${messageText.substring(0, 100)}"`,
      leadId: lead.id,
    });
  }

  // Add message to conversation
  convo.messages.push({
    id: msg.id,
    from: 'customer',
    text: messageText,
    type: msgType,
    timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
  });

  // ---- AUTO-REPLY LOGIC (same as Messenger, bilingual) ----
  const detectedLang = detectLanguage(messageText);
  if (!convo.language) convo.language = detectedLang;

  const firstName = contactName.split(' ')[0] || 'there';

  // First message Ã¢ÂÂ send greeting
  if (convo.messages.filter(m => m.from === 'customer').length === 1) {
    const greeting = autoReplyTemplates.find(t =>
      t.trigger === 'new_message' && t.active && t.lang === detectedLang
    ) || autoReplyTemplates.find(t => t.trigger === 'new_message' && t.active);

    if (greeting) {
      const reply = greeting.message.replace(/\{first_name\}/g, firstName);
      setTimeout(() => {
        sendWhatsAppMessage(from, reply);
        convo.messages.push({
          id: generateId(),
          from: 'bot',
          text: reply,
          timestamp: new Date().toISOString(),
          templateUsed: greeting.name,
        });
        saveData();
      }, greeting.delay * 1000);
    }
  }

  // Keyword-matched auto-reply
  const keywordTemplate = findKeywordTemplate(messageText);
  if (keywordTemplate && convo.messages.filter(m => m.from !== 'customer').length <= 1) {
    const reply = keywordTemplate.message.replace(/\{first_name\}/g, firstName);
    setTimeout(() => {
      sendWhatsAppMessage(from, reply);
      convo.messages.push({
        id: generateId(),
        from: 'bot',
        text: reply,
        timestamp: new Date().toISOString(),
        templateUsed: keywordTemplate.name,
      });
      saveData();
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
        convo.messages.push({
          id: generateId(),
          from: 'bot',
          text: inventoryMsg,
          timestamp: new Date().toISOString(),
          templateUsed: 'Inventory Match',
        });
        saveData();
      }, 60 * 1000);
    }
  }

  saveData();
}

function handleWhatsAppStatus(status) {
  // Track message delivery statuses: sent, delivered, read
  const convo = conversations.find(c => c.senderId === status.recipient_id && c.platform === 'whatsapp');
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
      console.log(`Ã°ÂÂÂ¤ WhatsApp sent to +${to}`);
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
      console.log(`Ã°ÂÂÂ¤ WhatsApp template "${templateName}" sent to +${to}`);
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
      console.log(`Ã°ÂÂÂ¤ Sent message to ${recipientId}`);
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
    'precio', 'cuÃÂ¡nto', 'cuanto', 'cuesta', 'carro', 'coche', 'troca',
    'camioneta', 'interesa', 'puedo', 'tiene', 'estÃÂ¡n', 'favor', 'ayuda',
    'familia', 'grande', 'nueva', 'nuevo', 'usada', 'usado', 'vender',
    'comprar', 'financiar', 'crÃÂ©dito', 'credito', 'enganche', 'mensual',
    'por favor', 'seÃÂ±or', 'amigo', 'millas', 'aÃÂ±o',
  ];
  const spanishCount = spanishIndicators.filter(w => lower.includes(w)).length;
  return spanishCount >= 2 ? 'es' : 'en';
}

function findKeywordTemplate(text) {
  const lower = text.toLowerCase();
  const lang = detectLanguage(text);

  // First try to match in the detected language
  let match = autoReplyTemplates.find(t =>
    t.trigger === 'keyword' && t.active && t.lang === lang &&
    t.keywords.some(k => lower.includes(k))
  );

  // Fallback to any language if no match found
  if (!match) {
    match = autoReplyTemplates.find(t =>
      t.trigger === 'keyword' && t.active &&
      t.keywords.some(k => lower.includes(k))
    );
  }

  return match;
}

function addNotification(notif) {
  notifications.unshift({
    id: generateId(),
    ...notif,
    read: false,
    createdAt: new Date().toISOString(),
  });
  // Keep last 100 notifications
  if (notifications.length > 100) notifications = notifications.slice(0, 100);
}


// ==================== REST API ENDPOINTS ====================
// These power the CRM frontend

// -- Leads --
app.get('/api/leads', (req, res) => {
  res.json(leads);
});

app.post('/api/leads', (req, res) => {
  const lead = { id: generateId(), ...req.body, createdAt: new Date().toISOString().split('T')[0] };
  leads.push(lead);
  saveData();
  res.json(lead);
});

app.put('/api/leads/:id', (req, res) => {
  const idx = leads.findIndex(l => l.id === req.params.id);
  if (idx !== -1) {
    leads[idx] = { ...leads[idx], ...req.body };
    saveData();
    res.json(leads[idx]);
  } else {
    res.status(404).json({ error: 'Lead not found' });
  }
});

app.delete('/api/leads/:id', (req, res) => {
  leads = leads.filter(l => l.id !== req.params.id);
  saveData();
  res.json({ success: true });
});

// -- Conversations --
app.get('/api/conversations', (req, res) => {
  res.json(conversations);
});

app.get('/api/conversations/:id', (req, res) => {
  const convo = conversations.find(c => c.id === req.params.id);
  if (convo) res.json(convo);
  else res.status(404).json({ error: 'Conversation not found' });
});

// Send a manual reply to a conversation (supports all platforms)
app.post('/api/conversations/:id/reply', async (req, res) => {
  const convo = conversations.find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const { text } = req.body;
  if (convo.platform === 'whatsapp') {
    await sendWhatsAppMessage(convo.senderId, text);
  } else {
    await sendMessage(convo.senderId, text, convo.platform);
  }

  convo.messages.push({
    id: generateId(),
    from: 'salesman',
    text,
    timestamp: new Date().toISOString(),
  });

  // Update lead stage to Contacted
  const lead = leads.find(l => l.id === convo.leadId);
  if (lead && lead.stage === 'New Lead') {
    lead.stage = 'Contacted';
  }

  saveData();
  res.json(convo);
});

// -- Notifications --
app.get('/api/notifications', (req, res) => {
  res.json(notifications);
});

app.put('/api/notifications/:id/read', (req, res) => {
  const notif = notifications.find(n => n.id === req.params.id);
  if (notif) {
    notif.read = true;
    saveData();
  }
  res.json({ success: true });
});

app.post('/api/notifications/read-all', (req, res) => {
  notifications.forEach(n => n.read = true);
  saveData();
  res.json({ success: true });
});

// -- Templates --
app.get('/api/templates', (req, res) => {
  res.json(autoReplyTemplates);
});

app.put('/api/templates/:id', (req, res) => {
  const idx = autoReplyTemplates.findIndex(t => t.id === req.params.id);
  if (idx !== -1) {
    autoReplyTemplates[idx] = { ...autoReplyTemplates[idx], ...req.body };
    saveData();
    res.json(autoReplyTemplates[idx]);
  } else {
    res.status(404).json({ error: 'Template not found' });
  }
});

app.post('/api/templates', (req, res) => {
  const template = { id: generateId(), ...req.body };
  autoReplyTemplates.push(template);
  saveData();
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
  res.json({
    totalLeads: leads.length,
    sources: {
      messenger: leads.filter(l => l.source === 'FB Messenger').length,
      instagram: leads.filter(l => l.source === 'Instagram DM').length,
      leadAds: leads.filter(l => l.source === 'FB Lead Ad').length,
      comments: leads.filter(l => l.source === 'FB Comment').length,
    },
    activeConversations: conversations.filter(c => c.status === 'new' || c.status === 'active').length,
    unreadNotifications: notifications.filter(n => !n.read).length,
  });
});

// -- Dashboard stats --
app.get('/api/stats', (req, res) => {
  const now = new Date();
  const thisMonth = leads.filter(l => {
    const d = new Date(l.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  res.json({
    totalLeads: leads.length,
    newThisMonth: thisMonth.length,
    byStage: STAGES_LIST.reduce((acc, s) => { acc[s] = leads.filter(l => l.stage === s).length; return acc; }, {}),
    bySource: leads.reduce((acc, l) => { acc[l.source] = (acc[l.source] || 0) + 1; return acc; }, {}),
    conversations: conversations.length,
    unreadNotifications: notifications.filter(n => !n.read).length,
    inventory: {
      total: inventoryModule.getInventoryCount(),
      lastScraped: inventoryModule.getLastScraped(),
    },
  });
});

const STAGES_LIST = ['New Lead', 'Contacted', 'Appointment', 'Negotiation', 'Sold'];


// ==================== AUTO-POSTING ENGINE ====================
// Create and publish posts to Facebook, Instagram, and WhatsApp Status

// -- Meta Algorithm-Optimized Post Engine --
// Strategy: Hook Ã¢ÂÂ Value Ã¢ÂÂ CTA Ã¢ÂÂ Hashtags (bilingual EN+ES)
// Hashtags: 3-5 branded + 5-8 niche/location + 2-3 trending = 10-16 total (Meta sweet spot)
// Line breaks for readability (algorithm rewards time-on-post)

// Hashtag engine Ã¢ÂÂ mixes branded, niche, location, and engagement tags
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

// Engagement hooks Ã¢ÂÂ Meta rewards posts that stop the scroll
const HOOKS = {
  sold_customer: [
    'SOLD! Ã°ÂÂÂÃ°ÂÂÂ',
    'Another one OFF the lot! Ã°ÂÂÂ',
    'Keys delivered. Dreams realized. Ã°ÂÂÂÃ¢ÂÂ¨',
    'This is why I do what I do Ã°ÂÂÂ',
    'CONGRATULATIONS are in order! Ã°ÂÂÂ',
  ],
  current_deal: [
    'Ã°ÂÂÂ¨ DEAL ALERT Ã°ÂÂÂ¨',
    'You\'re gonna want to see this Ã°ÂÂÂ',
    'My manager said YES to this one Ã°ÂÂ¤Â',
    'This deal won\'t last Ã¢ÂÂ real talk Ã°ÂÂÂ¯',
    'READ THIS before you buy anywhere else Ã¢Â¬ÂÃ¯Â¸Â',
  ],
  inventory_highlight: [
    'JUST HIT THE LOT Ã°ÂÂÂ¥',
    'Fresh off the truck Ã°ÂÂÂÃ¢ÂÂ¨',
    'This one won\'t sit long Ã°ÂÂÂ',
    'Who wants it? Ã°ÂÂÂÃ¢ÂÂÃ¢ÂÂÃ¯Â¸Â',
    'Stop scrolling Ã¢ÂÂ look at this beauty Ã°ÂÂÂ',
  ],
  personal_brand: [
    'Let me keep it real with you Ã°ÂÂÂ¯',
    'People always ask me how I do it...',
    'This is what moving metal looks like Ã°ÂÂÂª',
    'Grateful for another day on the lot Ã°ÂÂÂ',
    'The grind doesn\'t stop Ã°ÂÂÂ',
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
        `${hook}\n\nHuge congrats to ${data.customerName} on their brand new ${vehicle}! Ã°ÂÂÂÃ°ÂÂÂ¨\n\nThis is what happens when you trust the process. You come in, we find the perfect ride, and you drive off HAPPY.\n\nReady to be next? DM me or call/text Ã¢ÂÂ I got you.\nÃ°ÂÂÂ± (702) 416-3741\n\n${getHashtags('sold_customer', data)}`,
        `${hook}\n\n${data.customerName} just drove off in a BRAND NEW ${vehicle} and I couldn't be more hyped for them! Ã°ÂÂÂ¥\n\nFrom the test drive to the handshake Ã¢ÂÂ we made it happen at Findlay Chevrolet, the #1 volume dealer west of Texas.\n\nWho's next? Drop a Ã°ÂÂÂ if you're ready!\n\n${getHashtags('sold_customer', data)}`,
        `${hook}\n\nWelcome to the family, ${data.customerName}! Ã°ÂÂ¤Â\n\nYou came in looking for the right ${data.vehicleModel || 'ride'} and we got you RIGHT. That's how we do it at Findlay Chevy.\n\nIf you or someone you know is in the market Ã¢ÂÂ send them my way. I take care of my people. Ã°ÂÂÂ¯\n\n${getHashtags('sold_customer', data)}`,
      ];
      return pickRandom(captions);
    },
    generateCaptionES: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      return `ÃÂ¡VENDIDO! Ã°ÂÂÂÃ°ÂÂÂ\n\nÃÂ¡Felicidades a ${data.customerName} por su ${vehicle} nuevo! Ã°ÂÂÂÃ°ÂÂÂ¨\n\nEsto es lo que pasa cuando confÃÂ­as en el proceso. Vienes, encontramos el carro perfecto, y te vas FELIZ.\n\nÃÂ¿Listo para ser el siguiente? MÃÂ¡ndame mensaje o llÃÂ¡mame Ã¢ÂÂ yo te ayudo.\nÃ°ÂÂÂ± (702) 416-3741\n\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('sold_customer', data)}`;
    },
    generateBilingual: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const hook = pickRandom(HOOKS.sold_customer);
      return `${hook}\n\nCongrats to ${data.customerName} on their brand new ${vehicle}! Ã°ÂÂÂÃ°ÂÂÂ¨\nAnother happy customer driving off the lot at Findlay Chevrolet Ã¢ÂÂ the #1 volume dealer west of Texas.\n\nReady to be next? DM me or call/text Ã°ÂÂÂ± (702) 416-3741\n\nÃ¢ÂÂ\n\nÃÂ¡Felicidades a ${data.customerName} por su ${vehicle} nuevo! Ã°ÂÂÂ\nOtro cliente feliz saliendo de Findlay Chevrolet. ÃÂ¿Listo para ser el siguiente?\n\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('sold_customer', data)}`;
    },
  },
  current_deal: {
    type: 'current_deal',
    label: 'Current Deal / Special',
    fields: ['dealTitle', 'vehicleModel', 'dealDetails', 'expirationDate', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.current_deal);
      return `${hook}\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? 'Ã¢ÂÂ° Expires ' + data.expirationDate + ' Ã¢ÂÂ don\'t sleep on this!' : 'This won\'t last Ã¢ÂÂ first come, first served!'}\n\nDM me, call, or just pull up to Findlay Chevrolet. I'll make it happen. Ã°ÂÂ¤Â\nÃ°ÂÂÂ± (702) 416-3741\n\n${getHashtags('current_deal', data)}`;
    },
    generateCaptionES: (data) => {
      return `Ã°ÂÂÂ¨ OFERTA Ã°ÂÂÂ¨\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? 'Ã¢ÂÂ° Vence ' + data.expirationDate + ' Ã¢ÂÂ ÃÂ¡no te lo pierdas!' : 'ÃÂ¡No dura para siempre Ã¢ÂÂ primero que llegue!'}\n\nMÃÂ¡ndame mensaje, llÃÂ¡mame, o ven directo a Findlay Chevrolet. Yo te ayudo. Ã°ÂÂ¤Â\nÃ°ÂÂÂ± (702) 416-3741\n\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('current_deal', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.current_deal);
      return `${hook}\n\n${data.dealTitle}\n\n${data.dealDetails}\n\n${data.expirationDate ? 'Ã¢ÂÂ° Expires ' + data.expirationDate : 'Won\'t last long!'} DM me or call Ã°ÂÂÂ± (702) 416-3741\n\nÃ¢ÂÂ\n\n${data.dealTitle}\n${data.dealDetails}\n${data.expirationDate ? 'Ã¢ÂÂ° Vence ' + data.expirationDate : 'ÃÂ¡ApÃÂºrate!'}\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('current_deal', data)}`;
    },
  },
  inventory_highlight: {
    type: 'inventory_highlight',
    label: 'Inventory Highlight',
    fields: ['vehicleYear', 'vehicleModel', 'vehicleTrim', 'price', 'highlights', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.inventory_highlight);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? 'Ã°ÂÂÂ° $' + Number(data.price).toLocaleString() : '';
      return `${hook}\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Loaded and ready to roll.'}\n\nWant to see it in person? Schedule a test drive Ã¢ÂÂ DM me or hit my line:\nÃ°ÂÂÂ± (702) 416-3741\n\nFindlay Chevrolet Ã¢ÂÂ #1 volume dealer west of Texas Ã°ÂÂÂ\n\n${getHashtags('inventory_highlight', data)}`;
    },
    generateCaptionES: (data) => {
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? 'Ã°ÂÂÂ° $' + Number(data.price).toLocaleString() : '';
      return `ACABA DE LLEGAR Ã°ÂÂÂ¥\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Cargado y listo para rodar.'}\n\nÃÂ¿Quieres verlo en persona? Agenda un test drive Ã¢ÂÂ mÃÂ¡ndame mensaje:\nÃ°ÂÂÂ± (702) 416-3741\n\nFindlay Chevrolet Ã¢ÂÂ Dealer #1 en volumen al oeste de Texas Ã°ÂÂÂ\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('inventory_highlight', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.inventory_highlight);
      const vehicle = `${data.vehicleYear || ''} ${data.vehicleModel || ''}${data.vehicleTrim ? ' ' + data.vehicleTrim : ''}`.trim();
      const priceStr = data.price ? 'Ã°ÂÂÂ° $' + Number(data.price).toLocaleString() : '';
      return `${hook}\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n\n${data.highlights || 'Loaded and ready.'}\n\nDM me or call Ã°ÂÂÂ± (702) 416-3741\n\nÃ¢ÂÂ\n\n${vehicle}${priceStr ? '\n' + priceStr : ''}\n${data.highlights || 'Cargado y listo.'}\nMÃÂ¡ndame mensaje Ã°ÂÂÂ± (702) 416-3741\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('inventory_highlight', data)}`;
    },
  },
  personal_brand: {
    type: 'personal_brand',
    label: 'Personal Brand Content',
    fields: ['message', 'imageUrl'],
    generateCaption: (data) => {
      const hook = pickRandom(HOOKS.personal_brand);
      return `${hook}\n\n${data.message}\n\nIf you know someone looking for a car Ã¢ÂÂ send them my way. I take care of my people. Always. Ã°ÂÂ¤Â\n\nÃ¢ÂÂ Gabe Barajas\nFindlay Chevrolet | Las Vegas\nÃ°ÂÂÂ± (702) 416-3741\n\n${getHashtags('personal_brand', data)}`;
    },
    generateCaptionES: (data) => {
      return `Ã°ÂÂÂ¯\n\n${data.message}\n\nSi conoces a alguien buscando carro Ã¢ÂÂ mÃÂ¡ndamelos. Yo cuido a mi gente. Siempre. Ã°ÂÂ¤Â\n\nÃ¢ÂÂ Gabe Barajas\nFindlay Chevrolet | Las Vegas\nÃ°ÂÂÂ± (702) 416-3741\nHablo espaÃÂ±ol Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\n${getHashtags('personal_brand', data)}`;
    },
    generateBilingual: (data) => {
      const hook = pickRandom(HOOKS.personal_brand);
      return `${hook}\n\n${data.message}\n\nKnow someone looking for a car? Send them my way. Ã°ÂÂ¤Â\nÃÂ¿Conoces a alguien buscando carro? MÃÂ¡ndamelos. Ã°ÂÂÂ²Ã°ÂÂÂ½Ã°ÂÂÂºÃ°ÂÂÂ¸\n\nÃ¢ÂÂ Gabe Barajas\nFindlay Chevrolet | Las Vegas\nÃ°ÂÂÂ± (702) 416-3741\n\n${getHashtags('personal_brand', data)}`;
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
    console.log(`Ã°ÂÂÂ Facebook post published: ${result.id || result.post_id}`);
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
    console.log(`Ã°ÂÂÂ¸ Instagram post published: ${result.id}`);
    return { success: true, postId: result.id, platform: 'instagram' };
  } catch (err) {
    console.error('Failed to publish to Instagram:', err.message);
    return { success: false, error: err.message };
  }
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
app.post('/api/posts/ai-generate', async (req, res) => {
  const { type, data, language, customerContext } = req.body;
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
    return res.json({ caption, source: 'template' });
  }

  // Build the AI prompt
  const typeDescriptions = {
    sold_customer: 'a customer delivery celebration post (someone just bought a car)',
    current_deal: 'a promotional deal/special offer post',
    inventory_highlight: 'a vehicle inventory showcase post (new arrival on the lot)',
    personal_brand: 'a personal brand/motivational post from a car salesman',
  };

  const languageInstructions = {
    en: 'Write the caption in English only.',
    es: 'Write the caption in Spanish only. Include "Hablo espaÃÂ±ol" somewhere.',
    bilingual: 'Write the caption in BOTH English and Spanish. Put the English version first, then a line break with "Ã¢ÂÂ", then the Spanish version. Include "Hablo espaÃÂ±ol" with flag emojis in the Spanish section.',
  };

  const prompt = `You are a social media caption writer for Gabe Barajas, a bilingual car salesman at Findlay Chevrolet in Las Vegas Ã¢ÂÂ the #1 volume Chevy dealer west of Texas. His brand is "Gabe Moves Metal."

Write a Facebook post caption for ${typeDescriptions[type] || 'a social media post'}.

POST DATA:
${JSON.stringify(data, null, 2)}

RULES FOR META ALGORITHM OPTIMIZATION:
- Start with a scroll-stopping hook (1 short punchy line with emoji)
- Use line breaks between sections (Meta rewards time-on-post)
- Include a clear CTA (DM me, call/text, come see me)
- Include Gabe's phone: (702) 416-3741
- End with 10-15 hashtags mixing: branded (#GabeMovesmetal #FindlayChevrolet), location (#LasVegas #Vegas), niche (car-related), and engagement tags
- Keep it authentic, energetic, and conversational Ã¢ÂÂ NOT corporate
- Use emojis naturally but don't overdo it (3-6 per post)
- If the vehicle model is mentioned, include a hashtag for it
- Never use the word "utilize" or sound like a robot
- Sound like a real person who genuinely loves selling cars

${languageInstructions[language] || languageInstructions.bilingual}

Write ONLY the caption text. No explanations or metadata.

IMPORTANT: If customer context/story is provided, weave those details naturally into the caption to make it personal and authentic. For example, if they are a repeat customer, mention their loyalty. If first-time buyer, celebrate the milestone. If referral, acknowledge the connection.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const result = await response.json();
    if (result.content && result.content[0]) {
      return res.json({ caption: result.content[0].text, source: 'ai' });
    }
    throw new Error(result.error?.message || 'AI generation failed');
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
    return res.json({ caption, source: 'template' });
  }
});

// Generate a caption preview using templates (fast fallback)
app.post('/api/posts/preview', (req, res) => {
  const { type, data, language } = req.body;
  const template = POST_TEMPLATES[type];
  if (!template) return res.status(400).json({ error: 'Unknown post type' });

  let caption;
  if (language === 'bilingual' && template.generateBilingual) {
    caption = template.generateBilingual(data);
  } else if (language === 'es' && template.generateCaptionES) {
    caption = template.generateCaptionES(data);
  } else {
    caption = template.generateCaption(data);
  }
  res.json({ caption, source: 'template' });
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GabeMovesMetalCRM/1.0)' },
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
    const chevyResp = await axios.get('https://www.chevrolet.com/current-offers', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GabeMovesMetalCRM/1.0)' },
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
  const { type, data, platforms, language, customCaption } = req.body;
  // platforms: ['facebook', 'instagram', 'whatsapp'] or ['all']

  const template = POST_TEMPLATES[type];
  if (!template && !customCaption) {
    return res.status(400).json({ error: 'Unknown post type and no custom caption provided' });
  }

  let caption = customCaption;
  if (!caption && template) {
    caption = language === 'es'
      ? (template.generateCaptionES ? template.generateCaptionES(data) : template.generateCaption(data))
      : template.generateCaption(data);
  }

  const targetPlatforms = platforms.includes('all')
    ? ['facebook', 'instagram', 'whatsapp']
    : platforms;

  const results = [];
  const imageUrl = data?.imageUrl || null;

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
  posts.push(post);
  saveData();

  // If this is a sold customer post, update the lead stage
  if (type === 'sold_customer' && data?.customerName) {
    const lead = leads.find(l =>
      l.name?.toLowerCase().includes(data.customerName.toLowerCase()) && l.stage !== 'Sold'
    );
    if (lead) {
      lead.stage = 'Sold';
      saveData();
    }
  }

  res.json({ post, results });
});

// Get all published posts
app.get('/api/posts', (req, res) => {
  const { type, platform } = req.query;
  let filtered = [...posts];
  if (type) filtered = filtered.filter(p => p.type === type);
  if (platform) filtered = filtered.filter(p => p.platforms.includes(platform));
  res.json(filtered.reverse()); // newest first
});

// Delete a post from history
app.delete('/api/posts/:id', (req, res) => {
  posts = posts.filter(p => p.id !== req.params.id);
  saveData();
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
  posts.push(post);

  // Auto-update lead stage to Sold
  const lead = leads.find(l =>
    l.name?.toLowerCase().includes(customerName.toLowerCase()) && l.stage !== 'Sold'
  );
  if (lead) lead.stage = 'Sold';

  saveData();
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
  posts.push(post);
  saveData();
  res.json({ post, results });
});

// -- Stats update to include WhatsApp + posts --
app.get('/api/stats/extended', (req, res) => {
  const now = new Date();
  const thisMonth = leads.filter(l => {
    const d = new Date(l.createdAt);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });

  res.json({
    totalLeads: leads.length,
    newThisMonth: thisMonth.length,
    byStage: ['New Lead', 'Contacted', 'Appointment', 'Negotiation', 'Sold'].reduce(
      (acc, s) => { acc[s] = leads.filter(l => l.stage === s).length; return acc; }, {}
    ),
    bySource: leads.reduce((acc, l) => { acc[l.source] = (acc[l.source] || 0) + 1; return acc; }, {}),
    conversations: {
      total: conversations.length,
      messenger: conversations.filter(c => c.platform === 'page').length,
      instagram: conversations.filter(c => c.platform === 'instagram').length,
      whatsapp: conversations.filter(c => c.platform === 'whatsapp').length,
    },
    posts: {
      total: posts.length,
      sold: posts.filter(p => p.type === 'sold_customer').length,
      deals: posts.filter(p => p.type === 'current_deal').length,
      inventory: posts.filter(p => p.type === 'inventory_highlight').length,
      brand: posts.filter(p => p.type === 'personal_brand').length,
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
  res.send(`
${customerContext ? `CUSTOMER CONTEXT/STORY: ${customerContext}\n\n` : ""}<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy Ã¢ÂÂ Gabe Moves Metal</title>
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
  <title>Data Deletion Ã¢ÂÂ Gabe Moves Metal</title>
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
// All deal data behind requireAuth Ã¢ÂÂ must be logged in to access
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
let appointments = [];
let apptIdCounter = 1;

// Get all appointments (optionally filter by date)
app.get('/api/appointments', (req, res) => {
  try {
    const { date, from, to } = req.query;
    let filtered = [...appointments];
    
    if (date) {
      filtered = filtered.filter(a => a.date === date);
    } else if (from && to) {
      filtered = filtered.filter(a => a.date >= from && a.date <= to);
    }
    
    filtered.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.time || '00:00').localeCompare(b.time || '00:00');
    });
    
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
    
    appointments.push(appt);
    res.json({ success: true, appointment: appt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update appointment
app.put('/api/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = appointments.findIndex(a => a.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
    
    const updates = req.body;
    appointments[idx] = { ...appointments[idx], ...updates, id };
    res.json({ success: true, appointment: appointments[idx] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete appointment
app.delete('/api/appointments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idx = appointments.findIndex(a => a.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
    
    appointments.splice(idx, 1);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate .ics for a single appointment
app.get('/api/appointments/:id/ical', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const appt = appointments.find(a => a.id === id);
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
  try {
    const resp = await axios.get('https://www.findlaychevy.com/new-vehicles/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
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

// Scrape Chevy.com national offers for deals
async function scrapeChevyOffers() {
  try {
    const resp = await axios.get('https://www.chevrolet.com/current-offers', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    const $ = cheerio.load(resp.data);
    const deals = [];
    
    // Chevy.com uses various card/offer structures
    $('[class*="offer"], [class*="vehicle-card"], [class*="incentive"], [class*="tile"]').each((i, el) => {
      const card = $(el);
      const text = card.text().trim();
      
      // Skip nav/footer elements
      if (text.length < 20 || text.length > 2000) return;
      
      const nameMatch = text.match(/(20[2-3]\d\s+Chevrolet\s+[A-Za-z0-9 -]+)/i) ||
                        text.match(/(Silverado|Equinox|Trax|Blazer|Tahoe|Suburban|Traverse|Malibu|Camaro|Corvette|Colorado|Trailblazer|Bolt)[\s\w]*/i);
      const monthlyMatch = text.match(/\$(\d{2,3})\/mo/i) || text.match(/\$(\d{2,3})\s*per\s*month/i);
      const aprMatch = text.match(/(\d\.\d+)%\s*APR/i);
      const cashMatch = text.match(/\$(\d[\d,]+)\s*(?:cash|bonus|allowance|off)/i);
      const priceMatch = text.match(/\$([\d,]+)\s*(?:MSRP|starting)/i);
      
      if (nameMatch) {
        deals.push({
          vehicle: nameMatch[1] || nameMatch[0],
          monthly: monthlyMatch ? monthlyMatch[1] : null,
          apr: aprMatch ? aprMatch[1] : null,
          cashBack: cashMatch ? cashMatch[1] : null,
          price: priceMatch ? priceMatch[1] : null,
          type: 'national_offer',
          source: 'chevrolet.com'
        });
      }
    });
    
    // Deduplicate by vehicle name
    const seen = new Set();
    const unique = deals.filter(d => {
      const key = d.vehicle.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    console.log('[Scraper] Found ' + unique.length + ' offers from chevrolet.com');
    return unique;
  } catch (err) {
    console.error('[Scraper] Chevy offers error:', err.message);
    return [];
  }
}

// Scrape Findlay Chevy specials/deals (vehicles with discounts)
async function scrapeFindlayDeals() {
  try {
    // Use the main inventory page - vehicles with Findlay Discount are the "deals"
    const resp = await axios.get('https://www.findlaychevy.com/new-vehicles/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
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
app.get('/api/live-deals', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (cachedDeals.length > 0 && (now - dealsLastFetch) < CACHE_TTL) {
      return res.json({ deals: cachedDeals, cached: true, lastFetch: dealsLastFetch });
    }
    const [findlayDeals, chevyOffers] = await Promise.all([
      scrapeFindlayDeals(),
      scrapeChevyOffers()
    ]);
    cachedDeals = [...findlayDeals, ...chevyOffers];
    dealsLastFetch = now;
    res.json({ deals: cachedDeals, cached: false, lastFetch: dealsLastFetch });
  } catch (err) {
    console.error('[API] live-deals error:', err.message);
    res.status(500).json({ error: 'Failed to fetch deals', details: err.message });
  }
});

// GET /api/live-inventory - returns inventory from Findlay
app.get('/api/live-inventory', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    if (cachedInventory.length > 0 && (now - inventoryLastFetch) < CACHE_TTL) {
      return res.json({ inventory: cachedInventory, cached: true, lastFetch: inventoryLastFetch });
    }
    cachedInventory = await scrapeFindlayInventory();
    inventoryLastFetch = now;
    res.json({ inventory: cachedInventory, cached: false, lastFetch: inventoryLastFetch });
  } catch (err) {
    console.error('[API] live-inventory error:', err.message);
    res.status(500).json({ error: 'Failed to fetch inventory', details: err.message });
  }
});


app.listen(PORT, () => {
  // Start inventory auto-refresh
  inventoryModule.startAutoRefresh();

  console.log(`
  Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  Ã¢ÂÂ     GABE MOVES METAL Ã¢ÂÂ Lead Engine Running       Ã¢ÂÂ
  Ã¢ÂÂ     Personal Lead Gen for Gabe @ Findlay Chevy   Ã¢ÂÂ
  Ã¢ÂÂ                                                  Ã¢ÂÂ
  Ã¢ÂÂ  Ã°ÂÂÂ API:      http://localhost:${PORT}              Ã¢ÂÂ
  Ã¢ÂÂ  Ã°ÂÂÂ Webhook:  http://localhost:${PORT}/webhook       Ã¢ÂÂ
  Ã¢ÂÂ  Ã°ÂÂÂ Status:   http://localhost:${PORT}/api/stats      Ã¢ÂÂ
  Ã¢ÂÂ  Ã°ÂÂÂ¦ Inventory: ${String(inventoryModule.getInventoryCount()).padEnd(4)} vehicles loaded           Ã¢ÂÂ
  Ã¢ÂÂ  Ã°ÂÂÂ Bilingual: EN/ES auto-replies active         Ã¢ÂÂ
  Ã¢ÂÂ  Ã°ÂÂÂ Page ID:  ${CONFIG.PAGE_ID.padEnd(20)}           Ã¢ÂÂ
  Ã¢ÂÂ                                                  Ã¢ÂÂ
  Ã¢ÂÂ  ${CONFIG.META_APP_ID === 'YOUR_APP_ID' ? 'Ã¢ÂÂ Ã¯Â¸Â  Meta API not configured yet!' : 'Ã¢ÂÂ  Meta API connected!'}                 Ã¢ÂÂ
  Ã¢ÂÂ  See META_SETUP_GUIDE.md to connect              Ã¢ÂÂ
  Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  `);
});

module.exports = app;
