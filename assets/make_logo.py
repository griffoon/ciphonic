"""Draws the C1PH0N1C logo: a cipher disk whose ring is written in 0 and 1 and left open
like a «C», with a bold «1» standing inside it. Writes icons/icon.ico, docs/icon.png and
docs/logo.png.

Run from the repo root:  python assets/make_logo.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
ACID = (198, 255, 0, 255)
BG = (5, 5, 6, 255)
MONO = "C:/Windows/Fonts/consolab.ttf"
DISPLAY = "ui/fonts/Unbounded-ExtraBold.ttf"
# The opening of the «C», centred on the right, in degrees.
GAP = 64


def ring(draw, radius, font_size, phase, alpha):
    font = ImageFont.truetype(MONO, font_size)
    step = font_size * 0.78
    count = int(2 * math.pi * radius / step)
    for i in range(count):
        angle = 360 * i / count
        if -GAP / 2 < ((angle + 180) % 360) - 180 < GAP / 2:
            continue
        glyph = "01"[(i * 7 + phase) % 3 == 0]
        x = SIZE / 2 + radius * math.cos(math.radians(angle))
        y = SIZE / 2 + radius * math.sin(math.radians(angle))
        color = ACID[:3] + (alpha,)
        draw.text((x, y), glyph, font=font, fill=color, anchor="mm")


def draw_logo(size, detailed=True):
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=SIZE * 0.22, fill=BG)
    if detailed:
        # Three rows of digits make a thick ring that still reads as a C from afar.
        ring(draw, 372, 78, 0, 255)
        ring(draw, 300, 64, 1, 200)
        ring(draw, 238, 52, 2, 130)
    else:
        # Small sizes: a solid arc, digits would turn to mush.
        box = (SIZE * 0.1, SIZE * 0.1, SIZE * 0.9, SIZE * 0.9)
        draw.arc(box, start=GAP / 2, end=360 - GAP / 2, fill=ACID, width=int(SIZE * 0.12))
    one = ImageFont.truetype(DISPLAY, 360 if detailed else 400)
    draw.text((SIZE / 2 + 6, SIZE / 2 + 10), "1", font=one, fill=(244, 244, 242, 255), anchor="mm")
    return image.resize((size, size), Image.LANCZOS)


def main():
    big = draw_logo(1024)
    os.makedirs("docs", exist_ok=True)
    big.resize((512, 512), Image.LANCZOS).save("docs/logo.png")
    big.resize((256, 256), Image.LANCZOS).save("docs/icon.png")
    frames = [draw_logo(s, detailed=s >= 64) for s in (256, 128, 64, 48, 32, 24, 16)]
    frames[0].save("icons/icon.ico", sizes=[(f.width, f.height) for f in frames], append_images=frames[1:])
    print("ok")


if __name__ == "__main__":
    main()
