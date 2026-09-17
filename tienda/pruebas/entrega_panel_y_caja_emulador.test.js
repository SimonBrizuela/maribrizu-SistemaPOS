// @vitest-environment node
/**
 * El panel de verdad y las cajas de verdad entregando el mismo pedido al mismo
 * tiempo, contra el emulador de Firestore.
 *
 * `pos_system/tests/test_pedidos_tienda_nube.py` prueba las cajas entre sí y
 * contra una COPIA en Python de la transacción vieja del panel. Esto corre el
 * `registrarEntrega` del panel con el SDK web y, en el mismo instante, tres
 * cajas con `NubePedidos.entregar` en un proceso de Python aparte. Dos SDKs,
 * dos lenguajes, un pedido: el stock tiene que salir una sola vez.
 *
 * Necesita el emulador; sin él se saltea. Se corre con:
 *
 *   firebase emulators:exec --config pos_system/tests/emulador/firebase.json \
 *     --only firestore --project demo-pos-pedidos \
 *     "cd tienda && npx vitest run pruebas/entrega_panel_y_caja_emulador.test.js"
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EMULADOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROYECTO = 'demo-pos-pedidos';
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

vi.mock('../../webapp/src/avisos_cliente.js', () => ({ avisarAlCliente: async () => true }));
vi.mock('../../webapp/src/tienda_espejo.js', () => ({ reflejarSiPublicado: async () => ({}) }));

const CAJAS_PYTHON = `
import os, sys, threading, time
sys.path.insert(0, os.getcwd())
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
from pos_system.utils.pedidos_tienda_nube import NubePedidos
pid, arranque = sys.argv[1], float(sys.argv[2]) / 1000
resultados = []
def caja(i):
    db = firestore.Client(project='${PROYECTO}', credentials=AnonymousCredentials())
    nube = NubePedidos(db, quien=lambda: {'pc_id': f'CAJA{i}', 'pc_nombre': f'CAJA{i}', 'cajero': 'x'}, avisar_cliente=False)
    time.sleep(max(0, arranque - time.time()))
    r = nube.entregar(pid)
    resultados.append('plan' if (r.ok and r.plan is not None) else ('ok' if r.ok else 'error'))
hilos = [threading.Thread(target=caja, args=(i,)) for i in range(3)]
[h.start() for h in hilos]
[h.join(90) for h in hilos]
print(','.join(resultados))
`;

function cajasEnPython(pid, arranque) {
  return new Promise((resolver, rechazar) => {
    const p = spawn('python', ['-c', CAJAS_PYTHON, pid, String(arranque)], { cwd: RAIZ, env: process.env });
    let salida = '';
    let error = '';
    p.stdout.on('data', d => { salida += d; });
    p.stderr.on('data', d => { error += d; });
    p.on('close', codigo => (codigo === 0 ? resolver(salida.trim().split(',')) : rechazar(new Error(error))));
  });
}

describe.skipIf(!EMULADOR)('panel y cajas entregando el mismo pedido', () => {
  let fs;
  let db;
  let registrarEntrega;

  beforeAll(async () => {
    const { initializeApp } = await import('firebase/app');
    fs = await import('firebase/firestore');
    const app = initializeApp({ projectId: PROYECTO, apiKey: 'emulador' }, 'emulador-entrega');
    db = fs.getFirestore(app);
    const [host, puerto] = EMULADOR.split(':');
    fs.connectFirestoreEmulator(db, host, Number(puerto));
    ({ registrarEntrega } = await import('../../webapp/src/entregar_pedido.js'));
  });

  it('el stock sale una sola vez, gane quien gane', async () => {
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      const pid = `PANELYCAJA${vuelta}`;
      await fs.setDoc(fs.doc(db, 'catalogo', 'GOMA'), { nombre: 'GOMA', stock: 40 });
      await fs.setDoc(fs.doc(db, 'tienda_pedidos', pid), {
        codigo: `PC${vuelta}`, estado: 'entregado', venta_pendiente: true, entregado_por: 'reparto',
        entrega: { modo: 'delivery' }, pago: { modo: 'transferencia' }, cliente: { nombre: 'Ana' },
        items: [{ id: 'GOMA', nombre: 'Goma', cantidad: 3, precio: 500, subtotal: 1500 }],
        subtotal: 1500, envio: 0, total: 1500,
      });

      // En vueltas alternadas arranca antes uno u otro: si siempre gana el
      // mismo, la prueba solo mira un orden.
      const arranque = Date.now() + 2500;
      const python = cajasEnPython(pid, arranque + (vuelta % 2 ? 400 : 0));
      await new Promise(r => setTimeout(r, arranque + (vuelta % 2 ? 0 : 60) - Date.now()));
      const panel = await Promise.all([0, 1].map(() =>
        registrarEntrega(db, pid, { usuario: 'Panel' }).then(r => (!r.ok ? 'rechazo' : r.yaEstaba ? 'ok' : 'plan'), () => 'error')));
      const cajas = await python;

      const stock = (await fs.getDoc(fs.doc(db, 'catalogo', 'GOMA'))).data().stock;
      const pedido = (await fs.getDoc(fs.doc(db, 'tienda_pedidos', pid))).data();
      const movs = await fs.getDocs(fs.query(fs.collection(db, 'stock_movimientos'), fs.where('pedido_id', '==', pid)));
      const intentos = new Set(movs.docs.map(d => d.data().intento));

      console.info(`vuelta ${vuelta}: panel ${panel} · cajas ${cajas}`);
      expect(stock, `vuelta ${vuelta}: panel ${panel} cajas ${cajas}`).toBe(37);
      expect(intentos.size).toBe(1);
      expect([...panel, ...cajas].filter(x => x === 'plan')).toHaveLength(1);
      expect(pedido).toMatchObject({ stock_descontado: true, cobro_pendiente: true, venta_pendiente: false });
    }
  }, 180_000);
});
