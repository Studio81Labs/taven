import { DomainError } from "./errors.js";

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function padded(input: Uint8Array): Uint8Array {
  const bitLength = BigInt(input.length) * 8n;
  if (bitLength > 0xffff_ffff_ffff_ffffn) {
    throw new DomainError("INVALID_ARGUMENT", "input is too large for SHA-256");
  }
  const paddingLength = (64 - ((input.length + 9) % 64)) % 64;
  const result = new Uint8Array(input.length + 1 + paddingLength + 8);
  result.set(input);
  result[input.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    result[result.length - 1 - index] = Number(
      (bitLength >> BigInt(index * 8)) & 0xffn,
    );
  }
  return result;
}

/** A lowercase, immutable SHA-256 hex digest. */
export class Sha256Digest {
  readonly hex: string;

  private constructor(hex: string) {
    this.hex = hex;
    Object.freeze(this);
  }

  static parse(hex: string): Sha256Digest {
    if (!/^[a-f0-9]{64}$/.test(hex)) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "SHA-256 digest must be 64 lowercase hexadecimal characters",
      );
    }
    return new Sha256Digest(hex);
  }

  static of(input: string | Uint8Array): Sha256Digest {
    const bytes =
      typeof input === "string" ? new TextEncoder().encode(input) : input;
    const hash = new Uint32Array(INITIAL_HASH);
    const schedule = new Uint32Array(64);
    const data = padded(bytes);

    for (let offset = 0; offset < data.length; offset += 64) {
      for (let word = 0; word < 16; word += 1) {
        const index = offset + word * 4;
        schedule[word] =
          (data[index]! << 24) |
          (data[index + 1]! << 16) |
          (data[index + 2]! << 8) |
          data[index + 3]!;
      }
      for (let word = 16; word < 64; word += 1) {
        const x = schedule[word - 15]!;
        const y = schedule[word - 2]!;
        const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
        const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
        schedule[word] =
          (schedule[word - 16]! + sigma0 + schedule[word - 7]! + sigma1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = hash;
      for (let word = 0; word < 64; word += 1) {
        const sigma1 =
          rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
        const choose = (e! & f!) ^ (~e! & g!);
        const temp1 =
          (h! + sigma1 + choose + ROUND_CONSTANTS[word]! + schedule[word]!) >>>
          0;
        const sigma0 =
          rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
        const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
        const temp2 = (sigma0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d! + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      hash[0] = (hash[0]! + a!) >>> 0;
      hash[1] = (hash[1]! + b!) >>> 0;
      hash[2] = (hash[2]! + c!) >>> 0;
      hash[3] = (hash[3]! + d!) >>> 0;
      hash[4] = (hash[4]! + e!) >>> 0;
      hash[5] = (hash[5]! + f!) >>> 0;
      hash[6] = (hash[6]! + g!) >>> 0;
      hash[7] = (hash[7]! + h!) >>> 0;
    }

    return new Sha256Digest(
      Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join(""),
    );
  }

  equals(other: Sha256Digest): boolean {
    return this.hex === other.hex;
  }

  toString(): string {
    return this.hex;
  }
}
