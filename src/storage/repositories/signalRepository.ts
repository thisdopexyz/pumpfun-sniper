import { query } from '../postgres/postgresClient.js';
import type { IRepository } from '../../core/interfaces/storage.js';
import type {
  Signal,
  SignalId,
  SignalType,
  LaunchSignal,
  MomentumSignal,
  MigrationSignal,
  LiquidityPhaseSignal,
  WashTradeSignal,
  BundleSignal,
  ConcentrationSignal,
  SmartMoneySignal,
} from '../../core/types/signal.js';
import type { WalletAddress } from '../../core/types/wallet.js';

interface SignalRow {
  readonly id: string;
  readonly type: string;
  readonly mint: string;
  readonly timestamp: Date;
  readonly slot: string;
  readonly data: Record<string, unknown>;
}

function extractData(signal: Signal): Record<string, unknown> {
  const { id: _, type: _t, mint: _m, timestamp: _ts, slot: _s, ...rest } = signal;
  return rest;
}

function reconstructSignal(row: SignalRow): Signal {
  const base = {
    id: row.id as SignalId,
    type: row.type as SignalType,
    mint: row.mint,
    timestamp: new Date(row.timestamp).getTime(),
    slot: Number(row.slot),
  } as const;

  const data = row.data as Record<string, unknown>;

  switch (base.type) {
    case 'LAUNCH':
      return { ...base, ...data } as LaunchSignal;
    case 'MOMENTUM':
      return { ...base, ...data } as MomentumSignal;
    case 'MIGRATION':
      return { ...base, ...data } as MigrationSignal;
    case 'LIQUIDITY_PHASE':
      return { ...base, ...data } as LiquidityPhaseSignal;
    case 'WASH_TRADE':
      return { ...base, ...data } as WashTradeSignal;
    case 'BUNDLE':
      return { ...base, ...data } as BundleSignal;
    case 'CONCENTRATION':
      return { ...base, ...data } as ConcentrationSignal;
    case 'SMART_MONEY':
      return { ...base, ...data } as SmartMoneySignal;
    case 'WALLET_AGE':
      return { ...base, ...data } as import('../../core/types/signal.js').WalletAgeSignal;
    case 'BUY_VELOCITY':
      return { ...base, ...data } as import('../../core/types/signal.js').BuyVelocitySignal;
    case 'CROSS_TOKEN':
      return { ...base, ...data } as import('../../core/types/signal.js').CrossTokenSignal;
    default: {
      // Unknown type (legacy DB row from before type cleanup, or future type
      // not yet supported by this codebase). Filter out instead of throwing —
      // otherwise findByMint() in dataProvider crashes and breaks entry flow.
      console.warn('signalRepository: skipping unknown signal type', {
        type: base.type,
        id: base.id,
        mint: base.mint,
      });
      // Return null via signalData path — caller must filter.
      return null as unknown as Signal;
    }
  }
}

export class SignalRepository implements IRepository<Signal, SignalId> {
  async findById(id: SignalId): Promise<Signal | null> {
    const result = await query<SignalRow>({
      text: 'SELECT id, type, mint, timestamp, slot, data FROM signals WHERE id = $1',
      values: [id],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return reconstructSignal(row);
  }

  async save(signal: Signal): Promise<void> {
    const data = extractData(signal);
    const ts = new Date(signal.timestamp).toISOString();

    await query({
      text: `INSERT INTO signals (id, type, mint, timestamp, slot, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         mint = EXCLUDED.mint,
         timestamp = EXCLUDED.timestamp,
         slot = EXCLUDED.slot,
         data = EXCLUDED.data`,
      values: [signal.id, signal.type, signal.mint, ts, signal.slot, JSON.stringify(data)],
    });
  }

  async delete(id: SignalId): Promise<void> {
    await query({ text: 'DELETE FROM signals WHERE id = $1', values: [id] });
  }

  async findByMint(mint: string): Promise<readonly Signal[]> {
    const result = await query<SignalRow>({
      text: 'SELECT id, type, mint, timestamp, slot, data FROM signals WHERE mint = $1 ORDER BY timestamp ASC',
      values: [mint],
    });

    return result.rows.map(reconstructSignal);
  }

  async findByType(type: SignalType): Promise<readonly Signal[]> {
    const result = await query<SignalRow>({
      text: 'SELECT id, type, mint, timestamp, slot, data FROM signals WHERE type = $1 ORDER BY timestamp ASC',
      values: [type],
    });

    return result.rows.map(reconstructSignal);
  }

  async findRecentLaunchesByCreator(
    creator: WalletAddress,
    sinceTimestamp: number,
  ): Promise<readonly LaunchSignal[]> {
    const since = new Date(sinceTimestamp).toISOString();
    const result = await query<SignalRow>({
      text: `SELECT id, type, mint, timestamp, slot, data FROM signals
       WHERE type = 'LAUNCH'
         AND data->>'creator' = $1
         AND timestamp >= $2
       ORDER BY timestamp ASC`,
      values: [creator, since],
    });

    return result.rows
      .map(reconstructSignal)
      .filter((signal): signal is LaunchSignal => signal.type === 'LAUNCH');
  }
}
