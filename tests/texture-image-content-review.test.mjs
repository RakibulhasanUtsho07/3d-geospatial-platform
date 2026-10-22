import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { reviewTextureImageContent } from "../src/core/building-generation/texture-image-content-review.mjs";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYsAAAAASUVORK5CYII=", "base64");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name=Buffer.from(type,"ascii"),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,checksum]);
}

function pngRgba(width,height) {
  const header=Buffer.alloc(13);
  header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc(height*(width*4+1));
  for(let y=0;y<height;y++){
    const start=y*(width*4+1);rows[start]=0;
    for(let x=0;x<width;x++){
      const p=start+1+x*4;rows[p]=x*10;rows[p+1]=y*10;rows[p+2]=100;rows[p+3]=255;
    }
  }
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk("IHDR",header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND",Buffer.alloc(0)),
  ]);
}

test("inspects PNG dimensions and reports tiny texture resolution as a review risk", () => {
  const report = reviewTextureImageContent(onePixelPng,"image/png");
  assert.equal(report.format,"png");
  assert.equal(report.width,1);
  assert.equal(report.height,1);
  assert.ok(report.risks.includes("low-resolution-texture-review"));
  assert.ok(["sampled-8bit-png","invalid-png-data","unsupported-png-layout"].includes(report.pixelAnalysis));
});

test("does not pretend unsupported image formats have decoded pixel statistics", () => {
  const report = reviewTextureImageContent(Buffer.from([1,2,3]),"image/jpeg");
  assert.equal(report.pixelAnalysis,"not-available");
  assert.ok(report.risks.includes("pixel-content-not-analysed-for-this-image-format"));
});

test("returns decoded pixel bytes only when the caller explicitly requests bounded in-memory data", () => {
  const bytes = pngRgba(4,3);
  const ordinary = reviewTextureImageContent(bytes,"image/png");
  assert.equal(ordinary.pixelData,undefined);
  const decoded = reviewTextureImageContent(bytes,"image/png",{includePixelData:true,maxPixelDataPixels:20});
  assert.equal(decoded.pixelData.width,4);
  assert.equal(decoded.pixelData.height,3);
  assert.equal(decoded.pixelData.channels,4);
  assert.equal(decoded.pixelData.colorType,6);
  assert.equal(Buffer.isBuffer(decoded.pixelData.pixels),true);
  assert.equal(decoded.pixelData.pixels.length,4*3*4);
  const budgeted = reviewTextureImageContent(bytes,"image/png",{includePixelData:true,maxPixelDataPixels:8});
  assert.equal(budgeted.pixelData,undefined);
});

test("rejects invalid analysis configuration", () => {
  assert.throws(()=>reviewTextureImageContent(onePixelPng,"image/png",{maxPixels:0}),/maxPixels/);
  assert.throws(()=>reviewTextureImageContent(onePixelPng,"image/png",{minRecommendedDimension:0}),/minRecommendedDimension/);
});
