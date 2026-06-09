/**
 * WebSocket Manager
 *
 * Wraps the ws module with automatic reconnection and exponential backoff.
 * Re-subscribes to pump.fun logs after each reconnect.
 *
 * App layer — replaces raw ws usage in main.ts.
 */

import WebSocket from 'ws';
import { createLogger } from '../telemetry/logging/logger.js';
import {
  DEFAULT_WS_MAX_RETRIES,
  DEFAULT_WS_BASE_DELAY_MS,
  DEFAULT_WS_MAX_DELAY_MS,
  DEFAULT_WS_CONNECT_TIMEOUT_MS,
} from '../core/constants/defaults.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('app:wsManager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsManagerConfig {
  /** Primary WebSocket URL. */
  readonly url: string;
  /** Fallback WebSocket URLs (rotated on 429). */
  readonly fallbackUrls?: readonly string[];
  /** Called when a message is received. */
  readonly onMessage: (data: Buffer) => void;
  /** Called when the connection is opened (including reconnects). */
  readonly onOpen?: () => void;
  /** Called when all retries are exhausted. */
  readonly onFatal?: () => void;
}

// ---------------------------------------------------------------------------
// WsManager
// ---------------------------------------------------------------------------

export class WsManager {
  private readonly urls: readonly string[];
  private readonly onMessage: (data: Buffer) => void;
  private readonly onOpen?: () => void;
  private readonly onFatal?: () => void;

  private ws: WebSocket | null = null;
  private retryCount = 0;
  private urlIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(config: WsManagerConfig) {
    this.urls = [config.url, ...(config.fallbackUrls ?? [])];
    this.onMessage = config.onMessage;
    this.onOpen = config.onOpen;
    this.onFatal = config.onFatal;
  }

  private get currentUrl(): string {
    return this.urls[this.urlIndex]!;
  }

  private rotateUrl(): void {
    if (this.urls.length > 1) {
      this.urlIndex = (this.urlIndex + 1) % this.urls.length;
      logger.info('Rotated WebSocket URL', {
        index: this.urlIndex,
        url: this.currentUrl.replace(/api-key=[^&]+/, 'api-key=***'),
      });
    }
  }

  /**
   * Initiate the WebSocket connection.
   * Returns a promise that resolves once the initial connection is open.
   * Retries on 429 rate limit with exponential backoff.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.intentionalClose = false;
      this.retryCount = 0;

      const maxRetries = 5;
      const baseDelay = 5000; // 5 seconds

      const attemptConnect = (): void => {
        const onOpenHandler = (): void => {
          logger.info('WebSocket connected', {
            url: this.currentUrl.replace(/api-key=[^&]+/, 'api-key=***'),
          });
          cleanupTimeout();
          this.retryCount = 0;
          this.onOpen?.();
          resolve();
        };

        const onErrorHandler = (err: Error): void => {
          logger.error('WebSocket connection error', { error: err.message });
          cleanupTimeout();
          
          // Check if it's a 429 rate limit
          if (err.message.includes('429') && this.retryCount < maxRetries) {
            this.retryCount++;
            // Rotate to next URL on 429
            this.rotateUrl();
            const delay = baseDelay * Math.pow(2, this.retryCount - 1);
            logger.warn('WebSocket 429 rate limited, retrying with rotated URL', {
              attempt: this.retryCount,
              maxRetries,
              delayMs: delay,
            });
            setTimeout(attemptConnect, delay);
            return;
          }
          
          reject(err);
        };

        this.ws = new WebSocket(this.currentUrl);

        const timeoutId = setTimeout(() => {
          cleanupTimeout();
          reject(new Error('WebSocket connect timeout'));
        }, DEFAULT_WS_CONNECT_TIMEOUT_MS);

        const cleanupTimeout = (): void => {
          clearTimeout(timeoutId);
          this.ws?.removeListener('error', onErrorHandler);
        };

        this.ws.once('open', onOpenHandler);
        this.ws.once('error', onErrorHandler);
      };

      attemptConnect();

      this.setupPersistentListeners();
    });
  }

  /**
   * Gracefully close the WebSocket (no reconnect).
   */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send data through the WebSocket (if connected).
   */
  send(data: string): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      logger.warn('Cannot send — WebSocket not open');
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private setupPersistentListeners(): void {
    if (this.ws === null) return;

    this.ws.on('message', (data: Buffer) => {
      this.onMessage(data);
    });

    this.ws.on('close', () => {
      logger.warn('WebSocket disconnected');
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('WebSocket error', { error: err.message });
    });
  }

  private scheduleReconnect(): void {
    this.retryCount++;

    if (this.retryCount > DEFAULT_WS_MAX_RETRIES) {
      logger.fatal('WebSocket max retries exhausted, giving up', {
        maxRetries: DEFAULT_WS_MAX_RETRIES,
      });
      this.onFatal?.();
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s, 60s, ...
    const delay = Math.min(DEFAULT_WS_BASE_DELAY_MS * Math.pow(2, this.retryCount - 1), DEFAULT_WS_MAX_DELAY_MS);

    logger.info('Scheduling WebSocket reconnect', {
      attempt: this.retryCount,
      maxRetries: DEFAULT_WS_MAX_RETRIES,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doReconnect();
    }, delay);
  }

  private doReconnect(): void {
    logger.info('Attempting WebSocket reconnect', { attempt: this.retryCount });

    this.ws = new WebSocket(this.currentUrl);

    const timeoutId = setTimeout(() => {
      logger.warn('Reconnect timed out', { attempt: this.retryCount });
      this.ws?.close();
    }, DEFAULT_WS_CONNECT_TIMEOUT_MS);

    this.ws.once('open', () => {
      clearTimeout(timeoutId);
      logger.info('WebSocket reconnected', { attempt: this.retryCount });
      this.retryCount = 0;
      this.setupPersistentListeners();
      this.onOpen?.();
    });

    this.ws.once('error', (err: Error) => {
      clearTimeout(timeoutId);
      logger.error('Reconnect failed', {
        attempt: this.retryCount,
        error: err.message,
      });
      // The 'close' event will fire after 'error', triggering scheduleReconnect
    });
  }
}
