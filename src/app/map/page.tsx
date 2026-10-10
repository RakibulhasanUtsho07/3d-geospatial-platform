"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { BuildingVisualStyle } from "@/core/buildings/building-style";
import type { ArchitectureResearchReference } from "@/core/geospatial/architecture-research.mjs";
import type {
  BuildingStyleAssignment,
  MapFeatureSelection,
} from "@/core/map-engine/types";
import MapCanvas from "@/features/map/components/MapCanvas";
import ArchitectureResearchPanel from "@/features/map/components/ArchitectureResearchPanel";

type StylePreviewRequest = {
  revision: number;
  style: BuildingVisualStyle | null;
  title?: string;
};

const ASSIGNMENT_STORAGE_KEY = "3d-geospatial-platform:building-style-assignments:v1";
const VALID_PATTERNS = new Set<BuildingVisualStyle["pattern"]>([
  "balcony",
  "vertical-glass",
  "urban-grid",
  "compact",
  "heritage-arches",
  "painted-balcony",
  "biophilic-balcony",
  "brick-modernist",
]);
const VALID_ROOF_DETAILS = new Set<BuildingVisualStyle["roofDetail"]>([
  "water-tank",
  "hvac-unit",
  "roof-garden",
  "roof-terrace",
  "none",
]);
const VALID_MATERIAL_PATTERNS = new Set([
  "brick",
  "plaster",
  "glass",
  "stone",
  "weathered",
  "painted",
]);

function getSelectedFeatureId(feature: MapFeatureSelection | null): string | null {
  if (!feature) return null;
  const value = feature.properties.overture_feature_id;
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 512);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function parseSavedAssignments(serialized: string | null): BuildingStyleAssignment[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    const safe: BuildingStyleAssignment[] = [];
    const seen = new Set<string>();

    for (const candidate of parsed) {
      if (!isRecord(candidate) || !isRecord(candidate.style)) continue;
      const style = candidate.style;
      const featureId = typeof candidate.featureId === "string" ? candidate.featureId.trim() : "";
      const referenceId = typeof candidate.referenceId === "string" ? candidate.referenceId.trim() : "";
      const referenceTitle = typeof candidate.referenceTitle === "string" ? candidate.referenceTitle.trim() : "";
      const sourceUrl = typeof candidate.sourceUrl === "string" ? candidate.sourceUrl : "";
      const usageStatus = typeof candidate.usageStatus === "string" ? candidate.usageStatus : "";
      const assignedAt = typeof candidate.assignedAt === "string" ? candidate.assignedAt : "";
      let safeSourceUrl: URL | null = null;
      try {
        safeSourceUrl = new URL(sourceUrl);
      } catch {
        safeSourceUrl = null;
      }

      if (
        !featureId || featureId.length > 512 ||
        !referenceId || referenceId.length > 100 ||
        !referenceTitle || referenceTitle.length > 240 ||
        !safeSourceUrl || safeSourceUrl.protocol !== "https:" ||
        !usageStatus || !assignedAt ||
        typeof style.id !== "string" ||
        !isHexColor(style.facadeColor) ||
        !isHexColor(style.roofColor) ||
        !isHexColor(style.accentColor) ||
        !VALID_PATTERNS.has(style.pattern as BuildingVisualStyle["pattern"]) ||
        !VALID_ROOF_DETAILS.has(style.roofDetail as BuildingVisualStyle["roofDetail"]) ||
        typeof style.repeatWidthMeters !== "number" ||
        !Number.isFinite(style.repeatWidthMeters) ||
        style.repeatWidthMeters < 1 ||
        style.repeatWidthMeters > 16
      ) {
        continue;
      }

      if (
        style.materialPattern !== undefined &&
        (typeof style.materialPattern !== "string" || !VALID_MATERIAL_PATTERNS.has(style.materialPattern))
      ) continue;
      if (style.windowFrameColor !== undefined && !isHexColor(style.windowFrameColor)) continue;
      if (style.slabColor !== undefined && !isHexColor(style.slabColor)) continue;
      if (style.windowBayCount !== undefined && (
        typeof style.windowBayCount !== "number" ||
        !Number.isInteger(style.windowBayCount) ||
        style.windowBayCount < 2 ||
        style.windowBayCount > 5
      )) continue;

      if (seen.has(featureId)) continue;
      seen.add(featureId);
      safe.push({
        featureId,
        referenceId,
        referenceTitle,
        sourceUrl: safeSourceUrl.toString(),
        license: typeof candidate.license === "string" ? candidate.license.slice(0, 240) : null,
        usageStatus: usageStatus.slice(0, 240),
        assignedAt,
        style: style as unknown as BuildingVisualStyle,
      });
      if (safe.length >= 400) break;
    }
    return safe;
  } catch {
    return [];
  }
}

export default function MapPage() {
  const [selectedBuilding, setSelectedBuilding] = useState<MapFeatureSelection | null>(null);
  const [stylePreviewRequest, setStylePreviewRequest] = useState<StylePreviewRequest | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [previewStatusMessage, setPreviewStatusMessage] = useState<string | null>(null);
  const [savedAssignments, setSavedAssignments] = useState<BuildingStyleAssignment[]>([]);
  const [assignmentsLoaded, setAssignmentsLoaded] = useState(false);
  const selectedBuildingIdRef = useRef<string | null>(null);

  useEffect(() => {
    let assignments: BuildingStyleAssignment[] = [];
    try {
      assignments = parseSavedAssignments(window.localStorage.getItem(ASSIGNMENT_STORAGE_KEY));
    } catch {
      assignments = [];
    }
    setSavedAssignments(assignments);
    setAssignmentsLoaded(true);
  }, []);

  useEffect(() => {
    if (!assignmentsLoaded) return;
    try {
      window.localStorage.setItem(ASSIGNMENT_STORAGE_KEY, JSON.stringify(savedAssignments));
    } catch (error: unknown) {
      console.warn(
        "[Architecture profiles] Could not persist local assignments.",
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [savedAssignments, assignmentsLoaded]);

  const handleSelectedFeatureChange = useCallback((feature: MapFeatureSelection | null) => {
    const nextId = getSelectedFeatureId(feature);
    const identityChanged = selectedBuildingIdRef.current !== nextId;
    selectedBuildingIdRef.current = nextId;
    setSelectedBuilding(feature);
    if (identityChanged) {
      setPreviewActive(false);
      setPreviewTitle(null);
      setPreviewStatusMessage(null);
    }
  }, []);

  const requestStylePreview = useCallback((style: BuildingVisualStyle, title: string) => {
    setStylePreviewRequest((previous) => ({
      revision: (previous?.revision ?? 0) + 1,
      style,
      title,
    }));
    setPreviewStatusMessage(null);
  }, []);

  const requestStyleReset = useCallback(() => {
    setStylePreviewRequest((previous) => ({
      revision: (previous?.revision ?? 0) + 1,
      style: null,
      title: "Saved / source-derived style",
    }));
  }, []);

  const handleStylePreviewResult = useCallback((applied: boolean, request: StylePreviewRequest) => {
    if (!applied) {
      setPreviewActive(false);
      setPreviewTitle(null);
      setPreviewStatusMessage("Select an Overture 3D building on the map, then try the preview again.");
      return;
    }
    setPreviewActive(request.style !== null);
    setPreviewTitle(request.style === null ? null : (request.title ?? "Architecture style"));
    setPreviewStatusMessage(
      request.style === null
        ? "Restored this building's saved profile or its source-driven procedural style."
        : "Temporary visual preview applied. Use Apply & save to keep it attached to this building ID.",
    );
  }, []);

  const selectedBuildingId = getSelectedFeatureId(selectedBuilding);
  const selectedAssignment = selectedBuildingId
    ? savedAssignments.find((assignment) => assignment.featureId === selectedBuildingId) ?? null
    : null;

  const assignResearchProfile = useCallback((
    reference: ArchitectureResearchReference,
    style: BuildingVisualStyle,
  ) => {
    const featureId = getSelectedFeatureId(selectedBuilding);
    if (!featureId) {
      setPreviewStatusMessage("Select a building from the local Overture 3D layer before saving a research profile.");
      return;
    }
    if (reference.mediaType !== "image") {
      setPreviewStatusMessage("Video records contain broad street context; they cannot be saved as an individual building facade.");
      return;
    }

    const assignment: BuildingStyleAssignment = {
      featureId,
      referenceId: reference.id,
      referenceTitle: reference.title,
      sourceUrl: reference.sourceUrl,
      license: reference.license ?? null,
      usageStatus: reference.usageStatus,
      assignedAt: new Date().toISOString(),
      style: { ...style, fullHeightTexture: true },
    };
    setSavedAssignments((current) => [
      assignment,
      ...current.filter((item) => item.featureId !== featureId),
    ].slice(0, 400));
    setPreviewActive(false);
    setPreviewTitle(null);
    setPreviewStatusMessage(
      "Saved " + reference.id + " (" + reference.title + ") to building ID " + featureId +
      ". The profile will be applied again in this browser after reload. Match status is user-confirmed, not survey-verified; imagery rights remain " + reference.usageStatus + ".",
    );
  }, [selectedBuilding]);

  const removeSavedProfile = useCallback(() => {
    const featureId = getSelectedFeatureId(selectedBuilding);
    if (!featureId) return;
    setSavedAssignments((current) => current.filter((assignment) => assignment.featureId !== featureId));
    setPreviewActive(false);
    setPreviewTitle(null);
    setPreviewStatusMessage(
      "Removed the saved research profile from building ID " + featureId +
      ". Its source-driven/default procedural style is restored.",
    );
  }, [selectedBuilding]);

  return (
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-6">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1800px] flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-700">
              Geospatial Platform
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950">
              3D Map
            </h1>
          </div>
          <p className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
            {savedAssignments.length} saved architecture profile{savedAssignments.length === 1 ? "" : "s"} · this browser
          </p>
        </header>

        <section className="min-h-0 flex-1">
          <MapCanvas
            onSelectedFeatureChange={handleSelectedFeatureChange}
            stylePreviewRequest={stylePreviewRequest}
            styleAssignments={savedAssignments}
            onStylePreviewResult={handleStylePreviewResult}
          />
        </section>

        <ArchitectureResearchPanel
          canPreview={Boolean(selectedBuildingId)}
          isPreviewActive={previewActive}
          previewTitle={previewTitle}
          selectedAssignment={selectedAssignment}
          onPreview={requestStylePreview}
          onAssign={assignResearchProfile}
          onRemoveAssignment={removeSavedProfile}
          onResetPreview={requestStyleReset}
        />

        {previewStatusMessage && (
          <p role="status" className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-5 text-blue-900">
            {previewStatusMessage}
          </p>
        )}
      </div>
    </main>
  );
}
