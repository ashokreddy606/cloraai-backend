const http = require('http');

const PORT = process.env.PORT || 3000;

const sendRequest = (options, postData) => {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, body: data });
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
};

async function runTests() {
    console.log('--- Starting Crash Audit Tests on /api/auth/register ---');

    // Test 1: No body parser (missing Content-Type)
    console.log('\n[Test 1] Missing Content-Type (undefined req.body)');
    const res1 = await sendRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/auth/register',
        method: 'POST',
    }, 'random data not json');
    console.log('Status:', res1.statusCode);
    console.log('Response:', res1.body);

    // Test 2: Empty JSON body
    console.log('\n[Test 2] Empty JSON body {}');
    const res2 = await sendRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, '{}');
    console.log('Status:', res2.statusCode);
    console.log('Response:', res2.body);

    // Test 3: Invalid JSON syntax (body parser crash test)
    console.log('\n[Test 3] Invalid JSON syntax');
    const res3 = await sendRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, '{"email": "test@test.com", "password": "123');
    console.log('Status:', res3.statusCode);
    console.log('Response:', res3.body);

    // Test 4: Missing required fields (Zod validation test)
    console.log('\n[Test 4] Missing required fields');
    const res4 = await sendRequest({
        hostname: 'localhost',
        port: PORT,
        path: '/api/auth/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ email: 'test@test.com' }));
    console.log('Status:', res4.statusCode);
    console.log('Response:', res4.body);

    console.log('\n--- All Tests Completed ---');
}

runTests().catch(console.error);
