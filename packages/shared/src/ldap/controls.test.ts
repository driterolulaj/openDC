// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BerReader, BerWriter } from 'ldapts';
import { DirSyncControl, DirSyncFlags, SdFlagsControl, ShowDeletedControl, DIRSYNC_OID } from './controls.ts';

function encode(c: { write(w: BerWriter): void }): Buffer {
  const w = new BerWriter();
  c.write(w);
  return w.buffer;
}

test('DirSync request encodes flags, maxBytes and cookie inside the control value', () => {
  const c = new DirSyncControl({
    flags: DirSyncFlags.incrementalValues | DirSyncFlags.ancestorsFirstOrder,
    cookie: Buffer.from('abc'),
  });
  const r = new BerReader(encode(c));
  assert.ok(r.readSequence() !== null);
  assert.equal(r.readString(), DIRSYNC_OID);
  assert.equal(r.readBoolean(), true);
  const value = r.readString(0x04, true);
  assert.ok(value);
  const v = new BerReader(value);
  v.readSequence();
  assert.equal(v.readInt(), 0x80000000 | 0x800 | 0);
  assert.equal(v.readInt(), 0x100000);
  assert.deepEqual(v.readString(0x04, true), Buffer.from('abc'));
});

test('DirSync response cookie and moreResults are parsed into the request control', () => {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(1);
  w.writeInt(0);
  w.writeBuffer(Buffer.from([1, 2, 3]), 0x04);
  w.endSequence();
  const c = new DirSyncControl();
  c.parse(new BerReader(w.buffer));
  assert.deepEqual(c.response, { moreResults: true, cookie: Buffer.from([1, 2, 3]) });
  const empty = new DirSyncControl();
  empty.parse(new BerReader(Buffer.alloc(0)));
  assert.equal(empty.response, null);
});

test('Show Deleted has no value; SD Flags carries the flags', () => {
  const sd = new BerReader(encode(new ShowDeletedControl()));
  sd.readSequence();
  assert.equal(sd.readString(), '1.2.840.113556.1.4.417');
  assert.equal(sd.readBoolean(), true);
  const f = new BerReader(encode(new SdFlagsControl(0x4)));
  f.readSequence();
  f.readString();
  f.readBoolean();
  const v = new BerReader(f.readString(0x04, true) ?? Buffer.alloc(0));
  v.readSequence();
  assert.equal(v.readInt(), 4);
});
