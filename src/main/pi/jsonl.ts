import { StringDecoder } from "node:string_decoder";

/**
 * Splits a UTF-8 byte stream into JSONL records.
 *
 * Pi's RPC framing splits only on LF (an optional preceding CR is stripped). Node's
 * `readline` also splits on U+2028/U+2029, which are legal inside JSON strings, so it
 * must not be used here.
 */
export class JsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	constructor(
		private readonly onRecord: (record: unknown) => void,
		private readonly onInvalid: (line: string, error: unknown) => void,
	) {}

	push(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) this.emit(line);
			newline = this.buffer.indexOf("\n");
		}
	}

	/** Flush a final unterminated record, if any. */
	end(): void {
		this.buffer += this.decoder.end();
		const line = this.buffer.replace(/\r$/, "");
		this.buffer = "";
		if (line.length > 0) this.emit(line);
	}

	private emit(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch (error) {
			this.onInvalid(line, error);
			return;
		}
		this.onRecord(record);
	}
}

export function encodeJsonl(record: unknown): string {
	return `${JSON.stringify(record)}\n`;
}
