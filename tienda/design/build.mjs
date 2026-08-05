/**
 * Genera las previsualizaciones autocontenidas que se suben a claude.ai/design.
 *
 * Cada archivo de previews/ es solo el fragmento de contenido. Este script le
 * inyecta tokens.css y components.css tal cual están en disco, así lo que se
 * revisa en el panel de diseño es exactamente el CSS que corre en la tienda —
 * no una copia que se despega a la primera semana.
 *
 *   node design/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const aca      = dirname(fileURLToPath(import.meta.url));
const previews = join(aca, 'previews');
const salida   = join(aca, 'dist');

const tokens     = readFileSync(join(aca, 'tokens.css'), 'utf8');
const componentes = readFileSync(join(aca, 'components.css'), 'utf8');

// El marcador @dsCard tiene que ser la primera línea del HTML final: de ahí
// saca el panel el nombre y el grupo de cada tarjeta.
const MARCADOR = /^<!--\s*@dsCard[^>]*-->/;

mkdirSync(salida, { recursive: true });

const archivos = readdirSync(previews).filter(f => f.endsWith('.html'));

for (const archivo of archivos) {
  const crudo = readFileSync(join(previews, archivo), 'utf8');
  const match = crudo.match(MARCADOR);

  if (!match) {
    console.error(`  ✗ ${archivo} — falta el marcador @dsCard en la primera línea`);
    process.exitCode = 1;
    continue;
  }

  const marcador  = match[0];
  const contenido = crudo.slice(marcador.length).trimStart();
  const titulo    = basename(archivo, '.html');

  const html = `${marcador}
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Librería Liceo · ${titulo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${tokens}
${componentes}

/* ── Solo para la previsualización: no forma parte de la tienda ── */
.pv-lienzo { padding: var(--e-6) var(--e-5); background: var(--bg); min-height: 100vh; }
.pv-seccion { margin-bottom: var(--e-8); }
.pv-seccion:last-child { margin-bottom: 0; }
.pv-titulo {
  font-family: var(--font-titulo);
  font-size: var(--t-xs);
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-3);
  margin: 0 0 var(--e-4);
  padding-bottom: var(--e-2);
  border-bottom: 1px solid var(--border);
}
.pv-nota {
  font-size: var(--t-xs);
  color: var(--text-2);
  line-height: 1.5;
  margin-top: var(--e-3);
  padding-left: var(--e-3);
  border-left: 2px solid var(--border-2);
}
.pv-fila { display: flex; flex-wrap: wrap; gap: var(--e-3); align-items: center; }
.pv-columna { display: flex; flex-direction: column; gap: var(--e-4); }
.pv-marco {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  overflow: hidden;
}
.pv-telefono {
  width: 375px;
  max-width: 100%;
  border: 1px solid var(--border-2);
  border-radius: var(--r-xl);
  overflow: hidden;
  background: var(--bg);
  box-shadow: var(--s-3);
}
</style>
</head>
<body>
<div class="pv-lienzo">
${contenido}
</div>
</body>
</html>
`;

  writeFileSync(join(salida, archivo), html, 'utf8');
  console.log(`  ✓ ${archivo}`);
}

console.log(`\n${archivos.length} previsualizaciones en design/dist/`);
