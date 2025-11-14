/**
 * Firestore-Triggered AI Image Processing
 * Triggered when iOS creates a new scan_records document
 * This replaces the Storage-triggered approach to ensure document exists before processing
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import OpenAI from "openai";

// OpenAI client
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
 * Process scan record when it's created in Firestore
 * Triggered by: Firestore onCreate event on scan_records collection
 */
export const processNewScanRecord = functions.firestore
  .document("scan_records/{scanId}")
  .onCreate(async (snapshot, context) => {
    const startTime = Date.now();
    const scanId = context.params.scanId;
    const data = snapshot.data();

    console.log(`📸 [ProcessScanRecord] Starting: ${scanId}`);
    console.log("📄 [Data] Fields:", Object.keys(data));

    try {
      // Skip if this record will be processed by Storage trigger (batch uploads)
      if (data.metadata?.batchUpload) {
        console.log("⏭️  Skipping - batch upload (will be processed by Storage trigger)");
        return null;
      }

      // Extract data from iOS format (capitalized with underscores)
      const userId = data.User_ID || data.userId;
      const imageURL = data.Image_URL || data.imageUrl;
      const aiProcessed = data.ai_processed || data.aiProcessed || false;

      console.log(`👤 User: ${userId}`);
      console.log(`🖼️  Image URL: ${imageURL}`);
      console.log(`🤖 AI Processed: ${aiProcessed}`);

      // Skip if already processed
      if (aiProcessed) {
        console.log("✅ Already processed, skipping");
        return null;
      }

      // Validate required fields
      if (!userId || !imageURL) {
        console.log("❌ Missing required fields (User_ID or Image_URL)");
        await snapshot.ref.update({
          ai_processed: false,
          ai_status: "failed",
          ai_processing_error: "VALIDATION_ERROR",
          ai_processing_error_message: "Missing required fields (User_ID or Image_URL)",
          ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        return null;
      }

      // Simplified quota check - create user document if not exists
      const userRef = admin.firestore().collection("users").doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.log("👤 Creating user document with default quota");
        await userRef.set({
          uid: userId,
          email: data.Username || "unknown",
          role: "user",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          ai_quota: {
            daily_cost_limit_usd: 10.0,
            daily_request_limit: 100,
            enabled: true,
            today_usage: {
              request_count: 0,
              total_tokens: 0,
              cost_usd: 0.0,
              last_reset_at: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
        });
      }

      // Mark as processing
      await snapshot.ref.update({
        ai_status: "processing",
        ai_processing_started_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("🤖 Calling OpenAI Vision API...");

      // Call OpenAI Vision API
      const response = await getOpenAIClient().chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this shelf tag image and extract product information. Return ONLY valid JSON with this exact structure:
{
  "product_name": "exact product name",
  "price": "price as string with currency symbol",
  "barcode": "barcode if visible, otherwise null",
  "brand": "brand name if visible",
  "description": "brief product description"
}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: imageURL,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
      });

      const aiContent = response.choices[0]?.message?.content || "{}";
      console.log("📝 AI Response:", aiContent);

      // Parse AI result
      let aiResult;
      try {
        // Remove markdown code blocks if present
        const jsonMatch = aiContent.match(/```json\n?([\s\S]*?)\n?```/) ||
                         aiContent.match(/```\n?([\s\S]*?)\n?```/);
        const jsonStr = jsonMatch ? jsonMatch[1] : aiContent;
        aiResult = JSON.parse(jsonStr.trim());
      } catch (error) {
        console.log("⚠️  Failed to parse JSON, using raw response");
        aiResult = { raw_response: aiContent };
      }

      // Calculate costs (simplified)
      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;
      const totalTokens = response.usage?.total_tokens || 0;

      // GPT-4o pricing: $5/1M input tokens, $15/1M output tokens
      const costUsd = (inputTokens * 0.000005) + (outputTokens * 0.000015);

      console.log(`💰 Cost: $${costUsd.toFixed(6)}, Tokens: ${totalTokens}`);

      // Update scan record with AI results
      await snapshot.ref.update({
        ai_processed: true,
        ai_status: "completed",
        ai_result: aiResult,
        ai_tokens_used: totalTokens,
        ai_cost_usd: costUsd,
        ai_processed_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update user quota
      await userRef.update({
        "ai_quota.today_usage.request_count": admin.firestore.FieldValue.increment(1),
        "ai_quota.today_usage.total_tokens": admin.firestore.FieldValue.increment(totalTokens),
        "ai_quota.today_usage.cost_usd": admin.firestore.FieldValue.increment(costUsd),
      });

      const duration = Date.now() - startTime;
      console.log(`✅ [ProcessScanRecord] Completed in ${duration}ms`);

      return { success: true, scanId, cost: costUsd };
    } catch (error: any) {
      console.error("❌ [Error]:", error.message);

      // Determine error type
      let errorCode = "PROCESSING_ERROR";
      let friendlyMessage = "AI processing failed";

      if (error.code === "insufficient_quota") {
        errorCode = "QUOTA_EXCEEDED";
        friendlyMessage = "OpenAI quota exceeded";
      } else if (error.code === "rate_limit_exceeded") {
        errorCode = "RATE_LIMIT";
        friendlyMessage = "Rate limit exceeded";
      }

      // Update scan record with error (consistent with ai-processor.ts)
      await snapshot.ref.update({
        ai_processed: false,
        ai_status: "failed",
        ai_processing_error: errorCode,
        ai_processing_error_message: error.message,
        ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
        ai_error_code: errorCode,
        ai_error_friendly: friendlyMessage,
      });

      const duration = Date.now() - startTime;
      console.log(`⏱️  [ProcessScanRecord] Failed in ${duration}ms`);

      return { success: false, error: error.message };
    }
  });

/**
 * Process scan record retry when ai_status changes to pending
 * Triggered by: Firestore onUpdate event on scan_records collection
 * This handles retry requests from the Web frontend
 */
export const processRetryRequest = functions.firestore
  .document("scan_records/{scanId}")
  .onUpdate(async (change, context) => {
    const scanId = context.params.scanId;
    const before = change.before.data();
    const after = change.after.data();

    // Only process if:
    // 1. ai_status changed to "pending"
    // 2. batch_retry flag is true (indicates this is a retry request)
    // 3. ai_processed is false
    if (
      after.ai_status === "pending" &&
      after.batch_retry === true &&
      after.ai_processed === false &&
      before.ai_status !== "pending" // Ensure this is a state change
    ) {
      console.log(`🔄 [ProcessRetry] Retry requested for: ${scanId}`);

      // Reuse the same processing logic as onCreate
      // by calling processNewScanRecord's logic
      const snapshot = change.after;

      try {
        const startTime = Date.now();
        const data = snapshot.data();

        // Extract data
        const userId = data.User_ID || data.userId;
        const imageURL = data.Image_URL || data.imageUrl;

        console.log(`👤 User: ${userId}`);
        console.log(`🖼️  Image URL: ${imageURL}`);

        // Validate required fields
        if (!userId || !imageURL) {
          console.log("❌ Missing required fields (User_ID or Image_URL)");
          await snapshot.ref.update({
            ai_processed: false,
            ai_status: "failed",
            ai_processing_error: "VALIDATION_ERROR",
            ai_processing_error_message: "Missing required fields (User_ID or Image_URL)",
            ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
            batch_retry: false, // Clear retry flag
          });
          return null;
        }

        // Call OpenAI Vision API
        console.log("🤖 Calling OpenAI Vision API...");
        const openai = getOpenAIClient();

        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Please analyze this shelf tag image and extract the following information in JSON format:
{
  "title": "Product name",
  "price": "Price (number only, without currency symbol)",
  "barcode": "Barcode number",
  "merchant": "Store/merchant name",
  "discount": "Discount info (if any)",
  "unit": "Unit of measurement (if any)"
}`,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageURL,
                  },
                },
              ],
            },
          ],
          max_tokens: 500,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
          throw new Error("No response from OpenAI");
        }

        // Parse JSON response
        const aiResult = JSON.parse(content);

        // Calculate cost
        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const totalTokens = inputTokens + outputTokens;

        const inputCostPer1k = 0.00015; // $0.150 / 1M tokens = $0.00015 / 1K
        const outputCostPer1k = 0.0006; // $0.600 / 1M tokens = $0.0006 / 1K

        const inputCost = (inputTokens / 1000) * inputCostPer1k;
        const outputCost = (outputTokens / 1000) * outputCostPer1k;
        const totalCost = inputCost + outputCost;

        console.log(`💰 Cost: $${totalCost.toFixed(6)} (${totalTokens} tokens)`);

        // Update scan record with results
        await snapshot.ref.update({
          ai_processed: true,
          ai_status: "completed",
          ai_result: aiResult,
          ai_processing_completed_at: admin.firestore.FieldValue.serverTimestamp(),
          ai_cost: {
            inputTokens,
            outputTokens,
            totalTokens,
            inputCostUsd: parseFloat(inputCost.toFixed(6)),
            outputCostUsd: parseFloat(outputCost.toFixed(6)),
            totalCostUsd: parseFloat(totalCost.toFixed(6)),
            model: "gpt-4o-mini",
          },
          batch_retry: false, // Clear retry flag after successful processing
        });

        const duration = Date.now() - startTime;
        console.log(`✅ [ProcessRetry] Completed in ${duration}ms for ${scanId}`);

        return { success: true };
      } catch (error: any) {
        console.error("❌ [ProcessRetry] Error:", error);

        let errorCode = "UNKNOWN_ERROR";
        let friendlyMessage = "An error occurred during AI processing";

        if (error.code === "insufficient_quota") {
          errorCode = "QUOTA_EXCEEDED";
          friendlyMessage = "OpenAI quota exceeded";
        } else if (error.code === "rate_limit_exceeded") {
          errorCode = "RATE_LIMIT";
          friendlyMessage = "Rate limit exceeded";
        }

        // Update scan record with error
        await snapshot.ref.update({
          ai_processed: false,
          ai_status: "failed",
          ai_processing_error: errorCode,
          ai_processing_error_message: error.message,
          ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
          ai_error_code: errorCode,
          ai_error_friendly: friendlyMessage,
          batch_retry: false, // Clear retry flag
        });

        return { success: false, error: error.message };
      }
    }

    // Not a retry request, skip
    return null;
  });
