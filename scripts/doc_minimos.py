"""
Escribe REGLAS_VENTA_TIENDA.md: por que hay minimos, con que numeros se
calcularon y la lista completa de los productos que llevan uno.

    python scripts/doc_minimos.py

El documento queda fuera del repositorio (tiene costos y margenes). Se
regenera cuando cambian los parametros o los precios.
"""
import io
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from estudio_minimos import leer_catalogo, plata, regla_de  # noqa: E402
from estudio_negocio import conectar, leer_lineas  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, 'REGLAS_VENTA_TIENDA.md')

MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
         'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

# Los mismos con los que se aplicaron los minimos.
PREPARAR = 2000
RENGLON = 400
OBJETIVO = 1500
PEDIDO_MINIMO = 6500


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    hoy = datetime.now()
    db = conectar()

    print('Leyendo catálogo y ventas...')
    productos = leer_catalogo(db)
    lineas = leer_lineas(db, datetime.now(timezone.utc) - timedelta(days=120))

    vendidos = defaultdict(float)
    for l in lineas:
        if not l['servicio']:
            vendidos[l['clave']] += l['cantidad']

    for p in productos:
        p['vendidos'] = vendidos.get(p['clave'], 0)
        p['regla'] = regla_de(p, RENGLON)

    margenes = sorted(p['ganancia'] / p['precio'] for p in productos)
    margen = margenes[len(margenes) // 2]

    sueltos = [p for p in productos if p['regla']['tipo'] == 'suelto']
    con_minimo = [p for p in productos if p['regla']['tipo'] == 'minimo']
    sin_stock = [p for p in productos if p['regla']['tipo'] == 'no_vender']
    revisar = [p for p in productos if p['regla']['tipo'] == 'revisar']

    grupos = defaultdict(list)
    for p in con_minimo:
        grupos[p['regla']['minimo']].append(p)

    L = []
    w = L.append

    w('# De a cuánto se vende cada cosa en la tienda')
    w('')
    w(f'Aplicado el {hoy.day} de {MESES[hoy.month - 1]} de {hoy.year} sobre '
      f'{len(productos)} productos del catálogo')
    w('con precio, costo y stock.')
    w('')
    w('Calculado por `scripts/estudio_minimos.py`, escrito por '
      '`scripts/aplicar_minimos.py`,')
    w('este documento por `scripts/doc_minimos.py`.')
    w('')
    w('---')
    w('')
    w('## Por qué hay mínimos')
    w('')
    w('En el mostrador atender una venta cuesta cero: la persona ya está ahí. Un pedido')
    w('online no. Hay que leerlo, recorrer el local juntando las cosas, embalarlo, avisar')
    w('y despacharlo, y eso cuesta lo mismo para un pedido de $600 que para uno de $60.000.')
    w('')
    w('Vender un mapa de $100 que deja $40 por internet no es un negocio chico: es un')
    w('negocio al revés. Los $40 no pagan ni el minuto de ir a buscarlo entre 2.400')
    w('productos.')
    w('')
    w('## Los dos costos, que son distintos')
    w('')
    w('Confundirlos lleva a reglas absurdas. El primer intento le cargaba a cada renglón')
    w('la mitad del costo del pedido, y daba *"para comprar bolígrafos Bic hay que llevar')
    w('el rollo de 50"*. Separados:')
    w('')
    w('| | Qué es | Cómo se cubre |')
    w('|---|---|---|')
    w('| **Costo fijo del pedido** | leerlo, embalar, avisar, despachar. El mismo para '
      'uno o diez renglones | **Mínimo de pedido**, uno solo para toda la tienda |')
    w('| **Costo por renglón** | buscar esa cosa entre 2.400, contarla, cortarla | '
      '**Mínimo por producto** |')
    w('')
    w('## Los números que se usaron')
    w('')
    w('| | | De dónde sale |')
    w('|---|---|---|')
    w(f'| Preparar un pedido | **{plata(PREPARAR)}** | estimado: unos 12 minutos de una '
      'persona, más bolsa y cinta |')
    w(f'| Agregar un renglón | **{plata(RENGLON)}** | estimado: unos 2 minutos de '
      'buscarlo y contarlo |')
    w(f'| Ganancia buscada por pedido | **{plata(OBJETIVO)}** | decisión, no dato |')
    w(f'| De cada peso vendido queda | **{margen:.0%}** | mediana real del catálogo |')
    w('')
    w('Los tres primeros son estimaciones y conviene corregirlas:')
    w('`scripts/estudio_minimos.py --preparar 2500 --renglon 500` recalcula todo.')
    w('')
    w(f'## El mínimo de pedido: {plata(PEDIDO_MINIMO)}')
    w('')
    w(f'Con {margen:.0%} de margen, un pedido de {plata(PEDIDO_MINIMO)} deja '
      f'{plata(PEDIDO_MINIMO * margen)}: paga los')
    w(f'{plata(PREPARAR)} de prepararlo y sobran {plata(OBJETIVO)}. Debajo de '
      f'**{plata(PREPARAR / margen)}** el pedido deja')
    w('pérdida — lo que entra no paga el trabajo de armarlo.')
    w('')
    w('| Si preparar un pedido cuesta | El mínimo debería ser |')
    w('|---|---|')
    for prep in (1000, 1500, 2000, 2500, 3000):
        marca = '  ← el que está puesto' if prep == PREPARAR else ''
        w(f'| {plata(prep)} | {plata((prep + OBJETIVO) / margen)}{marca} |')
    w('')
    w('El checkout no dice "mínimo $6.500": dice cuánto falta. La resta la hace el sitio.')
    w('')
    w('## Los mínimos por producto')
    w('')
    w(f'De {len(productos)} productos, **{len(sueltos)} ({len(sueltos) / len(productos):.0%}) '
      f'se siguen vendiendo de a uno**: dejan más de')
    w(f'{plata(RENGLON)} la unidad y pagan solos el trabajo de buscarlos. Los otros '
      f'**{len(con_minimo)}** llevan un mínimo.')
    w('')
    w('El mínimo se redondea a un escalón que se pueda decir en voz alta — 2, 3, 5, 6,')
    w('10, 12, 25, 50 — porque "mínimo 7" no se lo cree nadie. Y tiene que caer justo en')
    w('un paso, o con los botones no se puede llegar.')
    w('')
    w('| Mínimo | Productos | De los que se venden | El que más se vende |')
    w('|---|---|---|---|')
    for m in sorted(grupos):
        lista = sorted(grupos[m], key=lambda p: -p['vendidos'])
        conVenta = len([p for p in lista if p['vendidos'] > 0])
        w(f'| {m} | {len(lista)} | {conVenta} | {lista[0]["nombre"][:38].title()} |')
    w('')
    w('Los mínimos altos (25, 50, 100) son todos productos de $10 a $150 — tachas, ojos')
    w('móviles, broches, palitos de helado, globos — que tampoco se venden de a uno en el')
    w('mostrador. Ninguno pasa de $7.500 el renglón mínimo.')
    w('')
    w('## Lo que quedó afuera')
    w('')
    w(f'**{len(sin_stock)} productos** necesitarían un mínimo más grande que el stock que')
    w('hay. Se dejaron sin mínimo: ponérselo sería sacarlos de la tienda sin decirlo.')
    w('')
    if revisar:
        w(f'**{len(revisar)} tienen el precio abajo del costo.** No es un problema de la')
        w('tienda, es un precio mal cargado en el POS:')
        w('')
        for p in revisar:
            w(f'- {p["nombre"]} — se vende a {plata(p["precio"])} y cuesta '
              f'{plata(p["costo"])}')
        w('')
    w('Y hay un caso para mirar: **OJO DE SEGURIDAD Nº16** se vende a $150 y deja $10, así')
    w('que le tocó un mínimo de 50 ($7.500). Un margen de $10 sobre $150 huele a costo')
    w('desactualizado más que a una decisión de precio.')
    w('')
    w('## Cómo se cambia')
    w('')
    w('En **Tienda › Catálogo de la Tienda**, abrir el producto, sección "Cómo se vende":')
    w('están *Mínimo que se puede llevar* y *De a cuánto sube*, en la unidad del producto')
    w('—metros para lo que se corta del rollo, unidades para el resto—. El panel muestra')
    w('en pesos cuánto queda el renglón más chico y avisa si no hay stock para sostenerlo.')
    w('')
    w('El mínimo de pedido está en **Tienda › Configuración › Entrega**.')
    w('')
    w(f'Para volver atrás los {len(con_minimo)} de una vez:')
    w('')
    w('```')
    w('python scripts/aplicar_minimos.py --deshacer')
    w('python scripts/sync_tienda.py')
    w('```')
    w('')
    w('Restaura desde `minimos_anteriores.json`, que se escribió antes de tocar nada.')
    w('')
    w('---')
    w('')
    w('## La lista completa')
    w('')
    w('Ordenada por lo que más se vende dentro de cada grupo. "Deja" es lo que queda de')
    w('una unidad después del costo; "renglón" es lo que sale el mínimo. Lo que lleva')
    w('`/m` se corta del rollo y su mínimo está en metros.')

    for m in sorted(grupos):
        lista = sorted(grupos[m], key=lambda p: -p['vendidos'])
        w('')
        w(f'### Mínimo {m} · {len(lista)} productos')
        w('')
        w('| Producto | Precio | Deja | Renglón | Vendidos en 4 meses |')
        w('|---|---|---|---|---|')
        for p in lista:
            unidad = ' /m' if p['unidad'] == 'metro' else ''
            vendidas = f'{p["vendidos"]:.0f}' if p['vendidos'] else '—'
            w(f'| {p["nombre"]} | {plata(p["precio"])}{unidad} | {plata(p["ganancia"])} '
              f'| {plata(m * p["precio"])} | {vendidas} |')

    io.open(SALIDA, 'w', encoding='utf-8', newline='\n').write('\n'.join(L) + '\n')
    print(f'{SALIDA} · {len(L)} líneas · {len(con_minimo)} productos con mínimo')


if __name__ == '__main__':
    main()
