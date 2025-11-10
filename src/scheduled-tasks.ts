/**
 * Scheduled Tasks for Quota Management
 * Daily reset of user quotas and global statistics
 */

import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

// ==================== resetDailyQuotas ====================

/**
 * Reset daily quotas for all users and global statistics
 * Schedule: Every day at 00:00 Asia/Shanghai (UTC+8)
 * Trigger: Cloud Scheduler
 */
export const resetDailyQuotas = functions.pubsub
  .schedule("0 0 * * *") // Every day at 00:00
  .timeZone("Asia/Shanghai") // UTC+8
  .onRun(async (context) => {
    console.log("🔄 [ResetQuotas] Starting daily quota reset...");
    const startTime = Date.now();

    try {
      const now = admin.firestore.FieldValue.serverTimestamp();

      // ==================== 1. Reset All User Quotas ====================

      console.log("📊 [ResetQuotas] Fetching users with AI enabled...");

      const usersSnapshot = await admin.firestore()
        .collection("users")
        .where("ai_quota.enabled", "==", true)
        .get();

      console.log(`👥 [ResetQuotas] Found ${usersSnapshot.size} users to reset`);

      // Batch in chunks of 500 to respect Firestore batch limit
      const BATCH_SIZE = 500;
      const userDocs = usersSnapshot.docs;
      let totalUpdated = 0;

      for (let i = 0; i < userDocs.length; i += BATCH_SIZE) {
        const batch = admin.firestore().batch();
        const chunk = userDocs.slice(i, i + BATCH_SIZE);

        chunk.forEach((doc) => {
          batch.update(doc.ref, {
            "ai_quota.today_usage.request_count": 0,
            "ai_quota.today_usage.total_tokens": 0,
            "ai_quota.today_usage.cost_usd": 0,
            "ai_quota.today_usage.last_reset_at": now,
            "ai_quota.rate_limit.recent_requests": [],
          });
        });

        await batch.commit();
        totalUpdated += chunk.length;
        console.log(`✅ [ResetQuotas] Batch ${Math.floor(i / BATCH_SIZE) + 1} committed (${chunk.length} users)`);
      }

      console.log(`✅ [ResetQuotas] Total ${totalUpdated} users updated`);

      // ==================== 2. Reset Global Statistics ====================

      console.log("🌍 [ResetQuotas] Resetting global statistics...");

      const globalConfigRef = admin.firestore()
        .collection("settings")
        .doc("ai_global_config");

      // Get current stats for logging before reset
      const globalDoc = await globalConfigRef.get();
      const currentStats = globalDoc.data()?.today_stats || {};

      console.log("📈 [ResetQuotas] Today's stats before reset:", {
        requests: currentStats.total_requests || 0,
        tokens: currentStats.total_tokens || 0,
        cost_usd: (currentStats.total_cost_usd || 0).toFixed(2),
        failed: currentStats.failed_requests || 0,
        quota_exceeded: currentStats.quota_exceeded_count || 0,
      });

      // Reset cost alert triggered flags (properly delete triggered_at field)
      const costAlerts = globalDoc.data()?.cost_alerts || [];
      const resetAlerts = costAlerts.map((alert: any) => {
        const { triggered_at, ...rest } = alert;
        return { ...rest, triggered: false };
      });

      // Create separate batch for global config updates
      const globalBatch = admin.firestore().batch();

      globalBatch.update(globalConfigRef, {
        "today_stats.total_requests": 0,
        "today_stats.total_tokens": 0,
        "today_stats.total_cost_usd": 0,
        "today_stats.failed_requests": 0,
        "today_stats.quota_exceeded_count": 0,
        "today_stats.last_reset_at": now,
        "cost_alerts": resetAlerts,
      });

      console.log("💾 [ResetQuotas] Committing global statistics reset...");
      await globalBatch.commit();
      console.log("✅ [ResetQuotas] Global statistics reset completed");

      // ==================== 4. Log Reset Event ====================

      await admin.firestore().collection("quota_logs").add({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        event_type: "daily_reset",
        user_id: "system",
        details: {
          users_reset: usersSnapshot.size,
          previous_stats: {
            requests: currentStats.total_requests || 0,
            tokens: currentStats.total_tokens || 0,
            cost_usd: currentStats.total_cost_usd || 0,
            failed: currentStats.failed_requests || 0,
          },
        },
      });

      const duration = Date.now() - startTime;
      console.log("✅ [ResetQuotas] Daily quota reset completed successfully");
      console.log(`⏱️  [ResetQuotas] Execution time: ${duration}ms`);
      console.log("📊 [ResetQuotas] Summary:", {
        users_reset: usersSnapshot.size,
        previous_requests: currentStats.total_requests || 0,
        previous_cost_usd: (currentStats.total_cost_usd || 0).toFixed(2),
      });

      return {
        success: true,
        reset_count: usersSnapshot.size,
        duration_ms: duration,
      };
    } catch (error) {
      console.error("❌ [ResetQuotas] Failed to reset daily quotas:", error);

      // Log error
      try {
        await admin.firestore().collection("quota_logs").add({
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          event_type: "daily_reset_error",
          user_id: "system",
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (logError) {
        console.error("❌ [ResetQuotas] Failed to log error:", logError);
      }

      throw error;
    }
  });

// ==================== sendDailyCostReport (Optional) ====================

/**
 * Send daily cost report email to admins
 * Schedule: Every day at 23:50 Asia/Shanghai (UTC+8)
 * Optional: Can be enabled after email service is configured
 */
export const sendDailyCostReport = functions.pubsub
  .schedule("50 23 * * *") // Every day at 23:50
  .timeZone("Asia/Shanghai") // UTC+8
  .onRun(async (context) => {
    console.log("📧 [CostReport] Generating daily cost report...");

    try {
      // Get today's statistics
      const globalDoc = await admin.firestore()
        .collection("settings")
        .doc("ai_global_config")
        .get();

      const todayStats = globalDoc.data()?.today_stats || {};
      const globalLimits = globalDoc.data()?.global_limits || {};

      const report = {
        date: new Date().toISOString().split("T")[0],
        total_requests: todayStats.total_requests || 0,
        total_tokens: todayStats.total_tokens || 0,
        total_cost_usd: (todayStats.total_cost_usd || 0).toFixed(2),
        failed_requests: todayStats.failed_requests || 0,
        quota_exceeded_count: todayStats.quota_exceeded_count || 0,
        daily_limit_usd: globalLimits.daily_cost_limit_usd || 100.0,
        usage_percentage: ((todayStats.total_cost_usd || 0) / (globalLimits.daily_cost_limit_usd || 100.0) * 100).toFixed(2),
      };

      console.log("📊 [CostReport] Daily report:", report);

      // TODO: Implement email sending via SendGrid/AWS SES/etc.
      // For now, just log the report
      console.log("📧 [CostReport] Email sending not implemented yet");

      return { success: true, report };
    } catch (error) {
      console.error("❌ [CostReport] Failed to generate cost report:", error);
      throw error;
    }
  });

// ==================== checkCostAlerts ====================

/**
 * Check cost alerts and send notifications if thresholds are exceeded
 * Schedule: Every hour
 * Runs: Checks if cost thresholds are exceeded and sends alerts
 */
export const checkCostAlerts = functions.pubsub
  .schedule("0 * * * *") // Every hour at :00
  .timeZone("Asia/Shanghai") // UTC+8
  .onRun(async (context) => {
    console.log("🚨 [CostAlerts] Checking cost alert thresholds...");

    try {
      const globalDoc = await admin.firestore()
        .collection("settings")
        .doc("ai_global_config")
        .get();

      const todayStats = globalDoc.data()?.today_stats || {};
      const costAlerts = globalDoc.data()?.cost_alerts || [];
      const currentCost = todayStats.total_cost_usd || 0;

      let alertsTriggered = 0;

      for (let i = 0; i < costAlerts.length; i++) {
        const alert = costAlerts[i];

        if (!alert.triggered && currentCost >= alert.threshold_usd) {
          console.log(`🚨 [CostAlerts] Threshold exceeded: $${currentCost.toFixed(2)} >= $${alert.threshold_usd}`);

          // Mark alert as triggered
          costAlerts[i].triggered = true;
          costAlerts[i].triggered_at = admin.firestore.FieldValue.serverTimestamp();

          // TODO: Send email/SMS notification
          console.log(`📧 [CostAlerts] Would send alert to: ${alert.email}`);

          // Log alert
          await admin.firestore().collection("quota_logs").add({
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            event_type: "cost_alert",
            user_id: "system",
            details: {
              threshold_usd: alert.threshold_usd,
              current_cost_usd: currentCost,
              alert_email: alert.email,
            },
          });

          alertsTriggered++;
        }
      }

      if (alertsTriggered > 0) {
        // Update cost alerts in Firestore
        await admin.firestore()
          .collection("settings")
          .doc("ai_global_config")
          .update({ cost_alerts: costAlerts });

        console.log(`✅ [CostAlerts] Triggered ${alertsTriggered} alerts`);
      } else {
        console.log(`✅ [CostAlerts] No alerts triggered (Current: $${currentCost.toFixed(2)})`);
      }

      return { success: true, alerts_triggered: alertsTriggered };
    } catch (error) {
      console.error("❌ [CostAlerts] Failed to check cost alerts:", error);
      throw error;
    }
  });
