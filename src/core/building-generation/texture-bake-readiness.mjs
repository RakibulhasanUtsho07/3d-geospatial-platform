const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sha256Pattern = /^[a-f0-9]{64}$/i;

export function assessTextureBakeReadiness(candidate, options = {}) {
  if (!candidate || !Array.isArray(candidate.images) || !Array.isArray(candidate.materials) || !Array.isArray(candidate.faces)) {
    throw new TypeError("candidate must contain images, materials and faces arrays");
  }
  const atlasWidth = options.atlasWidth ?? 2048;
  const atlasHeight = options.atlasHeight ?? 2048;
  if (![atlasWidth, atlasHeight].every((n) => Number.isInteger(n) && n > 0)) {
    throw new RangeError("atlas dimensions must be positive integers");
  }
  const images = new Map();
  const materials = new Map();
  const duplicateIds = [];
  for (const image of candidate.images) {
    if (!image || typeof image.id !== "string" || !image.id || images.has(image.id)) {
      duplicateIds.push(image?.id ?? null);
      continue;
    }
    images.set(image.id, image);
  }
  for (const material of candidate.materials) {
    if (!material || typeof material.id !== "string" || !material.id || materials.has(material.id)) {
      duplicateIds.push(material?.id ?? null);
      continue;
    }
    materials.set(material.id, material);
  }

  const faceIssues = [];
  const eligible = [];
  const imageUsage = new Map();
  const materialUsage = new Map();
  const uvRects = [];
  candidate.faces.forEach((face, index) => {
    const reasons = [];
    if (!face || !Array.isArray(face.uv) || face.uv.length !== 3 ||
      face.uv.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((n) => !finite(n) || n < 0 || n > 1))) {
      reasons.push("uv-missing-invalid-or-out-of-range");
    }
    const image = images.get(face?.sourceImageId);
    if (!image) reasons.push("source-image-not-found");
    else {
      if (image.verifiedSource !== true) reasons.push("source-image-not-verified");
      if (!sha256Pattern.test(image.sha256 ?? "")) reasons.push("source-image-hash-invalid");
      if (!Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1) reasons.push("source-image-dimensions-invalid");
      imageUsage.set(image.id, (imageUsage.get(image.id) ?? 0) + 1);
    }
    const material = materials.get(face?.materialId);
    if (!material) reasons.push("material-not-found");
    else {
      if (typeof material.name !== "string" || !material.name.trim()) reasons.push("material-name-missing");
      if (material.reviewed !== true) reasons.push("material-not-reviewed");
      materialUsage.set(material.id, (materialUsage.get(material.id) ?? 0) + 1);
    }
    if (reasons.length) faceIssues.push({ index, reasons });
    else {
      eligible.push(index);
      const us = face.uv.map((p) => p[0]);
      const vs = face.uv.map((p) => p[1]);
      uvRects.push({ index, minU: Math.min(...us), maxU: Math.max(...us), minV: Math.min(...vs), maxV: Math.max(...vs) });
    }
  });
  const overlapCandidates = [];
  for (let i = 0; i < uvRects.length; i++) {
    for (let j = i + 1; j < uvRects.length; j++) {
      const a = uvRects[i], b = uvRects[j];
      const overlapU = Math.min(a.maxU, b.maxU) - Math.max(a.minU, b.minU);
      const overlapV = Math.min(a.maxV, b.maxV) - Math.max(a.minV, b.minV);
      if (overlapU > 1e-9 && overlapV > 1e-9) {
        overlapCandidates.push({ faceIndices: [a.index, b.index], type: "uv-bounding-box-overlap-candidate", requiresExactTriangleIntersectionCheck: true });
      }
    }
  }
  const blockers = [];
  if (duplicateIds.length) blockers.push("duplicate-image-or-material-ids");
  if (faceIssues.length) blockers.push("faces-have-missing-or-unreviewed-inputs");
  if (candidate.faces.length === 0) blockers.push("no-faces-to-bake");
  if (eligible.length !== candidate.faces.length) blockers.push("not-all-faces-eligible");
  if (overlapCandidates.length) blockers.push("uv-overlap-candidates-require-review");
  return {
    schemaVersion: "1.0.0",
    status: blockers.length ? "review-required" : "bake-inputs-ready-for-external-baker",
    atlas: { width: atlasWidth, height: atlasHeight, format: "not-yet-generated" },
    faceCount: candidate.faces.length,
    eligibleFaceIndices: eligible,
    faceIssues,
    overlapCandidates,
    imageUsage: [...imageUsage].map(([imageId, faces]) => ({ imageId, faces })),
    materialUsage: [...materialUsage].map(([materialId, faces]) => ({ materialId, faces })),
    blockers,
    policy: {
      rasterTextureGenerated: false,
      atlasPacked: false,
      uvIslandsAutomaticallyRepacked: false,
      overlapBoundingBoxesAreNotProofOfTriangleOverlap: true,
      missingPixelsSynthesized: false,
      publicationEligible: false,
    },
    limitations: [
      "UV bounding-box overlap is only a candidate signal; exact triangle intersection and intentional texture sharing need separate review.",
      "This is a preflight report, not a texture baker, atlas packer or visual seam detector.",
      "Passing preflight does not establish visual fidelity or real-building accuracy.",
    ],
    publicationEligible: false,
  };
}
