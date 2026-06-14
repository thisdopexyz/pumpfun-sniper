/**
 * Dependency Injection Container
 *
 * Wires all services together. Single source of truth for all
 * runtime dependencies.
 *
 * Design:
 *   - Lazy initialization (services created on first access)
 *   - Singleton pattern (one instance per service)
 *   - No magic — explicit wiring, easy to trace
 *   - RPC: priority-based pool (Helius > PublicNode > Alchemy)
 *
 * App layer = orchestration ONLY. No business logic.
 */

import { Connection, Keypair } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
import { createLogger } from '../telemetry/logging/logger.js';
import { nowMs } from '../core/utils/time.js';
// Config env loading is in bootstrap.ts, not here
import {
  DEFAULT_HELIUS_RPC_BASE,
  DEFAULT_ALCHEMY_RPC_BASE,
  DEFAULT_RPC_HELIUS_TIMEOUT_MS,
  DEFAULT_RPC_PUBLICNODE_TIMEOUT_MS,
  DEFAULT_RPC_ALCHEMY_TIMEOUT_MS,
  DEFAULT_DB_MAX_CONNECTIONS,
  DEFAULT_DB_IDLE_TIMEOUT_MS,
  DEFAULT_DB_CONNECTION_TIMEOUT_MS,
} from '../core/constants/defaults.js';

// ---------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------
import { createPool } from '../storage/postgres/postgresClient.js';
import { createRedisClient } from '../storage/redis/redisClient.js';
import { TradeRepository } from '../storage/repositories/tradeRepository.js';
import { SignalRepository } from '../storage/repositories/signalRepository.js';
import { RiskStateRepository } from '../storage/repositories/riskStateRepository.js';
import { CreatorStatsRepository } from '../storage/repositories/creatorStatsRepository.js';

// ---------------------------------------------------------------------------
// RPC (priority-ordered pool + failover)
// ---------------------------------------------------------------------------
import { RpcPool, createRpcPool } from '../ingestion/rpc/rpcPool.js';
import type { RpcEndpointConfig } from '../ingestion/rpc/rpcPool.js';
import { RpcFailover } from '../ingestion/rpc/rpcFailover.js';

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------
import { EmergencyKillSwitch } from '../risk/controls/emergencyKillSwitch.js';
import { CooldownManager } from '../risk/controls/cooldownManager.js';
import { DailyLossGuard } from '../risk/controls/dailyLossGuard.js';
import { TradeThrottle } from '../risk/controls/tradeThrottle.js';
import { MaxExposureGuard } from '../risk/exposure/maxExposureGuard.js';
import type { PositionProvider } from '../risk/exposure/maxExposureGuard.js';
import { CreatorBlacklist } from '../risk/blacklist/creatorBlacklist.js';
import { TokenBlacklist } from '../risk/blacklist/tokenBlacklist.js';
import { AntiRugMonitor } from '../risk/controls/antiRug.js';
import { PostBuyMonitor } from '../risk/controls/postBuyMonitor.js';

import { SolPriceOracle } from './solPriceOracle.js';

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
import { TxBuilder } from '../execution/tx/txBuilder.js';
import { PumpfunVenue } from '../execution/venues/pumpfunVenue.js';
import { BonkfunVenue } from '../execution/venues/bonkfunVenue.js';
import { JupiterVenue } from '../execution/venues/jupiterVenue.js';
import { RpcSender } from '../execution/sender/rpcSender.js';
// import { JitoSender } from '../execution/sender/jitoSender.js'; // Disabled
import { SendCoordinator } from '../execution/sender/sendCoordinator.js';
import { KeypairSigner } from '../execution/signing/keypairSigner.js';
import { TradeLifecycleManager } from '../execution/lifecycle/tradeLifecycleManager.js';

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------
import type { IStrategy } from '../core/interfaces/strategy.js';

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

const logger = createLogger('app:container');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** App configuration (loaded from environment). */
export interface AppConfig {
  /** Helius API key (primary RPC). */
  readonly heliusApiKey: string;
  /** Extra Helius API keys (each becomes a separate RPC endpoint at same priority for rotation/failover). */
  readonly heliusExtraApiKeys: readonly string[];
  /** PublicNode RPC URL (fallback #1). */
  readonly publicNodeUrl: string;
  /** Alchemy API key (fallback #2, optional). */
  readonly alchemyApiKey: string;
  /** Solana WebSocket URL (wss://). */
  readonly wsUrl: string;
  /** PostgreSQL connection string. */
  readonly postgresUrl: string;
  /** Redis connection string. */
  readonly redisUrl: string;
  /** Wallet secret key (Uint8Array, 64 bytes). */
  readonly walletSecretKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// RPC URL builders
// ---------------------------------------------------------------------------

function buildHeliusRpcUrl(apiKey: string): string {
  return `${DEFAULT_HELIUS_RPC_BASE}/?api-key=${apiKey}`;
}

function buildAlchemyRpcUrl(apiKey: string): string {
  return `${DEFAULT_ALCHEMY_RPC_BASE}/${apiKey}`;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export class ServiceContainer {
  private readonly config: AppConfig;

  /** WebSocket URL (Helius WSS or custom). */
  get wsUrl(): string {
    return this.config.wsUrl;
  }

  get heliusApiKey(): string {
    return this.config.heliusApiKey;
  }

  // Cached instances (lazy singletons)
  private _rpcPool: RpcPool | null = null;
  private _rpcFailover: RpcFailover | null = null;
  private _connection: Connection | null = null;
  private _connectionCreatedAt = 0;
  private _pgPool: Pool | null = null;
  private _redis: Redis | null = null;
  private _tradeRepository: TradeRepository | null = null;
  private _signalRepository: SignalRepository | null = null;
  private _riskStateRepository: RiskStateRepository | null = null;
  private _creatorStatsRepository: CreatorStatsRepository | null = null;
  private _signer: KeypairSigner | null = null;
  private _killSwitch: EmergencyKillSwitch | null = null;
  private _tradeLifecycleManager: TradeLifecycleManager | null = null;
  private _strategy: IStrategy | null = null;
  private _cooldownManager: CooldownManager | null = null;
  private _dailyLossGuard: DailyLossGuard | null = null;
  private _tradeThrottle: TradeThrottle | null = null;
  private _maxExposureGuard: MaxExposureGuard | null = null;
  private _creatorBlacklist: CreatorBlacklist | null = null;
  private _tokenBlacklist: TokenBlacklist | null = null;
  private _txBuilder: TxBuilder | null = null;
  private _rpcSender: RpcSender | null = null;
  // private _jitoSender: JitoSender | null = null; // Disabled
  private _sendCoordinator: SendCoordinator | null = null;
  private _sellSendCoordinator: SendCoordinator | null = null;
  private _pumpfunVenue: PumpfunVenue | null = null;
  private _bonkfunVenue: BonkfunVenue | null = null;
  private _jupiterVenue: JupiterVenue | null = null;
  private _solPriceOracle: SolPriceOracle | null = null;
  private _antiRugMonitor: AntiRugMonitor | null = null;
  private _postBuyMonitor: PostBuyMonitor | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    logger.info('Service container created');
  }

  // -----------------------------------------------------------------------
  // RPC Infrastructure (priority-ordered)
  // -----------------------------------------------------------------------

  /** Priority-ordered RPC pool: Helius > PublicNode > Alchemy. */
  get rpcPool(): RpcPool {
    if (this._rpcPool === null) {
      // All Helius keys (primary + extras) sit at priority 0. The pool's health
      // tracking moves to the next healthy Helius key when the current one
      // 429s (3 consecutive failures → 30s cooldown). After cooldown the
      // key is retried. This gives load-spreading + automatic failover across
      // all 14 Helius keys without round-robin bookkeeping.
      const endpoints: RpcEndpointConfig[] = [
        {
          name: 'helius',
          priority: 0,
          url: buildHeliusRpcUrl(this.config.heliusApiKey),
          timeoutMs: DEFAULT_RPC_HELIUS_TIMEOUT_MS,
        },
      ];

      this.config.heliusExtraApiKeys.forEach((key, idx) => {
        endpoints.push({
          name: `helius-${idx + 2}`,
          priority: 0,
          url: buildHeliusRpcUrl(key),
          timeoutMs: DEFAULT_RPC_HELIUS_TIMEOUT_MS,
        });
      });

      endpoints.push({
        name: 'publicnode',
        priority: 1,
        url: this.config.publicNodeUrl,
        timeoutMs: DEFAULT_RPC_PUBLICNODE_TIMEOUT_MS,
      });

      // Alchemy only if API key provided
      if (this.config.alchemyApiKey !== '') {
        endpoints.push({
          name: 'alchemy',
          priority: 2,
          url: buildAlchemyRpcUrl(this.config.alchemyApiKey),
          timeoutMs: DEFAULT_RPC_ALCHEMY_TIMEOUT_MS,
        });
      }

      this._rpcPool = createRpcPool(endpoints);

      logger.info('RPC pool created', {
        endpoints: endpoints.map((e) => e.name),
        count: endpoints.length,
      });
    }
    return this._rpcPool;
  }

  /** RPC failover — wraps pool with automatic retry + health tracking. */
  get rpcFailover(): RpcFailover {
    if (this._rpcFailover === null) {
      this._rpcFailover = new RpcFailover(this.rpcPool);
    }
    return this._rpcFailover;
  }

  /**
   * Primary Solana Connection (from best healthy endpoint).
   * Use rpcFailover.execute() for failover-protected calls.
   * This connection is for things that need a raw Connection (subscriptions, etc.)
   */
  get connection(): Connection {
    // Refresh cached connection every 60s so failover to a healthy endpoint
    // actually takes effect. Without TTL, the cached Connection never changes
    // even if the underlying endpoint goes down.
    const CONNECTION_TTL_MS = 60_000;
    if (this._connection === null || (nowMs() - this._connectionCreatedAt) > CONNECTION_TTL_MS) {
      const bestClient = this.rpcFailover.getBestClient();
      this._connection = bestClient.raw;
      this._connectionCreatedAt = nowMs();
    }
    return this._connection;
  }

  // -----------------------------------------------------------------------
  // Storage
  // -----------------------------------------------------------------------

  get pgPool(): Pool {
    if (this._pgPool === null) {
      this._pgPool = createPool({
        connectionString: this.config.postgresUrl,
        maxConnections: DEFAULT_DB_MAX_CONNECTIONS,
        idleTimeoutMs: DEFAULT_DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMs: DEFAULT_DB_CONNECTION_TIMEOUT_MS,
      });
    }
    return this._pgPool;
  }

  get redis(): Redis {
    if (this._redis === null) {
      this._redis = createRedisClient(this.config.redisUrl);
    }
    return this._redis;
  }

  get tradeRepository(): TradeRepository {
    if (this._tradeRepository === null) {
      this._tradeRepository = new TradeRepository();
    }
    return this._tradeRepository;
  }

  get signalRepository(): SignalRepository {
    if (this._signalRepository === null) {
      this._signalRepository = new SignalRepository();
    }
    return this._signalRepository;
  }

  get riskStateRepository(): RiskStateRepository {
    if (this._riskStateRepository === null) {
      this._riskStateRepository = new RiskStateRepository();
    }
    return this._riskStateRepository;
  }

  get creatorStatsRepository(): CreatorStatsRepository {
    if (this._creatorStatsRepository === null) {
      this._creatorStatsRepository = new CreatorStatsRepository();
    }
    return this._creatorStatsRepository;
  }

  get signer(): KeypairSigner {
    if (this._signer === null) {
      const keypair = Keypair.fromSecretKey(this.config.walletSecretKey);
      this._signer = new KeypairSigner(keypair);
    }
    return this._signer;
  }

  // -----------------------------------------------------------------------
  // Risk
  // -----------------------------------------------------------------------

  get killSwitch(): EmergencyKillSwitch {
    if (this._killSwitch === null) {
      this._killSwitch = new EmergencyKillSwitch();
    }
    return this._killSwitch;
  }

  get cooldownManager(): CooldownManager {
    if (this._cooldownManager === null) {
      this._cooldownManager = new CooldownManager({
        riskStateRepo: this.riskStateRepository,
      });
    }
    return this._cooldownManager;
  }

  get dailyLossGuard(): DailyLossGuard {
    if (this._dailyLossGuard === null) {
      this._dailyLossGuard = new DailyLossGuard({
        riskStateRepo: this.riskStateRepository,
      });
    }
    return this._dailyLossGuard;
  }

  get tradeThrottle(): TradeThrottle {
    if (this._tradeThrottle === null) {
      this._tradeThrottle = new TradeThrottle();
    }
    return this._tradeThrottle;
  }

  get maxExposureGuard(): MaxExposureGuard {
    if (this._maxExposureGuard === null) {
      // Default position provider: uses container's strategy data provider
      // Will be overridden via setMaxExposurePositionProvider() after strategy wiring
      const nullProvider: PositionProvider = {
        getOpenPositionCount: async () => 0,
        getTotalExposureLamports: async () => 0n,
      };
      this._maxExposureGuard = new MaxExposureGuard(nullProvider);
    }
    return this._maxExposureGuard;
  }

  /**
   * Set the real position provider for MaxExposureGuard.
   * Call this after wiring the strategy/data provider.
   */
  setMaxExposurePositionProvider(provider: PositionProvider): void {
    this._maxExposureGuard = new MaxExposureGuard(provider);
  }

  get creatorBlacklist(): CreatorBlacklist {
    if (this._creatorBlacklist === null) {
      this._creatorBlacklist = new CreatorBlacklist({
        riskStateRepo: this.riskStateRepository,
      });
    }
    return this._creatorBlacklist;
  }

  get tokenBlacklist(): TokenBlacklist {
    if (this._tokenBlacklist === null) {
      this._tokenBlacklist = new TokenBlacklist();
    }
    return this._tokenBlacklist;
  }

  get antiRugMonitor(): AntiRugMonitor {
    if (this._antiRugMonitor === null) {
      this._antiRugMonitor = new AntiRugMonitor(this.connection);
    }
    return this._antiRugMonitor;
  }

  get postBuyMonitor(): PostBuyMonitor {
    if (this._postBuyMonitor === null) {
      this._postBuyMonitor = new PostBuyMonitor(this.connection);
    }
    return this._postBuyMonitor;
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  get txBuilder(): TxBuilder {
    if (this._txBuilder === null) {
      this._txBuilder = new TxBuilder(this.connection);
    }
    return this._txBuilder;
  }

  private get rpcSender(): RpcSender {
    if (this._rpcSender === null) {
      this._rpcSender = new RpcSender(this.connection);
    }
    return this._rpcSender;
  }

  // JitoSender disabled — bundles not landing in blocks before TX expires
  // private get jitoSender(): JitoSender {
  //   if (this._jitoSender === null) {
  //     this._jitoSender = new JitoSender(this.connection, 'mainnet', {
  //       tipLamports: 100_000,
  //       timeoutMs: 5_000,
  //     });
  //   }
  //   return this._jitoSender;
  // }

  get sendCoordinator(): SendCoordinator {
    if (this._sendCoordinator === null) {
      // Use RpcSender directly (Jito disabled — bundles not landing in blocks)
      this._sendCoordinator = new SendCoordinator(
        this.signer,
        this.rpcSender,
      );
    }
    return this._sendCoordinator;
  }

  /** Sell-specific send coordinator — uses RpcSender directly for speed. */
  get sellSendCoordinator(): SendCoordinator {
    if (this._sellSendCoordinator === null) {
      // Use RpcSender directly for sells (faster confirmation)
      this._sellSendCoordinator = new SendCoordinator(
        this.signer,
        this.rpcSender,
      );
    }
    return this._sellSendCoordinator;
  }

  get pumpfunVenue(): PumpfunVenue {
    if (this._pumpfunVenue === null) {
      this._pumpfunVenue = new PumpfunVenue();
    }
    return this._pumpfunVenue;
  }

  get bonkfunVenue(): BonkfunVenue {
    if (this._bonkfunVenue === null) {
      this._bonkfunVenue = new BonkfunVenue();
    }
    return this._bonkfunVenue;
  }

  get jupiterVenue(): JupiterVenue {
    if (this._jupiterVenue === null) {
      this._jupiterVenue = new JupiterVenue();
    }
    return this._jupiterVenue;
  }

  get tradeLifecycleManager(): TradeLifecycleManager {
    if (this._tradeLifecycleManager === null) {
      this._tradeLifecycleManager = new TradeLifecycleManager();
    }
    return this._tradeLifecycleManager;
  }

  // -----------------------------------------------------------------------
  // App Services
  // -----------------------------------------------------------------------

  get solPriceOracle(): SolPriceOracle {
    if (this._solPriceOracle === null) {
      this._solPriceOracle = new SolPriceOracle();
    }
    return this._solPriceOracle;
  }

  // -----------------------------------------------------------------------
  // Strategy
  // -----------------------------------------------------------------------

  get strategy(): IStrategy {
    if (this._strategy === null) {
      throw new Error(
        'Strategy must be initialized. Call container.setStrategy() first.',
      );
    }
    return this._strategy;
  }

  setStrategy(strategy: IStrategy): void {
    this._strategy = strategy;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  async destroy(): Promise<void> {
    logger.info('Destroying service container');
    // Stop all anti-rug monitoring before shutting down
    if (this._antiRugMonitor !== null) {
      this._antiRugMonitor.stopAll();
    }
    const errors: string[] = [];

    try {
      if (this._pgPool !== null) {
        await this._pgPool.end();
      }
    } catch (err: unknown) {
      errors.push(`postgres: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      if (this._redis !== null) {
        this._redis.disconnect();
      }
    } catch (err: unknown) {
      errors.push(`redis: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (errors.length > 0) {
      logger.error('Errors during container destroy', { errors });
    } else {
      logger.info('Service container destroyed cleanly');
    }
  }
}