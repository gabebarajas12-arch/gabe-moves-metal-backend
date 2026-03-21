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
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const inventoryModule = require('./inventory');

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
  // Personal brand info
  SALESMAN_NAME: 'Gabe',
  PAGE_NAME: 'Gabe Moves Metal',
  DEALERSHIP: 'Findlay Chevrolet',  // where Gabe works
  MESSENGER_ID: '653248677865512',
};

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==================== IN-MEMORY DATA STORE ====================
// In production, replace with a database (SQLite, PostgreSQL, etc.)
let leads = [];
let conversations = [];
let notifications = [];
let autoReplyTemplates = [
  // ===== ENGLISH TEMPLATES =====
  {
    id: 'instant_greeting_en',
    trigger: 'new_message',
    lang: 'en',
    name: 'Instant Greeting (EN)',
    message: `Hey {first_name}! Thanks for reaching out! This is Gabe from Gabe Moves Metal — I sell at Findlay Chevrolet, the #1 volume dealer west of Texas. What are you looking for today?`,
    active: true,
    delay: 0,
  },
  {
    id: 'truck_interest_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['truck', 'silverado', 'colorado', 'sierra', 'tow', 'towing', 'pickup', 'f150', 'ram'],
    name: 'Truck Interest (EN)',
    message: `Great taste! I work at the #1 volume Chevy dealer west of Texas so we've got a HUGE truck selection. Silverado 1500, 2500HD, or Colorado — I can pull options and pricing right now. What are you looking at?`,
    active: true,
    delay: 30,
  },
  {
    id: 'suv_interest_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'trailblazer', 'trax', 'traverse', 'family'],
    name: 'SUV Interest (EN)',
    message: `SUVs are my bread and butter! Whether you want an Equinox, Blazer, Tahoe, or Suburban — I've got them all on the lot. What size are you thinking, and is there a budget range you're working with?`,
    active: true,
    delay: 30,
  },
  {
    id: 'ev_interest_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['ev', 'electric', 'equinox ev', 'blazer ev', 'silverado ev', 'hybrid', 'bolt', 'charge'],
    name: 'EV Interest (EN)',
    message: `Love that you're looking at EVs! Chevy has incredible electric options — the Equinox EV starts under $35K and there are federal tax credits available. Want me to break down the numbers for you?`,
    active: true,
    delay: 30,
  },
  {
    id: 'trade_in_en',
    trigger: 'keyword',
    lang: 'en',
    keywords: ['trade', 'trade-in', 'trade in', 'sell my car', 'selling', 'what is my car worth', 'value'],
    name: 'Trade-In Interest (EN)',
    message: `Trade values are strong right now! I can get you a quick appraisal — just need the year, make, model, and roughly how many miles. No obligation. Want to set that up?`,
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
    message: `¡Hola {first_name}! Gracias por escribirme. Soy Gabe de Gabe Moves Metal — vendo en Findlay Chevrolet, el dealer #1 en volumen al oeste de Texas. ¿En qué te puedo ayudar hoy?`,
    active: true,
    delay: 0,
  },
  {
    id: 'truck_interest_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['troca', 'camioneta', 'silverado', 'colorado', 'pickup', 'remolque', 'jalar'],
    name: 'Interés en Trocas (ES)',
    message: `¡Buena elección! Trabajo en el dealer Chevy #1 en volumen al oeste de Texas — tenemos una selección enorme de trocas. Silverado 1500, 2500HD, o Colorado. ¿Cuál te interesa? Te puedo dar precios ahorita mismo.`,
    active: true,
    delay: 30,
  },
  {
    id: 'suv_interest_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['suv', 'tahoe', 'suburban', 'blazer', 'equinox', 'familiar', 'familia', 'camioneta grande'],
    name: 'Interés en SUVs (ES)',
    message: `¡Las SUVs son mi especialidad! Ya sea Equinox, Blazer, Tahoe o Suburban — las tengo todas en el lote. ¿Quémaño buscas y cuál es tu presupuesto más o menos?`,
    active: true,
    delay: 30,
  },
  {
    id: 'price_question_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['precio', 'cuánto', 'cuanto', 'cuesta', 'pago', 'mensual', 'financiar', 'crédito', 'credito', 'enganche'],
    name: 'Pregunta de Precio (ES)',
    message: `¡Buena pregunta! En Findlay movemos mucho volumen así que nuestros precios son muy competitivos. ¿Qué vehículo te interesa? Te consigo los mejores números que pueda.`,
    active: true,
    delay: 15,
  },
  {
    id: 'trade_in_es',
    trigger: 'keyword',
    lang: 'es',
    keywords: ['intercambio', 'trade', 'vender mi carro', 'cuánto vale', 'cuanto vale', 'avalúo'],
    name: 'Interés en Trade-In (ES)',
    message: `¡Los valores de trade-in están muy buenos ahorita! Solo necesito el año, marca, modelo y más o menos cuántas millas tiene. Sin compromiso. ¿Quieres que lo hagamos?`,
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
      if (data.autoReplyTemplates) autoReplyTemplates = data.autoReplyTemplates;
    }
  } catch (e) { console.log('Starting with fresh data'); }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ leads, conversations, notifications, autoReplyTemplates }, null, 2));
}

loadData();


// ==================== META WEBHOOK VERIFICATION ====================
// Meta sends a GET request to verify your webhook endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === CONFIG.META_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    return res.status(200).send(challenge);
  }
  console.log('❌ Webhook verification failed');
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
        console.log('❌ Invalid webhook signature');
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

    console.log(`📩 New ${platform} message from ${senderId}: "${messageText}"`);

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

    // 2.5. Inventory matching — send matching vehicles from the lot
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

  console.log(`📋 New Lead Ad submission: ${leadgenId}`);

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
      console.log(`✅ Lead captured: ${lead.name} - ${lead.interest}`);
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

    console.log(`💬 New comment from ${commenterName}: "${comment}"`);

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
      console.log(`📤 Sent message to ${recipientId}`);
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

// Send a manual reply to a conversation
app.post('/api/conversations/:id/reply', async (req, res) => {
  const convo = conversations.find(c => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: 'Conversation not found' });

  const { text } = req.body;
  await sendMessage(convo.senderId, text, convo.platform);

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


// ==================== START SERVER ====================
app.listen(PORT, () => {
  // Start inventory auto-refresh
  inventoryModule.startAutoRefresh();

  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║     GABE MOVES METAL — Lead Engine Running       ║
  ║     Personal Lead Gen for Gabe @ Findlay Chevy   ║
  ║                                                  ║
  ║  🌐 API:      http://localhost:${PORT}              ║
  ║  🔗 Webhook:  http://localhost:${PORT}/webhook       ║
  ║  📊 Status:   http://localhost:${PORT}/api/stats      ║
  ║  📦 Inventory: ${String(inventoryModule.getInventoryCount()).padEnd(4)} vehicles loaded           ║
  ║  🌎 Bilingual: EN/ES auto-replies active         ║
  ║  📄 Page ID:  ${CONFIG.PAGE_ID.padEnd(20)}           ║
  ║                                                  ║
  ║  ${CONFIG.META_APP_ID === 'YOUR_APP_ID' ? '⚠️  Meta API not configured yet!' : '✅  Meta API connected!'}                 ║
  ║  See META_SETUP_GUIDE.md to connect              ║
  ╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
