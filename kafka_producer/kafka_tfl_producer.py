import requests
import time
import logging
from confluent_kafka import Producer
from datetime import datetime
from dotenv import load_dotenv
import os

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9094")
KAFKA_TOPIC = "tube-prediction-timings-topic"
TFL_API_BASE = "https://api.tfl.gov.uk/TrackerNet/PredictionSummary"
TFL_APP_KEY = os.getenv("TFL_APP_KEY")
# TfL Line codes
TUBE_LINES = ["B", "C", "D", "H", "J", "M", "N", "P", "V", "W"]
# B=Bakerloo, C=Central, D=District, H=Hammersmith, J=Jubilee,
# M=Metropolitan, N=Northern, P=Piccadilly, V=Victoria, W=Waterloo

def create_producer():
    "Create a Kafka producer"
    return Producer({
        "bootstrap.servers": KAFKA_BOOTSTRAP_SERVERS,
        "client.id": "tube-tube-producer",
        "acks": "all",  # Wait for all replicas
        "retries": 3,
        "retry.backoff.ms": 1000,
    })

def delivery_callback(err, msg):
    if err:
        logging.error(f"Delivery failed for message: {msg.value()}: {err}")
    else:
        logging.info(f"Message delivered to {msg.topic()} [{msg.partition()}] at offset {msg.offset()}")

def get_tube_predictions(station_code):
    url = f"{TFL_API_BASE}/{station_code}"
    headers = {"app_key": TFL_APP_KEY}

    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        logger.info(f"Response received for {station_code}: {response.text[:10]}...")
        return response.text
    except requests.exceptions.RequestException as e:
        logging.error(f"Error fetching predictions for {station_code}: {e}")
        return None

def produce_to_kafka(producer: Producer, line_code: str, message: str ):
    """Send XML message to Kafka"""
    line = line_code
    headers = [
        ("source", b"tube-tube-producer"),
        ("line_code", line.encode("utf-8")),
        ("timestamp", datetime.now().isoformat().encode("utf-8")),
        ("content-type", b"application/xml"),
    ]
    producer.produce(topic=KAFKA_TOPIC, value=message.encode("utf-8"), headers=headers, callback=delivery_callback)
    producer.poll(0)

def main():
    "Main producer loop"
    producer = create_producer()
    try:
        while True:
            for line in TUBE_LINES:
                predictions = get_tube_predictions(line)
                if predictions:
                    produce_to_kafka(producer, line, predictions)
                    logger.info(f"Produced message to {KAFKA_TOPIC} for line {line}")
            # Flush to ensure all messages in this batch are delivered
            producer.flush()
            time.sleep(30)
    except KeyboardInterrupt:
        logger.info("Shutting down producer...")
    finally:
        # Ensure any remaining messages are sent before exiting
        producer.flush()
        logger.info("Producer shutdown complete")

if __name__ == "__main__":
    main()