/**
 * Retry API - HTTP Callable Functions for batch retry operations
 * Allows Web frontend to trigger retry of failed AI processing
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { isAdmin } from "./utils";

/**
 * Retry a single failed scan record
 * Callable from Web frontend
 */
export const retrySingleScan = functions.https.onCall(async (data, context) => {
  // Authentication check
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { scanId } = data;

  if (!scanId) {
    throw new functions.https.HttpsError("invalid-argument", "scanId is required");
  }

  const userId = context.auth.uid;

  try {
    // Get the scan record
    const scanDoc = await admin.firestore().collection("scan_records").doc(scanId).get();

    if (!scanDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Scan record not found");
    }

    const scanData = scanDoc.data();

    // Check ownership (user can only retry their own scans, admins can retry any)
    const userIsAdmin = await isAdmin(userId);
    if (scanData?.User_ID !== userId && !userIsAdmin) {
      throw new functions.https.HttpsError("permission-denied", "You can only retry your own scans");
    }

    // Check if scan has failed or is pending
    if (scanData?.ai_status !== "failed" && scanData?.ai_status !== "pending" && scanData?.ai_processed !== false) {
      throw new functions.https.HttpsError("failed-precondition", "Scan is not in failed/pending state");
    }

    // Get image URL
    const imageURL = scanData.Image_URL || scanData.imageUrl;
    if (!imageURL) {
      throw new functions.https.HttpsError("failed-precondition", "Missing Image_URL");
    }

    console.log(`🔄 [RetryAPI] Processing retry for scan ${scanId}`);

    // Mark as processing
    await admin.firestore().collection("scan_records").doc(scanId).update({
      ai_status: "processing",
      retry_triggered_at: admin.firestore.FieldValue.serverTimestamp(),
      retry_triggered_by: userId,
    });

    try {
      // Import OpenAI (lazy load)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const OpenAI = require("openai");
      // eslint-disable-next-line new-cap
      const openai = new OpenAI.default({
        apiKey: functions.config().openai?.key || process.env.OPENAI_API_KEY,
      });

      // Call OpenAI Vision API
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
                image_url: { url: imageURL },
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

      // Parse AI response - handle both pure JSON and markdown-wrapped JSON
      let aiResult;
      try {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) ||
                         content.match(/```\n?([\s\S]*?)\n?```/);
        const jsonStr = jsonMatch ? jsonMatch[1] : content;

        // Also handle cases where AI adds text before/after JSON
        // Look for JSON object pattern
        const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
        const finalJsonStr = objectMatch ? objectMatch[0] : jsonStr;

        aiResult = JSON.parse(finalJsonStr.trim());
      } catch (parseError) {
        console.log(`⚠️  [RetryAPI] Failed to parse JSON for scan ${scanId}, using raw response`);
        console.log(`Raw content: ${content.substring(0, 200)}...`);
        aiResult = { raw_response: content };
      }

      // Calculate cost
      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;
      const totalTokens = inputTokens + outputTokens;
      const inputCost = (inputTokens / 1000) * 0.00015;
      const outputCost = (outputTokens / 1000) * 0.0006;
      const totalCost = inputCost + outputCost;

      // Update scan record with success
      await admin.firestore().collection("scan_records").doc(scanId).update({
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
        ai_processing_error: null,
        ai_processing_error_message: null,
        ai_error: null,
        ai_error_code: null,
        ai_error_friendly: null,
      });

      console.log(`✅ [RetryAPI] Successfully retried scan ${scanId}`);

      return {
        success: true,
        scanId,
        message: "Scan processed successfully",
        result: aiResult,
      };
    } catch (aiError: any) {
      console.error(`❌ [RetryAPI] OpenAI error for scan ${scanId}:`, aiError);

      // Update with error
      await admin.firestore().collection("scan_records").doc(scanId).update({
        ai_processed: false,
        ai_status: "failed",
        ai_processing_error: aiError.code || "UNKNOWN_ERROR",
        ai_processing_error_message: aiError.message,
        ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      throw new functions.https.HttpsError("internal", `AI processing failed: ${aiError.message}`);
    }
  } catch (error) {
    console.error(`❌ [RetryAPI] Error retrying scan ${scanId}:`, error);

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
  }
});

/**
 * Batch retry all failed scans for a user or globally (admin only)
 * Callable from Web frontend
 */
export const retryFailedScans = functions.https.onCall(async (data, context) => {
  // Authentication check
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { userId: targetUserId, limit = 50 } = data;
  const requestUserId = context.auth.uid;

  try {
    // Check if requesting user is admin
    const userIsAdmin = await isAdmin(requestUserId);

    // Determine which user ID to query for
    let queryUserId: string | null = null;

    if (targetUserId !== undefined) {
      // Explicit userId provided - admin permission required
      if (!userIsAdmin) {
        throw new functions.https.HttpsError("permission-denied", "Only admins can retry scans for other users");
      }
      queryUserId = targetUserId;
    } else {
      // No userId provided
      if (userIsAdmin) {
        // Admin: query all users (no User_ID filter)
        queryUserId = null;
      } else {
        // Normal user: query own records
        queryUserId = requestUserId;
      }
    }

    // Query both "failed" and "error" status (for backward compatibility)
    let failedQuery;
    let errorQuery;

    if (queryUserId === null) {
      // Admin querying all users - no User_ID filter
      failedQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "failed")
        .orderBy("Timestamp", "desc")
        .limit(limit);

      errorQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "error")
        .orderBy("Timestamp", "desc")
        .limit(limit);
    } else {
      // Query specific user
      failedQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "failed")
        .where("User_ID", "==", queryUserId)
        .orderBy("Timestamp", "desc")
        .limit(limit);

      errorQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "error")
        .where("User_ID", "==", queryUserId)
        .orderBy("Timestamp", "desc")
        .limit(limit);
    }

    // Execute both queries in parallel
    const [failedSnapshot, errorSnapshot] = await Promise.all([
      failedQuery.get(),
      errorQuery.get(),
    ]);

    // Combine results from both queries
    const allFailedDocs = [...failedSnapshot.docs, ...errorSnapshot.docs];

    // Sort combined results by Timestamp and apply limit
    const sortedDocs = allFailedDocs
      .sort((a, b) => {
        const timestampA = a.data().Timestamp?.toMillis() || 0;
        const timestampB = b.data().Timestamp?.toMillis() || 0;
        return timestampB - timestampA; // DESC order
      })
      .slice(0, limit);

    if (sortedDocs.length === 0) {
      return {
        success: true,
        retriedCount: 0,
        message: "No failed scans found to retry",
      };
    }

    const userInfo = queryUserId === null ? "all users" : `user ${queryUserId}`;
    console.log(
      `📦 [RetryAPI] Found ${sortedDocs.length} failed scans to retry for ${userInfo} ` +
      `(${failedSnapshot.size} with status 'failed' + ${errorSnapshot.size} with status 'error')`
    );

    const retriedScanIds: string[] = [];

    // Process each scan individually using direct OpenAI API call
    // This is safer than Firestore triggers which can cause conflicts
    const processedResults = await Promise.allSettled(
      sortedDocs.map(async (doc) => {
        const scanId = doc.id;
        const data = doc.data();

        try {
          console.log(`🔄 [RetryAPI] Processing retry for scan ${scanId}`);

          // Get image URL
          const imageURL = data.Image_URL || data.imageUrl;
          if (!imageURL) {
            throw new Error("Missing Image_URL");
          }

          // Import OpenAI (lazy load)
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const OpenAI = require("openai");
          // eslint-disable-next-line new-cap
          const openai = new OpenAI.default({
            apiKey: functions.config().openai?.key || process.env.OPENAI_API_KEY,
          });

          // Call OpenAI Vision API
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
                    image_url: { url: imageURL },
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

          // Parse AI response - handle both pure JSON and markdown-wrapped JSON
          let aiResult;
          try {
            // Try to extract JSON from markdown code blocks
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) ||
                             content.match(/```\n?([\s\S]*?)\n?```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : content;

            // Also handle cases where AI adds text before/after JSON
            // Look for JSON object pattern
            const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
            const finalJsonStr = objectMatch ? objectMatch[0] : jsonStr;

            aiResult = JSON.parse(finalJsonStr.trim());
          } catch (parseError) {
            console.log(`⚠️  [RetryAPI] Failed to parse JSON for scan ${scanId}, using raw response`);
            console.log(`Raw content: ${content.substring(0, 200)}...`);
            aiResult = { raw_response: content };
          }

          // Calculate cost
          const inputTokens = response.usage?.prompt_tokens || 0;
          const outputTokens = response.usage?.completion_tokens || 0;
          const totalTokens = inputTokens + outputTokens;
          const inputCost = (inputTokens / 1000) * 0.00015;
          const outputCost = (outputTokens / 1000) * 0.0006;
          const totalCost = inputCost + outputCost;

          // Update scan record with success
          await doc.ref.update({
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
            ai_processing_error: null,
            ai_processing_error_message: null,
            ai_error: null,
            ai_error_code: null,
            ai_error_friendly: null,
            retry_triggered_at: admin.firestore.FieldValue.serverTimestamp(),
            retry_triggered_by: requestUserId,
          });

          retriedScanIds.push(scanId);
          console.log(`✅ [RetryAPI] Successfully retried scan ${scanId}`);
          return { scanId, success: true };
        } catch (error: any) {
          console.error(`❌ [RetryAPI] Failed to retry scan ${scanId}:`, error);

          // Update with error
          await doc.ref.update({
            ai_processed: false,
            ai_status: "failed",
            ai_processing_error: error.code || "UNKNOWN_ERROR",
            ai_processing_error_message: error.message,
            ai_processing_error_timestamp: admin.firestore.FieldValue.serverTimestamp(),
          });

          return { scanId, success: false, error: error.message };
        }
      })
    );

    const successCount = processedResults.filter((r) => r.status === "fulfilled" && r.value.success).length;
    const failedCount = sortedDocs.length - successCount;
    console.log(`✅ [RetryAPI] Retry completed: ${successCount}/${sortedDocs.length} successful`);

    // Create a batch retry tracking record
    const batchRetryId = `batch_retry_${Date.now()}_${requestUserId}`;
    await admin
      .firestore()
      .collection("batch_retries")
      .doc(batchRetryId)
      .set({
        batchRetryId,
        triggeredBy: requestUserId,
        targetUserId: targetUserId || requestUserId,
        totalScans: sortedDocs.length,
        scanIds: retriedScanIds,
        status: "completed",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        completedScans: successCount,
        failedScans: failedCount,
      });

    return {
      success: true,
      retriedCount: successCount,
      totalAttempted: sortedDocs.length,
      failedCount,
      batchRetryId,
      message: `${successCount}/${sortedDocs.length} scans retried successfully.`,
    };
  } catch (error) {
    console.error("❌ [RetryAPI] Error batch retrying scans:", error);

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
  }
});

/**
 * Get retry batch status
 * Callable from Web frontend
 */
export const getRetryBatchStatus = functions.https.onCall(async (data, context) => {
  // Authentication check
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { batchRetryId } = data;

  if (!batchRetryId) {
    throw new functions.https.HttpsError("invalid-argument", "batchRetryId is required");
  }

  try {
    const batchDoc = await admin.firestore().collection("batch_retries").doc(batchRetryId).get();

    if (!batchDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Batch retry not found");
    }

    const batchData = batchDoc.data();

    // Check permission
    const userId = context.auth.uid;
    const userIsAdmin = await isAdmin(userId);

    if (batchData?.triggeredBy !== userId && !userIsAdmin) {
      throw new functions.https.HttpsError("permission-denied", "You can only view your own batch retries");
    }

    return {
      success: true,
      batch: batchData,
    };
  } catch (error) {
    console.error("❌ [RetryAPI] Error getting batch status:", error);

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
  }
});

/**
 * Get count of failed scans for a user
 * Callable from Web frontend
 */
export const getFailedScansCount = functions.https.onCall(async (data, context) => {
  // Authentication check
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated");
  }

  const { userId: targetUserId } = data;
  const requestUserId = context.auth.uid;

  try {
    // Check if requesting user is admin
    const userIsAdmin = await isAdmin(requestUserId);

    // Determine which user ID to query for
    let queryUserId: string | null = null;

    if (targetUserId !== undefined) {
      // Explicit userId provided - admin permission required
      if (!userIsAdmin) {
        throw new functions.https.HttpsError("permission-denied", "Only admins can check other users' failed scans");
      }
      queryUserId = targetUserId;
    } else {
      // No userId provided
      if (userIsAdmin) {
        // Admin: query all users (no User_ID filter)
        queryUserId = null;
      } else {
        // Normal user: query own records
        queryUserId = requestUserId;
      }
    }

    // Query both "failed" and "error" status (for backward compatibility)
    // Some records have ai_status: "error" (from firestore-ai-processor.ts)
    // while others have ai_status: "failed" (from ai-processor.ts)

    let failedQuery;
    let errorQuery;

    if (queryUserId === null) {
      // Admin querying all users - no User_ID filter
      failedQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "failed")
        .count();

      errorQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "error")
        .count();
    } else {
      // Query specific user
      failedQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "failed")
        .where("User_ID", "==", queryUserId)
        .count();

      errorQuery = admin
        .firestore()
        .collection("scan_records")
        .where("ai_status", "==", "error")
        .where("User_ID", "==", queryUserId)
        .count();
    }

    // Execute both queries in parallel
    const [failedSnapshot, errorSnapshot] = await Promise.all([
      failedQuery.get(),
      errorQuery.get(),
    ]);

    const failedCount = failedSnapshot.data().count;
    const errorCount = errorSnapshot.data().count;
    const totalCount = failedCount + errorCount;

    const userInfo = queryUserId === null ? "all users" : `user ${queryUserId}`;
    console.log(`📊 [RetryAPI] Failed count for ${userInfo} - failed: ${failedCount}, error: ${errorCount}, total: ${totalCount}`);

    return {
      success: true,
      failedCount: totalCount,
    };
  } catch (error) {
    console.error("❌ [RetryAPI] Error getting failed scans count:", error);

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    throw new functions.https.HttpsError("internal", error instanceof Error ? error.message : "Unknown error");
  }
});
