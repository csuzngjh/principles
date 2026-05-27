const fs = require('fs');
const path = 'D:\\.openclaw\\workspace\\.pd\\state.db';
const buf = Buffer.alloc(16);
const fd = fs.openSync(path, 'r');
fs.readSync(fd, buf, 0, 16, 0);
fs.closeSync(fd);
console.log('Header bytes:', buf.toString('hex'));
console.log('Is SQLite:', buf.toString('ascii', 0, 16));
