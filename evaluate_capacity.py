import pandas as pd
import json
import sys
import os

def analyze_performance(csv_prefix):
    stats_file = f"{csv_prefix}_stats.csv"
    
    if not os.path.exists(stats_file):
        print(f"Error: Stats file {stats_file} not found.")
        return

    df = pd.read_csv(stats_file)
    
    # Filter for Aggregated Total Row
    total_stats = df[df['Name'] == 'Aggregated'].iloc[0]
    
    avg_response_time = total_stats['Average Response Time']
    p95_response_time = total_stats['95%']
    rps = total_stats['Requests/s']
    error_rate = (total_stats['Failure Count'] / total_stats['Request Count']) * 100 if total_stats['Request Count'] > 0 else 0
    
    # Simple Rating Logic
    rating = 10
    if error_rate > 1: rating -= 2
    if error_rate > 5: rating -= 3
    if avg_response_time > 500: rating -= 1
    if avg_response_time > 1000: rating -= 2
    if p95_response_time > 2000: rating -= 1
    rating = max(1, rating)
    
    # Capacity Estimation (very rough heuristic based on latency and error rate)
    # If error rate is low, we assume we haven't hit the limit.
    # If error rate is high, we assume we are past the limit.
    concurrency_env = os.getenv("LOCUST_USERS", "100")
    try:
        users = int(concurrency_env)
    except:
        users = 100
        
    est_max_capacity = "Unknown (Test did not reach saturation)"
    if error_rate > 2:
        est_max_capacity = f"Around {users} concurrent users"
    elif rating > 8:
        est_max_capacity = f"Exceeds {users} concurrent users"

    # Bottleneck Analysis
    bottlenecks = []
    if error_rate > 5:
        bottlenecks.append("System is failing under load. Check backend logs and database connection pool.")
    if p95_response_time > 3000:
        bottlenecks.append("High tail latency detect. Possible database indexing issues or synchronous blocking operations.")
    
    # Recommendations
    recommendations = [
        "Enable horizontal scaling for the Express backend on Railway.",
        "Implement Redis caching for dashboard and analytics endpoints.",
        "Optimize MongoDB indexes for frequently queried fields.",
        "Offload AI generation and post scheduling to background workers if not already fully decoupled."
    ]

    report = {
        "Overall Rating": f"{rating}/10",
        "Average Response Time": f"{avg_response_time:.2f} ms",
        "95th Percentile": f"{p95_response_time:.2f} ms",
        "Requests Per Second": f"{rps:.2f}",
        "Error Rate": f"{error_rate:.2f}%",
        "Estimated Max Capacity": est_max_capacity,
        "Bottleneck Analysis": bottlenecks if bottlenecks else ["No major bottlenecks identified within current test bounds."],
        "Recommendations": recommendations
    }

    print("\n--- CLORAAI PERFORMANCE SUMMARY ---")
    print(json.dumps(report, indent=4))
    
    with open("performance_report.json", "w") as f:
        json.dump(report, f, indent=4)
    print("\nReport saved to performance_report.json")

if __name__ == "__main__":
    prefix = sys.argv[1] if len(sys.argv) > 1 else "load_test_results"
    analyze_performance(prefix)
