#!/usr/bin/env python3
"""GSLens.AI — compatibilidade do CSS com navegadores antigos (Android 5+/Chrome 58+).

Mantém o CSS moderno e acrescenta, ANTES de cada recurso novo, uma alternativa
que os navegadores antigos entendem (os novos continuam usando a moderna, que
vem depois):
  - inset:X                       → top/right/bottom/left            (Chrome < 87)
  - clamp(a,b,c) / min() / max()  → valor fixo equivalente           (Chrome < 79)
  - calc(... env(...))            → mesma conta sem env()            (Chrome < 69)
  - 100dvh / 100svh               → 100vh                            (Chrome < 108)
  - seletores :focus-visible / :has() / :is() numa lista           (Chrome < 86/105)
    → a lista é dividida: um seletor desconhecido invalidava a regra inteira
É idempotente: rodar de novo não duplica nada (marca: /*legacy*/).
Uso: python3 tools/css-legacy.py css/style.css
"""
import re, sys

MARK = '/*legacy*/'
RISKY_SEL = re.compile(r':focus-visible|:has\(|:is\(|:where\(')


def split_top(s, sep=','):
    out, depth, cur = [], 0, ''
    for ch in s:
        if ch in '([': depth += 1
        elif ch in ')]': depth -= 1
        if ch == sep and depth == 0:
            out.append(cur); cur = ''
        else:
            cur += ch
    out.append(cur)
    return out


def eval_fn(v):
    """Troca clamp/min/max por um valor fixo (o máximo do clamp, o 1º de min/max)."""
    def rep(m):
        name, inner = m.group(1), m.group(2)
        args = [a.strip() for a in split_top(inner)]
        if name == 'clamp' and len(args) == 3: return args[2]
        return args[0]
    prev = None
    while prev != v:
        prev = v
        v = re.sub(r'(?<![\w-])(clamp|min|max)\(((?:[^()]|\([^()]*\))*)\)', rep, v)
    return v


def strip_env(v):
    v = re.sub(r'\s*[+-]\s*env\([^()]*\)', '', v)
    v = re.sub(r'env\(\s*[\w-]+\s*,\s*([^()]+)\)', r'\1', v)
    v = re.sub(r'env\([^()]*\)', '0px', v)
    v = re.sub(r'calc\(\s*([^()+\-*/\s]+)\s*\)', r'\1', v)
    return v


def legacy_decls(body):
    """Insere as alternativas antes das declarações modernas de um bloco."""
    if MARK in body: return body
    decls = split_top(body, ';')
    out = []
    for d in decls:
        if not d.strip():
            out.append(d); continue
        m = re.match(r'(\s*)([\w-]+)(\s*:\s*)(.*?)\s*$', d, re.S)
        if not m:
            out.append(d); continue
        ws, prop, colon, val = m.groups()
        imp = ' !important' if '!important' in val else ''
        base = val.replace('!important', '').strip()
        fb = []
        if prop == 'inset':
            p = base.split()
            t, r, b, l = (p * 4)[:4] if len(p) == 1 else (p + p)[:4] if len(p) == 2 else (p[0], p[1], p[2], p[1]) if len(p) == 3 else p[:4]
            fb.append(f'top:{t}{imp};right:{r}{imp};bottom:{b}{imp};left:{l}{imp}')
        alt = base
        if 'minmax(' not in alt and re.search(r'(?<![\w-])(clamp|min|max)\(', alt): alt = eval_fn(alt)
        if 'env(' in alt: alt = strip_env(alt)
        if re.search(r'\d(dvh|svh|lvh)\b', alt): alt = re.sub(r'(\d)(dvh|svh|lvh)\b', r'\1vh', alt)
        if alt != base and prop != 'inset': fb.append(f'{prop}:{alt}{imp}')
        if fb:
            out.append(ws + MARK + ';'.join(fb))
        out.append(d)
    return ';'.join(out)


def process(css):
    out, i, n = [], 0, len(css)
    while i < n:
        if css.startswith('/*', i):
            j = css.find('*/', i + 2); j = n if j < 0 else j + 2
            out.append(css[i:j]); i = j; continue
        j = css.find('{', i)
        k = css.find('}', i)
        if j < 0 or (0 <= k < j):
            out.append(css[i:] if j < 0 and k < 0 else css[i:k + 1] if k >= 0 else css[i:]); i = (k + 1) if k >= 0 else n; continue
        head = css[i:j]
        # bloco: acha o fechamento correspondente
        depth, p = 1, j + 1
        while p < n and depth:
            if css.startswith('/*', p):
                q = css.find('*/', p + 2); p = n if q < 0 else q + 2; continue
            if css[p] == '{': depth += 1
            elif css[p] == '}': depth -= 1
            p += 1
        body = css[j + 1:p - 1]
        h = head.strip()
        if h.startswith('@media') or h.startswith('@supports'):
            out.append(head + '{' + process(body) + '}')
        elif h.startswith('@'):
            out.append(head + '{' + body + '}')
        else:
            lead = head[:len(head) - len(head.lstrip())]
            sels = [s.strip() for s in split_top(h)]
            nb = legacy_decls(body)
            risky = [s for s in sels if RISKY_SEL.search(s)]
            if risky and len(sels) > 1 and len(risky) < len(sels):
                safe = [s for s in sels if not RISKY_SEL.search(s)]
                if safe: out.append(lead + ','.join(safe) + '{' + nb + '}')
                for s in risky: out.append(MARK + s + '{' + nb + '}')
            else:
                out.append(head + '{' + nb + '}')
        i = p
    return ''.join(out)


if __name__ == '__main__':
    for f in sys.argv[1:]:
        src = open(f, encoding='utf-8').read()
        res = process(src)
        open(f, 'w', encoding='utf-8').write(res)
        print(f, 'alternativas:', res.count(MARK) - src.count(MARK))
