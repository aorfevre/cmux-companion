import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, readdirSync, openSync, closeSync, writeFileSync, constants, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const hash = value => createHash('sha256').update(value).digest('hex');
// Use one portable policy for reads, writes and enumeration. macOS can preserve
// caller spelling in realpath while resolving case/Unicode aliases to metadata.
const protectedComponent = name => ['.git', '.codex', '.companion'].includes(
  name.normalize('NFKC').toLowerCase().replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, ''),
);
function inside(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).some(protectedComponent)) throw new Error('Path is outside the permitted project files');
  return path;
}
export function scopedFile(config, name, input) {
  const root = realpathSync(config.root);
  if (root !== config.root || !input || typeof input.path !== 'string' || input.path.includes('\0')) throw new Error('Invalid file request');
  const path = inside(root, resolve(root, input.path));
  if (name === 'list_files') {
    inside(root, realpathSync(path));
    return { entries: readdirSync(path, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink() && !protectedComponent(entry.name)).slice(0, 500).map(entry => ({ name: entry.name, directory: entry.isDirectory() })) };
  }
  if (name === 'read_file') {
    inside(root, realpathSync(path));
    if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1 || lstatSync(path).size > 262144) throw new Error('File is unavailable or exceeds 256 KiB');
    const content = readFileSync(path, 'utf8'); return { content, sha256: hash(content) };
  }
  if (name !== 'write_file' || !['implementer', 'integrator'].includes(config.role)) throw new Error('This role cannot write files');
  if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 262144) throw new Error('File exceeds 256 KiB');
  if (input.expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error('Expected content hash is required');
  const parts = relative(root, dirname(path)).split(sep).filter(Boolean);
  let parent = root;
  for (const part of parts) {
    parent = inside(root, join(parent, part));
    try { mkdirSync(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) throw new Error('Unsafe parent directory');
    inside(root, realpathSync(parent));
  }
  let previous = null;
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1 || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 262144) throw new Error('Only regular files can be edited');
    previous = hash(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== input.expectedSha256) throw new Error('File changed; read it again before editing');
  const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | (previous === null ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC), 0o600);
  try { writeFileSync(fd, input.content); } finally { closeSync(fd); }
  return { sha256: hash(input.content) };
}
export const fileTools = role => [
  { name: 'list_files', description: 'List a directory inside the goal worktree, at most 500 entries.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'read_file', description: 'Read a UTF-8 project file up to 256 KiB and its content hash.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  ...(['implementer', 'integrator'].includes(role) ? [{ name: 'write_file', description: 'Create or update a project file. Supply the hash returned by read_file, or null for a new file. Parent directory must exist.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, expectedSha256: { type: ['string', 'null'] } }, required: ['path', 'content', 'expectedSha256'], additionalProperties: false } }] : []),
];
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let message;
    try {
      if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Oversized request');
      message = JSON.parse(line);
      if (message.id === undefined) continue;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'companion-files', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: fileTools(config.role) };
      else if (message.method === 'tools/call') {
        try { result = { content: [{ type: 'text', text: JSON.stringify(scopedFile(config, message.params.name, message.params.arguments)) }] }; }
        catch { result = { isError: true, content: [{ type: 'text', text: 'File operation refused. Check the project path, file size and expected content hash.' }] }; }
      } else if (message.method === 'ping') result = {};
      else throw new Error('Unknown method');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    } catch { if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid scoped file request' } }) + '\n'); }
  }
}
