# Tripo V3 image and multiview generation

## Scope

The media-to-model workflow exposes an explicit `strategy: "tripo-image"` route for the paid Tripo V3 image-to-model and multiview-to-model APIs. This is separate from:

- `single-image-ai`: the locally installed TripoSR worker;
- `photogrammetry`: local COLMAP reconstruction from three or more reviewed views;
- `tripo-text`: paid Tripo text-to-model generation;
- `procedural`: deterministic BuildingSpec-based geometry.

The new route is never selected by `auto` and is not a fallback. The caller must request it directly.

## Permissions and consent

Before generation, the operator must:

1. Attest the licence/permission basis for every ingested source (`confirmRights: true`).
2. Grant the selected image/video-frame sources the distinct `external-provider-image-generation` permitted operation.
3. Set `confirmExternalProviderProcessing: true` after acknowledging that selected image bytes will be sent to Tripo.
4. Set `allowPaidProviderGeneration: true` to authorise the paid provider call.
5. Configure `TRIPO_API_KEY` on the server. Never pass an API key from a browser.

The worker re-reads the approved source records and verifies the BuildingSpec source identity, usage status, licence, operation scopes, regular-file path and SHA-256 before upload. It uploads the bytes via the Tripo File Upload API and passes only provider-issued `file_token` values to generation endpoints; it does not ask Tripo to fetch arbitrary source URLs.

## Single image

Select exactly one ingested image or extracted video frame:

```js
await runMediaToModelWorkflow({
  workspaceRoot,
  buildingSpec,
  jobId: "building-image-candidate-01",
  strategy: "tripo-image",
  sources: [{
    sourceId: "front-photo",
    relativePath: "uploads/front-photo.png",
    licence: "CC BY 4.0",
    permittedOperations: [
      "private-media-ingestion",
      "external-provider-image-generation"
    ]
  }],
  viewSourceIds: ["front-photo"],
  confirmRights: true,
  confirmExternalProviderProcessing: true,
  allowPaidProviderGeneration: true
});
```

This invokes `POST /v3/generation/image-to-model`.

## Labelled multi-view

Select two to four actual views of the same physical building. The front view is mandatory and every selected source must be labelled exactly once using `viewLabels`:

```js
viewSourceIds: ["front-photo", "left-photo", "rear-photo"],
viewLabels: {
  front: "front-photo",
  left: "left-photo",
  back: "rear-photo"
}
```

Only the supported labels `front`, `left`, `back`, and `right` are accepted. The selected IDs must equal the IDs in the label map; labels are not inferred from filenames or image metadata. This invokes `POST /v3/generation/multiview-to-model`. Do not supply unrelated buildings or AI-generated side views as if they were independent photographs.

## Input and output constraints

- The Tripo file-upload route accepts JPEG/PNG source images up to 20 MiB each.
- Video inputs must first pass the existing video-frame extraction and rights workflow. Only selected extracted frames are sent to Tripo.
- The server pins the H-series model to `v3.1-20260211` by default (or another explicitly allowed pinned version).
- Task polling is bounded. Download URLs are restricted to HTTPS `cdn.tripo3d.ai`, redirects are rejected, and model downloads are capped at 500 MiB.
- The downloaded GLB must pass the current structural geometry QA before it is saved as a candidate.

## Review boundary

The result is reported as `ai-proposed` and `completed-requires-review`. The report stores the selected source IDs, SHA-256 hashes, operation permissions, view labels, provider task ID, output hash and geometry QA. It explicitly records:

- metric alignment: `not-run`;
- georeference: `not-solved`;
- `mapReady: false`;
- `publicationEligible: false`;
- `automaticApproval: false`.

A multiview input may improve visual coverage, but it does not by itself establish measured scale, facade bearing, unseen/hidden geometry, survey accuracy or WGS84 placement. Human visual review and independent measurements/control points remain mandatory before any map publication.

## Provider references

- [Tripo V3 File Upload](https://developers.tripo3d.ai/en/docs/files)
- [Tripo V3 Image to 3D Model — H Series](https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard)
- [Tripo V3 Multiview to 3D Model — H Series](https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard)
