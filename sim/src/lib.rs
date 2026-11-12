//! Thin simulation wrapper around the unmodified Percolator v16 risk engine.
//! The wrapper only does what the engine README says a wrapper must do:
//! hold accounts, feed prices, and move (paper) tokens. All risk decisions
//! (margin, funding, liquidation, loss handling) come from the engine.
//! Heap-free, so the browser build needs nothing but `core`.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
use core::cell::UnsafeCell;
#[cfg(not(target_arch = "wasm32"))]
use std::cell::RefCell;
use core::fmt::Write;
use percolator::{
    AutoCrankObservationV16, AutoCrankPlanV16, AutoCrankWorkV16, EngineAssetSlotV16Account, LiquidationRequestV16, Market, MarketGroupV16HeaderAccount,
    MarketGroupV16ViewMut, PortfolioAccountV16Account, PortfolioV16ViewMut, ProvenanceHeaderV16,
    ProvenanceHeaderV16Account, SideV16, TradeRequestV16, V16Config, V16Error,
};

// Browser exports are single-threaded. Native simulations and C ABI callers use
// thread-local scratch/state so independent threads never alias a mutable buffer.
const OUT_CAP: usize = 32 * 1024;
#[cfg(target_arch = "wasm32")]
struct Cell<T>(UnsafeCell<T>);
#[cfg(target_arch = "wasm32")]
unsafe impl<T> Sync for Cell<T> {}
#[cfg(target_arch = "wasm32")]
static SNAP: Cell<Option<Sim>> = Cell(UnsafeCell::new(None));
#[cfg(target_arch = "wasm32")]
static SIM: Cell<Option<Sim>> = Cell(UnsafeCell::new(None));
#[cfg(target_arch = "wasm32")]
static OUT: Cell<([u8; OUT_CAP], usize)> = Cell(UnsafeCell::new(([0; OUT_CAP], 0)));
#[cfg(not(target_arch = "wasm32"))]
std::thread_local! {
    static SNAP: RefCell<Option<Sim>> = const { RefCell::new(None) };
    static SIM: RefCell<Option<Sim>> = const { RefCell::new(None) };
    static OUT: RefCell<([u8; OUT_CAP], usize)> = const { RefCell::new(([0; OUT_CAP], 0)) };
}
macro_rules! with_cell {
    ($cell:ident, $f:expr) => {{
        #[cfg(target_arch = "wasm32")]
        { ($f)(unsafe { &mut *$cell.0.get() }) }
        #[cfg(not(target_arch = "wasm32"))]
        { $cell.with(|cell| ($f)(&mut *cell.borrow_mut())) }
    }};
}
fn with_snapshot<R>(f: impl FnOnce(&mut Option<Sim>) -> R) -> R {
    with_cell!(SNAP, f)
}

pub const ASSETS: usize = 6;
/// Traders are accounts 0..TRADERS. Each trader has a dedicated house counterparty account at
/// TRADERS + trader, so closing a trader out always cancels both sides exactly.
pub const TRADERS: usize = 7;
pub const ACCOUNTS: usize = 2 * TRADERS;
const TAKEOVER_FEE_BPS: u64 = 50;
const MARKET_ID: [u8; 32] = [7; 32];
const OWNER: [u8; 32] = [9; 32];

#[derive(Clone, Copy)]
pub struct Sim {
    header: MarketGroupV16HeaderAccount,
    markets: [Market<u64>; ASSETS],
    accounts: [PortfolioAccountV16Account; ACCOUNTS],
    prices: [u64; ASSETS],
    slot: u64,
    deposited: u128,
    withdrawn: u128,
    pub last_error: &'static str,
    pub last_crank: u32,
    pub last_takeover: u32,
}

fn err_name(e: V16Error) -> &'static str {
    match e {
        V16Error::InvalidConfig => "InvalidConfig",
        V16Error::ArithmeticOverflow => "ArithmeticOverflow",
        V16Error::ProvenanceMismatch => "ProvenanceMismatch",
        V16Error::HiddenLeg => "HiddenLeg",
        V16Error::InvalidLeg => "InvalidLeg",
        V16Error::Stale => "Stale",
        V16Error::BStale => "BStale",
        V16Error::LockActive => "LockActive",
        V16Error::NonProgress => "NonProgress",
        V16Error::RecoveryRequired => "RecoveryRequired",
        V16Error::CounterOverflow => "CounterOverflow",
        V16Error::CounterUnderflow => "CounterUnderflow",
    }
}

impl Sim {
    pub fn new(
        init_prices: [u64; ASSETS],
        initial_margin_bps: u64,
        maintenance_margin_bps: u64,
        liquidation_fee_bps: u64,
        max_move_bps: u64,
    ) -> Result<Sim, V16Error> {
        let mut cfg = V16Config::public_user_fund_with_market_slots(ASSETS as u16, ASSETS as u32, 0, 10);
        cfg.initial_margin_bps = initial_margin_bps;
        cfg.maintenance_margin_bps = maintenance_margin_bps;
        cfg.liquidation_fee_bps = liquidation_fee_bps;
        cfg.liquidation_fee_cap = 1_000_000_000_000;
        cfg.max_trading_fee_bps = 100;
        cfg.min_nonzero_mm_req = 100;
        cfg.min_nonzero_im_req = 101;
        cfg.max_price_move_bps_per_slot = max_move_bps;
        let mut header = MarketGroupV16HeaderAccount::new_dynamic(MARKET_ID, cfg, ASSETS as u32, 0)?;
        let mut markets: [Market<u64>; ASSETS] =
            core::array::from_fn(|i| Market::new(i as u64, EngineAssetSlotV16Account::default()));
        for i in 0..ASSETS {
            header.activate_empty_asset_slot_not_atomic(
                i as u32,
                &mut markets[i].engine,
                init_prices[i],
                (i + 1) as u64,
            )?;
        }
        // Assets must be activated one slot apart; bring every asset to the same slot before use.
        {
            let mut market = MarketGroupV16ViewMut::new(&mut header, &mut markets);
            let target = ASSETS as u64 + 1;
            for i in 0..ASSETS {
                let mut guard = 0;
                while market.markets[i].engine.asset.slot_last.get() < target && guard < 64 {
                    market.accrue_asset_to_not_atomic(i, target, init_prices[i], 0, true)?;
                    guard += 1;
                }
            }
        }
        let mut accounts = [PortfolioAccountV16Account::default(); ACCOUNTS];
        for a in 0..ACCOUNTS {
            let ph = ProvenanceHeaderV16Account::from_runtime(&ProvenanceHeaderV16::new(
                MARKET_ID,
                [a as u8 + 1; 32],
                OWNER,
            ));
            let mut acct = PortfolioAccountV16Account::default();
            acct.init_empty_in_place(ph)?;
            accounts[a] = acct;
        }
        let sim = Sim { header, markets, accounts, prices: init_prices, slot: 0, deposited: 0, withdrawn: 0, last_error: "", last_crank: 0, last_takeover: 0 };
        Ok(sim)
    }

    /// Engine calls are documented as non-atomic: an `Err` must be rolled back by the
    /// caller, the way the SVM rolls back a failed transaction. We snapshot and restore.
    fn tx<R>(&mut self, f: impl FnOnce(&mut Sim) -> Result<R, V16Error>) -> Option<R> {
        with_snapshot(|snap| {
            *snap = Some(*self);
            match f(self) {
            Ok(r) => {
                self.last_error = "";
                Some(r)
            }
            Err(e) => {
                if let Some(prev) = snap.take() {
                    *self = prev;
                }
                self.last_error = err_name(e);
                None
            }
            }
        })
    }

    pub fn deposit(&mut self, acct: usize, amount: u128) -> bool {
        if acct >= ACCOUNTS { return false; }
        self.tx(|s| {
            let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
            let mut p = PortfolioV16ViewMut::new(&mut s.accounts[acct]);
            market.deposit_not_atomic(&mut p, amount)?;
            s.deposited += amount;
            Ok(())
        })
        .is_some()
    }

    pub fn withdraw(&mut self, acct: usize, amount: u128) -> bool {
        if acct >= ACCOUNTS { return false; }
        self.tx(|s| {
            let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
            let mut p = PortfolioV16ViewMut::new(&mut s.accounts[acct]);
            market.full_account_refresh_not_atomic(&mut p)?;
            market.withdraw_not_atomic(&mut p, amount)?;
            s.withdrawn += amount;
            Ok(())
        })
        .is_some()
    }

    /// `size_q` > 0: account `a` buys from account `b` at the current oracle price.
    pub fn trade(&mut self, a: usize, b: usize, asset: usize, size_q: i128, fee_bps: u64) -> bool {
        if a >= ACCOUNTS || b >= ACCOUNTS || a == b || asset >= ASSETS { return false; }
        self.tx(|s| {
            let price = s.prices[asset];
            let (lo, hi) = if a < b { (a, b) } else { (b, a) };
            let (left, right) = s.accounts.split_at_mut(hi);
            let (ra, rb) = if a < b { (&mut left[lo], &mut right[0]) } else { (&mut right[0], &mut left[lo]) };
            let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
            let mut pa = PortfolioV16ViewMut::new(ra);
            let mut pb = PortfolioV16ViewMut::new(rb);
            market.full_account_refresh_not_atomic(&mut pa)?;
            market.full_account_refresh_not_atomic(&mut pb)?;
            market.execute_trade_with_fee_loss_stale_scoped_not_atomic(
                &mut pa,
                &mut pb,
                TradeRequestV16 { asset_index: asset, size_q, exec_price: price, fee_bps },
            )?;
            Ok(())
        })
        .is_some()
    }

    /// Advance the clock one slot and move one asset's oracle price (others keep theirs).
    pub fn set_price(&mut self, asset: usize, price: u64, _funding_rate_e9: i128) -> bool {
        if asset >= ASSETS { return false; }
        let mut prices = self.prices;
        prices[asset] = price;
        self.tick(prices)
    }

    /// One slot: publish the oracle observation for every asset, accrue each asset to the new
    /// slot, then crank (refresh) every account so no leg is left stale. The engine enforces
    /// its own per-slot price-move limit; a refused tick leaves state unchanged.
    pub fn tick(&mut self, prices: [u64; ASSETS]) -> bool {
        let ok = self
            .tx(|s| {
                let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
                let mut next = market.header.current_slot.get();
                for i in 0..ASSETS {
                    next = next.max(market.markets[i].engine.asset.slot_last.get());
                }
                next += 1;
                let mut targets = [(0usize, 0u64); ASSETS];
                for i in 0..ASSETS {
                    targets[i] = (i, prices[i]);
                }
                market.set_asset_raw_oracle_targets_not_atomic(&targets)?;
                for i in 0..ASSETS {
                    market.accrue_asset_to_not_atomic(i, next, prices[i], 0, true)?;
                }
                s.slot = next;
                s.prices = prices;
                Ok(())
            })
            .is_some();
        if ok {
            self.housekeeping();
            self.last_takeover = self.takeovers();
            self.last_crank = self.crank();
            self.housekeeping();
            self.last_error = "";
        }
        ok
    }

    /// Market-maker backstop, a wrapper policy and not an engine rule: when the engine certifies
    /// a trader below the maintenance requirement, that trader's house counterparty closes the
    /// whole position at the oracle price as an ordinary trade, charging the configured fee.
    /// Both sides cancel exactly, so no other account is touched. The engine still decides
    /// whether the trade is allowed; anything left falls through to the engine's own
    /// liquidation in `crank`. Returns a bitmask of traders closed out.
    fn takeovers(&mut self) -> u32 {
        let mut mask = 0u32;
        for a in 0..TRADERS {
            let under = self.tx(|s| {
                let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
                let mut p = PortfolioV16ViewMut::new(&mut s.accounts[a]);
                let c = market.full_account_refresh_not_atomic(&mut p)?;
                Ok(c.certified_maintenance_req != 0 && c.certified_equity < c.certified_maintenance_req as i128)
            });
            if under != Some(true) { continue; }
            let pos = self.effective_positions(a);
            for i in 0..ASSETS {
                if pos[i] != 0 && self.trade(a, TRADERS + a, i, -pos[i], TAKEOVER_FEE_BPS) {
                    mask |= 1 << a;
                }
            }
        }
        mask
    }

    /// Effective (post-ADL) signed size per asset for one account.
    pub fn effective_positions(&self, a: usize) -> [i128; ASSETS] {
        let mut pos = [0i128; ASSETS];
        for leg in self.accounts[a].legs.iter() {
            if let Ok(l) = leg.try_to_runtime() {
                if l.active && (l.asset_index as usize) < ASSETS {
                    let i = l.asset_index as usize;
                    if let Ok(asset) = self.markets[i].engine.asset.try_to_runtime() {
                        let long = l.basis_pos_q > 0;
                        let (a_side, epoch) = if long { (asset.a_long, asset.epoch_long) } else { (asset.a_short, asset.epoch_short) };
                        if epoch == l.epoch_snap && l.a_basis != 0 {
                            let abs = l.basis_pos_q.unsigned_abs();
                            let eff = match abs.checked_mul(a_side) { Some(v) => v / l.a_basis, None => abs / l.a_basis * a_side };
                            pos[i] = if long { eff as i128 } else { -(eff as i128) };
                        }
                    }
                }
            }
        }
        pos
    }

    /// Permissionless upkeep any keeper may call: retire backing buckets whose freshness window
    /// has passed, and finish side resets the engine has already scheduled. Each call either
    /// succeeds or is rolled back; the engine decides whether it is allowed.
    fn housekeeping(&mut self) {
        for d in 0..2 * ASSETS {
            let _ = self.tx(|s| {
                let now = s.slot;
                let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
                market.expire_source_backing_bucket_not_atomic(d, now)
            });
        }
        for i in 0..ASSETS {
            for side in [SideV16::Long, SideV16::Short] {
                let _ = self.tx(|s| {
                    let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
                    market.finalize_side_reset_not_atomic(i, side)
                });
            }
        }
    }

    /// The engine's own keeper entry point, run for every account until it reports nothing
    /// left to do. The engine picks the step (refresh, settle, liquidate, release liens,
    /// recovery); the wrapper only supplies the current slot and prices.
    /// Returns a bitmask of accounts the engine liquidated during this crank.
    pub fn crank(&mut self) -> u32 {
        let mut liquidated = 0u32;
        for a in 0..ACCOUNTS {
            for _ in 0..8 {
                let step = self.tx(|s| {
                    let mut obs = [AutoCrankObservationV16 { asset_index: 0, effective_price: 0, funding_rate_e9: 0 }; ASSETS];
                    for i in 0..ASSETS {
                        obs[i] = AutoCrankObservationV16 { asset_index: i, effective_price: s.prices[i], funding_rate_e9: 0 };
                    }
                    let now_slot = s.slot;
                    let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
                    let mut p = PortfolioV16ViewMut::new(&mut s.accounts[a]);
                    let r = market.permissionless_auto_crank_not_atomic(
                        &mut p,
                        AutoCrankWorkV16 { now_slot, observations: &obs, resolved_close_fee_rate_per_slot: 0 },
                    )?;
                    Ok(r.selected)
                });
                match step {
                    Some(AutoCrankPlanV16::NoAction) | None => break,
                    Some(AutoCrankPlanV16::Liquidate { .. }) => liquidated |= 1 << a,
                    Some(_) => {}
                }
            }
        }
        liquidated
    }

    pub fn liquidate(&mut self, acct: usize, asset: usize) -> Option<(u128, u128, u128)> {
        if acct >= ACCOUNTS || asset >= ASSETS { return None; }
        self.tx(|s| {
            let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
            let mut p = PortfolioV16ViewMut::new(&mut s.accounts[acct]);
            let o = market.liquidate_account_not_atomic(&mut p, LiquidationRequestV16 { asset_index: asset })?;
            Ok((o.closed_q, o.fee_charged, o.insurance_used))
        })
    }

    pub fn convert_pnl(&mut self, acct: usize) -> bool {
        if acct >= ACCOUNTS { return false; }
        self.tx(|s| {
            let mut market = MarketGroupV16ViewMut::new(&mut s.header, &mut s.markets);
            let mut p = PortfolioV16ViewMut::new(&mut s.accounts[acct]);
            market.full_account_refresh_not_atomic(&mut p)?;
            market.convert_released_pnl_to_capital_not_atomic(&mut p)?;
            Ok(())
        })
        .is_some()
    }

    /// The solvency checks the playground scores against.
    /// Returns (tokens_conserved, vault_covers_capital_and_insurance, engine_shape_valid).
    pub fn invariants(&mut self) -> (bool, bool, bool) {
        let vault = self.header.vault.get();
        let conserved = vault == self.deposited - self.withdrawn;
        let cap: u128 = self.accounts.iter().map(|a| a.capital.get()).sum();
        let covered = vault >= cap + self.header.insurance.get();
        let market = MarketGroupV16ViewMut::new(&mut self.header, &mut self.markets);
        let shape = market.validate_shape().is_ok();
        (conserved, covered, shape)
    }

    pub fn write_state<W: Write>(&mut self, o: &mut W) {
        let (c, v, sh) = self.invariants();
        let _ = write!(
            o,
            "{{\"slot\":{},\"vault\":\"{}\",\"insurance\":\"{}\",\"c_tot\":\"{}\",\"deposited\":\"{}\",\"withdrawn\":\"{}\",\"inv\":{{\"conserved\":{},\"covered\":{},\"shape\":{}}},\"err\":\"{}\",\"assets\":[",
            self.slot, self.header.vault.get(), self.header.insurance.get(), self.header.c_tot.get(),
            self.deposited, self.withdrawn, c, v, sh, self.last_error
        );
        for i in 0..ASSETS {
            let (l, s) = match self.markets[i].engine.asset.try_to_runtime() {
                Ok(a) => (a.oi_eff_long_q, a.oi_eff_short_q),
                Err(_) => (0, 0),
            };
            let _ = write!(o, "{}{{\"price\":{},\"oi_long\":\"{}\",\"oi_short\":\"{}\"}}", if i > 0 { "," } else { "" }, self.prices[i], l, s);
        }
        let _ = o.write_str("],\"accounts\":[");
        for a in 0..ACCOUNTS {
            // Health is read on a scratch copy so viewing never mutates engine state.
            let cert = with_snapshot(|scratch| {
                *scratch = Some(*self);
                match scratch.as_mut() {
                Some(sc) => {
                    let mut market = MarketGroupV16ViewMut::new(&mut sc.header, &mut sc.markets);
                    let mut p = PortfolioV16ViewMut::new(&mut sc.accounts[a]);
                    market.full_account_refresh_not_atomic(&mut p)
                }
                None => Err(V16Error::InvalidConfig),
                }
            });
            let (eq, im, mm, ok) = match cert {
                Ok(c) => (c.certified_equity, c.certified_initial_req, c.certified_maintenance_req, true),
                Err(_) => (0, 0, 0, false),
            };
            let _ = write!(
                o,
                "{}{{\"capital\":\"{}\",\"pnl\":\"{}\",\"equity\":\"{}\",\"im\":\"{}\",\"mm\":\"{}\",\"cert\":{},\"pos\":[",
                if a > 0 { "," } else { "" }, self.accounts[a].capital.get(), self.accounts[a].pnl.get(), eq, im, mm, ok
            );
            let pos = self.effective_positions(a);
            for i in 0..ASSETS {
                let _ = write!(o, "{}\"{}\"", if i > 0 { "," } else { "" }, pos[i]);
            }
            let _ = o.write_str("]}");
        }
        let _ = o.write_str("]}");
    }
}

// ---------------- C ABI for the browser (wasm32-unknown-unknown, no bindgen) ----------------

struct Buf;
impl Write for Buf {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        with_cell!(OUT, |out: &mut ([u8; OUT_CAP], usize)| {
            let (buf, len) = out;
            let b = s.as_bytes();
            if *len + b.len() > OUT_CAP { return Err(core::fmt::Error); }
            buf[*len..*len + b.len()].copy_from_slice(b);
            *len += b.len();
            Ok(())
        })
    }
}

fn with<R>(d: R, f: impl FnOnce(&mut Sim) -> R) -> R {
    with_cell!(SIM, |slot: &mut Option<Sim>| match slot.as_mut() { Some(sim) => f(sim), None => d })
}

#[no_mangle]
pub extern "C" fn sim_init(p0: u64, p1: u64, p2: u64, p3: u64, p4: u64, p5: u64, im_bps: u64, mm_bps: u64, liq_bps: u64, max_move_bps: u64) -> i32 {
    match Sim::new([p0, p1, p2, p3, p4, p5], im_bps, mm_bps, liq_bps, max_move_bps) {
        Ok(s) => { with_cell!(SIM, |slot: &mut Option<Sim>| *slot = Some(s)); 1 }
        Err(_) => 0,
    }
}
#[no_mangle]
pub extern "C" fn sim_deposit(acct: u32, amount: u64) -> i32 { with(0, |s| s.deposit(acct as usize, amount as u128) as i32) }
#[no_mangle]
pub extern "C" fn sim_withdraw(acct: u32, amount: u64) -> i32 { with(0, |s| s.withdraw(acct as usize, amount as u128) as i32) }
#[no_mangle]
pub extern "C" fn sim_trade(a: u32, asset: u32, size_q: i64, fee_bps: u64) -> i32 { with(0, |s| if (a as usize) < TRADERS { s.trade(a as usize, TRADERS + a as usize, asset as usize, size_q as i128, fee_bps) as i32 } else { 0 }) }
#[no_mangle]
pub extern "C" fn sim_set_price(asset: u32, price: u64, funding_e9: i64) -> i32 { with(0, |s| s.set_price(asset as usize, price, funding_e9 as i128) as i32) }
#[no_mangle]
pub extern "C" fn sim_tick(p0: u64, p1: u64, p2: u64, p3: u64, p4: u64, p5: u64) -> i32 { with(0, |s| s.tick([p0, p1, p2, p3, p4, p5]) as i32) }
/// Bitmask of accounts the house took over during the last tick.
#[no_mangle]
pub extern "C" fn sim_last_takeover() -> u32 { with(0, |s| s.last_takeover) }
/// Bitmask of accounts the engine liquidated during the last tick's crank.
#[no_mangle]
pub extern "C" fn sim_last_crank() -> u32 { with(0, |s| s.last_crank) }
#[no_mangle]
pub extern "C" fn sim_liquidate(acct: u32, asset: u32) -> i32 { with(0, |s| s.liquidate(acct as usize, asset as usize).is_some() as i32) }
#[no_mangle]
pub extern "C" fn sim_convert(acct: u32) -> i32 { with(0, |s| s.convert_pnl(acct as usize) as i32) }
/// Serialises state to JSON in a static buffer; returns its address. Length via `sim_state_len`.
#[no_mangle]
pub extern "C" fn sim_state() -> *const u8 {
    with_cell!(OUT, |out: &mut ([u8; OUT_CAP], usize)| out.1 = 0);
    with((), |s| s.write_state(&mut Buf));
    with_cell!(OUT, |out: &mut ([u8; OUT_CAP], usize)| out.0.as_ptr())
}
#[no_mangle]
pub extern "C" fn sim_state_len() -> u32 { with_cell!(OUT, |out: &mut ([u8; OUT_CAP], usize)| out.1 as u32) }

#[cfg(target_arch = "wasm32")]
mod rt {
    use core::alloc::{GlobalAlloc, Layout};
    // The engine declares `extern crate alloc` but never allocates; neither do we.
    struct NoHeap;
    unsafe impl GlobalAlloc for NoHeap {
        unsafe fn alloc(&self, _: Layout) -> *mut u8 { core::ptr::null_mut() }
        unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
    }
    #[global_allocator]
    static A: NoHeap = NoHeap;
    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn independent_transactions_keep_their_own_rollback_snapshot() {
        let barrier = Arc::new(Barrier::new(4));
        let threads: Vec<_> = (0..4).map(|i| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut sim = Sim::new([100_000_000; ASSETS], 1000, 500, 50, 400).unwrap();
                let amount = (i + 1) * 1_000_000u128;
                assert!(sim.deposit(0, amount));
                let result: Option<()> = sim.tx(|s| {
                    // Every thread has captured a different snapshot before any rolls back.
                    barrier.wait();
                    s.deposited = 0;
                    Err(V16Error::InvalidConfig)
                });
                assert!(result.is_none());
                assert_eq!(sim.deposited, amount);
                assert_eq!(sim.invariants(), (true, true, true));
                let mut state = String::new();
                sim.write_state(&mut state);
                assert!(state.contains(&format!("\"deposited\":\"{}\"", amount)));
            })
        }).collect();
        for thread in threads { thread.join().unwrap(); }
    }

    #[test]
    fn native_abi_state_and_output_are_isolated_per_thread() {
        let barrier = Arc::new(Barrier::new(4));
        let threads: Vec<_> = (0..4).map(|i| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                assert_eq!(sim_init(100_000_000, 100_000_000, 100_000_000, 100_000_000, 100_000_000, 100_000_000, 1000, 500, 50, 400), 1);
                let amount = (i + 1) * 1_000_000;
                assert_eq!(sim_deposit(0, amount), 1);
                barrier.wait();
                let ptr = sim_state();
                barrier.wait();
                let state = unsafe { std::slice::from_raw_parts(ptr, sim_state_len() as usize) };
                let state = std::str::from_utf8(state).unwrap();
                assert!(state.contains(&format!("\"deposited\":\"{}\"", amount)));
            })
        }).collect();
        for thread in threads { thread.join().unwrap(); }
    }
}
