/**
 * GABE MOVES METAL — SQLite Database Module
 * ==========================================
 * Replaces the old JSON file storage (data.json) with SQLite.
 * Data now persists across Render restarts.
 *
 * Tables: leads, conversations, messages, notifications, posts, templates, appointments
 *
 * Uses better-sqlite3 for synchronous, fast access (no async needed).
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gabe_moves_metal.db');

let db;

// ==================== INIT ====================
function initDatabase() {
  db = new Database(DB_PATH);
  try {
    db.pragma('journal_mode = WAL');    // Better concurrent read performance
  } catch (e) {
    console.log('⚠️  WAL mode not supported on this filesystem, using default journal mode');
  }
  db.pragma('foreign_keys = ON');

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      interest TEXT DEFAULT '',
      source TEXT DEFAULT '',
      stage TEXT DEFAULT 'New Lead',
      followUpDate TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      language TEXT DEFAULT 'en',
      conversationId TEXT DEFAULT '',
      createdAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      senderId TEXT,
      platform TEXT,
      name TEXT,
      profilePic TEXT DEFAULT '',
      leadId TEXT DEFAULT '',
      status TEXT DEFAULT 'new',
      language TEXT DEFAULT '',
      createdAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT DEFAULT '',
      timestamp TEXT DEFAULT '',
      templateUsed TEXT DEFAULT '',
      FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT '',
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      leadId TEXT DEFAULT '',
      conversationId TEXT DEFAULT '',
      read INTEGER DEFAULT 0,
      createdAt TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT '',
      caption TEXT DEFAULT '',
      imageUrl TEXT DEFAULT '',
      data TEXT DEFAULT '{}',
      platforms TEXT DEFAULT '[]',
      results TEXT DEFAULT '[]',
      language TEXT DEFAULT 'en',
      createdAt TEXT DEFAULT '',
      createdBy TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      trigger_type TEXT DEFAULT '',
      lang TEXT DEFAULT 'en',
      name TEXT DEFAULT '',
      message TEXT DEFAULT '',
      keywords TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      delay INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customerName TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '09:00',
      type TEXT DEFAULT '',
      duration INTEGER DEFAULT 30,
      notes TEXT DEFAULT '',
      vehicle TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      status TEXT DEFAULT 'scheduled',
      createdAt TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversationId);
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
  `);

  console.log('🗄️  SQLite database initialized at', DB_PATH);
  return db;
}


// ==================== LEADS ====================
const leadsDb = {
  getAll() {
    return db.prepare('SELECT * FROM leads ORDER BY createdAt DESC').all();
  },

  getById(id) {
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  },

  create(lead) {
    const stmt = db.prepare(`
      INSERT INTO leads (id, name, phone, email, interest, source, stage, followUpDate, notes, language, conversationId, createdAt)
      VALUES (@id, @name, @phone, @email, @interest, @source, @stage, @followUpDate, @notes, @language, @conversationId, @createdAt)
    `);
    stmt.run({
      id: lead.id,
      name: lead.name || '',
      phone: lead.phone || '',
      email: lead.email || '',
      interest: lead.interest || '',
      source: lead.source || '',
      stage: lead.stage || 'New Lead',
      followUpDate: lead.followUpDate || '',
      notes: lead.notes || '',
      language: lead.language || 'en',
      conversationId: lead.conversationId || '',
      createdAt: lead.createdAt || new Date().toISOString().split('T')[0],
    });
    return lead;
  },

  update(id, updates) {
    const current = this.getById(id);
    if (!current) return null;
    const merged = { ...current, ...updates, id };
    const stmt = db.prepare(`
      UPDATE leads SET name=@name, phone=@phone, email=@email, interest=@interest, source=@source,
        stage=@stage, followUpDate=@followUpDate, notes=@notes, language=@language,
        conversationId=@conversationId, createdAt=@createdAt
      WHERE id=@id
    `);
    stmt.run(merged);
    return merged;
  },

  delete(id) {
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  },

  findByName(name) {
    return db.prepare('SELECT * FROM leads WHERE LOWER(name) LIKE ?').all(`%${name.toLowerCase()}%`);
  },
};


// ==================== CONVERSATIONS ====================
const conversationsDb = {
  getAll() {
    const convos = db.prepare('SELECT * FROM conversations ORDER BY createdAt DESC').all();
    // Attach messages to each conversation
    const msgStmt = db.prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC');
    return convos.map(c => ({
      ...c,
      messages: msgStmt.all(c.id).map(m => ({
        id: m.id,
        from: m.sender,
        text: m.text,
        timestamp: m.timestamp,
        templateUsed: m.templateUsed || undefined,
      })),
    }));
  },

  getById(id) {
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!convo) return null;
    const messages = db.prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC').all(id);
    convo.messages = messages.map(m => ({
      id: m.id,
      from: m.sender,
      text: m.text,
      timestamp: m.timestamp,
      templateUsed: m.templateUsed || undefined,
    }));
    return convo;
  },

  findBySenderId(senderId, platform) {
    const convo = db.prepare('SELECT * FROM conversations WHERE senderId = ? AND platform = ?').get(senderId, platform);
    if (!convo) return null;
    const messages = db.prepare('SELECT * FROM messages WHERE conversationId = ? ORDER BY timestamp ASC').all(convo.id);
    convo.messages = messages.map(m => ({
      id: m.id,
      from: m.sender,
      text: m.text,
      timestamp: m.timestamp,
      templateUsed: m.templateUsed || undefined,
    }));
    return convo;
  },

  create(convo) {
    db.prepare(`
      INSERT INTO conversations (id, senderId, platform, name, profilePic, leadId, status, language, createdAt)
      VALUES (@id, @senderId, @platform, @name, @profilePic, @leadId, @status, @language, @createdAt)
    `).run({
      id: convo.id,
      senderId: convo.senderId || '',
      platform: convo.platform || '',
      name: convo.name || '',
      profilePic: convo.profilePic || '',
      leadId: convo.leadId || '',
      status: convo.status || 'new',
      language: convo.language || '',
      createdAt: convo.createdAt || new Date().toISOString(),
    });
    convo.messages = convo.messages || [];
    return convo;
  },

  update(id, updates) {
    const fields = [];
    const values = {};
    for (const [key, val] of Object.entries(updates)) {
      if (['senderId', 'platform', 'name', 'profilePic', 'leadId', 'status', 'language'].includes(key)) {
        fields.push(`${key}=@${key}`);
        values[key] = val;
      }
    }
    if (fields.length > 0) {
      values.id = id;
      db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id=@id`).run(values);
    }
    return this.getById(id);
  },

  addMessage(conversationId, message) {
    db.prepare(`
      INSERT INTO messages (id, conversationId, sender, text, timestamp, templateUsed)
      VALUES (@id, @conversationId, @sender, @text, @timestamp, @templateUsed)
    `).run({
      id: message.id,
      conversationId,
      sender: message.from,
      text: message.text || '',
      timestamp: message.timestamp || new Date().toISOString(),
      templateUsed: message.templateUsed || '',
    });
  },

  getMessageCount(conversationId, senderFilter) {
    if (senderFilter) {
      return db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversationId = ? AND sender = ?')
        .get(conversationId, senderFilter).count;
    }
    return db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversationId = ?')
      .get(conversationId).count;
  },

  getNonCustomerMessageCount(conversationId) {
    return db.prepare("SELECT COUNT(*) as count FROM messages WHERE conversationId = ? AND sender != 'customer'")
      .get(conversationId).count;
  },
};


// ==================== NOTIFICATIONS ====================
const notificationsDb = {
  getAll() {
    return db.prepare('SELECT * FROM notifications ORDER BY createdAt DESC').all().map(n => ({
      ...n,
      read: !!n.read,
    }));
  },

  create(notif) {
    db.prepare(`
      INSERT INTO notifications (id, type, title, message, leadId, conversationId, read, createdAt)
      VALUES (@id, @type, @title, @message, @leadId, @conversationId, @read, @createdAt)
    `).run({
      id: notif.id,
      type: notif.type || '',
      title: notif.title || '',
      message: notif.message || '',
      leadId: notif.leadId || '',
      conversationId: notif.conversationId || '',
      read: 0,
      createdAt: notif.createdAt || new Date().toISOString(),
    });
    return notif;
  },

  markRead(id) {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  },

  markAllRead() {
    db.prepare('UPDATE notifications SET read = 1').run();
  },
};


// ==================== POSTS ====================
const postsDb = {
  getAll(filters = {}) {
    let rows = db.prepare('SELECT * FROM posts ORDER BY createdAt DESC').all();
    // Parse JSON fields
    rows = rows.map(p => ({
      ...p,
      data: JSON.parse(p.data || '{}'),
      platforms: JSON.parse(p.platforms || '[]'),
      results: JSON.parse(p.results || '[]'),
    }));
    if (filters.type) rows = rows.filter(p => p.type === filters.type);
    if (filters.platform) rows = rows.filter(p => p.platforms.includes(filters.platform));
    return rows;
  },

  create(post) {
    db.prepare(`
      INSERT INTO posts (id, type, caption, imageUrl, data, platforms, results, language, createdAt, createdBy)
      VALUES (@id, @type, @caption, @imageUrl, @data, @platforms, @results, @language, @createdAt, @createdBy)
    `).run({
      id: post.id,
      type: post.type || '',
      caption: post.caption || '',
      imageUrl: post.imageUrl || '',
      data: JSON.stringify(post.data || {}),
      platforms: JSON.stringify(post.platforms || []),
      results: JSON.stringify(post.results || []),
      language: post.language || 'en',
      createdAt: post.createdAt || new Date().toISOString(),
      createdBy: post.createdBy || '',
    });
    return post;
  },

  delete(id) {
    db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  },
};


// ==================== TEMPLATES ====================
const templatesDb = {
  getAll() {
    return db.prepare('SELECT * FROM templates').all().map(t => ({
      ...t,
      trigger: t.trigger_type,
      keywords: JSON.parse(t.keywords || '[]'),
      active: !!t.active,
    }));
  },

  getById(id) {
    const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!t) return null;
    return {
      ...t,
      trigger: t.trigger_type,
      keywords: JSON.parse(t.keywords || '[]'),
      active: !!t.active,
    };
  },

  upsert(template) {
    db.prepare(`
      INSERT OR REPLACE INTO templates (id, trigger_type, lang, name, message, keywords, active, delay)
      VALUES (@id, @trigger_type, @lang, @name, @message, @keywords, @active, @delay)
    `).run({
      id: template.id,
      trigger_type: template.trigger || template.trigger_type || '',
      lang: template.lang || 'en',
      name: template.name || '',
      message: template.message || '',
      keywords: JSON.stringify(template.keywords || []),
      active: template.active !== false ? 1 : 0,
      delay: template.delay || 0,
    });
    return this.getById(template.id);
  },

  create(template) {
    return this.upsert(template);
  },

  update(id, updates) {
    const current = this.getById(id);
    if (!current) return null;
    return this.upsert({ ...current, ...updates, id });
  },
};


// ==================== APPOINTMENTS ====================
const appointmentsDb = {
  getAll(filters = {}) {
    let rows;
    if (filters.date) {
      rows = db.prepare('SELECT * FROM appointments WHERE date = ? ORDER BY date, time').all(filters.date);
    } else if (filters.from && filters.to) {
      rows = db.prepare('SELECT * FROM appointments WHERE date >= ? AND date <= ? ORDER BY date, time')
        .all(filters.from, filters.to);
    } else {
      rows = db.prepare('SELECT * FROM appointments ORDER BY date, time').all();
    }
    return rows;
  },

  getById(id) {
    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  },

  create(appt) {
    const result = db.prepare(`
      INSERT INTO appointments (customerName, date, time, type, duration, notes, vehicle, phone, status, createdAt)
      VALUES (@customerName, @date, @time, @type, @duration, @notes, @vehicle, @phone, @status, @createdAt)
    `).run({
      customerName: appt.customerName || '',
      date: appt.date || '',
      time: appt.time || '09:00',
      type: appt.type || '',
      duration: appt.duration || 30,
      notes: appt.notes || '',
      vehicle: appt.vehicle || '',
      phone: appt.phone || '',
      status: appt.status || 'scheduled',
      createdAt: appt.createdAt || new Date().toISOString(),
    });
    return { ...appt, id: result.lastInsertRowid };
  },

  update(id, updates) {
    const current = this.getById(id);
    if (!current) return null;
    const merged = { ...current, ...updates, id };
    db.prepare(`
      UPDATE appointments SET customerName=@customerName, date=@date, time=@time, type=@type,
        duration=@duration, notes=@notes, vehicle=@vehicle, phone=@phone, status=@status
      WHERE id=@id
    `).run(merged);
    return merged;
  },

  delete(id) {
    db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
  },
};


// ==================== MIGRATION ====================
// Import existing data.json into SQLite (run once, then data.json becomes a backup)
function migrateFromJson() {
  const DATA_FILE = path.join(__dirname, 'data.json');
  if (!fs.existsSync(DATA_FILE)) {
    console.log('📦 No data.json found — starting fresh.');
    return;
  }

  // Only migrate if the database is empty
  const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
  if (leadCount > 0) {
    console.log('📦 Database already has data — skipping migration.');
    return;
  }

  console.log('📦 Migrating data.json → SQLite...');
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

    const migrate = db.transaction(() => {
      // Migrate leads
      if (data.leads) {
        for (const lead of data.leads) {
          try { leadsDb.create(lead); } catch (e) { console.log(`  Skip lead ${lead.id}: ${e.message}`); }
        }
        console.log(`  ✅ ${data.leads.length} leads migrated`);
      }

      // Migrate conversations + messages
      if (data.conversations) {
        for (const convo of data.conversations) {
          try {
            const messages = convo.messages || [];
            conversationsDb.create({ ...convo, messages: [] });
            for (const msg of messages) {
              try { conversationsDb.addMessage(convo.id, msg); } catch (e) { /* skip duplicate */ }
            }
          } catch (e) { console.log(`  Skip convo ${convo.id}: ${e.message}`); }
        }
        console.log(`  ✅ ${data.conversations.length} conversations migrated`);
      }

      // Migrate notifications
      if (data.notifications) {
        for (const notif of data.notifications) {
          try { notificationsDb.create(notif); } catch (e) { /* skip */ }
        }
        console.log(`  ✅ ${data.notifications.length} notifications migrated`);
      }

      // Migrate posts
      if (data.posts) {
        for (const post of data.posts) {
          try { postsDb.create(post); } catch (e) { /* skip */ }
        }
        console.log(`  ✅ ${data.posts.length} posts migrated`);
      }

      // Migrate templates
      if (data.autoReplyTemplates) {
        for (const tmpl of data.autoReplyTemplates) {
          try { templatesDb.upsert(tmpl); } catch (e) { /* skip */ }
        }
        console.log(`  ✅ ${data.autoReplyTemplates.length} templates migrated`);
      }
    });

    migrate();
    console.log('📦 Migration complete!');

    // Rename data.json as backup
    const backupPath = DATA_FILE + '.backup';
    fs.renameSync(DATA_FILE, backupPath);
    console.log(`📦 data.json renamed to data.json.backup`);
  } catch (e) {
    console.error('⚠️  Migration error:', e.message);
  }
}


// ==================== SEED DEFAULT TEMPLATES ====================
function seedDefaultTemplates(defaultTemplates) {
  const count = db.prepare('SELECT COUNT(*) as count FROM templates').get().count;
  if (count === 0 && defaultTemplates && defaultTemplates.length > 0) {
    console.log('🌱 Seeding default auto-reply templates...');
    for (const tmpl of defaultTemplates) {
      templatesDb.upsert(tmpl);
    }
    console.log(`🌱 ${defaultTemplates.length} templates seeded.`);
  }
}


// ==================== STATS ====================
function getStats() {
  const totalLeads = db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
  const newLeads = db.prepare("SELECT COUNT(*) as count FROM leads WHERE stage = 'New Lead'").get().count;
  const contacted = db.prepare("SELECT COUNT(*) as count FROM leads WHERE stage = 'Contacted'").get().count;
  const sold = db.prepare("SELECT COUNT(*) as count FROM leads WHERE stage = 'Sold'").get().count;
  const totalConvos = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const unreadNotifs = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0').get().count;
  const totalPosts = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;
  const totalAppointments = db.prepare('SELECT COUNT(*) as count FROM appointments').get().count;

  return {
    totalLeads, newLeads, contacted, sold,
    totalConvos, totalMessages, unreadNotifs, totalPosts, totalAppointments,
  };
}


// Expose raw db instance for modules that need direct access (e.g. intelligence engine)
function getDb() {
  return db;
}

module.exports = {
  initDatabase,
  migrateFromJson,
  seedDefaultTemplates,
  getStats,
  getDb,
  leads: leadsDb,
  conversations: conversationsDb,
  notifications: notificationsDb,
  posts: postsDb,
  templates: templatesDb,
  appointments: appointmentsDb,
};
