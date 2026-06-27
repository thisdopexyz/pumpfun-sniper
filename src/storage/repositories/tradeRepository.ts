import { query } from '../postgres/postgresClient.js';
import type { IRepository } from '../../core/interfaces/storage.js';
import type { TradeRecord, TradeId } from '../../core/types/trade.js';

// ---------------------------------------------------------------------------
// Row shapes coming back from pg driver (all values are strings / null)
// ---------------------------------------------------------------------------

interface TradeRow {
  readonly id: string;
  readonly mint: string;
  readonly side: string;
  readonly status: string;
  readonly amount_sol: string;
  readonly amount_tokens: string;
  readonly signature: string | null;
  readonly slot: string | null;
  readonly submitted_at: string;
  readonly confirmed_at: string | null;
  readonly failure_reason: string | null;
  readonly exit_reason: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTradeRecord(row: TradeRow): TradeRecord {
  return {
    id: row.id as TradeId,
    mint: row.mint,
    side: row.side as TradeRecord['side'],
    status: row.status as TradeRecord['status'],
    amountSol: BigInt(row.amount_sol),
    amountTokens: BigInt(row.amount_tokens),
    signature: row.signature,
    slot: row.slot !== null ? Number(row.slot) : null,
    submittedAt: new Date(row.submitted_at).getTime(),
    confirmedAt: row.confirmed_at !== null ? new Date(row.confirmed_at).getTime() : null,
    failureReason: row.failure_reason,
    exitReason: row.exit_reason ?? null,
  };
}


// TradeRepository
// ---------------------------------------------------------------------------

export class TradeRepository implements IRepository<TradeRecord, TradeId> {
  async findById(id: TradeId): Promise<TradeRecord | null> {
    const result = await query<TradeRow>({
      text: 'SELECT * FROM trades WHERE id = $1',
      values: [id],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row === undefined) return null;

    return toTradeRecord(row);
  }

  /**
   * MED-POSITION-1 fix: source-of-truth check for in-flight positions.
   * Returns count of CONFIRMED BUY trades that have NO matching SELL row
   * (i.e., position still open on-chain). DB is authoritative — in-memory
   * `positionRegistry` is just a cache. If cache desyncs (e.g. after a
   * restart, missed transition, or partial state), this query catches it
   * and prevents the strategy from opening a 2nd concurrent position.
   *
   * Recent window (24h) — older unmatched BUYs are reconciled at startup
   * by `positionRecovery`, so anything older is already closed.
   */
  async countOpenPositions(windowMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const cutoffMs = Date.now() - windowMs;
    const result = await query<{ count: string }>({
      text: `
        SELECT COUNT(*)::text AS count
        FROM trades t1
        WHERE t1.side = 'BUY'
          AND t1.status = 'CONFIRMED'
          AND to_timestamp(t1.submitted_at::double precision / 1000) > to_timestamp($1::double precision / 1000)
          AND NOT EXISTS (
            SELECT 1 FROM trades t2
            WHERE t2.side = 'SELL'
              AND t2.status = 'CONFIRMED'
              AND (t2.id = 'sell-' || t1.id OR t2.id LIKE 'sell-' || t1.id || '-%')
          )
      `,
      values: [cutoffMs],
    });
    const row = result.rows[0];
    return row ? parseInt(row.count, 10) : 0;
  }

  async save(record: TradeRecord): Promise<void> {
    await query({
      text: `INSERT INTO trades (
        id, mint, side, status, amount_sol, amount_tokens,
        signature, slot, submitted_at, confirmed_at, failure_reason, exit_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
        to_timestamp($9::double precision / 1000),
        CASE WHEN $10::double precision IS NOT NULL
             THEN to_timestamp($10::double precision / 1000)
             ELSE NULL END,
        $11, $12
      )
      ON CONFLICT (id) DO UPDATE SET
        mint           = EXCLUDED.mint,
        side           = EXCLUDED.side,
        status         = EXCLUDED.status,
        amount_sol     = EXCLUDED.amount_sol,
        amount_tokens  = EXCLUDED.amount_tokens,
        signature      = EXCLUDED.signature,
        slot           = EXCLUDED.slot,
        submitted_at   = EXCLUDED.submitted_at,
        confirmed_at   = EXCLUDED.confirmed_at,
        failure_reason = EXCLUDED.failure_reason,
        exit_reason    = EXCLUDED.exit_reason
      WHERE NOT (trades.status = 'CONFIRMED' AND EXCLUDED.status = 'FAILED')`,
      values: [
        record.id,
        record.mint,
        record.side,
        record.status,
        record.amountSol.toString(),
        record.amountTokens.toString(),
        record.signature,
        record.slot,
        record.submittedAt,
        record.confirmedAt,
        record.failureReason,
        record.exitReason ?? null,
      ],
    });
  }

  async delete(id: TradeId): Promise<void> {
    await query({
      text: 'DELETE FROM trades WHERE id = $1',
      values: [id],
    });
  }

  async findByMint(mint: string): Promise<readonly TradeRecord[]> {
    const result = await query<TradeRow>({
      text: 'SELECT * FROM trades WHERE mint = $1 ORDER BY submitted_at ASC',
      values: [mint],
    });

    return result.rows.map(toTradeRecord);
  }

  async findBySignature(signature: string): Promise<TradeRecord | null> {
    const result = await query<TradeRow>({
      text: 'SELECT * FROM trades WHERE signature = $1',
      values: [signature],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row === undefined) return null;

    return toTradeRecord(row);
  }

  /**
   * Find confirmed SELL records for a trade (by ID prefix).
   * Handles unique sell IDs: sell-${tradeId}-${sellSendRunId}
   */
  async findConfirmedSellsByTradeId(tradeId: string): Promise<readonly TradeRecord[]> {
    const result = await query<TradeRow>({
      text: `SELECT * FROM trades WHERE id LIKE $1 AND side = 'SELL' AND status = 'CONFIRMED'`,
      values: [`sell-${tradeId}%`],
    });
    return result.rows.map(toTradeRecord);
  }

  /**
   * Confirmed BUY rows that do not yet have a confirmed SELL row.
   *
   * Used at startup to rehydrate in-memory position monitoring from Postgres.
   * This closes the restart gap where DB has an open buy, but the strategy's
   * monitoredTrades Set is empty, so TIMEOUT/TP/SL never fires.
   */
  async findOpenConfirmedBuys(): Promise<readonly TradeRecord[]> {
    const result = await query<TradeRow>({
      text: `SELECT b.*
        FROM trades b
        WHERE b.side = 'BUY'
          AND b.status = 'CONFIRMED'
          AND b.amount_tokens > 0
          AND b.confirmed_at > NOW() - INTERVAL '24 hours'
          AND (
            -- No matching sell at all (LIKE handles unique sell IDs)
            NOT EXISTS (
              SELECT 1
              FROM trades s
              WHERE s.side = 'SELL'
                AND s.status = 'CONFIRMED'
                AND s.mint = b.mint
                AND s.id LIKE ('sell-' || b.id || '%')
            )
            OR
            -- Matching sells exist but total sold < bought (still holding remainder)
            -- Uses SUM to handle scale-out where multiple partial sells add up
            (
              EXISTS (
                SELECT 1
                FROM trades s
                WHERE s.side = 'SELL'
                  AND s.status = 'CONFIRMED'
                  AND s.mint = b.mint
                  AND s.id LIKE ('sell-' || b.id || '%')
              )
              AND (
                SELECT COALESCE(SUM(s.amount_tokens), 0)
                FROM trades s
                WHERE s.side = 'SELL'
                  AND s.status = 'CONFIRMED'
                  AND s.mint = b.mint
                  AND s.id LIKE ('sell-' || b.id || '%')
              ) < b.amount_tokens
            )
          )
        ORDER BY COALESCE(b.confirmed_at, b.submitted_at) ASC`,
      values: [],
    });

    return result.rows.map(toTradeRecord);
  }
}


