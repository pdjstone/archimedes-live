class ExtensibleUnzip extends Zlib.Unzip {

    extraFieldParsers = {};

    parseExtraFields() {
        this.getFilenames();
        for (let f of this.fileHeaderList) {
            if (f.extraFieldLength > 0) {
                f.extraFields = this.parseExtraField(f.extraField, f.extraFieldLength);
            }
        }
        return this.fileHeaderList;
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
            break;
        case 2:
            return  buf[offset + 1] << 8 | 
                    buf[offset + 0];
            break;
        default:
            return buf[offset];
            break;
        }
    }

    parseExtraField(extraField, extraFieldTotalLength) {
        let offset = 0;
        let extraFields = {};

        // extraFieldTotalLength is total length of all extra fields
        // Iterate through each extra field and parse if known
        while (offset < extraFieldTotalLength) {
            let extraFieldType = this.getInt(extraField, offset, 2);
            let extraFieldLen = this.getInt(extraField, offset + 2, 2);
            let extraMeta = null;
            if (this.extraFieldParsers.hasOwnProperty(extraFieldType)) {
                extraMeta = this.extraFieldParsers[extraFieldType].call(this, extraField, offset, extraFieldLen);
            } 
            extraFields[extraFieldType] = extraMeta;
            if (extraMeta && extraMeta.hasOwnProperty('len') && extraMeta.len > 0) {
                offset += extraMeta.len + 4; 
            } else {
                offset += extraFieldLen + 4;
            }
        }
        return extraFields;
    }
}


const ZIP_EXT_ACORN = 0x4341; // 'AC' - SparkFS / Acorn
const ZIP_ID_ARC0 = 0x30435241; // 'ARC0'

class RiscOsUnzip extends ExtensibleUnzip
{
    constructor(buf) {
        super(buf);
        this.isRiscOs = false;
        this.registerZipExtension(ZIP_EXT_ACORN, this.parseRiscOsZipField);
        this.parseExtraFields();
        for (let f of this.fileHeaderList) {
            if (f.extraFieldLength > 0 && f.extraFields.hasOwnProperty(ZIP_EXT_ACORN)) {
                this.isRiscOs = true;
            }
        }
    }

    parseRiscOsZipField(buf, offset, len) {
        // See https://www.davidpilling.com/wiki/index.php/SparkFS "A Comment on Zip files"
        if (len == 24) len = 20;
        let id2 = this.getInt(buf, offset + 4, 4);
        if (id2 != ZIP_ID_ARC0)
            return null;
        this.isRiscOs = true;
        return {
            len: len,
            loadAddr: this.getInt(buf, offset + 8, 4) >>> 0,
            execAddr: this.getInt(buf, offset + 12, 4) >>> 0,
            attr: this.getInt(buf, offset + 16, 4) >>> 0
        };
    }
}
