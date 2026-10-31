import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import zlib from 'zlib';
import app from '../app.js';
import prisma from '../db.js';

// Build a minimal stored (uncompressed) zip with local headers only.
// file-type reads local headers, so this is enough for MIME detection.
function buildZip(entries: Array<{ name: string; data?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const { name, data = '' } of entries) {
    const nameBuf = Buffer.from(name);
    const dataBuf = Buffer.from(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt32LE(zlib.crc32(dataBuf), 14);
    header.writeUInt32LE(dataBuf.length, 18); // compressed size
    header.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26);
    parts.push(header, nameBuf, dataBuf);
  }
  return Buffer.concat(parts);
}

const iworkFixtures: Record<string, Buffer> = {
  keynote: buildZip([{ name: 'Index/Document.iwa' }, { name: 'Index/MasterSlide.iwa' }]),
  numbers: buildZip([{ name: 'Index/Document.iwa' }, { name: 'Index/Tables/Tile.iwa' }]),
  pages: buildZip([{ name: 'Index/Document.iwa' }]),
};

const rejectedFixtures: Record<string, Buffer> = {
  'jar (java-archive)': buildZip([{ name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\n' }]),
  'macro-enabled xlsm': buildZip([{
    name: '[Content_Types].xml',
    data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
  }]),
  'macro-enabled docm': buildZip([{
    name: '[Content_Types].xml',
    data: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
  }]),
  'registry file (.reg)': Buffer.from('REGEDIT4\r\n[HKEY_CURRENT_USER\\Software\\Test]\r\n'),
};

// EBML header with DocType "webm" and no video track: an audio-only recording container
const webmBytes = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x88, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x04,
  0x42, 0x85, 0x81, 0x02, 0x18, 0x53, 0x80, 0x67, 0x80,
]);

describe('File upload MIME detection (file-type 22)', () => {
  let authToken: string;

  beforeEach(async () => {
    await prisma.dMReaction.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const userRes = await request(app).post('/auth/register').send({
      email: 'mime-test@example.com',
      password: TEST_PASSWORD,
      name: 'Mime Test User',
    });
    authToken = userRes.body.token;
  });

  const upload = (buf: Buffer, filename: string, contentType: string) =>
    request(app)
      .post('/files')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', buf, { filename, contentType });

  describe.each(Object.entries(iworkFixtures))('Apple iWork %s', (kind, buf) => {
    it('should upload, read, download and delete', async () => {
      const filename = `sample.${kind === 'keynote' ? 'key' : kind}`;
      const created = await upload(buf, filename, 'application/zip');
      expect(created.status).toBe(201);
      expect(created.body.mimetype).toBe(`application/vnd.apple.${kind}`);

      const id = created.body.id;
      const info = await request(app).get(`/files/${id}`).set('Authorization', `Bearer ${authToken}`);
      expect(info.status).toBe(200);
      expect(info.body.originalName).toBe(filename);

      const download = await request(app).get(`/files/${id}/download`).set('Authorization', `Bearer ${authToken}`);
      expect(download.status).toBe(200);
      expect(download.headers['content-disposition']).toMatch(/attachment/);
      expect(download.headers['x-content-type-options']).toBe('nosniff');

      const del = await request(app).delete(`/files/${id}`).set('Authorization', `Bearer ${authToken}`);
      expect(del.status).toBe(200);
      const after = await request(app).get(`/files/${id}`).set('Authorization', `Bearer ${authToken}`);
      expect(after.status).toBe(404);
    });
  });

  it('should still accept a plain zip', async () => {
    const res = await upload(buildZip([{ name: 'readme.txt', data: 'hi' }]), 'plain.zip', 'application/zip');
    expect(res.status).toBe(201);
    expect(res.body.mimetype).toBe('application/zip');
  });

  describe.each(Object.entries(rejectedFixtures))('%s', (_label, buf) => {
    it('should be rejected by content detection', async () => {
      // Client claims zip/plain text; the real content decides
      const res = await upload(buf, 'bad.zip', buf.toString('latin1', 0, 8) === 'REGEDIT4' ? 'text/plain' : 'application/zip');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('File content does not match an allowed type');
      const count = await prisma.file.count();
      expect(count).toBe(0);
    });
  });

  describe('Audio-only WebM (voice message)', () => {
    it('should be detected by file-type as video/webm', async () => {
      const { fileTypeFromBuffer } = await import('file-type');
      const detected = await fileTypeFromBuffer(webmBytes);
      expect(detected?.mime).toBe('video/webm');
    });

    it('should keep audio/webm when the client says audio/webm, then download and delete', async () => {
      const created = await upload(webmBytes, 'voice.webm', 'audio/webm;codecs=opus');
      expect(created.status).toBe(201);
      expect(created.body.mimetype).toBe('audio/webm');

      const info = await request(app).get(`/files/${created.body.id}`).set('Authorization', `Bearer ${authToken}`);
      expect(info.status).toBe(200);
      expect(info.body.mimetype).toBe('audio/webm');

      const del = await request(app).delete(`/files/${created.body.id}`).set('Authorization', `Bearer ${authToken}`);
      expect(del.status).toBe(200);
    });

    it('should store video/webm when the client says video/webm', async () => {
      const res = await upload(webmBytes, 'clip.webm', 'video/webm');
      expect(res.status).toBe(201);
      expect(res.body.mimetype).toBe('video/webm');
    });
  });
});
