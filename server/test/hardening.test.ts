import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { settings } from '../src/config';
import { api } from './helpers';

describe('production hardening', () => {
  it('rate-limits repeated login attempts per user', async () => {
    const previous = settings.loginAttemptsPerMinute;
    settings.loginAttemptsPerMinute = 3;
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await api().post('/api/auth/login').send({ user_id: 'rate-limit-probe', passcode: '0000' });
        statuses.push(response.status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
      const other = await api().post('/api/auth/login').send({ user_id: 'demo-customer-01', passcode: '2468' });
      assert.equal(other.status, 200, 'other users are not locked out');
    } finally {
      settings.loginAttemptsPerMinute = previous;
    }
  });

  it('sends security headers', async () => {
    const response = await api().get('/api/health');
    assert.match(response.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-powered-by'], undefined);
  });
});
