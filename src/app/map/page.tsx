"use client";

import { useCallback, useState } from "react";
import type { BuildingVisualStyle } from "@/core/buildings/building-style";
import type { MapFeatureSelection } from "@/core/map-engine/types";
import MapCanvas from "@/features/map/components/MapCanvas";
import ArchitectureResearchPanel from "@/features/map/components/ArchitectureResearchPanel";

type StylePreviewRequest = {
  revision: number;
  style: BuildingVisualStyle | null;
  title?: string;
};

export default function MapPage() {
  const [selectedBuilding, setSelectedBuilding] = useState<MapFeatureSelection | null>(null);
  const [stylePreviewRequest, setStylePreviewRequest] = useState<StylePreviewRequest | null>(null);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [previewStatusMessage, setPreviewStatusMessage] = useState<string | null>(null);

  const handleSelectedFeatureChange = useCallback((feature: MapFeatureSelection | null) => {
    setSelectedBuilding(feature);
    setPreviewActive(false);
    setPreviewTitle(null);
    setPreviewStatusMessage(null);
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
      title: "Original procedural style",
    }));
  }, []);

  const handleStylePreviewResult = useCallback((applied: boolean, request: StylePreviewRequest) => {
    if (!applied) {
      setPreviewActive(false);
      setPreviewTitle(null);
      setPreviewStatusMessage("Select a 3D building on the map, then try the preview again.");
      return;
    }
    setPreviewActive(request.style !== null);
    setPreviewTitle(request.style === null ? null : (request.title ?? "Architecture style"));
    setPreviewStatusMessage(
      request.style === null
        ? "Restored the selected building's source-driven/default procedural style."
        : "Temporary visual preview applied. This does not verify the selected building has this real-world facade.",
    );
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-6">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1800px] flex-col gap-4">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-700">
            Geospatial Platform
          </p>

          <h1 className="mt-1 text-2xl font-semibold text-slate-950">
            3D Map
          </h1>
        </header>

        <section className="min-h-0 flex-1">
          <MapCanvas
            onSelectedFeatureChange={handleSelectedFeatureChange}
            stylePreviewRequest={stylePreviewRequest}
            onStylePreviewResult={handleStylePreviewResult}
          />
        </section>

        <ArchitectureResearchPanel
          canPreview={Boolean(selectedBuilding)}
          isPreviewActive={previewActive}
          previewTitle={previewTitle}
          onPreview={requestStylePreview}
          onResetPreview={requestStyleReset}
        />
        {previewStatusMessage && (
          <p role="status" className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            {previewStatusMessage}
          </p>
        )}
      </div>
    </main>
  );
}