/**
 * AI Image Processing with Quota Control
 * Storage-triggered function for GPT-4o Vision processing with 5-layer security
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

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: functions.config().openai?.key || process.env.OPENAI_API_KEY,
});

// ==================== processImageUpload ====================

/**
 * Process uploaded images with GPT-4o Vision
 * Triggered by: Storage onFinalize event
 * Security: 5-layer quota check system
 *
 * Security Layers:
 * 1. Global Circuit Breaker Check
 * 2. Global Quota Check
 * 3. User Quota Enabled Check
 * 4. User Quota Limit Check
 * 5. Rate Limiting Check
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
    if (!pathInfo.valid || !pathInfo.userId || !pathInfo.scanId) {
      console.log("❌ Invalid path format, skipping");
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
      const todayStats = globalConfig.today_stats || {};

      if (globalLimits.circuit_breaker_enabled) {
        const reason = globalLimits.circuit_breaker_reason || "System maintenance";
        console.log(`🔴 [Layer 1] Circuit breaker enabled: ${reason}`);
        await markAsQuotaError(scanId, "GLOBAL_CIRCUIT_BREAKER", reason);
        logQuotaCheck(userId, scanId, false, "Circuit breaker enabled");
        return { success: false, error: "GLOBAL_CIRCUIT_BREAKER" };
      }

      console.log("✅ [Layer 1] Circuit breaker check passed");

      // ==================== LAYER 2: Global Quota Check ====================

      console.log("🔒 [Layer 2] Checking global quota...");
      const globalCostLimit = globalLimits.daily_cost_limit_usd || 100.0;
      const globalRequestLimit = globalLimits.daily_request_limit || 20000;
      const currentGlobalCost = todayStats.total_cost_usd || 0;
      const currentGlobalRequests = todayStats.total_requests || 0;

      if (currentGlobalCost >= globalCostLimit) {
        const message = `Global daily cost limit reached: $${currentGlobalCost.toFixed(2)} / $${globalCostLimit.toFixed(2)}`;
        console.log(`🔴 [Layer 2] ${message}`);
        await markAsQuotaError(scanId, "GLOBAL_QUOTA_EXCEEDED", message);
        await triggerCircuitBreaker("Daily cost limit reached");
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "GLOBAL_QUOTA_EXCEEDED" };
      }

      if (currentGlobalRequests >= globalRequestLimit) {
        const message = `Global daily request limit reached: ${currentGlobalRequests} / ${globalRequestLimit}`;
        console.log(`🔴 [Layer 2] ${message}`);
        await markAsQuotaError(scanId, "GLOBAL_QUOTA_EXCEEDED", message);
        await triggerCircuitBreaker("Daily request limit reached");
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "GLOBAL_QUOTA_EXCEEDED" };
      }

      console.log(
        `✅ [Layer 2] Global quota check passed (Cost: $${currentGlobalCost.toFixed(2)}/$${globalCostLimit.toFixed(2)}, Requests: ${currentGlobalRequests}/${globalRequestLimit})`
      );

      // ==================== LAYER 3: User Quota Enabled Check ====================

      console.log("🔒 [Layer 3] Checking user quota enabled...");
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

      if (userQuota.enabled === false) {
        const message = "AI processing is disabled for this user";
        console.log(`❌ [Layer 3] ${message}`);
        await markAsQuotaError(scanId, "QUOTA_DISABLED", message);
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "QUOTA_DISABLED" };
      }

      console.log("✅ [Layer 3] User quota enabled check passed");

      // ==================== LAYER 4: User Quota Limit Check ====================

      console.log("🔒 [Layer 4] Checking user quota limits...");
      const todayUsage = userQuota.today_usage || { request_count: 0, cost_usd: 0 };
      const dailyCostLimit = userQuota.daily_cost_limit_usd || 10.0;
      const dailyRequestLimit = userQuota.daily_request_limit || 2000;

      if (todayUsage.request_count >= dailyRequestLimit) {
        const message = `Daily request limit exceeded: ${todayUsage.request_count} / ${dailyRequestLimit}`;
        console.log(`❌ [Layer 4] ${message}`);
        await markAsQuotaError(scanId, "QUOTA_EXCEEDED_DAILY_LIMIT", message);
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "QUOTA_EXCEEDED_DAILY_LIMIT" };
      }

      if (todayUsage.cost_usd >= dailyCostLimit) {
        const message = `Daily cost limit exceeded: $${todayUsage.cost_usd.toFixed(2)} / $${dailyCostLimit.toFixed(2)}`;
        console.log(`❌ [Layer 4] ${message}`);
        await markAsQuotaError(scanId, "QUOTA_EXCEEDED_COST_LIMIT", message);
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "QUOTA_EXCEEDED_COST_LIMIT" };
      }

      console.log(
        `✅ [Layer 4] User quota limit check passed (Cost: $${todayUsage.cost_usd.toFixed(2)}/$${dailyCostLimit.toFixed(2)}, Requests: ${todayUsage.request_count}/${dailyRequestLimit})`
      );

      // ==================== LAYER 5: Rate Limiting Check ====================

      console.log("🔒 [Layer 5] Checking rate limiting...");
      const rateLimit = userQuota.rate_limit || { per_minute: 10, recent_requests: [] };
      const recentRequests = filterRecentRequests(rateLimit.recent_requests || []);

      if (recentRequests.length >= rateLimit.per_minute) {
        const message = `Rate limit exceeded: ${recentRequests.length} requests in last minute (limit: ${rateLimit.per_minute}/min)`;
        console.log(`❌ [Layer 5] ${message}`);
        await markAsQuotaError(scanId, "RATE_LIMIT_EXCEEDED", message);
        logQuotaCheck(userId, scanId, false, message);
        return { success: false, error: "RATE_LIMIT_EXCEEDED" };
      }

      console.log(`✅ [Layer 5] Rate limiting check passed (${recentRequests.length}/${rateLimit.per_minute} requests/min)`);
      logQuotaCheck(userId, scanId, true);

      // ==================== AI Processing ====================

      console.log("🤖 [AI] Starting GPT-4o Vision processing...");

      // 1. Download image
      const bucket = admin.storage().bucket(object.bucket);
      const file = bucket.file(filePath || "");
      const [imageBuffer] = await file.download();
      const base64Image = imageBuffer.toString("base64");

      console.log(`📥 [AI] Image downloaded (${imageBuffer.length} bytes)`);

      // 2. Call GPT-4o Vision API
      const response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `请分析这张货架标签照片，识别以下信息并以JSON格式返回：
{
  "product_name": "商品名称",
  "price": "价格（包含货币符号）",
  "brand": "品牌名称",
  "category": "商品分类",
  "description": "其他可见信息",
  "confidence": 0.95
}

如果某些信息无法识别，请设置为 null。confidence 表示整体识别的置信度（0-1之间）。`,
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
        max_tokens: 500,
        temperature: 0.2,
      });

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
        const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          aiResult = JSON.parse(jsonMatch[0]);
        } else {
          aiResult = {
            product_name: null,
            price: null,
            brand: null,
            category: null,
            description: aiContent,
            confidence: 0.5,
          };
        }
      } catch (parseError) {
        console.error("❌ [AI] JSON parse error:", parseError);
        aiResult = {
          product_name: null,
          price: null,
          brand: null,
          category: null,
          description: aiContent,
          confidence: 0.3,
        };
      }

      // 5. Update Firestore - scan_records
      const scanDocRef = admin.firestore()
        .collection("scan_records")
        .doc(scanId);

      await scanDocRef.update({
        AI_Result: {
          ...aiResult,
          processed_at: admin.firestore.FieldValue.serverTimestamp(),
          raw_response: aiContent,
        },
        ai_processed: true,
        ai_processing_error: null,
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
          pricing_model: "gpt-4-vision-preview",
        },
        ai_metrics: {
          model_used: "gpt-4-vision-preview",
          processing_timestamp: admin.firestore.FieldValue.serverTimestamp(),
        },
      });

      console.log(`✅ [Firestore] Scan record ${scanId} updated with AI results`);

      // 6. Update user usage statistics
      recentRequests.push(Date.now());
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
