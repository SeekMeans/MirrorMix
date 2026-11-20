import { execFileSync } from "node:child_process";

/**
 * Secrets at rest (SSH passwords, private keys): sealed with Windows DPAPI, so only this Windows account on this
 * machine can read them back. Elsewhere (tests, other systems) they are only base64-wrapped.
 */
export interface SecretBox {
  seal(secret: string): string;
  unseal(sealed: string): string;
}

function runPowerShell(script: string, input: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, MIRRORMIX_SECRET: input },
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

export function dpapiSeal(secret: string): string {
  if (process.platform !== "win32") return Buffer.from(secret, "utf8").toString("base64");
  return runPowerShell(
    "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:MIRRORMIX_SECRET); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))",
    secret,
  );
}

export function dpapiUnseal(sealed: string): string {
  if (process.platform !== "win32") return Buffer.from(sealed, "base64").toString("utf8");
  // The bytes come back as base64: PowerShell would print text in the console's code page and mangle anything non-ASCII.
  const bytes = runPowerShell(
    "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:MIRRORMIX_SECRET); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
    sealed,
  );
  return Buffer.from(bytes, "base64").toString("utf8");
}

/** DPAPI with an in-memory cache of what was already opened, since each call starts PowerShell. */
export function dpapiBox(): SecretBox {
  const opened = new Map<string, string>();
  return {
    seal(secret) {
      const sealed = dpapiSeal(secret);
      opened.set(sealed, secret);
      return sealed;
    },
    unseal(sealed) {
      const known = opened.get(sealed);
      if (known != null) return known;
      const secret = dpapiUnseal(sealed);
      opened.set(sealed, secret);
      return secret;
    },
  };
}

/** For tests: reversible, and plainly not a real protection. */
export function plainBox(): SecretBox {
  return {
    seal: (secret) => `plain:${Buffer.from(secret, "utf8").toString("base64")}`,
    unseal: (sealed) => Buffer.from(sealed.replace(/^plain:/, ""), "base64").toString("utf8"),
  };
}
