import os
import random
from locust import HttpUser, task, between, events

class CloraAIUser(HttpUser):
    wait_time = between(1, 3)
    token = None
    client_ip = None

    def on_start(self):
        """Perform login and store JWT token."""
        # Generate a unique spoofed IP for this user to bypass rate limiting
        self.client_ip = f"{random.randint(1, 255)}.{random.randint(1, 255)}.{random.randint(1, 255)}.{random.randint(1, 255)}"
        
        email = "loadtest_1773401331540@cloraai.com"
        password = "Password123!"

        headers = {"X-Forwarded-For": self.client_ip}
        with self.client.post("/api/v1/auth/login", json={
            "email": email,
            "password": password
        }, headers=headers, catch_response=True) as response:
            if response.status_code == 200:
                data = response.json()
                if "data" in data and "token" in data["data"]:
                    self.token = data["data"]["token"]
                elif "token" in data:
                    self.token = data["token"]
                
                if self.token:
                    response.success()
                else:
                    response.failure("Login successful but no token found in response")
            else:
                response.failure(f"Login failed with status {response.status_code}: {response.text}")

    @task(3)
    def fetch_dashboard(self):
        """GET /api/v1/analytics/dashboard"""
        if not self.token:
            return
        
        headers = {
            "Authorization": f"Bearer {self.token}",
            "X-Forwarded-For": self.client_ip
        }
        self.client.get("/api/v1/analytics/dashboard", headers=headers)

    @task(2)
    def generate_caption(self):
        """POST /api/v1/captions/generate"""
        if not self.token:
            return

        headers = {
            "Authorization": f"Bearer {self.token}",
            "X-Forwarded-For": self.client_ip
        }
        payload = {
            "topic": "Future of AI in Social Media",
            "tone": "professional",
            "length": "medium"
        }
        self.client.post("/api/v1/captions/generate", json=payload, headers=headers)

    @task(2)
    def fetch_instagram_analytics(self):
        """GET /api/v1/instagram/stats"""
        if not self.token:
            return

        headers = {
            "Authorization": f"Bearer {self.token}",
            "X-Forwarded-For": self.client_ip
        }
        self.client.get("/api/v1/instagram/stats", headers=headers)

    @task(1)
    def schedule_post(self):
        """POST /api/v1/scheduler/schedule"""
        if not self.token:
            return

        headers = {
            "Authorization": f"Bearer {self.token}",
            "X-Forwarded-For": self.client_ip
        }
        payload = {
            "caption": "Testing load capacity #CloraAI #SocialMediaAutomation",
            "mediaUrl": "https://cloraai.com/static/test-media.jpg",
            "publishInstantly": True
        }
        self.client.post("/api/v1/scheduler/schedule", json=payload, headers=headers)

@events.init_command_line_parser.add_listener
def _(parser):
    parser.add_argument("--test-email", type=str, env_var="LOCUST_TEST_EMAIL", default="cloraai3425@gmail.com")
    parser.add_argument("--test-password", type=str, env_var="LOCUST_TEST_PASSWORD", default="password123")
