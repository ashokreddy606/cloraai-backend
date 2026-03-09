import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics to track specific requirements
const errorRate = new Rate('error_rate');

export const options = {
    // 2. Stages for increasing traffic
    stages: [
        { duration: '30s', target: 10 },  // 10 users for 30 seconds
        { duration: '1m', target: 50 },   // 50 users for 1 minute
        { duration: '2m', target: 100 },  // 100 users for 2 minutes
        { duration: '2m', target: 200 },  // 200 users for 2 minutes
    ],
    // 5. Thresholds
    thresholds: {
        'http_req_duration': ['p(95)<1000'], // p95 latency must stay below 1000 ms
        'error_rate': ['rate<0.02'],         // error rate must stay below 2%
    },
};

// 3. Example prompt pool
const promptPool = [
    "Sunset beach Instagram caption",
    "Travel vlog caption",
    "Coffee aesthetic caption",
    "Fitness motivation caption",
    "Nature photography caption"
];

export default function () {
    const url = 'https://api.cloraai.com/api/captions/generate';

    // Randomly select a prompt from the pool
    const prompt = promptPool[Math.floor(Math.random() * promptPool.length)];

    const payload = JSON.stringify({
        prompt: prompt,
        platform: 'instagram',
        tone: 'engaging'
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer TEST_TOKEN',
        },
    };

    // 3. Send POST request
    const res = http.post(url, payload, params);

    // 6. Log API error if status != 200
    const success = check(res, {
        'status is 200': (r) => r.status === 200,
    });

    if (!success) {
        console.error(`Request failed! Status: ${res.status}, Body: ${res.body}, Prompt: ${prompt}`);
        errorRate.add(1);
    } else {
        errorRate.add(0);
    }

    // 3. Sleep between 1–2 seconds between requests
    sleep(Math.random() * 1 + 1);
}
