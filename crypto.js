/* ==========================================================================
   CRYPTO PRICE TRACKER — crypto.js
   Vanilla JavaScript (ES6+) implementation of all functional requirements:
   fetching, auto-refresh, search, sort, watchlist (localStorage), loading
   state, and error handling. No frameworks or external JS libraries.
   ========================================================================== */

/* ------------------------------ CONFIG ---------------------------------- */

const API_BASE = "https://api.coingecko.com/api/v3";
const MARKETS_ENDPOINT =
  `${API_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
  `&per_page=50&page=1&sparkline=true&price_change_percentage=24h`;

const REFRESH_INTERVAL_SECONDS = 60;   // auto-refresh cadence (F-04 in PRD)
const CACHE_KEY = "cpt_market_cache";  // localStorage key: last good API payload
const WATCHLIST_KEY = "cpt_watchlist"; // localStorage key: array of coin ids
const REQUEST_TIMEOUT_MS = 12000;

/* ------------------------------- STATE ----------------------------------- */

const state = {
  coins: [],            // full unfiltered dataset from the last successful fetch
  view: [],              // filtered + sorted dataset currently rendered
  watchlist: new Set(),  // Set<coinId>
  searchTerm: "",
  sortKey: "market_cap_desc",
  countdownRemaining: REFRESH_INTERVAL_SECONDS,
  isFetching: false,
};

let refreshIntervalId = null;
let countdownIntervalId = null;
let inFlightController = null;

/* ------------------------------ DOM REFS --------------------------------- */

const dom = {
  tableBody: document.getElementById("coinsTableBody"),
  watchlistContainer: document.getElementById("watchlistContainer"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  loadingIndicator: document.getElementById("loadingIndicator"),
  lastUpdated: document.getElementById("lastUpdated"),
  refreshCountdown: document.getElementById("refreshCountdown"),
  errorBanner: document.getElementById("errorBanner"),
  errorMessage: document.getElementById("errorMessage"),
  errorRetryBtn: document.getElementById("errorRetryBtn"),
  resultsCount: document.getElementById("resultsCount"),
  clearWatchlistBtn: document.getElementById("clearWatchlistBtn"),
};

/* ------------------------------ UTILITIES -------------------------------- */

/** Formats a USD price with sensible precision for both large and tiny coins. */
function formatPrice(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 8;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Formats large market-cap figures using compact notation (e.g. $1.2B). */
function formatMarketCap(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

/** Formats a 24h percentage change, keeping the sign explicit. */
function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Simple debounce so search filtering doesn't run on every keystroke. */
function debounce(fn, delay) {
  let timerId;
  return (...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn(...args), delay);
  };
}

/** Builds a small inline SVG sparkline from an array of 7-day price points. */
function buildSparkline(prices, isUp) {
  if (!Array.isArray(prices) || prices.length < 2) return "";
  const w = 100, h = 32, pad = 2;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const step = (w - pad * 2) / (prices.length - 1);

  const points = prices
    .map((p, i) => {
      const x = pad + i * step;
      const y = h - pad - ((p - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const color = isUp ? "#22c55e" : "#ef4444";
  return `<svg class="sparkline-svg" viewBox="0 0 ${w} ${h}" width="100" height="32" preserveAspectRatio="none">
      <polyline fill="none" stroke="${color}" stroke-width="2" points="${points}"></polyline>
    </svg>`;
}

/* -------------------------- LOADING / ERROR UI --------------------------- */

function showLoading() {
  if (dom.loadingIndicator) dom.loadingIndicator.hidden = false;
}

function hideLoading() {
  if (dom.loadingIndicator) dom.loadingIndicator.hidden = true;
}

/** Displays a friendly, user-facing error message instead of breaking the UI. */
function showError(message) {
  if (!dom.errorBanner || !dom.errorMessage) return;
  dom.errorMessage.textContent = message;
  dom.errorBanner.hidden = false;
}

function hideError() {
  if (!dom.errorBanner || !dom.errorMessage) return;
  dom.errorBanner.hidden = true;
  dom.errorMessage.textContent = "";
}

function setLastUpdatedText(value) {
  if (dom.lastUpdated) {
    dom.lastUpdated.textContent = value;
  }
}

/* ------------------------------ WATCHLIST --------------------------------- */

/** Persists the current watchlist Set to localStorage. */
function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...state.watchlist]));
  } catch (err) {
    // localStorage may be unavailable (private browsing, storage full, etc.)
    console.warn("Could not save watchlist:", err);
  }
}

/** Loads a previously saved watchlist from localStorage, if any. */
function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (raw) state.watchlist = new Set(JSON.parse(raw));
  } catch (err) {
    console.warn("Could not load watchlist:", err);
    state.watchlist = new Set();
  }
}

function addToWatchlist(coinId) {
  state.watchlist.add(coinId);
  saveWatchlist();
  renderCoins(state.view);   // updates the star button state in the table
  renderWatchlist();
}

function removeFromWatchlist(coinId) {
  state.watchlist.delete(coinId);
  saveWatchlist();
  renderCoins(state.view);
  renderWatchlist();
}

function clearWatchlist() {
  state.watchlist.clear();
  saveWatchlist();
  renderCoins(state.view);
  renderWatchlist();
}

/* -------------------------------- CACHE ----------------------------------- */

function saveCache(coins) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ coins, timestamp: Date.now() }));
  } catch (err) {
    console.warn("Could not cache market data:", err);
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

/* --------------------------------- API ------------------------------------ */

/**
 * Fetches the top 50 coins by market cap from CoinGecko.
 * Handles offline state, network failure, rate limiting (429), and empty
 * responses, falling back to the last cached dataset where possible.
 */
async function fetchCryptoData() {
  if (state.isFetching) return; // avoid overlapping requests (performance)
  state.isFetching = true;

  if (!navigator.onLine) {
    handleFetchFailure("You appear to be offline. Showing the last saved prices.");
    state.isFetching = false;
    return;
  }

  // Cancel any previous in-flight request before starting a new one.
  if (inFlightController) inFlightController.abort();
  inFlightController = new AbortController();
  const timeoutId = setTimeout(() => inFlightController.abort(), REQUEST_TIMEOUT_MS);

  showLoading();

  try {
    const response = await fetch(MARKETS_ENDPOINT, { signal: inFlightController.signal });

    if (response.status === 429) {
      throw new Error("RATE_LIMITED");
    }
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("EMPTY_RESPONSE");
    }

    state.coins = data;
    saveCache(data);
    hideError();
    applyFilterAndSort();
    setLastUpdatedText(formatTime(new Date()));
    resetCountdown();
  } catch (err) {
    if (err.name === "AbortError") {
      handleFetchFailure("The request timed out. Showing the last saved prices.");
    } else if (err.message === "RATE_LIMITED") {
      handleFetchFailure("CoinGecko's rate limit was reached. Retrying shortly with cached prices in the meantime.");
    } else if (err.message === "EMPTY_RESPONSE") {
      handleFetchFailure("The API returned no data. Showing the last saved prices.");
    } else {
      handleFetchFailure("Could not reach the crypto price API. Showing the last saved prices.");
    }
  } finally {
    clearTimeout(timeoutId);
    hideLoading();
    state.isFetching = false;
  }
}

/** Falls back to cached data (if any) and surfaces a friendly error banner. */
function handleFetchFailure(message) {
  const cached = loadCache();
  if (cached && Array.isArray(cached.coins) && cached.coins.length > 0) {
    state.coins = cached.coins;
    applyFilterAndSort();
    setLastUpdatedText(`${formatTime(new Date(cached.timestamp))} (cached)`);
  } else if (state.coins.length === 0) {
    // No live data and no cache: table stays empty, message explains why.
    renderTableMessage("No cryptocurrency data available right now.");
  }
  showError(message);
}

/** Re-fetches data on the auto-refresh cycle without a full page reload. */
async function updatePrices() {
  await fetchCryptoData();
}

/* ------------------------------ FILTER / SORT ------------------------------ */

/** Filters the in-memory coin list by name or symbol (case-insensitive). */
function filterCoins(query) {
  const q = query.trim().toLowerCase();
  if (!q) return state.coins;
  return state.coins.filter(
    (coin) => coin.name.toLowerCase().includes(q) || coin.symbol.toLowerCase().includes(q)
  );
}

/** Returns a new array of coins sorted according to the given key. */
function sortCoins(coins, key) {
  const sorted = [...coins];
  switch (key) {
    case "price_desc":
      return sorted.sort((a, b) => b.current_price - a.current_price);
    case "price_asc":
      return sorted.sort((a, b) => a.current_price - b.current_price);
    case "change_desc":
      return sorted.sort(
        (a, b) => (b.price_change_percentage_24h ?? -Infinity) - (a.price_change_percentage_24h ?? -Infinity)
      );
    case "change_asc":
      return sorted.sort(
        (a, b) => (a.price_change_percentage_24h ?? Infinity) - (b.price_change_percentage_24h ?? Infinity)
      );
    case "market_cap_desc":
    default:
      return sorted.sort((a, b) => b.market_cap - a.market_cap);
  }
}

/** Recomputes the visible dataset from current search + sort state and re-renders. */
function applyFilterAndSort() {
  const filtered = filterCoins(state.searchTerm);
  state.view = sortCoins(filtered, state.sortKey);
  renderCoins(state.view);
  renderWatchlist();
  updateResultsCount();
}

function updateResultsCount() {
  if (!dom.resultsCount) return;
  dom.resultsCount.textContent = state.coins.length
    ? `${state.view.length} of ${state.coins.length} coins`
    : "";
}

/* -------------------------------- RENDER ----------------------------------- */

function renderTableMessage(message) {
  if (!dom.tableBody) return;
  dom.tableBody.innerHTML = `<tr><td colspan="7" class="table-empty">${message}</td></tr>`;
}

/**
 * Renders the market table. Rows are keyed by coin id and reused between
 * renders (rather than rebuilding the whole tbody) so only changed cells
 * are touched on each refresh — this keeps auto-refresh cheap and avoids
 * layout flicker.
 */
function renderCoins(coins) {
  if (!dom.tableBody) return;

  if (!coins || coins.length === 0) {
    renderTableMessage(
      state.searchTerm ? "No coins match your search." : "No cryptocurrency data to display."
    );
    return;
  }

  const existingRows = new Map();
  dom.tableBody.querySelectorAll("tr[data-coin-id]").forEach((row) => {
    existingRows.set(row.dataset.coinId, row);
  });

  const fragment = document.createDocumentFragment();

  coins.forEach((coin, index) => {
    const isUp = (coin.price_change_percentage_24h ?? 0) >= 0;
    const isWatchlisted = state.watchlist.has(coin.id);
    let row = existingRows.get(coin.id);

    if (!row) {
      row = document.createElement("tr");
      row.dataset.coinId = coin.id;
      row.innerHTML = `
        <td class="cell-rank"></td>
        <td>
          <div class="coin-cell">
            <img src="${coin.image}" alt="${coin.name} logo" loading="lazy" width="26" height="26">
            <span class="coin-name"></span>
          </div>
        </td>
        <td class="coin-symbol-cell"></td>
        <td class="cell-price"></td>
        <td class="cell-change"></td>
        <td class="cell-sparkline"></td>
        <td><button type="button" class="watchlist-btn" aria-label="Toggle watchlist">☆</button></td>
      `;
    } else {
      existingRows.delete(coin.id); // mark as still in use
    }

    // Update only the pieces of each row that can change between refreshes.
    row.querySelector(".cell-rank").textContent = index + 1;
    row.querySelector(".coin-name").textContent = coin.name;
    row.querySelector(".coin-symbol-cell").textContent = coin.symbol;
    row.querySelector(".cell-price").textContent = formatPrice(coin.current_price);

    const changeCell = row.querySelector(".cell-change");
    changeCell.textContent = formatPercent(coin.price_change_percentage_24h);
    changeCell.className = `cell-change ${isUp ? "up" : "down"}`;

    row.querySelector(".cell-sparkline").innerHTML = buildSparkline(
      coin.sparkline_in_7d?.price,
      isUp
    );

    const starBtn = row.querySelector(".watchlist-btn");
    starBtn.textContent = isWatchlisted ? "★" : "☆";
    starBtn.classList.toggle("active", isWatchlisted);
    starBtn.setAttribute("aria-pressed", String(isWatchlisted));
    starBtn.onclick = () => {
      isWatchlisted ? removeFromWatchlist(coin.id) : addToWatchlist(coin.id);
    };

    fragment.appendChild(row);
  });

  // Any rows left in existingRows are for coins no longer in view — drop them.
  existingRows.forEach((row) => row.remove());

  dom.tableBody.innerHTML = "";
  dom.tableBody.appendChild(fragment);
}

/** Renders the sidebar watchlist panel from the current watchlist Set. */
function renderWatchlist() {
  if (!dom.watchlistContainer) return;

  if (state.watchlist.size === 0) {
    dom.watchlistContainer.innerHTML = `<p class="watchlist-empty">No coins in your watchlist yet. Star a coin in the table to add it here.</p>`;
    return;
  }

  const coinsById = new Map(state.coins.map((c) => [c.id, c]));
  const fragment = document.createDocumentFragment();

  state.watchlist.forEach((coinId) => {
    const coin = coinsById.get(coinId);
    const item = document.createElement("div");
    item.className = "watchlist-item";

    if (!coin) {
      // Coin is starred but not present in the latest fetch (e.g. offline/cache miss).
      item.innerHTML = `<div class="watchlist-item-info"><span class="coin-name">${coinId}</span>
        <span class="watchlist-item-price">Data unavailable</span></div>`;
    } else {
      const isUp = (coin.price_change_percentage_24h ?? 0) >= 0;
      item.innerHTML = `
        <div class="coin-cell">
          <img src="${coin.image}" alt="${coin.name} logo" width="22" height="22">
          <div class="watchlist-item-info">
            <span class="coin-name">${coin.name}</span>
            <span class="watchlist-item-price ${isUp ? "up" : "down"}">
              ${formatPrice(coin.current_price)} · ${formatPercent(coin.price_change_percentage_24h)}
            </span>
          </div>
        </div>
      `;
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "watchlist-remove-btn";
    removeBtn.setAttribute("aria-label", "Remove from watchlist");
    removeBtn.textContent = "✕";
    removeBtn.onclick = () => removeFromWatchlist(coinId);
    item.appendChild(removeBtn);

    fragment.appendChild(item);
  });

  dom.watchlistContainer.innerHTML = "";
  dom.watchlistContainer.appendChild(fragment);
}

/* ------------------------------ AUTO-REFRESH -------------------------------- */

function resetCountdown() {
  state.countdownRemaining = REFRESH_INTERVAL_SECONDS;
  updateCountdownDisplay();
}

function updateCountdownDisplay() {
  if (dom.refreshCountdown) {
    dom.refreshCountdown.textContent = `· next refresh in ${state.countdownRemaining}s`;
  }
}

function startAutoRefresh() {
  if (refreshIntervalId) clearInterval(refreshIntervalId);
  if (countdownIntervalId) clearInterval(countdownIntervalId);

  resetCountdown();
  refreshIntervalId = setInterval(updatePrices, REFRESH_INTERVAL_SECONDS * 1000);

  countdownIntervalId = setInterval(() => {
    state.countdownRemaining = Math.max(0, state.countdownRemaining - 1);
    updateCountdownDisplay();

    if (state.countdownRemaining === 0) {
      resetCountdown();
    }
  }, 1000);
}

/* --------------------------------- EVENTS ------------------------------------ */

function bindEvents() {
  const debouncedFilter = debounce((value) => {
    state.searchTerm = value;
    applyFilterAndSort();
  }, 300);

  dom.searchInput.addEventListener("input", (e) => debouncedFilter(e.target.value));

  dom.sortSelect.addEventListener("change", (e) => {
    state.sortKey = e.target.value;
    applyFilterAndSort();
  });

  dom.clearWatchlistBtn.addEventListener("click", clearWatchlist);

  dom.errorRetryBtn.addEventListener("click", () => {
    hideError();
    fetchCryptoData();
  });

  window.addEventListener("online", () => {
    hideError();
    fetchCryptoData();
  });

  window.addEventListener("offline", () => {
    showError("You're offline. Showing the last saved prices.");
  });
}

/* ---------------------------------- INIT -------------------------------------- */

async function init() {
  loadWatchlist();
  bindEvents();
  renderWatchlist();
  await fetchCryptoData();
  startAutoRefresh();
}

document.addEventListener("DOMContentLoaded", init);
