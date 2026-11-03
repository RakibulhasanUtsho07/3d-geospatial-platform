# BRF-46 — Per-source operation-scope gate

**Status: implementation / test in progress.** This contract narrows workflow permission by operation; it does not grant rights, interpret a licence, prove ownership, prove same-building identity, validate geometry accuracy, or enable publication.

## Problem

The media workflow previously recorded a general operator rights confirmation and a non-empty licence string. Downstream workers checked that broad state, but did not require the source record and normalized BuildingSpec to name the particular reconstruction operations being performed. A source approved only for private ingestion could therefore be presented to a reconstruction worker with the same broad usageStatus.

## Operation vocabulary

Every source admitted to the media-to-model workflow must declare permittedOperations, containing one or more distinct values from this fixed list:

- private-media-ingestion
- private-image-quality-preflight
- video-frame-extraction
- procedural-model-derivation
- single-image-ai-reconstruction
- photogrammetry-reconstruction
- texture-baking

The source-review CLI records the operator's explicit scoped attestation next to the exact source bytes' SHA-256 and timestamp. A string in this field is an attestation, not independent legal verification; only scopes genuinely supported by an applicable licence or written permission may be selected.

## Operation matrix

| Operation | Required scope(s) |
|---|---|
| Local intake through media-to-model workflow | private-media-ingestion |
| Video frame extraction | video-frame-extraction in addition to intake |
| Procedural candidate generation | procedural-model-derivation |
| Single-image AI reconstruction | single-image-ai-reconstruction |
| COLMAP multi-view reconstruction and texturing | photogrammetry-reconstruction and texture-baking |

Unknown values, empty lists, duplicate values, absent scope declarations, BuildingSpec/source-record mismatches, and missing strategy scopes fail closed. Operation scopes are copied to the normalized BuildingSpec and stage/source summaries so the model-generation stage fingerprint changes when a scope changes. Cached source records are checked against their stored scope declaration.

Derived video frames inherit the parent video record's stated scopes and identify the parent source. A frame-extraction operation is rejected before FFmpeg starts unless the parent record explicitly includes video-frame-extraction.

## Validation

The BRF-46 contract uses synthetic/local fixtures to test scope enforcement at:
- explicit source review and BuildingSpec normalization;
- media-to-model preflight, selected-source validation and cached-stage consistency;
- direct single-image AI and direct COLMAP worker entry points;
- CLI argument exposure for repeatable per-source scope declarations.

These tests establish code behavior only. They do not grant any new TUM2TWIN, GT-LOD3, or other third-party rights. Real sources stay blocked unless their exact rights evidence independently authorizes the intended scopes.

## Release boundary

The workflow still emits review candidates only. acceptanceEligible, publicationEligible, mapReady, and automaticApproval remain false. No production map placement, commercial release, accuracy claim, or merge to main is authorized by this change.
