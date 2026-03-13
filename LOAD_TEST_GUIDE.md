# CloraAI Load Testing Guide

This guide explains how to run the load testing setup for the CloraAI backend.

## Prerequisites

1.  **Python 3.x** installed.
2.  Install required Python packages:
    ```bash
    pip install locust pandas
    ```

## Step 1: Configure Credentials

Set your test account credentials as environment variables or pass them as arguments.

**Windows (PowerShell):**
```powershell
$env:LOCUST_TEST_EMAIL = "your-test-email@gmail.com"
$env:LOCUST_TEST_PASSWORD = "your-test-password"
```

## Step 2: Run the Load Test

Run Locust in headless mode to simulate up to 10,000 users with a spawn rate of 100 users/second for 10 minutes. Replace `<BACKEND_URL>` with your actual Railway backend URL (e.g., `https://backend-production.up.railway.app`).

```bash
locust -f locustfile.py --headless -u 10000 -r 100 --run-time 10m --host <BACKEND_URL> --csv load_test_results
```

*Note: For testing locally or with fewer users first:*
```bash
locust -f locustfile.py --headless -u 10 -r 2 --run-time 1m --host http://localhost:3000 --csv load_test_results
```

## Step 3: Evaluate Performance

After the test completes, run the evaluation script to generate a summary report.

```bash
python evaluate_capacity.py load_test_results
```

The script will output a performance rating and save the details to `performance_report.json`.

## Endpoints Tested

-   **Login**: `POST /api/v1/auth/login`
-   **Dashboard**: `GET /api/v1/analytics/dashboard`
-   **AI Caption**: `POST /api/v1/captions/generate`
-   **Instagram Stats**: `GET /api/v1/instagram/stats`
-   **Schedule Post**: `POST /api/v1/scheduler/schedule`
