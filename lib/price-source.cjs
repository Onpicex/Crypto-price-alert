const axios = require("axios");

const BINANCE_API = "https://api.binance.com/api/v3";

const priceCache = new Map();
const cacheTimeout = new Map();
const CACHE_TTL_MS = 1000;

async function getSpotPrice(symbol) {
  const now = Date.now();
  const cacheKey = symbol.toUpperCase();
  
  const cached = priceCache.get(cacheKey);
  const cacheExpire = cacheTimeout.get(cacheKey);
  if (cached && cacheExpire && now < cacheExpire) {
    return cached;
  }
  
  try {
    const response = await axios.get(`${BINANCE_API}/ticker/price`, {
      params: { symbol: cacheKey },
      timeout: 5000
    });
    
    const price = parseFloat(response.data.price);
    const result = { price, price_ts: Math.floor(now / 1000) };
    
    priceCache.set(cacheKey, result);
    cacheTimeout.set(cacheKey, now + CACHE_TTL_MS);
    
    return result;
  } catch (error) {
    if (cached) return cached;
    throw new Error(`Failed to fetch price for ${symbol}: ${error.message}`);
  }
}

async function validateSymbol(symbol) {
  try {
    const response = await axios.get(`${BINANCE_API}/exchangeInfo`, { timeout: 5000 });
    const symbols = response.data.symbols;
    const upperSymbol = symbol.toUpperCase();
    return symbols.some(s => s.symbol === upperSymbol && s.status === "TRADING");
  } catch {
    return false;
  }
}

function clearPriceCache() {
  priceCache.clear();
  cacheTimeout.clear();
}

module.exports = { getSpotPrice, validateSymbol, clearPriceCache };
