"""
Dibuja las imágenes del recorrido del pedido que van en las notificaciones del
celular (tienda/public/avisos/*.png, 1024x512).

Una página web no puede poner una barra de progreso en una notificación: la
imagen grande de abajo dibuja los pasos con el actual marcado, y así se ve el
avance. Los pasos y los nombres de archivo tienen que coincidir con
`pasosDeAviso()` en tienda/src/avisos_estado.js (la prueba avisos_estado.test.js
falla si falta alguna).

    python scripts/generar_imagenes_avisos.py

Necesita Playwright con Chromium y las fuentes de tienda/node_modules/@fontsource.
"""
import base64
from pathlib import Path

from playwright.sync_api import sync_playwright

TIENDA = Path(__file__).resolve().parent.parent / 'tienda'
SALIDA = TIENDA / 'public' / 'avisos'
FUENTES = TIENDA / 'node_modules' / '@fontsource'


def fuente(relativa):
    # Incrustada: una página armada con set_content no puede leer archivos locales.
    return 'data:font/woff2;base64,' + base64.b64encode((FUENTES / relativa).read_bytes()).decode()


PASOS = {
    'retiro': [('nuevo', 'Recibido'), ('preparando', 'Preparando'), ('listo', 'Para retirar'),
               ('entregado', 'Entregado')],
    'envio': [('nuevo', 'Recibido'), ('preparando', 'Preparando'), ('listo', 'Listo'),
              ('en_camino', 'En camino'), ('entregado', 'Entregado')],
}
TITULOS = {
    'preparando': 'Estamos armando tu pedido',
    'listo': {'retiro': 'Ya lo podés pasar a buscar', 'envio': 'Listo para salir'},
    'en_camino': 'Va en camino',
    'entregado': {'retiro': 'Pedido retirado', 'envio': 'Pedido entregado'},
}

TILDE = ('<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#0E0D10" '
         'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>')


def html(modo, actual, rubik, nunito):
    pasos = PASOS[modo]
    i_actual = [c for c, _ in pasos].index(actual)
    titulo = TITULOS[actual][modo] if isinstance(TITULOS[actual], dict) else TITULOS[actual]
    marcas = []
    for i, (_clave, texto) in enumerate(pasos):
        hecho = i < i_actual or (actual == 'entregado' and i == i_actual)
        estado = 'hecho' if hecho else ('actual' if i == i_actual else 'falta')
        marcas.append(f'''
          <div class="paso paso--{estado}">
            <div class="marca">{TILDE if estado == 'hecho' else ''}</div>
            <div class="texto">{texto}</div>
          </div>''')
    avance = (i_actual / (len(pasos) - 1)) * 100
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face {{ font-family: Rubik; font-weight: 700; src: url('{rubik}'); }}
      @font-face {{ font-family: Nunito; font-weight: 700; src: url('{nunito}'); }}
      * {{ box-sizing: border-box; margin: 0; }}
      body {{ width: 1024px; height: 512px; background: #0E0D10; color: #fff; font-family: Nunito, sans-serif;
             position: relative; overflow: hidden; }}
      .franja {{ position: absolute; inset: 0 0 auto; height: 12px; display: flex; }}
      .franja i {{ flex: 1; }}
      .marca-local {{ position: absolute; left: 72px; top: 64px; font: 700 24px Nunito; letter-spacing: .14em;
                     text-transform: uppercase; color: rgba(255,255,255,.62); }}
      h1 {{ position: absolute; left: 72px; top: 104px; right: 72px; font: 700 58px/1.1 Rubik; letter-spacing: -.02em; }}
      .recorrido {{ position: absolute; left: 72px; right: 72px; top: 318px; }}
      .riel {{ position: absolute; left: 34px; right: 34px; top: 33px; height: 6px; border-radius: 3px;
              background: rgba(255,255,255,.16); }}
      .riel i {{ display: block; height: 100%; width: {avance}%; border-radius: 3px; background: #8EC63F; }}
      .pasos {{ position: relative; display: flex; justify-content: space-between; }}
      .paso {{ width: 150px; margin: 0 -40px; display: flex; flex-direction: column; align-items: center; gap: 18px; }}
      .paso:first-child {{ margin-left: -41px; }} .paso:last-child {{ margin-right: -41px; }}
      .marca {{ width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center; }}
      .paso--hecho .marca {{ background: #8EC63F; width: 56px; height: 56px; margin: 8px 0; }}
      .paso--actual .marca {{ background: #7B3FA6; box-shadow: 0 0 0 10px rgba(123,63,166,.35), 0 0 0 20px rgba(123,63,166,.14); }}
      .paso--actual .marca::after {{ content: ''; width: 22px; height: 22px; border-radius: 50%; background: #fff; }}
      .paso--falta .marca {{ width: 40px; height: 40px; margin: 16px 0; border: 5px solid rgba(255,255,255,.28); background: #0E0D10; }}
      .texto {{ font: 700 26px Nunito; white-space: nowrap; color: rgba(255,255,255,.55); }}
      .paso--actual .texto {{ color: #fff; }}
      .paso--hecho .texto {{ color: rgba(255,255,255,.8); }}
    </style></head><body>
      <div class="franja"><i style="background:#7B3FA6"></i><i style="background:#8EC63F"></i><i style="background:#F39C12"></i><i style="background:#29ABCA"></i><i style="background:#E63946"></i></div>
      <p class="marca-local">Librería Liceo</p>
      <h1>{titulo}</h1>
      <div class="recorrido"><div class="riel"><i></i></div><div class="pasos">{''.join(marcas)}</div></div>
    </body></html>'''


def main():
    SALIDA.mkdir(parents=True, exist_ok=True)
    rubik = fuente('rubik/files/rubik-latin-700-normal.woff2')
    nunito = fuente('nunito-sans/files/nunito-sans-latin-700-normal.woff2')
    with sync_playwright() as p:
        nav = p.chromium.launch()
        pag = nav.new_page(viewport={'width': 1024, 'height': 512}, device_scale_factor=1)
        for modo, pasos in PASOS.items():
            for clave, _ in pasos:
                if clave == 'nuevo':
                    continue
                archivo = SALIDA / f'{modo}-{clave}.png'
                pag.set_content(html(modo, clave, rubik, nunito), wait_until='load')
                pag.evaluate('document.fonts.ready.then(() => document.fonts.size)')
                pag.wait_for_timeout(150)
                pag.screenshot(path=str(archivo), type='png')
                print(f'{archivo.name:28} {archivo.stat().st_size // 1024} KB')

        # La insignia de la barra de estado de Android: blanca sobre transparente,
        # que el sistema la pinta con su color. Es la bolsa de los iconos de la tienda.
        insignia = SALIDA / 'insignia.png'
        pag.set_viewport_size({'width': 96, 'height': 96})
        pag.set_content('''<html><body style="margin:0;background:transparent">
          <svg width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14"/><path d="M5 12a7 7 0 0 1 14 0"/>
            <path d="M7 12v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-6"/></svg></body></html>''')
        pag.screenshot(path=str(insignia), type='png', omit_background=True)
        print(f'{insignia.name:28} {insignia.stat().st_size // 1024} KB')
        nav.close()


if __name__ == '__main__':
    main()
