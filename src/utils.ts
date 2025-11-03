/**
 * Utility functions for ShelfTagSnap Cloud Functions
 */

import * as admin from "firebase-admin";
import { AIProcessingErrorCode, TokenMetrics, OpenAIUsage } from "./types";

// ==================== Admin Verification ====================

/**
 * Check if a user is an admin
 */
export async function isAdmin(userId: string): Promise<boolean> {
  try {
    const userDoc = await admin.firestore()
      .collection("users")
      .doc(userId)
      .get();

    if (!userDoc.exists) {
      return false;
    }

    const userData = userDoc.data();
    return userData?.role === "admin";
  } catch (error) {
    console.error(`Error checking admin status for user ${userId}:`, error);
    return false;
  }
}

// ==================== Token Cost Calculation ====================

/**
 * Calculate token metrics and costs for GPT-4o Vision
 * Pricing: Input $5/1M tokens, Output $20/1M tokens
 */
export function calculateTokenMetrics(usage: OpenAIUsage): TokenMetrics {
  const inputCost = (usage.prompt_tokens / 1000000) * 5.0;
  const outputCost = (usage.completion_tokens / 1000000) * 20.0;
  const totalCost = inputCost + outputCost;

  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_cost_usd: parseFloat(inputCost.toFixed(6)),
    output_cost_usd: parseFloat(outputCost.toFixed(6)),
    total_cost_usd: parseFloat(totalCost.toFixed(6)),
  };
}

// ==================== Quota Error Handling ====================

/**
 * Mark a scan record with quota error
 */
export async function markAsQuotaError(
  scanId: string,
  errorCode: AIProcessingErrorCode,
  errorMessage: string
): Promise<void> {
  try {
    // Update scan record
    await admin.firestore()
      .collection("scan_records")
      .doc(scanId)
      .update({
        ai_processed: false,
        ai_processing_error: errorCode,
        ai_processing_error_message: errorMessage,
        ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Log to quota_logs collection
    await admin.firestore().collection("quota_logs").add({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      event_type: "quota_error",
      scan_id: scanId,
      error_code: errorCode,
      error_message: errorMessage,
    });

    console.log(`[QuotaError] ${scanId}: ${errorCode} - ${errorMessage}`);
  } catch (error) {
    console.error(`Failed to mark quota error for ${scanId}:`, error);
  }
}

// ==================== Rate Limiting ====================

/**
 * Filter recent requests within the last minute
 */
export function filterRecentRequests(
  recentRequests: admin.firestore.Timestamp[],
  windowMs: number = 60 * 1000 // 1 minute
): number[] {
  const now = Date.now();
  const cutoff = now - windowMs;

  return recentRequests
    .map((ts) => ts.toMillis ? ts.toMillis() : (ts as any))
    .filter((ts) => ts > cutoff);
}

// ==================== Circuit Breaker ====================

/**
 * Trigger global circuit breaker
 */
export async function triggerCircuitBreaker(reason: string): Promise<void> {
  try {
    await admin.firestore()
      .collection("settings")
      .doc("ai_global_config")
      .update({
        "global_limits.circuit_breaker_enabled": true,
        "global_limits.circuit_breaker_reason": reason,
      });

    console.log(`🔴 Circuit breaker triggered: ${reason}`);

    // Log to quota_logs
    await admin.firestore().collection("quota_logs").add({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      event_type: "circuit_breaker",
      user_id: "system",
      details: { reason },
    });
  } catch (error) {
    console.error("Failed to trigger circuit breaker:", error);
  }
}

// ==================== Validation ====================

/**
 * Validate path format: users/{userId}/images/{filename}
 */
export function validateStoragePath(filePath: string): {
  valid: boolean;
  userId?: string;
  filename?: string;
  scanId?: string;
} {
  const pathParts = filePath.split("/");

  if (
    pathParts.length < 4 ||
    pathParts[0] !== "users" ||
    pathParts[2] !== "images"
  ) {
    return { valid: false };
  }

  const userId = pathParts[1];
  const filename = pathParts[3];
  const scanId = filename.replace(".jpg", "").replace(".jpeg", "").replace(".png", "");

  return { valid: true, userId, filename, scanId };
}

// ==================== Data Sanitization ====================

/**
 * Sanitize user quota data for response
 */
export function sanitizeUserQuota(quota: any) {
  return {
    daily_cost_limit_usd: quota?.daily_cost_limit_usd || 10.0,
    daily_request_limit: quota?.daily_request_limit || 2000,
    enabled: quota?.enabled !== false,
    today_usage: {
      request_count: quota?.today_usage?.request_count || 0,
      total_tokens: quota?.today_usage?.total_tokens || 0,
      cost_usd: quota?.today_usage?.cost_usd || 0,
    },
    rate_limit: {
      per_minute: quota?.rate_limit?.per_minute || 10,
      per_hour: quota?.rate_limit?.per_hour || 100,
      recent_requests: quota?.rate_limit?.recent_requests || [],
    },
  };
}

/**
 * Sanitize global config data for response
 */
export function sanitizeGlobalConfig(config: any) {
  return {
    global_limits: {
      daily_cost_limit_usd: config?.global_limits?.daily_cost_limit_usd || 100.0,
      daily_request_limit: config?.global_limits?.daily_request_limit || 20000,
      circuit_breaker_enabled: config?.global_limits?.circuit_breaker_enabled || false,
      circuit_breaker_reason: config?.global_limits?.circuit_breaker_reason || null,
    },
    today_stats: {
      total_requests: config?.today_stats?.total_requests || 0,
      total_tokens: config?.today_stats?.total_tokens || 0,
      total_cost_usd: config?.today_stats?.total_cost_usd || 0,
      failed_requests: config?.today_stats?.failed_requests || 0,
      quota_exceeded_count: config?.today_stats?.quota_exceeded_count || 0,
    },
  };
}

// ==================== Logging Helpers ====================

/**
 * Log function execution time
 */
export function logExecutionTime(functionName: string, startTime: number): void {
  const duration = Date.now() - startTime;
  console.log(`⏱️  [${functionName}] Execution time: ${duration}ms`);
}

/**
 * Log quota check result
 */
export function logQuotaCheck(
  userId: string,
  scanId: string,
  passed: boolean,
  reason?: string
): void {
  if (passed) {
    console.log(`✅ [QuotaCheck] User ${userId}, Scan ${scanId}: PASSED`);
  } else {
    console.log(`❌ [QuotaCheck] User ${userId}, Scan ${scanId}: FAILED - ${reason}`);
  }
}
