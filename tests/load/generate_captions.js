import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// Custom metrics to track specific performance data
const responseTimeTrend = new Trend('api_response_time');
const failureRate = new Rate('api_failure_rate');

/**
 * TEST SCENARIO CONFIGURATION
 * ---------------------------
 * Stage 1: Warm-up (10 users, 30s)
 * Stage 2: Moderate Load (50 users, 1m)
 * Stage 3: Launch Simulation (100 users, 2m)
 * Stage 4: Stress Test (200 users, 2m)
 */
export const options = {
    stages: [
        { duration: '30s', target: 10 },  // Stage 1: Warm-up
        { duration: '1m', target: 50 },   // Stage 2: Moderate Load
        { duration: '2m', target: 100 },  // Stage 3: Launch Simulation
        { duration: '2m', target: 200 },  // Stage 4: Stress Test
        { duration: '30s', target: 0 },   // Cool down
    ],
    thresholds: {
        // p95 response time must be under 1 second
        'http_req_duration': ['p(95)<1000'],
        // API response time custom trend percentile check
        'api_response_time': ['p(95)<1000', 'p(99)<2000'],
        // Error rate must be under 2%
        'api_failure_rate': ['rate<0.02'],
        // Standard http error rate check
        'http_req_failed': ['rate<0.02'],
    },
};

// Configuration constants
const BASE_URL = __ENV.API_BASE_URL || 'https://cloraai-backend-production.up.railway.app';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || 'YOUR_PRODUCTION_BEARER_TOKEN';

// List of prompts to randomize testing
const prompts = [
    "Generate Instagram caption for sunset beach photo",
    "Short witty caption for a coffee shop morning",
    "Professional LinkedIn post about AI productivity",
    "Engaging TikTok description for a travel vlog",
    "Casual Facebook status for a weekend hike",
    "Motivational quote for a gym workout photo",
    "Funny caption for a cat being lazy",
    "Elegant caption for a wedding anniversary",
    "Creative description for a new tech gadget",
    "Minimalist caption for an urban architecture shot"
];

const platforms = ["instagram", "linkedin", "tiktok", "facebook", "twitter"];
const tones = ["engaging", "professional", "witty", "motivational", "casual"];

/**
 * Main Virtual User (VU) function
 */
export default function () {
    // Randomly select parameters for each request
    const prompt = prompts[Math.floor(Math.random() * prompts.length)];
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    const tone = tones[Math.floor(Math.random() * tones.length)];

    const url = `${BASE_URL}/api/captions/generate`;

    const payload = JSON.stringify({
        prompt: prompt,
        platform: platform,
        tone: tone
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AUTH_TOKEN}`,
        },
        timeout: '25s', // Slightly higher than the 20s OpenAI timeout
    };

    // Perform the POST request
    const res = http.post(url, payload, params);

    // Track metrics
    responseTimeTrend.add(res.timings.duration);

    // Verify response
    const success = check(res, {
        'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
        'has generated content': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body && (body.caption || body.text || body.data);
            } catch (e) {
                return false;
            }
        },
    });

    // Record failure if check fails
    if (!success) {
        failureRate.add(1);
        console.error(`Request failed! Status: ${res.status}, Body: ${res.body}`);
    } else {
        failureRate.add(0);
    }

    // Sleep between 1 to 3 seconds to simulate human behavior
    sleep(Math.random() * 2 + 1);
}

/**
 * Summary output formatting
 */
export function handleSummary(data) {
    return {
        'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    };
}

// Simple text summary helper (often provided by k6-utils but defined here for portability)
function textSummary(data, options) {
    const { metrics } = data;
    const totalReqs = metrics.http_reqs ? metrics.http_reqs.values.count : 0;
    const failedReqs = metrics.http_req_failed ? metrics.http_req_failed.values.passes : 0;
    const avgResponse = metrics.http_req_duration ? metrics.http_req_duration.values.avg.toFixed(2) : 0;
    const maxResponse = metrics.http_req_duration ? metrics.http_req_duration.values.max.toFixed(2) : 0;

    return `
==============================================================
CloraAI Load Test Summary
==============================================================
Total Requests:    ${totalReqs}
Failed Requests:   ${failedReqs} (${((failedReqs / totalReqs) * 100).toFixed(2)}%)
Avg Response Time: ${avgResponse} ms
Max Response Time: ${maxResponse} ms
--------------------------------------------------------------
Check status indicators in the k6 breakdown above for p95/p99.
==============================================================
`;
}
