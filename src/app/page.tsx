import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-white">
      <section className="w-full max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          3D Geospatial Platform
        </p>

        <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-6xl">
          A modular foundation for the 3D world.
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-sm leading-7 text-zinc-400 md:text-base">
          A future-ready geospatial platform built around modular
          rendering, spatial data, streaming 3D content, and
          standards-based architecture.
        </p>

        <div className="mt-8">
          <Link
            href="/map"
            className="inline-flex rounded-xl border border-white/10 bg-white px-5 py-3 text-sm font-medium text-black transition hover:bg-zinc-200"
          >
            Open 3D Map
          </Link>
        </div>
      </section>
    </main>
  );
}