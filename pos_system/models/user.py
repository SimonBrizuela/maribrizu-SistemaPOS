"""
User model with authentication and role management
"""
import hashlib
import logging
import os
from datetime import datetime
from typing import List, Dict, Optional
from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

ROLES = {
    'admin': 'Administrador',
    'cajero': 'Cajero',
}


def _hash_password(password: str) -> str:
    """Hash a password using SHA-256 with a salt"""
    salt = "pos_system_salt_2026"
    return hashlib.sha256(f"{salt}{password}".encode()).hexdigest()


class User:
    """User model with authentication"""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def create(self, username: str, password: str, full_name: str, role: str = 'cajero') -> int:
        """Create a new user"""
        if role not in ROLES:
            raise ValueError(f"Rol inválido: {role}. Roles válidos: {list(ROLES.keys())}")
        if not username or not username.strip():
            raise ValueError("El nombre de usuario es obligatorio")
        if not password or len(password) < 4:
            raise ValueError("La contraseña debe tener al menos 4 caracteres")
        if not full_name or not full_name.strip():
            raise ValueError("El nombre completo es obligatorio")

        existing = self.get_by_username(username.strip())
        if existing:
            raise ValueError(f"El usuario '{username}' ya existe")

        query = """
            INSERT INTO users (username, password_hash, full_name, role, is_active)
            VALUES (?, ?, ?, ?, 1)
        """
        user_id = self.db.execute_update(query, (
            username.strip().lower(),
            _hash_password(password),
            full_name.strip(),
            role
        ))
        logger.info(f"Usuario creado: {username} (rol: {role})")
        return user_id

    def authenticate(self, username: str, password: str) -> Optional[Dict]:
        """Authenticate user and return user data if valid"""
        user = self.get_by_username(username.strip().lower())
        if not user:
            logger.warning(f"Intento de login con usuario inexistente: {username}")
            return None
        if not user['is_active']:
            logger.warning(f"Intento de login con usuario inactivo: {username}")
            return None
        if user['password_hash'] != _hash_password(password):
            logger.warning(f"Contraseña incorrecta para: {username}")
            return None

        # Actualizar last_login
        self.db.execute_update(
            "UPDATE users SET last_login = ? WHERE id = ?",
            (datetime.now().isoformat(), user['id'])
        )
        logger.info(f"Login exitoso: {username} (rol: {user['role']})")
        return user

    def get_by_username(self, username: str) -> Optional[Dict]:
        result = self.db.execute_query(
            "SELECT * FROM users WHERE username = ?", (username.lower(),)
        )
        return result[0] if result else None

    def get_by_id(self, user_id: int) -> Optional[Dict]:
        result = self.db.execute_query("SELECT * FROM users WHERE id = ?", (user_id,))
        return result[0] if result else None

    def get_all(self) -> List[Dict]:
        return self.db.execute_query(
            "SELECT id, username, full_name, role, is_active, created_at, last_login FROM users ORDER BY full_name"
        )

    def update(self, user_id: int, **kwargs) -> bool:
        allowed = ['full_name', 'role', 'is_active']
        updates = []
        params = []
        for key, value in kwargs.items():
            if key in allowed:
                if key == 'role' and value not in ROLES:
                    raise ValueError(f"Rol inválido: {value}")
                updates.append(f"{key} = ?")
                params.append(value)
        if not updates:
            return False
        params.append(user_id)
        self.db.execute_update(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", tuple(params))
        return True

    def change_password(self, user_id: int, new_password: str) -> bool:
        if not new_password or len(new_password) < 4:
            raise ValueError("La contraseña debe tener al menos 4 caracteres")
        self.db.execute_update(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (_hash_password(new_password), user_id)
        )
        return True

    def ensure_default_admin(self) -> bool:
        """Crea el usuario admin por defecto si no hay ningún usuario"""
        existing = self.get_all()
        if not existing:
            self.create(
                username='admin',
                password='admin123',
                full_name='Administrador',
                role='admin'
            )
            logger.info("Usuario admin por defecto creado (usuario: admin, contraseña: admin123)")
            return True
        return False

    def delete(self, user_id: int) -> bool:
        """Desactiva un usuario (no elimina físicamente)"""
        self.db.execute_update("UPDATE users SET is_active = 0 WHERE id = ?", (user_id,))
        return True

    def hard_delete(self, user_id: int) -> bool:
        """Elimina físicamente un usuario de la base de datos."""
        self.db.execute_update("DELETE FROM users WHERE id = ?", (user_id,))
        return True
