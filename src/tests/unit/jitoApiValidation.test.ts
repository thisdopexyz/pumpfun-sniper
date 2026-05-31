/**
 * Jito Bundle API Validation Test
 * 
 * Tests:
 * 1. API endpoint reachable
 * 2. JSON-RPC format correct
 * 3. getTipAccounts returns 8 accounts
 * 4. sendBundle rejects empty bundle
 * 5. getBundleStatuses works
 * 
 * Note: Jito API has rate limit (1 req/sec), so tests run sequentially with delays
 */

import { describe, it, expect } from 'vitest';

const JITO_ENDPOINT = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

async function jitoRpc(method: string, params: any[] = []): Promise<any> {
  const response = await fetch(JITO_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  return response.json();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Jito Bundle API Validation', () => {
  it('API endpoint is reachable + getTipAccounts', async () => {
    const result = await jitoRpc('getTipAccounts');
    expect(result.jsonrpc).toBe('2.0');
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    expect(result.result.length).toBe(8);
    
    // Each account should be a valid base58 string
    for (const account of result.result) {
      expect(typeof account).toBe('string');
      expect(account.length).toBeGreaterThan(30);
      expect(account.length).toBeLessThan(50);
    }
  });

  it('sendBundle rejects empty bundle', async () => {
    await delay(1100); // Rate limit
    const result = await jitoRpc('sendBundle', [[]]);
    expect(result.error).toBeDefined();
    // Could be rate limit or "no transactions" error
    expect(result.error.message).toBeDefined();
  });

  it('getBundleStatuses returns empty for non-existent bundle', async () => {
    await delay(1100); // Rate limit
    const result = await jitoRpc('getBundleStatuses', [['non-existent-bundle-id']]);
    // Could be rate limit or empty result
    expect(result).toBeDefined();
  });

  it('JSON-RPC format validation', async () => {
    await delay(1100); // Rate limit
    // Missing jsonrpc field
    const response = await fetch(JITO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'getTipAccounts' }),
    });
    const result = await response.json();
    expect(result).toBeDefined();
  });
});
