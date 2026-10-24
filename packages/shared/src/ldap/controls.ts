// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AD/Samba LDAP controls ldapts doesn't ship (ADR-0012 §1). ldapts parses a response control into the
 * request control whose responseType matches, so a DirSync request object also carries the response cookie
 * after the search completes.
 */
import { Ber, BerWriter, Control, type BerReader } from 'ldapts';

export const DIRSYNC_OID = '1.2.840.113556.1.4.841';
export const SHOW_DELETED_OID = '1.2.840.113556.1.4.417';
export const SD_FLAGS_OID = '1.2.840.113556.1.4.801';
export const NOTIFICATION_OID = '1.2.840.113556.1.4.528';

/** DirSync request flags (MS-ADTS 3.1.1.3.4.1.3). */
export const DirSyncFlags = {
  objectSecurity: 0x00000001,
  ancestorsFirstOrder: 0x00000800,
  publicDataOnly: 0x00002000,
  incrementalValues: 0x80000000,
} as const;

export interface DirSyncResponse {
  moreResults: boolean;
  cookie: Buffer;
}

/** DirSync (1.2.840.113556.1.4.841): changes since `cookie` under an NC head. */
export class DirSyncControl extends Control {
  static readonly type = DIRSYNC_OID;
  flags: number;
  maxBytes: number;
  cookie: Buffer;
  response: DirSyncResponse | null = null;

  constructor(opts: { flags?: number; maxBytes?: number; cookie?: Buffer | null; critical?: boolean } = {}) {
    super(DIRSYNC_OID, { critical: opts.critical ?? true });
    this.flags = opts.flags ?? 0;
    this.maxBytes = opts.maxBytes ?? 0x100000;
    this.cookie = opts.cookie ?? Buffer.alloc(0);
  }

  override writeControl(writer: BerWriter): void {
    const v = new BerWriter();
    v.startSequence();
    // BER INTEGER is signed; the high flag bit (incrementalValues) must be sent as a negative 32-bit value.
    v.writeInt(this.flags | 0);
    v.writeInt(this.maxBytes);
    v.writeBuffer(this.cookie, Ber.OctetString);
    v.endSequence();
    writer.writeBuffer(v.buffer, Ber.OctetString);
  }

  override parseControl(reader: BerReader): void {
    if (reader.readSequence() === null) return;
    const more = reader.readInt() ?? 0;
    reader.readInt();
    const cookie = reader.readString(Ber.OctetString, true) ?? Buffer.alloc(0);
    this.response = { moreResults: more !== 0, cookie };
  }
}

/** Show Deleted (1.2.840.113556.1.4.417): include tombstones in search results. No value. */
export class ShowDeletedControl extends Control {
  constructor() {
    super(SHOW_DELETED_OID, { critical: true });
  }
}

/** SD Flags (1.2.840.113556.1.4.801): which parts of nTSecurityDescriptor to read or write. */
export class SdFlagsControl extends Control {
  /** OWNER=1, GROUP=2, DACL=4, SACL=8 */
  flags: number;

  constructor(flags = 0x4) {
    super(SD_FLAGS_OID, { critical: true });
    this.flags = flags;
  }

  override writeControl(writer: BerWriter): void {
    const v = new BerWriter();
    v.startSequence();
    v.writeInt(this.flags);
    v.endSequence();
    writer.writeBuffer(v.buffer, Ber.OctetString);
  }
}
