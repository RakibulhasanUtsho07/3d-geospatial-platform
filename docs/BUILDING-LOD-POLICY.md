# Building LOD Policy

## Purpose

Keep camera-driven detail-selection policy separate from Cesium graphics mutations. The adapter still owns Cesium camera reads, entity styling, material/cache lifecycle and render requests.

## Policy boundary

- `shouldRecomputeBuildingLod` decides whether camera origin movement, an explicit force flag or a changed facade-detail budget requires recalculation.
- `selectDetailedBuildingRecords` applies the existing bounded nearest-record ordering and selected-building override.
- A budget of zero is valid at high altitude. No unselected buildings receive detailed facade graphics at that budget.
- A selected building with the geometry needed to render its facade stays detailed even when it falls outside the budget. A selected record without a center or wall positions is not forced into the detailed set.

## Verification

Run `npm run test:building-lod-policy`. Existing selector parity, facade budget, map optimization and browser/API tests remain in the CI path.

This is a policy extraction and edge-case fix, not a measured claim about FPS or rendering latency.
