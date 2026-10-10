import MapCanvas from "@/features/map/components/MapCanvas";
import ArchitectureResearchPanel from "@/features/map/components/ArchitectureResearchPanel";

export default function MapPage() {
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
          <MapCanvas />
        </section>

        <ArchitectureResearchPanel />
      </div>
    </main>
  );
}