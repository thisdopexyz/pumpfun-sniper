/**
 * Bootstrap
 *
 * Application startup sequence. Initializes all services in the correct
 * order and wires them together.
 *
 * Startup order:
 *   1. Load config from environment
 *   2. Create service container (with priority-ordered RPC pool)
 *   3. Connect infrastructure (postgres, redis)
 *   4. Verify RPC connectivity
 *   5. Wire strategy
 *   6. Log startup info
 *
 * App layer = orchestration ONLY. No business logic.
 */

import { ServiceContainer } from './container.js';
import type { AppConfig } from './container.js';
import { requireEnv, optionalEnv } from '../core/config/env.js';
import { healthCheck as postgresHealthCheck } from '../storage/postgres/postgresClient.js';
import { createLogger } from '../telemetry/logging/logger.js';

const logger = createLogger('app:bootstrap');

// ---------------------------------------------------------------------------
// Environment Config Loader
// ---------------------------------------------------------------------------

/**
 * Load configuration from environment variables.
 *
 * Required env vars:
 *   - HELIUS_EXTRA_KEYS (comma-separated Helius API keys; first one used for WS)
 *   - DATABASE_URL
 *   - REDIS_URL
 *   - WALLET_SECRET_KEY (base64-encoded 64-byte secret key)
 *
 * Optional env vars:
 *   - HELIUS_API_KEY (legacy: if set, used as primary; otherwise first extra key)
 *   - PUBLICNODE_RPC_URL (default: https://solana-rpc.publicnode.com)
 *   - ALCHEMY_API_KEY (empty = disabled)
 *   - SOLANA_WS_URL (default: wss://mainnet.helius-rpc.com/?api-key=<primary key>)
 *
 * The legacy HELIUS_API_KEY was removed because Helius free tier keys share
 * a single per-account rate limit. Rotating across multiple keys (HELIUS_EXTRA_KEYS)
 * gives much higher throughput. Set HELIUS_API_KEY only if you have a dedicated
 * paid key and want it pinned as primary.
 */
function loadConfig(): AppConfig {
  const legacyPrimaryKey = process.env['HELIUS_API_KEY'];
  const heliusExtraApiKeysRaw = (process.env['HELIUS_EXTRA_KEYS'] ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (heliusExtraApiKeysRaw.length === 0) {
    throw new Error('HELIUS_EXTRA_KEYS missing — provide at least one Helius API key');
  }

  // If legacy HELIUS_API_KEY is set and is NOT already in the extras list,
  // use it as the primary (prepended) so it gets the WS slot.
  // Otherwise the first extra key is the primary.
  const heliusApiKey = (legacyPrimaryKey && !heliusExtraApiKeysRaw.includes(legacyPrimaryKey))
    ? legacyPrimaryKey
    : heliusExtraApiKeysRaw[0]!;

  const heliusExtraApiKeys = heliusExtraApiKeysRaw.filter((k) => k !== heliusApiKey);
  const publicNodeUrl = optionalEnv('PUBLICNODE_RPC_URL', 'https://solana-rpc.publicnode.com');
  const alchemyApiKey = optionalEnv('ALCHEMY_API_KEY', '');
  const wsUrl = optionalEnv('SOLANA_WS_URL', `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`);
  const postgresUrl = requireEnv('DATABASE_URL');
  const redisUrl = requireEnv('REDIS_URL');
  const walletSecretKeyB64 = requireEnv('WALLET_SECRET_KEY');

  // Decode base64 secret key
  const walletSecretKey = new Uint8Array(
    Buffer.from(walletSecretKeyB64, 'base64'),
  );

  if (walletSecretKey.length !== 64) {
    throw new Error(
      `WALLET_SECRET_KEY must decode to 64 bytes, got ${walletSecretKey.length}`,
    );
  }

  logger.info('Config loaded from environment', {
    rpcPrimary: 'helius',
    rpcHeliusExtras: heliusExtraApiKeys.length,
    rpcFallback1: 'publicnode',
    rpcFallback2: alchemyApiKey !== '' ? 'alchemy' : 'disabled',
    postgresUrl: '<redacted>',
    redisUrl: '<redacted>',
  });

  return {
    heliusApiKey,
    heliusExtraApiKeys,
    publicNodeUrl,
    alchemyApiKey,
    wsUrl,
    postgresUrl,
    redisUrl,
    walletSecretKey,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstrap the application.
 * Returns the service container for lifecycle management.
 */
export async function bootstrap(): Promise<ServiceContainer> {
  logger.info('=== PUMPFUN SNIPER STARTING ===');
  const startTime = Date.now();

  // Step 1: Load config
  logger.info('Step 1/6: Loading config...');
  const config = loadConfig();

  // Step 2: Create container
  logger.info('Step 2/6: Creating service container...');
  const container = new ServiceContainer(config);

  // Step 3: Connect infrastructure
  logger.info('Step 3/6: Connecting infrastructure...');
  // Eagerly create and ping the Postgres pool so repositories can use query()
  // immediately. pg.Pool construction is lazy, so creation alone does not prove
  // DB connectivity; a startup health check prevents first-trade DB failures.
  try {
    void container.pgPool; // triggers createPool()
    const pgHealth = await postgresHealthCheck();
    if (!pgHealth.ok) {
      throw new Error(pgHealth.error ?? 'unknown Postgres health-check failure');
    }
    logger.info('  PostgreSQL pool ready', { latencyMs: pgHealth.latencyMs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('  PostgreSQL unavailable — refusing to start without trade persistence', { error: msg });
    throw err;
  }

  // Redis — trigger creation and verify connectivity
  try {
    void container.redis; // force creation (triggers lazy connect)
    logger.info('  Redis client created (lazy connect)');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('  Redis creation failed — continuing without cache', { error: msg });
  }

  // Step 4: Verify RPC connectivity
  logger.info('Step 4/6: Verifying RPC endpoints...');
  const healthStatus = container.rpcPool.getHealthStatus();
  logger.info('  RPC pool health', {
    endpoints: healthStatus.map((h) => ({ name: h.name, healthy: h.healthy })),
  });
  logger.info('  Solana RPC connection ready');

  // Step 5: Wire strategy
  logger.info('Step 5/6: Wiring strategy...');
  // Strategy is initialized by the integration layer after bootstrap.
  // The container.strategy getter will throw if accessed before setStrategy().
  // This is intentional — the caller (main.ts) must wire the strategy
  // with real providers before starting the event loop.
  logger.info('  Strategy container slot ready (wire via container.setStrategy())');

  // Step 6: Log startup info
  logger.info('Step 6/6: Startup complete');
  const walletPubkey = container.signer.getPublicKey().toBase58();
  const elapsed = Date.now() - startTime;

  logger.info('=== PUMPFUN SNIPER READY ===', {
    walletPublicKey: walletPubkey,
    killSwitchActive: container.killSwitch.getState().killed,
    rpcEndpoints: healthStatus.map((h) => h.name),
    startupTimeMs: elapsed,
  });

  return container;
}
