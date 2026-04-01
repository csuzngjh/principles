import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

export function appendText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, text, 'utf8');
}

export function fileExists(filePath) {
  return fs.existsSync(filePath);
}
