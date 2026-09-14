import { Algorithm, Version, hash, verify, parseOptions } from "@node-rs/argon2";

const policy = { algorithm: Algorithm.Argon2id, version: Version.V0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 1024) throw new Error("Password must contain at least 12 characters and at most 1024 UTF-8 bytes");
  return hash(password, policy);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > 1024) return false;
  try {
    const options = parseOptions(encoded);
    if (
      options.algorithm !== Algorithm.Argon2id || options.version !== Version.V0x13 ||
      options.memoryCost < policy.memoryCost || options.memoryCost > 65536 ||
      options.timeCost < policy.timeCost || options.timeCost > 10 ||
      options.parallelism < policy.parallelism || options.parallelism > 4 ||
      options.outputLen < policy.outputLen
    ) return false;
    return await verify(encoded, password);
  } catch { return false; }
}
