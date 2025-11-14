# ShelfTagSnap Cloud Functions

Firebase Cloud Functions backend for ShelfTagSnap - AI-powered shelf tag recognition system.

## 📋 Overview

Cloud-based backend service for processing shelf tag images using OpenAI Vision API, with comprehensive cost control and intelligent retry mechanisms.

## 🏗️ Architecture

### Tech Stack
- **Runtime**: Node.js 20
- **Framework**: Firebase Cloud Functions (1st Gen)
- **Database**: Cloud Firestore
- **Storage**: Firebase Cloud Storage
- **AI Service**: OpenAI GPT-4o-mini Vision API
- **Language**: TypeScript

### Core Modules

**AI Processing**
- `ai-processor.ts` - Main AI image processing with Storage triggers
- `firestore-ai-processor.ts` - Firestore-triggered AI processing
- `retry-api.ts` - Intelligent retry API system
- `retry-handler.ts` - Exponential backoff retry logic
- `batch-processor.ts` - Batch upload detection and processing
- `rate-limiter.ts` - Request rate limiting

**Quota & Cost Management**
- `quota-functions.ts` - User and global quota management
- `scheduled-tasks.ts` - Daily quota reset and cost reporting

**Audit & Security**
- `audit-functions.ts` - Activity logging API
- `audit-logger.ts` - Centralized audit logging
- `utils.ts` - Admin role verification

## 🚀 Features

### 1. AI Image Processing
- **GPT-4o-mini Vision API** integration
- Automatic product information extraction
- Multi-format JSON response parsing
- Cost tracking per request

### 2. Intelligent Retry System
- **Manual Single Retry** - Users can retry failed records via web UI
- **Batch Retry** - Admins can retry all failed records (up to 50 at once)
- **Automatic Retry** - Exponential backoff for temporary failures (max 3 attempts)
- **Parallel Processing** - Batch operations use Promise.allSettled

### 3. Cost Control (5-Layer Security)
- Global circuit breaker (emergency shutdown)
- System-wide daily limits ($100/day)
- Per-user quota management ($10/day, 100 requests/day)
- Rate limiting (10 requests/minute)
- Real-time cost tracking

### 4. Batch Processing Optimization
- Automatic batch detection (20+ uploads in 5 minutes)
- Intelligent rate limiting for batch uploads
- Prevents API overload

### 5. Audit & Monitoring
- Comprehensive activity logging
- Daily cost reports (email alerts)
- Hourly cost alert checking
- Real-time usage statistics

## 📡 Cloud Functions

### HTTP Callable Functions
- `retrySingleScan` - Retry a single failed scan
- `retryFailedScans` - Batch retry all failed scans (admin)
- `getRetryBatchStatus` - Get batch retry status
- `getFailedScansCount` - Get failed scans count
- `getAIQuotaStatus` - Get user quota status
- `updateUserAIQuota` - Update user quotas (admin)
- `updateGlobalAIConfig` - Update global config (admin)
- `getAuditLogs` - Get audit logs (admin)
- `logActivity` - Log user activity

### Firestore Triggers
- `processNewScanRecord` - Process new scan records (onCreate)

### Storage Triggers
- `processImageUpload` - Process uploaded images (onFinalize)

### Scheduled Functions (Cloud Scheduler)
- `resetDailyQuotas` - Daily quota reset (00:00 UTC+8)
- `sendDailyCostReport` - Daily cost report (23:50 UTC+8)
- `checkCostAlerts` - Hourly cost checking (every hour)

## 🚢 Deployment

### Prerequisites
- Firebase CLI installed (`npm install -g firebase-tools`)
- Firebase project configured
- Node.js 20+ installed

### Deploy All Functions
```bash
npm run build
npm run deploy
```

### Deploy Specific Functions
```bash
# Deploy retry API functions
firebase deploy --only functions:retrySingleScan,retryFailedScans

# Deploy AI processing functions
firebase deploy --only functions:processNewScanRecord,processImageUpload

# Deploy scheduled tasks
firebase deploy --only functions:resetDailyQuotas,sendDailyCostReport
```

### View Logs
```bash
# Real-time logs
firebase functions:log

# Function-specific logs
firebase functions:log --only retrySingleScan

# Search logs
firebase functions:log 2>&1 | grep "RetryAPI"
```

## 📊 Project Structure

```
src/
├── ai-processor.ts              # Main AI processing (Storage trigger)
├── firestore-ai-processor.ts   # Firestore-triggered processing
├── retry-api.ts                 # Retry API system (619 lines)
├── retry-handler.ts             # Exponential backoff logic
├── batch-processor.ts           # Batch detection & management
├── rate-limiter.ts              # Rate limiting utilities
├── quota-functions.ts           # Quota management APIs
├── scheduled-tasks.ts           # Cron jobs
├── audit-functions.ts           # Audit APIs
├── audit-logger.ts              # Centralized logging
├── utils.ts                     # Shared utilities
├── types.ts                     # TypeScript types
└── index.ts                     # Function exports
```

## 🔧 Development

### Build
```bash
npm run build
```

### Lint
```bash
npm run lint
```

### Local Testing
```bash
firebase emulators:start
```

## 📚 Resources

- [Firebase Functions Documentation](https://firebase.google.com/docs/functions)
- [OpenAI API Documentation](https://platform.openai.com/docs)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

---

**Version**: 2.1.0
**Last Updated**: 2025-11-14
**Node Version**: 20
