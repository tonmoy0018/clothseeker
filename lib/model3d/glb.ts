import { z } from "zod";

// GLB, the one-file binary form of glTF 2.0 (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification):
// the 3D view's models. `writeGlb` makes the fake provider's models; `checkGlb` is how the worker treats
// a model from any provider (untrusted, like an image): the right structure, within limits, and nothing
// that makes the viewer fetch another file (a `uri`), before it is stored. Pure, so it's unit-tested.

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"

/** A model bigger than this isn't stored (TripoSR's are about 1 MB). */
export const MAX_MODEL_BYTES = 20 * 1024 * 1024;
/** Or with more vertices than this (TripoSR at its default resolution makes about 60 000). */
export const MAX_MODEL_VERTICES = 1_000_000;

/** One textured triangle mesh: positions (x, y, z; Y up, metres), texture coordinates, and a PNG. */
export type TexturedMesh = {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** PNG; its alpha cuts the outline (below half is see-through). */
  texture: Buffer;
};

const pad4 = (n: number) => (n + 3) & ~3;

export function writeGlb(mesh: TexturedMesh): Buffer {
  const parts = [Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength), Buffer.from(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength), Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), mesh.texture];
  const views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  let offset = 0;
  for (const [i, part] of parts.entries()) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: part.length, ...(i < 2 ? { target: 34962 } : i === 2 ? { target: 34963 } : {}) });
    offset = pad4(offset + part.length);
  }
  const bin = Buffer.alloc(offset);
  for (const [i, part] of parts.entries()) part.copy(bin, views[i]?.byteOffset ?? 0);

  const count = mesh.positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 1) {
    const axis = i % 3;
    const value = mesh.positions[i] ?? 0;
    min[axis] = Math.min(min[axis] ?? Infinity, value);
    max[axis] = Math.max(max[axis] ?? -Infinity, value);
  }
  const json = {
    asset: { version: "2.0", generator: "ClothSeeker" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987 }],
    images: [{ bufferView: 3, mimeType: "image/png" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5126, count, type: "VEC2" },
      { bufferView: 2, componentType: 5125, count: mesh.indices.length, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.alloc(pad4(text.length), 0x20);
  text.copy(jsonChunk);

  const out = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + bin.length);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(JSON_CHUNK, 16);
  jsonChunk.copy(out, 20);
  const binAt = 20 + jsonChunk.length;
  out.writeUInt32LE(bin.length, binAt);
  out.writeUInt32LE(BIN_CHUNK, binAt + 4);
  bin.copy(out, binAt + 8);
  return out;
}

export class GlbError extends Error {
  override readonly name = "GlbError";
}

/** No `uri` anywhere it could point the viewer at another file (only data inside the GLB is allowed). */
const noUri = z.looseObject({}).refine((o) => !("uri" in o), "external file");

const gltfSchema = z.looseObject({
  asset: z.looseObject({ version: z.literal("2.0") }),
  meshes: z
    .array(z.looseObject({ primitives: z.array(z.looseObject({ attributes: z.looseObject({ POSITION: z.int().min(0) }) })).min(1) }))
    .min(1)
    .max(64),
  accessors: z.array(z.looseObject({ count: z.int().min(0) })).max(1024),
  buffers: z.array(noUri.and(z.looseObject({ byteLength: z.int().min(0) }))).max(1),
  images: z.array(noUri).max(16).optional(),
});

/** What a stored model contains, from `checkGlb`. */
export type GlbSummary = { bytes: number; meshes: number; vertices: number };

/** Throws GlbError unless `bytes` is a self-contained GLB within the limits. */
export function checkGlb(bytes: Uint8Array): GlbSummary {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 20 || data.length > MAX_MODEL_BYTES) throw new GlbError("size");
  if (data.readUInt32LE(0) !== MAGIC || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw new GlbError("header");
  const jsonLength = data.readUInt32LE(12);
  if (data.readUInt32LE(16) !== JSON_CHUNK || 20 + jsonLength > data.length) throw new GlbError("json chunk");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.subarray(20, 20 + jsonLength).toString("utf8"));
  } catch {
    throw new GlbError("json");
  }
  const gltf = gltfSchema.safeParse(parsed);
  if (!gltf.success) throw new GlbError("structure");
  const binAt = 20 + pad4(jsonLength);
  const binLength = binAt + 8 <= data.length && data.readUInt32LE(binAt + 4) === BIN_CHUNK ? data.readUInt32LE(binAt) : 0;
  const needed = gltf.data.buffers[0]?.byteLength ?? 0;
  if (needed > binLength || binAt + 8 + binLength > data.length) throw new GlbError("binary chunk");
  const vertices = gltf.data.meshes.flatMap((m) => m.primitives).reduce((sum, p) => sum + (gltf.data.accessors[p.attributes.POSITION]?.count ?? 0), 0);
  if (vertices === 0 || vertices > MAX_MODEL_VERTICES) throw new GlbError("vertices");
  return { bytes: data.length, meshes: gltf.data.meshes.length, vertices };
}
