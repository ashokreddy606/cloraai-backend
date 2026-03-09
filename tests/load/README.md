# CloraAI Load Testing Guide

This guide explains how to install k6, run the load testing script, and interpret the results for the CloraAI backend API.

## 1. Installing k6

k6 is a modern load testing tool that uses JavaScript.

### Windows (using winget)
```powershell
winget install k6
```

### macOS (using Homebrew)
```bash
brew install k6
```

### Linux (Ubuntu/Debian)
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

## 2. Running the Load Test

The load test script is located at `backend/tests/load/generate_captions.js`.

### Basic Execution
Open a terminal in the project root and run:
```bash
k6 run backend/tests/load/generate_captions.js
```

### Production Execution with Environment Variables
To test your production API, pass the `API_BASE_URL` and `AUTH_TOKEN`:
```bash
k6 run -e API_BASE_URL=https://cloraai-backend-production.up.railway.app -e AUTH_TOKEN=your_jwt_token_here backend/tests/load/generate_captions.js
```

### Simulation Stages
The script automatically follows these stages:
1. **Warm-up**: 10 users for 30 seconds
2. **Moderate**: 50 users for 1 minute
3. **Launch Simulation**: 100 users for 2 minutes
4. **Stress Test**: 200 users for 2 minutes

## 3. Interpreting the Results

After the test completes, k6 will print a summary. Here is how to read it:

### Key Metrics to Watch
- **Total Requests**: Total number of POST calls made during the test.
- **Failed Requests**: Number of requests that didn't return a 200/201 status or failed internal validation.
- **p95 Response Time**: 95% of requests were completed within this time. Our threshold is **< 1 second**.
- **p99 Response Time**: 99% of requests were completed within this time. useful for spotting outliers.
- **Thresholds**: If k6 shows a red checkmark next to a threshold (like `http_req_duration`), it means the performance goal was **NOT** met.

### Success Criteria
- **Pass**: All thresholds are green, error rate is < 2%, and p95 is < 1s.
- **Warning**: p95 exceeds 1s but stays under 3s. Consider scaling Redis or increasing worker concurrency.
- **Fail**: Error rate > 2% or p95 > 5s. This indicates the system is bottlenecked (likely by OpenAI API limits or MongoDB connection pool).

### Troubleshooting
- **Internal 500 Errors**: Check backend logs on Railway. Likely related to Redis connection timeouts or database locks.
- **Request Timeouts**: If response times skyrocket, verify that BullMQ workers are actually processing jobs and not stuck in a restart loop.
