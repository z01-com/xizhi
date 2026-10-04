declare module 'fontkit' {
  interface Font {
    ascender: number | null;
    descender: number | null;
    family: string | null;
    unitsPerEm: number;
    cmap: Map<number, string>;
    glyphCount: number;
    getGlyph(code: number): Glyph | null;
    getHorizontalAdvance(code: number): number | null;
  }

  interface Glyph {
    draw(pen: any): void;
  }

  interface FontCollection {
    fonts: Font[];
  }

  export function create(data: Buffer): Font | FontCollection;
}
