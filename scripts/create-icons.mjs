import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

const root = process.cwd();
const iconDir = join(root, "src-tauri", "icons");
const size = 1024;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  const center = width / 2;

  function blendPixel(x, y, color, alpha = 1) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= width || py < 0 || py >= height) return;

    const offset = (py * width + px) * 4;
    const sourceAlpha = Math.max(0, Math.min(1, alpha)) * (color[3] ?? 255) / 255;
    const targetAlpha = pixels[offset + 3] / 255;
    const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
    if (outAlpha === 0) return;

    pixels[offset] = Math.round((color[0] * sourceAlpha + pixels[offset] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    pixels[offset + 1] = Math.round((color[1] * sourceAlpha + pixels[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    pixels[offset + 2] = Math.round((color[2] * sourceAlpha + pixels[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
    pixels[offset + 3] = Math.round(outAlpha * 255);
  }

  function roundedMask(x, y, radius) {
    const edge = width * 0.09;
    const cx = Math.max(edge, Math.min(width - edge, x));
    const cy = Math.max(edge, Math.min(height - edge, y));
    return Math.hypot(x - cx, y - cy) <= radius;
  }

  function drawCircle(cx, cy, radius, color, alpha = 1, softness = 0) {
    const minX = Math.floor(cx - radius - softness);
    const maxX = Math.ceil(cx + radius + softness);
    const minY = Math.floor(cy - radius - softness);
    const maxY = Math.ceil(cy + radius + softness);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = Math.hypot(x - cx, y - cy);
        if (distance > radius + softness) continue;
        const falloff = softness > 0 && distance > radius ? 1 - (distance - radius) / softness : 1;
        blendPixel(x, y, color, alpha * falloff);
      }
    }
  }

  function drawLine(x1, y1, x2, y2, thickness, color, alpha = 1) {
    const minX = Math.floor(Math.min(x1, x2) - thickness);
    const maxX = Math.ceil(Math.max(x1, x2) + thickness);
    const minY = Math.floor(Math.min(y1, y2) - thickness);
    const maxY = Math.ceil(Math.max(y1, y2) + thickness);
    const lengthSquared = (x2 - x1) ** 2 + (y2 - y1) ** 2;

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / lengthSquared));
        const projectionX = x1 + t * (x2 - x1);
        const projectionY = y1 + t * (y2 - y1);
        const distance = Math.hypot(x - projectionX, y - projectionY);
        if (distance <= thickness) {
          blendPixel(x, y, color, alpha * (1 - distance / thickness));
        }
      }
    }
  }

  function drawPolyline(points, thickness, color, alpha = 1) {
    for (let index = 0; index < points.length - 1; index += 1) {
      drawLine(points[index][0], points[index][1], points[index + 1][0], points[index + 1][1], thickness, color, alpha);
    }
  }

  function drawStar(cx, cy, radius, color) {
    drawLine(cx - radius, cy, cx + radius, cy, radius * 0.08, color, 0.9);
    drawLine(cx, cy - radius, cx, cy + radius, radius * 0.08, color, 0.9);
    drawLine(cx - radius * 0.55, cy - radius * 0.55, cx + radius * 0.55, cy + radius * 0.55, radius * 0.05, color, 0.75);
    drawLine(cx - radius * 0.55, cy + radius * 0.55, cx + radius * 0.55, cy - radius * 0.55, radius * 0.05, color, 0.75);
    drawCircle(cx, cy, radius * 0.13, color, 1, radius * 0.16);
  }

  function drawRing(cx, cy, radius, thickness, color, alpha = 1) {
    const minX = Math.floor(cx - radius - thickness);
    const maxX = Math.ceil(cx + radius + thickness);
    const minY = Math.floor(cy - radius - thickness);
    const maxY = Math.ceil(cy + radius + thickness);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = Math.hypot(x - cx, y - cy);
        const edgeDistance = Math.abs(distance - radius);
        if (edgeDistance > thickness) continue;
        blendPixel(x, y, color, alpha * (1 - edgeDistance / thickness));
      }
    }
  }

  function drawArc(cx, cy, radius, startAngle, endAngle, thickness, color, alpha = 1) {
    const points = [];
    const steps = 18;
    for (let index = 0; index <= steps; index += 1) {
      const angle = startAngle + ((endAngle - startAngle) * index) / steps;
      points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
    drawPolyline(points, thickness, color, alpha);
  }

  function drawBezier(points, thickness, color, alpha = 1) {
    const curve = [];
    const steps = 26;
    const [p0, p1, p2, p3] = points;

    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const mt = 1 - t;
      curve.push([
        mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
        mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1]
      ]);
    }

    drawPolyline(curve, thickness, color, alpha);
  }

  function drawSoftBezier(points, radius, color, alpha = 1) {
    const steps = 72;
    const [p0, p1, p2, p3] = points;

    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const mt = 1 - t;
      const x = mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0];
      const y = mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1];
      const taper = Math.sin(Math.PI * t);
      drawCircle(x, y, radius * (0.25 + taper * 0.75), color, alpha * (0.45 + taper * 0.55), radius * 0.75);
    }
  }

  drawCircle(512, 600, 300, [5, 25, 42, 255], 0.14, 90);
  drawCircle(512, 520, 250, [14, 86, 100, 255], 0.12, 80);
  drawCircle(512, 342, 190, [44, 92, 134, 255], 0.08, 70);

  drawCircle(512, 494, 330, [18, 222, 206, 255], 0.06, 110);
  drawCircle(512, 356, 190, [171, 111, 255, 255], 0.07, 130);
  drawRing(512, 330, 178, 8, [174, 250, 255, 255], 0.22);
  drawRing(512, 330, 248, 5, [148, 107, 255, 255], 0.16);

  const networkNodes = [
    [512, 244, 18],
    [420, 296, 14],
    [604, 296, 14],
    [360, 376, 13],
    [664, 376, 13],
    [426, 438, 11],
    [598, 438, 11]
  ];
  const networkLines = [
    [[512, 244], [420, 296]],
    [[512, 244], [604, 296]],
    [[420, 296], [360, 376]],
    [[604, 296], [664, 376]],
    [[360, 376], [426, 438]],
    [[664, 376], [598, 438]]
  ];

  for (const [[x1, y1], [x2, y2]] of networkLines) {
    drawLine(x1, y1, x2, y2, 9, [102, 255, 239, 255], 0.18);
    drawLine(x1, y1, x2, y2, 4, [248, 255, 246, 255], 0.55);
  }

  for (const [cx, cy, radius] of networkNodes) {
    drawCircle(cx, cy, radius + 18, [92, 245, 232, 255], 0.18, 26);
    drawCircle(cx, cy, radius, [255, 255, 238, 255], 0.95, 6);
  }

  const brainLobes = [
    [370, 500, 96],
    [286, 590, 112],
    [380, 694, 122],
    [490, 724, 98],
    [654, 500, 96],
    [738, 590, 112],
    [644, 694, 122],
    [534, 724, 98],
    [512, 590, 142],
    [512, 675, 116]
  ];

  for (const [cx, cy, radius] of brainLobes) {
    drawCircle(cx, cy, radius + 44, [18, 222, 206, 255], 0.08, 48);
  }

  for (const [cx, cy, radius] of brainLobes) {
    drawCircle(cx, cy, radius, [72, 231, 220, 255], 0.96, 6);
    drawCircle(cx - radius * 0.28, cy - radius * 0.34, radius * 0.34, [240, 255, 250, 255], 0.32, 14);
  }

  drawCircle(512, 595, 72, [255, 255, 246, 255], 0.26, 60);
  drawRing(512, 595, 86, 10, [255, 255, 246, 255], 0.5);
  drawCircle(512, 595, 30, [255, 255, 246, 255], 0.9, 18);
  drawCircle(512, 595, 11, [15, 58, 88, 255], 0.86, 2);

  drawLine(512, 392, 512, 736, 7, [7, 54, 82, 255], 0.34);
  const lobeGlints = [
    [374, 552, 13],
    [336, 668, 10],
    [436, 702, 9],
    [650, 552, 13],
    [688, 668, 10],
    [588, 702, 9],
    [448, 528, 8],
    [576, 528, 8]
  ];

  for (const [cx, cy, radius] of lobeGlints) {
    drawCircle(cx, cy, radius + 18, [255, 255, 246, 255], 0.045, 24);
    drawCircle(cx, cy, radius, [255, 255, 246, 255], 0.12, 12);
  }

  drawStar(512, 244, 48, [255, 255, 238, 255]);
  drawStar(690, 488, 34, [199, 164, 255, 255]);
  drawStar(330, 768, 30, [190, 255, 250, 255]);
  drawCircle(772, 302, 10, [255, 255, 238, 255], 0.8, 16);
  drawCircle(262, 420, 10, [190, 255, 250, 255], 0.78, 16);

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    pixels.copy(row, 1, y * width * 4, (y + 1) * width * 4);
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

await mkdir(iconDir, { recursive: true });
await writeFile(join(iconDir, "icon.png"), makePng(size, size));

const iconsetDir = join(iconDir, "icon.iconset");
await mkdir(iconsetDir, { recursive: true });

const iconSizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];

for (const [fileName, outputSize] of iconSizes) {
  execFileSync("sips", [
    "-z",
    String(outputSize),
    String(outputSize),
    join(iconDir, "icon.png"),
    "--out",
    join(iconsetDir, fileName)
  ]);
}

execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", join(iconDir, "icon.icns")]);

console.log("Created src-tauri/icons/icon.png and src-tauri/icons/icon.icns");
