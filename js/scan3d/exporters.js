/* ═══════════════════════════════════════════════════
   GSLens.AI — Scanner 3D · exporters.js
   Escritores de arquivo REAIS (binários/texto conforme
   cada especificação), sem dependências externas:
     GLB   — glTF 2.0 binário, textura PNG embutida
     glTF  — .gltf (JSON) + .bin + .png empacotados em ZIP
     OBJ   — .obj + .mtl + .png empacotados em ZIP
     STL   — binário, somente geometria
     FBX   — binário 7.4 (7400), textura PNG embutida
   Escala/eixos (o objeto sai em tamanho real):
     GLB/glTF/OBJ: metros, Y para cima (convenções glTF/Blender)
     FBX: centímetros, Y para cima (padrão do formato)
     STL: milímetros, Z para cima (padrão de fatiadores 3D)
═══════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const GS3D = root.GS3D = root.GS3D || {};

  const enc = new TextEncoder();

  /* ── Geometria de exportação ──
     scan: { positions (mm, prancha Z-up), indices, normals, uvs (por canto,
     origem no topo-esquerdo), png (Uint8Array) }  */
  function prepare(scan) {
    const v = GS3D.recon.validateMesh(scan);
    if (!v.ok) throw new Error('Modelo 3D inválido: ' + v.errors.join(', '));
    if (!scan.uvs || scan.uvs.length !== scan.indices.length * 2) throw new Error('Coordenadas de textura ausentes ou inconsistentes.');
    const b = GS3D.recon.bounds(scan.positions);
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, z0 = b.min[2];
    return { scan, cx, cy, z0, bounds: b, validation: v };
  }
  /* (x,y,z) prancha mm → Y-up com fator de escala */
  function toYUp(g, i, s, out) {
    const p = g.scan.positions;
    out[0] = (p[3 * i] - g.cx) * s;
    out[1] = (p[3 * i + 2] - g.z0) * s;
    out[2] = -(p[3 * i + 1] - g.cy) * s;
    return out;
  }
  function normalYUp(g, i, out) {
    const n = g.scan.normals;
    out[0] = n[3 * i]; out[1] = n[3 * i + 2]; out[2] = -n[3 * i + 1];
    return out;
  }

  /* ════════════ glTF 2.0 ════════════ */
  function buildGLTF(g, embedImage) {
    const { indices, uvs, png } = g.scan;
    const T = indices.length / 3, n = T * 3;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), tex = new Float32Array(n * 2), idx = new Uint32Array(n);
    const tmp = [0, 0, 0];
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) {
      const vi = indices[k];
      toYUp(g, vi, 0.001, tmp);
      pos.set(tmp, k * 3);
      for (let a = 0; a < 3; a++) { if (tmp[a] < mn[a]) mn[a] = tmp[a]; if (tmp[a] > mx[a]) mx[a] = tmp[a]; }
      normalYUp(g, vi, tmp); nor.set(tmp, k * 3);
      tex[2 * k] = uvs[2 * k]; tex[2 * k + 1] = uvs[2 * k + 1];   /* glTF: origem no topo-esquerdo (igual ao atlas) */
      idx[k] = k;
    }
    const parts = [];
    let off = 0;
    const views = [];
    const addView = (bytes, target) => {
      const pad = (4 - (off % 4)) % 4;
      if (pad) { parts.push(new Uint8Array(pad)); off += pad; }
      const view = { buffer: 0, byteOffset: off, byteLength: bytes.byteLength };
      if (target) view.target = target;
      views.push(view);
      parts.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      off += bytes.byteLength;
      return views.length - 1;
    };
    const vPos = addView(pos, 34962), vNor = addView(nor, 34962), vTex = addView(tex, 34962), vIdx = addView(idx, 34963);
    let vImg = -1;
    if (embedImage) vImg = addView(png);
    const padEnd = (4 - (off % 4)) % 4;
    if (padEnd) { parts.push(new Uint8Array(padEnd)); off += padEnd; }
    const bin = new Uint8Array(off);
    let o = 0;
    for (const p of parts) { bin.set(p, o); o += p.byteLength; }

    const json = {
      asset: { version: '2.0', generator: 'GSLens.AI Scanner 3D' },
      scene: 0,
      scenes: [{ name: 'GSLens Scan', nodes: [0] }],
      nodes: [{ name: 'objeto_escaneado', mesh: 0 }],
      meshes: [{ name: 'objeto_escaneado', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
      materials: [{ name: 'material_escaneado', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
      textures: [{ sampler: 0, source: 0 }],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
      images: [embedImage ? { bufferView: vImg, mimeType: 'image/png', name: 'textura' } : { uri: 'modelo_textura.png', mimeType: 'image/png', name: 'textura' }],
      accessors: [
        { bufferView: vPos, componentType: 5126, count: n, type: 'VEC3', min: mn, max: mx },
        { bufferView: vNor, componentType: 5126, count: n, type: 'VEC3' },
        { bufferView: vTex, componentType: 5126, count: n, type: 'VEC2' },
        { bufferView: vIdx, componentType: 5125, count: n, type: 'SCALAR' }
      ],
      bufferViews: views,
      buffers: [embedImage ? { byteLength: bin.byteLength } : { byteLength: bin.byteLength, uri: 'modelo.bin' }]
    };
    return { json, bin };
  }

  function toGLB(scan) {
    const g = prepare(scan);
    const { json, bin } = buildGLTF(g, true);
    let jsonBytes = enc.encode(JSON.stringify(json));
    const jpad = (4 - (jsonBytes.length % 4)) % 4;
    if (jpad) { const j2 = new Uint8Array(jsonBytes.length + jpad); j2.set(jsonBytes); j2.fill(0x20, jsonBytes.length); jsonBytes = j2; }
    const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
    const out = new Uint8Array(total), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true);   /* 'glTF' */
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length, true);
    dv.setUint32(16, 0x4E4F534A, true);  /* 'JSON' */
    out.set(jsonBytes, 20);
    const bo = 20 + jsonBytes.length;
    dv.setUint32(bo, bin.length, true);
    dv.setUint32(bo + 4, 0x004E4942, true); /* 'BIN\0' */
    out.set(bin, bo + 8);
    return { blob: new Blob([out], { type: 'model/gltf-binary' }), name: 'modelo_3d.glb', bytes: out };
  }

  function toGLTFZip(scan) {
    const g = prepare(scan);
    const { json, bin } = buildGLTF(g, false);
    const files = [
      { name: 'modelo.gltf', data: enc.encode(JSON.stringify(json, null, 1)) },
      { name: 'modelo.bin', data: bin },
      { name: 'modelo_textura.png', data: scan.png },
      { name: 'LEIA-ME.txt', data: enc.encode(readme('glTF 2.0 (.gltf + .bin + .png)', 'metros, eixo Y para cima')) }
    ];
    const zip = makeZip(files);
    return { blob: new Blob([zip], { type: 'application/zip' }), name: 'modelo_3d_gltf.zip', bytes: zip, files };
  }

  /* ════════════ OBJ + MTL ════════════ */
  function toOBJZip(scan) {
    const g = prepare(scan);
    const { positions, indices, uvs } = g.scan;
    const nv = positions.length / 3, T = indices.length / 3;
    const L = ['# GSLens.AI Scanner 3D — objeto escaneado', '# Unidades: metros · eixo Y para cima', 'mtllib modelo.mtl', 'o objeto_escaneado'];
    const t = [0, 0, 0];
    const f6 = x => (Math.abs(x) < 5e-7 ? 0 : x).toFixed(6);
    for (let i = 0; i < nv; i++) { toYUp(g, i, 0.001, t); L.push('v ' + f6(t[0]) + ' ' + f6(t[1]) + ' ' + f6(t[2])); }
    for (let k = 0; k < T * 3; k++) L.push('vt ' + uvs[2 * k].toFixed(6) + ' ' + (1 - uvs[2 * k + 1]).toFixed(6));   /* OBJ: origem embaixo */
    for (let i = 0; i < nv; i++) { normalYUp(g, i, t); L.push('vn ' + t[0].toFixed(5) + ' ' + t[1].toFixed(5) + ' ' + t[2].toFixed(5)); }
    L.push('usemtl material_escaneado', 's 1');
    for (let tr = 0; tr < T; tr++) {
      const f = [];
      for (let c = 0; c < 3; c++) { const v = indices[3 * tr + c] + 1, vt = 3 * tr + c + 1; f.push(v + '/' + vt + '/' + v); }
      L.push('f ' + f.join(' '));
    }
    const obj = enc.encode(L.join('\n') + '\n');
    const mtl = enc.encode([
      '# GSLens.AI Scanner 3D', 'newmtl material_escaneado',
      'Ka 1.000 1.000 1.000', 'Kd 1.000 1.000 1.000', 'Ks 0.000 0.000 0.000', 'Ns 10.0', 'd 1.0', 'illum 1',
      'map_Kd modelo_textura.png', ''
    ].join('\n'));
    const files = [
      { name: 'modelo.obj', data: obj },
      { name: 'modelo.mtl', data: mtl },
      { name: 'modelo_textura.png', data: scan.png },
      { name: 'LEIA-ME.txt', data: enc.encode(readme('Wavefront OBJ (.obj + .mtl + .png)', 'metros, eixo Y para cima')) }
    ];
    const zip = makeZip(files);
    return { blob: new Blob([zip], { type: 'application/zip' }), name: 'modelo_3d_obj.zip', bytes: zip, files };
  }

  /* ════════════ STL binário ════════════ */
  function toSTL(scan) {
    const g = prepare(scan);
    const { positions: p, indices: I } = g.scan;
    const T = I.length / 3;
    const out = new Uint8Array(84 + 50 * T), dv = new DataView(out.buffer);
    out.set(enc.encode('GSLens.AI Scanner 3D - binary STL - unidades: mm, Z para cima').slice(0, 80));
    dv.setUint32(80, T, true);
    let o = 84;
    const P = i => [p[3 * i] - g.cx, p[3 * i + 1] - g.cy, p[3 * i + 2] - g.z0];
    for (let t = 0; t < T; t++) {
      const a = P(I[3 * t]), b = P(I[3 * t + 1]), c = P(I[3 * t + 2]);
      let n = GS3D.math.cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      const l = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
      for (const v of [n, a, b, c]) { dv.setFloat32(o, v[0], true); dv.setFloat32(o + 4, v[1], true); dv.setFloat32(o + 8, v[2], true); o += 12; }
      dv.setUint16(o, 0, true); o += 2;
    }
    return { blob: new Blob([out], { type: 'model/stl' }), name: 'modelo_3d.stl', bytes: out };
  }

  /* ════════════ FBX binário 7.4 ════════════ */
  class ByteWriter {
    constructor(cap) { this.buf = new Uint8Array(cap || 1 << 20); this.dv = new DataView(this.buf.buffer); this.pos = 0; }
    ensure(n) {
      if (this.pos + n <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < this.pos + n) cap *= 2;
      const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb; this.dv = new DataView(nb.buffer);
    }
    u8(v) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
    u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v, true); this.pos += 4; }
    i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; }
    i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, true); this.pos += 4; }
    /* 64 bits sem BigInt (Chrome < 67): dois inteiros de 32 bits (valores até 2^53) */
    i64(v) { this.ensure(8); const lo = v % 4294967296, hi = Math.floor(v / 4294967296); this.dv.setUint32(this.pos, lo < 0 ? lo + 4294967296 : lo, true); this.dv.setInt32(this.pos + 4, hi, true); this.pos += 8; }
    f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
    f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v, true); this.pos += 8; }
    bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
    zeros(n) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; }
    patchU32(at, v) { this.dv.setUint32(at, v, true); }
    result() { return this.buf.slice(0, this.pos); }
  }

  /* Propriedades: { t: 'I'|'L'|'D'|'F'|'C'|'Y'|'S'|'R'|'i'|'d'|'l'|'f', v } */
  const P = {
    I: v => ({ t: 'I', v }), L: v => ({ t: 'L', v }), D: v => ({ t: 'D', v }), C: v => ({ t: 'C', v }),
    S: v => ({ t: 'S', v }), R: v => ({ t: 'R', v }), ai: v => ({ t: 'i', v }), ad: v => ({ t: 'd', v })
  };
  const N = (name, props, children) => ({ name, props: props || [], children: children || [] });

  function writeProp(w, p) {
    w.u8(p.t.charCodeAt(0));
    switch (p.t) {
      case 'Y': w.i16(p.v); break;
      case 'C': w.u8(p.v ? 1 : 0); break;
      case 'I': w.i32(p.v); break;
      case 'F': w.f32(p.v); break;
      case 'D': w.f64(p.v); break;
      case 'L': w.i64(p.v); break;
      case 'S': case 'R': {
        const b = typeof p.v === 'string' ? enc.encode(p.v) : p.v;
        w.u32(b.length); w.bytes(b); break;
      }
      case 'i': case 'd': case 'f': case 'l': {
        const arr = p.v, len = arr.length;
        const size = p.t === 'i' || p.t === 'f' ? 4 : 8;
        w.u32(len); w.u32(0); w.u32(len * size);   /* encoding 0 = sem compressão */
        w.ensure(len * size);
        for (let k = 0; k < len; k++) {
          if (p.t === 'i') w.i32(arr[k]); else if (p.t === 'f') w.f32(arr[k]);
          else if (p.t === 'd') w.f64(arr[k]); else w.i64(arr[k]);
        }
        break;
      }
      default: throw new Error('Tipo de propriedade FBX desconhecido: ' + p.t);
    }
  }
  function writeNode(w, node) {
    const start = w.pos;
    w.u32(0); w.u32(node.props.length); w.u32(0);
    const nameB = enc.encode(node.name);
    w.u8(nameB.length); w.bytes(nameB);
    const ps = w.pos;
    for (const p of node.props) writeProp(w, p);
    w.patchU32(start + 8, w.pos - ps);
    if (node.children.length) {
      for (const c of node.children) writeNode(w, c);
      w.zeros(13);
    } else if (!node.props.length) w.zeros(13);
    w.patchU32(start, w.pos);
  }

  /* Entrada de Properties70 */
  const prop70 = (name, type, label, flags, ...vals) => N('P', [P.S(name), P.S(type), P.S(label), P.S(flags), ...vals]);
  const objName = (n, cls) => n + '\x00\x01' + cls;

  function toFBX(scan) {
    const g = prepare(scan);
    const { positions, indices, uvs, png } = g.scan;
    const nv = positions.length / 3, T = indices.length / 3;
    const verts = new Float64Array(nv * 3), t = [0, 0, 0];
    for (let i = 0; i < nv; i++) { toYUp(g, i, 0.1, t); verts[3 * i] = t[0]; verts[3 * i + 1] = t[1]; verts[3 * i + 2] = t[2]; }   /* cm */
    const pvi = new Int32Array(T * 3);
    const nrm = new Float64Array(T * 9);
    const uv = new Float64Array(T * 6), uvIdx = new Int32Array(T * 3);
    for (let tr = 0; tr < T; tr++) {
      for (let c = 0; c < 3; c++) {
        const k = 3 * tr + c, vi = indices[k];
        pvi[k] = c === 2 ? ~vi : vi;              /* último índice do polígono: -(i+1) */
        normalYUp(g, vi, t); nrm[3 * k] = t[0]; nrm[3 * k + 1] = t[1]; nrm[3 * k + 2] = t[2];
        uv[2 * k] = uvs[2 * k]; uv[2 * k + 1] = 1 - uvs[2 * k + 1];   /* FBX: origem embaixo */
        uvIdx[k] = k;
      }
    }
    const now = new Date();
    const ID = { model: 2135001, geom: 2135002, mat: 2135003, tex: 2135004, video: 2135005, doc: 2135000 };
    const texFile = 'modelo_textura.png';

    const nodes = [
      N('FBXHeaderExtension', [], [
        N('FBXHeaderVersion', [P.I(1003)]),
        N('FBXVersion', [P.I(7400)]),
        N('EncryptionType', [P.I(0)]),
        N('CreationTimeStamp', [], [
          N('Version', [P.I(1000)]), N('Year', [P.I(now.getFullYear())]), N('Month', [P.I(now.getMonth() + 1)]),
          N('Day', [P.I(now.getDate())]), N('Hour', [P.I(now.getHours())]), N('Minute', [P.I(now.getMinutes())]),
          N('Second', [P.I(now.getSeconds())]), N('Millisecond', [P.I(now.getMilliseconds())])
        ]),
        N('Creator', [P.S('GSLens.AI Scanner 3D')])
      ]),
      N('FileId', [P.R(new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]))]),
      N('CreationTime', [P.S('1970-01-01 10:00:00:000')]),
      N('Creator', [P.S('GSLens.AI Scanner 3D')]),
      N('GlobalSettings', [], [
        N('Version', [P.I(1000)]),
        N('Properties70', [], [
          prop70('UpAxis', 'int', 'Integer', '', P.I(1)),
          prop70('UpAxisSign', 'int', 'Integer', '', P.I(1)),
          prop70('FrontAxis', 'int', 'Integer', '', P.I(2)),
          prop70('FrontAxisSign', 'int', 'Integer', '', P.I(1)),
          prop70('CoordAxis', 'int', 'Integer', '', P.I(0)),
          prop70('CoordAxisSign', 'int', 'Integer', '', P.I(1)),
          prop70('OriginalUpAxis', 'int', 'Integer', '', P.I(1)),
          prop70('OriginalUpAxisSign', 'int', 'Integer', '', P.I(1)),
          prop70('UnitScaleFactor', 'double', 'Number', '', P.D(1)),
          prop70('OriginalUnitScaleFactor', 'double', 'Number', '', P.D(1)),
          prop70('AmbientColor', 'ColorRGB', 'Color', '', P.D(0), P.D(0), P.D(0)),
          prop70('DefaultCamera', 'KString', '', '', P.S('Producer Perspective')),
          prop70('TimeMode', 'enum', '', '', P.I(11)),
          prop70('TimeSpanStart', 'KTime', 'Time', '', P.L(0)),
          prop70('TimeSpanStop', 'KTime', 'Time', '', P.L(46186158000)),
          prop70('CustomFrameRate', 'double', 'Number', '', P.D(24))
        ])
      ]),
      N('Documents', [], [
        N('Count', [P.I(1)]),
        N('Document', [P.L(ID.doc), P.S(''), P.S('Scene')], [
          N('Properties70', [], [
            prop70('SourceObject', 'object', '', ''),
            prop70('ActiveAnimStackName', 'KString', '', '', P.S(''))
          ]),
          N('RootNode', [P.L(0)])
        ])
      ]),
      N('References'),
      N('Definitions', [], [
        N('Version', [P.I(100)]),
        N('Count', [P.I(6)]),
        N('ObjectType', [P.S('GlobalSettings')], [N('Count', [P.I(1)])]),
        N('ObjectType', [P.S('Model')], [N('Count', [P.I(1)])]),
        N('ObjectType', [P.S('Geometry')], [N('Count', [P.I(1)])]),
        N('ObjectType', [P.S('Material')], [N('Count', [P.I(1)])]),
        N('ObjectType', [P.S('Texture')], [N('Count', [P.I(1)])]),
        N('ObjectType', [P.S('Video')], [N('Count', [P.I(1)])])
      ]),
      N('Objects', [], [
        N('Geometry', [P.L(ID.geom), P.S(objName('objeto_escaneado', 'Geometry')), P.S('Mesh')], [
          N('Properties70'),
          N('GeometryVersion', [P.I(124)]),
          N('Vertices', [P.ad(verts)]),
          N('PolygonVertexIndex', [P.ai(pvi)]),
          N('LayerElementNormal', [P.I(0)], [
            N('Version', [P.I(102)]), N('Name', [P.S('')]),
            N('MappingInformationType', [P.S('ByPolygonVertex')]),
            N('ReferenceInformationType', [P.S('Direct')]),
            N('Normals', [P.ad(nrm)])
          ]),
          N('LayerElementUV', [P.I(0)], [
            N('Version', [P.I(101)]), N('Name', [P.S('UVMap')]),
            N('MappingInformationType', [P.S('ByPolygonVertex')]),
            N('ReferenceInformationType', [P.S('IndexToDirect')]),
            N('UV', [P.ad(uv)]),
            N('UVIndex', [P.ai(uvIdx)])
          ]),
          N('LayerElementMaterial', [P.I(0)], [
            N('Version', [P.I(101)]), N('Name', [P.S('')]),
            N('MappingInformationType', [P.S('AllSame')]),
            N('ReferenceInformationType', [P.S('IndexToDirect')]),
            N('Materials', [P.ai(new Int32Array([0]))])
          ]),
          N('Layer', [P.I(0)], [
            N('Version', [P.I(100)]),
            N('LayerElement', [], [N('Type', [P.S('LayerElementNormal')]), N('TypedIndex', [P.I(0)])]),
            N('LayerElement', [], [N('Type', [P.S('LayerElementUV')]), N('TypedIndex', [P.I(0)])]),
            N('LayerElement', [], [N('Type', [P.S('LayerElementMaterial')]), N('TypedIndex', [P.I(0)])])
          ])
        ]),
        N('Model', [P.L(ID.model), P.S(objName('objeto_escaneado', 'Model')), P.S('Mesh')], [
          N('Version', [P.I(232)]),
          N('Properties70', [], [
            prop70('Lcl Translation', 'Lcl Translation', '', 'A', P.D(0), P.D(0), P.D(0)),
            prop70('Lcl Rotation', 'Lcl Rotation', '', 'A', P.D(0), P.D(0), P.D(0)),
            prop70('Lcl Scaling', 'Lcl Scaling', '', 'A', P.D(1), P.D(1), P.D(1)),
            prop70('DefaultAttributeIndex', 'int', 'Integer', '', P.I(0)),
            prop70('InheritType', 'enum', '', '', P.I(1))
          ]),
          N('MultiLayer', [P.I(0)]),
          N('MultiTake', [P.I(0)]),
          N('Shading', [P.C(true)]),
          N('Culling', [P.S('CullingOff')])
        ]),
        N('Material', [P.L(ID.mat), P.S(objName('material_escaneado', 'Material')), P.S('')], [
          N('Version', [P.I(102)]),
          N('ShadingModel', [P.S('phong')]),
          N('MultiLayer', [P.I(0)]),
          N('Properties70', [], [
            prop70('AmbientColor', 'Color', '', 'A', P.D(0), P.D(0), P.D(0)),
            prop70('DiffuseColor', 'Color', '', 'A', P.D(1), P.D(1), P.D(1)),
            prop70('DiffuseFactor', 'Number', '', 'A', P.D(1)),
            prop70('SpecularColor', 'Color', '', 'A', P.D(0.1), P.D(0.1), P.D(0.1)),
            prop70('SpecularFactor', 'Number', '', 'A', P.D(0.2)),
            prop70('ShininessExponent', 'Number', '', 'A', P.D(10)),
            prop70('EmissiveColor', 'Color', '', 'A', P.D(0), P.D(0), P.D(0)),
            prop70('Opacity', 'double', 'Number', '', P.D(1))
          ])
        ]),
        N('Video', [P.L(ID.video), P.S(objName('textura', 'Video')), P.S('Clip')], [
          N('Type', [P.S('Clip')]),
          N('Properties70', [], [prop70('Path', 'KString', 'XRefUrl', '', P.S(texFile))]),
          N('UseMipMap', [P.I(0)]),
          N('Filename', [P.S(texFile)]),
          N('RelativeFilename', [P.S(texFile)]),
          N('Content', [P.R(png)])
        ]),
        N('Texture', [P.L(ID.tex), P.S(objName('textura', 'Texture')), P.S('')], [
          N('Type', [P.S('TextureVideoClip')]),
          N('Version', [P.I(202)]),
          N('TextureName', [P.S(objName('textura', 'Texture'))]),
          N('Properties70', [], [
            prop70('CurrentTextureBlendMode', 'enum', '', '', P.I(1)),
            prop70('UVSet', 'KString', '', '', P.S('UVMap')),
            prop70('UseMaterial', 'bool', '', '', P.I(1))
          ]),
          N('Media', [P.S(objName('textura', 'Video'))]),
          N('FileName', [P.S(texFile)]),
          N('RelativeFilename', [P.S(texFile)]),
          N('ModelUVTranslation', [P.D(0), P.D(0)]),
          N('ModelUVScaling', [P.D(1), P.D(1)]),
          N('Texture_Alpha_Source', [P.S('None')]),
          N('Cropping', [P.I(0), P.I(0), P.I(0), P.I(0)])
        ])
      ]),
      N('Connections', [], [
        N('C', [P.S('OO'), P.L(ID.model), P.L(0)]),
        N('C', [P.S('OO'), P.L(ID.geom), P.L(ID.model)]),
        N('C', [P.S('OO'), P.L(ID.mat), P.L(ID.model)]),
        N('C', [P.S('OP'), P.L(ID.tex), P.L(ID.mat), P.S('DiffuseColor')]),
        N('C', [P.S('OO'), P.L(ID.video), P.L(ID.tex)])
      ]),
      N('Takes', [], [N('Current', [P.S('')])])
    ];

    const w = new ByteWriter(Math.max(1 << 20, T * 120 + png.length + 65536));
    w.bytes(enc.encode('Kaydara FBX Binary  ')); w.u8(0); w.u8(0x1a); w.u8(0x00);
    w.u32(7400);
    for (const n of nodes) writeNode(w, n);
    w.zeros(13);                                   /* registro nulo final */
    /* rodapé padrão (mesmo layout do SDK/Blender) */
    w.bytes(new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]));
    w.zeros(4);
    let pad = ((w.pos + 15) & ~15) - w.pos;
    if (pad === 0) pad = 16;
    w.zeros(pad);
    w.u32(7400);
    w.zeros(120);
    w.bytes(new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]));
    const bytes = w.result();
    return { blob: new Blob([bytes], { type: 'application/octet-stream' }), name: 'modelo_3d.fbx', bytes };
  }

  /* ════════════ ZIP (método STORE) ════════════ */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function makeZip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const entries = [];
    let size = 22;
    for (const f of files) {
      const name = enc.encode(f.name);
      entries.push({ name, data: f.data, crc: crc32(f.data) });
      size += 30 + name.length + f.data.length + 46 + name.length;
    }
    const out = new Uint8Array(size), dv = new DataView(out.buffer);
    let o = 0;
    for (const e of entries) {
      e.offset = o;
      dv.setUint32(o, 0x04034b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 0x0800, true);
      dv.setUint16(o + 8, 0, true); dv.setUint16(o + 10, dosTime, true); dv.setUint16(o + 12, dosDate, true);
      dv.setUint32(o + 14, e.crc, true); dv.setUint32(o + 18, e.data.length, true); dv.setUint32(o + 22, e.data.length, true);
      dv.setUint16(o + 26, e.name.length, true); dv.setUint16(o + 28, 0, true);
      out.set(e.name, o + 30); out.set(e.data, o + 30 + e.name.length);
      o += 30 + e.name.length + e.data.length;
    }
    const cdStart = o;
    for (const e of entries) {
      dv.setUint32(o, 0x02014b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 20, true);
      dv.setUint16(o + 8, 0x0800, true); dv.setUint16(o + 10, 0, true); dv.setUint16(o + 12, dosTime, true);
      dv.setUint16(o + 14, dosDate, true); dv.setUint32(o + 16, e.crc, true); dv.setUint32(o + 20, e.data.length, true);
      dv.setUint32(o + 24, e.data.length, true); dv.setUint16(o + 28, e.name.length, true);
      dv.setUint16(o + 30, 0, true); dv.setUint16(o + 32, 0, true); dv.setUint16(o + 34, 0, true);
      dv.setUint16(o + 36, 0, true); dv.setUint32(o + 38, 0, true); dv.setUint32(o + 42, e.offset, true);
      out.set(e.name, o + 46);
      o += 46 + e.name.length;
    }
    dv.setUint32(o, 0x06054b50, true); dv.setUint16(o + 4, 0, true); dv.setUint16(o + 6, 0, true);
    dv.setUint16(o + 8, entries.length, true); dv.setUint16(o + 10, entries.length, true);
    dv.setUint32(o + 12, o - cdStart, true); dv.setUint32(o + 16, cdStart, true); dv.setUint16(o + 20, 0, true);
    return out;
  }

  function readme(fmt, units) {
    return [
      'GSLens.AI - Scanner 3D', '',
      'Formato: ' + fmt,
      'Unidades: ' + units + ' (tamanho real, se a prancha foi impressa a 100%).',
      'Mantenha todos os arquivos deste ZIP na mesma pasta: o modelo referencia',
      'a textura e/ou o buffer binário pelo nome do arquivo.', ''
    ].join('\r\n');
  }

  const FORMATS = {
    glb: { label: 'GLB', fn: toGLB },
    gltf: { label: 'glTF (ZIP)', fn: toGLTFZip },
    obj: { label: 'OBJ (ZIP)', fn: toOBJZip },
    stl: { label: 'STL', fn: toSTL },
    fbx: { label: 'FBX', fn: toFBX }
  };

  GS3D.exporters = { toGLB, toGLTFZip, toOBJZip, toSTL, toFBX, makeZip, crc32, FORMATS };
})(typeof window !== 'undefined' ? window : globalThis);
