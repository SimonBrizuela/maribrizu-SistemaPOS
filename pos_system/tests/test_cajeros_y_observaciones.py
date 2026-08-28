"""
Las dos pestañas chicas del POS: Cajeros y Observaciones.

Cajeros es quién puede entrar y qué puede tocar (el rol decide si se ven Caja,
Productos y Fiscal). Observaciones son las notas que se dejan entre turnos y
que viajan a las demás PCs.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.observation import Observation
from pos_system.models.user import User


@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'cajeros.db'))
    base.initialize_database()
    yield base


# ── Cajeros ───────────────────────────────────────────────────────────────

@pytest.fixture
def usuarios(db):
    return User(db)


class TestEntrarAlSistema:
    def test_entrar_con_la_clave_correcta(self, usuarios):
        usuarios.create('marta', 'clave1234', 'Marta Gómez', 'cajero')
        u = usuarios.authenticate('marta', 'clave1234')
        assert u is not None and u['full_name'] == 'Marta Gómez'

    def test_el_usuario_no_distingue_mayusculas(self, usuarios):
        usuarios.create('Marta', 'clave1234', 'Marta Gómez')
        assert usuarios.authenticate('MARTA', 'clave1234') is not None

    def test_la_clave_si_distingue(self, usuarios):
        usuarios.create('marta', 'clave1234', 'Marta Gómez')
        assert usuarios.authenticate('marta', 'CLAVE1234') is None

    def test_un_usuario_que_no_existe_no_entra(self, usuarios):
        assert usuarios.authenticate('nadie', 'loquesea') is None

    def test_un_cajero_dado_de_baja_no_entra(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        usuarios.delete(uid)
        assert usuarios.authenticate('marta', 'clave1234') is None
        # Pero no se borró: el historial de sus ventas sigue teniendo su nombre.
        assert usuarios.get_by_id(uid) is not None

    def test_entrar_deja_la_marca_del_ultimo_ingreso(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        assert usuarios.get_by_id(uid)['last_login'] is None
        usuarios.authenticate('marta', 'clave1234')
        assert usuarios.get_by_id(uid)['last_login'] is not None

    def test_la_clave_no_se_guarda_en_texto(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        assert 'clave1234' not in str(usuarios.get_by_id(uid)['password_hash'])


class TestAltaDeCajeros:
    def test_no_se_repite_el_usuario(self, usuarios):
        usuarios.create('marta', 'clave1234', 'Marta Gómez')
        with pytest.raises(ValueError):
            usuarios.create('marta', 'otra1234', 'Otra Marta')

    def test_una_clave_corta_se_rechaza(self, usuarios):
        with pytest.raises(ValueError):
            usuarios.create('marta', '123', 'Marta Gómez')

    def test_un_rol_inventado_se_rechaza(self, usuarios):
        with pytest.raises(ValueError):
            usuarios.create('marta', 'clave1234', 'Marta Gómez', 'gerente')

    def test_hace_falta_nombre_y_usuario(self, usuarios):
        with pytest.raises(ValueError):
            usuarios.create('', 'clave1234', 'Marta')
        with pytest.raises(ValueError):
            usuarios.create('marta', 'clave1234', '   ')

    def test_la_primera_vez_se_crea_el_admin(self, usuarios):
        assert usuarios.ensure_default_admin() is True
        assert usuarios.authenticate('admin', 'admin123')['role'] == 'admin'
        # Con usuarios ya cargados no vuelve a crearlo.
        assert usuarios.ensure_default_admin() is False


class TestCambiosDeCajero:
    def test_cambiar_la_clave(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        usuarios.change_password(uid, 'nueva5678')
        assert usuarios.authenticate('marta', 'clave1234') is None
        assert usuarios.authenticate('marta', 'nueva5678') is not None

    def test_una_clave_nueva_corta_se_rechaza(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        with pytest.raises(ValueError):
            usuarios.change_password(uid, '12')

    def test_ascender_a_administrador(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez', 'cajero')
        usuarios.update(uid, role='admin')
        assert usuarios.get_by_id(uid)['role'] == 'admin'

    def test_no_se_puede_poner_un_rol_que_no_existe(self, usuarios):
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        with pytest.raises(ValueError):
            usuarios.update(uid, role='dueño')

    def test_los_campos_que_no_estan_permitidos_se_ignoran(self, usuarios):
        """Nadie se cambia la contraseña por la puerta de atrás."""
        uid = usuarios.create('marta', 'clave1234', 'Marta Gómez')
        antes = usuarios.get_by_id(uid)['password_hash']
        usuarios.update(uid, password_hash='pirata', username='otro')
        despues = usuarios.get_by_id(uid)
        assert despues['password_hash'] == antes
        assert despues['username'] == 'marta'


# ── Observaciones ─────────────────────────────────────────────────────────

@pytest.fixture
def notas(db):
    return Observation(db)


class TestObservaciones:
    def test_dejar_una_nota_para_el_turno_que_sigue(self, notas):
        oid = notas.create('Falta reponer papel obra', created_by_name='Marta')
        n = notas.get_by_id(oid)
        assert n['text'] == 'Falta reponer papel obra'
        assert n['context'] == 'general'
        assert n['created_by_name'] == 'Marta'

    def test_una_nota_atada_a_una_venta(self, notas):
        oid = notas.create('El cliente pidió factura después',
                           context='sale', sale_id=12, sale_item_id=3)
        n = notas.get_by_id(oid)
        assert n['context'] == 'sale'
        assert n['sale_id'] == 12

    def test_una_nota_vacia_no_se_guarda(self, notas):
        with pytest.raises(ValueError):
            notas.create('   ')

    def test_un_contexto_inventado_se_rechaza(self, notas):
        with pytest.raises(ValueError):
            notas.create('algo', context='inventario')

    def test_dos_notas_seguidas_sin_internet(self, notas):
        """El bug viejo: `firebase_id` es UNIQUE y su default era ''. SQLite
        admite muchos NULL pero un solo '', así que la segunda nota creada
        antes de que el sync le asignara su id reventaba y se perdía."""
        notas.create('primera')
        notas.create('segunda')
        assert len(notas.get_all()) == 2

    def test_borrar_la_saca_de_la_lista_sin_perderla(self, notas):
        oid = notas.create('nota vieja')
        notas.delete(oid)
        assert notas.get_all() == []
        assert len(notas.get_all(include_deleted=True)) == 1

    def test_las_mas_nuevas_arriba(self, notas):
        notas.create('primera')
        notas.create('segunda')
        assert notas.get_all()[0]['text'] == 'segunda'

    def test_lo_que_llega_de_otra_pc_no_se_duplica(self, notas):
        notas.upsert_from_firebase('fb-1', {'text': 'desde la otra PC'})
        notas.upsert_from_firebase('fb-1', {'text': 'desde la otra PC, corregida'})
        todas = notas.get_all()
        assert len(todas) == 1
        assert todas[0]['text'] == 'desde la otra PC, corregida'

    def test_una_nota_borrada_en_otra_pc_se_borra_aca(self, notas):
        notas.upsert_from_firebase('fb-1', {'text': 'algo'})
        notas.upsert_from_firebase('fb-1', {'text': 'algo', 'deleted': True})
        assert notas.get_all() == []

    def test_lo_que_llega_vacio_se_ignora(self, notas):
        assert notas.upsert_from_firebase('fb-1', {'text': '  '}) is None
        assert notas.upsert_from_firebase('', {'text': 'algo'}) is None
        assert notas.get_all() == []
