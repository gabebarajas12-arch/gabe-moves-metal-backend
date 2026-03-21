/**
 * GABE MOVES METAL — Inventory Module
 * ========================================
 * Scrapes and manages vehicle inventory from findlaychevy.com
 * Also supports CSV import for manual inventory updates.
 *
 * Features:
 * - Scrapes new & used inventory from the dealer website
 * - CSV/JSON import for manual updates
 * - Smart matching: lead interest → inventory matches
 * - Availability disclaimer ("might still be available — I'll verify")
 * - Auto-refresh on configurable interval
 */

const fs = require('fs');
const path = require('path');

// ==================== INVENTORY DATA STORE ====================
const INVENTORY_FILE = path.join(__dirname, 'inventory.json');

let inventory = [];
let lastScraped = null;

// Load saved inventory on startup
function loadInventory() {
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
      inventory = data.vehicles || [];
      lastScraped = data.lastScraped || null;
      console.log(`📦 Loaded ${inventory.length} vehicles from inventory cache`);
    }
  } catch (e) {
    console.log('Starting with empty inventory');
  }
}

function saveInventory() {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify({
    vehicles: inventory,
    lastScraped,
    count: inventory.length,
  }, null, 2));
}

loadInventory();


// ==================== WEBSITE SCRAPER ====================
/**
 * Scrapes inventory from findlaychevy.com
 *
 * Most Chevy dealer websites (powered by Dealer.com, DealerSocket, CDK, etc.)
 * serve inventory through a search results page with JSON data embedded or
 * via an API endpoint. This scraper handles the most common patterns.
 *
 * HOW TO FIND YOUR DEALER'S INVENTORY API:
 * 1. Go to findlaychevy.com/new-vehicles/ in Chrome
 * 2. Open DevTools (F12) → Network tab
 * 3. Filter by "XHR" or "Fetch"
 * 4. Scroll the inventory page or click "Load More"
 * 5. Look for API calls that return JSON with vehicle data
 * 6. Copy that URL and put it in INVENTORY_API_URL below
 *
 * Common patterns for Chevy dealer sites:
 * - Dealer.com: /apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_NEW/*
 * - DealerSocket: /api/inventory/search
 * - CDK: /VehicleSearchResults?search=new
 * - Homenet: /api/inventory
 */

const SCRAPER_CONFIG = {
  // ⬇️ UPDATE THIS with your actual inventory API URL (see instructions above)
  INVENTORY_API_URL: process.env.INVENTORY_API_URL || 'https://www.findlaychevy.com/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_NEW/getInventory',

  // Common query params for dealer inventory APIs
  DEFAULT_PARAMS: {
    make: 'Chevrolet',
    pageSize: 100,
    sortBy: 'make',
    order: 'asc',
  },

  // How often to re-scrape (in milliseconds)
  REFRESH_INTERVAL: 30 * 60 * 1000, // 30 minutes

  // Dealer website base URL
  BASE_URL: 'https://www.findlaychevy.com',
};

/**
 * Fetch inventory from the dealer website's API
 * Returns normalized vehicle objects
 */
async function scrapeInventory() {
  console.log('🔄 Scraping inventory from dealer website...');

  try {
    // Try the primary API endpoint
    const url = new URL(SCRAPER_CONFIG.INVENTORY_API_URL);
    Object.entries(SCRAPER_CONFIG.DEFAULT_PARAMS).forEach(([k, v]) => {
      url.searchParams.set(k, v);
    });

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Normalize the data (different platforms use different field names)
    const vehicles = normalizeInventoryData(data);

    if (vehicles.length > 0) {
      inventory = vehicles;
      lastScraped = new Date().toISOString();
      saveInventory();
      console.log(`✅ Scraped ${vehicles.length} vehicles from website`);
    }

    return vehicles;
  } catch (err) {
    console.error('⚠️  Website scrape failed:', err.message);
    console.log('💡 Tip: Update INVENTORY_API_URL in inventory.js or use CSV import instead');
    console.log('   See the comments in this file for how to find your API URL');
    return inventory; // Return cached data
  }
}

/**
 * Normalize vehicle data from different dealer platforms
 * Handles Dealer.com, DealerSocket, CDK, and generic formats
 */
function normalizeInventoryData(data) {
  // Try to find the vehicle array in the response
  let rawVehicles = [];

  if (Array.isArray(data)) {
    rawVehicles = data;
  } else if (data.inventory) {
    rawVehicles = data.inventory;
  } else if (data.vehicles) {
    rawVehicles = data.vehicles;
  } else if (data.results) {
    rawVehicles = data.results;
  } else if (data.data && Array.isArray(data.data)) {
    rawVehicles = data.data;
  } else if (data.pageInfo && data.pageInfo.trackingData) {
    // Dealer.com format
    rawVehicles = data.pageInfo.trackingData;
  }

  return rawVehicles.map(v => ({
    // Core fields — maps from all common platform formats
    id: v.id || v.vin || v.stockNumber || v.stock_number || generateId(),
    vin: v.vin || v.VIN || v.vinNumber || '',
    stockNumber: v.stockNumber || v.stock_number || v.stockNo || v.stock || '',
    year: parseInt(v.year || v.modelYear || v.model_year || 0),
    make: v.make || v.makeName || 'Chevrolet',
    model: v.model || v.modelName || v.model_name || '',
    trim: v.trim || v.trimName || v.trim_name || '',
    body: v.body || v.bodyStyle || v.body_style || v.bodyType || '',
    exteriorColor: v.exteriorColor || v.exterior_color || v.color || v.extColor || '',
    interiorColor: v.interiorColor || v.interior_color || v.intColor || '',
    mileage: parseInt(v.mileage || v.miles || v.odometer || 0),
    price: parseFloat(v.price || v.internetPrice || v.internet_price || v.msrp || v.askingPrice || 0),
    msrp: parseFloat(v.msrp || v.MSRP || v.sticker_price || 0),
    condition: v.condition || v.type || (parseInt(v.mileage || 0) < 500 ? 'New' : 'Used'),
    engine: v.engine || v.engineDescription || '',
    transmission: v.transmission || v.trans || '',
    drivetrain: v.drivetrain || v.driveTrain || v.drive_type || '',
    fuelType: v.fuelType || v.fuel_type || v.fuel || '',
    imageUrl: v.imageUrl || v.image || v.photo || v.primaryImage || v.images?.[0] || '',
    detailUrl: v.detailUrl || v.url || v.vdpUrl || '',
    features: v.features || v.options || [],
    daysOnLot: v.daysOnLot || v.days_on_lot || v.age || null,

    // Computed fields
    title: `${v.year || v.modelYear || ''} ${v.make || 'Chevrolet'} ${v.model || v.modelName || ''} ${v.trim || v.trimName || ''}`.trim(),
    lastUpdated: new Date().toISOString(),
  }));
}


// ==================== CSV / JSON IMPORT ====================
/**
 * Import inventory from a CSV file
 * This is useful if you can export your inventory from the DMS or download
 * it from the dealer website as a spreadsheet.
 *
 * Expected CSV columns (flexible — we map common names):
 * Stock #, VIN, Year, Make, Model, Trim, Color, Price, MSRP, Mileage, Condition
 */
function importFromCSV(csvContent) {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));

  // Map common CSV header names to our fields
  const headerMap = {
    'stocknumber': 'stockNumber', 'stock': 'stockNumber', 'stockno': 'stockNumber', 'stk': 'stockNumber',
    'vin': 'vin', 'vinnumber': 'vin',
    'year': 'year', 'modelyear': 'year',
    'make': 'make',
    'model': 'model', 'modelname': 'model',
    'trim': 'trim', 'trimname': 'trim',
    'color': 'exteriorColor', 'exteriorcolor': 'exteriorColor', 'extcolor': 'exteriorColor',
    'interiorcolor': 'interiorColor', 'intcolor': 'interiorColor',
    'price': 'price', 'internetprice': 'price', 'sellingprice': 'price', 'askingprice': 'price',
    'msrp': 'msrp', 'stickerprice': 'msrp',
    'mileage': 'mileage', 'miles': 'mileage', 'odometer': 'mileage',
    'condition': 'condition', 'type': 'condition', 'newused': 'condition',
    'body': 'body', 'bodystyle': 'body', 'bodytype': 'body',
    'engine': 'engine',
    'transmission': 'transmission',
    'drivetrain': 'drivetrain',
    'fueltype': 'fuelType',
  };

  const vehicles = [];

  for (let i = 1; i < lines.length; i++) {
    // Handle CSV values that might contain commas in quotes
    const values = parseCSVLine(lines[i]);
    if (values.length < 3) continue;

    const vehicle = { id: generateId(), make: 'Chevrolet', lastUpdated: new Date().toISOString() };

    headers.forEach((header, idx) => {
      const field = headerMap[header];
      if (field && values[idx]) {
        vehicle[field] = values[idx].trim();
      }
    });

    // Parse numeric fields
    if (vehicle.year) vehicle.year = parseInt(vehicle.year);
    if (vehicle.price) vehicle.price = parseFloat(vehicle.price.replace(/[$,]/g, ''));
    if (vehicle.msrp) vehicle.msrp = parseFloat(vehicle.msrp.replace(/[$,]/g, ''));
    if (vehicle.mileage) vehicle.mileage = parseInt(vehicle.mileage.replace(/,/g, ''));

    // Build title
    vehicle.title = `${vehicle.year || ''} ${vehicle.make || 'Chevrolet'} ${vehicle.model || ''} ${vehicle.trim || ''}`.trim();

    if (vehicle.model) { // Only add if we at least have a model
      vehicles.push(vehicle);
    }
  }

  console.log(`📥 Imported ${vehicles.length} vehicles from CSV`);
  return vehicles;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Import inventory from a JSON array
 */
function importFromJSON(jsonContent) {
  const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
  const vehicles = normalizeInventoryData(data);
  console.log(`📥 Imported ${vehicles.length} vehicles from JSON`);
  return vehicles;
}


// ==================== INVENTORY MATCHING ====================
/**
 * Match a lead's interest to available inventory
 * Returns ranked results with match confidence
 *
 * @param {string} interest - What the lead is looking for (e.g., "2025 Silverado", "truck", "SUV under 40K")
 * @param {object} options - { maxResults, condition, maxPrice, minPrice }
 * @returns {Array} Matched vehicles sorted by relevance
 */
function matchInventory(interest, options = {}) {
  const {
    maxResults = 5,
    condition = null, // 'New', 'Used', or null for both
    maxPrice = null,
    minPrice = null,
  } = options;

  if (!interest || inventory.length === 0) return [];

  const query = interest.toLowerCase();
  const tokens = query.split(/\s+/);

  // Model name mappings (what people say → what's in inventory)
  const modelAliases = {
    'silverado': ['silverado', '1500', '2500', '3500'],
    'tahoe': ['tahoe'],
    'suburban': ['suburban'],
    'equinox': ['equinox'],
    'blazer': ['blazer'],
    'traverse': ['traverse'],
    'colorado': ['colorado'],
    'camaro': ['camaro'],
    'corvette': ['corvette'],
    'trax': ['trax'],
    'trailblazer': ['trailblazer'],
    'malibu': ['malibu'],
    'bolt': ['bolt'],
  };

  // Category mappings (what people say → which models to show)
  const categoryMap = {
    'truck': ['silverado', 'colorado'],
    'pickup': ['silverado', 'colorado'],
    'suv': ['tahoe', 'suburban', 'blazer', 'equinox', 'traverse', 'trailblazer', 'trax'],
    'ev': ['equinox ev', 'blazer ev', 'silverado ev', 'bolt'],
    'electric': ['equinox ev', 'blazer ev', 'silverado ev', 'bolt'],
    'sedan': ['malibu'],
    'car': ['malibu', 'camaro', 'corvette'],
    'sports': ['camaro', 'corvette'],
    'family': ['tahoe', 'suburban', 'traverse', 'equinox'],
    'tow': ['silverado', 'tahoe', 'suburban'],
    'work': ['silverado', 'colorado'],
    'cheap': ['trax', 'trailblazer', 'malibu'],
    'affordable': ['trax', 'trailblazer', 'malibu', 'equinox'],
    'luxury': ['suburban', 'tahoe', 'corvette'],
    'big': ['suburban', 'tahoe', 'silverado'],
    'small': ['trax', 'trailblazer', 'bolt'],
    'third row': ['tahoe', 'suburban', 'traverse'],
    '3rd row': ['tahoe', 'suburban', 'traverse'],
  };

  // Score each vehicle
  const scored = inventory.map(vehicle => {
    let score = 0;
    const v = {
      title: (vehicle.title || '').toLowerCase(),
      model: (vehicle.model || '').toLowerCase(),
      trim: (vehicle.trim || '').toLowerCase(),
      body: (vehicle.body || '').toLowerCase(),
      year: vehicle.year,
      price: vehicle.price || vehicle.msrp || 0,
      condition: (vehicle.condition || '').toLowerCase(),
    };

    // Exact model match (highest weight)
    for (const [alias, models] of Object.entries(modelAliases)) {
      if (query.includes(alias)) {
        if (models.some(m => v.model.includes(m) || v.title.includes(m))) {
          score += 100;
        }
      }
    }

    // Category match
    for (const [category, models] of Object.entries(categoryMap)) {
      if (query.includes(category)) {
        if (models.some(m => v.model.includes(m))) {
          score += 60;
        }
      }
    }

    // Token matching (each word in the query)
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (v.title.includes(token)) score += 20;
      if (v.model.includes(token)) score += 30;
      if (v.trim.includes(token)) score += 15;
      if (v.body.includes(token)) score += 10;
    }

    // Year match
    const yearMatch = query.match(/20\d{2}/);
    if (yearMatch && vehicle.year === parseInt(yearMatch[0])) {
      score += 40;
    }

    // Price mentions
    const priceMatch = query.match(/under\s*\$?(\d+)[kK]?/);
    if (priceMatch) {
      let targetPrice = parseInt(priceMatch[1]);
      if (targetPrice < 200) targetPrice *= 1000; // "under 40K" → 40000
      if (v.price && v.price <= targetPrice) score += 30;
      else if (v.price && v.price > targetPrice) score -= 50;
    }

    // Condition filter
    if (condition) {
      if (v.condition !== condition.toLowerCase()) score -= 1000;
    }

    // Price filters
    if (maxPrice && v.price > maxPrice) score -= 1000;
    if (minPrice && v.price < minPrice) score -= 1000;

    // Boost newer models
    if (vehicle.year >= new Date().getFullYear()) score += 10;

    return { vehicle, score };
  });

  // Filter and sort
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => ({
      ...s.vehicle,
      matchScore: s.score,
      availabilityNote: getAvailabilityNote(s.vehicle),
    }));
}

/**
 * Generate availability disclaimer based on how fresh the data is
 */
function getAvailabilityNote(vehicle) {
  const hoursSinceUpdate = lastScraped
    ? (Date.now() - new Date(lastScraped).getTime()) / (1000 * 60 * 60)
    : 999;

  if (hoursSinceUpdate < 1) {
    return "This should still be available on the lot — I'll confirm for you!";
  } else if (hoursSinceUpdate < 6) {
    return "This one might still be available — I'll go verify for you and get back to you ASAP!";
  } else if (hoursSinceUpdate < 24) {
    return "I saw this in our inventory recently — it might still be available, I just have to go verify. Things move fast here at the #1 volume store!";
  } else {
    return "We had this one recently — let me check if it's still on the lot. At Findlay we move a lot of metal so inventory changes daily!";
  }
}

/**
 * Format matched vehicles into a customer-friendly message
 * Used in auto-replies when a lead asks about a specific vehicle
 */
function formatInventoryMessage(matches, leadFirstName) {
  if (!matches || matches.length === 0) {
    return `I'll check our current inventory and get back to you with some options, ${leadFirstName || 'friend'}! We've got 500+ vehicles on the lot so I'm sure we can find something perfect.`;
  }

  let msg = `Great news, ${leadFirstName || 'friend'}! I checked our lot and found some options for you:\n\n`;

  matches.slice(0, 3).forEach((v, i) => {
    const price = v.price ? `$${v.price.toLocaleString()}` : 'Contact for price';
    msg += `${i + 1}. ${v.title}`;
    if (v.exteriorColor) msg += ` — ${v.exteriorColor}`;
    msg += `\n   ${price}`;
    if (v.stockNumber) msg += ` | Stock #${v.stockNumber}`;
    msg += '\n\n';
  });

  // Add the availability disclaimer
  msg += `⚠️ ${matches[0].availabilityNote}\n\n`;
  msg += `Want me to pull any of these up for you, or are you looking for something different? I can also check if we have anything coming in on the truck!`;

  return msg;
}

/**
 * Format matches for CRM display (more detailed, for the salesman)
 */
function formatInventoryForCRM(matches) {
  return matches.map(v => ({
    id: v.id,
    title: v.title,
    stockNumber: v.stockNumber || 'N/A',
    vin: v.vin || 'N/A',
    price: v.price,
    msrp: v.msrp,
    exteriorColor: v.exteriorColor || 'N/A',
    interiorColor: v.interiorColor || 'N/A',
    mileage: v.mileage,
    condition: v.condition,
    engine: v.engine || 'N/A',
    drivetrain: v.drivetrain || 'N/A',
    daysOnLot: v.daysOnLot,
    imageUrl: v.imageUrl,
    detailUrl: v.detailUrl ? `${SCRAPER_CONFIG.BASE_URL}${v.detailUrl}` : null,
    matchScore: v.matchScore,
    availabilityNote: v.availabilityNote,
  }));
}


// ==================== SAMPLE INVENTORY DATA ====================
/**
 * If you haven't connected the scraper yet, this loads sample data
 * so you can test the matching feature immediately.
 * DELETE THIS once you connect to the real inventory.
 */
function loadSampleInventory() {
  if (inventory.length > 0) return; // Don't overwrite real data

  inventory = [
    { id: 'S001', stockNumber: 'FC24501', vin: '1GCUYEED1RZ123456', year: 2025, make: 'Chevrolet', model: 'Silverado 1500', trim: 'RST', body: 'Crew Cab', exteriorColor: 'Summit White', interiorColor: 'Jet Black', mileage: 12, price: 52995, msrp: 55900, condition: 'New', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 5, title: '2025 Chevrolet Silverado 1500 RST' },
    { id: 'S002', stockNumber: 'FC24502', vin: '1GCUYEED2RZ234567', year: 2025, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT Trail Boss', body: 'Crew Cab', exteriorColor: 'Black', interiorColor: 'Jet Black', mileage: 8, price: 56490, msrp: 59750, condition: 'New', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 12, title: '2025 Chevrolet Silverado 1500 LT Trail Boss' },
    { id: 'S003', stockNumber: 'FC24503', vin: '1GCUYEED3RZ345678', year: 2025, make: 'Chevrolet', model: 'Silverado 1500', trim: 'High Country', body: 'Crew Cab', exteriorColor: 'Empire Beige', interiorColor: 'Jet Black/Umber', mileage: 5, price: 65990, msrp: 68500, condition: 'New', engine: '6.2L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 3, title: '2025 Chevrolet Silverado 1500 High Country' },
    { id: 'S004', stockNumber: 'FC24504', vin: '3GNAXKEV1RS456789', year: 2025, make: 'Chevrolet', model: 'Equinox', trim: 'RS', body: 'SUV', exteriorColor: 'Radiant Red', interiorColor: 'Jet Black', mileage: 15, price: 33290, msrp: 34700, condition: 'New', engine: '1.5L Turbo', transmission: 'Auto', drivetrain: 'FWD', fuelType: 'Gas', daysOnLot: 18, title: '2025 Chevrolet Equinox RS' },
    { id: 'S005', stockNumber: 'FC24505', vin: '3GNAXKEV2RS567890', year: 2025, make: 'Chevrolet', model: 'Equinox EV', trim: '2RS', body: 'SUV', exteriorColor: 'Riptide Blue', interiorColor: 'Jet Black', mileage: 3, price: 34995, msrp: 36600, condition: 'New', engine: 'Electric', transmission: 'Single Speed', drivetrain: 'FWD', fuelType: 'Electric', daysOnLot: 7, title: '2025 Chevrolet Equinox EV 2RS' },
    { id: 'S006', stockNumber: 'FC24506', vin: '1GNSKBKD5RS678901', year: 2025, make: 'Chevrolet', model: 'Tahoe', trim: 'Z71', body: 'SUV', exteriorColor: 'Midnight Blue', interiorColor: 'Jet Black', mileage: 10, price: 64500, msrp: 67100, condition: 'New', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 8, title: '2025 Chevrolet Tahoe Z71' },
    { id: 'S007', stockNumber: 'FC24507', vin: '1GNSKBKD6RS789012', year: 2025, make: 'Chevrolet', model: 'Tahoe', trim: 'RST', body: 'SUV', exteriorColor: 'Summit White', interiorColor: 'Jet Black', mileage: 8, price: 61990, msrp: 64500, condition: 'New', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 15, title: '2025 Chevrolet Tahoe RST' },
    { id: 'S008', stockNumber: 'FC24508', vin: '1GNSCCKD7RS890123', year: 2025, make: 'Chevrolet', model: 'Suburban', trim: 'Premier', body: 'SUV', exteriorColor: 'Black', interiorColor: 'Jet Black/Maple Sugar', mileage: 6, price: 76995, msrp: 79400, condition: 'New', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 4, title: '2025 Chevrolet Suburban Premier' },
    { id: 'S009', stockNumber: 'FC24509', vin: '2GNAXUEV8RS901234', year: 2025, make: 'Chevrolet', model: 'Blazer EV', trim: 'RS', body: 'SUV', exteriorColor: 'Radiant Red', interiorColor: 'Jet Black', mileage: 4, price: 51995, msrp: 54600, condition: 'New', engine: 'Electric', transmission: 'Single Speed', drivetrain: 'AWD', fuelType: 'Electric', daysOnLot: 6, title: '2025 Chevrolet Blazer EV RS' },
    { id: 'S010', stockNumber: 'FC24510', vin: '1GCGTCEN0R1012345', year: 2025, make: 'Chevrolet', model: 'Colorado', trim: 'ZR2', body: 'Crew Cab', exteriorColor: 'Sterling Gray', interiorColor: 'Jet Black', mileage: 14, price: 48750, msrp: 51200, condition: 'New', engine: '2.7L Turbo', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 22, title: '2025 Chevrolet Colorado ZR2' },
    { id: 'S011', stockNumber: 'FC24511', vin: '1G1YC2D45R5123456', year: 2025, make: 'Chevrolet', model: 'Corvette', trim: 'Stingray 2LT', body: 'Coupe', exteriorColor: 'Torch Red', interiorColor: 'Adrenaline Red', mileage: 7, price: 72490, msrp: 74500, condition: 'New', engine: '6.2L V8', transmission: 'Dual Clutch', drivetrain: 'RWD', fuelType: 'Gas', daysOnLot: 2, title: '2025 Chevrolet Corvette Stingray 2LT' },
    { id: 'S012', stockNumber: 'FC24512', vin: '3GNKBHR48RS234567', year: 2025, make: 'Chevrolet', model: 'Traverse', trim: 'RS', body: 'SUV', exteriorColor: 'Lakeshore Blue', interiorColor: 'Jet Black', mileage: 9, price: 44500, msrp: 46800, condition: 'New', engine: '2.5L Turbo', transmission: 'Auto', drivetrain: 'AWD', fuelType: 'Gas', daysOnLot: 11, title: '2025 Chevrolet Traverse RS' },
    { id: 'S013', stockNumber: 'FC24513', vin: 'KL77BHE24RC345678', year: 2025, make: 'Chevrolet', model: 'Trax', trim: '1RS', body: 'SUV', exteriorColor: 'Mosaic Black', interiorColor: 'Jet Black', mileage: 20, price: 23495, msrp: 24400, condition: 'New', engine: '1.2L Turbo', transmission: 'Auto', drivetrain: 'FWD', fuelType: 'Gas', daysOnLot: 30, title: '2025 Chevrolet Trax 1RS' },
    { id: 'S014', stockNumber: 'FC24514', vin: 'KL79BNSL5RC456789', year: 2025, make: 'Chevrolet', model: 'Trailblazer', trim: 'ACTIV', body: 'SUV', exteriorColor: 'Nitro Yellow', interiorColor: 'Jet Black', mileage: 11, price: 28990, msrp: 30200, condition: 'New', engine: '1.3L Turbo', transmission: 'Auto', drivetrain: 'AWD', fuelType: 'Gas', daysOnLot: 14, title: '2025 Chevrolet Trailblazer ACTIV' },
    { id: 'S015', stockNumber: 'FC24515', vin: '1GC4YREY5RF567890', year: 2025, make: 'Chevrolet', model: 'Silverado 2500HD', trim: 'LTZ', body: 'Crew Cab', exteriorColor: 'Summit White', interiorColor: 'Jet Black', mileage: 7, price: 72995, msrp: 76200, condition: 'New', engine: '6.6L V8 Duramax Diesel', transmission: 'Allison Auto', drivetrain: '4WD', fuelType: 'Diesel', daysOnLot: 9, title: '2025 Chevrolet Silverado 2500HD LTZ' },
    // Pre-owned
    { id: 'U001', stockNumber: 'FC24601', vin: '1GCUYEED7PZ111222', year: 2023, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT', body: 'Crew Cab', exteriorColor: 'Silver Ice', interiorColor: 'Jet Black', mileage: 18500, price: 39995, msrp: 0, condition: 'Used', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 25, title: '2023 Chevrolet Silverado 1500 LT' },
    { id: 'U002', stockNumber: 'FC24602', vin: '1GNSKCKD1NR222333', year: 2022, make: 'Chevrolet', model: 'Tahoe', trim: 'LT', body: 'SUV', exteriorColor: 'Black', interiorColor: 'Jet Black', mileage: 32000, price: 46990, msrp: 0, condition: 'Used', engine: '5.3L V8', transmission: 'Auto', drivetrain: '4WD', fuelType: 'Gas', daysOnLot: 19, title: '2022 Chevrolet Tahoe LT' },
    { id: 'U003', stockNumber: 'FC24603', vin: '3GNAXKEV5MR333444', year: 2021, make: 'Chevrolet', model: 'Equinox', trim: 'LT', body: 'SUV', exteriorColor: 'Nightfall Gray', interiorColor: 'Medium Ash Gray', mileage: 41000, price: 19995, msrp: 0, condition: 'Used', engine: '1.5L Turbo', transmission: 'Auto', drivetrain: 'FWD', fuelType: 'Gas', daysOnLot: 35, title: '2021 Chevrolet Equinox LT' },
    { id: 'U004', stockNumber: 'FC24604', vin: '1G1FH1R79L0444555', year: 2020, make: 'Chevrolet', model: 'Camaro', trim: 'SS', body: 'Coupe', exteriorColor: 'Crush Orange', interiorColor: 'Jet Black', mileage: 28000, price: 34990, msrp: 0, condition: 'Used', engine: '6.2L V8', transmission: 'Manual', drivetrain: 'RWD', fuelType: 'Gas', daysOnLot: 40, title: '2020 Chevrolet Camaro SS' },
  ];

  lastScraped = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // Pretend scraped 3 hours ago
  saveInventory();
  console.log(`📦 Loaded ${inventory.length} sample vehicles for testing`);
}

loadSampleInventory();


// ==================== AUTO-REFRESH ====================
let refreshInterval = null;

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    console.log('⏰ Auto-refreshing inventory...');
    await scrapeInventory();
  }, SCRAPER_CONFIG.REFRESH_INTERVAL);
  console.log(`⏰ Inventory auto-refresh set to every ${SCRAPER_CONFIG.REFRESH_INTERVAL / 60000} minutes`);
}


// ==================== UTILITY ====================
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function getInventory() { return inventory; }
function getInventoryCount() { return inventory.length; }
function getLastScraped() { return lastScraped; }


// ==================== EXPORTS ====================
module.exports = {
  // Data
  getInventory,
  getInventoryCount,
  getLastScraped,

  // Scraping
  scrapeInventory,
  importFromCSV,
  importFromJSON,
  loadSampleInventory,
  startAutoRefresh,

  // Matching
  matchInventory,
  formatInventoryMessage,
  formatInventoryForCRM,
  getAvailabilityNote,

  // Config
  SCRAPER_CONFIG,
};
