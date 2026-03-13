const axios = require('axios');

async function registerLoadTestUser() {
    const email = `loadtest_${Date.now()}@cloraai.com`;
    const password = 'Password123!';
    try {
        const response = await axios.post('https://cloraai-backend-production.up.railway.app/api/v1/auth/register', {
            email: email,
            password: password,
            username: `loadtest_${Date.now()}`,
            tosAccepted: true
        });
        console.log('User registered successfully');
        console.log(`EMAIL=${email}`);
        console.log(`PASSWORD=${password}`);
    } catch (error) {
        console.error('Registration failed:', error.response ? error.response.data : error.message);
        // If it fails because of CORS or something else, I'll try localhost if it's running
    }
}

registerLoadTestUser();
