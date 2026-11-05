import {
  createHash, createPrivateKey, createPublicKey, sign, verify,
} from "node:crypto";

export const TRUSTED_SURVEY_DEVICE_REGISTRY_SCHEMA_VERSION = "1.0.0";
export const SURVEY_OBSERVATION_DEVICE_ATTESTATION_SCHEMA_VERSION = "1.0.0";
export const MAX_TRUSTED_SURVEY_DEVICE_REGISTRY_BYTES = 64 * 1024;
export const MAX_SURVEY_DEVICE_KEYS = 100;
const DOMAIN = Buffer.from("3d-geospatial-platform/survey-observation-device-attestation/v1\0", "utf8");
const PURPOSE = "survey-observation-device-key-association-only";
const ENGINE = "survey-observation-device-attestation-v1";
const NOTE = "This signature associates exact opaque survey record bytes and checkpoint context with an externally enrolled device key only. It does not prove manufacturer certification, secure-element custody, genuine receiver capture, firmware integrity, measurement accuracy or release approval.";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SAFE_CONTEXT_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const REGISTRY_FIELDS = ["schemaVersion","recordType","registryId","issuedAtUtc","expiresAtUtc","entries"];
const ENTRY_FIELDS = ["deviceId","manufacturerId","modelId","deviceSerialCommitmentSha256","enrollmentEvidenceSha256","keyId","status","publicKeyPem","validFromUtc","validUntilUtc","revokedAtUtc","replacesKeyId"];
const ATTESTATION_FIELDS = ["schemaVersion","engine","algorithm","signaturePurpose","observationId","checkpointId","buildingId","recordSha256","recordBytes","controlPointManifestSha256","deviceId","manufacturerId","modelId","deviceSerialCommitmentSha256","enrollmentEvidenceSha256","keyId","registryId","publicKeyFingerprintSha256","registryIssuedAtUtc","registryExpiresAtUtc","keyValidFromUtc","keyValidUntilUtc","attestedAtUtc","publicationEligible","note","signatureBase64"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
function canonicalUtc(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === v;
}
function normalizeNow(v) {
  const d = v instanceof Date ? new Date(v) : new Date(v ?? Date.now());
  if (!Number.isFinite(d.getTime())) throw new TypeError("Device registry validation time must be valid.");
  return d;
}
function safeId(v, label) {
  if (typeof v !== "string" || !SAFE_ID.test(v)) throw new TypeError(label + " must be a canonical lowercase safe identifier.");
  return v;
}
function safeContext(v, label) {
  if (typeof v !== "string" || !SAFE_CONTEXT_ID.test(v)) throw new TypeError(label + " must be a safe identifier.");
  return v;
}
function canonicalize(v, seen = new Set()) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("Signed device context contains a non-finite number.");
    return v;
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new TypeError("Signed device context contains a circular array.");
    seen.add(v); const out = v.map(x => canonicalize(x, seen)); seen.delete(v); return out;
  }
  if (isObject(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("Signed device context must contain plain JSON objects.");
    if (seen.has(v)) throw new TypeError("Signed device context contains a circular object.");
    seen.add(v); const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) throw new TypeError("Signed device context must not contain undefined values.");
      out[k] = canonicalize(v[k], seen);
    }
    seen.delete(v); return out;
  }
  throw new TypeError("Signed device context must be JSON-compatible.");
}
function canonicalJson(v) { return JSON.stringify(canonicalize(v)); }
function parseRegistry(input) {
  let value = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_TRUSTED_SURVEY_DEVICE_REGISTRY_BYTES) throw new RangeError("Trusted device registry exceeds 64 KiB.");
    try { value = JSON.parse(input); } catch { throw new TypeError("Trusted device registry must be valid JSON."); }
  } else if (isObject(input) && Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_TRUSTED_SURVEY_DEVICE_REGISTRY_BYTES) {
    throw new RangeError("Trusted device registry exceeds 64 KiB.");
  }
  return value;
}
function publicKey(pem, label) {
  if (typeof pem !== "string" || pem.length < 64 || pem.length > 16*1024 ||
      !pem.includes("BEGIN PUBLIC KEY") || /PRIVATE KEY/.test(pem)) throw new TypeError(label + " must be public-key PEM only.");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError(label + " must be Ed25519.");
  return key;
}
function fingerprint(key) { return sha256(key.export({type:"spki",format:"der"})); }
function exactFields(v, fields) {
  if (!isObject(v)) return false;
  const actual = Object.keys(v).sort(), expected = [...fields].sort();
  return actual.length === expected.length && actual.every((x,i)=>x===expected[i]);
}

export function parseTrustedSurveyDeviceRegistry(input, {now: nowInput} = {}) {
  const now = normalizeNow(nowInput), registry = parseRegistry(input);
  if (!exactFields(registry, REGISTRY_FIELDS)) throw new TypeError("Trusted device registry must use the exact versioned envelope fields.");
  if (registry.schemaVersion !== TRUSTED_SURVEY_DEVICE_REGISTRY_SCHEMA_VERSION ||
      registry.recordType !== "trusted-survey-device-public-key-registry") throw new TypeError("Trusted device registry schema or record type is unsupported.");
  safeId(registry.registryId, "registryId");
  if (!canonicalUtc(registry.issuedAtUtc) || !canonicalUtc(registry.expiresAtUtc)) throw new TypeError("Device registry timestamps must be canonical UTC values.");
  const issued = Date.parse(registry.issuedAtUtc), expires = Date.parse(registry.expiresAtUtc), current = now.getTime();
  if (expires <= issued || expires-issued > 90*86400000) throw new RangeError("Device registry lifetime must be positive and no longer than 90 days.");
  if (current < issued) throw new Error("Trusted device registry is not yet valid.");
  if (current >= expires) throw new Error("Trusted device registry has expired.");
  if (!Array.isArray(registry.entries) || registry.entries.length < 1 || registry.entries.length > MAX_SURVEY_DEVICE_KEYS) {
    throw new RangeError("Trusted device registry must contain 1–100 key-history entries.");
  }
  const keyIds=new Set(), fingerprints=new Set(), serialOwners=new Map(), activeByDevice=new Map(), parsed=[];
  for (const [i,e] of registry.entries.entries()) {
    if (!exactFields(e, ENTRY_FIELDS)) throw new TypeError("Device registry entry "+i+" must use the exact lifecycle fields.");
    safeId(e.deviceId,"deviceId"); safeId(e.manufacturerId,"manufacturerId"); safeId(e.modelId,"modelId"); safeId(e.keyId,"keyId");
    if (!HASH.test(e.deviceSerialCommitmentSha256 ?? "") || !HASH.test(e.enrollmentEvidenceSha256 ?? "")) throw new TypeError("Device serial commitment and enrollment evidence must be SHA-256 digests.");
    const serialOwner=serialOwners.get(e.deviceSerialCommitmentSha256);
    if(serialOwner && serialOwner!==e.deviceId) throw new TypeError("A device serial commitment cannot identify more than one device ID.");
    serialOwners.set(e.deviceSerialCommitmentSha256,e.deviceId);
    if (!["active","revoked"].includes(e.status)) throw new TypeError("Device key status must be active or revoked.");
    if (keyIds.has(e.keyId)) throw new TypeError("Device key IDs must be globally unique.");
    keyIds.add(e.keyId);
    if (!canonicalUtc(e.validFromUtc) || !canonicalUtc(e.validUntilUtc)) throw new TypeError("Device key validity timestamps must be canonical UTC.");
    const from=Date.parse(e.validFromUtc), until=Date.parse(e.validUntilUtc);
    if (until<=from || until>expires) throw new RangeError("Device key validity must be positive and end no later than registry expiry.");
    const key=publicKey(e.publicKeyPem,"Device key "+e.keyId), fp=fingerprint(key);
    if (fingerprints.has(fp)) throw new TypeError("Device public-key fingerprints must be unique.");
    fingerprints.add(fp);
    if (e.status==="active") {
      if (e.revokedAtUtc!==null || from>current || until<=current) throw new Error("Active device key must be unrevoked and currently valid.");
      activeByDevice.set(e.deviceId,(activeByDevice.get(e.deviceId)??0)+1);
    } else {
      if (!canonicalUtc(e.revokedAtUtc)) throw new TypeError("Revoked device keys require a canonical revocation time.");
      const revoked=Date.parse(e.revokedAtUtc);
      if (revoked<from || revoked>current || revoked>until) throw new RangeError("Device key revocation must occur inside its validity window and not in the future.");
    }
    if (e.replacesKeyId!==null) safeId(e.replacesKeyId,"replacesKeyId");
    parsed.push(Object.freeze({...e,publicKey,keyFingerprintSha256:fp,registryId:registry.registryId,registryIssuedAtUtc:registry.issuedAtUtc,registryExpiresAtUtc:registry.expiresAtUtc}));
  }
  for (const [id,count] of activeByDevice) if(count!==1) throw new TypeError("Device "+id+" must have at most one active key.");
  const byId=new Map(parsed.map(e=>[e.keyId,e])), children=new Map();
  for(const e of parsed) {
    if(e.replacesKeyId===null) continue;
    const prev=byId.get(e.replacesKeyId);
    if(!prev || prev.deviceId!==e.deviceId || prev.status!=="revoked" ||
       Date.parse(prev.revokedAtUtc)>Date.parse(e.validFromUtc) || children.has(prev.keyId) ||
       prev.manufacturerId!==e.manufacturerId || prev.modelId!==e.modelId ||
       prev.deviceSerialCommitmentSha256!==e.deviceSerialCommitmentSha256 ||
       prev.enrollmentEvidenceSha256!==e.enrollmentEvidenceSha256) throw new TypeError("Device key must replace one earlier revoked key for the same device and identity.");
    children.set(prev.keyId,e.keyId);
  }
  const grouped=new Map();
  for(const e of parsed){const a=grouped.get(e.deviceId)??[];a.push(e);grouped.set(e.deviceId,a);}
  for(const [id,entries] of grouped){
    const roots=entries.filter(e=>e.replacesKeyId===null);
    if(roots.length!==1) throw new TypeError("Device "+id+" key history must have exactly one root.");
    let cur=roots[0];const visited=new Set();
    while(cur){if(visited.has(cur.keyId))throw new TypeError("Device key rotation history contains a cycle.");visited.add(cur.keyId);cur=children.has(cur.keyId)?byId.get(children.get(cur.keyId)):null;}
    if(visited.size!==entries.length) throw new TypeError("Device key rotation history must form one complete linear chain.");
    const first=entries[0];
    if(entries.some(e=>e.manufacturerId!==first.manufacturerId||e.modelId!==first.modelId||e.deviceSerialCommitmentSha256!==first.deviceSerialCommitmentSha256||
       e.enrollmentEvidenceSha256!==first.enrollmentEvidenceSha256)) {
      throw new TypeError("Device identity and enrollment evidence must remain stable across key rotation.");
    }
  }
  return Object.freeze({schemaVersion:registry.schemaVersion,registryId:registry.registryId,issuedAtUtc:registry.issuedAtUtc,expiresAtUtc:registry.expiresAtUtc,entries:Object.freeze(parsed),activeEntries:Object.freeze(parsed.filter(e=>e.status==="active"))});
}
function validateBytes({recordBytes,controlPointManifestBytes}) {
  if(!Buffer.isBuffer(recordBytes)||recordBytes.length<1||recordBytes.length>16*1024*1024) throw new RangeError("Device-attested record must be a non-empty Buffer within 16 MiB.");
  if(!Buffer.isBuffer(controlPointManifestBytes)||controlPointManifestBytes.length<1||controlPointManifestBytes.length>1024*1024) throw new RangeError("Control manifest must be a non-empty Buffer within 1 MiB.");
}
function unsignedContext(envelope) {
  const { signatureBase64: _signatureBase64, ...context } = envelope;
  return context;
}
function signingBytes(context){return Buffer.concat([DOMAIN,Buffer.from(canonicalJson(context),"utf8")]);}

export function createSurveyObservationDeviceAttestation({
  recordBytes,controlPointManifestBytes,observationId,checkpointId,buildingId,deviceId,privateKeyPem,trustedDeviceRegistry,attestedAtUtc,
}) {
  validateBytes({recordBytes,controlPointManifestBytes});safeContext(observationId,"observationId");safeContext(checkpointId,"checkpointId");safeContext(buildingId,"buildingId");safeId(deviceId,"deviceId");
  if(typeof privateKeyPem!=="string"||!privateKeyPem.includes("PRIVATE KEY"))throw new TypeError("privateKeyPem must be a local PEM private key.");
  if(!canonicalUtc(attestedAtUtc))throw new TypeError("attestedAtUtc must be canonical UTC with milliseconds.");
  const privateKey=createPrivateKey(privateKeyPem);
  if(privateKey.asymmetricKeyType!=="ed25519")throw new TypeError("Survey observation device attestations require an Ed25519 key.");
  const registry=parseTrustedSurveyDeviceRegistry(trustedDeviceRegistry,{now:attestedAtUtc});
  const fp=fingerprint(createPublicKey(privateKey));
  const matches=registry.activeEntries.filter(e=>e.deviceId===deviceId&&e.keyFingerprintSha256===fp);
  if(matches.length!==1)throw new Error("Device private key does not resolve to exactly one active trusted-device registry entry.");
  const d=matches[0];
  const context={
    schemaVersion:SURVEY_OBSERVATION_DEVICE_ATTESTATION_SCHEMA_VERSION,engine:ENGINE,algorithm:"Ed25519",signaturePurpose:PURPOSE,
    observationId,checkpointId,buildingId,recordSha256:sha256(recordBytes),recordBytes:recordBytes.length,
    controlPointManifestSha256:sha256(controlPointManifestBytes),deviceId:d.deviceId,manufacturerId:d.manufacturerId,modelId:d.modelId,
    deviceSerialCommitmentSha256:d.deviceSerialCommitmentSha256,enrollmentEvidenceSha256:d.enrollmentEvidenceSha256,keyId:d.keyId,registryId:d.registryId,
    publicKeyFingerprintSha256:d.keyFingerprintSha256,registryIssuedAtUtc:d.registryIssuedAtUtc,registryExpiresAtUtc:d.registryExpiresAtUtc,
    keyValidFromUtc:d.validFromUtc,keyValidUntilUtc:d.validUntilUtc,attestedAtUtc,publicationEligible:false,note:NOTE,
  };
  return Object.freeze({...context,signatureBase64:sign(null,signingBytes(context),privateKey).toString("base64")});
}

export function verifySurveyObservationDeviceAttestation({
  attestation,recordBytes,controlPointManifestBytes,observationId,checkpointId,buildingId,trustedDeviceRegistry,now:nowInput,
}) {
  validateBytes({recordBytes,controlPointManifestBytes});safeContext(observationId,"observationId");safeContext(checkpointId,"checkpointId");safeContext(buildingId,"buildingId");
  const checks=[],errors=[],check=(id,ok,message)=>{const x={id,status:ok?"passed":"failed",message};checks.push(x);if(!ok)errors.push(x);};
  const fields=exactFields(attestation,ATTESTATION_FIELDS);
  check("device-attestation-fields",fields,"Device attestation must contain exactly the documented fields.");
  if(!fields)return {schemaVersion:"1.0.0",status:"invalid",valid:false,checks,errors,publicationEligible:false};
  const shape=attestation.schemaVersion==="1.0.0"&&attestation.engine===ENGINE&&attestation.algorithm==="Ed25519"&&
    attestation.signaturePurpose===PURPOSE&&SAFE_CONTEXT_ID.test(attestation.observationId??"")&&
    SAFE_CONTEXT_ID.test(attestation.checkpointId??"")&&SAFE_CONTEXT_ID.test(attestation.buildingId??"")&&
    HASH.test(attestation.recordSha256??"")&&Number.isSafeInteger(attestation.recordBytes)&&attestation.recordBytes>0&&
    HASH.test(attestation.controlPointManifestSha256??"")&&SAFE_ID.test(attestation.deviceId??"")&&
    SAFE_ID.test(attestation.manufacturerId??"")&&SAFE_ID.test(attestation.modelId??"")&&
    HASH.test(attestation.deviceSerialCommitmentSha256??"")&&HASH.test(attestation.enrollmentEvidenceSha256??"")&&
    SAFE_ID.test(attestation.keyId??"")&&SAFE_ID.test(attestation.registryId??"")&&
    HASH.test(attestation.publicKeyFingerprintSha256??"")&&
    [attestation.registryIssuedAtUtc,attestation.registryExpiresAtUtc,attestation.keyValidFromUtc,attestation.keyValidUntilUtc,attestation.attestedAtUtc].every(canonicalUtc)&&
    attestation.publicationEligible===false&&attestation.note===NOTE&&typeof attestation.signatureBase64==="string"&&SIGNATURE.test(attestation.signatureBase64);
  check("device-attestation-envelope",shape,"Device attestation fields, identifiers, digests, timestamps, purpose and signature encoding must be canonical.");
  check("device-observation-binding",attestation.observationId===observationId&&attestation.checkpointId===checkpointId&&attestation.buildingId===buildingId,
    "Observation, checkpoint and building IDs must match the exact manifest context.");
  check("device-record-byte-binding",attestation.recordSha256===sha256(recordBytes)&&attestation.recordBytes===recordBytes.length,
    "Device signature must bind the exact opaque record SHA-256 and byte length.");
  check("device-manifest-binding",attestation.controlPointManifestSha256===sha256(controlPointManifestBytes),
    "Device signature must bind the exact control-point manifest bytes.");
  let registry=null;try{registry=parseTrustedSurveyDeviceRegistry(trustedDeviceRegistry,{now:nowInput});}catch(e){check("trusted-device-registry",false,e instanceof Error?e.message:"Trusted device registry is invalid.");}
  let signer=null;
  if(registry&&shape){
    const found=registry.activeEntries.filter(e=>e.deviceId===attestation.deviceId&&e.keyId===attestation.keyId&&
      e.registryId===attestation.registryId&&e.keyFingerprintSha256===attestation.publicKeyFingerprintSha256&&
      e.manufacturerId===attestation.manufacturerId&&e.modelId===attestation.modelId&&
      e.deviceSerialCommitmentSha256===attestation.deviceSerialCommitmentSha256&&e.enrollmentEvidenceSha256===attestation.enrollmentEvidenceSha256&&
      e.registryIssuedAtUtc===attestation.registryIssuedAtUtc&&e.registryExpiresAtUtc===attestation.registryExpiresAtUtc&&
      e.validFromUtc===attestation.keyValidFromUtc&&e.validUntilUtc===attestation.keyValidUntilUtc);
    signer=found.length===1?found[0]:null;
  }
  check("active-device-key",Boolean(signer),"Device, key, registry, enrollment digests and validity must resolve to one currently active trusted-device entry.");
  const now=normalizeNow(nowInput),signedAt=shape?Date.parse(attestation.attestedAtUtc):NaN;
  const timeValid=Boolean(signer)&&signedAt>=Date.parse(attestation.registryIssuedAtUtc)&&signedAt<Date.parse(attestation.registryExpiresAtUtc)&&
    signedAt>=Date.parse(attestation.keyValidFromUtc)&&signedAt<Date.parse(attestation.keyValidUntilUtc)&&signedAt<=now.getTime();
  check("device-attestation-time-window",timeValid,"Attestation time must be within registry/key validity windows and not in the future.");
  let sigOk=false;
  if(signer&&shape&&timeValid){try{const bytes=Buffer.from(attestation.signatureBase64,"base64");sigOk=bytes.length===64&&bytes.toString("base64")===attestation.signatureBase64&&verify(null,signingBytes(unsignedContext(attestation)),signer.publicKey,bytes);}catch{sigOk=false;}}
  check("device-ed25519-signature",sigOk,"Ed25519 signature must authenticate the exact record, manifest and device context.");
  return {
    schemaVersion:"1.0.0",engine:"survey-observation-device-attestation-verification-v1",
    status:errors.length===0?"device-key-attestation-verified":"device-key-attestation-invalid",valid:errors.length===0,
    observationId,checkpointId,buildingId,recordSha256:sha256(recordBytes),controlPointManifestSha256:sha256(controlPointManifestBytes),
    deviceId:signer?.deviceId??null,keyId:signer?.keyId??null,registryId:registry?.registryId??null,
    enrollmentEvidenceSha256:signer?.enrollmentEvidenceSha256??null,checks,errors,publicationEligible:false,
    note:"A valid signature proves possession of the private key corresponding to a current registry entry and association with exact record/checkpoint bytes. It does not independently prove manufacturer certification, hardware custody, genuine capture or measurement accuracy.",
  };
}

export function surveyObservationDeviceAttestationPath(observationId) {
  safeContext(observationId,"observationId");
  if(observationId.endsWith(".")||/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(observationId.split(".")[0]))throw new TypeError("Survey observation ID is unsafe for a cross-platform device sidecar path.");
  return "evidence/survey-observations/"+observationId+".device-attestation.json";
}

export function buildSurveyObservationDeviceAttestationInventory(entries) {
  if(!Array.isArray(entries)||entries.length<6||entries.length>100)throw new RangeError("Device attestation inventory requires 6–100 entries.");
  const observations=new Set(),checkpoints=new Set(),paths=new Set();
  const normalized=entries.map((e,i)=>{
    if(!isObject(e)||!SAFE_CONTEXT_ID.test(e.observationId??"")||!SAFE_CONTEXT_ID.test(e.checkpointId??"")||
       observations.has(e.observationId.toLowerCase())||checkpoints.has(e.checkpointId.toLowerCase())||
       e.relativePath!==surveyObservationDeviceAttestationPath(e.observationId)||paths.has(e.relativePath.toLowerCase())||
       !HASH.test(e.sha256??"")||!Number.isSafeInteger(e.bytes)||e.bytes<1||e.bytes>32*1024)
      throw new TypeError("Device attestation inventory entry "+i+" is invalid.");
    observations.add(e.observationId.toLowerCase());checkpoints.add(e.checkpointId.toLowerCase());paths.add(e.relativePath.toLowerCase());
    return {observationId:e.observationId,checkpointId:e.checkpointId,relativePath:e.relativePath,sha256:e.sha256,bytes:e.bytes};
  }).sort((a,b)=>a.observationId<b.observationId?-1:a.observationId>b.observationId?1:a.checkpointId<b.checkpointId?-1:a.checkpointId>b.checkpointId?1:0);
  return {count:normalized.length,totalBytes:normalized.reduce((s,e)=>s+e.bytes,0),sha256:sha256(Buffer.from(JSON.stringify(normalized),"utf8")),entries:normalized};
}
