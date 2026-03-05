/**
 * CloraAI End-to-End API Test Runner
 * Tests all backend API endpoints systematically.
 */

const http = require('http');
const https = require('https');

const BASE = 'http://localhost:3000/api';
const BASE_ROOT = 'http://localhost:3000';

let TOKEN = '';
let ADMIN_TOKEN = '';
let USER_ID = '';
let TEST_EMAIL = `e2etest_${Date.now()}@test.com`;
let TEST_PASSWORD = 'TestPassword123!Strong';
let TEST_USERNAME = `testuser_${Date.now()}`;

const results = [];

// ── HTTP Helper ──────────────────────────────────────────────────────────────
function request(method, url, body, token) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
        };
        if (token) options.headers['Authorization'] = `Bearer ${token}`;

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = data; }
                resolve({ status: res.statusCode, body: parsed, headers: res.headers });
            });
        });

        req.on('error', (err) => resolve({ status: 0, body: { error: err.message }, headers: {} }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { error: 'TIMEOUT' }, headers: {} }); });

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ── Test Runner ──────────────────────────────────────────────────────────────
function record(id, name, passed, status, detail) {
    const icon = passed ? '✅' : '❌';
    results.push({ id, name, passed, status, detail });
    console.log(`${icon} ${id}: ${name} [${status}] ${detail || ''}`);
}

async function run() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  CloraAI E2E API Test Suite');
    console.log(`  Base URL: ${BASE}`);
    console.log(`  Test email: ${TEST_EMAIL}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // ═══ PHASE 1: HEALTH ═══════════════════════════════════════════════════════
    console.log('\n── PHASE 1: Health & Infrastructure ──\n');

    {
        const r = await request('GET', `${BASE_ROOT}/health`);
        record('TC-MW-01', 'Health Check', r.status === 200 && r.body?.status === 'ok', r.status, JSON.stringify(r.body).substring(0, 100));
    }

    {
        const r = await request('GET', `${BASE}/nonexistent-route-xyz`);
        record('TC-MW-02', '404 Handler', r.status === 404, r.status, JSON.stringify(r.body).substring(0, 100));
    }

    {
        const r = await request('GET', `${BASE_ROOT}/api/config`);
        record('TC-CFG-01', 'Public Config Endpoint', r.status === 200 && r.body?.success === true, r.status, `keys: ${Object.keys(r.body?.data?.config || {}).join(', ').substring(0, 80)}`);
    }

    // ═══ PHASE 2: AUTH ═════════════════════════════════════════════════════════
    console.log('\n── PHASE 2: Auth Endpoints ──\n');

    // TC-AUTH-01: Register
    {
        const r = await request('POST', `${BASE}/auth/register`, {
            email: TEST_EMAIL,
            password: TEST_PASSWORD,
            username: TEST_USERNAME,
        });
        const ok = r.status === 201 || (r.status === 200 && r.body?.data?.token);
        if (r.body?.data?.token) TOKEN = r.body.data.token;
        if (r.body?.data?.user?.id) USER_ID = r.body.data.user.id;
        record('TC-AUTH-01', 'Register — Happy Path', ok, r.status, `token=${!!TOKEN}, userId=${USER_ID || 'none'}`);
    }

    // TC-AUTH-02: Duplicate Email
    {
        const r = await request('POST', `${BASE}/auth/register`, {
            email: TEST_EMAIL,
            password: TEST_PASSWORD,
            username: 'dup_user',
        });
        record('TC-AUTH-02', 'Register — Duplicate Email', r.status === 400 || r.status === 409, r.status, JSON.stringify(r.body).substring(0, 100));
    }

    // TC-AUTH-03: Invalid Inputs
    {
        const r1 = await request('POST', `${BASE}/auth/register`, { password: 'x' });
        const r2 = await request('POST', `${BASE}/auth/register`, {});
        record('TC-AUTH-03a', 'Register — Missing email', r1.status === 400 || r1.status === 422, r1.status);
        record('TC-AUTH-03b', 'Register — Empty body', r2.status === 400 || r2.status === 422, r2.status);
    }

    // TC-AUTH-04: Login
    {
        const r = await request('POST', `${BASE}/auth/login`, {
            email: TEST_EMAIL,
            password: TEST_PASSWORD,
        });
        const ok = r.status === 200 && !!r.body?.data?.token;
        if (r.body?.data?.token) TOKEN = r.body.data.token;
        record('TC-AUTH-04', 'Login — Happy Path', ok, r.status, `token=${!!r.body?.data?.token}`);
    }

    // TC-AUTH-05: Wrong Password
    {
        const r = await request('POST', `${BASE}/auth/login`, {
            email: TEST_EMAIL,
            password: 'WrongPassword999!',
        });
        record('TC-AUTH-05', 'Login — Wrong Password', r.status === 401 || r.status === 400, r.status);
    }

    // TC-AUTH-06: Non-existent Email
    {
        const r = await request('POST', `${BASE}/auth/login`, {
            email: 'nonexistent_xyz@nowhere.com',
            password: TEST_PASSWORD,
        });
        record('TC-AUTH-06', 'Login — Non-existent Email', r.status === 401 || r.status === 400, r.status);
    }

    // TC-AUTH-07: Get Me (with token)
    {
        const r = await request('GET', `${BASE}/auth/me`, null, TOKEN);
        record('TC-AUTH-07', 'Get Current User (/me)', r.status === 200 && (r.body?.user || r.body?.data), r.status, `email=${r.body?.user?.email || r.body?.data?.email || '?'}`);
    }

    // TC-AUTH-08: Get Me (no token)
    {
        const r = await request('GET', `${BASE}/auth/me`);
        record('TC-AUTH-08', 'Get Me — No Token', r.status === 401, r.status);
    }

    // TC-AUTH-09: Get Me (invalid token)
    {
        const r = await request('GET', `${BASE}/auth/me`, null, 'invalidtoken123abc');
        record('TC-AUTH-09', 'Get Me — Invalid Token', r.status === 401, r.status);
    }

    // TC-AUTH-10: Update Profile
    {
        const r = await request('PUT', `${BASE}/auth/profile`, {
            username: TEST_USERNAME + '_updated',
            phoneNumber: '+919876543210',
        }, TOKEN);
        record('TC-AUTH-10', 'Update Profile', r.status === 200, r.status);
    }

    // TC-AUTH-11: Forgot Password
    {
        const r = await request('POST', `${BASE}/auth/forgot-password`, { email: TEST_EMAIL }, null);
        record('TC-AUTH-11', 'Forgot Password', r.status === 200 || r.status === 201, r.status, JSON.stringify(r.body).substring(0, 100));
    }

    // TC-AUTH-15: Logout
    {
        const r = await request('POST', `${BASE}/auth/logout`, null, TOKEN);
        record('TC-AUTH-15', 'Logout', r.status === 200, r.status);
    }

    // ─── ADMIN PROMOTION & PRO UPGRADE ───
    console.log('\n── Promoting test user to ADMIN & PRO ──');
    {
        // Need a valid token first
        const l = await request('POST', `${BASE}/auth/login`, { email: TEST_EMAIL, password: TEST_PASSWORD });
        if (l.body?.data?.token) TOKEN = l.body.data.token;

        const r1 = await request('POST', `${BASE}/auth/make-admin`, {
            email: TEST_EMAIL,
            secretKey: 'clora-admin-2026'
        });
        console.log(`   Admin promotion status: ${r1.status}`);

        // Now call admin upgrade (using the token which is now admin)
        const r2 = await request('POST', `${BASE}/admin/users/${USER_ID}/upgrade-pro`, { days: 30 }, TOKEN);
        console.log(`   Pro upgrade status: ${r2.status} ${JSON.stringify(r2.body)}`);
    }

    // Register a non-admin user for security testing
    let NON_ADMIN_TOKEN = '';
    {
        const r = await request('POST', `${BASE}/auth/register`, {
            email: 'nonadmin@test.com',
            password: TEST_PASSWORD,
            username: 'nonadmin'
        });
        if (r.body?.data?.token) NON_ADMIN_TOKEN = r.body.data.token;
    }

    // ═══ PHASE 3: SUBSCRIPTION ═════════════════════════════════════════════════
    console.log('\n── PHASE 3: Subscription Endpoints ──\n');

    // TC-SUB-02: Get Status
    {
        const r = await request('GET', `${BASE}/subscription/status`, null, TOKEN);
        record('TC-SUB-02', 'Get Subscription Status', r.status === 200, r.status, `plan=${r.body?.data?.plan || r.body?.plan || '?'}`);
    }

    // TC-SUB-05: Payment History
    {
        const r = await request('GET', `${BASE}/subscription/history`, null, TOKEN);
        record('TC-SUB-05', 'Get Payment History', r.status === 200, r.status, `count=${Array.isArray(r.body?.data) ? r.body.data.length : '?'}`);
    }

    // TC-SUB-01: Create Order (may fail without Razorpay test keys)
    {
        const r = await request('POST', `${BASE}/subscription/create-order`, { planType: 'monthly' }, TOKEN);
        const ok = r.status === 200 || r.status === 201;
        record('TC-SUB-01', 'Create Subscription Order', ok, r.status, ok ? `subId=${r.body?.subscriptionId || '?'}` : JSON.stringify(r.body).substring(0, 100));
    }

    // ═══ PHASE 4: INSTAGRAM ════════════════════════════════════════════════════
    console.log('\n── PHASE 4: Instagram Endpoints ──\n');

    // TC-IG-01: Get OAuth URL
    {
        const r = await request('GET', `${BASE}/instagram/oauth-url`, null, TOKEN);
        record('TC-IG-01', 'Get Instagram OAuth URL', r.status === 200, r.status, `hasUrl=${!!(r.body?.url || r.body?.data?.url)}`);
    }

    // TC-IG-03: Get Account (likely 404 for test user)
    {
        const r = await request('GET', `${BASE}/instagram/account`, null, TOKEN);
        record('TC-IG-03', 'Get Instagram Account', r.status === 200 || r.status === 404, r.status);
    }

    // ═══ PHASE 5: CAPTIONS ═════════════════════════════════════════════════════
    console.log('\n── PHASE 5: AI Caption Endpoints ──\n');

    let captionId = null;

    // TC-CAP-01: Generate Caption (may fail without OpenAI key)
    {
        const r = await request('POST', `${BASE}/captions/generate`, {
            topic: 'sunset photography',
            tone: 'inspirational',
            length: 'medium',
        }, TOKEN);
        const ok = r.status === 200 || r.status === 201;
        if (r.body?.data?.id) captionId = r.body.data.id;
        if (r.body?.caption?.id) captionId = r.body.caption.id;
        record('TC-CAP-01', 'Generate Caption', ok, r.status, ok ? 'Generated!' : JSON.stringify(r.body).substring(0, 100));
    }

    // TC-CAP-03: Get Caption History
    {
        const r = await request('GET', `${BASE}/captions/history?limit=10&skip=0`, null, TOKEN);
        record('TC-CAP-03', 'Get Caption History', r.status === 200, r.status, `count=${Array.isArray(r.body?.data) ? r.body.data.length : '?'}`);
    }

    // ═══ PHASE 6: SCHEDULER ════════════════════════════════════════════════════
    console.log('\n── PHASE 6: Post Scheduler Endpoints ──\n');

    // TC-SCH-02: Get Scheduled Posts
    {
        const r = await request('GET', `${BASE}/scheduler/posts`, null, TOKEN);
        record('TC-SCH-02', 'Get Scheduled Posts', r.status === 200, r.status, `count=${Array.isArray(r.body?.data) ? r.body.data.length : '?'}`);
    }

    // ═══ PHASE 7: DM AUTOMATION ════════════════════════════════════════════════
    console.log('\n── PHASE 7: DM Automation Endpoints ──\n');

    let ruleId = null;

    // TC-DM-01: Create Rule
    {
        const r = await request('POST', `${BASE}/dm-automation/rules`, {
            keyword: `testword_${Date.now()}`,
            autoReplyMessage: 'Auto-reply test message!',
        }, TOKEN);
        const ok = r.status === 200 || r.status === 201;
        if (r.body?.data?.id) ruleId = r.body.data.id;
        if (r.body?.data?.rule?.id) ruleId = r.body.data.rule.id;
        if (r.body?.rule?.id) ruleId = r.body.rule.id;
        record('TC-DM-01', 'Create DM Automation Rule', ok, r.status, ok ? `ruleId=${ruleId}` : JSON.stringify(r.body).substring(0, 100));
    }

    // TC-DM-02: Get Rules
    {
        const r = await request('GET', `${BASE}/dm-automation/rules`, null, TOKEN);
        record('TC-DM-02', 'Get DM Rules', r.status === 200, r.status, `count=${Array.isArray(r.body?.data) ? r.body.data.length : '?'}`);
    }

    // TC-DM-03: Update Rule
    if (ruleId) {
        const r = await request('PUT', `${BASE}/dm-automation/rules/${ruleId}`, {
            autoReplyMessage: 'Updated auto-reply!'
        }, TOKEN);
        record('TC-DM-03', 'Update DM Rule', r.status === 200, r.status);
    } else {
        record('TC-DM-03', 'Update DM Rule', false, 'SKIP', 'No ruleId available');
    }

    // TC-DM-04: Delete Rule
    if (ruleId) {
        const r = await request('DELETE', `${BASE}/dm-automation/rules/${ruleId}`, null, TOKEN);
        record('TC-DM-04', 'Delete DM Rule', r.status === 200, r.status);
    } else {
        record('TC-DM-04', 'Delete DM Rule', false, 'SKIP', 'No ruleId available');
    }

    // ═══ PHASE 8: ANALYTICS ════════════════════════════════════════════════════
    console.log('\n── PHASE 8: Analytics Endpoints ──\n');

    // TC-AN-01: Dashboard
    {
        const r = await request('GET', `${BASE}/analytics/dashboard`, null, TOKEN);
        record('TC-AN-01', 'Get Dashboard Analytics', r.status === 200, r.status);
    }

    // TC-AN-02: Record Snapshot
    {
        const r = await request('POST', `${BASE}/analytics/snapshot`, {
            followers: 1500,
            following: 300,
            engagement: 4.5,
        }, TOKEN);
        record('TC-AN-02', 'Record Analytics Snapshot', r.status === 200 || r.status === 201, r.status);
    }

    // ═══ PHASE 9: CALENDAR ═════════════════════════════════════════════════════
    console.log('\n── PHASE 9: Calendar Endpoints ──\n');

    let taskId = null;

    // TC-CAL-01: Create Task
    {
        const r = await request('POST', `${BASE}/calendar/tasks`, {
            title: 'Test task - E2E',
            date: '2026-03-10',
            time: '14:00',
        }, TOKEN);
        const ok = r.status === 200 || r.status === 201;
        if (r.body?.data?.id) taskId = r.body.data.id;
        if (r.body?.data?.task?.id) taskId = r.body.data.task.id;
        if (r.body?.task?.id) taskId = r.body.task.id;
        record('TC-CAL-01', 'Create Calendar Task', ok, r.status, `taskId=${taskId}`);
    }

    // TC-CAL-02: Get Tasks
    {
        const r = await request('GET', `${BASE}/calendar/tasks`, null, TOKEN);
        record('TC-CAL-02', 'Get Calendar Tasks', r.status === 200, r.status, `count=${Array.isArray(r.body?.data) ? r.body.data.length : '?'}`);
    }

    // TC-CAL-03: Toggle Task
    if (taskId) {
        const r = await request('PATCH', `${BASE}/calendar/tasks/${taskId}/toggle`, null, TOKEN);
        record('TC-CAL-03', 'Toggle Calendar Task', r.status === 200, r.status);
    } else {
        record('TC-CAL-03', 'Toggle Calendar Task', false, 'SKIP', 'No taskId');
    }

    // TC-CAL-04: Delete Task
    if (taskId) {
        const r = await request('DELETE', `${BASE}/calendar/tasks/${taskId}`, null, TOKEN);
        record('TC-CAL-04', 'Delete Calendar Task', r.status === 200, r.status);
    } else {
        record('TC-CAL-04', 'Delete Calendar Task', false, 'SKIP', 'No taskId');
    }

    // ═══ PHASE 10: NOTIFICATIONS ═══════════════════════════════════════════════
    console.log('\n── PHASE 10: Notification Endpoints ──\n');

    // TC-NOT-01: Get Notifications
    {
        const r = await request('GET', `${BASE}/notifications`, null, TOKEN);
        record('TC-NOT-01', 'Get Notifications', r.status === 200, r.status);
    }

    // TC-NOT-02: Register Push Token
    {
        const r = await request('POST', `${BASE}/notifications/register-token`, {
            pushToken: 'ExponentPushToken[TestToken123]',
        }, TOKEN);
        record('TC-NOT-02', 'Register Push Token', r.status === 200, r.status);
    }

    // ═══ PHASE 11: REFERRALS & BRAND DEALS ═════════════════════════════════════
    console.log('\n── PHASE 11: Referrals & Brand Deals ──\n');

    // TC-REF-03: Referral Stats
    {
        const r = await request('GET', `${BASE}/referral/stats`, null, TOKEN);
        record('TC-REF-03', 'Get Referral Stats', r.status === 200, r.status);
    }

    // TC-BD-01: Get Brand Deals
    {
        const r = await request('GET', `${BASE}/brand-deals`, null, TOKEN);
        record('TC-BD-01', 'Get Brand Deals', r.status === 200, r.status);
    }

    // ═══ PHASE 12: ADMIN ═══════════════════════════════════════════════════════
    console.log('\n── PHASE 12: Admin Endpoints ──\n');

    // TC-ADM-08: Non-admin tries admin endpoint
    {
        const r = await request('GET', `${BASE}/admin/metrics`, null, NON_ADMIN_TOKEN);
        const ok = r.status === 403;
        record('TC-ADM-08', 'Non-Admin → Forbidden', ok, r.status, JSON.stringify(r.body));
    }

    // TC-ADM-01: Get Metrics (will only pass if test user is admin — we try anyway)
    {
        const r = await request('GET', `${BASE}/admin/metrics`, null, ADMIN_TOKEN || TOKEN);
        record('TC-ADM-01', 'Get Admin Metrics', r.status === 200, r.status, JSON.stringify(r.body).substring(0, 100));
    }

    // ═══ PHASE 13: SECURITY & MIDDLEWARE ════════════════════════════════════════
    console.log('\n── PHASE 13: Security & Middleware ──\n');

    // TC-MW-05: Helmet Headers
    {
        const r = await request('GET', `${BASE_ROOT}/health`);
        const hasHelmet = !!(r.headers['x-content-type-options'] || r.headers['x-frame-options'] || r.headers['x-dns-prefetch-control']);
        record('TC-MW-05', 'Helmet Security Headers', hasHelmet, r.status, `x-content-type-options=${r.headers['x-content-type-options'] || 'missing'}`);
    }

    // TC-MW-03: Sensitive data check  
    {
        const r = await request('GET', `${BASE}/auth/me`, null, TOKEN);
        const body = JSON.stringify(r.body);
        const noPassword = !body.includes(TEST_PASSWORD) && !body.includes('$2b$');
        record('SEC-03', 'No password in /me response', noPassword, r.status);
    }

    // ═══ CLEANUP: Delete test user ═════════════════════════════════════════════
    console.log('\n── CLEANUP ──\n');

    {
        const r = await request('DELETE', `${BASE}/auth/account`, null, TOKEN);
        record('TC-AUTH-14', 'Delete Account (cleanup)', r.status === 200, r.status);
    }

    // ═══ SUMMARY ═══════════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  TEST RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');

    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;

    console.log(`\n  Total:  ${total}`);
    console.log(`  Passed: ${passed} ✅`);
    console.log(`  Failed: ${failed} ❌`);
    console.log(`  Pass Rate: ${((passed / total) * 100).toFixed(1)}%\n`);

    if (failed > 0) {
        console.log('  FAILED TESTS:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`    ❌ ${r.id}: ${r.name} [${r.status}] ${r.detail || ''}`);
        });
    }

    console.log('\n═══════════════════════════════════════════════════════════════');

    // Write results to file for the agent to read reliably
    const fs = require('fs');
    const report = {
        summary: { total, passed, failed, passRate: ((passed / total) * 100).toFixed(1) },
        results
    };
    fs.writeFileSync('test_report.json', JSON.stringify(report, null, 2));

    let textReport = `TEST RESULTS SUMMARY\nTotal: ${total}\nPassed: ${passed}\nFailed: ${failed}\nPass Rate: ${report.summary.passRate}%\n\n`;
    results.forEach(r => {
        textReport += `${r.passed ? '✅' : '❌'} ${r.id}: ${r.name} [${r.status}] ${r.detail || ''}\n`;
    });
    fs.writeFileSync('test_report.txt', textReport);
}

run().catch(console.error);
