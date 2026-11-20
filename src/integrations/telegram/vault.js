import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CONFIG_DIR } from '../../config/paths.js';

function dpapi(value, decrypt) {
    return new Promise((resolve, reject) => {
        const operation = decrypt ? 'Unprotect' : 'Protect';
        const script = `Add-Type -AssemblyName System.Security; $value=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($value); $result=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
        const child = execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
            if (error) reject(new Error('Windows credential protection failed. Telegram credentials were not opened or saved.'));
            else resolve(Buffer.from(stdout.trim(), 'base64'));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(value.toString('base64'));
    });
}

export class TokenVault {
    constructor({ directory = CONFIG_DIR, platform = process.platform } = {}) { this.directory = directory; this.platform = platform; }
    async key() {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, 'telegram.key');
        try { await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Telegram key file must be a private regular file (chmod 600).');
        const key = await fs.readFile(file);
        if (key.length !== 32) throw new Error('Telegram credential key is damaged. Reconfigure Telegram.');
        return key;
    }
    async seal(token) {
        if (this.platform === 'win32') return { type: 'dpapi', value: (await dpapi(Buffer.from(token), false)).toString('base64') };
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
        const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        return { type: 'aes-gcm', value: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') };
    }
    async open(secret) {
        if (secret?.type === 'dpapi' && this.platform === 'win32') return (await dpapi(Buffer.from(secret.value, 'base64'), true)).toString('utf8');
        if (secret?.type !== 'aes-gcm' || this.platform === 'win32') throw new Error('Reconfigure Telegram credentials on this operating system.');
        const bytes = Buffer.from(secret.value, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', await this.key(), bytes.subarray(0,12));
        decipher.setAuthTag(bytes.subarray(12,28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
}
