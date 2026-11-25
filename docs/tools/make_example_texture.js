// One-off: draws examples/packs/data/bb_ui/example/texture.png (64x64). Zero dependencies.
// Run from the repo root: node docs/tools/make_example_texture.js
const fs = require('fs');
const path = require('path');
const { Canvas } = require('../../bb_ui/lib/png.js');

const OUT = path.resolve(__dirname, '../../examples/packs/data/bb_ui/example/texture.png');
// regions: name -> [x, y, w, h, [r,g,b]]
const R = {
  bg:       [0, 0, 32, 20, [30, 34, 60]],
  shop_bg:  [32, 0, 28, 16, [20, 70, 70]],
  b_shop:   [0, 24, 8, 4, [60, 170, 90]],
  b_cmd:    [8, 24, 8, 4, [70, 110, 210]],
  b_fn:     [16, 24, 8, 4, [230, 140, 40]],
  b_close:  [24, 24, 8, 4, [200, 60, 60]],
  b_add:    [32, 24, 8, 4, [90, 200, 120]],
  b_buy:    [40, 24, 8, 4, [235, 200, 50]],
  b_back:   [48, 24, 8, 4, [140, 140, 150]],
  hl:       [0, 32, 8, 4, [255, 255, 255]],
  logo:     [8, 32, 8, 4, [200, 80, 200]],
  num_bg:   [16, 32, 8, 4, [10, 10, 14]],
};

const img = new Canvas(64, 64);
for (const [name, [x0, y0, w, h, [r, g, b]]] of Object.entries(R)) {
  const border = name.startsWith('b_') || name === 'logo';
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      let k = 1;
      if (border && (x === x0 || y === y0)) k = 1.3;
      if (border && (x === x0 + w - 1 || y === y0 + h - 1)) k = 0.7;
      img.set(x, y, Math.min(255, r * k) | 0, Math.min(255, g * k) | 0, Math.min(255, b * k) | 0, 255);
    }
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, img.toPng());
console.log('wrote', OUT);
