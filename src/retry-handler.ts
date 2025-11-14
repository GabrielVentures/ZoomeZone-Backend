/**
 * Intelligent Retry Handler for OpenAI API calls
 * Implements exponential backoff with jitter
 */

export interface RetryConfig {
  maxRetries: number;
  initialBackoff: number; // milliseconds
  maxBackoff: number; // milliseconds
  backoffMultiplier: number;
  retryableStatuses: number[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialBackoff: 1000, // 1 second
  maxBackoff: 30000, // 30 seconds
  backoffMultiplier: 2, // exponential growth
  retryableStatuses: [
    429, // Rate limit
    500, // Internal server error
    502, // Bad gateway
    503, // Service unavailable
    504, // Gateway timeout
  ],
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate backoff time with exponential backoff and jitter
 * @param attempt Current attempt number (0-indexed)
 * @param config Retry configuration
 * @returns Backoff time in milliseconds
 */
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialBackoff = config.initialBackoff * Math.pow(config.backoffMultiplier, attempt);
  const cappedBackoff = Math.min(exponentialBackoff, config.maxBackoff);

  // Add jitter (±25% randomness) to prevent thundering herd
  const jitter = cappedBackoff * 0.25 * (Math.random() * 2 - 1);
  return Math.floor(cappedBackoff + jitter);
}

/**
 * Retry a function with exponential backoff
 * @param fn Function to retry
 * @param config Retry configuration
 * @param context Context string for logging
 * @returns Result from successful function call
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = "Operation"
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // Execute the function
      const result = await fn();

      if (attempt > 0) {
        console.log(`✅ [Retry] ${context} succeeded on attempt ${attempt + 1}`);
      }

      return result;
    } catch (error: any) {
      lastError = error;

      // Check if error is retryable
      const isRetryable = config.retryableStatuses.includes(error?.status || error?.statusCode);
      const isLastAttempt = attempt === config.maxRetries;

      if (!isRetryable) {
        console.error(`❌ [Retry] ${context} failed with non-retryable error (status: ${error?.status})`);
        throw error;
      }

      if (isLastAttempt) {
        console.error(
          `❌ [Retry] ${context} failed after ${config.maxRetries + 1} attempts. Last error:`,
          error?.message || error
        );
        throw error;
      }

      // Calculate backoff time
      let backoffTime: number;

      // If there's a retry-after header, use it
      if (error?.headers?.["retry-after"]) {
        const retryAfter = parseInt(error.headers["retry-after"]);
        backoffTime = isNaN(retryAfter) ? calculateBackoff(attempt, config) : retryAfter * 1000;
      } else if (error?.response?.headers?.["retry-after"]) {
        const retryAfter = parseInt(error.response.headers["retry-after"]);
        backoffTime = isNaN(retryAfter) ? calculateBackoff(attempt, config) : retryAfter * 1000;
      } else {
        backoffTime = calculateBackoff(attempt, config);
      }

      console.log(
        `⏳ [Retry] ${context} failed (attempt ${attempt + 1}/${config.maxRetries + 1}). ` +
          `Status: ${error?.status}. Retrying in ${Math.ceil(backoffTime / 1000)}s...`
      );

      // Wait before retrying
      await sleep(backoffTime);
    }
  }

  // This should never be reached, but TypeScript requires it
  throw lastError;
}

/**
 * Retry a function with specific OpenAI error handling
 * Specialized version for OpenAI API calls
 */
export async function retryOpenAICall<T>(
  fn: () => Promise<T>,
  scanId: string,
  _maxRetries: number = 3 // Prefix with _ to indicate intentionally unused
): Promise<T> {
  return retryWithBackoff(fn, DEFAULT_RETRY_CONFIG, `OpenAI call for scan ${scanId}`);
}

/**
 * Check if an error is a rate limit error
 */
export function isRateLimitError(error: any): boolean {
  return error?.status === 429 || error?.statusCode === 429 || error?.message?.includes("rate limit");
}

/**
 * Extract retry-after time from error
 * @param error Error object
 * @returns Retry-after time in seconds, or null if not found
 */
export function extractRetryAfter(error: any): number | null {
  // Check direct headers
  if (error?.headers?.["retry-after"]) {
    const retryAfter = parseInt(error.headers["retry-after"]);
    return isNaN(retryAfter) ? null : retryAfter;
  }

  // Check response headers
  if (error?.response?.headers?.["retry-after"]) {
    const retryAfter = parseInt(error.response.headers["retry-after"]);
    return isNaN(retryAfter) ? null : retryAfter;
  }

  // Check error message for retry-after hint
  const match = error?.message?.match(/try again in (\d+)ms/i);
  if (match) {
    return parseInt(match[1]) / 1000;
  }

  return null;
}
