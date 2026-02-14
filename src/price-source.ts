import axios from "axios";

const BINANCE_API = "https://api.binance.com/api/v3";

export interface PriceResult {
  price: number;
  price_ts: number;
}

let priceCache: Map<string, PriceResult> = new Map();
let cacheTimeout: Map<string, number> = new Map();
const CACHE_TTL_MS = 1000; // 1 second cache

/**
 * Get spot price from Binance
 * @param symbol e.g., "BTCUSDT"
 * @returns {price, price_ts}
 */
export async function getSpotPrice(symbol: string): Promise<PriceResult> {
  const now = Date.now();
  const cacheKey = symbol.toUpperCase();
  
  // Check cache
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
    const result: PriceResult = {
      price,
      price_ts: Math.floor(now / 1000)
    };
    
    // Cache the result
    priceCache.set(cacheKey, result);
    cacheTimeout.set(cacheKey, now + CACHE_TTL_MS);
    
    return result;
  } catch (error: any) {
    // Return cached data if available (even if expired) when fetch fails
    if (cached) {
      return cached;
    }
    throw new Error(`Failed to fetch price for ${symbol}: ${error.message}`);
  }
}

/**
 * Validate symbol exists on Binance
 */
export async function validateSymbol(symbol: string): Promise<boolean> {
  try {
    const response = await axios.get(`${BINANCE_API}/exchangeInfo`, {
      timeout: 5000
    });
    const symbols = response.data.symbols as Array<{ symbol: string; status: string; quoteAsset: string }>;
    const upperSymbol = symbol.toUpperCase();
    return symbols.some(s => s.symbol === upperSymbol && s.status === "TRADING");
  } catch {
    return false;
  }
}

/**
 * Clear price cache
 */
export function clearPriceCache(): void {
  priceCache.clear();
  cacheTimeout.clear();
}
