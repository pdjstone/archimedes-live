import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from './zip.js';

class ExtensibleZipReader extends ZipReader {

    extraFieldParsers = {};

    async* getEntriesGenerator() {
        for await (const entry of super.getEntriesGenerator()) {
            if (entry.rawExtraField.byteLength > 0) {
                this.parseExtraField(entry);
            }
            yield entry;
        }
    }

    registerZipExtension(extraFieldType, parserFn) {
        this.extraFieldParsers[extraFieldType] = parserFn;
    }

    getInt(buf, offset, size) {
        switch (size) {
        case 4:
            return  buf[offset + 3] << 24 | 
                    buf[offset + 2] << 16 | 
                    buf[offset + 1] << 8 | 
                    buf[offset + 0];
        case 2:
            return  buf[offset + 1] << 8 | 
                    buf[offset + 0];
        default:
            return buf[offset];
        }
    }

    parseExtraField(entry) {
        let extraField = entry.rawExtraField;
        let extraFieldTotalLength = extraField.byteLength;
        let offset = 0;

        // extraFieldTotalLength is total length of all extra fields
        // Iterate through each extra field and parse if known
        // Handle incorrect length
        while (offset < extraFieldTotalLength) {
            let extraFieldType = this.getInt(extraField, offset, 2);
            let extraFieldLen = this.getInt(extraField, offset + 2, 2);
            let extraMeta = null;
            if (this.extraFieldParsers.hasOwnProperty(extraFieldType)) {
                extraMeta = this.extraFieldParsers[extraFieldType].call(this, entry, offset, extraFieldLen);
            }
            if (extraMeta && extraMeta.hasOwnProperty('fieldLen') && extraMeta.fieldLen > 0) {
                offset += extraMeta.fieldLen + 4; 
            } else {
                offset += extraFieldLen + 4;
            }
        }
    }
}

const ZIP_EXT_ACORN = 0x4341; // 'AC' - SparkFS / Acorn
const ZIP_ID_ARC0 = 0x30435241; // 'ARC0'

export class RiscOsUnzip extends ExtensibleZipReader 
{
    constructor(buf) {
        super(new Uint8ArrayReader(buf));
        this.isRiscOs = false;
        this.registerZipExtension(ZIP_EXT_ACORN, this.parseRiscOsZipField);
    }

    async extract(entry) {
        return await entry.getData(new Uint8ArrayWriter());
    }

    parseRiscOsZipField(entry, offset, fieldLen) {
        /*
            When writing the length of the "extra" field for RISC OS Zip files I had counted 
            the first four bytes in the 'tag' and written the length as 24 bytes instead of 
            the correct 20. I fixed this. The result is that SparkFS Zips can have an extra 
            field length of 20 or 24, possibly RISC OS Zips written by other software can 
            have a length greater than these. 
            from https://www.davidpilling.com/wiki/index.php/SparkFS "A Comment on Zip files"
        */
        if (fieldLen == 24) {
            console.log('correcting risc os extra field len from 24 to 20');
            fieldLen = 20;
        }
        let buf = entry.rawExtraField;
        let id2 = this.getInt(buf, offset + 4, 4);
        if (id2 != ZIP_ID_ARC0)
            return null;
        this.isRiscOs = true;
        entry.extraRiscOs = {
            loadAddr: this.getInt(buf, offset + 8, 4) >>> 0,
            execAddr: this.getInt(buf, offset + 12, 4) >>> 0,
            attr: this.getInt(buf, offset + 16, 4) >>> 0
        };
        return {
            fieldLen: fieldLen
        };
    }
}
