# Dev Multi-Wallet Defense System

## Problem
Devs are using 200-300 wallets to fake organic buying activity on PumpFun tokens, bypassing existing bundle/wash/cabal detectors. Existing gaps:

1. Bundle detector slot clustering was REMOVED
2. Funding source trace is 1-hop only (stops at CEX hot wallets)
3. No wallet age checking anywhere
4. Bundle window too short (60s)
5. Bundle threshold too generous (40%)
6. Cabal detector needs 3+ token history (useless for first rug)
7. Wash trade detector doesn't track wallet identity
8. Creator check is address-only (no entity graph)
9. Unique wallets threshold only 10
10. No cross-token correlation

## Solution: 4-Layer Defense

### Layer 1: Wallet Age Detector (NEW)
**File:** `src/detectors/walletAge/walletAgeDetector.ts`
**Priority:** HIGHEST — solves 90% of dev multi-wallet cases without funding graph

- Check on-chain creation timestamp for every buying wallet
- Wallet age < 1 hour = weight 3x (critical red flag)
- Wallet age < 24 hours = weight 2x (suspicious)
- Wallet age > 7 days = normal
- Aggregate: if >50% of buying wallets are <1hr old → REJECT
- Scoring: weighted average age, normalized 0-100 (0=clean, 100=all brand new)

**Entry gate:** `walletAgeScore <= 60` (blocks when majority of wallets are new)

### Layer 2: Buy Velocity Analyzer (NEW)
**File:** `src/detectors/buyVelocity/buyVelocityAnalyzer.ts`
**Priority:** HIGH — catches bot swarms without needing wallet identity

- Track unique wallet count per time window
- Windows: 10s, 30s, 60s, 120s from first buy
- Calculate wallets-per-second velocity
- Thresholds:
  - >30 wallets in 60s = bot swarm (score 80+)
  - >50 wallets in 120s = coordinated dump setup (score 70+)
  - >15 wallets in 10s = instant reject (score 100)
- Also track: avg time between buys (low = bot), std dev of intervals

**Entry gate:** `buyVelocityScore <= 65`

### Layer 3: Enhanced Bundle Detector (MODIFY EXISTING)
**File:** `src/detectors/bundle/bundleDetector.ts`
**Changes:**
- Increase window: 60s → 180s
- Lower threshold: 30% → 20%
- Add multi-hop funding trace (3-5 hops, skip CEX)
- Add wallet age weight to cluster scoring
- Re-enable slot-level clustering with tolerance (same slot = +0.3 weight, not auto-cluster)
- Add CEX address exclusion list (Binance, OKX, Bybit, KuCoin, etc.)

### Layer 4: Cross-Token Correlator (NEW)
**File:** `src/detectors/crossToken/crossTokenCorrelator.ts`
**Priority:** MEDIUM — catches serial scammers

- Track wallet clusters across multiple tokens
- When a token dumps (>80% from ATH), mark all buying wallets as "dump participants"
- When those same wallets appear on a new token → flag
- Cluster by co-occurrence on dumped tokens
- Threshold: >5 wallets from a dump-cluster buying new token = REJECT
- TTL: 7 days rolling window

**Entry gate:** `crossTokenScore <= 50`

## Entry Decision Changes
**File:** `src/strategies/filteredSniper/entryDecision.ts`

Add 4 new checks to the 23 existing ones:
- Check 24: Wallet Age Score <= 60
- Check 25: Buy Velocity Score <= 65  
- Check 26: Enhanced Bundle (already Check 11, update threshold)
- Check 27: Cross-Token Score <= 50

## Data Provider Changes
**File:** `src/app/dataProvider.ts`

Wire new detectors into data provider so entry decision can access scores.

## On-Chain Testing
**File:** `src/tests/integration/onchainDevMultiWallet.test.ts`

Test against REAL tokens:
1. Pick known scam tokens (high bundle %, dev dump)
2. Pick known legitimate tokens (organic growth)
3. Verify new detectors correctly reject scams and pass legit tokens
4. Test funding chain tracing with real on-chain SOL transfers
5. Test wallet age with real wallet creation timestamps

## Implementation Order
1. WalletAgeDetector (biggest impact, simplest)
2. BuyVelocityAnalyzer (second biggest impact)
3. Enhanced BundleDetector modifications
4. CrossTokenCorrelator
5. Wire into entry decision + data provider
6. On-chain integration tests
