"""Validação independente (Python puro + numpy) dos arquivos exportados."""
import sys, os, json, struct, zipfile, io
import numpy as np

d = sys.argv[1]
ok = True
def report(name, cond, info=''):
    global ok
    ok &= bool(cond)
    print(('PASS' if cond else 'FAIL'), name, info)

def check_gltf_json(js, bin_bytes, name):
    acc = js['accessors']; bv = js['bufferViews']
    for i, a in enumerate(acc):
        v = bv[a['bufferView']]
        comp = {5126: 4, 5125: 4}[a['componentType']]
        n = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}[a['type']]
        end = v.get('byteOffset', 0) + a['count'] * comp * n
        assert end <= v.get('byteOffset', 0) + v['byteLength'] <= len(bin_bytes), 'accessor fora do buffer'
        assert v.get('byteOffset', 0) % 4 == 0
    pos = np.frombuffer(bin_bytes, np.float32, acc[0]['count'] * 3, bv[acc[0]['bufferView']].get('byteOffset', 0)).reshape(-1, 3)
    nor = np.frombuffer(bin_bytes, np.float32, acc[1]['count'] * 3, bv[acc[1]['bufferView']].get('byteOffset', 0)).reshape(-1, 3)
    idx = np.frombuffer(bin_bytes, np.uint32, acc[3]['count'], bv[acc[3]['bufferView']].get('byteOffset', 0))
    report(name + ' min/max POSITION', np.allclose(pos.min(0), acc[0]['min'], atol=1e-6) and np.allclose(pos.max(0), acc[0]['max'], atol=1e-6))
    report(name + ' normais unitárias', np.allclose(np.linalg.norm(nor, axis=1), 1, atol=1e-3))
    report(name + ' índices válidos', idx.max() < len(pos))
    size = pos.max(0) - pos.min(0)
    report(name + ' escala (m)', True, 'dimensões %.4f x %.4f x %.4f m' % tuple(size))
    return pos, idx

for f in sorted(os.listdir(d)):
    p = os.path.join(d, f); data = open(p, 'rb').read()
    if f.endswith('.glb'):
        magic, ver, length = struct.unpack('<III', data[:12])
        report('GLB cabeçalho', magic == 0x46546C67 and ver == 2 and length == len(data), f'{len(data)} bytes')
        jl, jt = struct.unpack('<II', data[12:20]); js = json.loads(data[20:20 + jl])
        bl, bt = struct.unpack('<II', data[20 + jl:28 + jl]); binb = data[28 + jl:28 + jl + bl]
        report('GLB chunks', jt == 0x4E4F534A and bt == 0x004E4942 and jl % 4 == 0 and bl % 4 == 0)
        check_gltf_json(js, binb, 'GLB')
        img = js['images'][0]; v = js['bufferViews'][img['bufferView']]
        png = binb[v['byteOffset']:v['byteOffset'] + v['byteLength']]
        report('GLB textura PNG embutida', png[:8] == b'\x89PNG\r\n\x1a\n', f'{len(png)} bytes')
    elif f.endswith('.zip'):
        z = zipfile.ZipFile(io.BytesIO(data))
        report(f + ' ZIP íntegro (CRC)', z.testzip() is None, str(z.namelist()))
        names = z.namelist()
        if 'modelo.gltf' in names:
            js = json.loads(z.read('modelo.gltf')); binb = z.read(js['buffers'][0]['uri'])
            report('glTF referências', js['buffers'][0]['uri'] in names and js['images'][0]['uri'] in names and len(binb) == js['buffers'][0]['byteLength'])
            check_gltf_json(js, binb, 'glTF')
        if 'modelo.obj' in names:
            txt = z.read('modelo.obj').decode()
            v = [l for l in txt.splitlines() if l.startswith('v ')]; vt = [l for l in txt.splitlines() if l.startswith('vt ')]
            vn = [l for l in txt.splitlines() if l.startswith('vn ')]; fs = [l for l in txt.splitlines() if l.startswith('f ')]
            mx = [0, 0, 0]
            for l in fs:
                for c in l.split()[1:]:
                    a = list(map(int, c.split('/'))); mx = [max(mx[i], a[i]) for i in range(3)]
            report('OBJ índices de face válidos', mx[0] <= len(v) and mx[1] <= len(vt) and mx[2] <= len(vn), f'v={len(v)} vt={len(vt)} vn={len(vn)} f={len(fs)}')
            mtl = z.read('modelo.mtl').decode()
            report('OBJ mtllib + map_Kd', 'mtllib modelo.mtl' in txt and 'map_Kd modelo_textura.png' in mtl and 'modelo_textura.png' in names)
            P = np.array([list(map(float, l.split()[1:4])) for l in v]); s = P.max(0) - P.min(0)
            report('OBJ escala (m)', True, 'dimensões %.4f x %.4f x %.4f m' % tuple(s))
    elif f.endswith('.stl'):
        n = struct.unpack('<I', data[80:84])[0]
        report('STL tamanho = 84+50n', len(data) == 84 + 50 * n, f'{n} triângulos')
        arr = np.frombuffer(data[84:], dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]))
        V = arr['v'].reshape(-1, 3); s = V.max(0) - V.min(0)
        report('STL finito / escala (mm, Z up)', np.isfinite(arr['v']).all(), 'dimensões %.1f x %.1f x %.1f mm' % tuple(s))
        # volume com sinal (malha fechada e orientada para fora => positivo)
        a, b, c = arr['v'][:, 0].astype(np.float64), arr['v'][:, 1].astype(np.float64), arr['v'][:, 2].astype(np.float64)
        vol = np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6
        report('STL volume positivo (orientação)', vol > 0, '%.0f mm³' % vol)
        # estanqueidade: cada aresta compartilhada por exatamente 2 triângulos
        keys = np.round(V * 1e4).astype(np.int64)
        _, inv = np.unique(keys, axis=0, return_inverse=True); inv = inv.reshape(-1, 3)
        e = np.sort(np.concatenate([inv[:, [0, 1]], inv[:, [1, 2]], inv[:, [2, 0]]]), axis=1)
        _, cnt = np.unique(e, axis=0, return_counts=True)
        report('STL malha fechada (manifold)', (cnt == 2).all(), f'arestas={len(cnt)} irregulares={(cnt != 2).sum()}')
    elif f.endswith('.fbx'):
        report('FBX assinatura', data[:23] == b'Kaydara FBX Binary  \x00\x1a\x00', 'versão %d' % struct.unpack('<I', data[23:27])[0])
        found = {}
        def read_props(off, n):
            props = []
            for _ in range(n):
                t = chr(data[off]); off += 1
                if t in 'YCIFDL':
                    sz = {'Y': 2, 'C': 1, 'I': 4, 'F': 4, 'D': 8, 'L': 8}[t]
                    props.append(struct.unpack('<' + {'Y': 'h', 'C': 'B', 'I': 'i', 'F': 'f', 'D': 'd', 'L': 'q'}[t], data[off:off + sz])[0]); off += sz
                elif t in 'SR':
                    l = struct.unpack('<I', data[off:off + 4])[0]; props.append(data[off + 4:off + 4 + l]); off += 4 + l
                else:
                    cnt, enc, cl = struct.unpack('<III', data[off:off + 12]); assert enc == 0
                    dt = {'i': '<i4', 'd': '<f8', 'f': '<f4', 'l': '<i8'}[t]
                    props.append(np.frombuffer(data[off + 12:off + 12 + cl], dt)); assert len(props[-1]) == cnt; off += 12 + cl
            return props, off
        def walk(off, depth, path):
            while True:
                end, n, plen, nl = struct.unpack('<IIIB', data[off:off + 13])
                if end == 0: return off + 13
                name = data[off + 13:off + 13 + nl].decode()
                props, poff = read_props(off + 13 + nl, n)
                assert poff == off + 13 + nl + plen, 'PropertyListLen incorreto em ' + name
                found.setdefault(name, []).append(props)
                if poff < end: assert walk(poff, depth + 1, path + [name]) == end, 'EndOffset incorreto em ' + name
                off = end
                if depth == 0 and off >= len(data) - 200: return off
        try:
            endTop = walk(27, 0, [])
            report('FBX estrutura de nós (offsets consistentes)', True)
            V = found['Vertices'][0][0].reshape(-1, 3); pvi = found['PolygonVertexIndex'][0][0]
            report('FBX polígonos válidos', (pvi < 0).sum() * 3 == len(pvi) and np.where(pvi < 0, ~pvi, pvi).max() < len(V), f'{len(V)} vértices, {(pvi < 0).sum()} triângulos')
            content = [p for p in found.get('Content', [])][0][0]
            report('FBX textura PNG embutida (Video/Content)', content[:8] == b'\x89PNG\r\n\x1a\n', f'{len(content)} bytes')
            s = V.max(0) - V.min(0)
            report('FBX escala (cm, Y up)', True, 'dimensões %.2f x %.2f x %.2f cm' % tuple(s))
            report('FBX conexões', len(found['C']) == 5)
            report('FBX rodapé', data[-16:] == bytes([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]))
        except Exception as e:
            report('FBX parse', False, repr(e))
print('\nRESULTADO:', 'TODOS OK' if ok else 'HÁ FALHAS')
