/**
 * Global TPM (Tokens Per Minute) Rate Limiter
 * Implements a distributed token bucket algorithm using Firestore
 */

import * as admin from "firebase-admin";

// Rate limit configuration
export const RATE_LIMIT_CONFIG = {
  maxTokensPerMinute: 180000, // 90% of OpenAI's 200k TPM limit (conservative)
  bucketRefillRate: 3000, // Refill 3000 tokens per second
  maxBucketSize: 180000, // Maximum bucket capacity
};

export interface TokenBucket {
  tokens: number;
  lastRefill: number; // milliseconds since epoch
  currentMinuteUsage: number; // tokens used in current minute
  lastMinuteReset: number; // milliseconds since epoch
}

/**
 * Acquire tokens from the global rate limiter
 * @param requiredTokens Number of tokens needed for the operation
 * @returns true if tokens were acquired, false if rate limit exceeded
 */
export async function acquireTokens(requiredTokens: number): Promise<boolean> {
  const bucketRef = admin.firestore().collection("system").doc("openai_rate_limiter");

  try {
    const result = await admin.firestore().runTransaction(async (transaction) => {
      const bucketDoc = await transaction.get(bucketRef);
      const now = Date.now();

      // Initialize bucket if it doesn't exist
      const bucket: TokenBucket = bucketDoc.exists
        ? (bucketDoc.data() as TokenBucket)
        : {
          tokens: RATE_LIMIT_CONFIG.maxBucketSize,
          lastRefill: now,
          currentMinuteUsage: 0,
          lastMinuteReset: now,
        };

      // Reset minute counter if a minute has passed
      const timeSinceMinuteReset = now - bucket.lastMinuteReset;
      if (timeSinceMinuteReset >= 60000) {
        bucket.currentMinuteUsage = 0;
        bucket.lastMinuteReset = now;
      }

      // Refill tokens based on time passed
      const timePassed = (now - bucket.lastRefill) / 1000; // seconds
      const tokensToAdd = timePassed * RATE_LIMIT_CONFIG.bucketRefillRate;
      bucket.tokens = Math.min(bucket.tokens + tokensToAdd, RATE_LIMIT_CONFIG.maxBucketSize);
      bucket.lastRefill = now;

      // Check if we have enough tokens
      if (bucket.tokens >= requiredTokens) {
        bucket.tokens -= requiredTokens;
        bucket.currentMinuteUsage += requiredTokens;

        transaction.set(bucketRef, bucket);

        console.log(
          `✅ [RateLimiter] Acquired ${requiredTokens} tokens. ` +
            `Remaining: ${Math.floor(bucket.tokens)} | ` +
            `Minute usage: ${bucket.currentMinuteUsage}/${RATE_LIMIT_CONFIG.maxTokensPerMinute}`
        );

        return true;
      }

      // Not enough tokens
      const waitTime = Math.ceil(((requiredTokens - bucket.tokens) / RATE_LIMIT_CONFIG.bucketRefillRate) * 1000);

      console.log(
        "⏸️ [RateLimiter] Insufficient tokens. " +
          `Need: ${requiredTokens}, Available: ${Math.floor(bucket.tokens)}. ` +
          `Wait time: ~${Math.ceil(waitTime / 1000)}s`
      );

      return false;
    });

    return result;
  } catch (error) {
    console.error("❌ [RateLimiter] Error acquiring tokens:", error);
    // In case of error, fail open (allow request) to avoid blocking all requests
    return true;
  }
}

/**
 * Get current rate limiter status (readonly)
 */
export async function getRateLimiterStatus(): Promise<{
  availableTokens: number;
  minuteUsage: number;
  usagePercent: number;
  estimatedWaitSeconds: number;
}> {
  const bucketRef = admin.firestore().collection("system").doc("openai_rate_limiter");

  try {
    const bucketDoc = await bucketRef.get();

    if (!bucketDoc.exists) {
      return {
        availableTokens: RATE_LIMIT_CONFIG.maxBucketSize,
        minuteUsage: 0,
        usagePercent: 0,
        estimatedWaitSeconds: 0,
      };
    }

    const bucket = bucketDoc.data() as TokenBucket;
    const now = Date.now();

    // Calculate refilled tokens
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = timePassed * RATE_LIMIT_CONFIG.bucketRefillRate;
    const currentTokens = Math.min(bucket.tokens + tokensToAdd, RATE_LIMIT_CONFIG.maxBucketSize);

    // Check if minute has reset
    const timeSinceMinuteReset = now - bucket.lastMinuteReset;
    const currentMinuteUsage = timeSinceMinuteReset >= 60000 ? 0 : bucket.currentMinuteUsage;

    const usagePercent = (currentMinuteUsage / RATE_LIMIT_CONFIG.maxTokensPerMinute) * 100;
    const estimatedWaitSeconds =
      currentTokens < 2000 ? Math.ceil((2000 - currentTokens) / RATE_LIMIT_CONFIG.bucketRefillRate) : 0;

    return {
      availableTokens: Math.floor(currentTokens),
      minuteUsage: currentMinuteUsage,
      usagePercent: parseFloat(usagePercent.toFixed(2)),
      estimatedWaitSeconds,
    };
  } catch (error) {
    console.error("❌ [RateLimiter] Error getting status:", error);
    return {
      availableTokens: RATE_LIMIT_CONFIG.maxBucketSize,
      minuteUsage: 0,
      usagePercent: 0,
      estimatedWaitSeconds: 0,
    };
  }
}

/**
 * Estimate token usage for an image
 * @param imageSize Image file size in bytes
 * @returns Estimated token count
 */
export function estimateTokenUsage(imageSize: number): number {
  const basePromptTokens = 500; // Base prompt tokens
  const imageTokens = Math.ceil(imageSize / 512); // Rough estimate: 1 token per 512 bytes
  const maxCompletionTokens = 600; // max_tokens setting in API call

  return basePromptTokens + imageTokens + maxCompletionTokens;
}
