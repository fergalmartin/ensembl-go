from PIL import Image, ImageDraw, ImageFilter
import os

def create_mac_icon(input_path, output_path, size=(1024, 1024)):
    """
    Processes a raw square logo into a macOS-style icon:
    1. Resizes logo to ~85% of canvas (to create padding).
    2. Applies a squircle mask for rounded corners.
    """
    
    # 1. Open original image
    try:
        # Resolve path - we are in electron dir
        real_input = os.path.join(os.path.dirname(__file__), input_path)
        img = Image.open(real_input).convert("RGBA")
    except FileNotFoundError:
        print(f"Error: Could not find {input_path}")
        return

    # 2. Resize to 85% of the target canvas size
    # This creates the standard padding effect so it's not "huge"
    scale_factor = 0.80
    new_w = int(size[0] * scale_factor)
    new_h = int(size[1] * scale_factor)
    
    # Resize with high quality filter
    img_resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    
    # 3. Create a mask specifically for the resized content
    # A rounded rectangle mask for the content itself
    mask_size = (new_w, new_h)
    mask = Image.new("L", mask_size, 0)
    draw = ImageDraw.Draw(mask)
    
    # Corner radius approx 22% of dimension looks like a squircle
    corner_radius = int(new_w * 0.22)
    draw.rounded_rectangle([(0, 0), mask_size], radius=corner_radius, fill=255)
    
    # Apply mask to the resized image
    # Creates a new transparent image for just the content
    content_masked = Image.new("RGBA", mask_size, (0, 0, 0, 0))
    content_masked.paste(img_resized, (0, 0), mask=mask)
    
    # 4. Place masked content onto final transparent canvas
    final_canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    
    # Center it
    offset_x = (size[0] - new_w) // 2
    offset_y = (size[1] - new_h) // 2
    
    final_canvas.paste(content_masked, (offset_x, offset_y))
    
    # 5. Save
    real_output = os.path.join(os.path.dirname(__file__), output_path)
    final_canvas.save(real_output, "PNG")
    print(f"Created processed icon at {real_output}")


def create_windows_icon(input_path, output_path, sizes=((256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16))):
    """Create a Windows .ico from the same source asset."""
    try:
        real_input = os.path.join(os.path.dirname(__file__), input_path)
        img = Image.open(real_input).convert("RGBA")
    except FileNotFoundError:
        print(f"Error: Could not find {input_path}")
        return

    real_output = os.path.join(os.path.dirname(__file__), output_path)
    img.save(real_output, format="ICO", sizes=sizes)
    print(f"Created Windows icon at {real_output}")

if __name__ == "__main__":
    # Input: The file in public (relative to electron dir)
    input_file = "../frontend/public/e-icon.png"
    # Output: The file expected by electron-builder in build/
    output_file = "build/icon.png"
    output_ico = "build/icon.ico"
    
    # Ensure build dir exists
    if not os.path.exists("build"):
        os.makedirs("build")
        
    create_mac_icon(input_file, output_file)
    create_windows_icon(input_file, output_ico)
