// Real trading on Hyperliquid, from the user's own wallet. This site never holds funds:
// the user's wallet approves a trading-only agent key that lives in this browser's storage and
// cannot withdraw. Orders go straight from the browser to Hyperliquid's API.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { formatPrice, formatSize, SymbolConverter } from "@nktkas/hyperliquid/utils";
import { createWalletClient, custom } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";

const transport = new HttpTransport();
const info = new InfoClient({ transport });
const KEY = "ppp.hl.agent.";
let user = null, master = null, agent = null, converter = null, activeProvider = null;
let session = 0, connecting = false, approving = false, orderBusy = false;

function changed() {
  window.dispatchEvent(new CustomEvent("ppp:wallet-change", { detail: { user, session } }));
}
function invalidate() {
  user = master = agent = null;
  session++;
  changed();
}
const onAccounts = accounts => {
  if (user && accounts?.[0]?.toLowerCase() !== user) invalidate();
};
function bindProvider(p) {
  if (p === activeProvider) return;
  if (activeProvider?.removeListener) {
    activeProvider.removeListener("accountsChanged", onAccounts);
    activeProvider.removeListener("chainChanged", invalidate);
    activeProvider.removeListener("disconnect", invalidate);
  }
  activeProvider = p;
  p.on?.("accountsChanged", onAccounts);
  p.on?.("chainChanged", invalidate);
  p.on?.("disconnect", invalidate);
}
function capture() {
  if (!user || !master) throw new Error("Connect a wallet first.");
  return { id: session, user, agent, master, provider: activeProvider };
}
function checkSession(s) {
  if (session !== s.id || user !== s.user || activeProvider !== s.provider) {
    throw new Error("Wallet session changed. Reconnect and review again.");
  }
}
async function verifySession(s) {
  checkSession(s);
  const accounts = await s.provider.request({ method: "eth_accounts" });
  checkSession(s);
  if (accounts?.[0]?.toLowerCase() !== s.user) {
    invalidate();
    throw new Error("Wallet account changed. Reconnect and review again.");
  }
}
window.addEventListener("storage", event => {
  if (user && (event.key === null || event.key === KEY + user)) {
    agent = null;
    session++;
    changed();
  }
});

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

function provider() {
  const p = window.phantom?.ethereum || window.ethereum;
  if (!p) throw new Error("No Ethereum wallet found. Install Phantom, Rabby or MetaMask.");
  return p;
}

async function connect() {
  if (connecting) throw new Error("Wallet connection already in progress.");
  connecting = true;
  try {
    const p = provider();
    bindProvider(p);
    invalidate();
    const id = session;
    const [address] = await p.request({ method: "eth_requestAccounts" });
    if (!/^0x[0-9a-f]{40}$/i.test(address || "")) throw new Error("No wallet account selected.");
    const current = await p.request({ method: "eth_accounts" });
    if (id !== session || current?.[0]?.toLowerCase() !== address.toLowerCase()) {
      throw new Error("Wallet changed while connecting. Connect again.");
    }
    const symbols = converter || await SymbolConverter.create({ transport });
    if (id !== session) throw new Error("Wallet changed while connecting. Connect again.");
    const currentAfterLoad = await p.request({ method: "eth_accounts" });
    if (id !== session || currentAfterLoad?.[0]?.toLowerCase() !== address.toLowerCase()) {
      throw new Error("Wallet changed while connecting. Connect again.");
    }
    user = address.toLowerCase();
    master = new ExchangeClient({ transport, wallet: createWalletClient({ account: address, chain: arbitrum, transport: custom(p) }) });
    converter = symbols;
    const saved = store.get(KEY + user);
    if (saved) {
      try { agent = new ExchangeClient({ transport, wallet: privateKeyToAccount(saved) }); } catch { store.del(KEY + user); }
    }
    changed();
    return { user, hasAgent: !!agent };
  } finally { connecting = false; }
}

// One wallet popup. Creates a trading-only key for this browser.
async function enableTrading() {
  if (approving) throw new Error("Trading approval already in progress.");
  const s = capture();
  approving = true;
  try {
    await verifySession(s);
    const pk = generatePrivateKey();
    const signer = privateKeyToAccount(pk);
    await s.master.approveAgent({ agentAddress: signer.address, agentName: "pppercolator" });
    await verifySession(s);
    store.set(KEY + s.user, pk);
    agent = new ExchangeClient({ transport, wallet: signer });
    session++;
    changed();
    return true;
  } finally { approving = false; }
}

// Removes this browser's key. Exchange-side revocation is a separate wallet action.
function disableTrading() {
  if (user) store.del(KEY + user);
  agent = null;
  session++;
  changed();
}

async function maxBuilderFee(builder) {
  if (!user || !builder) return 0;
  const s = capture();
  const fee = await info.maxBuilderFee({ user: s.user, builder: builder.toLowerCase() });
  checkSession(s);
  return fee;
}

// One wallet popup. `rate` like "0.03%".
async function approveBuilder(builder, rate) {
  const s = capture();
  await verifySession(s);
  await s.master.approveBuilderFee({ builder: builder.toLowerCase(), maxFeeRate: rate });
  await verifySession(s);
  return true;
}

async function account(snapshot = capture()) {
  checkSession(snapshot);
  const s = await info.clearinghouseState({ user: snapshot.user });
  checkSession(snapshot);
  return {
    accountValue: s.marginSummary.accountValue,
    withdrawable: s.withdrawable,
    marginUsed: s.marginSummary.totalMarginUsed,
    positions: s.assetPositions.map((x) => x.position).map((p) => ({
      coin: p.coin, szi: p.szi, entryPx: p.entryPx, unrealizedPnl: p.unrealizedPnl,
      liquidationPx: p.liquidationPx, leverage: p.leverage?.value, positionValue: p.positionValue,
    })),
  };
}

// Market-style order: immediate-or-cancel limit with a price buffer. `builder` is optional:
// { b: "0x...", f: tenthsOfBasisPoint }.
async function submitOrder(snapshot, { coin, isBuy, size, leverage, reduceOnly = false, slippage = 0.01, builder = null, validUntil = null }) {
  if (!snapshot.agent) throw new Error("Enable trading first.");
  const checkQuote = () => {
    if (validUntil !== null && (!Number.isFinite(validUntil) || Date.now() > validUntil)) {
      throw new Error("Price quote expired. Review the order again.");
    }
  };
  checkQuote();
  if (typeof isBuy !== "boolean" || typeof reduceOnly !== "boolean" || !Number.isFinite(size) || size <= 0 ||
      !Number.isFinite(slippage) || slippage < 0 || slippage >= 1 ||
      (!reduceOnly && (!Number.isInteger(leverage) || leverage < 1))) {
    throw new Error("Invalid order size, side, leverage or slippage.");
  }
  const a = converter.getAssetId(coin), dec = converter.getSzDecimals(coin);
  if (a === undefined || dec === undefined) throw new Error("Unknown market " + coin);
  // Validate and format before any leverage change is sent.
  const formattedSize = formatSize(size, dec);
  await verifySession(snapshot);
  const mids = await info.allMids();
  checkSession(snapshot);
  const mid = Number(mids[coin]);
  if (!Number.isFinite(mid) || mid <= 0) throw new Error("No valid price for " + coin);
  const order = {
    a, b: isBuy,
    p: formatPrice(mid * (1 + (isBuy ? slippage : -slippage)), dec),
    s: formattedSize, r: reduceOnly, t: { limit: { tif: "Ioc" } },
  };
  const req = { orders: [order], grouping: "na" };
  if (builder) {
    if (!/^0x[0-9a-f]{40}$/i.test(builder.b || "") || !Number.isSafeInteger(builder.f) || builder.f <= 0) {
      throw new Error("Invalid builder fee.");
    }
    req.builder = { b: builder.b.toLowerCase(), f: builder.f };
  }
  await verifySession(snapshot);
  checkQuote();
  if (!reduceOnly) {
    await snapshot.agent.updateLeverage({ asset: a, isCross: true, leverage });
    await verifySession(snapshot);
  }
  checkQuote();
  let res;
  try { res = await snapshot.agent.order(req); }
  catch (cause) {
    throw new Error("Order outcome could not be confirmed. Check your Hyperliquid orders and positions before retrying. " + cause.message);
  }
  const st = res?.response?.data?.statuses?.[0];
  if (st?.error) throw new Error(st.error);
  if (st?.filled && Number.isFinite(Number(st.filled.totalSz)) && Number(st.filled.totalSz) > 0 && Number.isFinite(Number(st.filled.avgPx)) && Number(st.filled.avgPx) > 0) {
    return { filled: true, avgPx: st.filled.avgPx, totalSz: st.filled.totalSz };
  }
  throw new Error("Order outcome could not be confirmed. Check your Hyperliquid orders and positions before retrying.");
}

async function withOrder(action) {
  if (orderBusy) throw new Error("An order is already in progress. Wait for its result.");
  const snapshot = capture();
  orderBusy = true;
  try { return await action(snapshot); }
  finally { orderBusy = false; }
}
async function marketOrder(order) {
  return withOrder(snapshot => submitOrder(snapshot, order));
}
async function closePosition(coin, builder = null) {
  return withOrder(async snapshot => {
    const acc = await account(snapshot);
    const p = acc.positions.find(x => x.coin === coin);
    const szi = Number(p?.szi);
    if (!Number.isFinite(szi) || !szi) throw new Error("No open " + coin + " position.");
    return submitOrder(snapshot, { coin, isBuy: szi < 0, size: Math.abs(szi), reduceOnly: true, builder });
  });
}

window.PPPHL = { connect, enableTrading, disableTrading, maxBuilderFee, approveBuilder, account, marketOrder, closePosition,
  user: () => user, hasAgent: () => !!agent, session: () => session };
