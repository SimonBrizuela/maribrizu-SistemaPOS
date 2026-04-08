"""
Tests for core models (Product, Sale, CashRegister, User)
Run with: python -m pytest tests/ -v
"""
import pytest
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.product import Product
from pos_system.models.sale import Sale
from pos_system.models.cash_register import CashRegister
from pos_system.models.user import User
from pos_system.utils.validators import ValidationError

TEST_DB = 'tmp_rovodev_pytest_test.db'


@pytest.fixture(scope='function')
def db():
    """Fresh database for each test"""
    database = DatabaseManager(TEST_DB)
    database.initialize_database()
    yield database
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


@pytest.fixture
def product_model(db):
    return Product(db)


@pytest.fixture
def sale_model(db):
    return Sale(db)


@pytest.fixture
def cash_register_model(db):
    return CashRegister(db)


@pytest.fixture
def user_model(db):
    return User(db)


@pytest.fixture
def open_register(db, cash_register_model):
    """Open a cash register and return its ID"""
    reg_id = cash_register_model.open_register(initial_amount=500.0)
    return reg_id


@pytest.fixture
def sample_product(product_model):
    """Create a sample product and return its ID"""
    pid = product_model.create({
        'name': 'Coca Cola 500ml',
        'price': 2.50,
        'cost': 1.20,
        'stock': 50,
        'category': 'Bebidas',
        'barcode': 'COC500'
    })
    return pid


# ===== USER TESTS =====

class TestUser:
    def test_create_user(self, user_model):
        uid = user_model.create('testuser', 'pass1234', 'Test User', 'cajero')
        assert uid is not None and uid > 0

    def test_create_admin(self, user_model):
        uid = user_model.create('admin2', 'pass1234', 'Admin 2', 'admin')
        assert uid is not None

    def test_authenticate_success(self, user_model):
        user_model.create('juan', 'secret99', 'Juan Perez', 'cajero')
        result = user_model.authenticate('juan', 'secret99')
        assert result is not None
        assert result['username'] == 'juan'

    def test_authenticate_wrong_password(self, user_model):
        user_model.create('maria', 'correct', 'Maria', 'cajero')
        result = user_model.authenticate('maria', 'wrong')
        assert result is None

    def test_authenticate_nonexistent(self, user_model):
        result = user_model.authenticate('nobody', 'pass')
        assert result is None

    def test_duplicate_username(self, user_model):
        user_model.create('user1', 'pass', 'User One', 'cajero')
        with pytest.raises(ValueError):
            user_model.create('user1', 'other', 'User Two', 'cajero')

    def test_invalid_role(self, user_model):
        with pytest.raises(ValueError):
            user_model.create('x', 'pass', 'X', 'superadmin')

    def test_password_too_short(self, user_model):
        with pytest.raises(ValueError):
            user_model.create('x', '123', 'X', 'cajero')

    def test_ensure_default_admin(self, user_model):
        created = user_model.ensure_default_admin()
        assert created is True
        user = user_model.authenticate('admin', 'admin123')
        assert user is not None
        assert user['role'] == 'admin'

    def test_ensure_default_admin_only_once(self, user_model):
        user_model.ensure_default_admin()
        created_again = user_model.ensure_default_admin()
        assert created_again is False

    def test_deactivate_user(self, user_model):
        uid = user_model.create('todeactivate', 'pass1234', 'Temp', 'cajero')
        user_model.delete(uid)
        result = user_model.authenticate('todeactivate', 'pass1234')
        assert result is None


# ===== PRODUCT TESTS =====

class TestProduct:
    def test_create_product(self, product_model):
        pid = product_model.create({'name': 'Agua Mineral', 'price': 1.50, 'stock': 100})
        assert pid is not None and pid > 0

    def test_get_by_id(self, product_model, sample_product):
        p = product_model.get_by_id(sample_product)
        assert p is not None
        assert p['name'] == 'Coca Cola 500ml'
        assert p['price'] == 2.50
        assert p['stock'] == 50

    def test_get_by_barcode(self, product_model, sample_product):
        p = product_model.get_by_barcode('COC500')
        assert p is not None
        assert p['id'] == sample_product

    def test_update_product(self, product_model, sample_product):
        result = product_model.update(sample_product, price=3.00, stock=60)
        assert result is True
        p = product_model.get_by_id(sample_product)
        assert p['price'] == 3.00
        assert p['stock'] == 60

    def test_delete_product(self, product_model, sample_product):
        product_model.delete(sample_product)
        p = product_model.get_by_id(sample_product)
        assert p is None

    def test_update_stock_positive(self, product_model, sample_product):
        product_model.update_stock(sample_product, 10)
        p = product_model.get_by_id(sample_product)
        assert p['stock'] == 60  # 50 + 10

    def test_update_stock_negative(self, product_model, sample_product):
        product_model.update_stock(sample_product, -5)
        p = product_model.get_by_id(sample_product)
        assert p['stock'] == 45  # 50 - 5

    def test_get_categories(self, product_model, sample_product):
        product_model.create({'name': 'Fanta', 'price': 2.0, 'stock': 30, 'category': 'Bebidas'})
        product_model.create({'name': 'Chips', 'price': 1.5, 'stock': 20, 'category': 'Snacks'})
        cats = product_model.get_categories()
        assert 'Bebidas' in cats
        assert 'Snacks' in cats

    def test_get_low_stock(self, product_model):
        product_model.create({'name': 'Escaso', 'price': 5.0, 'stock': 2})
        product_model.create({'name': 'Abundante', 'price': 5.0, 'stock': 100})
        low = product_model.get_low_stock(threshold=5)
        names = [p['name'] for p in low]
        assert 'Escaso' in names
        assert 'Abundante' not in names

    def test_toggle_favorite(self, product_model, sample_product):
        product_model.toggle_favorite(sample_product)
        p = product_model.get_by_id(sample_product)
        assert p['is_favorite'] == 1
        product_model.toggle_favorite(sample_product)
        p = product_model.get_by_id(sample_product)
        assert p['is_favorite'] == 0

    def test_duplicate_barcode_raises(self, product_model, sample_product):
        with pytest.raises(ValidationError):
            product_model.create({'name': 'Other', 'price': 1.0, 'stock': 5, 'barcode': 'COC500'})

    def test_invalid_price_raises(self, product_model):
        with pytest.raises(ValidationError):
            product_model.create({'name': 'Bad Price', 'price': -1, 'stock': 10})

    def test_search(self, product_model):
        product_model.create({'name': 'Pepsi Cola', 'price': 2.0, 'stock': 20})
        product_model.create({'name': 'Sprite', 'price': 2.0, 'stock': 20})
        results = product_model.get_all(search='Pepsi')
        assert len(results) == 1
        assert results[0]['name'] == 'Pepsi Cola'


# ===== CASH REGISTER TESTS =====

class TestCashRegister:
    def test_open_register(self, cash_register_model):
        reg_id = cash_register_model.open_register(initial_amount=200.0)
        assert reg_id is not None
        current = cash_register_model.get_current()
        assert current is not None
        assert current['initial_amount'] == 200.0

    def test_cannot_open_twice(self, cash_register_model):
        cash_register_model.open_register(100.0)
        with pytest.raises(Exception):
            cash_register_model.open_register(200.0)

    def test_close_register(self, cash_register_model):
        reg_id = cash_register_model.open_register(100.0)
        cash_register_model.close_register(reg_id, final_amount=100.0)
        current = cash_register_model.get_current()
        assert current is None

    def test_add_withdrawal(self, cash_register_model):
        reg_id = cash_register_model.open_register(500.0)
        wid = cash_register_model.add_withdrawal(reg_id, 50.0, 'Pago proveedor')
        assert wid is not None
        withdrawals = cash_register_model.get_withdrawals(reg_id)
        assert len(withdrawals) == 1
        assert withdrawals[0]['amount'] == 50.0

    def test_cash_summary(self, cash_register_model):
        cash_register_model.open_register(300.0)
        summary = cash_register_model.get_cash_summary()
        assert summary['status'] == 'open'
        assert summary['initial_amount'] == 300.0

    def test_closing_report(self, cash_register_model):
        reg_id = cash_register_model.open_register(100.0)
        report = cash_register_model.get_closing_report(reg_id)
        assert report['initial_amount'] == 100.0
        assert 'expected_amount' in report


# ===== SALE TESTS =====

class TestSale:
    def test_create_sale(self, sale_model, product_model, open_register):
        pid = product_model.create({'name': 'Item', 'price': 5.0, 'stock': 20})
        sale_id = sale_model.create({
            'total_amount': 10.0,
            'payment_type': 'cash',
            'cash_received': 10.0,
            'change_given': 0.0,
            'items': [{'product_id': pid, 'product_name': 'Item',
                        'quantity': 2, 'unit_price': 5.0}]
        })
        assert sale_id is not None

    def test_sale_decrements_stock(self, sale_model, product_model, open_register):
        pid = product_model.create({'name': 'Producto', 'price': 3.0, 'stock': 30})
        sale_model.create({
            'total_amount': 9.0,
            'payment_type': 'cash',
            'items': [{'product_id': pid, 'product_name': 'Producto',
                        'quantity': 3, 'unit_price': 3.0}]
        })
        p = product_model.get_by_id(pid)
        assert p['stock'] == 27  # 30 - 3

    def test_sale_insufficient_stock_raises(self, sale_model, product_model, open_register):
        pid = product_model.create({'name': 'Escaso', 'price': 1.0, 'stock': 2})
        with pytest.raises(ValueError):
            sale_model.create({
                'total_amount': 5.0,
                'payment_type': 'cash',
                'items': [{'product_id': pid, 'product_name': 'Escaso',
                            'quantity': 5, 'unit_price': 1.0}]
            })

    def test_sale_invalid_payment_type(self, sale_model, product_model, open_register):
        pid = product_model.create({'name': 'Producto Test', 'price': 1.0, 'stock': 10})
        with pytest.raises(ValueError):
            sale_model.create({
                'total_amount': 1.0,
                'payment_type': 'bitcoin',
                'items': [{'product_id': pid, 'product_name': 'P',
                            'quantity': 1, 'unit_price': 1.0}]
            })

    def test_sale_empty_items_raises(self, sale_model, open_register):
        with pytest.raises(ValueError):
            sale_model.create({'total_amount': 10.0, 'payment_type': 'cash', 'items': []})

    def test_get_sale_with_items(self, sale_model, product_model, open_register):
        pid = product_model.create({'name': 'Widget', 'price': 7.0, 'stock': 10})
        sid = sale_model.create({
            'total_amount': 7.0,
            'payment_type': 'transfer',
            'items': [{'product_id': pid, 'product_name': 'Widget',
                        'quantity': 1, 'unit_price': 7.0}]
        })
        sale = sale_model.get_by_id(sid)
        assert sale['total_amount'] == 7.0
        assert sale['payment_type'] == 'transfer'
        assert len(sale['items']) == 1
        assert sale['items'][0]['product_name'] == 'Widget'

    def test_sales_summary(self, sale_model, product_model, open_register):
        pid = product_model.create({'name': 'Producto X', 'price': 10.0, 'stock': 50})
        for _ in range(3):
            sale_model.create({
                'total_amount': 10.0,
                'payment_type': 'cash',
                'items': [{'product_id': pid, 'product_name': 'Producto X',
                            'quantity': 1, 'unit_price': 10.0}]
            })
        summary = sale_model.get_sales_summary()
        assert summary['total_count'] == 3
        assert summary['total_amount'] == 30.0

    def test_atomicity_on_failure(self, sale_model, product_model, open_register):
        """If stock fails mid-sale, nothing should be committed"""
        pid1 = product_model.create({'name': 'OK Product', 'price': 5.0, 'stock': 10})
        pid2 = product_model.create({'name': 'No Stock', 'price': 5.0, 'stock': 1})

        with pytest.raises(ValueError):
            sale_model.create({
                'total_amount': 10.0,
                'payment_type': 'cash',
                'items': [
                    {'product_id': pid1, 'product_name': 'OK Product', 'quantity': 1, 'unit_price': 5.0},
                    {'product_id': pid2, 'product_name': 'No Stock', 'quantity': 5, 'unit_price': 5.0},
                ]
            })

        # Stock should be unchanged for both products
        p1 = product_model.get_by_id(pid1)
        p2 = product_model.get_by_id(pid2)
        assert p1['stock'] == 10, "Stock of OK Product should not have changed"
        assert p2['stock'] == 1, "Stock of No Stock should not have changed"
