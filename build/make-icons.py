#!/usr/bin/env python3
"""生成 PWA / 移动端所需的图标（renderer/icon-*.png、apple-touch-icon.png）

用法: python build/make-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'renderer')
BG = (29, 34, 42, 255)        # 与界面同一深色
ACCENT = (76, 175, 80, 255)   # 与界面同一绿色
FG = (215, 221, 230, 255)

EMOJI_FONTS = [
    r'C:\Windows\Fonts\seguiemj.ttf',
    '/System/Library/Fonts/Apple Color Emoji.ttc',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
]
TEXT_FONTS = [
    r'C:\Windows\Fonts\arialbd.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def pick(fonts):
    for f in fonts:
        if os.path.exists(f):
            return f
    return None


def draw_icon(size: int) -> Image.Image:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.19), fill=BG)
    # 顶部一条绿色装饰线
    d.rounded_rectangle([0, 0, size - 1, int(size * 0.055)], radius=int(size * 0.02), fill=ACCENT)

    emoji_font = pick(EMOJI_FONTS)
    drawn = False
    if emoji_font:
        try:
            font = ImageFont.truetype(emoji_font, int(size * 0.52))
            d.text((size / 2, size * 0.5), '\u26cf', font=font, anchor='mm', embedded_color=True)
            drawn = True
        except Exception:
            drawn = False

    if not drawn:
        # 退路：画一个简化的镐子（斜柄 + 镐头）
        cx, cy, s = size / 2, size * 0.52, size
        d.line([(cx - 0.16 * s, cy + 0.24 * s), (cx + 0.16 * s, cy - 0.20 * s)], fill=FG, width=int(size * 0.075))
        d.arc([cx - 0.30 * s, cy - 0.36 * s, cx + 0.30 * s, cy - 0.02 * s], start=200, end=340,
              fill=ACCENT, width=int(size * 0.085))

    text_font = pick(TEXT_FONTS)
    if text_font:
        f = ImageFont.truetype(text_font, int(size * 0.15))
        d.text((size / 2, size * 0.845), 'MC', font=f, anchor='mm', fill=ACCENT)
    return img


def main():
    for size, name in [(192, 'icon-192.png'), (512, 'icon-512.png'), (180, 'apple-touch-icon.png')]:
        img = draw_icon(size)
        path = os.path.join(OUT_DIR, name)
        img.save(path)
        print(f'  {name}  {size}x{size}  {os.path.getsize(path)} 字节')
    # 顺带一个 favicon
    icon = draw_icon(64)
    icon.save(os.path.join(OUT_DIR, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print('  favicon.ico')


if __name__ == '__main__':
    main()
