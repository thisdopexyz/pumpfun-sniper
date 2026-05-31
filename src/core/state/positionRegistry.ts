/**
 * Position registry — single source of truth for active positions.
 *
 * Single authoritative state. No duplicated truth (rule.md).
 * Max concurrent = 1 (LOCKED).
 */

import type { Position, PositionId, PositionStatus, PositionTransition } from '../types/position.js';
import type { MintAddress } from '../types/token.js';
import { nowMs } from '../utils/time.js';

/** In-memory position registry */
export class PositionRegistry {
  private readonly positions = new Map<PositionId, Position>();
  private readonly transitions: PositionTransition[] = [];

  /** Get a position by ID */
  get(id: PositionId): Position | undefined {
    return this.positions.get(id);
  }

  /** Get position by mint */
  getByMint(mint: MintAddress): Position | undefined {
    for (const position of this.positions.values()) {
      if (position.mint === mint) {
        return position;
      }
    }
    return undefined;
  }

  /** Register a new position */
  register(position: Position): void {
    this.positions.set(position.id, position);
  }

  /** Transition a position to a new status */
  transition(id: PositionId, to: PositionStatus, reason: string): Position | undefined {
    const existing = this.positions.get(id);
    if (existing === undefined) {
      return undefined;
    }

    const transition: PositionTransition = {
      positionId: id,
      from: existing.status,
      to,
      reason,
      timestamp: nowMs(),
    };
    this.transitions.push(transition);
    // Cap transition history to prevent unbounded memory growth
    if (this.transitions.length > 10_000) {
      this.transitions.splice(0, this.transitions.length - 10_000);
    }

    const updated: Position = {
      ...existing,
      status: to,
      updatedAt: nowMs(),
    };
    this.positions.set(id, updated);

    return updated;
  }

  /** Get all active positions (ENTERING, ENTERED, EXIT_PENDING, SCALE_OUT_PARTIAL) */
  getActive(): ReadonlyArray<Position> {
    const activeStatuses: ReadonlySet<PositionStatus> = new Set([
      'ENTERING',
      'ENTERED',
      'EXIT_PENDING',
      'SCALE_OUT_PARTIAL',
    ]);
    return [...this.positions.values()].filter((p) => activeStatuses.has(p.status));
  }

  /** Count of active positions */
  getActiveCount(): number {
    return this.getActive().length;
  }

  /** Get all positions */
  getAll(): ReadonlyArray<Position> {
    return [...this.positions.values()];
  }

  /** Get transition history for a position */
  getTransitions(id: PositionId): ReadonlyArray<PositionTransition> {
    return this.transitions.filter((t) => t.positionId === id);
  }

  /** Clear all (for testing/replay) */
  clear(): void {
    this.positions.clear();
    this.transitions.length = 0;
  }

  /** Record a completed scale-out tier for a position. */
  recordScaleOutTier(id: PositionId, tierIndex: number): Position | undefined {
    const existing = this.positions.get(id);
    if (existing === undefined) return undefined;

    const prev = existing.scaleOutTiersCompleted ?? [];
    if (prev.includes(tierIndex)) return existing; // already recorded

    const updated: Position = {
      ...existing,
      scaleOutTiersCompleted: [...prev, tierIndex],
      updatedAt: nowMs(),
    };
    this.positions.set(id, updated);
    return updated;
  }
}
