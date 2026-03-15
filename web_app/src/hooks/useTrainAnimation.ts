"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface TrainFeature {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: {
    id: number;
    set_number: string;
    line_code: string;
    location_type?: string;
    from_lat: number;
    from_lng: number;
    to_lat: number | null;
    to_lng: number | null;
    time_to_station_seconds: number | null;
    data_timestamp: string;
    [key: string]: unknown;
  };
}

interface TrainGeoJSON {
  type: "FeatureCollection";
  features: TrainFeature[];
}

interface AnimatedTrain {
  id: string;
  // Current displayed position (written back each frame so fetches blend from it)
  currentLng: number;
  currentLat: number;
  // Dead-reckoning params from the latest API response
  fromLng: number;
  fromLat: number;
  toLng: number | null;
  toLat: number | null;
  timeToStationSeconds: number | null;
  dataTimestampMs: number;
  // Predicted departure: the next station when currently at platform
  predictedNextLng: number | null;
  predictedNextLat: number | null;
  predictedTravelTime: number | null;
  // Blend state: smoothly reconcile display position when new data arrives
  blendFromLng: number;
  blendFromLat: number;
  blendStartTime: number; // ms epoch; 0 = no blend active
  lastSeenMs: number;     // when this train was last present in an API response
  stale: boolean;         // true if train wasn't in the most recent API response
  properties: TrainFeature["properties"];
}

const FETCH_INTERVAL = 30000;          // ms between API polls (TfL API updates every ~30s)
const BLEND_DURATION = 1500;           // ms to blend display position after new data arrives
const TRAIN_RETENTION_MS = 90000;      // keep stale trains for 90s before removing
const OVERLAP_OFFSET = 0.00015;        // ~15m offset for overlapping trains
const PLATFORM_DWELL_MS = 30000;       // start predicted departure after 30s at platform
const PREDICTED_DEPARTURE_CAP = 0.35;  // don't predict beyond 35% of the way to next station

function computeDeadReckonedPosition(train: AnimatedTrain, nowMs: number): [number, number] {
  const { fromLng, fromLat, toLng, toLat, timeToStationSeconds, dataTimestampMs } = train;

  // Normal dead-reckoning: train is moving toward a known destination with an ETA
  if (toLng !== null && toLat !== null && timeToStationSeconds !== null && timeToStationSeconds > 0) {
    const elapsedSeconds = Math.max(0, (nowMs - dataTimestampMs) / 1000);
    const fraction = Math.min(1, elapsedSeconds / timeToStationSeconds);
    return [
      fromLng + (toLng - fromLng) * fraction,
      fromLat + (toLat - fromLat) * fraction,
    ];
  }

  // Train at platform with predicted next station: after dwell, start moving
  if (timeToStationSeconds === null && train.predictedNextLng !== null && train.predictedNextLat !== null) {
    const dwellMs = nowMs - dataTimestampMs;
    if (dwellMs > PLATFORM_DWELL_MS) {
      const travelTime = train.predictedTravelTime ?? 120;
      const departureElapsed = (dwellMs - PLATFORM_DWELL_MS) / 1000;
      const fraction = Math.min(PREDICTED_DEPARTURE_CAP, departureElapsed / travelTime);
      return [
        fromLng + (train.predictedNextLng - fromLng) * fraction,
        fromLat + (train.predictedNextLat - fromLat) * fraction,
      ];
    }
  }

  return [fromLng, fromLat];
}

export function useTrainAnimation(lineFilter?: string) {
  const [animatedTrains, setAnimatedTrains] = useState<AnimatedTrain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestTimestamp, setLatestTimestamp] = useState<string | null>(null);

  const trainsRef = useRef<Map<string, AnimatedTrain>>(new Map());
  const animationFrameRef = useRef<number | null>(null);
  const prevFilterRef = useRef<string | undefined>(lineFilter);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Clear all trains and abort in-flight fetch when the line filter changes
  if (prevFilterRef.current !== lineFilter) {
    trainsRef.current = new Map();
    prevFilterRef.current = lineFilter;
    abortControllerRef.current?.abort();
    setIsLoading(true);
  }

  const fetchTrains = useCallback(async () => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const url = lineFilter ? `/api/trains?line=${lineFilter}` : "/api/trains";
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("Failed to fetch trains");

      const data: TrainGeoJSON = await response.json();
      const now = Date.now();
      const newTrainsMap = new Map<string, AnimatedTrain>();

      for (const feature of data.features) {
        const trainId = `${feature.properties.set_number}-${feature.properties.line_code}`;
        const [lng, lat] = feature.geometry.coordinates;

        const fromLng = feature.properties.from_lng ?? lng;
        const fromLat = feature.properties.from_lat ?? lat;
        const toLng = feature.properties.to_lng ?? null;
        const toLat = feature.properties.to_lat ?? null;
        const timeToStationSeconds = feature.properties.time_to_station_seconds ?? null;
        const predictedNextLng = (feature.properties.predicted_next_lng as number) ?? null;
        const predictedNextLat = (feature.properties.predicted_next_lat as number) ?? null;
        const predictedTravelTime = (feature.properties.predicted_travel_time as number) ?? null;
        const dataTimestampMs = feature.properties.data_timestamp
          ? new Date(feature.properties.data_timestamp).getTime()
          : now;

        const existingTrain = trainsRef.current.get(trainId);

        if (existingTrain) {
          const sameDestination =
            existingTrain.properties.station_name === feature.properties.station_name;

          const canCompareETAs =
            existingTrain.timeToStationSeconds !== null && timeToStationSeconds !== null;

          if (sameDestination && canCompareETAs) {
            const oldETA =
              existingTrain.dataTimestampMs + existingTrain.timeToStationSeconds! * 1000;
            const newETA = dataTimestampMs + timeToStationSeconds! * 1000;
            const etaShiftMs = Math.abs(newETA - oldETA);

            if (etaShiftMs < 20000) {
              newTrainsMap.set(trainId, {
                ...existingTrain,
                predictedNextLng, predictedNextLat, predictedTravelTime,
                lastSeenMs: now,
                stale: false,
                properties: feature.properties,
              });
            } else {
              const [currentDRLng, currentDRLat] = computeDeadReckonedPosition(
                existingTrain,
                now
              );
              const remainingSeconds = Math.max(0, (newETA - now) / 1000);
              newTrainsMap.set(trainId, {
                ...existingTrain,
                fromLng: currentDRLng,
                fromLat: currentDRLat,
                toLng,
                toLat,
                dataTimestampMs: now,
                timeToStationSeconds: remainingSeconds,
                predictedNextLng, predictedNextLat, predictedTravelTime,
                blendStartTime: 0,
                lastSeenMs: now,
                stale: false,
                properties: feature.properties,
              });
            }
          } else {
            newTrainsMap.set(trainId, {
              ...existingTrain,
              fromLng,
              fromLat,
              toLng,
              toLat,
              timeToStationSeconds,
              dataTimestampMs,
              predictedNextLng, predictedNextLat, predictedTravelTime,
              blendFromLng: existingTrain.currentLng,
              blendFromLat: existingTrain.currentLat,
              blendStartTime: now,
              lastSeenMs: now,
              stale: false,
              properties: feature.properties,
            });
          }
        } else {
          const staleTrain = trainsRef.current.get(trainId);
          if (staleTrain && staleTrain.stale) {
            newTrainsMap.set(trainId, {
              ...staleTrain,
              fromLng,
              fromLat,
              toLng,
              toLat,
              timeToStationSeconds,
              dataTimestampMs,
              predictedNextLng, predictedNextLat, predictedTravelTime,
              blendFromLng: staleTrain.currentLng,
              blendFromLat: staleTrain.currentLat,
              blendStartTime: now,
              lastSeenMs: now,
              stale: false,
              properties: feature.properties,
            });
          } else {
            const [initialLng, initialLat] = computeDeadReckonedPosition(
              { fromLng, fromLat, toLng, toLat, timeToStationSeconds, dataTimestampMs, predictedNextLng, predictedNextLat, predictedTravelTime } as AnimatedTrain,
              now
            );
            newTrainsMap.set(trainId, {
              id: trainId,
              currentLng: initialLng,
              currentLat: initialLat,
              fromLng,
              fromLat,
              toLng,
              toLat,
              timeToStationSeconds,
              dataTimestampMs,
              predictedNextLng, predictedNextLat, predictedTravelTime,
              blendFromLng: initialLng,
              blendFromLat: initialLat,
              blendStartTime: 0,
              lastSeenMs: now,
              stale: false,
              properties: feature.properties,
            });
          }
        }
      }

      // Retain trains not in this response for a grace period.
      // When filtering by line, don't retain trains from other lines (avoids stale cross-line display).
      for (const [existingId, existingTrain] of trainsRef.current) {
        if (!newTrainsMap.has(existingId)) {
          if (lineFilter && existingTrain.properties.line_code !== lineFilter) continue;
          if (now - existingTrain.lastSeenMs < TRAIN_RETENTION_MS) {
            newTrainsMap.set(existingId, { ...existingTrain, stale: true });
          }
        }
      }

      trainsRef.current = newTrainsMap;

      if (data.features.length > 0) {
        const maxTs = data.features.reduce((max, f) => {
          const ts = f.properties.data_timestamp;
          return ts > max ? ts : max;
        }, data.features[0].properties.data_timestamp);
        setLatestTimestamp(maxTs);
      }

      setIsLoading(false);
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setIsLoading(false);
    }
  }, [lineFilter]);

  const animate = useCallback(() => {
    const now = Date.now();
    const updatedTrains: AnimatedTrain[] = [];

    trainsRef.current.forEach((train, id) => {
      const [drLng, drLat] = computeDeadReckonedPosition(train, now);

      let currentLng: number;
      let currentLat: number;

      if (train.blendStartTime > 0) {
        const blendElapsed = now - train.blendStartTime;
        const blendProgress = Math.min(1, blendElapsed / BLEND_DURATION);
        // Ease-out quad: fast at start, smooth finish
        const eased = 1 - Math.pow(1 - blendProgress, 2);
        currentLng = train.blendFromLng + (drLng - train.blendFromLng) * eased;
        currentLat = train.blendFromLat + (drLat - train.blendFromLat) * eased;
      } else {
        currentLng = drLng;
        currentLat = drLat;
      }

      // Write current displayed position back to the ref so the next fetch
      // blends from where the train is actually shown, not a stale API position
      const updatedTrain: AnimatedTrain = { ...train, currentLng, currentLat };
      trainsRef.current.set(id, updatedTrain);
      updatedTrains.push(updatedTrain);
    });

    setAnimatedTrains(updatedTrains);
    animationFrameRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    animate();
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [animate]);

  useEffect(() => {
    fetchTrains();
    const interval = setInterval(fetchTrains, FETCH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchTrains]);

  // Group trains by approximate location to detect overlaps
  const locationGroups = new Map<string, AnimatedTrain[]>();
  for (const train of animatedTrains) {
    const key = `${train.currentLng.toFixed(4)},${train.currentLat.toFixed(4)}`;
    const group = locationGroups.get(key) || [];
    group.push(train);
    locationGroups.set(key, group);
  }

  const geoFeatures: TrainGeoJSON["features"] = [];
  for (const group of locationGroups.values()) {
    if (group.length === 1) {
      geoFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [group[0].currentLng, group[0].currentLat] },
        properties: { ...group[0].properties, overlap_count: 1 },
      });
    } else {
      const angleStep = (2 * Math.PI) / group.length;
      for (let i = 0; i < group.length; i++) {
        const angle = angleStep * i - Math.PI / 2;
        geoFeatures.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [
              group[i].currentLng + Math.cos(angle) * OVERLAP_OFFSET,
              group[i].currentLat + Math.sin(angle) * OVERLAP_OFFSET,
            ],
          },
          properties: { ...group[i].properties, overlap_count: group.length },
        });
      }
    }
  }

  const trainsGeoJSON: TrainGeoJSON = {
    type: "FeatureCollection",
    features: geoFeatures,
  };

  return {
    trains: trainsGeoJSON,
    isLoading,
    error,
    trainCount: animatedTrains.length,
    latestTimestamp,
    refetch: fetchTrains,
  };
}
