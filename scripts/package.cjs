"use strict";
// ZIP writer using only Node's standard library; runs on Windows and Linux.
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const folder = path.join(root, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
const files = fs.readdirSync(folder).filter(name => fs.statSync(path.join(folder, name)).isFile()).sort();
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const entries = [];
const directory = [];
let offset = 0;
for (const filename of files) {
  const name = Buffer.from(filename);
  const data = fs.readFileSync(path.join(folder, filename));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(33, 12); // 1980-01-01, deterministic archive timestamp.
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  central.writeUInt32LE(offset, 42);
  entries.push(local, name, data);
  directory.push(central, name);
  offset += local.length + name.length + data.length;
}
const index = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(index.length, 12);
end.writeUInt32LE(offset, 16);
const output = path.join(root, "dist", `youtube-subscriptions-filter-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([...entries, index, end]));
console.log(output);
