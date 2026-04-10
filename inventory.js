/**
 * GABE MOVES METAL — Inventory Module
 * ========================================
 * Pulls LIVE vehicle inventory from findlaychevy.com via Algolia search API.
 * Also supports CSV/JSON import for manual inventory updates.
 *
 * Features:
 * - LIVE inventory from findlaychevy.com (587+ vehicles)
 * - Smart matching: lead interest → inventory matches
 * - Availability disclaimer ("might still be available — I'll verify")
 * - Auto-refresh on configurable interval
 * - CSV/JSON import for manual updates
 * - Fallback to cached data if API is unavailable
 *
 * API: Algolia-powered search (public search credentials from the dealer website)
 */

const fs = require('fs');
const path = require('path');

// ==================== ALGOLIA API CONFIG ====================
const ALGOLIA_CONFIG = {
  APP_ID: process.env.FINDLAY_ALGOLIA_APP_ID || '2591J46P8G',
  API_KEY: process.env.FINDLAY_ALGOLIA_API_KEY || '78311e75e16dd6273d6b00cd6c21db3c',
  INDEX: process.env.FINDLAY_ALGOLIA_INDEX || 'findlaychevrolet_production_inventory',
  get BASE_URL() {
    return `https://${this.APP_ID}-1.algolia.net/1/indexes/${this.INDEX}/query`;
  },
};

const SCRAPER_CONFIG = {
  REFRESH_INTERVAL: 30 * 60 * 1000, // 30 minutes
  BASE_URL: 'https://www.findlaychevy.com',
  HITS_PER_PAGE: 500, // Algolia max per request
};


// ==================== INVENTORY DATA STORE ====================
const INVENTORY_FILE = path.join(__dirname, 'inventory.json');

let inventory = [];
let lastScraped = null;

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


// ==================== ALGOLIA LIVE SCRAPER ====================
/**
 * Fetch LIVE inventory from findlaychevy.com's Algolia search API.
 * This is the real deal — pulls every vehicle on the lot.
 *
 * @param {string} typeFilter - 'new', 'used', or null for all
 * @returns {Array} Normalized vehicle objects
 */
async function scrapeInventory(typeFilter = null) {
  console.log('🔄 Fetching live inventory from Algolia...');

  try {
    let allHits = [];
    let page = 0;
    let totalPages = 1;

    // Build filter string
    let filters = '';
    if (typeFilter === 'new') filters = 'type:new';
    else if (typeFilter === 'used') filters = 'type:CarBravo OR type:Used';

    // Paginate through all results
    while (page < totalPages) {
      const response = await fetch(ALGOLIA_CONFIG.BASE_URL, {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': ALGOLIA_CONFIG.APP_ID,
          'X-Algolia-API-Key': ALGOLIA_CONFIG.API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '',
          hitsPerPage: SCRAPER_CONFIG.HITS_PER_PAGE,
          page,
          filters,
        }),
      });

      if (!response.ok) {
        throw new Error(`Algolia HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      allHits.push(...data.hits);
      totalPages = data.nbPages;
      page++;
    }

    // Normalize all hits into our standard vehicle format
    const vehicles = allHits.map(normalizeAlgoliaHit);

    if (vehicles.length > 0) {
      inventory = vehicles;
      lastScraped = new Date().toISOString();
      saveInventory();
      console.log(`✅ Live inventory: ${vehicles.length} vehicles (${vehicles.filter(v => v.condition === 'New').length} new, ${vehicles.filter(v => v.condition === 'Used').length} used)`);
    }

    return vehicles;
  } catch (err) {
    console.error('⚠️  Algolia fetch failed:', err.message);
    console.log('💡 Using cached inventory data');
    return inventory; // Return cached data
  }
}

/**
 * Normalize an Algolia hit into our standard vehicle format
 */
function normalizeAlgoliaHit(hit) {
  // Parse the Findlay Price from the advanced pricing HTML if available
  let findlayPrice = hit.our_price || 0;
  let savings = 0;
  const pricingHtml = hit.lightning?.advancedPricingStack || '';

  const findlayPriceMatch = pricingHtml.match(/Findlay Price[\s\S]*?\$([\d,]+)/);
  if (findlayPriceMatch) {
    findlayPrice = parseFloat(findlayPriceMatch[1].replace(/,/g, ''));
  }
  const savingsMatch = pricingHtml.match(/Your Savings[\s\S]*?\$([\d,]+)/);
  if (savingsMatch) {
    savings = parseFloat(savingsMatch[1].replace(/,/g, ''));
  }

  return {
    id: hit.vin || hit.stock || hit.api_id,
    vin: hit.vin || '',
    stockNumber: hit.stock || '',
    year: parseInt(hit.year) || 0,
    make: hit.make || 'Chevrolet',
    model: hit.model || '',
    trim: hit.trim || '',
    body: hit.body || '',
    exteriorColor: hit.ext_color || '',
    exteriorColorGeneric: hit.ext_color_generic || '',
    interiorColor: hit.int_color || '',
    mileage: parseInt(hit.miles) || 0,
    price: findlayPrice || parseFloat(hit.our_price) || 0,
    msrp: parseFloat(hit.msrp) || 0,
    savings,
    condition: hit.type === 'new' || hit.type === 'New' ? 'New' : 'Used',
    engine: hit.engine_description || '',
    transmission: hit.transmission_description || '',
    drivetrain: hit.drivetrain || '',
    fuelType: hit.fueltype || '',
    cityMpg: hit.city_mpg || '',
    hwyMpg: hit.hw_mpg || '',
    cylinders: hit.cylinders || '',
    doors: hit.doors || '',
    imageUrl: hit.thumbnail || '',
    detailUrl: hit.link || '',
    features: hit.features || [],
    daysOnLot: hit.days_in_stock || null,
    dateInStock: hit.date_in_stock || '',
    certified: hit.certified === '1',
    inTransit: hit.in_transit_vehicles !== 'On-Lot',

    // Computed fields
    title: `${hit.year || ''} ${hit.make || 'Chevrolet'} ${hit.model || ''} ${hit.trim || ''}`.trim(),
    lastUpdated: new Date().toISOString(),
  };
}


// ==================== CSV / JSON IMPORT ====================
/**
 * Import inventory from a CSV file
 */
function importFromCSV(csvContent) {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));

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
    const values = parseCSVLine(lines[i]);
    if (values.length < 3) continue;

    const vehicle = { id: generateId(), make: 'Chevrolet', lastUpdated: new Date().toISOString() };

    headers.forEach((header, idx) => {
      const field = headerMap[header];
      if (field && values[idx]) {
        vehicle[field] = values[idx].trim();
      }
    });

    if (vehicle.year) vehicle.year = parseInt(vehicle.year);
    if (vehicle.price) vehicle.price = parseFloat(vehicle.price.replace(/[$,]/g, ''));
    if (vehicle.msrp) vehicle.msrp = parseFloat(vehicle.msrp.replace(/[$,]/g, ''));
    if (vehicle.mileage) vehicle.mileage = parseInt(vehicle.mileage.replace(/,/g, ''));

    vehicle.title = `${vehicle.year || ''} ${vehicle.make || 'Chevrolet'} ${vehicle.model || ''} ${vehicle.trim || ''}`.trim();

    if (vehicle.model) {
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

function importFromJSON(jsonContent) {
  const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
  let rawVehicles = [];

  if (Array.isArray(data)) rawVehicles = data;
  else if (data.inventory) rawVehicles = data.inventory;
  else if (data.vehicles) rawVehicles = data.vehicles;
  else if (data.results) rawVehicles = data.results;
  else if (data.hits) rawVehicles = data.hits;

  // If these look like Algolia hits, normalize them
  if (rawVehicles.length > 0 && rawVehicles[0].vin && rawVehicles[0].stock) {
    const vehicles = rawVehicles.map(normalizeAlgoliaHit);
    inventory = vehicles;
    lastScraped = new Date().toISOString();
    saveInventory();
    console.log(`📥 Imported ${vehicles.length} vehicles from JSON`);
    return vehicles;
  }

  // Generic JSON import
  const vehicles = rawVehicles.map(v => ({
    id: v.id || v.vin || v.stockNumber || generateId(),
    vin: v.vin || '',
    stockNumber: v.stockNumber || v.stock || '',
    year: parseInt(v.year) || 0,
    make: v.make || 'Chevrolet',
    model: v.model || '',
    trim: v.trim || '',
    body: v.body || '',
    exteriorColor: v.exteriorColor || v.ext_color || '',
    interiorColor: v.interiorColor || v.int_color || '',
    mileage: parseInt(v.mileage || v.miles || 0),
    price: parseFloat(v.price || v.our_price || 0),
    msrp: parseFloat(v.msrp || 0),
    condition: v.condition || v.type || 'Unknown',
    engine: v.engine || '',
    transmission: v.transmission || '',
    drivetrain: v.drivetrain || '',
    fuelType: v.fuelType || v.fueltype || '',
    imageUrl: v.imageUrl || v.thumbnail || '',
    detailUrl: v.detailUrl || v.link || '',
    features: v.features || [],
    daysOnLot: v.daysOnLot || v.days_in_stock || null,
    title: `${v.year || ''} ${v.make || 'Chevrolet'} ${v.model || ''} ${v.trim || ''}`.trim(),
    lastUpdated: new Date().toISOString(),
  }));

  inventory = vehicles;
  lastScraped = new Date().toISOString();
  saveInventory();
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
    condition = null,
    maxPrice = null,
    minPrice = null,
  } = options;

  if (!interest || inventory.length === 0) return [];

  const query = interest.toLowerCase();
  const tokens = query.split(/\s+/);

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

  const categoryMap = {
    'truck': ['silverado', 'colorado'],
    'pickup': ['silverado', 'colorado'],
    'troca': ['silverado', 'colorado'],
    'camioneta': ['silverado', 'colorado', 'tahoe', 'suburban'],
    'suv': ['tahoe', 'suburban', 'blazer', 'equinox', 'traverse', 'trailblazer', 'trax'],
    'ev': ['equinox ev', 'blazer ev', 'silverado ev', 'bolt'],
    'electric': ['equinox ev', 'blazer ev', 'silverado ev', 'bolt'],
    'sedan': ['malibu'],
    'car': ['malibu', 'camaro', 'corvette'],
    'carro': ['malibu', 'camaro', 'corvette'],
    'sports': ['camaro', 'corvette'],
    'family': ['tahoe', 'suburban', 'traverse', 'equinox'],
    'familia': ['tahoe', 'suburban', 'traverse', 'equinox'],
    'tow': ['silverado', 'tahoe', 'suburban'],
    'work': ['silverado', 'colorado'],
    'cheap': ['trax', 'trailblazer', 'malibu'],
    'affordable': ['trax', 'trailblazer', 'malibu', 'equinox'],
    'barato': ['trax', 'trailblazer', 'malibu'],
    'luxury': ['suburban', 'tahoe', 'corvette'],
    'big': ['suburban', 'tahoe', 'silverado'],
    'grande': ['suburban', 'tahoe', 'silverado'],
    'small': ['trax', 'trailblazer', 'bolt'],
    'third row': ['tahoe', 'suburban', 'traverse'],
    '3rd row': ['tahoe', 'suburban', 'traverse'],
  };

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

    // Token matching
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
      if (targetPrice < 200) targetPrice *= 1000;
      if (v.price && v.price <= targetPrice) score += 30;
      else if (v.price && v.price > targetPrice) score -= 50;
    }

    // Spanish price mentions
    const pricioMatch = query.match(/menos de\s*\$?(\d+)[kK]?/);
    if (pricioMatch) {
      let targetPrice = parseInt(pricioMatch[1]);
      if (targetPrice < 200) targetPrice *= 1000;
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

    // Boost vehicles on the lot (not in transit)
    if (!vehicle.inTransit) score += 5;

    // Boost vehicles with big savings
    if (vehicle.savings > 2000) score += 15;

    return { vehicle, score };
  });

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

  if (vehicle.inTransit) {
    return "This one is in transit to the lot — I can reserve it for you before it arrives!";
  }

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
    if (v.savings > 0) msg += ` (save $${v.savings.toLocaleString()}!)`;
    if (v.stockNumber) msg += ` | Stock #${v.stockNumber}`;
    msg += '\n\n';
  });

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
    savings: v.savings || 0,
    exteriorColor: v.exteriorColor || 'N/A',
    interiorColor: v.interiorColor || 'N/A',
    mileage: v.mileage,
    condition: v.condition,
    engine: v.engine || 'N/A',
    drivetrain: v.drivetrain || 'N/A',
    fuelType: v.fuelType || 'N/A',
    cityMpg: v.cityMpg || 'N/A',
    hwyMpg: v.hwyMpg || 'N/A',
    daysOnLot: v.daysOnLot,
    inTransit: v.inTransit || false,
    imageUrl: v.imageUrl,
    detailUrl: v.detailUrl || `${SCRAPER_CONFIG.BASE_URL}/new-vehicles/`,
    features: v.features || [],
    matchScore: v.matchScore,
    availabilityNote: v.availabilityNote,
  }));
}


// ==================== FALLBACK DEALS DATA ====================
/**
 * Curated deals for when live scraping is blocked
 * Updated periodically based on current Chevy promotions
 */
function getFallbackDeals() {
  return [
    { vehicle: '2026 Chevrolet Trax', type: 'findlay_special', savings: '752', source: 'findlaychevy.com', note: '3% off MSRP + potential GMF Bonus Cash' },
    { vehicle: '2025 Chevrolet Silverado 1500', type: 'findlay_special', savings: '3,000+', source: 'findlaychevy.com', note: 'Findlay Discount + Customer Cash available' },
    { vehicle: '2025 Chevrolet Equinox EV', type: 'findlay_special', savings: 'Tax Credit', source: 'findlaychevy.com', note: 'Federal EV tax credit up to $7,500' },
    { vehicle: '2025 Chevrolet Tahoe', type: 'findlay_special', savings: '2,500+', source: 'findlaychevy.com', note: 'Findlay Discount available on select trims' },
  ];
}

function getFallbackOffers() {
  return [
    { vehicle: 'Chevrolet Silverado 1500', type: 'national_offer', apr: '0.9', source: 'chevrolet.com', note: 'For well-qualified buyers' },
    { vehicle: 'Chevrolet Equinox', type: 'national_offer', cashBack: '2,000', source: 'chevrolet.com', note: 'Customer cash on select models' },
    { vehicle: 'Chevrolet Trax', type: 'national_offer', monthly: '249', source: 'chevrolet.com', note: 'Lease special, varies by region' },
  ];
}


// ==================== AUTO-REFRESH ====================
let refreshInterval = null;

function startAutoRefresh() {
  // Scrape on startup
  scrapeInventory().then(vehicles => {
    if (vehicles.length === 0) {
      console.log('⚠️  No vehicles returned from Algolia — will retry on next refresh');
    }
  }).catch(err => {
    console.error('Initial inventory scrape failed:', err.message);
  });

  // Set up recurring refresh
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
  startAutoRefresh,

  // Matching
  matchInventory,
  formatInventoryMessage,
  formatInventoryForCRM,
  getAvailabilityNote,

  // Fallback data
  getFallbackDeals,
  getFallbackOffers,

  // Config
  SCRAPER_CONFIG,
  ALGOLIA_CONFIG,
};
