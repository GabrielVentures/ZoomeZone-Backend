/**
 * Batch Processing Detector and Manager
 * Detects batch uploads and manages intelligent batch processing
 */

import * as admin from "firebase-admin";

export interface BatchInfo {
  batchId: string;
  userId: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startTime: number;
  estimatedCompletionTime: number;
  status: "processing" | "completed" | "failed";
}

const BATCH_DETECTION_WINDOW = 5 * 60 * 1000; // 5 minutes
const BATCH_THRESHOLD = 20; // Consider batch if >20 uploads in window
const BATCH_SIZE = 10; // Process 10 items per batch
const BATCH_DELAY = 60 * 1000; // 60 seconds between batches

/**
 * Detect if current upload is part of a batch upload
 * @param userId User ID
 * @param currentTime Current timestamp
 * @returns Batch information if detected, null otherwise
 */
export async function detectBatchUpload(
  userId: string,
  currentTime: number
): Promise<{ isBatch: boolean; batchId: string | null; position: number }> {
  try {
    const windowStart = currentTime - BATCH_DETECTION_WINDOW;

    // Query recent uploads from this user
    const recentUploads = await admin
      .firestore()
      .collection("scan_records")
      .where("User_ID", "==", userId)
      .where("Upload_Timestamp", ">=", new Date(windowStart))
      .orderBy("Upload_Timestamp", "desc")
      .limit(BATCH_THRESHOLD + 1)
      .get();

    const uploadCount = recentUploads.size;

    if (uploadCount >= BATCH_THRESHOLD) {
      // This is a batch upload
      // Find or create batch ID
      const firstUpload = recentUploads.docs[recentUploads.docs.length - 1];
      const batchId = `batch_${userId}_${firstUpload.data().Upload_Timestamp.toMillis()}`;

      console.log(
        `📦 [BatchDetector] Batch upload detected for user ${userId}. ` +
          `${uploadCount} uploads in last ${BATCH_DETECTION_WINDOW / 1000}s. Batch ID: ${batchId}`
      );

      return {
        isBatch: true,
        batchId,
        position: uploadCount,
      };
    }

    return {
      isBatch: false,
      batchId: null,
      position: 0,
    };
  } catch (error) {
    console.error("❌ [BatchDetector] Error detecting batch upload:", error);
    return {
      isBatch: false,
      batchId: null,
      position: 0,
    };
  }
}

/**
 * Calculate intelligent delay for batch processing
 * @param batchPosition Position in the batch (1-indexed)
 * @param totalInBatch Total items in batch
 * @returns Delay in milliseconds
 */
export function calculateBatchDelay(batchPosition: number, totalInBatch: number): number {
  // Group items into batches of BATCH_SIZE
  const batchNumber = Math.floor((batchPosition - 1) / BATCH_SIZE);
  const positionInBatch = (batchPosition - 1) % BATCH_SIZE;

  // Each batch gets a delay
  const baseDelay = batchNumber * BATCH_DELAY;

  // Add staggering within batch (spread items within 10 seconds)
  const staggerDelay = positionInBatch * 2000; // 2 seconds between items in same batch

  const totalDelay = baseDelay + staggerDelay;

  console.log(
    `⏱️ [BatchProcessor] Item ${batchPosition}/${totalInBatch}: ` +
      `Batch ${batchNumber + 1}, Position ${positionInBatch + 1}/${BATCH_SIZE}. ` +
      `Delay: ${Math.ceil(totalDelay / 1000)}s`
  );

  return totalDelay;
}

/**
 * Create or update batch info in Firestore
 */
export async function updateBatchInfo(batchId: string, updates: Partial<BatchInfo>): Promise<void> {
  try {
    const batchRef = admin.firestore().collection("batch_processing").doc(batchId);

    const batchDoc = await batchRef.get();

    if (!batchDoc.exists) {
      // Create new batch info
      const newBatch: BatchInfo = {
        batchId,
        userId: updates.userId || "",
        totalItems: updates.totalItems || 0,
        processedItems: 0,
        failedItems: 0,
        startTime: Date.now(),
        estimatedCompletionTime: Date.now() + (updates.totalItems || 0) * 30000, // 30s per item estimate
        status: "processing",
        ...updates,
      };

      await batchRef.set(newBatch);
      console.log(`📦 [BatchProcessor] Created batch info: ${batchId}`);
    } else {
      // Update existing batch info
      await batchRef.update({
        ...updates,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (error) {
    console.error(`❌ [BatchProcessor] Error updating batch info for ${batchId}:`, error);
  }
}

/**
 * Get batch processing progress
 */
export async function getBatchProgress(batchId: string): Promise<BatchInfo | null> {
  try {
    const batchDoc = await admin.firestore().collection("batch_processing").doc(batchId).get();

    if (!batchDoc.exists) {
      return null;
    }

    return batchDoc.data() as BatchInfo;
  } catch (error) {
    console.error(`❌ [BatchProcessor] Error getting batch progress for ${batchId}:`, error);
    return null;
  }
}

/**
 * Mark batch item as processed
 */
export async function markBatchItemProcessed(batchId: string, success: boolean): Promise<void> {
  try {
    const batchRef = admin.firestore().collection("batch_processing").doc(batchId);

    await batchRef.update({
      processedItems: admin.firestore.FieldValue.increment(1),
      ...(success ? {} : { failedItems: admin.firestore.FieldValue.increment(1) }),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error(`❌ [BatchProcessor] Error marking item processed for ${batchId}:`, error);
  }
}

/**
 * Check if batch is complete and update status
 */
export async function checkBatchCompletion(batchId: string): Promise<void> {
  try {
    const batchProgress = await getBatchProgress(batchId);

    if (!batchProgress) {
      return;
    }

    if (batchProgress.processedItems >= batchProgress.totalItems) {
      await updateBatchInfo(batchId, {
        status: "completed",
      });

      console.log(
        `✅ [BatchProcessor] Batch ${batchId} completed. ` +
          `Success: ${batchProgress.processedItems - batchProgress.failedItems}/${batchProgress.totalItems}, ` +
          `Failed: ${batchProgress.failedItems}`
      );
    }
  } catch (error) {
    console.error(`❌ [BatchProcessor] Error checking batch completion for ${batchId}:`, error);
  }
}
