/**
 * AI Image Processing with Quota Control
 * Storage-triggered function for GPT-4o Vision processing with 3-layer security
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import OpenAI from "openai";
import {
  calculateTokenMetrics,
  markAsQuotaError,
  filterRecentRequests,
  triggerCircuitBreaker,
  validateStoragePath,
  logQuotaCheck,
  logExecutionTime,
} from "./utils";
import { acquireTokens, estimateTokenUsage, getRateLimiterStatus } from "./rate-limiter";
import { retryOpenAICall, isRateLimitError } from "./retry-handler";
import { detectBatchUpload, calculateBatchDelay, updateBatchInfo } from "./batch-processor";

// OpenAI client - initialized lazily to avoid errors during deployment
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: functions.config().openai?.key || process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

/**
 * Validate price format and check for common issues
 * @param price - Price string to validate (e.g., "$2.09", "$12.99")
 * @returns Validation result with warning if format is unusual
 */
function validatePriceFormat(price: string | null): { valid: boolean; warning?: string } {
  if (!price) {
    return { valid: true }; // null prices are acceptable
  }

  // Standard format: $X.XX (exactly 2 decimal places)
  const standardFormat = /^\$\d+\.\d{2}$/;
  if (standardFormat.test(price)) {
    return { valid: true };
  }

  // Check for common issues
  if (price.includes("$") && price.includes(".")) {
    const parts = price.split(".");
    if (parts.length === 2 && parts[1].length === 1) {
      return {
        valid: false,
        warning: `Price has only 1 decimal place: ${price} (expected $X.XX format)`,
      };
    }
    if (parts.length === 2 && parts[1].length > 2 && !price.includes("/")) {
      return {
        valid: false,
        warning: `Price has ${parts[1].length} decimal places: ${price} (expected $X.XX format)`,
      };
    }
  }

  // Price range format: $X.XX-$Y.YY
  const rangeFormat = /^\$\d+\.\d{2}-\$\d+\.\d{2}$/;
  if (rangeFormat.test(price)) {
    return { valid: true };
  }

  // If it doesn't match expected formats, warn but don't block
  return {
    valid: false,
    warning: `Unusual price format: ${price} (expected $X.XX format)`,
  };
}

/**
 * Check and trigger budget alerts when usage crosses thresholds
 * @param usagePercent - Current usage percentage
 * @param currentCost - Current total cost in USD
 * @param dailyLimit - Daily limit in USD
 * @param budgetConfig - Current budget configuration
 */
async function checkBudgetAlerts(
  usagePercent: number,
  currentCost: number,
  dailyLimit: number,
  budgetConfig: any
): Promise<void> {
  try {
    const thresholds = budgetConfig.alert_thresholds || {
      warning_percent: 80,
      critical_percent: 90,
    };

    const alertState = budgetConfig.alert_state || {
      warning_triggered: false,
      critical_triggered: false,
      last_reset_date: new Date().toISOString().split("T")[0],
    };

    const today = new Date().toISOString().split("T")[0];

    // Reset alert state if it's a new day
    if (alertState.last_reset_date !== today) {
      alertState.warning_triggered = false;
      alertState.critical_triggered = false;
      alertState.last_reset_date = today;
    }

    let needsUpdate = false;

    // Check critical threshold (90%)
    if (usagePercent >= thresholds.critical_percent && !alertState.critical_triggered) {
      console.log(`🚨 [BudgetAlert] CRITICAL: ${usagePercent.toFixed(1)}% of daily budget used ($${currentCost.toFixed(4)}/$${dailyLimit.toFixed(2)})`);
      alertState.critical_triggered = true;
      needsUpdate = true;

      // Log to activity_logs for admin visibility
      try {
        await admin.firestore().collection("activity_logs").add({
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          action: "BUDGET_ALERT_CRITICAL",
          resource_type: "budget_config",
          resource_id: "budget_config",
          user_id: "system",
          user_email: "system",
          user_role: "system",
          level: "CRITICAL",
          description: `Critical budget alert: ${usagePercent.toFixed(1)}% of daily budget used ($${currentCost.toFixed(4)}/$${dailyLimit.toFixed(2)})`,
          metadata: {
            usage_percent: usagePercent,
            current_cost: currentCost,
            daily_limit: dailyLimit,
            threshold: thresholds.critical_percent,
          },
        });
      } catch (logError) {
        console.error("❌ [BudgetAlert] Failed to log critical alert:", logError);
      }
    }

    // Check warning threshold (80%)
    if (usagePercent >= thresholds.warning_percent && !alertState.warning_triggered && !alertState.critical_triggered) {
      console.log(`⚠️  [BudgetAlert] WARNING: ${usagePercent.toFixed(1)}% of daily budget used ($${currentCost.toFixed(4)}/$${dailyLimit.toFixed(2)})`);
      alertState.warning_triggered = true;
      needsUpdate = true;

      // Log to activity_logs for admin visibility
      try {
        await admin.firestore().collection("activity_logs").add({
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          action: "BUDGET_ALERT_WARNING",
          resource_type: "budget_config",
          resource_id: "budget_config",
          user_id: "system",
          user_email: "system",
          user_role: "system",
          level: "WARNING",
          description: `Budget warning alert: ${usagePercent.toFixed(1)}% of daily budget used ($${currentCost.toFixed(4)}/$${dailyLimit.toFixed(2)})`,
          metadata: {
            usage_percent: usagePercent,
            current_cost: currentCost,
            daily_limit: dailyLimit,
            threshold: thresholds.warning_percent,
          },
        });
      } catch (logError) {
        console.error("❌ [BudgetAlert] Failed to log warning alert:", logError);
      }
    }

    // Update budget_config if alert state changed
    if (needsUpdate) {
      await admin.firestore()
        .collection("settings")
        .doc("budget_config")
        .update({
          alert_state: alertState,
        });
    }
  } catch (error) {
    console.error("❌ [BudgetAlert] Error checking budget alerts:", error);
    // Don't throw - alerting failures shouldn't block processing
  }
}

// ==================== processImageUpload ====================

/**
 * Process uploaded images with GPT-4o Vision
 * Triggered by: Storage onFinalize event
 * Security: 3-layer quota check system
 *
 * Security Layers:
 * 1. Global Circuit Breaker Check
 * 2. Global Daily Quota Check (budget_config)
 * 3. Rate Limiting Check
 */
export const processImageUpload = functions.storage
  .object()
  .onFinalize(async (object) => {
    const startTime = Date.now();
    const filePath = object.name;
    const contentType = object.contentType;

    console.log(`📸 [ProcessImage] Starting: ${filePath}`);

    // ==================== Validation ====================

    // 1. Validate content type
    if (!contentType || !contentType.startsWith("image/")) {
      console.log("❌ Not an image file, skipping");
      return null;
    }

    // 2. Validate path format
    const pathInfo = validateStoragePath(filePath || "");
    console.log("🔍 [Path Validation] Result:", JSON.stringify(pathInfo));

    if (!pathInfo.valid || !pathInfo.userId || !pathInfo.scanId) {
      console.log(`❌ Invalid path format, skipping. Path: ${filePath}`);
      return null;
    }

    const { userId, scanId } = pathInfo;
    console.log(`👤 User: ${userId}, 🆔 Scan: ${scanId}`);

    try {
      // ==================== LAYER 1: Global Circuit Breaker ====================

      console.log("🔒 [Layer 1] Checking global circuit breaker...");
      const globalConfigDoc = await admin.firestore()
        .collection("settings")
        .doc("ai_global_config")
        .get();

      const globalConfig = globalConfigDoc.data() || {};
      const globalLimits = globalConfig.global_limits || {};

      if (globalLimits.circuit_breaker_enabled) {
        const reason = globalLimits.circuit_breaker_reason || "System maintenance";
        console.log(`🔴 [Layer 1] Circuit breaker enabled: ${reason}`);
        await markAsQuotaError(scanId, "GLOBAL_CIRCUIT_BREAKER", reason);
        logQuotaCheck(userId, scanId, false, "Circuit breaker enabled");
        return { success: false, error: "GLOBAL_CIRCUIT_BREAKER" };
      }

      console.log("✅ [Layer 1] Circuit breaker check passed");

      // ==================== LAYER 2: Global Daily Quota Check ====================

      console.log("🔒 [Layer 2] Checking global daily quota (budget_config)...");

      // Get budget configuration
      const budgetConfigDoc = await admin.firestore()
        .collection("settings")
        .doc("budget_config")
        .get();

      const budgetConfig = budgetConfigDoc.data() || {};
      const budgetEnabled = budgetConfig.enabled !== undefined ? budgetConfig.enabled : true;
      const dailyCostLimitUsd = budgetConfig.daily_cost_limit_usd || 50.0;

      if (!budgetEnabled) {
        console.log("⚠️  [Layer 2] Budget monitoring is disabled, skipping quota check");
      } else {
        // Calculate today's total cost from scan_records
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const scanRecordsSnapshot = await admin.firestore()
          .collection("scan_records")
          .where("Timestamp", ">=", admin.firestore.Timestamp.fromDate(todayStart))
          .get();

        let todayTotalCost = 0;
        scanRecordsSnapshot.docs.forEach((doc) => {
          const data = doc.data();
          const aiCost = data.ai_cost;
          if (aiCost && aiCost.total_cost_usd) {
            todayTotalCost += aiCost.total_cost_usd;
          }
        });

        const usagePercent = (todayTotalCost / dailyCostLimitUsd) * 100;

        console.log(
          `📊 [Layer 2] Daily quota: $${todayTotalCost.toFixed(4)} / $${dailyCostLimitUsd.toFixed(2)} (${usagePercent.toFixed(1)}%)`
        );

        // Check and trigger budget alerts
        await checkBudgetAlerts(usagePercent, todayTotalCost, dailyCostLimitUsd, budgetConfig);

        if (todayTotalCost >= dailyCostLimitUsd) {
          const message = `Global daily budget exceeded: $${todayTotalCost.toFixed(4)} / $${dailyCostLimitUsd.toFixed(2)}`;
          console.log(`🔴 [Layer 2] ${message}`);
          await markAsQuotaError(scanId, "GLOBAL_QUOTA_EXCEEDED", message);
          await triggerCircuitBreaker("Daily budget limit reached");
          logQuotaCheck(userId, scanId, false, message);
          return { success: false, error: "GLOBAL_QUOTA_EXCEEDED" };
        }

        console.log("✅ [Layer 2] Global daily quota check passed");
      }

      // ==================== LAYER 3: Rate Limiting Check ====================

      console.log("🔒 [Layer 3] Checking rate limiting...");

      // Get user document for rate limiting data
      const userDoc = await admin.firestore()
        .collection("users")
        .doc(userId)
        .get();

      if (!userDoc.exists) {
        const message = "User document not found";
        console.log(`❌ [Layer 3] ${message}`);
        await markAsQuotaError(scanId, "USER_NOT_FOUND", message);
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "USER_NOT_FOUND" };
      }

      const userData = userDoc.data();
      const userQuota = userData?.ai_quota || {};
      const rateLimit = userQuota.rate_limit || { per_minute: 10, recent_requests: [] };
      const recentRequests = filterRecentRequests(rateLimit.recent_requests || []);

      if (recentRequests.length >= rateLimit.per_minute) {
        const message = `Rate limit exceeded: ${recentRequests.length} requests in last minute (limit: ${rateLimit.per_minute}/min)`;
        console.log(`❌ [Layer 3] ${message}`);
        await markAsQuotaError(scanId, "RATE_LIMIT_EXCEEDED", message);
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "RATE_LIMIT_EXCEEDED" };
      }

      console.log(`✅ [Layer 3] Rate limiting check passed (${recentRequests.length}/${rateLimit.per_minute} requests/min)`);
      logQuotaCheck(userId, scanId, true);

      // ==================== LAYER 4: Global TPM Rate Limiting ⭐ NEW ====================

      console.log("🔒 [Layer 4] Checking global TPM (Tokens Per Minute) rate limit...");

      // Get rate limiter status
      const rateLimiterStatus = await getRateLimiterStatus();
      console.log(
        `📊 [Layer 4] TPM Status: ${rateLimiterStatus.usagePercent.toFixed(1)}% used ` +
          `(${rateLimiterStatus.minuteUsage}/180k tokens/min)`
      );

      // Detect batch upload
      const batchInfo = await detectBatchUpload(userId, Date.now());
      let processingDelay = 0;

      if (batchInfo.isBatch) {
        console.log(`📦 [Layer 4] Batch upload detected. Batch ID: ${batchInfo.batchId}, Position: ${batchInfo.position}`);

        // Calculate intelligent delay for batch processing
        processingDelay = calculateBatchDelay(batchInfo.position, 100); // Assume max 100 items

        // Update scan record with batch info
        await admin.firestore().collection("scan_records").doc(scanId).update({
          batch_id: batchInfo.batchId,
          batch_position: batchInfo.position,
          ai_status: "queued",
          queued_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Update batch info
        await updateBatchInfo(batchInfo.batchId || "unknown", {
          userId,
          totalItems: batchInfo.position,
        });

        if (processingDelay > 0) {
          console.log(`⏱️ [Layer 4] Batch processing delay: ${Math.ceil(processingDelay / 1000)}s`);
          await new Promise((resolve) => setTimeout(resolve, processingDelay));
        }
      }

      // ⚠️ Download image BEFORE estimating tokens
      // 1. Download image
      const bucket = admin.storage().bucket(object.bucket);
      const file = bucket.file(filePath || "");
      const [imageBuffer] = await file.download();
      console.log(`📥 [Image] Downloaded (${imageBuffer.length} bytes)`);

      // Estimate token usage based on image size
      const estimatedTokens = estimateTokenUsage(imageBuffer.length);
      console.log(`📊 [Layer 4] Estimated token usage: ${estimatedTokens} tokens`);

      // Try to acquire tokens
      const tokensAcquired = await acquireTokens(estimatedTokens);

      if (!tokensAcquired) {
        const message = `Global TPM rate limit reached. Please wait and retry. Current usage: ${rateLimiterStatus.usagePercent.toFixed(1)}%`;
        console.log(`🔴 [Layer 4] ${message}`);
        await markAsQuotaError(scanId, "RATE_LIMIT_EXCEEDED", message);
        logQuotaCheck(userId, scanId, false, message);

        // Update status for friendly UI display
        await admin.firestore().collection("scan_records").doc(scanId).update({
          ai_status: "rate_limited",
          ai_error_code: "RATE_LIMIT",
        });

        return { success: false, error: "RATE_LIMIT_EXCEEDED" };
      }

      console.log("✅ [Layer 4] TPM rate limit check passed, tokens acquired");

      // ==================== AI Processing ====================

      console.log("🤖 [AI] Starting GPT-4o Vision processing...");

      // Update status to processing
      await admin.firestore().collection("scan_records").doc(scanId).update({
        ai_status: "processing",
        processing_started_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 0. Read barcode and merchant information from scan record
      const scanDocRef = admin.firestore()
        .collection("scan_records")
        .doc(scanId);
      const scanDoc = await scanDocRef.get();
      const scanData = scanDoc.data();
      const barcodeInfo = scanData?.Barcode_Info;
      // Check both Barcode_Info.code (from Python/batch upload) and Barcode (from iOS app)
      const barcodeValue = barcodeInfo?.code || scanData?.Barcode || null;
      const merchantName = scanData?.Merchant || "Store";

      console.log(`🔍 [AI] Barcode to match: ${barcodeValue || "none"}`);
      console.log(`🏪 [AI] Merchant: ${merchantName}`);

      // 1. Convert image to base64 (already downloaded above)
      const base64Image = imageBuffer.toString("base64");

      // 2. Call GPT-4o Vision API with intelligent retry ⭐ NEW
      // Note: Using gpt-4o-mini due to quota limits on gpt-4o
      // gpt-4o-mini is ~95% cheaper and still provides excellent results

      // Track retry count for user-friendly UI
      let retryCount = 0;

      const response = await retryOpenAICall(
        async () => {
          if (retryCount > 0) {
            // Update scan record to show retrying status
            await admin.firestore().collection("scan_records").doc(scanId).update({
              ai_status: "retrying",
              ai_retry_count: retryCount,
            });
            console.log(`🔄 [AI] Retry attempt ${retryCount}/3 for scan ${scanId}`);
          }

          retryCount++;

          return await getOpenAIClient().chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `You are analyzing a shelf price tag from a ${merchantName} store in the United States.

${barcodeValue ? `IMPORTANT: The user scanned this specific barcode: "${barcodeValue}"
You MUST identify and extract information ONLY from the shelf tag that matches this barcode.
If multiple tags are visible in the image, focus on the one containing or associated with barcode "${barcodeValue}".
If you cannot find a tag matching this barcode, set all fields to null and confidence to "low".` : ""}

Extract the following information and return ONLY a valid JSON object with these exact fields:

{
  "price": "total price for the item/package (e.g., '$4.99', '$2.09', '$9.59')",
  "unit_price": "price per unit if shown (e.g., '$0.42/oz', '$0.50/ct', '$0.15/oz')",
  "size": "physical size/weight per unit (e.g., '20 oz', '1.76 oz', '500 ml')",
  "unit": "measurement unit (e.g., 'oz', 'ct', 'ml', 'lb', 'PK')",
  "product_name": "exact product name from the tag",
  "brand": "brand name",
  "category": "best guess category (Beverages, Snacks, Dairy, Health, Beauty, etc.)",
  "label_date": "any date visible on label in YYYY-MM-DD format (tag print date, timestamp, etc.)",
  "expiration_date": "expiration/best before date in YYYY-MM-DD format",
  "barcode_full": "complete UPC/EAN barcode (12-13 digits)",
  "barcode_shelf_tag": "short digits below barcode (4-8 digits, merchant's shelf tag ID)",
  "promotion": "promotion text if any",
  "confidence": "high, medium, or low"
}

NOTE: Do NOT include "count" field. It will be calculated automatically from price and unit_price.

CRITICAL INSTRUCTIONS:

=== PRICING (MOST IMPORTANT) ===
1. price: The MAIN PRICE customers pay (e.g., "$3.00", "$9.59", "$14.79")
   - This is the total cost for the item or package
   - MUST have EXACTLY 2 decimal places
   - Examples: "$3.00", "$12.99", "$0.99"

2. unit_price: Price PER UNIT if shown separately
   - Look for text like "per oz", "/oz", "each", "/ct"
   - Format: "$X.XX/unit" or "$X.XXX/unit"
   - Examples: "$0.15/oz", "$0.50/ct", "$7.19/oz"
   - Set to null if not visible

=== SIZE & UNIT (CRITICAL) ===

SIZE Rules:
- size: Physical measurement of EACH unit
  * Weight/volume ONLY: "20 oz", "1.76 oz", "500 ml", "1.5 lb"
  * Include the number and unit together
  * If no size visible: set to null
  * Examples: "20 oz", "500 ml", "1.5 lb"

UNIT Rules:
- unit: The measurement type (single word)
  * Weight: "oz", "lb", "g", "kg"
  * Volume: "ml", "l", "fl oz"
  * Count: "ct", "count", "PK", "pk"
  * Each: "ea", "each"
  * Examples: "oz", "ml", "ct", "PK"

EXAMPLES:
- "20 oz bottle" → size: "20 oz", unit: "oz"
- "4 PK" → size: null, unit: "PK"
- "90 ct vitamins" → size: null, unit: "ct"
- "4 PK 5.8 oz each" → size: "5.8 oz", unit: "PK"

=== DATES (IMPORTANT - LOOK CAREFULLY) ===
- label_date: Tag print date / timestamp on the label
  * Look in ALL corners of the tag (top-left, top-right, bottom-left, bottom-right)
  * Look near barcode, near price, or anywhere on the tag
  * Common formats: "11/07/2025", "11/07/25", "2025-11-07", "Nov 7 2025"
  * Convert to YYYY-MM-DD format (e.g., "2025-11-07")
  * This is the date the shelf tag was PRINTED, not expiration
  * Look carefully - this date is often small and in corners

- expiration_date: Product expiration / best before date
  * Usually says "EXP", "Best By", "Use By"
  * Format: YYYY-MM-DD
  * Different from label_date

${barcodeValue ? `
=== BARCODE MATCHING ===
- Only extract from the tag with barcode "${barcodeValue}"
- If multiple tags, ignore others
- If no match, return all null with confidence "low"
` : ""}

=== BARCODE EXTRACTION (TWO DIFFERENT FIELDS) ===
1. barcode_full: Complete UPC/EAN in the barcode IMAGE
   - Usually 12-13 digits
   - Examples: "041196912982", "014790311940"

2. barcode_shelf_tag: SHORT digits BELOW barcode (CRITICAL)
   - Typically 4-8 digits
   - Often last digits of full barcode
   - Examples: "912982", "311940", "159475"
   - This is the merchant's shelf tag ID

=== OTHER RULES ===
- Extract ALL visible prices
- Be precise with units
- All prices in US dollars ($)
- Set confidence "low" if blurry
- Promotion: Remove extra quotes
- Category: Best guess from product type

Return ONLY valid JSON, no markdown blocks.`,
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${base64Image}`,
                    },
                  },
                ],
              },
            ],
            max_tokens: 600,
            temperature: 0.1,
          });
        },
        scanId,
        3 // Max 3 retries
      );

      const aiContent = response.choices[0].message.content || "";
      console.log(`✅ [AI] GPT-4o response received: ${aiContent.substring(0, 100)}...`);

      // 3. Calculate token usage and cost
      const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      const tokenMetrics = calculateTokenMetrics(usage);

      console.log(
        `💰 [AI] Token usage: ${tokenMetrics.total_tokens} tokens, Cost: $${tokenMetrics.total_cost_usd.toFixed(6)}`
      );

      // 4. Parse AI result
      let aiResult: any = null;
      try {
        // Clean up markdown code blocks if present
        let cleanContent = aiContent;
        if (cleanContent.startsWith("```")) {
          const parts = cleanContent.split("```");
          if (parts.length > 1) {
            cleanContent = parts[1];
            if (cleanContent.startsWith("json")) {
              cleanContent = cleanContent.substring(4);
            }
          }
        }
        cleanContent = cleanContent.trim();

        const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          aiResult = JSON.parse(jsonMatch[0]);

          // CRITICAL: Remove count field from AI response if it exists
          // We will calculate it ourselves from price / unit_price
          if (aiResult.count !== undefined) {
            console.log(`⚠️  [AI] AI returned count: ${aiResult.count}, will be recalculated`);
            delete aiResult.count;
          }
        } else {
          aiResult = {
            product_name: null,
            price: null,
            unit_price: null,
            count: null,
            size: null,
            unit: null,
            category: null,
            label_date: null,
            expiration_date: null,
            brand: null,
            barcode_full: null,
            barcode_shelf_tag: null,
            promotion: null,
            confidence: "low",
            description: aiContent,
          };
        }
      } catch (parseError) {
        console.error("❌ [AI] JSON parse error:", parseError);
        aiResult = {
          product_name: null,
          price: null,
          unit_price: null,
          count: null,
          size: null,
          unit: null,
          category: null,
          label_date: null,
          expiration_date: null,
          brand: null,
          barcode_full: null,
          barcode_shelf_tag: null,
          promotion: null,
          confidence: "low",
          description: aiContent,
        };
      }

      // 5. Validate and log price format
      if (aiResult.price) {
        const priceValidation = validatePriceFormat(aiResult.price);
        if (!priceValidation.valid) {
          console.warn(`⚠️  [AI] ${priceValidation.warning}`);
          aiResult.price_validation_warning = priceValidation.warning;
        } else {
          console.log(`✅ [AI] Price format validated: ${aiResult.price}`);
        }
      }

      if (aiResult.unit_price) {
        // Unit prices can have 3 decimal places, so we're more lenient
        if (!aiResult.unit_price.includes("$")) {
          console.warn(`⚠️  [AI] Unit price missing $ symbol: ${aiResult.unit_price}`);
        }
      }

      // 6. Calculate count from price and unit_price
      let calculatedCount: number | null = null;
      if (aiResult.price && aiResult.unit_price) {
        try {
          // Extract numeric values from price strings
          const priceValue = parseFloat(aiResult.price.replace(/[^0-9.]/g, ""));
          const unitPriceValue = parseFloat(aiResult.unit_price.replace(/[^0-9.]/g, ""));

          if (!isNaN(priceValue) && !isNaN(unitPriceValue) && unitPriceValue > 0) {
            // Calculate count = total price / unit price
            calculatedCount = Math.round(priceValue / unitPriceValue);
            console.log(`✅ [AI] Calculated count: ${calculatedCount} (${priceValue} / ${unitPriceValue})`);
          }
        } catch (countError) {
          console.warn("⚠️  [AI] Failed to calculate count:", countError);
        }
      }

      // Set count to calculated value or default to null
      aiResult.count = calculatedCount;

      // Log final extracted data
      console.log("📊 [AI] Extracted data:", {
        price: aiResult.price,
        unit_price: aiResult.unit_price,
        count: aiResult.count,
        product_name: aiResult.product_name,
        confidence: aiResult.confidence,
        barcode_match: barcodeValue ? "required" : "not required",
      });

      // 6. Update Firestore - scan_records
      // Generate public URL for the image (reuse bucket and file from earlier)
      // Get file metadata to construct download URL
      const [metadata] = await file.getMetadata();
      const downloadToken = metadata.metadata?.firebaseStorageDownloadTokens;

      let imageUrl;
      if (downloadToken) {
        // Use download token URL (works with Firebase Security Rules)
        imageUrl = `https://firebasestorage.googleapis.com/v0/b/${object.bucket}/o/${encodeURIComponent(filePath || "")}?alt=media&token=${downloadToken}`;
      } else {
        // Fallback to public URL format
        imageUrl = `https://storage.googleapis.com/${object.bucket}/${filePath}`;
      }

      // Reuse scanDocRef from above (already declared when reading barcode info)
      const updateData: any = {
        Image_URL: imageUrl,
        Image_Filename: pathInfo.filename,
        AI_Result: {
          ...aiResult,
          processed_at: admin.firestore.FieldValue.serverTimestamp(),
          raw_response: aiContent,
        },
        ai_processed: true,
        ai_processing_error: null,
        ai_status: "completed", // ⭐ NEW: Set status to completed
        ai_error_code: null, // ⭐ NEW: Clear error code
        ai_retry_count: retryCount - 1, // ⭐ NEW: Record final retry count
        ai_tokens: {
          input: tokenMetrics.input_tokens,
          output: tokenMetrics.output_tokens,
          total: tokenMetrics.total_tokens,
        },
        ai_cost: {
          input_cost_usd: tokenMetrics.input_cost_usd,
          output_cost_usd: tokenMetrics.output_cost_usd,
          total_cost_usd: tokenMetrics.total_cost_usd,
          currency: "USD",
          pricing_model: "gpt-4o-mini",
        },
        ai_metrics: {
          model_used: "gpt-4o-mini",
          processing_timestamp: admin.firestore.FieldValue.serverTimestamp(),
        },
      };

      // Store new barcode fields from AI extraction
      // barcode_full: Complete UPC/EAN (12-13 digits)
      // barcode_shelf_tag: Short shelf tag ID (typically 4-8 digits) - MOST IMPORTANT for product lookup

      if (aiResult.barcode_full) {
        updateData.Barcode_Full = aiResult.barcode_full;
        console.log(`📊 [Barcode] AI extracted full barcode: ${aiResult.barcode_full}`);
      }

      if (aiResult.barcode_shelf_tag) {
        updateData.Barcode_ShelfTag = aiResult.barcode_shelf_tag;
        console.log(`📊 [Barcode] AI extracted shelf tag ID: ${aiResult.barcode_shelf_tag} ← USED FOR PRODUCT SEARCH`);
      }

      // Backward compatibility: Keep legacy Barcode field
      // Priority: barcode_full > existing Barcode > barcode_shelf_tag
      if (!barcodeValue) {
        // No existing barcode, use AI extracted values
        if (aiResult.barcode_full) {
          updateData.Barcode = aiResult.barcode_full;
        } else if (aiResult.barcode_shelf_tag) {
          updateData.Barcode = aiResult.barcode_shelf_tag;
        }

        if (updateData.Barcode) {
          console.log(`📊 [Barcode] Saved to legacy Barcode field: ${updateData.Barcode}`);
        }
      } else {
        console.log(`📊 [Barcode] Keeping existing barcode: ${barcodeValue}`);
        // Keep existing barcode in legacy field (from iOS or Python extraction)
      }

      await scanDocRef.set(updateData, { merge: true });

      console.log(`✅ [Firestore] Scan record ${scanId} updated with AI results`);

      // 6. Update user usage statistics
      // Convert to Timestamp for Firestore type consistency
      recentRequests.push(admin.firestore.Timestamp.fromMillis(Date.now()));
      await admin.firestore().collection("users").doc(userId).update({
        "ai_quota.today_usage.request_count": admin.firestore.FieldValue.increment(1),
        "ai_quota.today_usage.total_tokens": admin.firestore.FieldValue.increment(tokenMetrics.total_tokens),
        "ai_quota.today_usage.cost_usd": admin.firestore.FieldValue.increment(tokenMetrics.total_cost_usd),
        "ai_quota.today_usage.last_request_at": admin.firestore.FieldValue.serverTimestamp(),
        "ai_quota.rate_limit.recent_requests": recentRequests.slice(-10), // Keep last 10 requests
      });

      console.log(`✅ [Firestore] User ${userId} usage statistics updated`);

      // 7. Update global statistics
      await admin.firestore().collection("settings").doc("ai_global_config").update({
        "today_stats.total_requests": admin.firestore.FieldValue.increment(1),
        "today_stats.total_tokens": admin.firestore.FieldValue.increment(tokenMetrics.total_tokens),
        "today_stats.total_cost_usd": admin.firestore.FieldValue.increment(tokenMetrics.total_cost_usd),
      });

      console.log("✅ [Firestore] Global statistics updated");

      logExecutionTime("processImageUpload", startTime);
      console.log(`✅ [Complete] AI processing completed for ${scanId}`);

      return { success: true, scanId };
    } catch (error) {
      console.error(`❌ [Error] Processing ${scanId}:`, error);

      // ⭐ NEW: Determine error type for friendly UI display
      const errorAny = error as any;
      let errorCode = "UNKNOWN";
      let friendlyMessage = "AI processing failed. Please try again.";

      if (isRateLimitError(error)) {
        errorCode = "RATE_LIMIT";
        friendlyMessage = "Processing is temporarily busy. The system will automatically retry.";
      } else if (errorAny?.code === "ENOTFOUND" || errorAny?.code === "ETIMEDOUT") {
        errorCode = "NETWORK_ERROR";
        friendlyMessage = "Network connection issue. Please check your connection and retry.";
      } else if (errorAny?.message?.includes("quota") || errorAny?.message?.includes("QUOTA")) {
        errorCode = "QUOTA_EXCEEDED";
        friendlyMessage = "Daily processing quota reached. Will reset tomorrow.";
      }

      // Record error to Firestore
      try {
        await admin.firestore()
          .collection("scan_records")
          .doc(scanId)
          .update({
            ai_processed: false,
            ai_processing_error: "PROCESSING_ERROR",
            ai_processing_error_message: error instanceof Error ? error.message : String(error),
            ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
            ai_status: "failed", // ⭐ NEW: Set status to failed
            ai_error_code: errorCode, // ⭐ NEW: Set error code for UI
            ai_error_friendly: friendlyMessage, // ⭐ NEW: Friendly error message
          });

        // Update global failed requests count
        await admin.firestore().collection("settings").doc("ai_global_config").update({
          "today_stats.failed_requests": admin.firestore.FieldValue.increment(1),
        });
      } catch (updateError) {
        console.error("❌ [Error] Failed to update error status:", updateError);
      }

      logExecutionTime("processImageUpload", startTime);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
