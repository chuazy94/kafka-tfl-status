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
  // Blend state: smoothly reconcile display position when new data arrives
  blendFromLng: number;
  blendFromLat: number;
  blendStartTime: number; // ms epoch; 0 = no blend active
  properties: TrainFeature["properties"];
}

const FETCH_INTERVAL = 10000; // ms between API polls
const BLEND_DURATION = 1500;  // ms to blend display position after new data arrives

function computeDeadReckonedPosition(train: AnimatedTrain, nowMs: number): [number, number] {
  const { fromLng, fromLat, toLng, toLat, timeToStationSeconds, dataTimestampMs } = train;

  if (toLng === null || toLat === null || timeToStationSeconds === null) {
    return [fromLng, fromLat];
  }

  if (timeToStationSeconds <= 0) {
    // Train is at the destination station
    return [toLng, toLat];
  }

  const elapsedSeconds = Math.max(0, (nowMs - dataTimestampMs) / 1000);
  const fraction = Math.min(1, elapsedSeconds / timeToStationSeconds);
  return [
    fromLng + (toLng - fromLng) * fraction,
    fromLat + (toLat - fromLat) * fraction,
  ];
}

export function useTrainAnimation(lineFilter?: string) {
  const [animatedTrains, setAnimatedTrains] = useState<AnimatedTrain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestTimestamp, setLatestTimestamp] = useState<string | null>(null);

  const trainsRef = useRef<Map<string, AnimatedTrain>>(new Map());
  const animationFrameRef = useRef<number | null>(null);

  const fetchTrains = useCallback(async () => {
    try {
      const url = lineFilter ? `/api/trains?line=${lineFilter}` : "/api/trains";
      const response = await fetch(url);
      if (!response.ok) throw new Error("Failed to fetch trains");

      const data: TrainGeoJSON = await response.json();
      const now = Date.now();
      const newTrainsMap = new Map<string, AnimatedTrain>();

      for (const feature of data.features) {
        const trainId = feature.properties.set_number;
        const [lng, lat] = feature.geometry.coordinates;

        const fromLng = feature.properties.from_lng ?? lng;
        const fromLat = feature.properties.from_lat ?? lat;
        const toLng = feature.properties.to_lng ?? null;
        const toLat = feature.properties.to_lat ?? null;
        const timeToStationSeconds = feature.properties.time_to_station_seconds ?? null;
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
              // Same destination, on schedule — continue the existing trajectory unchanged.
              // The train is already moving correctly; touching the DR params would cause a jump.
              newTrainsMap.set(trainId, {
                ...existingTrain,
                properties: feature.properties,
              });
            } else {
              // Same destination but TfL's timing estimate shifted (train delayed/early).
              // Re-anchor from the current displayed position so there is no visual jump.
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
                blendStartTime: 0,
                properties: feature.properties,
              });
            }
          } else {
            // Destination changed (train moved to the next leg) or timing unavailable.
            // Blend smoothly from the current displayed position to the new DR position.
            newTrainsMap.set(trainId, {
              ...existingTrain,
              fromLng,
              fromLat,
              toLng,
              toLat,
              timeToStationSeconds,
              dataTimestampMs,
              blendFromLng: existingTrain.currentLng,
              blendFromLat: existingTrain.currentLat,
              blendStartTime: now,
              properties: feature.properties,
            });
          }
        } else {
          // New train: compute where it should be right now and place it there immediately
          const [initialLng, initialLat] = computeDeadReckonedPosition(
            { fromLng, fromLat, toLng, toLat, timeToStationSeconds, dataTimestampMs } as AnimatedTrain,
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
            blendFromLng: initialLng,
            blendFromLat: initialLat,
            blendStartTime: 0,
            properties: feature.properties,
          });
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

  const trainsGeoJSON: TrainGeoJSON = {
    type: "FeatureCollection",
    features: animatedTrains.map((train) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [train.currentLng, train.currentLat],
      },
      properties: train.properties,
    })),
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
