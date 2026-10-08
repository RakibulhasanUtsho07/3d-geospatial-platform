import MapCanvas from "@/features/map/components/MapCanvas";

export default function MapPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-4 text-white md:p-6">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1800px] flex-col gap-4">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Geospatial Platform
          </p>

          <h1 className="mt-1 text-2xl font-semibold">
            3D Map
          </h1>
        </header>

        <section className="min-h-0 flex-1">
          <MapCanvas />
        </section>
      </div>
    </main>
  );
}