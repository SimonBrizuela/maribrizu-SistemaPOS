/**
 * Un doble de `firebase/firestore` para las pruebas.
 *
 * Varias pruebas importan módulos del panel que abren Firestore al cargarse,
 * aunque lo que se esté probando sea una cuenta pura. Este doble los deja
 * importar sin credenciales ni red.
 *
 * Está escrito export por export a propósito. Antes esto era un
 * `new Proxy({}, { get: () => () => {} })`, que devuelve una función para
 * CUALQUIER nombre: si el módulo empezaba a usar una función nueva, la prueba
 * seguía en verde llamando a un doble vacío que no hacía nada. Con la lista
 * explícita, lo que falta aparece como error en vez de esconderse.
 *
 * Quien necesite espiar una escritura pasa `registro`: es un array donde se
 * apilan los `addDoc` / `setDoc` / `updateDoc` en el orden en que ocurren.
 */
export function firestoreFalso({ registro = null, docs = [] } = {}) {
  const anotar = (tipo, ref, datos) => {
    if (registro) registro.push({ tipo, ref, datos });
  };
  const instantanea = () => ({
    docs: docs.map(d => ({ id: d.id, ref: { id: d.id }, data: () => d.data ?? d,
                           exists: () => true })),
    empty: docs.length === 0,
    size: docs.length,
    docChanges: () => [],
  });

  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id }),
    query: (col, ...partes) => ({ col, partes }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    orderBy: (campo, dir) => ({ campo, dir }),
    limit: (n) => ({ limit: n }),
    startAfter: (...a) => ({ startAfter: a }),
    documentId: () => '__name__',
    getDocs: async () => instantanea(),
    getDoc: async () => ({ exists: () => docs.length > 0, data: () => docs[0]?.data ?? docs[0] }),
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    addDoc: async (ref, datos) => { anotar('add', ref, datos); return { id: 'nuevo' }; },
    setDoc: async (ref, datos) => { anotar('set', ref, datos); },
    updateDoc: async (ref, datos) => { anotar('update', ref, datos); },
    deleteDoc: async (ref) => { anotar('delete', ref, null); },
    onSnapshot: () => () => {},
    runTransaction: async (_db, fn) => fn({
      get: async (ref) => ({ exists: () => false, data: () => ({}), ref }),
      set: (ref, datos) => anotar('tx-set', ref, datos),
      update: (ref, datos) => anotar('tx-update', ref, datos),
    }),
    writeBatch: () => ({
      set: (ref, datos) => anotar('batch-set', ref, datos),
      update: (ref, datos) => anotar('batch-update', ref, datos),
      delete: (ref) => anotar('batch-delete', ref, null),
      commit: async () => {},
    }),
    serverTimestamp: () => 'AHORA',
    increment: (n) => ({ _incremento: n }),
    arrayUnion: (...v) => ({ _union: v }),
    arrayRemove: (...v) => ({ _remove: v }),
    Timestamp: {
      fromDate: (d) => ({ toDate: () => d, seconds: Math.floor(d.getTime() / 1000) }),
      now: () => ({ toDate: () => new Date() }),
    },
  };
}
