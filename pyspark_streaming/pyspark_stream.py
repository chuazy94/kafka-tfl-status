import os
import sys
import xml.etree.ElementTree as ET
import psycopg2
from psycopg2.extras import execute_values
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, udf, explode
from pyspark.sql.types import ArrayType, StructType, StructField, StringType
from dotenv import load_dotenv

load_dotenv()

# Suppress BrokenPipeError from PySpark daemon (harmless cleanup noise)
import signal
signal.signal(signal.SIGPIPE, signal.SIG_DFL)

# Kafka Configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "localhost:9094")
KAFKA_TOPIC = os.getenv("KAFKA_TOPIC", "tube-prediction-timings-topic")

# PostgreSQL Configuration
PG_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", "localhost"),
    "port": os.getenv("POSTGRES_PORT", "5435"),
    "database": os.getenv("POSTGRES_DB", "tfl_trains"),
    "user": os.getenv("POSTGRES_USER", "tfl"),
    "password": os.getenv("POSTGRES_PASSWORD", "tfl_password"),
}

# Schema for parsed predictions
PREDICTION_SCHEMA = ArrayType(StructType([
    StructField("station_code", StringType(), True),
    StructField("station_name", StringType(), True),
    StructField("platform_name", StringType(), True),
    StructField("platform_code", StringType(), True),
    StructField("trip_number", StringType(), True),
    StructField("set_number", StringType(), True),
    StructField("time_to_station", StringType(), True),
    StructField("destination", StringType(), True),
    StructField("current_location", StringType(), True),
]))


def parse_tfl_xml(xml_string: str) -> list:
    """
    Parse TfL TrackerNet XML into list of prediction records.
    
    Example XML structure:
    <ROOT>
      <S Code="ABC" N="Station Name">
        <P N="Platform Name" Code="1">
          <T S="123" T="2" D="Destination" C="Northbound" L="Central"/>
        </P>
      </S>
    </ROOT>
    """
    if not xml_string:
        return []
    
    try:
        root = ET.fromstring(xml_string)
        predictions = []
        
        for station in root.findall('.//S'):
            station_code = station.get('Code', '')
            station_name = station.get('N', '')
            
            for platform in station.findall('.//P'):
                platform_name = platform.get('N', '')
                platform_code = platform.get('Code', '')
                
                for train in platform.findall('.//T'):
                    prediction = {
                        "station_code": station_code,
                        "station_name": station_name,
                        "platform_name": platform_name,
                        "platform_code": platform_code,
                        "trip_number": train.get('T', ''),
                        "set_number": train.get('S', ''),
                        "time_to_station": train.get('C', ''),
                        "destination": train.get('DE', ''),
                        "current_location": train.get('L', ''),
                    }
                    predictions.append(prediction)
        
        return predictions
    
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
        return []


def extract_line_code_from_headers(headers):
    """Extract line_code from Kafka message headers."""
    if not headers:
        return None
    for key, value in headers:
        if key == "line_code":
            return value.decode("utf-8") if isinstance(value, bytes) else value
    return None


def write_to_postgres(batch_df, batch_id):
    """Write a micro-batch DataFrame to PostgreSQL."""
    if batch_df.isEmpty():
        print(f"Batch {batch_id}: Empty batch, skipping...")
        return
    
    # Collect rows to driver
    rows = batch_df.collect()
    
    # Connect to PostgreSQL
    conn = psycopg2.connect(**PG_CONFIG)
    cursor = conn.cursor()
    
    insert_sql = """
        INSERT INTO train_positions (
            set_number, trip_number, line_code, station_code, station_name,
            platform_name, platform_code, current_location, time_to_station, destination
        ) VALUES %s
    """
    
    records = [
        (
            row.set_number,
            row.trip_number,
            row.line_code if hasattr(row, 'line_code') else None,
            row.station_code,
            row.station_name,
            row.platform_name,
            row.platform_code,
            row.current_location,
            row.time_to_station,
            row.destination,
        )
        for row in rows
    ]
    
    try:
        execute_values(cursor, insert_sql, records)
        conn.commit()
        print(f"Batch {batch_id}: Inserted {len(records)} records into PostgreSQL")
    except Exception as e:
        print(f"Batch {batch_id}: Error inserting records: {e}")
        conn.rollback()
    finally:
        cursor.close()
        conn.close()


def create_spark_session():
    """Create Spark session with Kafka dependencies."""
    # PySpark 4.x uses Scala 2.13
    return SparkSession.builder \
        .appName("TfL-Predictions-Consumer") \
        .config("spark.jars.packages", "org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.0") \
        .config("spark.sql.streaming.checkpointLocation", "./checkpoints") \
        .getOrCreate()


# Register UDF at module level for proper serialization
parse_xml_udf = udf(parse_tfl_xml, PREDICTION_SCHEMA)


def main():
    # Create Spark session
    spark = create_spark_session()
    spark.sparkContext.setLogLevel("ERROR")  # Reduce log noise
    
    print(f"Connecting to Kafka at {KAFKA_BOOTSTRAP_SERVERS}...")
    print(f"Subscribing to topic: {KAFKA_TOPIC}")
    print(f"Writing to PostgreSQL at {PG_CONFIG['host']}:{PG_CONFIG['port']}/{PG_CONFIG['database']}")
    
    # Read from Kafka (include headers for line_code)
    kafka_df = spark.readStream \
        .format("kafka") \
        .option("kafka.bootstrap.servers", KAFKA_BOOTSTRAP_SERVERS) \
        .option("subscribe", KAFKA_TOPIC) \
        .option("startingOffsets", "latest") \
        .option("kafka.group.id", "tfl-pyspark-consumer") \
        .option("includeHeaders", "true") \
        .load()
    
    # Parse XML using distributed UDF and explode into individual prediction records
    # Also extract line_code from headers
    parsed_df = kafka_df \
        .selectExpr(
            "CAST(value AS STRING) as xml_content",
            "headers"
        ) \
        .withColumn("predictions", parse_xml_udf(col("xml_content"))) \
        .select(
            explode(col("predictions")).alias("prediction"),
            col("headers")
        ) \
        .select(
            col("prediction.station_code").alias("station_code"),
            col("prediction.station_name").alias("station_name"),
            col("prediction.platform_name").alias("platform_name"),
            col("prediction.platform_code").alias("platform_code"),
            col("prediction.trip_number").alias("trip_number"),
            col("prediction.set_number").alias("set_number"),
            col("prediction.time_to_station").alias("time_to_station"),
            col("prediction.destination").alias("destination"),
            col("prediction.current_location").alias("current_location"),
            # Extract line_code from headers array
            col("headers").getItem(1).getItem("value").cast("string").alias("line_code"),
        )
    
    # Write to PostgreSQL using foreachBatch
    query = parsed_df.writeStream \
        .foreachBatch(write_to_postgres) \
        .outputMode("append") \
        .trigger(processingTime="10 seconds") \
        .start()
    
    print("Streaming started! Press Ctrl+C to stop...")
    
    try:
        query.awaitTermination()
    except KeyboardInterrupt:
        print("\nStopping stream...")
        query.stop()
        spark.stop()
        print("Stream stopped gracefully.")


if __name__ == "__main__":
    main()
