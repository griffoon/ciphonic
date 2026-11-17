"""Renders the C1PH0N1C wordmark as images, in Pricedown (the GTA logo face): white letters,
acid digits, a thick black outline and a drop shadow.

Pricedown is NOT in this repository and must not be: its Typodermic desktop license allows
logos and other fixed artwork made with it (section 2.2) but not shipping the font file in an
app, a website or open-source code (4.3, 4.6). Get it yourself from an authorized source
(dafont.com/pricedown.font) and pass its path:

    python assets/make_wordmark.py "path/to/Pricedown Bl.otf"

Writes ui/img/wordmark.png and docs/wordmark.png (transparent PNGs).
"""
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

TEXT = "C1PH0N1C"
WHITE = (244, 244, 242, 255)
ACID = (198, 255, 0, 255)
BLACK = (0, 0, 0, 255)


def render(font_path, height):
    size = int(height * 1.25)
    font = ImageFont.truetype(font_path, size)
    stroke = max(2, size // 14)
    shadow = max(2, size // 18)
    widths = [font.getlength(ch) for ch in TEXT]
    tracking = size * 0.02
    width = int(sum(widths) + tracking * (len(TEXT) - 1) + stroke * 2 + shadow + 8)
    canvas_h = int(size * 1.15 + stroke * 2 + shadow)
    image = Image.new("RGBA", (width, canvas_h), (0, 0, 0, 0))

    def draw_text(target, offset, fill_for, outline):
        draw = ImageDraw.Draw(target)
        x = stroke + offset
        for ch, w in zip(TEXT, widths):
            draw.text((x, stroke + offset), ch, font=font, fill=fill_for(ch),
                      stroke_width=stroke if outline else 0, stroke_fill=BLACK)
            x += w + tracking

    # Soft drop shadow, then the outlined letters on top.
    shade = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw_text(shade, shadow, lambda ch: BLACK, True)
    image.alpha_composite(shade.filter(ImageFilter.GaussianBlur(shadow / 2)))
    draw_text(image, 0, lambda ch: ACID if ch.isdigit() else WHITE, True)
    return image.crop(image.getbbox())


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    font_path = sys.argv[1]
    render(font_path, 120).save("ui/img/wordmark.png")
    render(font_path, 220).save("docs/wordmark.png")
    print("ok")


if __name__ == "__main__":
    main()
