from PIL import Image
import os
from datetime import datetime

class ImageHandler:
    def __init__(self, base_path=None):
        if base_path is None:
            from pos_system.config import IMAGES_DIR
            base_path = str(IMAGES_DIR)
        self.base_path = base_path
        os.makedirs(base_path, exist_ok=True)
        
    def save_product_image(self, source_path, product_id=None):
        '''Guardar y optimizar imagen de producto'''
        try:
            # Abrir imagen
            img = Image.open(source_path)
            
            # Convertir a RGB si es necesario
            if img.mode in ('RGBA', 'P', 'LA'):
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = background
            elif img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Redimensionar manteniendo aspecto ratio (max 800x800)
            max_size = (800, 800)
            img.thumbnail(max_size, Image.Resampling.LANCZOS)
            
            # Generar nombre de archivo
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            filename = f'product_{product_id}_{timestamp}.jpg' if product_id else f'product_{timestamp}.jpg'
            save_path = os.path.join(self.base_path, filename)
            
            # Guardar con compresión
            img.save(save_path, 'JPEG', quality=85, optimize=True)
            
            return save_path
            
        except Exception as e:
            print(f'Error al guardar imagen: {e}')
            return None
            
    def delete_product_image(self, image_path):
        '''Eliminar imagen de producto'''
        try:
            if image_path and os.path.exists(image_path):
                os.remove(image_path)
                return True
        except Exception as e:
            print(f'Error al eliminar imagen: {e}')
        return False
        
    def create_thumbnail(self, source_path, size=(150, 150)):
        '''Crear miniatura de imagen'''
        try:
            img = Image.open(source_path)
            img.thumbnail(size, Image.Resampling.LANCZOS)
            
            thumbnail_path = source_path.replace('.jpg', '_thumb.jpg')
            img.save(thumbnail_path, 'JPEG', quality=85)
            
            return thumbnail_path
        except Exception as e:
            print(f'Error al crear miniatura: {e}')
            return None
            
    def get_image_info(self, image_path):
        '''Obtener información de la imagen'''
        try:
            img = Image.open(image_path)
            return {
                'size': img.size,
                'format': img.format,
                'mode': img.mode,
                'file_size': os.path.getsize(image_path)
            }
        except Exception as e:
            print(f'Error al obtener info de imagen: {e}')
            return None
            
    def crop_to_square(self, source_path):
        '''Recortar imagen a cuadrado'''
        try:
            img = Image.open(source_path)
            width, height = img.size
            
            # Calcular dimensiones del cuadrado
            size = min(width, height)
            left = (width - size) // 2
            top = (height - size) // 2
            right = left + size
            bottom = top + size
            
            # Recortar
            img_cropped = img.crop((left, top, right, bottom))
            
            # Guardar
            cropped_path = source_path.replace('.jpg', '_square.jpg')
            img_cropped.save(cropped_path, 'JPEG', quality=85)
            
            return cropped_path
        except Exception as e:
            print(f'Error al recortar imagen: {e}')
            return None
            
    def rotate_image(self, source_path, degrees):
        '''Rotar imagen'''
        try:
            img = Image.open(source_path)
            img_rotated = img.rotate(degrees, expand=True)
            
            rotated_path = source_path.replace('.jpg', f'_rot{degrees}.jpg')
            img_rotated.save(rotated_path, 'JPEG', quality=85)
            
            return rotated_path
        except Exception as e:
            print(f'Error al rotar imagen: {e}')
            return None
