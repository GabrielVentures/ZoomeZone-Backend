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
          ai_processed: true,
          ai_status: "error",
          ai_error: "Missing required fields",
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

      // Update scan record with error
      await snapshot.ref.update({
        ai_processed: true,
        ai_status: "error",
        ai_error: error.message,
        ai_processed_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      const duration = Date.now() - startTime;
      console.log(`⏱️  [ProcessScanRecord] Failed in ${duration}ms`);

      return { success: false, error: error.message };
    }
  });
