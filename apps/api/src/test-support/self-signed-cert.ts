import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestCertificate {
  dir: string;
  pfxFile: string;
  pfxPassphrase: string;
  certFile: string;
  keyFile: string;
  remove(): void;
}

// .NET builds the certificate in memory: nothing touches a Windows certificate store.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  'CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('localhost')
$san.AddIpAddress([System.Net.IPAddress]::Loopback)
$request.CertificateExtensions.Add($san.Build())
$now = [DateTimeOffset]::UtcNow
$cert = $request.CreateSelfSigned($now.AddMinutes(-5), $now.AddDays(1))
$dir = $env:T20_CERT_DIR
[System.IO.File]::WriteAllBytes((Join-Path $dir 'test.pfx'),
  $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:T20_CERT_PASS))
[System.IO.File]::WriteAllText((Join-Path $dir 'test.crt'), $cert.ExportCertificatePem())
[System.IO.File]::WriteAllText((Join-Path $dir 'test.key'), $rsa.ExportPkcs8PrivateKeyPem())
`;

/** True when PowerShell 7 (pwsh) is available to make throwaway certificates. */
export function canMakeTestCertificates(): boolean {
  try {
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway self-signed certificate for localhost, as PFX and as PEM, in a temp folder. */
export function makeTestCertificate(): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'trapezoid-cert-'));
  const pfxPassphrase = `test-${Math.random().toString(36).slice(2)}`;
  execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    env: { ...process.env, T20_CERT_DIR: dir, T20_CERT_PASS: pfxPassphrase },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return {
    dir,
    pfxFile: join(dir, 'test.pfx'),
    pfxPassphrase,
    certFile: join(dir, 'test.crt'),
    keyFile: join(dir, 'test.key'),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
