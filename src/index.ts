/**
 * ShelfTagSnap Cloud Functions
 * Main entry point - exports all Cloud Functions
 *
 * Functions Overview:
 * - Quota Management: getAIQuotaStatus, updateUserAIQuota, updateGlobalAIConfig
 * - AI Processing: processImageUpload (Storage trigger)
 * - Scheduled Tasks: resetDailyQuotas, sendDailyCostReport, checkCostAlerts
 */

import * as admin from "firebase-admin";

// Initialize Firebase Admin
admin.initializeApp();

// Export Quota Management Functions
export {
  getAIQuotaStatus,
  updateUserAIQuota,
  updateGlobalAIConfig,
} from "./quota-functions";

// Export AI Processing Function
export { processImageUpload } from "./ai-processor";

// Export Scheduled Tasks
export {
  resetDailyQuotas,
  sendDailyCostReport,
  checkCostAlerts,
} from "./scheduled-tasks";
