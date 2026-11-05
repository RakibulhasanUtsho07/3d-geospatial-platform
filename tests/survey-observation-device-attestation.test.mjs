import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify as verifyRawEd25519 } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseTrustedSurveyDeviceRegistry, createSurveyObservationDeviceAttestation,
  verifySurveyObservationDeviceAttestation, surveyObservationDeviceAttestationPath,
  surveyObservationDeviceAttestationSigningBytes,
} from "../src/core/building-generation/survey-observation-device-attestation.mjs";

const ISSUED="2026-11-01T00:00:00.000Z", FROM=ISSUED, EXPIRES="2026-12-01T00:00:00.000Z";
const NOW="2026-11-05T13:00:00.000Z", SIGNED="2026-11-05T12:00:00.000Z";
const recordBytes=Buffer.from([0,82,73,78,69,88,255,16]);
const controlPointManifestBytes=Buffer.from('{"schemaVersion":"1.2.0"}');
function keys(){const p=generateKeyPairSync("ed25519");return {privateKeyPem:p.privateKey.export({type:"pkcs8",format:"pem"}).toString(),publicKeyPem:p.publicKey.export({type:"spki",format:"pem"}).toString()};}
function entry(k,overrides={}){return {deviceId:"receiver-01",manufacturerId:"vendor-01",modelId:"gnss-model-a",deviceSerialCommitmentSha256:"a".repeat(64),enrollmentEvidenceSha256:"b".repeat(64),keyId:"receiver-key-01",status:"active",publicKeyPem:k.publicKeyPem,validFromUtc:FROM,validUntilUtc:EXPIRES,revokedAtUtc:null,replacesKeyId:null,...overrides};}
function registry(entries,overrides={}){return {schemaVersion:"1.0.0",recordType:"trusted-survey-device-public-key-registry",registryId:"devices-q4-2026",issuedAtUtc:ISSUED,expiresAtUtc:EXPIRES,entries,...overrides};}
function signFixture(k, trusted=registry([entry(k)]), overrides={}){return createSurveyObservationDeviceAttestation({recordBytes,controlPointManifestBytes,observationId:"obs-001",checkpointId:"check-001",buildingId:"building-001",deviceId:"receiver-01",privateKeyPem:k.privateKeyPem,trustedDeviceRegistry:trusted,attestedAtUtc:SIGNED,...overrides});}
function verifyFixture(a,trusted=registry([entryFromAttestation(a)]),overrides={}){return verifySurveyObservationDeviceAttestation({attestation:a,recordBytes,controlPointManifestBytes,observationId:"obs-001",checkpointId:"check-001",buildingId:"building-001",trustedDeviceRegistry:trusted,now:NOW,...overrides});}
function entryFromAttestation(a){return {deviceId:a.deviceId,manufacturerId:a.manufacturerId,modelId:a.modelId,deviceSerialCommitmentSha256:a.deviceSerialCommitmentSha256,enrollmentEvidenceSha256:a.enrollmentEvidenceSha256,keyId:a.keyId,status:"active",publicKeyPem:activePublicKey,validFromUtc:a.keyValidFromUtc,validUntilUtc:a.keyValidUntilUtc,revokedAtUtc:null,replacesKeyId:null};}
function sortedJson(value){if(Array.isArray(value))return value.map(sortedJson);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortedJson(value[k])]));return value;}
function rawSignatureCheck(attestation,publicKeyPem){
 const {signatureBase64,...unsigned}=attestation;
 const payload=surveyObservationDeviceAttestationSigningBytes(attestation);
 return verifyRawEd25519(null,payload,createPublicKey(publicKeyPem),Buffer.from(signatureBase64,"base64"));
}
let activePublicKey;
test("creates and verifies a device-key attestation bound to exact opaque record and manifest",()=>{
 const k=keys();activePublicKey=k.publicKeyPem;const r=registry([entry(k)]),a=signFixture(k,r),v=verifyFixture(a,r);
 const payload=surveyObservationDeviceAttestationSigningBytes(a);
 const signatureBytes=Buffer.from(a.signatureBase64,"base64");
 const parsedKey=parseTrustedSurveyDeviceRegistry(r,{now:NOW}).activeEntries[0].publicKey;
 assert.equal(signatureBytes.length,64,"Ed25519 signatures must decode to exactly 64 bytes.");
 assert.equal(signatureBytes.toString("base64"),a.signatureBase64,"Signature Base64 must be canonical.");
 assert.equal(rawSignatureCheck(a,k.publicKeyPem),true,"Direct Ed25519 verification must pass for the creator's original public key.");
 assert.equal(verifyRawEd25519(null,payload,parsedKey,signatureBytes),true,"Registry-parsed KeyObject must verify the same signed bytes.");
 assert.equal(a.algorithm,"Ed25519");assert.equal(a.publicationEligible,false);assert.equal(v.valid,true,JSON.stringify(v.checks));assert.equal(v.deviceId,"receiver-01");assert.equal(v.publicationEligible,false);
});
test("rejects record bytes and manifest substitution",()=>{
 const k=keys();activePublicKey=k.publicKeyPem;const r=registry([entry(k)]),a=signFixture(k,r);
 assert.equal(verifyFixture(a,r,{recordBytes:Buffer.concat([recordBytes,Buffer.from("x")])}).valid,false);
 assert.equal(verifyFixture(a,r,{controlPointManifestBytes:Buffer.concat([controlPointManifestBytes,Buffer.from(" ")])}).valid,false);
});
test("rejects checkpoint, building and device context substitution",()=>{
 const k=keys();activePublicKey=k.publicKeyPem;const r=registry([entry(k)]),a=signFixture(k,r);
 assert.equal(verifyFixture(a,r,{checkpointId:"check-002"}).valid,false);
 assert.equal(verifyFixture(a,r,{buildingId:"building-002"}).valid,false);
 assert.equal(verifyFixture({...a,deviceId:"receiver-02"},r).valid,false);
});
test("rejects wrong, unknown and revoked device keys",()=>{
 const k=keys(),wrong=keys();activePublicKey=k.publicKeyPem;const r=registry([entry(k)]),a=signFixture(k,r);
 assert.throws(()=>signFixture(wrong,r),/does not resolve/);
 assert.equal(verifyFixture(a,registry([entry(wrong)])).valid,false);
 const revoked=registry([entry(k,{status:"revoked",revokedAtUtc:"2026-11-05T11:00:00.000Z"})]);
 assert.equal(verifyFixture(a,revoked).valid,false);
});
test("rejects expired and not-yet-valid registries",()=>{
 const k=keys();assert.throws(()=>parseTrustedSurveyDeviceRegistry(registry([entry(k)],{expiresAtUtc:"2026-11-05T12:00:00.000Z"}),{now:NOW}),/expired/);
 assert.throws(()=>parseTrustedSurveyDeviceRegistry(registry([entry(k)],{issuedAtUtc:"2026-11-06T00:00:00.000Z"}),{now:NOW}),/not yet valid/);
});
test("enforces unique key IDs/fingerprints and linear rotation history",()=>{
 const k=keys(),k2=keys();const duplicate=registry([entry(k),entry(k2,{status:"revoked",revokedAtUtc:"2026-11-04T00:00:00.000Z"})]);
 assert.throws(()=>parseTrustedSurveyDeviceRegistry({...duplicate,entries:[duplicate.entries[0],{...duplicate.entries[1],keyId:duplicate.entries[0].keyId}]},{now:NOW}),/unique/);
 assert.throws(()=>parseTrustedSurveyDeviceRegistry({...duplicate,entries:[duplicate.entries[0],{...duplicate.entries[1],publicKeyPem:k.publicKeyPem,keyId:"receiver-key-02"}]},{now:NOW}),/fingerprints/);
 const rotated=registry([entry(k,{status:"revoked",revokedAtUtc:"2026-11-04T00:00:00.000Z"}),entry(k2,{keyId:"receiver-key-02",validFromUtc:"2026-11-04T00:00:00.000Z",replacesKeyId:"receiver-key-01"})]);
 assert.equal(parseTrustedSurveyDeviceRegistry(rotated,{now:NOW}).activeEntries.length,1);
 const reusedSerial=registry([entry(k),entry(k2,{deviceId:"receiver-02",keyId:"receiver-key-02"})]);
 assert.throws(()=>parseTrustedSurveyDeviceRegistry(reusedSerial,{now:NOW}),/more than one device ID/);
});
test("rejects unsafe IDs, non-Ed25519 keys and malformed release claims",()=>{
 const k=keys();assert.throws(()=>parseTrustedSurveyDeviceRegistry(registry([entry(k,{deviceId:"../escape"})]),{now:NOW}),/safe identifier/);
 const a=signFixture(k,registry([entry(k)]));assert.equal(verifyFixture({...a,publicationEligible:true},registry([entry(k)])).valid,false);
 assert.throws(()=>signFixture(k,registry([entry(k)]),{deviceId:"../escape"}),/safe identifier/);
 assert.throws(()=>parseTrustedSurveyDeviceRegistry(registry([entry(k,{publicKeyPem:"not a public key"})]),{now:NOW}));
});
test("keeps JSON schemas strict and versioned",async()=>{
 const rs=JSON.parse(await readFile(new URL("../trusted-survey-device-public-key-registry.schema.json",import.meta.url),"utf8"));
 const as=JSON.parse(await readFile(new URL("../survey-observation-device-attestation.schema.json",import.meta.url),"utf8"));
 assert.equal(rs.additionalProperties,false);assert.equal(rs.properties.schemaVersion.const,"1.0.0");
 assert.equal(as.additionalProperties,false);assert.equal(as.properties.algorithm.const,"Ed25519");assert.equal(as.properties.publicationEligible.const,false);
});
test("uses a deterministic cross-platform-safe sidecar path",()=>{
 assert.equal(surveyObservationDeviceAttestationPath("Obs-Upper-01"),"evidence/survey-observations/Obs-Upper-01.device-attestation.json");
 assert.throws(()=>surveyObservationDeviceAttestationPath("CON"),/cross-platform/);
});
