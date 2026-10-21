import { NextResponse } from "next/server";

import catalogueJson from "../../../../../data/research/dhaka-building-reference-catalog.json";
import {
  filterArchitectureReferences,
  parseArchitectureResearchParams,
  resolveArchitectureMediaPreview,
  summarizeArchitectureReferences,
} from "@/core/geospatial/architecture-research.mjs";
import type { ArchitectureResearchReference } from "@/core/geospatial/architecture-research.mjs";

type Catalogue = {
  researchedAt?: string;
  references?: ArchitectureResearchReference[];
};

const catalogue = catalogueJson as Catalogue;
const references = Array.isArray(catalogue.references) ? catalogue.references : [];

export function GET(request: Request): Response {
  const parsed = parseArchitectureResearchParams(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const filtered = filterArchitectureReferences(references, parsed.value);
  const summary = summarizeArchitectureReferences(references);
  const results = filtered
    .slice(0, parsed.value.limit)
    .map((reference) => ({
      ...reference,
      ...resolveArchitectureMediaPreview(reference),
    }));

  return NextResponse.json(
    {
      dataStatus: "curated-research",
      researchedAt: catalogue.researchedAt ?? null,
      totalMatches: filtered.length,
      returnedCount: results.length,
      limit: parsed.value.limit,
      summary,
      results,
      notice: "Curated research references are not a complete inventory of Dhaka buildings. Colour swatches are estimated; exact-building identity and imagery reuse rights vary by record.",
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=900",
        "X-Architecture-Reference-Count": String(results.length),
        "X-Architecture-Total-Matches": String(filtered.length),
      },
    },
  );
}
