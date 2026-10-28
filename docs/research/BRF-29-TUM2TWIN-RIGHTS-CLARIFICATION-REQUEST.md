# BRF-29 — TUM2TWIN rights clarification request packet

**Status: DRAFT — NOT SENT.** This packet records the current source observations and provides a ready-to-send request. It does not establish permission, identify the legally authorized grantor, or approve any asset.

## Why clarification is necessary

The [TUM2TWIN UAS photo page](https://tum2t.win/datasets/im-uas), [UAS laser-scan page](https://tum2t.win/datasets/pc-uas), and [UAS photogrammetry page](https://tum2t.win/datasets/pc-uasp) describe their datasets as openly available, but those pages do not display per-asset licence terms or the full set of downstream uses requested for this platform. The current [Zenodo record version 1.2.0](https://zenodo.org/records/15282970) was published 25 April 2025 and lists the source files below; its visible Rights area shows a “License” heading without a licence value. Zenodo's [permission guidance](https://support.zenodo.org/help/en-gb/2-content/21-can-i-get-permission-to-use-a-specific-record) states that reuse depends on the record's licence and that Zenodo does not own uploader-submitted content.

The project homepage publishes benedikt.schwab@tum.de and olaf.wysocki@tum.de under “Contribute”; the TUM Remote Sensing Applications dataset page publishes info.rsa@ed.tum.de. These are contact routes only; the recipient's authority over every listed asset must be confirmed.

## Ready-to-send email

**To:** benedikt.schwab@tum.de; olaf.wysocki@tum.de  
**CC:** info.rsa@ed.tum.de  
**Subject:** Clarification of reuse licence and derivative-model permissions for TUM2TWIN TUM Downtown dataset

Dear TUM2TWIN team,

I am developing a 3D geospatial building-reconstruction engine. I would like to evaluate whether selected TUM Downtown UAS photographs, laser-scanning/photogrammetry data, and related reference products can be used as a reproducible engineering and geometry-validation benchmark.

The Zenodo record [UAV Laser Scanning and Photogrammetry of TUM Downtown Campus, version 1.2.0](https://zenodo.org/records/15282970; DOI 10.5281/zenodo.15282970) is marked “Dataset Open”, and the TUM2TWIN pages describe the data as openly available. However, the visible Rights field on that Zenodo version does not show a licence value, so I do not want to assume the scope of permission.

Could you please confirm the applicable licence or written permission, and the authority of the grantor, separately for the exact asset families in the attached inventory: (1) UAS photos/Images.zip, (2) photogrammetry and ULS LAZ point clouds, (3) DSM/orthophoto/mesh products and textures, (4) trajectory/metadata/documentation, and (5) any CityGML/LOD2/LOD3 building models or modelling projects in the separate TUM2TWIN model repository?

For each applicable asset family, could you please indicate which of these uses are permitted: private local download/inspection; scientific and metric validation; geometry extraction and creation of derived meshes/GLBs/textures; public interactive display/hosting/caching on a website; commercial use; redistribution of original source bytes; and redistribution or display of derived models, textures and renders. Please also state required attribution, share-alike or other derivative obligations, restrictions, effective/expiry dates if applicable, and whether the imagery, point clouds and reference model can be mapped to one named building ID.

A licence URL or written response that clearly identifies covered files/version and the permitted scopes would be very helpful. We will preserve provenance and attribution and will not use the assets in the reconstruction workflow until the rights and requested uses have been reviewed. If another person or office is responsible for granting these permissions, could you please direct me to the appropriate contact?

Thank you for your time and for maintaining the dataset.

Best regards,  
[Your name]  
[Project or organization, if applicable]  
[Contact information]

## Asset inventory and response intake

The machine-readable register is `benchmarks/building-reconstruction/brf-29-tum2twin-rights-clarification.json`. It enumerates the 14 files shown by Zenodo, preserves its displayed MD5 values only as catalogue metadata, leaves local SHA-256/byte counts blank until authorized acquisition, and sets every rights decision to `pending`.

Use one answer per asset family rather than a blanket “open data” response. If a licence covers a group of files, record that exact covered set and record/version. The separate CityGML/LOD model repository needs an independent rights answer.

## Gate

Until the written response is received, mapped to the exact files, checked for grantor authority, archived and reviewed, all real TUM input gates remain blocked. Do not download or feed the listed source bytes to reconstruction on the basis of this draft. Any later acquisition must compute local SHA-256 and exact byte size, bind each file to the permission evidence, establish same-building correspondence, and keep the four release flags false pending independent metric and human review.
