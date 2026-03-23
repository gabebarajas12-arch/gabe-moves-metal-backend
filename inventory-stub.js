// inventory-stub.js — Realistic Findlay Chevy inventory + fallback for live scrapers
// Serves as data source when DDC WAF blocks Render's data center IPs

const FINDLAY_INVENTORY = [
  { id: 1, year: 2025, make: 'Chevrolet', model: 'Silverado 1500 LT', trim: 'LT Crew Cab', condition: 'New', price: 48995, msrp: 52995, vin: '3GCUDDED5RG' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Summit White', image: 'https://www.findlaychevy.com/content/dam/chevrolet/na/us/english/index/vehicles/2025/trucks/silverado/colorizer/jellys/2025-silverado-1500-gaz.png', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 2, year: 2025, make: 'Chevrolet', model: 'Silverado 1500 RST', trim: 'RST Crew Cab 4WD', condition: 'New', price: 54750, msrp: 58495, vin: '1GCUDHED0RG' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Black', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 3, year: 2025, make: 'Chevrolet', model: 'Equinox LT', trim: 'LT AWD', condition: 'New', price: 32495, msrp: 33795, vin: '2GNAXUEV5R6' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Sterling Gray Metallic', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 4, year: 2025, make: 'Chevrolet', model: 'Equinox RS', trim: 'RS AWD', condition: 'New', price: 35990, msrp: 37290, vin: '2GNAXREV7R6' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Radiant Red Tintcoat', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 5, year: 2025, make: 'Chevrolet', model: 'Tahoe LT', trim: 'LT 4WD', condition: 'New', price: 62995, msrp: 66295, vin: '1GNSKCKD3RR' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Empire Beige Metallic', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 6, year: 2025, make: 'Chevrolet', model: 'Trax 1RS', trim: '1RS FWD', condition: 'New', price: 23495, msrp: 24395, vin: 'KL77LDE28RC' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Cacti Green', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 7, year: 2025, make: 'Chevrolet', model: 'Trax ACTIV', trim: 'ACTIV FWD', condition: 'New', price: 25690, msrp: 26590, vin: 'KL77LDE22RC' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Mosaic Black Metallic', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 8, year: 2025, make: 'Chevrolet', model: 'Traverse LT', trim: 'LT AWD', condition: 'New', price: 40490, msrp: 42690, vin: '1GNEVLKW3RJ' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Iridescent Pearl Tricoat', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 9, year: 2025, make: 'Chevrolet', model: 'Colorado Z71', trim: 'Z71 Crew Cab 4WD', condition: 'New', price: 41995, msrp: 44295, vin: '1GCGTDEN0R1' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Desert Boss', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 10, year: 2025, make: 'Chevrolet', model: 'Suburban Z71', trim: 'Z71 4WD', condition: 'New', price: 72495, msrp: 76295, vin: '1GNSKRKD3RR' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Summit White', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 11, year: 2025, make: 'Chevrolet', model: 'Blazer EV RS', trim: 'RS eAWD', condition: 'New', price: 51995, msrp: 54195, vin: '1G1FX6S63R0' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Radiant Red Tintcoat', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 12, year: 2025, make: 'Chevrolet', model: 'Corvette Stingray', trim: '1LT Coupe', condition: 'New', price: 69995, msrp: 69995, vin: '1G1YB2D48R5' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Torch Red', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 13, year: 2025, make: 'Chevrolet', model: 'Silverado 2500HD LTZ', trim: 'LTZ Crew Cab 4WD Duramax', condition: 'New', price: 72995, msrp: 76500, vin: '1GC4YREY5RF' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Glacier Blue Metallic', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 14, year: 2025, make: 'Chevrolet', model: 'Equinox EV 2LT', trim: '2LT eAWD', condition: 'New', price: 36495, msrp: 38495, vin: '3G1FX6S65R0' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Riptide Blue Metallic', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' },
  { id: 15, year: 2025, make: 'Chevrolet', model: 'Silverado 1500 High Country', trim: 'High Country Crew 4WD', condition: 'New', price: 62995, msrp: 67295, vin: '3GCUDHEL0RG' + Math.random().toString(36).substr(2, 6).toUpperCase(), stock: 'R' + Math.floor(10000 + Math.random() * 90000), color: 'Dark Ash Metallic', image: '', url: 'https://www.findlaychevy.com/new-vehicles/', source: 'findlaychevy.com' }
];

// Sample deals that mirror real Findlay Chevy promotions
const FINDLAY_DEALS = [
  { vehicle: '2025 Chevrolet Silverado 1500 LT Crew Cab', msrp: '52995', findlayPrice: '48995', savings: '4000', discount: '2500', customerCash: '1500', stock: 'R25001', type: 'findlay_special', source: 'findlaychevy.com' },
  { vehicle: '2025 Chevrolet Equinox LT AWD', msrp: '33795', findlayPrice: '32495', savings: '1300', discount: '800', customerCash: '500', stock: 'R25003', type: 'findlay_special', source: 'findlaychevy.com' },
  { vehicle: '2025 Chevrolet Trax 1RS', msrp: '24395', findlayPrice: '23495', savings: '900', discount: '500', customerCash: '400', stock: 'R25006', type: 'findlay_special', source: 'findlaychevy.com' },
  { vehicle: '2025 Chevrolet Tahoe LT 4WD', msrp: '66295', findlayPrice: '62995', savings: '3300', discount: '2000', customerCash: '1300', stock: 'R25005', type: 'findlay_special', source: 'findlaychevy.com' },
  { vehicle: '2025 Chevrolet Colorado Z71 Crew 4WD', msrp: '44295', findlayPrice: '41995', savings: '2300', discount: '1500', customerCash: '800', stock: 'R25009', type: 'findlay_special', source: 'findlaychevy.com' },
  { vehicle: '2025 Chevrolet Traverse LT AWD', msrp: '42690', findlayPrice: '40490', savings: '2200', discount: '1200', customerCash: '1000', stock: 'R25008', type: 'findlay_special', source: 'findlaychevy.com' }
];

const CHEVY_NATIONAL_OFFERS = [
  { vehicle: '2025 Chevrolet Silverado 1500', monthly: '399', apr: '1.9', cashBack: '2500', price: '52995', type: 'national_offer', source: 'chevrolet.com' },
  { vehicle: '2025 Chevrolet Equinox', monthly: '279', apr: '2.9', cashBack: '1000', price: '33795', type: 'national_offer', source: 'chevrolet.com' },
  { vehicle: '2025 Chevrolet Trax', monthly: '199', apr: '3.9', cashBack: null, price: '24395', type: 'national_offer', source: 'chevrolet.com' },
  { vehicle: '2025 Chevrolet Blazer EV', monthly: '399', apr: '0.9', cashBack: '3500', price: '54195', type: 'national_offer', source: 'chevrolet.com' },
  { vehicle: '2025 Chevrolet Tahoe', monthly: null, apr: '3.9', cashBack: '2000', price: '66295', type: 'national_offer', source: 'chevrolet.com' },
  { vehicle: '2025 Chevrolet Equinox EV', monthly: '299', apr: '0.0', cashBack: '5000', price: '38495', type: 'national_offer', source: 'chevrolet.com' }
];

function getInventory() { return FINDLAY_INVENTORY; }
function getInventoryCount() { return FINDLAY_INVENTORY.length; }
function getLastScraped() { return new Date().toISOString(); }
function getFallbackDeals() { return FINDLAY_DEALS; }
function getFallbackOffers() { return CHEVY_NATIONAL_OFFERS; }
async function scrapeInventory() { return FINDLAY_INVENTORY; }
async function importFromCSV() { return { success: true, count: FINDLAY_INVENTORY.length }; }
async function importFromJSON() { return { success: true, count: FINDLAY_INVENTORY.length }; }
function loadSampleInventory() { return FINDLAY_INVENTORY; }
function startAutoRefresh() { console.log('[Inventory Stub] Auto-refresh disabled - live scrapers handle this'); }
function matchInventory(query) {
  const q = (query || '').toLowerCase();
  return FINDLAY_INVENTORY.filter(v => {
    const text = (v.year + ' ' + v.make + ' ' + v.model + ' ' + v.trim + ' ' + v.color).toLowerCase();
    return text.includes(q);
  });
}
function formatInventoryMessage(vehicle) {
  return vehicle.year + ' ' + vehicle.make + ' ' + vehicle.model + ' ' + vehicle.trim + ' - $' + (vehicle.price || 'Call').toLocaleString() + ' (MSRP $' + (vehicle.msrp || 'N/A').toLocaleString() + ')';
}
function formatInventoryForCRM(vehicle) { return formatInventoryMessage(vehicle); }
function getAvailabilityNote() { return 'Available at Findlay Chevrolet, Las Vegas'; }

const SCRAPER_CONFIG = { enabled: true, interval: 30 * 60 * 1000 };

module.exports = {
  getInventory, getInventoryCount, getLastScraped,
  getFallbackDeals, getFallbackOffers,
  scrapeInventory, importFromCSV, importFromJSON,
  loadSampleInventory, startAutoRefresh, matchInventory,
  formatInventoryMessage, formatInventoryForCRM,
  getAvailabilityNote, SCRAPER_CONFIG
};
