// Lightweight inventory stub - replaces old inventory.js scraping
// Real inventory now comes from live scrapers in server.js

let vehicles = [];
let lastScraped = null;

// Load sample vehicles for testing
const sampleVehicles = [
  { name: '2025 Chevrolet Silverado 1500 LT', vin: 'SAMPLE001', stock: 'S001', msrp: '45995', price: '42995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT' },
  { name: '2025 Chevrolet Equinox RS', vin: 'SAMPLE002', stock: 'S002', msrp: '33995', price: '31495', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Equinox', trim: 'RS' },
  { name: '2025 Chevrolet Tahoe Premier', vin: 'SAMPLE003', stock: 'S003', msrp: '72995', price: '69995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Tahoe', trim: 'Premier' },
  { name: '2025 Chevrolet Trax 1RS', vin: 'SAMPLE004', stock: 'S004', msrp: '23495', price: '21995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Trax', trim: '1RS' },
  { name: '2025 Chevrolet Blazer EV RS', vin: 'SAMPLE005', stock: 'S005', msrp: '56995', price: '53995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Blazer EV', trim: 'RS' },
  { name: '2025 Chevrolet Traverse Z71', vin: 'SAMPLE006', stock: 'S006', msrp: '46995', price: '44495', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Traverse', trim: 'Z71' },
  { name: '2025 Chevrolet Colorado Trail Boss', vin: 'SAMPLE007', stock: 'S007', msrp: '39995', price: '37995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Colorado', trim: 'Trail Boss' },
  { name: '2025 Chevrolet Suburban RST', vin: 'SAMPLE008', stock: 'S008', msrp: '69995', price: '66995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Suburban', trim: 'RST' },
  { name: '2025 Chevrolet Camaro SS', vin: 'SAMPLE009', stock: 'S009', msrp: '44995', price: '42995', condition: 'New', year: 2025, make: 'Chevrolet', model: 'Camaro', trim: 'SS' },
  { name: '2026 Chevrolet Corvette Stingray', vin: 'SAMPLE010', stock: 'S010', msrp: '68995', price: '68995', condition: 'New', year: 2026, make: 'Chevrolet', model: 'Corvette', trim: 'Stingray' },
];

vehicles = [...sampleVehicles];
lastScraped = new Date().toISOString();

function getInventory() { return vehicles; }
function getInventoryCount() { return vehicles.length; }
function getLastScraped() { return lastScraped; }

async function scrapeInventory() {
  console.log('[Inventory Stub] Scraping disabled - using live scrapers instead');
  return vehicles;
}

function importFromCSV(data) {
  const lines = data.split('\n').filter(l => l.trim());
  if (lines.length < 2) return vehicles;
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const vehicle = {};
    headers.forEach((h, idx) => { vehicle[h] = cols[idx] ? cols[idx].trim() : ''; });
    if (vehicle.name || vehicle.vin) vehicles.push(vehicle);
  }
  lastScraped = new Date().toISOString();
  return vehicles;
}

function importFromJSON(data) {
  if (Array.isArray(data)) {
    vehicles = data;
    lastScraped = new Date().toISOString();
  }
  return vehicles;
}

function loadSampleInventory() { vehicles = [...sampleVehicles]; return vehicles; }
function startAutoRefresh() { console.log('[Inventory Stub] Auto-refresh disabled - live scrapers handle this'); }

function matchInventory(interest, options = {}) {
  const max = options.maxResults || 3;
  if (!interest) return vehicles.slice(0, max);
  const searchTerm = interest.toLowerCase();
  const matches = vehicles.filter(v => {
    const name = (v.name || '').toLowerCase();
    return name.includes(searchTerm) || (v.model || '').toLowerCase().includes(searchTerm);
  });
  return matches.slice(0, max);
}

function formatInventoryMessage(matches, firstName) {
  if (!matches || matches.length === 0) return '';
  const name = firstName || 'there';
  let msg = 'Hey ' + name + '! Check out what we have:\n';
  matches.forEach(v => {
    msg += '\n- ' + v.name + (v.price ? ' - $' + Number(v.price).toLocaleString() : '');
  });
  msg += '\n\nCome see me at Findlay Chevrolet!';
  return msg;
}

function formatInventoryForCRM(matches) {
  return (matches || []).map(v => ({
    name: v.name, vin: v.vin, stock: v.stock,
    msrp: v.msrp, price: v.price, condition: v.condition || 'New'
  }));
}

function getAvailabilityNote(vehicle) {
  return vehicle ? 'Available at Findlay Chevrolet' : 'Contact us for availability';
}

const SCRAPER_CONFIG = { enabled: false, interval: 30 * 60 * 1000, source: 'live-scrapers' };

console.log('📦 Loaded ' + vehicles.length + ' sample vehicles for testing');

module.exports = {
  getInventory, getInventoryCount, getLastScraped,
  scrapeInventory, importFromCSV, importFromJSON, loadSampleInventory, startAutoRefresh,
  matchInventory, formatInventoryMessage, formatInventoryForCRM, getAvailabilityNote,
  SCRAPER_CONFIG
};
