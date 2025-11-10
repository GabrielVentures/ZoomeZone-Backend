/**
 * Quota Management Cloud Functions
 * HTTP Callable Functions for managing user quotas and global AI configuration
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {
  GetAIQuotaStatusRequest,
  GetAIQuotaStatusResponse,
  UpdateUserAIQuotaRequest,
  UpdateUserAIQuotaResponse,
  UpdateGlobalAIConfigRequest,
  UpdateGlobalAIConfigResponse,
} from "./types";
import { isAdmin, sanitizeUserQuota, sanitizeGlobalConfig } from "./utils";
import {
  logUserQuotaChange,
  logGlobalAIConfigChange,
  logCircuitBreakerToggle,
} from "./audit-logger";

// ==================== getAIQuotaStatus ====================

/**
 * Get AI quota status for a user
 * Callable by: Authenticated users (for own quota) or admins (for any user)
 *
 * @param data - Request data containing optional userId
 * @param context - Call context with auth information
 * @returns User quota status and global status
 */
export const getAIQuotaStatus = functions.https.onCall(
  async (
    data: GetAIQuotaStatusRequest,
    context: functions.https.CallableContext
  ): Promise<GetAIQuotaStatusResponse> => {
    // 1. Validate authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    const requestedUserId = data.userId || context.auth.uid;

    // 2. Check permission (only admins can view other users' quotas)
    if (requestedUserId !== context.auth.uid) {
      const adminCheck = await isAdmin(context.auth.uid);
      if (!adminCheck) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Only admins can view other users' quotas"
        );
      }
    }

    try {
      // 3. Get user quota data
      const userDoc = await admin.firestore()
        .collection("users")
        .doc(requestedUserId)
        .get();

      if (!userDoc.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          "User not found"
        );
      }

      const userData = userDoc.data();
      const quota = sanitizeUserQuota(userData?.ai_quota);

      // 4. Get global config
      const globalDoc = await admin.firestore()
        .collection("settings")
        .doc("ai_global_config")
        .get();

      const globalData = sanitizeGlobalConfig(globalDoc.data());

      // 5. Calculate remaining quota
      const dailyCostLimit = quota.daily_cost_limit_usd;
      const dailyRequestLimit = quota.daily_request_limit;
      const todayUsage = quota.today_usage;

      const remainingRequests = Math.max(0, dailyRequestLimit - todayUsage.request_count);
      const remainingCost = Math.max(0, dailyCostLimit - todayUsage.cost_usd);
      // Safe division - handle edge case where limit is 0
      const usagePercentage = dailyCostLimit > 0 ?
        ((todayUsage.cost_usd / dailyCostLimit) * 100).toFixed(2) :
        "0.00";

      // 6. Return response
      return {
        success: true,
        data: {
          user_quota: {
            daily_cost_limit_usd: dailyCostLimit,
            daily_request_limit: dailyRequestLimit,
            enabled: quota.enabled,
            today_usage: {
              request_count: todayUsage.request_count,
              cost_usd: todayUsage.cost_usd,
              remaining_requests: remainingRequests,
              remaining_cost_usd: parseFloat(remainingCost.toFixed(2)),
              usage_percentage: usagePercentage,
            },
          },
          global_status: {
            circuit_breaker_enabled: globalData.global_limits.circuit_breaker_enabled,
            circuit_breaker_reason: globalData.global_limits.circuit_breaker_reason,
            today_cost_usd: globalData.today_stats.total_cost_usd,
            today_limit_usd: globalData.global_limits.daily_cost_limit_usd,
          },
        },
      };
    } catch (error) {
      console.error("Error in getAIQuotaStatus:", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError(
        "internal",
        "Failed to get quota status"
      );
    }
  }
);

// ==================== updateUserAIQuota ====================

/**
 * Update user AI quota settings
 * Callable by: Admins only
 *
 * @param data - Request data containing userId and quota updates
 * @param context - Call context with auth information
 * @returns Success response
 */
export const updateUserAIQuota = functions.https.onCall(
  async (
    data: UpdateUserAIQuotaRequest,
    context: functions.https.CallableContext
  ): Promise<UpdateUserAIQuotaResponse> => {
    // 1. Validate authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    // 2. Check admin permission
    const adminCheck = await isAdmin(context.auth.uid);
    if (!adminCheck) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only admins can update user quotas"
      );
    }

    // 3. Validate request data
    const { userId, quota } = data;
    if (!userId || !quota) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "userId and quota are required"
      );
    }

    try {
      // 4. Build update object
      const updateData: Record<string, any> = {};

      if (quota.daily_cost_limit_usd !== undefined) {
        if (quota.daily_cost_limit_usd < 0) {
          throw new functions.https.HttpsError(
            "invalid-argument",
            "daily_cost_limit_usd must be non-negative"
          );
        }
        updateData["ai_quota.daily_cost_limit_usd"] = quota.daily_cost_limit_usd;
      }

      if (quota.daily_request_limit !== undefined) {
        if (quota.daily_request_limit < 0) {
          throw new functions.https.HttpsError(
            "invalid-argument",
            "daily_request_limit must be non-negative"
          );
        }
        updateData["ai_quota.daily_request_limit"] = quota.daily_request_limit;
      }

      if (quota.enabled !== undefined) {
        updateData["ai_quota.enabled"] = quota.enabled;
      }

      // 4.5. Validate that we have at least one field to update
      if (Object.keys(updateData).length === 0) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "At least one quota field must be provided for update"
        );
      }

      // 5. Check user exists before update
      const userRef = admin.firestore().collection("users").doc(userId);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          `User ${userId} not found`
        );
      }

      // 6. Update user quota
      await userRef.update(updateData);

      // 7. Log audit activity using new audit logger
      await logUserQuotaChange(
        context.auth.uid,
        context.auth.token.email || "unknown",
        userId,
        quota
      );

      console.log(`✅ [AdminAction] User ${userId} quota updated by ${context.auth.uid}`);

      return {
        success: true,
        message: "User quota updated successfully",
      };
    } catch (error) {
      console.error("Error in updateUserAIQuota:", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError(
        "internal",
        "Failed to update user quota"
      );
    }
  }
);

// ==================== updateGlobalAIConfig ====================

/**
 * Update global AI configuration
 * Callable by: Admins only
 *
 * @param data - Request data containing global config updates
 * @param context - Call context with auth information
 * @returns Success response
 */
export const updateGlobalAIConfig = functions.https.onCall(
  async (
    data: UpdateGlobalAIConfigRequest,
    context: functions.https.CallableContext
  ): Promise<UpdateGlobalAIConfigResponse> => {
    // 1. Validate authentication
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be authenticated"
      );
    }

    // 2. Check admin permission
    const adminCheck = await isAdmin(context.auth.uid);
    if (!adminCheck) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only admins can update global AI configuration"
      );
    }

    // 3. Validate request data
    const { global_limits } = data;
    if (!global_limits) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "global_limits is required"
      );
    }

    try {
      // 4. Build update object
      const updateData: Record<string, any> = {};

      if (global_limits.daily_cost_limit_usd !== undefined) {
        if (global_limits.daily_cost_limit_usd < 0) {
          throw new functions.https.HttpsError(
            "invalid-argument",
            "daily_cost_limit_usd must be non-negative"
          );
        }
        updateData["global_limits.daily_cost_limit_usd"] = global_limits.daily_cost_limit_usd;
      }

      if (global_limits.daily_request_limit !== undefined) {
        if (global_limits.daily_request_limit < 0) {
          throw new functions.https.HttpsError(
            "invalid-argument",
            "daily_request_limit must be non-negative"
          );
        }
        updateData["global_limits.daily_request_limit"] = global_limits.daily_request_limit;
      }

      if (global_limits.circuit_breaker_enabled !== undefined) {
        updateData["global_limits.circuit_breaker_enabled"] = global_limits.circuit_breaker_enabled;

        if (global_limits.circuit_breaker_enabled) {
          updateData["global_limits.circuit_breaker_reason"] =
            global_limits.circuit_breaker_reason || "Manual toggle by admin";
          console.log(
            `🔴 [CircuitBreaker] Enabled by admin ${context.auth.uid}: ${updateData["global_limits.circuit_breaker_reason"]}`
          );
        } else {
          updateData["global_limits.circuit_breaker_reason"] = null;
          console.log(`🟢 [CircuitBreaker] Disabled by admin ${context.auth.uid}`);
        }
      }

      // 4.5. Validate that we have at least one field to update
      if (Object.keys(updateData).length === 0) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "At least one configuration field must be provided for update"
        );
      }

      // 5. Update global config
      const configRef = admin.firestore()
        .collection("settings")
        .doc("ai_global_config");
      await configRef.update(updateData);

      // 6. Log audit activity using new audit logger
      // Log circuit breaker toggle if it changed
      if (global_limits.circuit_breaker_enabled !== undefined) {
        await logCircuitBreakerToggle(
          context.auth.uid,
          context.auth.token.email || "unknown",
          global_limits.circuit_breaker_enabled,
          global_limits.circuit_breaker_reason
        );
      }

      // Log general config change
      await logGlobalAIConfigChange(
        context.auth.uid,
        context.auth.token.email || "unknown",
        global_limits
      );

      // Keep old admin_logs for backwards compatibility (optional)
      await admin.firestore().collection("admin_logs").add({
        action: "update_global_ai_config",
        admin_id: context.auth.uid,
        changes: global_limits,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`✅ [AdminAction] Global AI config updated by ${context.auth.uid}`);

      return {
        success: true,
        message: "Global AI configuration updated successfully",
      };
    } catch (error) {
      console.error("Error in updateGlobalAIConfig:", error);
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      throw new functions.https.HttpsError(
        "internal",
        "Failed to update global AI configuration"
      );
    }
  }
);
