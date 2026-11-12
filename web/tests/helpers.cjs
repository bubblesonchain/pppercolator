const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const root = resolve(__dirname, '../..');
const prices = [100, 80000, 3000, 150, 300, 200];
const coins = ['SOL', 'BTC', 'ETH', 'xyz:NVDA', 'xyz:TSLA', 'xyz:AAPL'];

function pageScript(path) {
  const html = readFileSync(resolve(root, path), 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(script => script.includes('const WASM_B64='));
}

function metadata(dex, values = prices) {
  const indexes = dex ? [3, 4, 5] : [0, 1, 2];
  return [
    { universe: indexes.map(i => ({ name: coins[i], maxLeverage: 10 })) },
    indexes.map(i => ({ markPx: String(values[i]), funding: '0', dayNtlVlm: '1000', prevDayPx: '100' })),
  ];
}

function harness(path) {
  const elements = new Map();
  const clock = { now: 100000 };
  const orders = [];
  const closes = [];
  const requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'lev' ? '2' : id === 'usd' ? '100' : '',
      textContent: '', hidden: true, disabled: false, style: {},
    });
    return elements.get(id);
  };
  const wallet = { user: '0x' + 'a'.repeat(40), session: 1 };
  const window = new EventTarget(); window.PPPHL = {};
  const context = vm.createContext({
    document: { getElementById: element },
    window,
    PPPHL: {
      hasAgent: () => true,
      user: () => wallet.user,
      session: () => wallet.session,
      account: async () => ({ accountValue: '1000', withdrawable: '1000', marginUsed: '0', positions: [] }),
      maxBuilderFee: async () => 0,
      marketOrder: async order => { orders.push(order); return { filled: false }; },
      closePosition: async coin => { closes.push(coin); return { filled: false }; },
    },
    Date: class extends Date { static now() { return clock.now; } },
    AbortController, setTimeout, clearTimeout, TextDecoder, TextEncoder,
    // Keep startup suspended: these tests drive the page's price and order handlers directly.
    atob: () => '',
    WebAssembly: { instantiate: () => new Promise(() => {}) },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.equal(body.type, 'metaAndAssetCtxs');
      return { ok: true, json: async () => metadata(body.dex) };
    },
  });
  vm.runInContext(pageScript(path), context, { filename: path });
  const run = code => vm.runInContext(code, context);
  run(`
    S={accounts:[{equity:'1000000000',im:'0'}]};
    px=${JSON.stringify(prices.map(p => p * 1e6))};
    live=true; real=true;
    RA={accountValue:'1000',withdrawable:'1000',marginUsed:'0',positions:[]};realAtMs=Date.now();
    log=()=>{};render=()=>{};
  `);
  return {
    run, clock, orders, closes, requests, element, wallet, window, api: context.PPPHL,
    read: expression => JSON.parse(run(`JSON.stringify(${expression})`)),
    respond: callback => {
      context.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return { ok: true, json: async () => callback(body.dex) };
      };
    },
    fail: () => { context.fetch = async () => { throw new Error('offline'); }; },
  };
}


module.exports = { root, prices, coins, pageScript, metadata, harness };
