# Deployment Guide - ShelfTagSnap Backend

Complete step-by-step deployment guide for Firebase Cloud Functions with OpenAI cost control.

## 📋 Pre-Deployment Checklist

- [ ] Firebase project created
- [ ] Firebase CLI installed (`npm install -g firebase-tools`)
- [ ] OpenAI API key obtained
- [ ] Node.js 18+ installed
- [ ] Admin user created in Firebase Authentication

## 🚀 Step 1: Firebase Project Setup

### 1.1 Login to Firebase

```bash
firebase login
```

### 1.2 Initialize Project

```bash
cd /Users/kent.sun/Projects/upwork/ShelfTagSnap/ShelfTagSnap-Web_Backend

# Set Firebase project
firebase use <your-project-id>

# Or create .firebaserc manually
echo '{
  "projects": {
    "default": "your-project-id"
  }
}' > .firebaserc
```

### 1.3 Create firebase.json

```bash
# Create firebase.json configuration
cat > firebase.json << 'EOF'
{
  "functions": [
    {
      "source": ".",
      "codebase": "default",
      "ignore": [
        "node_modules",
        ".git",
        "firebase-debug.log",
        "firebase-debug.*.log",
        "*.local"
      ],
      "predeploy": [
        "npm --prefix \"$RESOURCE_DIR\" run build",
        "npm --prefix \"$RESOURCE_DIR\" run lint"
      ]
    }
  ]
}
EOF
```

## 🔐 Step 2: Configure Secrets

### 2.1 Set OpenAI API Key

```bash
# Set OpenAI API key
firebase functions:config:set openai.key="sk-your-actual-openai-api-key"

# Verify
firebase functions:config:get
```

### 2.2 Download Config for Local Development (Optional)

```bash
firebase functions:config:get > .runtimeconfig.json
```

**⚠️ Warning**: Add `.runtimeconfig.json` to `.gitignore` (already done)

## 📦 Step 3: Install Dependencies

```bash
npm install
```

## 🗄️ Step 4: Initialize Firestore Data Structure

### 4.1 Create Global AI Config Document

Go to Firebase Console → Firestore → Create document:

**Collection**: `settings`
**Document ID**: `ai_global_config`

**Document data**:
```json
{
  "global_limits": {
    "daily_cost_limit_usd": 100.0,
    "daily_request_limit": 20000,
    "circuit_breaker_enabled": false,
    "circuit_breaker_reason": null
  },
  "today_stats": {
    "total_requests": 0,
    "total_tokens": 0,
    "total_cost_usd": 0.0,
    "failed_requests": 0,
    "quota_exceeded_count": 0
  },
  "cost_alerts": [
    {
      "threshold_usd": 50,
      "email": "admin@example.com",
      "triggered": false
    },
    {
      "threshold_usd": 80,
      "email": "admin@example.com",
      "triggered": false
    },
    {
      "threshold_usd": 95,
      "email": "admin@example.com",
      "triggered": false
    }
  ],
  "default_user_quota": {
    "daily_cost_limit_usd": 10.0,
    "daily_request_limit": 2000,
    "enabled": true
  }
}
```

### 4.2 Add AI Quota to Existing Users

For each user in `users` collection, add `ai_quota` field:

```json
{
  "ai_quota": {
    "daily_cost_limit_usd": 10.0,
    "daily_request_limit": 2000,
    "enabled": true,
    "today_usage": {
      "request_count": 0,
      "total_tokens": 0,
      "cost_usd": 0.0
    },
    "rate_limit": {
      "per_minute": 10,
      "per_hour": 100,
      "recent_requests": []
    }
  }
}
```

**Option 1: Manual via Firebase Console**
- Go to Firestore → users → [select user] → Edit
- Add the above field

**Option 2: Bulk Update Script** (create later if needed)

### 4.3 Create Admin User

Ensure at least one user has `role: "admin"`:

```json
{
  "uid": "admin-user-id",
  "email": "admin@example.com",
  "role": "admin",
  "ai_quota": { /* same as above */ }
}
```

### 4.4 Create Firestore Indexes

**Required Indexes**:

1. `users` collection:
   - Field: `ai_quota.enabled` (Ascending)

2. `quota_logs` collection:
   - Field: `timestamp` (Descending)

**Create via Firebase Console**:
- Firestore → Indexes → Add Index
- Or wait for auto-creation when queries run

## 🏗️ Step 5: Build and Deploy

### 5.1 Build TypeScript

```bash
npm run build
```

**Expected Output**:
- `lib/` directory created with compiled JavaScript

### 5.2 Test Locally (Optional but Recommended)

```bash
# Start Firebase emulators
npm run serve
```

### 5.3 Deploy Functions

```bash
# Deploy all functions
npm run deploy

# Or deploy specific functions
firebase deploy --only functions:processImageUpload
firebase deploy --only functions:getAIQuotaStatus
firebase deploy --only functions:updateUserAIQuota
firebase deploy --only functions:updateGlobalAIConfig
firebase deploy --only functions:resetDailyQuotas
```

**Expected Output**:
```
✔  functions[processImageUpload(us-central1)] Successful create operation.
✔  functions[getAIQuotaStatus(us-central1)] Successful create operation.
✔  functions[updateUserAIQuota(us-central1)] Successful create operation.
✔  functions[updateGlobalAIConfig(us-central1)] Successful create operation.
✔  functions[resetDailyQuotas(us-central1)] Successful create operation.
```

## 🔍 Step 6: Verify Deployment

### 6.1 Check Function Status

```bash
firebase functions:list
```

### 6.2 Test HTTP Callable Functions

**Test getAIQuotaStatus** (via Firebase Console or client SDK):
```javascript
const getAIQuotaStatus = firebase.functions().httpsCallable('getAIQuotaStatus');
const result = await getAIQuotaStatus({});
console.log(result.data);
```

### 6.3 Monitor Logs

```bash
# Real-time logs
firebase functions:log

# Check for errors
firebase functions:log --only processImageUpload --limit 10
```

### 6.4 Test Image Upload Trigger

1. Upload a test image to Storage: `users/{test-user-id}/images/test.jpg`
2. Check logs: `firebase functions:log --only processImageUpload`
3. Verify Firestore `scan_records` updated with AI results

## ⚙️ Step 7: Configure Cloud Scheduler

### 7.1 Enable Cloud Scheduler

```bash
# Enable Cloud Scheduler API
gcloud services enable cloudscheduler.googleapis.com
```

### 7.2 Verify Scheduled Functions

Functions deployed with `.schedule()` automatically create Cloud Scheduler jobs:

- `resetDailyQuotas`: Runs daily at 00:00 UTC+8
- `sendDailyCostReport`: Runs daily at 23:50 UTC+8
- `checkCostAlerts`: Runs hourly

**Check in Google Cloud Console**:
- Cloud Scheduler → View scheduled jobs

### 7.3 Test Manual Trigger

```bash
# Manually trigger resetDailyQuotas
gcloud scheduler jobs run resetDailyQuotas --location=us-central1
```

## 🔒 Step 8: Configure Firestore Security Rules

Update Firestore security rules to allow Cloud Functions access:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Settings - read-only for authenticated users
    match /settings/{document} {
      allow read: if request.auth != null;
      allow write: if false; // Only Cloud Functions can write
    }

    // Users - users can read own data, admins can read all
    match /users/{userId} {
      allow read: if request.auth != null &&
                    (request.auth.uid == userId ||
                     get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
      allow write: if request.auth != null && request.auth.uid == userId;
    }

    // Scan records - users can read own records
    match /scan_records/{recordId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null &&
                      request.resource.data.User_ID == request.auth.uid;
      allow update: if request.auth != null; // Allow Cloud Functions to update
      allow delete: if request.auth != null &&
                      (resource.data.User_ID == request.auth.uid ||
                       get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
    }

    // Quota logs - read-only for admins
    match /quota_logs/{logId} {
      allow read: if request.auth != null &&
                    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
      allow write: if false; // Only Cloud Functions can write
    }

    // Admin logs - read-only for admins
    match /admin_logs/{logId} {
      allow read: if request.auth != null &&
                    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
      allow write: if false; // Only Cloud Functions can write
    }
  }
}
```

Deploy rules:
```bash
firebase deploy --only firestore:rules
```

## 🧪 Step 9: Testing Checklist

### 9.1 Quota Management Tests

- [ ] Call `getAIQuotaStatus` as regular user → See own quota
- [ ] Call `getAIQuotaStatus` as admin with `userId` param → See other user's quota
- [ ] Call `updateUserAIQuota` as admin → Successfully update quota
- [ ] Call `updateUserAIQuota` as regular user → Permission denied
- [ ] Call `updateGlobalAIConfig` as admin → Successfully update config
- [ ] Enable circuit breaker → All new AI requests rejected

### 9.2 AI Processing Tests

- [ ] Upload image → AI processing starts within 10 seconds
- [ ] Check logs → See 5-layer quota checks passing
- [ ] Check Firestore → `ai_tokens` and `ai_cost` fields populated
- [ ] Check user quota → `today_usage` incremented
- [ ] Check global stats → `today_stats` incremented

### 9.3 Quota Limit Tests

- [ ] Set user quota to $0.01 → Next request rejected with `QUOTA_EXCEEDED_COST_LIMIT`
- [ ] Set user `enabled: false` → Next request rejected with `QUOTA_DISABLED`
- [ ] Upload 11 images in 1 minute → 11th rejected with `RATE_LIMIT_EXCEEDED`
- [ ] Set global quota to $0.01 → All requests rejected, circuit breaker auto-triggered

### 9.4 Scheduled Task Tests

- [ ] Manually trigger `resetDailyQuotas` → All user quotas reset to 0
- [ ] Check logs after 00:00 UTC+8 → Automatic reset occurred
- [ ] Check quota_logs collection → Reset event logged

## 📊 Step 10: Monitoring Setup

### 10.1 Set Up Alerts (Google Cloud Console)

1. Go to Cloud Monitoring → Alerting
2. Create alerts for:
   - Function errors > 5 in 5 minutes
   - Function execution time > 60 seconds
   - OpenAI API 429 errors (rate limit)

### 10.2 Cost Monitoring

1. Go to Billing → Budgets & alerts
2. Set budget alert at $150/month
3. Enable email notifications

### 10.3 Daily Review

Check these daily:
- Firebase Console → Functions → Logs
- Firestore → settings/ai_global_config → today_stats
- OpenAI Dashboard → Usage

## 🔄 Step 11: Update/Rollback

### Update Functions

```bash
# Make changes
npm run build

# Deploy
npm run deploy
```

### Rollback to Previous Version

```bash
# View deployment history
firebase functions:log

# Rollback (if needed)
# Note: Firebase Functions doesn't have direct rollback
# Best practice: Use git tags and redeploy previous version

git checkout <previous-tag>
npm run build
npm run deploy
```

## 🎉 Deployment Complete!

Your ShelfTagSnap backend is now live with:
- ✅ 5-layer OpenAI cost control
- ✅ User quota management
- ✅ Admin control panel APIs
- ✅ AI image processing
- ✅ Daily quota resets
- ✅ Cost monitoring

## 📞 Support

For issues, check:
1. Firebase Functions logs: `firebase functions:log`
2. Google Cloud Console → Cloud Functions → Logs
3. Firestore data integrity
4. OpenAI API status: https://status.openai.com

---

**Version**: 1.0.0
**Last Updated**: 2025-11-03
