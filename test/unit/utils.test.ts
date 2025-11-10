/**
 * Unit Tests for Utility Functions
 */

import * as admin from 'firebase-admin';
import {
  calculateTokenMetrics,
  filterRecentRequests,
  validateStoragePath,
  sanitizeUserQuota,
  sanitizeGlobalConfig,
} from '../../src/utils';

// Mock Firestore Timestamp
const mockTimestamp = (millis: number) => ({
  toMillis: () => millis,
  toDate: () => new Date(millis),
  seconds: Math.floor(millis / 1000),
  nanoseconds: (millis % 1000) * 1000000,
});

describe('calculateTokenMetrics', () => {
  it('should calculate correct costs for GPT-4o Vision', () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    };

    const metrics = calculateTokenMetrics(usage);

    expect(metrics.input_tokens).toBe(1000);
    expect(metrics.output_tokens).toBe(500);
    expect(metrics.total_tokens).toBe(1500);
    expect(metrics.input_cost_usd).toBe(0.005); // 1000 / 1M * $5
    expect(metrics.output_cost_usd).toBe(0.01); // 500 / 1M * $20
    expect(metrics.total_cost_usd).toBe(0.015);
  });

  it('should handle zero tokens', () => {
    const usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const metrics = calculateTokenMetrics(usage);

    expect(metrics.total_cost_usd).toBe(0);
  });

  it('should round costs to 6 decimal places', () => {
    const usage = {
      prompt_tokens: 123,
      completion_tokens: 456,
      total_tokens: 579,
    };

    const metrics = calculateTokenMetrics(usage);

    expect(metrics.input_cost_usd.toString()).toMatch(/^\d+\.\d{1,6}$/);
    expect(metrics.output_cost_usd.toString()).toMatch(/^\d+\.\d{1,6}$/);
  });
});

describe('filterRecentRequests', () => {
  it('should filter requests within the time window', () => {
    const now = Date.now();
    const recentRequests = [
      mockTimestamp(now - 30000), // 30 seconds ago - should keep
      mockTimestamp(now - 70000), // 70 seconds ago - should remove
      mockTimestamp(now - 10000), // 10 seconds ago - should keep
      mockTimestamp(now - 90000), // 90 seconds ago - should remove
    ] as admin.firestore.Timestamp[];

    const filtered = filterRecentRequests(recentRequests, 60000);

    expect(filtered.length).toBe(2);
  });

  it('should return empty array for empty input', () => {
    const filtered = filterRecentRequests([]);
    expect(filtered).toEqual([]);
  });

  it('should keep all requests if all are recent', () => {
    const now = Date.now();
    const recentRequests = [
      mockTimestamp(now - 10000),
      mockTimestamp(now - 20000),
      mockTimestamp(now - 30000),
    ] as admin.firestore.Timestamp[];

    const filtered = filterRecentRequests(recentRequests, 60000);

    expect(filtered.length).toBe(3);
  });

  it('should remove all requests if all are old', () => {
    const now = Date.now();
    const recentRequests = [
      mockTimestamp(now - 70000),
      mockTimestamp(now - 80000),
      mockTimestamp(now - 90000),
    ] as admin.firestore.Timestamp[];

    const filtered = filterRecentRequests(recentRequests, 60000);

    expect(filtered.length).toBe(0);
  });
});

describe('validateStoragePath', () => {
  it('should validate correct path format', () => {
    const result = validateStoragePath('users/user123/images/scan456.jpg');

    expect(result.valid).toBe(true);
    expect(result.userId).toBe('user123');
    expect(result.filename).toBe('scan456.jpg');
    expect(result.scanId).toBe('scan456');
  });

  it('should reject invalid path format', () => {
    const result = validateStoragePath('invalid/path/format.jpg');

    expect(result.valid).toBe(false);
    expect(result.userId).toBeUndefined();
  });

  it('should reject non-images folder', () => {
    const result = validateStoragePath('users/user123/documents/file.jpg');

    expect(result.valid).toBe(false);
  });

  it('should handle .png files', () => {
    const result = validateStoragePath('users/user123/images/scan789.png');

    expect(result.valid).toBe(true);
    expect(result.scanId).toBe('scan789');
  });

  it('should reject path with missing parts', () => {
    const result = validateStoragePath('users/user123');

    expect(result.valid).toBe(false);
  });
});

describe('sanitizeUserQuota', () => {
  it('should return default values for empty quota', () => {
    const sanitized = sanitizeUserQuota({});

    expect(sanitized.daily_cost_limit_usd).toBe(10.0);
    expect(sanitized.daily_request_limit).toBe(2000);
    expect(sanitized.enabled).toBe(true);
    expect(sanitized.today_usage.request_count).toBe(0);
  });

  it('should preserve existing values', () => {
    const quota = {
      daily_cost_limit_usd: 50.0,
      daily_request_limit: 5000,
      enabled: false,
      today_usage: {
        request_count: 100,
        total_tokens: 50000,
        cost_usd: 2.5,
      },
    };

    const sanitized = sanitizeUserQuota(quota);

    expect(sanitized.daily_cost_limit_usd).toBe(50.0);
    expect(sanitized.daily_request_limit).toBe(5000);
    expect(sanitized.enabled).toBe(false);
    expect(sanitized.today_usage.request_count).toBe(100);
  });

  it('should handle null values', () => {
    const sanitized = sanitizeUserQuota(null);

    expect(sanitized.daily_cost_limit_usd).toBe(10.0);
    expect(sanitized.enabled).toBe(true);
  });

  it('should default enabled to true when undefined', () => {
    const quota = { enabled: undefined };
    const sanitized = sanitizeUserQuota(quota);

    expect(sanitized.enabled).toBe(true);
  });

  it('should respect enabled: false', () => {
    const quota = { enabled: false };
    const sanitized = sanitizeUserQuota(quota);

    expect(sanitized.enabled).toBe(false);
  });
});

describe('sanitizeGlobalConfig', () => {
  it('should return default values for empty config', () => {
    const sanitized = sanitizeGlobalConfig({});

    expect(sanitized.global_limits.daily_cost_limit_usd).toBe(100.0);
    expect(sanitized.global_limits.daily_request_limit).toBe(20000);
    expect(sanitized.global_limits.circuit_breaker_enabled).toBe(false);
    expect(sanitized.today_stats.total_requests).toBe(0);
  });

  it('should preserve existing values', () => {
    const config = {
      global_limits: {
        daily_cost_limit_usd: 200.0,
        daily_request_limit: 50000,
        circuit_breaker_enabled: true,
        circuit_breaker_reason: 'Test maintenance',
      },
      today_stats: {
        total_requests: 1000,
        total_tokens: 500000,
        total_cost_usd: 25.0,
        failed_requests: 5,
        quota_exceeded_count: 3,
      },
    };

    const sanitized = sanitizeGlobalConfig(config);

    expect(sanitized.global_limits.daily_cost_limit_usd).toBe(200.0);
    expect(sanitized.global_limits.circuit_breaker_enabled).toBe(true);
    expect(sanitized.today_stats.total_requests).toBe(1000);
  });

  it('should handle null values', () => {
    const sanitized = sanitizeGlobalConfig(null);

    expect(sanitized.global_limits.daily_cost_limit_usd).toBe(100.0);
    expect(sanitized.today_stats.total_cost_usd).toBe(0);
  });
});
